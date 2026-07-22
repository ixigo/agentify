#!/usr/bin/env python3
"""RepoBench repo-context adapter: index retrieval scoring + paired completion.

This file is benchmark tooling, not an Agentify runtime dependency. It scores
the repo-intelligence layer two ways against RepoBench's labeled gold
cross-file dependency (`context[gold_snippet_index]`):

- `retrieval` is token-free. It checks out each pinned repository commit,
  builds the Agentify index, derives symbol queries from the task's import
  statement only (never from the answer line), and scores whether
  `agentify query def|refs|impacts` surfaces the gold cross-file file and
  dependency edge.
- `run` is the paid paired arm. Both arms receive the identical in-file
  context and instruction; the agentify arm additionally receives cross-file
  snippets selected mechanically by the same index queries. The only
  difference between arms is the index-supplied context block.

Dataset rows are fetched from the Hugging Face datasets-server row API with
no heavy dependencies; every consumed row field is verified against the
sha256 receipts committed in dataset.json, so upstream drift is a hard error
rather than a silent re-benchmark.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Iterable
import urllib.parse
import urllib.request

SCHEMA = "repobench-context-v1"
JOB_SCHEMA = "repobench-job-v1"
ATTEMPT_SCHEMA = "repobench-attempt-v1"
RETRIEVAL_SCHEMA = "repobench-retrieval-v1"
ROOT = Path(__file__).resolve().parents[2]
# The benchmarked CLI is this checkout's own entry point, never whatever
# `agentify` happens to be first on PATH — the recorded build commit must
# describe the code that actually built the index.
AGENTIFY_CLI = ["node", str(ROOT / "src" / "cli.js")]
DEFAULT_MANIFEST = Path(__file__).with_name("dataset.json")
DEFAULT_PROMPT = Path(__file__).with_name("prompts") / "completion.md"
ROWS_ENDPOINT = "https://datasets-server.huggingface.co/rows"
# Every dataset field the adapter is allowed to consume, each pinned by a
# committed sha256 receipt. Anything else in the row is never read.
HASHED_FIELDS = {
    "all_code": "all_code_sha256",
    "cropped_code": "cropped_code_sha256",
    "import_statement": "import_statement_sha256",
    "next_line": "next_line_sha256",
}
PROMPT_PLACEHOLDERS = {"file_path", "import_statement", "context_block", "code"}
PYTHON_KEYWORDS = {
    "False", "None", "True", "and", "as", "assert", "async", "await", "break",
    "class", "continue", "def", "del", "elif", "else", "except", "finally",
    "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
    "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
}
MAX_QUERY_SYMBOLS = 12


class AdapterError(RuntimeError):
    """A reproducibility or answer-isolation invariant failed."""


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_manifest(path: Path = DEFAULT_MANIFEST) -> dict[str, Any]:
    manifest = read_json(path)
    if manifest.get("schema") != SCHEMA:
        raise AdapterError(f"manifest schema must be {SCHEMA}")
    return manifest


def selected_tasks(manifest: dict[str, Any], suite: str) -> list[dict[str, Any]]:
    suite_config = manifest.get("suites", {}).get(suite)
    if not suite_config:
        known = ", ".join(sorted(manifest.get("suites", {})))
        raise AdapterError(f"unknown suite {suite!r}; known: {known}")
    by_id = {task["task_id"]: task for task in manifest["tasks"]}
    return [by_id[task_id] for task_id in suite_config["tasks"]]


def task_slug(task_id: str) -> str:
    return task_id.replace("/", "-")


# ---------------------------------------------------------------------------
# Pinned dataset rows
# ---------------------------------------------------------------------------

def require_pinned_dataset_head(dataset: dict[str, Any]) -> None:
    """The datasets-server row API always serves the default branch HEAD and
    accepts no revision parameter, so serving is only reproducible while HEAD
    still equals the committed pin. Fail closed the moment upstream moves."""
    url = f"https://huggingface.co/api/datasets/{dataset['name']}"
    request = urllib.request.Request(url, headers={"User-Agent": "agentify-repobench"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as error:  # noqa: BLE001 - surfaced as one adapter error
        raise AdapterError(f"failed to resolve dataset HEAD for {dataset['name']}: {error}") from error
    head = str(payload.get("sha") or "")
    if head != dataset["revision"]:
        raise AdapterError(
            f"dataset {dataset['name']} HEAD is {head or 'unknown'}, but the committed pin is "
            f"{dataset['revision']}. Either update the pin deliberately, or materialize the pinned "
            "rows with the `datasets` library at the pinned revision into --rows-cache (row-<index>.json) "
            "and rerun; cached rows are still verified against the committed sha256 receipts."
        )


def fetch_rows(manifest: dict[str, Any], row_indices: list[int], cache_dir: Path | None) -> dict[int, dict[str, Any]]:
    """Fetch dataset rows by index from the datasets-server row API."""
    dataset = manifest["dataset"]
    rows: dict[int, dict[str, Any]] = {}
    pinned_head_checked = False
    for index in sorted(set(row_indices)):
        cache_path = (cache_dir / f"row-{index}.json") if cache_dir else None
        if cache_path and cache_path.is_file():
            rows[index] = read_json(cache_path)
            continue
        if not pinned_head_checked:
            require_pinned_dataset_head(dataset)
            pinned_head_checked = True
        query = urllib.parse.urlencode({
            "dataset": dataset["name"],
            "config": "default",
            "split": dataset["split"],
            "offset": index,
            "length": 1,
        })
        request = urllib.request.Request(f"{ROWS_ENDPOINT}?{query}", headers={"User-Agent": "agentify-repobench"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception as error:  # noqa: BLE001 - surfaced as one adapter error
            raise AdapterError(f"failed to fetch dataset row {index}: {error}") from error
        fetched = payload.get("rows") or []
        if len(fetched) != 1 or fetched[0].get("row_idx") != index:
            raise AdapterError(f"datasets-server did not return row {index}")
        rows[index] = fetched[0]["row"]
        if cache_path:
            write_json(cache_path, rows[index])
    return rows


def gold_reference(row: dict[str, Any]) -> dict[str, str]:
    index = row.get("gold_snippet_index")
    context = row.get("context") or []
    if not isinstance(index, int) or index < 0 or index >= len(context):
        raise AdapterError("dataset row has no valid gold snippet index")
    gold = context[index]
    return {"identifier": str(gold["identifier"]), "path": str(gold["path"]), "snippet": str(gold["snippet"])}


def verify_row(task: dict[str, Any], row: dict[str, Any]) -> dict[str, str]:
    """Pin every consumed field to its committed hash; return the gold label."""
    receipts = task["verification"]
    for field, receipt in HASHED_FIELDS.items():
        observed = sha256_text(str(row.get(field) or ""))
        if observed != receipts[receipt]:
            raise AdapterError(f"dataset drift for {task['task_id']}: {field} does not match its committed sha256")
    tokenized = " ".join(str(row.get("next_line") or "").split())
    if sha256_text(tokenized) != receipts["next_line_token_sha256"]:
        raise AdapterError(f"dataset drift for {task['task_id']}: next_line token hash does not match its committed sha256")
    if str(row.get("repo_name")) != task["repo"] or str(row.get("file_path")) != task["file_path"]:
        raise AdapterError(f"dataset drift for {task['task_id']}: repo or file path changed")
    gold = gold_reference(row)
    if sha256_text(gold["path"]) != receipts["gold_path_sha256"]:
        raise AdapterError(f"dataset drift for {task['task_id']}: gold path does not match its committed sha256")
    if sha256_text(gold["snippet"]) != receipts["gold_snippet_sha256"]:
        raise AdapterError(f"dataset drift for {task['task_id']}: gold snippet does not match its committed sha256")
    return gold


# ---------------------------------------------------------------------------
# Checkout content verification
# ---------------------------------------------------------------------------

def nonempty_lines(text: str) -> list[str]:
    return [line.rstrip() for line in text.split("\n") if line.strip()]


def ordered_subsequence_end(haystack: list[str], needles: list[str]) -> int | None:
    """Index after matching every needle line in order, or None."""
    position = 0
    for needle in needles:
        while position < len(haystack) and haystack[position] != needle:
            position += 1
        if position >= len(haystack):
            return None
        position += 1
    return position


def verify_checkout_content(content: str, row: dict[str, Any]) -> bool:
    """RepoBench strips import lines out of all_code, so the checkout file is
    verified by ordered line-subsequence: every non-empty in-file context line
    must appear in order, the import statement must be present, and the target
    line must occur after the matched context."""
    lines = [line.rstrip() for line in content.replace("\r\n", "\n").split("\n")]
    for statement in nonempty_lines(str(row["import_statement"])):
        if statement not in lines:
            return False
    end = ordered_subsequence_end(lines, nonempty_lines(str(row["all_code"])))
    if end is None:
        return False
    return str(row["next_line"]).rstrip() in lines[end:]


def snippet_span(content: str, snippet: str) -> tuple[int, int] | None:
    """Inclusive 1-based line span of the gold snippet in the gold file. The
    snippet must appear as a contiguous run of lines — a subsequence match
    would let unrelated definitions between snippet lines count as hits."""
    lines = [line.rstrip() for line in content.replace("\r\n", "\n").split("\n")]
    needles = [line.rstrip() for line in snippet.split("\n")]
    while needles and not needles[-1]:
        needles.pop()
    if not needles:
        return None
    for index in range(len(lines) - len(needles) + 1):
        if lines[index:index + len(needles)] == needles:
            return index + 1, index + len(needles)
    return None


# ---------------------------------------------------------------------------
# Workspace and tooling
# ---------------------------------------------------------------------------

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


def checkout(repo: str, commit: str, destination: Path) -> None:
    """Fetch exactly one shallow pinned commit with no remote or later refs."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.mkdir()
    completed = run_command(["git", "init", "--quiet"], cwd=destination)
    if completed.returncode != 0:
        raise AdapterError(f"failed to initialize checkout for {repo}: {completed.stderr[-1000:]}")
    completed = run_command(
        ["git", "fetch", "--quiet", "--depth=1", "--no-tags", f"https://github.com/{repo}.git", commit],
        cwd=destination,
    )
    if completed.returncode != 0:
        raise AdapterError(f"failed to fetch {repo}@{commit}: {completed.stderr[-1000:]}")
    completed = run_command(["git", "-c", "advice.detachedHead=false", "checkout", "--detach", "FETCH_HEAD"], cwd=destination)
    if completed.returncode != 0:
        raise AdapterError(f"failed to checkout {repo}@{commit}: {completed.stderr[-1000:]}")


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
            # state from the benchmark host. Both arms use this empty config.
            "HOME": str(home_dir),
            "CLAUDE_CONFIG_DIR": str(config_dir),
            "XDG_CONFIG_HOME": str(home_dir / ".config"),
            "AGENTIFY_CTX_SESSION": session,
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        }
    )
    return env


