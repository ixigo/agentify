#!/usr/bin/env sh
# One-command paired Harbor smoke (#298): shows the maximum spend, asks for
# confirmation (skipped when CI=true), runs both agents on the smoke task,
# and imports the job into the native eval report.
#
# Prerequisites (see docs/harbor.md): Docker running, `harbor` installed at
# the pinned version, ANTHROPIC_API_KEY exported, agentify on PATH.
set -eu
cd "$(dirname "$0")"

SUITE="${1:-smoke}"

# plan/import resolve the dataset relative to the repo root, not this directory
REPO_ROOT="$(cd ../.. && pwd)"

agentify eval harbor plan --suite "$SUITE" --root "$REPO_ROOT"

if [ "${CI:-}" != "true" ]; then
  printf 'Launch this paid run? [y/N] '
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Aborted before any provider call."; exit 1 ;;
  esac
fi

# PYTHONPATH: harbor resolves the custom agent import path
# (agents.agentify_claude:AgentifyClaudeAgent) via Python imports, and the
# installed CLI does not add the working directory to sys.path. pipx installs
# harbor with a `python -E` shebang that IGNORES PYTHONPATH, so invoke the
# CLI app through the interpreter from harbor's own shebang instead.
HARBOR_BIN="$(command -v harbor)"
HARBOR_PY="$(head -1 "$HARBOR_BIN" | sed 's/^#!//; s/ -E$//')"
if [ -x "$HARBOR_PY" ]; then
  PYTHONPATH="$PWD" "$HARBOR_PY" -c 'from harbor.cli.main import app; app()' run -c "suites/$SUITE.yaml"
else
  PYTHONPATH="$PWD" harbor run -c "suites/$SUITE.yaml"
fi

# Import the newest job produced by this run into .agentify/evals/runs.
job_dir=$(ls -td jobs/*/ 2>/dev/null | head -1)
if [ -z "$job_dir" ]; then
  echo "No job directory found under jobs/ — nothing to import." >&2
  exit 1
fi
cd ../..
agentify eval harbor import "evals/harbor/$job_dir"
echo "Done. Render a report with: agentify eval report <run-id> --format html --out report.html"
