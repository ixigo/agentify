#!/usr/bin/env sh
# Paid paired inference + official SWE-bench grading. Nothing calls a provider
# until the printed ceiling is confirmed.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUITE="${1:-smoke}"
JOB_ID="$(date -u +%Y%m%d-%H%M%S)-$SUITE"
JOB_DIR="evals/swebench/jobs/$JOB_ID"

cd "$REPO_ROOT"
agentify eval swebench validate
agentify eval swebench plan --suite "$SUITE"

if [ "${CI:-}" != "true" ]; then
  printf 'Launch this paid run? [y/N] '
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Aborted before any provider call."; exit 1 ;;
  esac
fi

python3 evals/swebench/runner.py run --suite "$SUITE" --output "$JOB_DIR" --yes
python3 evals/swebench/runner.py grade --job "$JOB_DIR"
agentify eval swebench import "$JOB_DIR"

echo "Done. Render the printed run id with: agentify eval report <run-id> --format html --out report.html"