def ensure_tools(manifest: dict[str, Any], *, paid: bool) -> None:
    required = ["git", "node"] + (["claude"] if paid else [])
    missing = [tool for tool in required if shutil.which(tool) is None]
    if missing:
        raise AdapterError(f"missing required executable(s): {', '.join(missing)}")
    if not (ROOT / "src" / "cli.js").is_file():
        raise AdapterError("the RepoBench adapter must run from an Agentify source checkout (src/cli.js not found)")
    if paid:
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
        "agentify": ([*AGENTIFY_CLI, "--version"], manifest["pins"]["agentify"]),
    }
    if paid:
        version_commands["claude-code"] = (["claude", "--version"], manifest["pins"]["claude_code"])
    for name, (command, expected) in version_commands.items():
        completed = run_command(command, cwd=ROOT)
        observed = f"{completed.stdout}\n{completed.stderr}"
        # Exact version-token equality: substring matching would accept
        # "10.4.0" for an expected "0.4.0".
        tokens = re.findall(r"\d+\.\d+\.[0-9A-Za-z.-]+", observed)
        if completed.returncode != 0 or expected not in tokens:
            raise AdapterError(f"{name} must be pinned at {expected}; observed {observed.strip() or 'unavailable'}")


def build_receipt() -> dict[str, Any]:
    """Semver alone cannot distinguish two builds reporting the same version.
    Record the benchmark checkout's commit (the runner ships inside the
    Agentify source tree); a dirty tree additionally records a diff hash so
    two different uncommitted implementations never share a receipt."""
    commit = run_command(["git", "rev-parse", "HEAD"], cwd=ROOT)
    resolved = commit.stdout.strip().lower()
    if commit.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40}", resolved):
        raise AdapterError("cannot resolve the Agentify checkout commit for the build receipt")
    status = run_command(["git", "status", "--porcelain=v1"], cwd=ROOT)
    diff = run_command(["git", "diff", "HEAD"], cwd=ROOT)
    if status.returncode != 0 or diff.returncode != 0:
        raise AdapterError("cannot resolve the Agentify worktree state for the build receipt")
    dirty = bool(status.stdout.strip())
    receipt: dict[str, Any] = {"agentify_commit": resolved, "agentify_worktree_dirty": dirty}
    if dirty:
        receipt["agentify_worktree_sha256"] = hashlib.sha256(
            (diff.stdout + status.stdout).encode("utf-8")
        ).hexdigest()
    return receipt


