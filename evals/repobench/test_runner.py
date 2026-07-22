"""Stdlib-only tests for the external RepoBench adapter."""

import json
from pathlib import Path
import random
import tempfile
import unittest
from unittest.mock import patch

from evals.repobench import runner


def fixture_row():
    return {
        "repo_name": "owner/repo",
        "file_path": "pkg/consumer.py",
        "import_statement": "import os\nfrom pkg.helpers import compute_total, RetryPolicy\nfrom pkg import registry",
        "all_code": '"""Docstring."""\n\n\nvalue = 1\n\n\ndef use():\n    policy = RetryPolicy()\n',
        "cropped_code": "def use():\n    policy = RetryPolicy()\n",
        "next_line": "    return compute_total(policy)",
        "context": [
            {"identifier": "registry", "path": "pkg/registry.py", "snippet": "REGISTRY = {}"},
            {"identifier": "compute_total", "path": "pkg/helpers.py", "snippet": "def compute_total(policy):\n    return policy.total()"},
        ],
        "gold_snippet_index": 1,
        "level": "2k",
    }


def file_content_for(row):
    """Reconstruct a checkout file: docstring, imports, then the stripped code."""
    return (
        '"""Docstring."""\n\nimport os\nfrom pkg.helpers import compute_total, RetryPolicy\n'
        "from pkg import registry\n\nvalue = 1\n\n\ndef use():\n    policy = RetryPolicy()\n"
        "    return compute_total(policy)\n"
    )


