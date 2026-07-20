#!/usr/bin/env python3
"""SWE-bench Verified cold vs Agentify-warm inference adapter.

This file is benchmark tooling, not an Agentify runtime dependency. It uses a
pinned Hugging Face snapshot for inference inputs, Claude Code for both arms,
and the official SWE-bench package for Docker grading. The warm-up subprocess
receives only (repo, base_commit) plus a static prompt; answer-bearing fields
remain in the parent process solely for the post-warm-up contamination scan.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
from importlib import metadata as importlib_metadata
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Iterable


SCHEMA = "swebench-warm-v1"
JOB_SCHEMA = "swebench-job-v1"
ATTEMPT_SCHEMA = "swebench-attempt-v1"
SAFE_WARMUP_FIELDS = ("repo", "base_commit")
ANSWER_FIELDS = ("patch", "test_patch", "FAIL_TO_PASS", "problem_statement")
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = Path(__file__).with_name("dataset.json")
DEFAULT_WARMUP_PROMPT = Path(__file__).with_name("warmup") / "instruction.md"


class AdapterError(RuntimeError):
    """A reproducibility or contamination invariant failed."""


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def load_manifest(path: Path = DEFAULT_MANIFEST) -> dict[str, Any]:
    manifest = read_json(path)
    if manifest.get("schema") != SCHEMA:
        raise AdapterError(f"manifest schema must be {SCHEMA}")
    return manifest


def selected_instances(manifest: dict[str, Any], suite: str) -> list[dict[str, Any]]:
    suite_config = manifest.get("suites", {}).get(suite)
    if not suite_config:
        known = ", ".join(sorted(manifest.get("suites", {})))
        raise AdapterError(f"unknown suite {suite!r}; known: {known}")
    by_id = {item["instance_id"]: item for item in manifest["instances"]}
    return [by_id[instance_id] for instance_id in suite_config["instances"]]


def load_dataset_rows(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        from datasets import load_dataset  # type: ignore
    except ImportError as error:
        raise AdapterError("install the external inference dependency with: pip install datasets") from error
    dataset = manifest["dataset"]
    rows = load_dataset(
        dataset["name"],
        split=dataset["split"],
        revision=dataset["revision"],
    )
    return [dict(row) for row in rows]


def resolve_rows(manifest: dict[str, Any], suite: str, rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    expected = selected_instances(manifest, suite)
    by_id = {row.get("instance_id"): row for row in rows}
    resolved = []
    for pinned in expected:
        row = by_id.get(pinned["instance_id"])
        if not row:
            raise AdapterError(f"pinned instance {pinned['instance_id']} is absent from the dataset snapshot")
        for field in SAFE_WARMUP_FIELDS:
            if row.get(field) != pinned[field]:
                raise AdapterError(f"dataset drift for {pinned['instance_id']}: {field} does not match the pin")
        resolved.append(row)
    return resolved


def warmup_target(row: dict[str, Any]) -> dict[str, str]:
    """Project a full dataset row onto the only fields phase A may receive."""
    return {field: str(row[field]) for field in SAFE_WARMUP_FIELDS}


def command_env(session: str, home_dir: Path) -> dict[str, str]:
    allowed = (
        "PATH", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL",
        "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
    )
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    home_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    config_dir = home_dir / ".claude"
    config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    oauth_token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "").strip()
    force_oauth = os.environ.get("CLAUDE_FORCE_OAUTH", "").strip().lower() not in ("", "0", "false")
    api_key = "" if force_oauth else os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if oauth_token:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = oauth_token
    if api_key:
        env["ANTHROPIC_API_KEY"] = api_key
    env.update(
        {
            # Never inherit ~/.claude hooks, MCP servers, plugins, or session
            # state from the benchmark host. Both arms start from this empty
            # config; only the warm arm receives repo-local Agentify settings.
            "HOME": str(home_dir),
            "CLAUDE_CONFIG_DIR": str(config_dir),
            "XDG_CONFIG_HOME": str(home_dir / ".config"),
            "AGENTIFY_PROFILE": "balanced",
            "AGENTIFY_CTX_SESSION": session,
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        }
    )
    return env


def claude_model(manifest: dict[str, Any]) -> str:
    model = str(manifest["model"])
    return model.split("/", 1)[1] if "/" in model else model


def claude_command(
    manifest: dict[str, Any], prompt: str, *, warmup: bool
) -> list[str]:
    limits = manifest["limits"]
    budget_key = "warmup_max_budget_usd" if warmup else "scored_max_budget_usd"
    turns_key = "warmup_max_turns" if warmup else "scored_max_turns"
    command = [
        "claude",
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        claude_model(manifest),
        "--max-budget-usd",
        str(limits[budget_key]),
        "--max-turns",
        str(limits[turns_key]),
        "--no-session-persistence",
        "--permission-mode",
        "plan" if warmup else "acceptEdits",
    ]
    if warmup:
        command.extend(["--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit"])
    return command


def parse_stream(path: Path) -> dict[str, Any]:
    result: dict[str, Any] | None = None
    assistant_turns = 0
    first_edit_turn: int | None = None
    message_turns: dict[str, int] = {}
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            event = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") == "result":
            result = event
            continue
        if event.get("type") != "assistant" or not isinstance(event.get("message"), dict):
            continue
        message = event["message"]
        message_id = str(message.get("id") or f"line-{assistant_turns + 1}")
        if message_id not in message_turns:
            assistant_turns += 1
            message_turns[message_id] = assistant_turns
        turn_index = message_turns[message_id]
        content = message.get("content") if isinstance(message.get("content"), list) else []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") in EDIT_TOOLS:
                if first_edit_turn is None:
                    first_edit_turn = turn_index
    result = result or {}
    usage = result.get("usage") if isinstance(result.get("usage"), dict) else None
    normalized_usage = None
    if usage:
        cache_read = int(usage.get("cache_read_input_tokens") or 0)
        cache_write = int(usage.get("cache_creation_input_tokens") or 0)
        normalized_usage = {
            "fresh_input_tokens": int(usage.get("input_tokens") or 0),
            "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write,
            "output_tokens": int(usage.get("output_tokens") or 0),
        }
    return {
        "subtype": result.get("subtype"),
        "num_turns": result.get("num_turns"),
        "turns_to_first_edit": first_edit_turn,
        "cost_usd": result.get("total_cost_usd") if isinstance(result.get("total_cost_usd"), (int, float)) else None,
        "usage": normalized_usage,
        # Used only by the warm-up controller, which writes the model's
        # read-only observations through Agentify after Claude exits. Scored
        # attempts remove this field before persisting provider telemetry.
        "final_output": result.get("result") if isinstance(result.get("result"), str) else None,
    }


def run_command(
    command: list[str], *, cwd: Path, env: dict[str, str] | None = None,
    stdout_path: Path | None = None, timeout: int | None = None,
) -> subprocess.CompletedProcess[str]:
    stdout_handle = None
    try:
        if stdout_path:
            stdout_path.parent.mkdir(parents=True, exist_ok=True)
            stdout_handle = stdout_path.open("w", encoding="utf-8")
        return subprocess.run(
            command,
            cwd=cwd,
            env=env,
            text=True,
            stdout=stdout_handle if stdout_handle else subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    finally:
        if stdout_handle:
            stdout_handle.close()


def run_claude(
    manifest: dict[str, Any], prompt: str, *, cwd: Path, trajectory: Path,
    warmup: bool, session: str,
) -> dict[str, Any]:
    started = time.monotonic()
    timed_out = False
    isolated_home = cwd.parent / f".{cwd.name}-claude-home"
    try:
        completed = run_command(
            claude_command(manifest, prompt, warmup=warmup),
            cwd=cwd,
            env=command_env(session, isolated_home),
            stdout_path=trajectory,
            timeout=60 * 60,
        )
        exit_code = completed.returncode
        stderr = completed.stderr
    except subprocess.TimeoutExpired as error:
        timed_out = True
        exit_code = 124
        stderr = str(error)
    telemetry = parse_stream(trajectory) if trajectory.exists() else {
        "subtype": None,
        "num_turns": None,
        "turns_to_first_edit": None,
        "cost_usd": None,
        "usage": None,
        "final_output": None,
    }
    if not warmup:
        telemetry.pop("final_output", None)
    telemetry.update(
        {
            "exit_code": exit_code,
            "timed_out": timed_out,
            "duration_ms": round((time.monotonic() - started) * 1000),
            "resolved_model": claude_model(manifest),
            "stderr_tail": stderr[-2000:] if stderr else "",
        }
    )
    return telemetry


def git_status(workspace: Path) -> str:
    result = run_command(["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=workspace)
    if result.returncode != 0:
        raise AdapterError(f"git status failed: {result.stderr[-500:]}")
    return result.stdout


def ensure_tools(manifest: dict[str, Any]) -> None:
    missing = [tool for tool in ("git", "claude", "agentify") if shutil.which(tool) is None]
    if missing:
        raise AdapterError(f"missing required executable(s): {', '.join(missing)}")
    oauth_token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "").strip()
    force_oauth = os.environ.get("CLAUDE_FORCE_OAUTH", "").strip().lower() not in ("", "0", "false")
    api_key = "" if force_oauth else os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not oauth_token and not api_key:
        raise AdapterError(
            "isolated benchmark sessions require ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN; "
            "host ~/.claude credentials and settings are intentionally not inherited"
        )
    version_commands = {
        "node": (["node", "--version"], manifest["pins"]["node"]),
        "claude-code": (["claude", "--version"], manifest["pins"]["claude_code"]),
        "agentify": (["agentify", "--version"], manifest["pins"]["agentify"]),
    }
    for name, (command, expected) in version_commands.items():
        completed = run_command(command, cwd=ROOT)
        observed = f"{completed.stdout}\n{completed.stderr}"
        if completed.returncode != 0 or expected not in observed:
            raise AdapterError(f"{name} must be pinned at {expected}; observed {observed.strip() or 'unavailable'}")


def repo_slug(repo: str) -> str:
    return repo.replace("/", "__")


def checkout(target: dict[str, str], destination: Path) -> None:
    """Fetch exactly one shallow base commit with no remote or future refs."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.mkdir()
    completed = run_command(["git", "init", "--quiet"], cwd=destination)
    if completed.returncode != 0:
        raise AdapterError(f"failed to initialize checkout for {target['repo']}: {completed.stderr[-1000:]}")
    completed = run_command(
        ["git", "fetch", "--quiet", "--depth=1", "--no-tags", f"https://github.com/{target['repo']}.git", target["base_commit"]],
        cwd=destination,
    )
    if completed.returncode != 0:
        raise AdapterError(f"failed to fetch {target['base_commit']}: {completed.stderr[-1000:]}")
    completed = run_command(["git", "-c", "advice.detachedHead=false", "checkout", "--detach", "FETCH_HEAD"], cwd=destination)
    if completed.returncode != 0:
        raise AdapterError(f"failed to checkout {target['base_commit']}: {completed.stderr[-1000:]}")
    # FETCH_HEAD contains only the selected base. Expire the fetch reflog and
    # prune unreachable objects so phase A cannot inspect later branches, tags,
    # or the eventual fix through Git history.
    run_command(["git", "reflog", "expire", "--expire=now", "--all"], cwd=destination)
    run_command(["git", "gc", "--prune=now", "--quiet"], cwd=destination)