def install_index(workspace: Path) -> None:
    completed = run_command([*AGENTIFY_CLI, "scan", "--root", str(workspace)], cwd=workspace)
    if completed.returncode != 0:
        raise AdapterError(f"agentify scan failed: {completed.stderr[-1000:]}")


def agentify_query(workspace: Path, verb: str, flag: str, value: str) -> dict[str, Any]:
    completed = run_command([*AGENTIFY_CLI, "query", verb, flag, value], cwd=workspace)
    if completed.returncode != 0:
        raise AdapterError(f"agentify query {verb} failed for {value!r}: {completed.stderr[-1000:]}")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise AdapterError(f"agentify query {verb} returned non-JSON output for {value!r}") from error


# ---------------------------------------------------------------------------
# Query protocol (answer-free inputs only)
# ---------------------------------------------------------------------------

def query_symbols(import_statement: str, cap: int = MAX_QUERY_SYMBOLS) -> list[str]:
    """Derive index queries from the import statement alone. The answer line
    (`next_line`) and the gold label never feed the query plan."""
    symbols: list[str] = []

    def push(name: str) -> None:
        candidate = name.strip()
        if not candidate.isidentifier() or candidate in PYTHON_KEYWORDS:
            return
        if candidate not in symbols:
            symbols.append(candidate)

    def push_clause(clause: str) -> None:
        for part in clause.split(","):
            push(re.sub(r"\s+as\s+\w+\s*$", "", part.strip()))

    # Parenthesized from-imports span lines; match them before the
    # single-line form so neither shadows the other.
    for match in re.finditer(r"^\s*from\s+[.\w]+\s+import\s+\(([^)]*)\)", import_statement, re.MULTILINE | re.DOTALL):
        push_clause(match.group(1))
    for match in re.finditer(r"^\s*from\s+[.\w]+\s+import\s+([^(\n][^\n]*)$", import_statement, re.MULTILINE):
        push_clause(match.group(1))
    for match in re.finditer(r"^\s*import\s+([^\n]+)$", import_statement, re.MULTILINE):
        for module in match.group(1).split(","):
            push(re.sub(r"\s+as\s+\w+\s*$", "", module.strip()).split(".")[-1])
    return symbols[:cap]


def run_retrieval_queries(workspace: Path, task_file: str, symbols: list[str]) -> dict[str, Any]:
    """Run def and refs per symbol; candidates are defining files in query
    order. `def` is the scored definition source so a regression specific to
    that verb is detected; `refs` supplies the reverse dependency edges."""
    candidates: list[str] = []
    definitions: list[dict[str, Any]] = []
    referencing_files: set[str] = set()
    for symbol in symbols:
        defs = agentify_query(workspace, "def", "--symbol", symbol)
        for definition in defs.get("definitions") or []:
            file_path = definition.get("file_path")
            if not file_path or file_path == task_file:
                continue
            definitions.append({"symbol": symbol, **definition})
            if file_path not in candidates:
                candidates.append(file_path)
        refs = agentify_query(workspace, "refs", "--symbol", symbol)
        for reference in refs.get("references") or []:
            importer = reference.get("file_path")
            imported = reference.get("imports")
            if importer and imported:
                referencing_files.add(f"{importer} -> {imported}")
    return {
        "candidates": candidates,
        "definitions": definitions,
        "reference_edges": sorted(referencing_files),
    }


def score_retrieval(
    workspace: Path, task: dict[str, Any], row: dict[str, Any], gold: dict[str, str],
    *, queries: dict[str, Any] | None = None,
) -> dict[str, Any]:
    symbols = query_symbols(str(row["import_statement"]))
    if queries is None:
        queries = run_retrieval_queries(workspace, task["file_path"], symbols)
    candidates = queries["candidates"]
    gold_rank = candidates.index(gold["path"]) + 1 if gold["path"] in candidates else None

    gold_file = workspace / gold["path"]
    gold_content = gold_file.read_text(encoding="utf-8", errors="replace") if gold_file.is_file() else ""
    span = snippet_span(gold_content, gold["snippet"])
    snippet_hit = False
    if gold_rank is not None and span is not None:
        for definition in queries["definitions"]:
            if definition.get("file_path") != gold["path"]:
                continue
            def_line = definition.get("start_line")
            if isinstance(def_line, int) and span[0] <= def_line <= span[1]:
                snippet_hit = True
                break

    # The reverse direction: does the index know the task file depends on the
    # gold file? refs lists importers of each defining file; impacts walks the
    # same edges as blast radius. Impacts runs only when the gold file was
    # already retrieved by the answer-free def queries — its input is then a
    # retrieved candidate, never the gold label itself.
    edge = f"{task['file_path']} -> {gold['path']}"
    edge_hit = edge in queries["reference_edges"]
    impact_hit = False
    if gold_rank is not None:
        impacts = agentify_query(workspace, "impacts", "--file", gold["path"])
        impact_hit = any(item.get("file_path") == task["file_path"] for item in impacts.get("impacts") or [])

    return {
        "schema": RETRIEVAL_SCHEMA,
        "task_id": task["task_id"],
        "repo": task["repo"],
        "commit": task["commit"],
        "file_path": task["file_path"],
        "level": task.get("level"),
        "query_symbols": symbols,
        "gold_path": gold["path"],
        "gold_snippet_span": list(span) if span else None,
        "candidates": candidates,
        "candidate_count": len(candidates),
        "gold_rank": gold_rank,
        "def_hit": gold_rank is not None,
        "snippet_hit": snippet_hit,
        "ref_edge_hit": edge_hit,
        "impact_hit": impact_hit,
    }