class RunnerTests(unittest.TestCase):
    def test_query_symbols_come_from_imports_only_and_never_the_answer(self):
        row = fixture_row()
        symbols = runner.query_symbols(row["import_statement"])
        self.assertEqual(symbols, ["compute_total", "RetryPolicy", "registry", "os"])
        self.assertNotIn("return", " ".join(symbols))
        capped = runner.query_symbols(
            "from pkg import " + ", ".join(f"name{i}" for i in range(30))
        )
        self.assertEqual(len(capped), runner.MAX_QUERY_SYMBOLS)

    def test_checkout_verification_tolerates_stripped_import_lines(self):
        row = fixture_row()
        self.assertTrue(runner.verify_checkout_content(file_content_for(row), row))
        drifted = file_content_for(row).replace("value = 1", "value = 2")
        self.assertFalse(runner.verify_checkout_content(drifted, row))
        missing_target = file_content_for(row).replace("    return compute_total(policy)\n", "")
        self.assertFalse(runner.verify_checkout_content(missing_target, row))

    def test_row_verification_pins_every_consumed_field_by_hash(self):
        row = fixture_row()
        gold = row["context"][1]
        task = {
            "task_id": "cross_file_first/0",
            "repo": row["repo_name"],
            "file_path": row["file_path"],
            "verification": {
                **{receipt: runner.sha256_text(str(row[field])) for field, receipt in runner.HASHED_FIELDS.items()},
                "gold_path_sha256": runner.sha256_text(gold["path"]),
                "gold_snippet_sha256": runner.sha256_text(gold["snippet"]),
            },
        }
        resolved = runner.verify_row(task, row)
        self.assertEqual(resolved["path"], "pkg/helpers.py")
        tampered = dict(row, next_line="    return 42")
        with self.assertRaises(runner.AdapterError) as raised:
            runner.verify_row(task, tampered)
        self.assertIn("next_line", str(raised.exception))

    def test_retrieval_scoring_ranks_gold_and_checks_reverse_edges(self):
        row = fixture_row()
        gold = {"identifier": "compute_total", "path": "pkg/helpers.py", "snippet": row["context"][1]["snippet"]}
        task = {"task_id": "cross_file_first/0", "repo": "owner/repo", "commit": "a" * 40,
                "file_path": "pkg/consumer.py", "level": "2k"}
        queries = {
            "candidates": ["pkg/policy.py", "pkg/helpers.py"],
            "definitions": [
                {"symbol": "RetryPolicy", "file_path": "pkg/policy.py", "start_line": 3, "end_line": 3},
                {"symbol": "compute_total", "file_path": "pkg/helpers.py", "start_line": 1, "end_line": 1},
            ],
            "reference_edges": ["pkg/consumer.py -> pkg/helpers.py"],
        }
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "pkg").mkdir()
            (workspace / "pkg" / "helpers.py").write_text(
                "def compute_total(policy):\n    return policy.total()\n", encoding="utf-8"
            )

            def fake_query(_workspace, verb, _flag, value):
                self.assertEqual(verb, "impacts")
                return {"impacts": [{"file_path": "pkg/consumer.py"}]}

            with patch.object(runner, "agentify_query", side_effect=fake_query):
                result = runner.score_retrieval(workspace, task, row, gold, queries=queries)
        self.assertTrue(result["def_hit"])
        self.assertEqual(result["gold_rank"], 2)
        self.assertTrue(result["snippet_hit"])
        self.assertTrue(result["ref_edge_hit"])
        self.assertTrue(result["impact_hit"])
        summary = runner.summarize_retrieval([result])
        self.assertEqual(summary["def_hit_rate"], 1.0)
        self.assertEqual(summary["hit_at_1"], 0.0)
        self.assertEqual(summary["hit_at_5"], 1.0)
        self.assertEqual(summary["mrr"], 0.5)

    def test_prompt_template_placeholders_are_allowlisted(self):
        template = runner.load_prompt_template()
        row = fixture_row()
        baseline = runner.build_prompt(template, row, context_block="")
        self.assertNotIn(row["next_line"].strip(), baseline)
        self.assertIn("pkg/consumer.py", baseline)
        with tempfile.TemporaryDirectory() as directory:
            bad = Path(directory) / "completion.md"
            bad.write_text("Predict {next_line} for {file_path}", encoding="utf-8")
            with self.assertRaises(runner.AdapterError):
                runner.load_prompt_template(bad)

    def test_completion_parsing_and_scores(self):
        output = "Here is the line:\n```python\n    return compute_total(policy)\n```\n"
        prediction = runner.parse_completion(output)
        self.assertEqual(prediction, "    return compute_total(policy)")
        score = runner.score_completion(prediction, "    return compute_total(policy)")
        self.assertTrue(score["exact_match"])
        self.assertEqual(score["edit_similarity"], 100.0)
        self.assertEqual(score["identifier_f1"], 1.0)
        near = runner.score_completion("return compute_total(policy2)", "return compute_total(policy)")
        self.assertFalse(near["exact_match"])
        self.assertGreater(near["edit_similarity"], 90)
        self.assertLess(near["identifier_f1"], 1.0)
        # Official RepoBench definitions: exact match is whitespace-token
        # equality; edit similarity is fuzz.ratio (indel-costed Levenshtein).
        whitespace_only = runner.score_completion("return  x", "return x")
        self.assertTrue(whitespace_only["exact_match"])
        self.assertEqual(runner.edit_similarity("abcd", "bcde"), 75.0)

    def test_answer_leak_receipt_flags_context_that_quotes_the_answer(self):
        self.assertTrue(runner.answer_leak_receipt("# return compute_total(policy)", "    return compute_total(policy)"))
        self.assertFalse(runner.answer_leak_receipt("# def compute_total(policy):", "    return compute_total(policy)"))
        self.assertFalse(runner.answer_leak_receipt("# x = 1", "x"))

    def test_trial_order_is_randomized_and_preserves_the_full_cross_product(self):
        tasks = [{"task_id": "cross_file_first/0"}, {"task_id": "cross_file_first/1"}]
        order = runner.randomized_trial_order(tasks, ["agentify", "claude-code"], 2, rng=random.Random(7))
        self.assertEqual(
            {(trial["task_id"], trial["attempt"]) for trial in order},
            {("cross_file_first/0", 1), ("cross_file_first/0", 2),
             ("cross_file_first/1", 1), ("cross_file_first/1", 2)},
        )
        self.assertTrue(all(set(trial["arms"]) == {"agentify", "claude-code"} for trial in order))
        self.assertNotEqual(
            [(trial["task_id"], trial["attempt"]) for trial in order],
            [("cross_file_first/0", 1), ("cross_file_first/0", 2),
             ("cross_file_first/1", 1), ("cross_file_first/1", 2)],
        )

    def test_committed_manifest_tasks_are_answer_free(self):
        manifest = runner.load_manifest()
        self.assertEqual(len(manifest["tasks"]), 8)
        for task in manifest["tasks"]:
            for field in ("next_line", "gold_path", "gold_snippet", "context", "all_code",
                          "cropped_code", "import_statement", "snippet"):
                self.assertNotIn(field, task)
            self.assertEqual(len(task["verification"]), 6)
        plan = runner.cost_plan(manifest, "smoke")
        self.assertEqual(plan["completion_trials"], 2)
        self.assertEqual(plan["retrieval_cost_usd"], 0)

    def test_stream_parser_reads_result_event_and_counts_tool_calls(self):
        events = [
            {"type": "assistant", "message": {"id": "one", "content": [{"type": "text", "text": "ok"}]}},
            {"type": "result", "subtype": "success", "num_turns": 1,
             "total_cost_usd": 0.01, "result": "```python\nx = 1\n```",
             "usage": {"input_tokens": 5, "output_tokens": 3}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trajectory.jsonl"
            path.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
            parsed = runner.parse_stream(path)
            self.assertEqual(parsed["tool_calls"], 0)
            events.insert(1, {"type": "assistant", "message": {"id": "two", "content": [
                {"type": "tool_use", "name": "WebSearch", "input": {}},
            ]}})
            path.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
            tainted = runner.parse_stream(path)
        self.assertEqual(parsed["num_turns"], 1)
        self.assertEqual(parsed["cost_usd"], 0.01)
        self.assertEqual(runner.parse_completion(parsed["final_output"]), "x = 1")
        # Any tool call marks the session as not tool-free; run_attempt
        # invalidates the trial and the importer refuses it.
        self.assertEqual(tainted["tool_calls"], 1)


if __name__ == "__main__":
    unittest.main()
