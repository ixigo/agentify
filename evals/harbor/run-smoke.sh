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

agentify eval harbor plan --suite "$SUITE"

if [ "${CI:-}" != "true" ]; then
  printf 'Launch this paid run? [y/N] '
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Aborted before any provider call."; exit 1 ;;
  esac
fi

harbor run -c "suites/$SUITE.yaml"

# Import the newest job produced by this run into .agentify/evals/runs.
job_dir=$(ls -td jobs/*/ 2>/dev/null | head -1)
if [ -z "$job_dir" ]; then
  echo "No job directory found under jobs/ — nothing to import." >&2
  exit 1
fi
cd ../..
agentify eval harbor import "evals/harbor/$job_dir"
echo "Done. Render a report with: agentify eval report <run-id> --format html --out report.html"