def summarize_retrieval(results: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(results)

    def rate(predicate) -> float | None:
        return round(sum(1 for result in results if predicate(result)) / total, 4) if total else None

    ranks = [result["gold_rank"] for result in results if result["gold_rank"] is not None]
    precisions = [
        (1 / result["candidate_count"] if result["def_hit"] and result["candidate_count"] else 0.0)
        for result in results
    ]
    return {
        "schema": RETRIEVAL_SCHEMA,
        "tasks": total,
        "def_hit_rate": rate(lambda result: result["def_hit"]),
        "hit_at_1": rate(lambda result: result["gold_rank"] == 1),
        "hit_at_5": rate(lambda result: result["gold_rank"] is not None and result["gold_rank"] <= 5),
        "snippet_hit_rate": rate(lambda result: result["snippet_hit"]),
        "ref_edge_hit_rate": rate(lambda result: result["ref_edge_hit"]),
        "impact_hit_rate": rate(lambda result: result["impact_hit"]),
        "mrr": round(sum(1 / rank for rank in ranks) / total, 4) if total else None,
        "macro_precision": round(sum(precisions) / total, 4) if total else None,
        "mean_candidates": round(sum(result["candidate_count"] for result in results) / total, 2) if total else None,
    }


# ---------------------------------------------------------------------------
# Completion arm
# ---------------------------------------------------------------------------

def build_context_block(
    workspace: Path, queries: dict[str, Any], *, max_snippets: int, max_chars: int,
) -> tuple[str, list[dict[str, Any]]]:
    """Extract definition-anchored snippets from candidate files, in query
    order, bounded by count and total characters."""
    entries: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    block_parts: list[str] = []
    block_length = 0
    for definition in queries["definitions"]:
        if len(entries) >= max_snippets:
            break
        file_path = definition["file_path"]
        start_line = definition.get("start_line")
        if not isinstance(start_line, int):
            continue
        key = (file_path, start_line)
        if key in seen:
            continue
        seen.add(key)
        source = workspace / file_path
        if not source.is_file():
            continue
        lines = source.read_text(encoding="utf-8", errors="replace").split("\n")
        end_line = definition.get("end_line") if isinstance(definition.get("end_line"), int) else start_line
        snippet_lines = lines[max(0, start_line - 1):min(len(lines), max(end_line, start_line + 19))]
        snippet = "\n".join(snippet_lines).rstrip()
        if not snippet:
            continue
        # The budget bounds the serialized block the model actually receives,
        # including path headers, comment prefixes, and separators.
        serialized = "\n".join([
            f"# Path: {file_path}",
            *(f"# {line}" for line in snippet.split("\n")),
            "#",
        ])
        if block_length + len(serialized) + (1 if block_parts else 0) > max_chars:
            continue
        block_length += len(serialized) + (1 if block_parts else 0)
        block_parts.append(serialized)
        entries.append({
            "file_path": file_path,
            "symbol": definition["symbol"],
            "start_line": start_line,
            "snippet": snippet,
        })
    return "\n".join(block_parts), entries


def load_prompt_template(path: Path = DEFAULT_PROMPT) -> str:
    template = path.read_text(encoding="utf-8")
    placeholders = set(re.findall(r"\{(\w+)\}", template))
    # Exactly the allowlist: an extra placeholder could splice answer data,
    # and a missing one silently degrades the task (no {context_block} makes
    # both arms identical; no {code} removes the completion input).
    if placeholders != PROMPT_PLACEHOLDERS:
        raise AdapterError(
            f"completion prompt must splice exactly {sorted(PROMPT_PLACEHOLDERS)}; found {sorted(placeholders)}"
        )
    return template


def build_prompt(template: str, row: dict[str, Any], *, context_block: str) -> str:
    prompt = template.format(
        file_path=str(row["file_path"]),
        import_statement=str(row["import_statement"]),
        context_block=context_block if context_block else "# (no cross-file context provided)",
        code=str(row["cropped_code"]),
    )
    return prompt


def answer_leak_receipt(context_block: str, next_line: str) -> bool:
    """Legitimate retrieval can still quote the exact answer line (cross-file
    duplication). Record every exact line match, however short; never gate on
    it silently."""
    target = next_line.strip()
    if not target:
        return False
    for line in context_block.split("\n"):
        content = line[2:] if line.startswith("# ") else line
        if content.strip() == target:
            return True
    return False


def gold_context_receipt(retrieval: dict[str, Any], context_entries: list[dict[str, Any]]) -> bool:
    """True only when an injected snippet overlaps the gold snippet's line
    span — a different definition from the gold file is not gold context."""
    span = retrieval.get("gold_snippet_span")
    if not span:
        return False
    for entry in context_entries:
        if entry["file_path"] != retrieval["gold_path"]:
            continue
        entry_start = entry["start_line"]
        entry_end = entry_start + entry["snippet"].count("\n")
        if entry_start <= span[1] and entry_end >= span[0]:
            return True
    return False


def claude_model(manifest: dict[str, Any]) -> str:
    model = str(manifest["model"])
    return model.split("/", 1)[1] if "/" in model else model


def claude_command(manifest: dict[str, Any], prompt: str) -> list[str]:
    limits = manifest["limits"]
    return [
        "claude",
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        claude_model(manifest),
        "--max-budget-usd",
        str(limits["completion_max_budget_usd"]),
        "--max-turns",
        str(limits["completion_max_turns"]),
        "--no-session-persistence",
        "--permission-mode",
        "plan",
        # A completion is a pure text task: disallow every standard tool so a
        # session cannot browse the web or a filesystem for benchmark
        # content. parse_stream additionally counts tool_use blocks and any
        # non-zero count invalidates the trial (belt and suspenders).
        "--disallowedTools",
        "Task,Bash,BashOutput,KillBash,Glob,Grep,LS,Read,Edit,Write,MultiEdit,"
        "NotebookRead,NotebookEdit,WebFetch,WebSearch,TodoWrite,ExitPlanMode",
    ]


def parse_stream(path: Path) -> dict[str, Any]:
    result: dict[str, Any] | None = None
    tool_calls = 0
    assistant_models: set[str] = set()
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
        if event.get("type") == "assistant" and isinstance(event.get("message"), dict):
            if event["message"].get("model"):
                assistant_models.add(str(event["message"]["model"]))
            content = event["message"].get("content")
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    tool_calls += 1
    result = result or {}
    observed_models: set[str] = set(assistant_models)
    if isinstance(result.get("modelUsage"), dict):
        observed_models.update(str(model) for model in result["modelUsage"].keys())
    usage = result.get("usage") if isinstance(result.get("usage"), dict) else None
    normalized_usage = None
    if usage:
        normalized_usage = {
            "fresh_input_tokens": int(usage.get("input_tokens") or 0),
            "cache_read_tokens": int(usage.get("cache_read_input_tokens") or 0),
            "cache_write_tokens": int(usage.get("cache_creation_input_tokens") or 0),
            "output_tokens": int(usage.get("output_tokens") or 0),
        }
    return {
        "subtype": result.get("subtype"),
        "num_turns": result.get("num_turns"),
        "tool_calls": tool_calls,
        "observed_models": sorted(observed_models),
        "cost_usd": result.get("total_cost_usd") if isinstance(result.get("total_cost_usd"), (int, float)) else None,
        "usage": normalized_usage,
        "final_output": result.get("result") if isinstance(result.get("result"), str) else None,
    }


def parse_completion(output: str) -> str:
    """The instruction asks for one fenced block holding the single next
    line. The complete fenced content is the prediction — discarding extra
    lines would grade a contract-violating multi-line answer as a pass."""
    fenced = re.search(r"```[a-zA-Z]*\n(.*?)```", output, re.DOTALL)
    body = fenced.group(1) if fenced else output
    return body.strip("\n").rstrip()


def run_claude_completion(
    manifest: dict[str, Any], prompt: str, *, scratch: Path, trajectory: Path, session: str,
) -> dict[str, Any]:
    started = time.monotonic()
    timed_out = False
    isolated_home = scratch.parent / f".{scratch.name}-claude-home"
    try:
        completed = run_command(
            claude_command(manifest, prompt),
            cwd=scratch,
            env=command_env(session, isolated_home),
            stdout_path=trajectory,
            timeout=15 * 60,
        )
        exit_code = completed.returncode
        stderr = completed.stderr
    except subprocess.TimeoutExpired as error:
        timed_out = True
        exit_code = 124
        stderr = str(error)
    telemetry = parse_stream(trajectory) if trajectory.exists() else {
        "subtype": None, "num_turns": None, "tool_calls": None, "observed_models": [],
        "cost_usd": None, "usage": None, "final_output": None,
    }
    observed = telemetry.get("observed_models") or []
    telemetry.update(
        {
            "exit_code": exit_code,
            "timed_out": timed_out,
            "duration_ms": round((time.monotonic() - started) * 1000),
            # Observed from the trajectory, never asserted; foreign models
            # fail closed in run_attempt.
            "resolved_model": observed[0] if len(observed) == 1 else None,
            "stderr_tail": stderr[-2000:] if stderr else "",
        }
    )
    return telemetry


# ---------------------------------------------------------------------------
# Scoring (RepoBench / CrossCodeEval conventions, stdlib only)
# ---------------------------------------------------------------------------

def indel_distance(left: str, right: str) -> int:
    """Levenshtein with substitutions costed 2 (one delete + one insert), the
    distance underlying `fuzz.ratio` in the official RepoBench evaluator."""
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)
    previous = list(range(len(right) + 1))
    for row_index, left_char in enumerate(left, start=1):
        current = [row_index]
        for column_index, right_char in enumerate(right, start=1):
            current.append(min(
                previous[column_index] + 1,
                current[column_index - 1] + 1,
                previous[column_index - 1] + (0 if left_char == right_char else 2),
            ))
        previous = current
    return previous[-1]


