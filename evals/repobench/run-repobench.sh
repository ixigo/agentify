#!/usr/bin/env sh
# Token-free retrieval scoring plus optional paid paired completion. Nothing
# calls a provider until the printed ceiling is confirmed.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUITE="${1:-smoke}"
JOB_ID="$(date -u +%Y%m%d-%H%M%S)-$SUITE"
JOB_DIR="evals/repobench/jobs/$JOB_ID"

cd "$REPO_ROOT"
agentify eval repobench validate
agentify eval repobench plan --suite "$SUITE"

python3 evals/repobench/runner.py retrieval --suite "$SUITE" --output "$JOB_DIR"

if [ "${CI:-}" != "true" ]; then
  printf 'Retrieval scoring is done ($0). Launch the paid completion run? [y/N] '
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Stopped after the free retrieval phase."; exit 0 ;;
  esac
fi

# Same job directory: the paid run regenerates retrieval evidence in place
# (pinned inputs make it deterministic), so nothing orphaned is left behind
# and the imported evidence is the evidence of this job.
python3 evals/repobench/runner.py run --suite "$SUITE" --output "$JOB_DIR" --yes
agentify eval repobench import "$JOB_DIR"

echo "Done. Render the printed run id with: agentify eval report <run-id> --format html --out report.html"