def seal_setup(workspace: Path) -> str:
    """Commit harness-owned files so only provider work enters the prediction."""
    added = run_command(["git", "add", "-A"], cwd=workspace)
    if added.returncode != 0:
        raise AdapterError(f"failed to seal benchmark setup: {added.stderr[-1000:]}")
    committed = run_command(
        [
            "git", "-c", "user.name=Agentify SWE-bench", "-c", "user.email=eval@agentify.local",
            "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--allow-empty", "--no-gpg-sign",
            "--no-verify", "-m", "benchmark setup baseline",
        ],
        cwd=workspace,
    )
    if committed.returncode != 0:
        raise AdapterError(f"failed to seal benchmark setup: {committed.stderr[-1000:]}")
    resolved = run_command(["git", "rev-parse", "HEAD"], cwd=workspace)
    if resolved.returncode != 0:
        raise AdapterError(f"failed to resolve setup baseline: {resolved.stderr[-1000:]}")
    return resolved.stdout.strip()


def remove_workspace(workspace: Path) -> None:
    shutil.rmtree(workspace, ignore_errors=True)
    shutil.rmtree(workspace.parent / f".{workspace.name}-claude-home", ignore_errors=True)


def directory_digest(directory: Path) -> str:
    """Fingerprint file names and bytes so warm-up must create real context."""
    digest = hashlib.sha256()
    if not directory.exists():
        return digest.hexdigest()
    for candidate in sorted(item for item in directory.rglob("*") if item.is_file()):
        digest.update(str(candidate.relative_to(directory)).encode("utf-8"))
        digest.update(b"\0")
        digest.update(candidate.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def record_warmup_context(workspace: Path, observation: str, *, session: str) -> None:
    """Let Claude explore read-only, then perform the one allowed context write."""
    clean = observation.strip()
    if not clean:
        raise AdapterError("warm-up returned no durable repository observations")
    context_dir = workspace / ".agentify" / "context"
    before = directory_digest(context_dir)
    isolated_home = workspace.parent / f".{workspace.name}-claude-home"
    completed = run_command(
        ["agentify", "ctx", "note", clean],
        cwd=workspace,
        env=command_env(session, isolated_home),
    )
    if completed.returncode != 0:
        raise AdapterError(f"agentify ctx note failed: {completed.stderr[-1000:]}")
    if directory_digest(context_dir) == before:
        raise AdapterError("warm-up observation did not change the Agentify context store")


def capture_provider_patch(workspace: Path, setup_baseline: str) -> tuple[str, list[str]]:
    """Diff provider work only, including new files but excluding arm setup."""
    intent = run_command(["git", "add", "--intent-to-add", "--", "."], cwd=workspace)
    if intent.returncode != 0:
        raise AdapterError(f"failed to include new provider files: {intent.stderr[-1000:]}")
    patch_result = run_command(["git", "diff", "--binary", setup_baseline], cwd=workspace)
    names_result = run_command(["git", "diff", "--name-only", setup_baseline], cwd=workspace)
    if patch_result.returncode != 0 or names_result.returncode != 0:
        raise AdapterError("failed to capture the provider patch against the sealed setup baseline")
    return patch_result.stdout, [line for line in names_result.stdout.splitlines() if line.strip()]


def install_agentify(workspace: Path) -> None:
    completed = run_command(["agentify", "install", "--provider", "claude"], cwd=workspace)
    if completed.returncode != 0:
        raise AdapterError(f"agentify install failed: {completed.stderr[-1000:]}")
    completed = run_command(["agentify", "scan", "--root", str(workspace)], cwd=workspace)
    if completed.returncode != 0:
        raise AdapterError(f"agentify scan failed: {completed.stderr[-1000:]}")


def added_patch_lines(patch: str) -> list[str]:
    lines = []
    for line in patch.splitlines():
        if line.startswith("+++") or not line.startswith("+"):
            continue
        value = line[1:].strip()
        if len(value) >= 20:
            lines.append(value)
    return lines


def json_string_list(value: Any) -> list[str]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return [value] if value else []
    return [str(item) for item in value] if isinstance(value, list) else []


def contamination_patterns(rows: Iterable[dict[str, Any]]) -> list[tuple[str, str]]:
    patterns: dict[str, str] = {}
    for row in rows:
        for field in ("patch", "test_patch"):
            for value in added_patch_lines(str(row.get(field) or "")):
                patterns[value] = field
        for value in json_string_list(row.get("FAIL_TO_PASS")):
            if len(value.strip()) >= 12:
                patterns[value.strip()] = "FAIL_TO_PASS"
        for value in str(row.get("problem_statement") or "").splitlines():
            clean = value.strip()
            if len(clean) >= 40:
                patterns[clean] = "problem_statement"
    return sorted(((value, source) for value, source in patterns.items()), key=lambda item: item[0])


def contamination_receipt(
    rows: Iterable[dict[str, Any]], artifacts: Iterable[Path]
) -> dict[str, Any]:
    patterns = contamination_patterns(rows)
    files_checked = 0
    for artifact in artifacts:
        candidates = [artifact] if artifact.is_file() else [item for item in artifact.rglob("*") if item.is_file()]
        for candidate in candidates:
            files_checked += 1
            content = candidate.read_text(encoding="utf-8", errors="replace")
            for pattern, source in patterns:
                if pattern in content:
                    digest = hashlib.sha256(pattern.encode("utf-8")).hexdigest()
                    raise AdapterError(
                        f"warm-up contamination detected in {candidate.name}: {source} marker sha256={digest}"
                    )
    return {
        "status": "passed",
        "patterns_checked": len(patterns),
        "files_checked": files_checked,
        "sources": list(ANSWER_FIELDS),
        "warmup_input_fields": list(SAFE_WARMUP_FIELDS),
    }


def run_warmup(
    manifest: dict[str, Any], repo_rows: list[dict[str, Any]], *, work_root: Path,
    job_dir: Path,
) -> dict[str, Any]:
    target = warmup_target(repo_rows[0])
    workspace = work_root / "warmup" / repo_slug(target["repo"])
    checkout(target, workspace)
    install_agentify(workspace)
    before = git_status(workspace)
    warmup_dir = job_dir / "warmups" / repo_slug(target["repo"])
    trajectory = warmup_dir / "trajectory.jsonl"
    prompt = DEFAULT_WARMUP_PROMPT.read_text(encoding="utf-8")
    session = f"swebench-warmup-{repo_slug(target['repo'])}"
    provider = run_claude(
        manifest, prompt, cwd=workspace, trajectory=trajectory, warmup=True,
        session=session,
    )
    if provider["exit_code"] != 0:
        raise AdapterError(f"warm-up provider failed for {target['repo']} with exit {provider['exit_code']}")
    observation = str(provider.pop("final_output", "") or "")
    record_warmup_context(workspace, observation, session=session)
    after = git_status(workspace)
    if before != after:
        raise AdapterError(f"warm-up modified the {target['repo']} checkout; refusing to snapshot context")
    context_dir = workspace / ".agentify" / "context"
    if not context_dir.exists():
        raise AdapterError(f"warm-up produced no .agentify/context store for {target['repo']}")
    receipt = contamination_receipt(repo_rows, [context_dir, trajectory])
    snapshot = warmup_dir / "context"
    shutil.copytree(context_dir, snapshot)
    result = {
        "repo": target["repo"],
        "base_commit": target["base_commit"],
        "provider": provider,
        "contamination": receipt,
        "context_path": str(snapshot.relative_to(job_dir)),
        "trajectory_path": str(trajectory.relative_to(job_dir)),
    }
    remove_workspace(workspace)
    return result


def scored_prompt(problem_statement: str) -> str:
    return (
        "Resolve the repository issue below. Work directly in the checkout, make the smallest correct change, "
        "and leave the working tree with the proposed patch. Do not search for or reconstruct benchmark answers.\n\n"
        + problem_statement
    )


def run_attempt(
    manifest: dict[str, Any], row: dict[str, Any], *, arm: str, attempt_number: int,
    warmup: dict[str, Any] | None, work_root: Path, job_dir: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    target = warmup_target(row)
    workspace = work_root / "attempts" / arm / f"{row['instance_id']}-{attempt_number}"
    checkout(target, workspace)
    if arm == "agentify":
        if not warmup:
            raise AdapterError(f"missing warm store for {row['repo']}")
        install_agentify(workspace)
        context_dir = workspace / ".agentify" / "context"
        if context_dir.exists():
            shutil.rmtree(context_dir)
        shutil.copytree(job_dir / warmup["context_path"], context_dir)
    setup_baseline = seal_setup(workspace)
    result_dir = job_dir / "attempts" / arm / row["instance_id"] / str(attempt_number)
    trajectory = result_dir / "trajectory.jsonl"
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    provider = run_claude(
        manifest,
        scored_prompt(str(row["problem_statement"])),
        cwd=workspace,
        trajectory=trajectory,
        warmup=False,
        session=f"swebench-scored-{arm}-{attempt_number}",
    )
    if provider["exit_code"] != 0:
        result_dir.mkdir(parents=True, exist_ok=True)
        error_record = {
            "schema": ATTEMPT_SCHEMA,
            "instance_id": row["instance_id"],
            "repo": row["repo"],
            "base_commit": row["base_commit"],
            "difficulty": row.get("difficulty"),
            "arm": arm,
            "attempt": attempt_number,
            "model": manifest["model"],
            "started_at": started_at,
            "duration_ms": provider["duration_ms"],
            "provider": provider,
            "changed_paths": [],
            "patch_path": None,
            "trajectory_path": str(trajectory.relative_to(job_dir)),
            "contamination": warmup["contamination"] if warmup else None,
            "score": None,
        }
        write_json(result_dir / "result.json", error_record)
        remove_workspace(workspace)
        raise AdapterError(
            f"scored provider failed for {row['instance_id']} arm {arm} "
            f"attempt {attempt_number} with exit {provider['exit_code']}"
        )
    patch, changed_paths = capture_provider_patch(workspace, setup_baseline)
    patch_path = result_dir / "patch.diff"
    patch_path.parent.mkdir(parents=True, exist_ok=True)
    patch_path.write_text(patch, encoding="utf-8")
    record = {
        "schema": ATTEMPT_SCHEMA,
        "instance_id": row["instance_id"],
        "repo": row["repo"],
        "base_commit": row["base_commit"],
        "difficulty": row.get("difficulty"),
        "arm": arm,
        "attempt": attempt_number,
        "model": manifest["model"],
        "started_at": started_at,
        "duration_ms": provider["duration_ms"],
        "provider": provider,
        "changed_paths": changed_paths,
        "patch_path": str(patch_path.relative_to(job_dir)),
        "trajectory_path": str(trajectory.relative_to(job_dir)),
        "contamination": warmup["contamination"] if warmup else None,
        "score": None,
    }
    prediction = {
        "instance_id": row["instance_id"],
        "model_name_or_path": f"{'agentify-warm' if arm == 'agentify' else 'claude-cold'}-{claude_model(manifest)}-attempt-{attempt_number}",
        "model_patch": patch,
    }
    write_json(result_dir / "result.json", record)
    remove_workspace(workspace)
    return record, prediction


def cost_plan(manifest: dict[str, Any], suite: str) -> dict[str, Any]:
    instances = selected_instances(manifest, suite)
    attempts = int(manifest["suites"][suite].get("attempts", 1))
    repos = {item["repo"] for item in instances}
    scored = len(instances) * len(manifest["arms"]) * attempts
    scored_ceiling = scored * float(manifest["limits"]["scored_max_budget_usd"])
    warmup_ceiling = len(repos) * float(manifest["limits"]["warmup_max_budget_usd"])
    return {
        "instances": len(instances),
        "repos": len(repos),
        "attempts": attempts,
        "scored_trials": scored,
        "scored_ceiling_usd": round(scored_ceiling, 6),
        "warmup_ceiling_usd": round(warmup_ceiling, 6),
        "max_spend_usd": round(scored_ceiling + warmup_ceiling, 6),
    }


def randomized_trial_order(
    rows: list[dict[str, Any]], arms: list[str], attempts: int,
    *, rng: Any | None = None,
) -> list[dict[str, Any]]:
    """Randomize trials and arm order, recording the receipt before spend."""
    generator = rng or secrets.SystemRandom()
    trials = [
        {"instance_id": row["instance_id"], "attempt": attempt_number}
        for row in rows
        for attempt_number in range(1, attempts + 1)
    ]
    generator.shuffle(trials)
    for trial in trials:
        trial["arms"] = list(arms)
        generator.shuffle(trial["arms"])
    return trials


def run_suite(args: argparse.Namespace) -> None:
    manifest = load_manifest(args.manifest)
    plan = cost_plan(manifest, args.suite)
    print(json.dumps({"suite": args.suite, **plan}, indent=2))
    if not args.yes:
        raise AdapterError("paid inference blocked: rerun with --yes only after reviewing the ceiling")
    ensure_tools(manifest)
    if args.output.exists() and (args.output / "job.json").exists():
        raise AdapterError(f"job already exists at {args.output}; choose a fresh output directory")
    args.output.mkdir(parents=True, exist_ok=True)
    rows = resolve_rows(manifest, args.suite, load_dataset_rows(manifest))
    attempts = int(manifest["suites"][args.suite].get("attempts", 1))
    work_root = Path(args.work_root) if args.work_root else Path(tempfile.mkdtemp(prefix="agentify-swebench-"))
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    job = {
        "schema": JOB_SCHEMA,
        "suite": args.suite,
        "dataset": manifest["dataset"],
        "pins": manifest["pins"],
        "model": manifest["model"],
        "limits": manifest["limits"],
        "started_at": started_at,
        "max_spend_usd": plan["max_spend_usd"],
        "warmups": [],
        "order": randomized_trial_order(rows, list(manifest["arms"]), attempts),
        "status": "running",
    }
    write_json(args.output / "job.json", job)
    try:
        warmups: dict[str, dict[str, Any]] = {}
        for repo in sorted({row["repo"] for row in rows}):
            warmup = run_warmup(
                manifest,
                [row for row in rows if row["repo"] == repo],
                work_root=work_root,
                job_dir=args.output,
            )
            warmups[repo] = warmup
            job["warmups"].append(warmup)
            write_json(args.output / "job.json", job)

        predictions: dict[tuple[str, int], list[dict[str, Any]]] = {}
        rows_by_id = {row["instance_id"]: row for row in rows}
        for trial in job["order"]:
            row = rows_by_id[trial["instance_id"]]
            attempt_number = int(trial["attempt"])
            for arm in trial["arms"]:
                _, prediction = run_attempt(
                    manifest,
                    row,
                    arm=arm,
                    attempt_number=attempt_number,
                    warmup=warmups.get(row["repo"]) if arm == "agentify" else None,
                    work_root=work_root,
                    job_dir=args.output,
                )
                predictions.setdefault((arm, attempt_number), []).append(prediction)
        predictions_dir = args.output / "predictions"
        predictions_dir.mkdir(parents=True, exist_ok=True)
        for (arm, attempt_number), items in predictions.items():
            output = predictions_dir / f"{arm}-attempt-{attempt_number}.jsonl"
            output.write_text("".join(json.dumps(item) + "\n" for item in items), encoding="utf-8")
        # Materialize the exact pinned rows only after every provider session
        # has ended. The official harness accepts local JSON, which prevents it
        # from silently reloading a newer dataset revision. This private file
        # contains benchmark answers and remains inside the gitignored job.
        grader_dataset = args.output / "dataset" / "pinned-sample.json"
        write_json(grader_dataset, rows)
        job["grader_dataset_path"] = str(grader_dataset.relative_to(args.output))
        job["status"] = "inference-complete"
        job["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write_json(args.output / "job.json", job)
    except AdapterError as error:
        job["status"] = "inference-errors"
        job["inference_error"] = str(error)
        job["failed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write_json(args.output / "job.json", job)
        raise
    finally:
        if not args.work_root:
            shutil.rmtree(work_root, ignore_errors=True)
    print(f"Inference complete. Grade with: python3 {Path(__file__).relative_to(ROOT)} grade --job {args.output}")


def instance_report_paths(job_dir: Path, run_id: str) -> dict[str, str]:
    results: dict[str, str] = {}
    root = job_dir / "logs" / "run_evaluation" / run_id
    if not root.exists():
        return results
    for report_path in root.rglob("report.json"):
        report = read_json(report_path)
        if not isinstance(report, dict):
            continue
        for instance_id, value in report.items():
            if isinstance(value, dict) and isinstance(value.get("resolved"), bool):
                results[instance_id] = str(report_path.relative_to(job_dir))
    return results


def official_run_report(job_dir: Path, predictions: Path, run_id: str) -> tuple[dict[str, Any], str]:
    first_prediction = next(
        (json.loads(line) for line in predictions.read_text(encoding="utf-8").splitlines() if line.strip()),
        None,
    )
    if not first_prediction:
        raise AdapterError(f"prediction file is empty: {predictions}")
    model_name = str(first_prediction["model_name_or_path"]).replace("/", "__")
    report_path = job_dir / f"{model_name}.{run_id}.json"
    if not report_path.is_file():
        raise AdapterError(f"official harness did not write its run report: {report_path.name}")
    report = read_json(report_path)
    if report.get("schema_version") != 2:
        raise AdapterError(f"official harness run report has unexpected schema: {report.get('schema_version')}")
    return report, str(report_path.relative_to(job_dir))


def attempt_result_paths(job_dir: Path, arm: str, attempt_number: int) -> list[Path]:
    return sorted((job_dir / "attempts" / arm).glob(f"*/{attempt_number}/result.json"))


def patch_apply_failed(job_dir: Path, run_id: str, instance_id: str) -> bool:
    """Identify the one harness error that is directly caused by model output."""
    logs = list((job_dir / "logs" / "run_evaluation" / run_id).glob(
        f"*/{instance_id}/run_instance.log"
    ))
    return len(logs) == 1 and ">>>>> Patch Apply Failed" in logs[0].read_text(
        encoding="utf-8", errors="replace"
    )


def grade_job(args: argparse.Namespace) -> None:
    job = read_json(args.job / "job.json")
    if job.get("schema") != JOB_SCHEMA:
        raise AdapterError(f"job schema must be {JOB_SCHEMA}")
    if importlib.util.find_spec("swebench") is None:
        raise AdapterError(f"install the pinned grader with: pip install swebench=={job['pins']['swebench']}")
    observed_swebench = importlib_metadata.version("swebench")
    if observed_swebench != job["pins"]["swebench"]:
        raise AdapterError(
            f"swebench must be pinned at {job['pins']['swebench']}; observed {observed_swebench}"
        )
    manifest = load_manifest(args.manifest)
    attempts = int(manifest["suites"][job["suite"]].get("attempts", 1))
    instance_ids = [item["instance_id"] for item in selected_instances(manifest, job["suite"])]
    grader_dataset = args.job / str(job.get("grader_dataset_path") or "")
    if not grader_dataset.is_file():
        raise AdapterError("job is missing its pinned local grader dataset")
    job_id = args.job.name.replace("_", "-")
    grading_errors: list[str] = []
    for arm in manifest["arms"]:
        for attempt_number in range(1, attempts + 1):
            predictions = args.job / "predictions" / f"{arm}-attempt-{attempt_number}.jsonl"
            run_id = f"{job_id}-{arm}-{attempt_number}"
            command = [
                sys.executable,
                "-m",
                "swebench.harness.run_evaluation",
                "--dataset_name",
                str(grader_dataset.resolve()),
                "--split",
                job["dataset"]["split"],
                "--predictions_path",
                str(predictions.resolve()),
                "--max_workers",
                str(args.max_workers),
                "--run_id",
                run_id,
                "--instance_ids",
                *instance_ids,
            ]
            completed = run_command(command, cwd=args.job)
            summary, summary_path = official_run_report(args.job, predictions, run_id)
            reports = instance_report_paths(args.job, run_id)
            resolved_ids = set(summary.get("resolved_ids") or [])
            unresolved_ids = set(summary.get("unresolved_ids") or [])
            empty_patch_ids = set(summary.get("empty_patch_ids") or [])
            error_ids = set(summary.get("error_ids") or [])
            incomplete_ids = set(summary.get("incomplete_ids") or [])
            patch_error_ids = {
                instance_id for instance_id in error_ids
                if patch_apply_failed(args.job, run_id, instance_id)
            }
            infrastructure_error_ids = error_ids - patch_error_ids
            if completed.returncode != 0:
                grading_errors.append(f"{arm} attempt {attempt_number}: harness exited {completed.returncode}")
            if infrastructure_error_ids:
                grading_errors.append(
                    f"{arm} attempt {attempt_number}: harness errors for "
                    f"{', '.join(sorted(infrastructure_error_ids))}"
                )
            if incomplete_ids:
                grading_errors.append(f"{arm} attempt {attempt_number}: incomplete predictions for {', '.join(sorted(incomplete_ids))}")
            for result_path in attempt_result_paths(args.job, arm, attempt_number):
                record = read_json(result_path)
                instance_id = record["instance_id"]
                if instance_id in resolved_ids:
                    status, resolved = "resolved", True
                elif instance_id in unresolved_ids:
                    status, resolved = "unresolved", False
                elif instance_id in empty_patch_ids:
                    status, resolved = "empty_patch", False
                elif instance_id in patch_error_ids:
                    status, resolved = "patch_apply_failed", False
                elif instance_id in infrastructure_error_ids:
                    status, resolved = "harness_error", None
                else:
                    status, resolved = "incomplete", None
                    grading_errors.append(f"{arm} attempt {attempt_number}: no outcome for {instance_id}")
                record["score"] = {
                    "status": status,
                    "resolved": resolved,
                    "official_report": reports.get(instance_id),
                    "official_run_report": summary_path,
                    "run_id": run_id,
                }
                write_json(result_path, record)
    if grading_errors:
        job["status"] = "grading-errors"
        job["grading_errors"] = grading_errors
        write_json(args.job / "job.json", job)
        raise AdapterError("official grading produced infrastructure errors; inspect job.json and rerun grade")
    job["status"] = "graded"
    job.pop("grading_errors", None)
    job["graded_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write_json(args.job / "job.json", job)
    print(f"Grading complete. Import with: agentify eval swebench import {args.job}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    subcommands = parser.add_subparsers(dest="command", required=True)
    run = subcommands.add_parser("run", help="run paired inference after an explicit ceiling confirmation")
    run.add_argument("--suite", default="smoke")
    run.add_argument("--output", type=Path, required=True)
    run.add_argument("--work-root", type=Path)
    run.add_argument("--yes", action="store_true")
    grade = subcommands.add_parser("grade", help="grade predictions with the official Docker harness")
    grade.add_argument("--job", type=Path, required=True)
    grade.add_argument("--max-workers", type=int, default=2)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "run":
            run_suite(args)
        else:
            grade_job(args)
    except AdapterError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