def edit_similarity(prediction: str, target: str) -> int:
    """`fuzz.ratio` equivalent on the unmodified strings, as in the official
    evaluator: an integer percent from the indel distance. Indentation errors
    count against the score."""
    lensum = len(prediction) + len(target)
    if lensum == 0:
        return 100
    return int(round((lensum - indel_distance(prediction, target)) / lensum * 100))


def identifiers(text: str) -> set[str]:
    """CrossCodeEval-style identifier extraction (regex approximation):
    string literals and trailing comments are removed first so words inside
    them do not count as identifiers."""
    without_strings = re.sub(
        r"('''.*?'''|\"\"\".*?\"\"\"|'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\")",
        "", text, flags=re.DOTALL,
    )
    without_comments = re.sub(r"#.*$", "", without_strings, flags=re.MULTILINE)
    return {token for token in re.findall(r"[A-Za-z_]\w*", without_comments) if token not in PYTHON_KEYWORDS}


def identifier_f1(prediction: str, target: str) -> float:
    predicted = identifiers(prediction)
    expected = identifiers(target)
    # An empty denominator scores zero, matching the official CrossCodeEval
    # evaluator; identifier overlap is meaningless without identifiers.
    if not predicted or not expected:
        return 0.0
    overlap = len(predicted & expected)
    if overlap == 0:
        return 0.0
    precision = overlap / len(predicted)
    recall = overlap / len(expected)
    return round(2 * precision * recall / (precision + recall), 4)


def score_completion(prediction: str, target: str) -> dict[str, Any]:
    return {
        # Whitespace-token equality, matching the official RepoBench
        # evaluator's exact-match definition (`pred.split() == gt.split()`).
        "exact_match": prediction.split() == target.split(),
        "edit_similarity": edit_similarity(prediction, target),
        # Supplementary CrossCodeEval-style diagnostic, not a RepoBench
        # headline metric.
        "identifier_f1": identifier_f1(prediction, target),
    }


