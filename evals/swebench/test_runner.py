"""Stdlib-only tests for the external SWE-bench adapter."""

import json
from pathlib import Path
import random
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from evals.swebench import runner


class RunnerTests(unittest.TestCase):
    def test_warmup_projection_drops_every_answer_field(self):
        row = {
            "repo": "owner/repo",
            "base_commit": "a" * 40,
            "problem_statement": "SECRET ISSUE",
            "patch": "SECRET PATCH",
            "test_patch": "SECRET TEST",
            "FAIL_TO_PASS": '["SECRET NODE"]',
        }
        self.assertEqual(runner.warmup_target(row), {"repo": "owner/repo", "base_commit": "a" * 40})
        command = runner.claude_command(runner.load_manifest(), "static prompt", warmup=True)
        self.assertNotIn("SECRET", " ".join(command))
        self.assertIn("plan", command)

    def test_stream_parser_counts_first_file_mutation_turn(self):
        events = [
            {"type": "assistant", "message": {"id": "one", "content": [{"type": "tool_use", "name": "Read"}]}},
            {"type": "assistant", "message": {"id": "one", "content": [{"type": "tool_use", "name": "Read"}]}},
            {"type": "assistant", "message": {"id": "two", "content": [{"type": "tool_use", "name": "Edit"}]}},
            {"type": "result", "subtype": "success", "num_turns": 4, "total_cost_usd": 0.12, "result": "module map"},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trajectory.jsonl"
            path.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
            parsed = runner.parse_stream(path)
        self.assertEqual(parsed["turns_to_first_edit"], 2)
        self.assertEqual(parsed["num_turns"], 4)
        self.assertEqual(parsed["cost_usd"], 0.12)
        self.assertEqual(parsed["final_output"], "module map")

    def test_controller_records_read_only_warmup_output_as_agentify_context(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / "repo"
            context = workspace / ".agentify" / "context"
            context.mkdir(parents=True)

            def fake_run(command, **_kwargs):
                self.assertEqual(command[:3], ["agentify", "ctx", "note"])
                (context / "notes.jsonl").write_text(command[3], encoding="utf-8")
                return subprocess.CompletedProcess(command, 0, "", "")

            with patch.object(runner, "run_command", side_effect=fake_run):
                runner.record_warmup_context(workspace, "durable module map", session="warm")
            self.assertEqual((context / "notes.jsonl").read_text(encoding="utf-8"), "durable module map")

    def test_provider_env_isolates_host_configuration_and_other_credentials(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            runner.os.environ,
            {
                "HOME": "/host/home",
                "PATH": "/usr/bin",
                "ANTHROPIC_API_KEY": "anthropic-secret",
                "OPENAI_API_KEY": "must-not-cross",
            },
            clear=True,
        ):
            isolated = Path(directory) / "home"
            env = runner.command_env("session", isolated)
        self.assertEqual(env["HOME"], str(isolated))
        self.assertEqual(env["ANTHROPIC_API_KEY"], "anthropic-secret")
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], str(isolated / ".claude"))

    def test_trial_order_is_randomized_and_preserves_the_full_cross_product(self):
        rows = [{"instance_id": "one"}, {"instance_id": "two"}]
        order = runner.randomized_trial_order(
            rows, ["agentify", "claude-code"], 2, rng=random.Random(7)
        )
        self.assertEqual(
            {(trial["instance_id"], trial["attempt"]) for trial in order},
            {("one", 1), ("one", 2), ("two", 1), ("two", 2)},
        )
        self.assertTrue(all(set(trial["arms"]) == {"agentify", "claude-code"} for trial in order))
        self.assertNotEqual(
            [(trial["instance_id"], trial["attempt"]) for trial in order],
            [("one", 1), ("one", 2), ("two", 1), ("two", 2)],
        )

    def test_contamination_guard_reports_hash_not_answer(self):
        secret = "return the_distinctive_gold_answer_value"
        row = {"patch": f"diff --git a/a b/a\n+{secret}\n", "test_patch": "", "FAIL_TO_PASS": "[]", "problem_statement": ""}
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "notes.jsonl"
            artifact.write_text(secret, encoding="utf-8")
            with self.assertRaises(runner.AdapterError) as raised:
                runner.contamination_receipt([row], [artifact])
        self.assertNotIn(secret, str(raised.exception))
        self.assertIn("sha256=", str(raised.exception))

    def test_patch_capture_includes_new_files_and_excludes_arm_setup(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            runner.run_command(["git", "init", "--quiet"], cwd=workspace)
            (workspace / "source.py").write_text("value = 1\n", encoding="utf-8")
            runner.run_command(["git", "add", "-A"], cwd=workspace)
            runner.run_command(
                [
                    "git", "-c", "user.name=Test", "-c", "user.email=test@example.com",
                    "commit", "--quiet", "-m", "base",
                ],
                cwd=workspace,
            )
            # Harness-owned integration change, sealed before provider work.
            (workspace / "CLAUDE.md").write_text("Agentify setup\n", encoding="utf-8")
            baseline = runner.seal_setup(workspace)
            # Provider edits a tracked file and creates a new one.
            (workspace / "source.py").write_text("value = 2\n", encoding="utf-8")
            (workspace / "new_module.py").write_text("created = True\n", encoding="utf-8")
            diff, names = runner.capture_provider_patch(workspace, baseline)
        self.assertEqual(names, ["new_module.py", "source.py"])
        self.assertIn("new_module.py", diff)
        self.assertIn("value = 2", diff)
        self.assertNotIn("CLAUDE.md", diff)

    def test_patch_apply_error_is_model_failure_only_with_explicit_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            log = job / "logs" / "run_evaluation" / "run-1" / "model" / "instance" / "run_instance.log"
            log.parent.mkdir(parents=True)
            log.write_text("docker daemon unavailable", encoding="utf-8")
            self.assertFalse(runner.patch_apply_failed(job, "run-1", "instance"))
            log.write_text(">>>>> Patch Apply Failed\ninvalid hunk", encoding="utf-8")
            self.assertTrue(runner.patch_apply_failed(job, "run-1", "instance"))


if __name__ == "__main__":
    unittest.main()