# ---------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------

def prepare_task_workspace(
    task: dict[str, Any], row: dict[str, Any], gold: dict[str, str], work_root: Path,
) -> Path:
    """Only the clone is cached; commit identity, content verification, and
    the index rebuild run unconditionally so a reused --work-root can never
    score a wrong commit, edited checkout, or stale index."""
    workspace = work_root / "repos" / task_slug(task["task_id"])
    if not workspace.exists():
        checkout(task["repo"], task["commit"], workspace)
    head = run_command(["git", "rev-parse", "HEAD"], cwd=workspace)
    if head.returncode != 0 or head.stdout.strip().lower() != task["commit"].lower():
        raise AdapterError(
            f"{task['task_id']}: workspace HEAD {head.stdout.strip() or 'unknown'} does not match pinned commit {task['commit']}"
        )
    status = run_command(["git", "status", "--porcelain=v1"], cwd=workspace)
    if status.returncode != 0:
        raise AdapterError(f"{task['task_id']}: git status failed in the workspace")
    dirty = [
        line for line in status.stdout.splitlines()
        # Only the Agentify index directory itself is expected untracked;
        # a `.agentify.yaml` or similar could alter scan behavior.
        if line.strip() and line[3:] != ".agentify" and not line[3:].startswith(".agentify/")
    ]
    if dirty:
        raise AdapterError(f"{task['task_id']}: workspace has local modifications; refusing to score it")
    task_file = workspace / task["file_path"]
    if not task_file.is_file():
        raise AdapterError(f"{task['task_id']}: pinned checkout is missing {task['file_path']}")
    if not verify_checkout_content(task_file.read_text(encoding="utf-8", errors="replace"), row):
        raise AdapterError(f"{task['task_id']}: pinned checkout content does not match the dataset row")
    gold_file = workspace / gold["path"]
    if not gold_file.is_file():
        raise AdapterError(f"{task['task_id']}: pinned checkout is missing gold file {gold['path']}")
    install_index(workspace)
    return workspace


def retrieval_phase(args: argparse.Namespace) -> None:
    manifest = load_manifest(args.manifest)
    ensure_tools(manifest, paid=False)
    output = Path(args.output)
    # Never desynchronize existing evidence: a graded job's retrieval
    # receipts belong to its paid attempts, and a finished retrieval run
    # should not be silently replaced.
    if (output / "job.json").exists():
        raise AdapterError(f"{output} already holds a completion job; choose a fresh output directory")
    if (output / "retrieval" / "summary.json").exists():
        raise AdapterError(f"{output} already holds retrieval results; choose a fresh output directory")
    tasks = selected_tasks(manifest, args.suite)
    cache_dir = Path(args.rows_cache) if args.rows_cache else None
    rows = fetch_rows(manifest, [task["row_index"] for task in tasks], cache_dir)
    work_root = Path(args.work_root) if args.work_root else Path(tempfile.mkdtemp(prefix="agentify-repobench-"))
    results = []
    try:
        for task in tasks:
            row = rows[task["row_index"]]
            gold = verify_row(task, row)
            workspace = prepare_task_workspace(task, row, gold, work_root)
            result = score_retrieval(workspace, task, row, gold)
            results.append(result)
            write_json(output / "retrieval" / "tasks" / f"{task_slug(task['task_id'])}.json", result)
            print(
                f"{task['task_id']} {task['repo']}: def_hit={result['def_hit']} "
                f"rank={result['gold_rank']} edge={result['ref_edge_hit']} impacts={result['impact_hit']}"
            )
    finally:
        if not args.work_root:
            shutil.rmtree(work_root, ignore_errors=True)
    summary = {
        **summarize_retrieval(results),
        "suite": args.suite,
        "dataset": manifest["dataset"],
        "agentify": manifest["pins"]["agentify"],
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cost_usd": 0,
    }
    write_json(output / "retrieval" / "summary.json", summary)
    print(json.dumps(summary, indent=2))


def cost_plan(manifest: dict[str, Any], suite: str) -> dict[str, Any]:
    tasks = selected_tasks(manifest, suite)
    attempts = int(manifest["suites"][suite].get("attempts", 1))
    trials = len(tasks) * len(manifest["arms"]) * attempts
    ceiling = trials * float(manifest["limits"]["completion_max_budget_usd"])
    return {
        "tasks": len(tasks),
        "attempts": attempts,
        "completion_trials": trials,
        "retrieval_cost_usd": 0,
        "max_spend_usd": round(ceiling, 6),
    }


def randomized_trial_order(
    tasks: list[dict[str, Any]], arms: list[str], attempts: int, *, rng: Any | None = None,
) -> list[dict[str, Any]]:
    generator = rng or secrets.SystemRandom()
    trials = [
        {"task_id": task["task_id"], "attempt": attempt_number}
        for task in tasks
        for attempt_number in range(1, attempts + 1)
    ]
    generator.shuffle(trials)
    for trial in trials:
        trial["arms"] = list(arms)
        generator.shuffle(trial["arms"])
    return trials


def run_attempt(
    manifest: dict[str, Any], task: dict[str, Any], row: dict[str, Any], *,
    arm: str, attempt_number: int, template: str, retrieval: dict[str, Any],
    context_block: str, context_entries: list[dict[str, Any]],
    work_root: Path, job_dir: Path,
) -> dict[str, Any]:
    # Unique per invocation: a reused --work-root must never resurrect an
    # earlier session's Claude home (settings, hooks, scratch state). The
    # name is opaque — an arm-labeled path or session id would leak the
    # treatment to the model through its working-directory context.
    session_token = secrets.token_hex(6)
    scratch = work_root / "sessions" / f"s-{session_token}"
    scratch.mkdir(parents=True)
    block = context_block if arm == "agentify" else ""
    prompt = build_prompt(template, row, context_block=block)
    next_line = str(row["next_line"])
    result_dir = job_dir / "attempts" / arm / task_slug(task["task_id"]) / str(attempt_number)
    trajectory = result_dir / "trajectory.jsonl"
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        provider = run_claude_completion(
            manifest, prompt, scratch=scratch,
            trajectory=trajectory,
            session=f"rb-{session_token}",
        )
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
        shutil.rmtree(scratch.parent / f".{scratch.name}-claude-home", ignore_errors=True)
    final_output = str(provider.pop("final_output", "") or "")
    clean_session = provider["exit_code"] == 0 and provider.get("tool_calls") == 0
    prediction = parse_completion(final_output) if clean_session else ""
    record = {
        "schema": ATTEMPT_SCHEMA,
        "task_id": task["task_id"],
        "repo": task["repo"],
        "commit": task["commit"],
        "file_path": task["file_path"],
        "level": task.get("level"),
        "arm": arm,
        "attempt": attempt_number,
        "model": manifest["model"],
        "started_at": started_at,
        "duration_ms": provider["duration_ms"],
        "provider": provider,
        "prediction": prediction,
        # The target stays inside the private, gitignored job artifact so the
        # importer can hash-verify it against the committed receipt and
        # recompute every score from prediction + target.
        "target": next_line,
        "context": {
            "snippets": len(context_entries) if arm == "agentify" else 0,
            "chars": len(block),
            "files": [entry["file_path"] for entry in context_entries] if arm == "agentify" else [],
            "answer_in_context": answer_leak_receipt(block, next_line),
            "gold_in_context": arm == "agentify" and gold_context_receipt(retrieval, context_entries),
        },
        "retrieval": {key: retrieval[key] for key in ("def_hit", "gold_rank", "ref_edge_hit", "impact_hit")}
            if arm == "agentify" else None,
        "trajectory_path": str(trajectory.relative_to(job_dir)),
        "score": score_completion(prediction, next_line) if clean_session else None,
    }
    write_json(result_dir / "result.json", record)
    if provider["exit_code"] != 0:
        raise AdapterError(
            f"completion provider failed for {task['task_id']} arm {arm} "
            f"attempt {attempt_number} with exit {provider['exit_code']}"
        )
    if provider.get("tool_calls") != 0:
        raise AdapterError(
            f"completion session for {task['task_id']} arm {arm} attempt {attempt_number} "
            f"used {provider.get('tool_calls')} tool call(s); tool-free completion is required"
        )
    requested_model = claude_model(manifest)
    if provider.get("resolved_model") != requested_model:
        raise AdapterError(
            f"completion session for {task['task_id']} arm {arm} attempt {attempt_number} "
            f"observed model(s) {provider.get('observed_models') or 'none'}; the pinned model "
            f"{requested_model} must be the only one observed"
        )
    return record


def run_suite(args: argparse.Namespace) -> None:
    manifest = load_manifest(args.manifest)
    plan = cost_plan(manifest, args.suite)
    print(json.dumps({"suite": args.suite, **plan}, indent=2))
    if not args.yes:
        raise AdapterError("paid inference blocked: rerun with --yes only after reviewing the ceiling")
    ensure_tools(manifest, paid=True)
    template = load_prompt_template()
    output = Path(args.output)
    if output.exists() and (output / "job.json").exists():
        raise AdapterError(f"job already exists at {output}; choose a fresh output directory")
    output.mkdir(parents=True, exist_ok=True)
    tasks = selected_tasks(manifest, args.suite)
    attempts = int(manifest["suites"][args.suite].get("attempts", 1))
    cache_dir = Path(args.rows_cache) if args.rows_cache else None
    rows = fetch_rows(manifest, [task["row_index"] for task in tasks], cache_dir)
    work_root = Path(args.work_root) if args.work_root else Path(tempfile.mkdtemp(prefix="agentify-repobench-"))
    job = {
        "schema": JOB_SCHEMA,
        "suite": args.suite,
        "dataset": manifest["dataset"],
        "pins": manifest["pins"],
        "model": manifest["model"],
        "limits": manifest["limits"],
        "selection_rule": manifest.get("selection_rule"),
        "build": build_receipt(),
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "max_spend_usd": plan["max_spend_usd"],
        "order": randomized_trial_order(tasks, list(manifest["arms"]), attempts),
        "status": "running",
    }
    write_json(output / "job.json", job)
    try:
        # Token-free preparation: verified checkout, index, retrieval, and the
        # frozen context block reused by every attempt of the task.
        prepared: dict[str, dict[str, Any]] = {}
        retrieval_results = []
        for task in tasks:
            row = rows[task["row_index"]]
            gold = verify_row(task, row)
            workspace = prepare_task_workspace(task, row, gold, work_root)
            queries = run_retrieval_queries(
                workspace, task["file_path"], query_symbols(str(row["import_statement"])),
            )
            retrieval = score_retrieval(workspace, task, row, gold, queries=queries)
            retrieval_results.append(retrieval)
            write_json(output / "retrieval" / "tasks" / f"{task_slug(task['task_id'])}.json", retrieval)
            block, entries = build_context_block(
                workspace, queries,
                max_snippets=int(manifest["limits"]["context_snippets"]),
                max_chars=int(manifest["limits"]["context_max_chars"]),
            )
            prepared[task["task_id"]] = {
                "row": row, "retrieval": retrieval, "block": block, "entries": entries,
            }
        retrieval_summary = {
            **summarize_retrieval(retrieval_results),
            "suite": args.suite,
            "dataset": manifest["dataset"],
            "agentify": manifest["pins"]["agentify"],
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "cost_usd": 0,
        }
        write_json(output / "retrieval" / "summary.json", retrieval_summary)
        job["retrieval_summary_path"] = "retrieval/summary.json"

        tasks_by_id = {task["task_id"]: task for task in tasks}
        for trial in job["order"]:
            task = tasks_by_id[trial["task_id"]]
            preparation = prepared[task["task_id"]]
            for arm in trial["arms"]:
                run_attempt(
                    manifest, task, preparation["row"],
                    arm=arm,
                    attempt_number=int(trial["attempt"]),
                    template=template,
                    retrieval=preparation["retrieval"],
                    context_block=preparation["block"],
                    context_entries=preparation["entries"],
                    work_root=work_root,
                    job_dir=output,
                )
        job["status"] = "graded"
        job["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write_json(output / "job.json", job)
    except AdapterError as error:
        job["status"] = "inference-errors"
        job["inference_error"] = str(error)
        job["failed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write_json(output / "job.json", job)
        raise
    finally:
        if not args.work_root:
            shutil.rmtree(work_root, ignore_errors=True)
    print(f"Scored completions written. Import with: agentify eval repobench import {output}")


# ---------------------------------------------------------------------------
# Sample selection (documents the committed selection rule executably)
# ---------------------------------------------------------------------------

def github_json(url: str) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": "agentify-repobench"})
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 - selection treats fetch failures as skips
        return None


def raw_github_file(repo: str, commit: str, file_path: str) -> str | None:
    url = f"https://raw.githubusercontent.com/{repo}/{commit}/{urllib.parse.quote(file_path)}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "agentify-repobench"}), timeout=30) as response:
            return response.read().decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return None


def resolve_verified_commit(
    repo: str, row: dict[str, Any], gold: dict[str, str], until: str, max_commits: int = 1000,
) -> str | None:
    """Search the file's commit history newest-first, paginated up to the
    disclosed max_commits cutoff, for a content-verified commit."""
    listing: list[dict[str, Any]] = []
    for page in range(1, (max_commits // 100) + 2):
        if len(listing) >= max_commits:
            break
        chunk = github_json(
            f"https://api.github.com/repos/{repo}/commits?path={urllib.parse.quote(row['file_path'])}"
            f"&until={until}&per_page=100&page={page}"
        )
        if not isinstance(chunk, list) or not chunk:
            break
        listing.extend(chunk)
    if not listing:
        return None
    for entry in listing[:max_commits]:
        commit = entry.get("sha")
        content = raw_github_file(repo, commit, row["file_path"]) if commit else None
        if content is None or not verify_checkout_content(content, row):
            continue
        gold_content = raw_github_file(repo, commit, gold["path"])
        if gold_content is None:
            continue
        # Selection must apply the same contiguous rule as the scorer's
        # snippet_span, or it would pin tasks whose snippet_hit can never
        # be true.
        if snippet_span(gold_content, gold["snippet"]) is not None:
            return commit
    return None


def select_sample(args: argparse.Namespace) -> None:
    """Regenerate the committed task list from the selection rule: first
    content-verified row per distinct repository, in dataset order."""
    manifest = load_manifest(args.manifest)
    dataset = manifest["dataset"]
    # Receipts must be generated from the exact revision the manifest labels;
    # a selection run against a moved HEAD would silently relabel the sample.
    require_pinned_dataset_head(dataset)
    tasks: list[dict[str, Any]] = []
    seen_repos: set[str] = set()
    offset = 0
    while len(tasks) < args.limit and offset < args.max_rows:
        query = urllib.parse.urlencode({
            "dataset": dataset["name"], "config": "default", "split": dataset["split"],
            "offset": offset, "length": 100,
        })
        request = urllib.request.Request(f"{ROWS_ENDPOINT}?{query}", headers={"User-Agent": "agentify-repobench"})
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.loads(response.read().decode("utf-8"))
        fetched = payload.get("rows") or []
        if not fetched:
            break
        for entry in fetched:
            if len(tasks) >= args.limit:
                break
            row = entry["row"]
            repo = str(row["repo_name"])
            # A repository is consumed only once a row for it verifies; an
            # earlier unverifiable row must not disqualify the repository, or
            # the rule would silently become "first row per repository".
            if repo in seen_repos:
                continue
            try:
                gold = gold_reference(row)
            except AdapterError:
                continue
            if gold["path"] == row["file_path"]:
                continue
            commit = resolve_verified_commit(repo, row, gold, args.until, args.max_commits)
            if not commit:
                print(
                    f"skip {entry['row_idx']} {repo}: no content-verified commit "
                    f"in the newest {args.max_commits} file commits",
                    file=sys.stderr,
                )
                continue
            seen_repos.add(repo)
            tasks.append({
                "task_id": f"{dataset['split']}/{entry['row_idx']}",
                "row_index": entry["row_idx"],
                "repo": repo,
                "commit": commit,
                "file_path": str(row["file_path"]),
                "level": str(row["level"]),
                "verification": {
                    **{receipt: sha256_text(str(row[field])) for field, receipt in HASHED_FIELDS.items()},
                    "next_line_token_sha256": sha256_text(" ".join(str(row["next_line"]).split())),
                    "gold_path_sha256": sha256_text(gold["path"]),
                    "gold_snippet_sha256": sha256_text(gold["snippet"]),
                },
            })
            print(f"verified {entry['row_idx']} {repo} @ {commit[:12]}", file=sys.stderr)
        offset += 100
    print(json.dumps(tasks, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    subcommands = parser.add_subparsers(dest="command", required=True)
    retrieval = subcommands.add_parser("retrieval", help="token-free index retrieval scoring against gold cross-file labels")
    retrieval.add_argument("--suite", default="repo-8")
    retrieval.add_argument("--output", type=Path, required=True)
    retrieval.add_argument("--work-root", type=Path)
    retrieval.add_argument("--rows-cache", type=Path)
    run = subcommands.add_parser("run", help="paired completion inference after an explicit ceiling confirmation")
    run.add_argument("--suite", default="smoke")
    run.add_argument("--output", type=Path, required=True)
    run.add_argument("--work-root", type=Path)
    run.add_argument("--rows-cache", type=Path)
    run.add_argument("--yes", action="store_true")
    select = subcommands.add_parser("select", help="regenerate the committed sample with the documented selection rule")
    select.add_argument("--limit", type=int, default=8)
    select.add_argument("--max-rows", type=int, default=500)
    select.add_argument("--until", default="2024-03-01T00:00:00Z")
    select.add_argument("--max-commits", type=int, default=1000,
                        help="newest-first per-file commit search cutoff (disclosed in skip messages)")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "retrieval":
            retrieval_phase(args)
        elif args.command == "run":
            run_suite(args)
        else:
            select_sample(args)
    except AdapterError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
