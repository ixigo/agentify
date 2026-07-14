#!/usr/bin/env bash
# Deterministic verifier: exit 0 iff the trial passes. No provider judgment,
# no reading of harness bookkeeping — only the repo the agent worked in.
set -euo pipefail
cd /app

# The suite must stay green.
node --test

# Every source header now carries the bumped year, and none carries the old one.
test "$(grep -rl 'Copyright 2026 Example Corp' src | wc -l)" -eq 4
if grep -rn 'Copyright 2025' src; then
  echo "found a stale 2025 copyright line in src"
  exit 1
fi

# Nothing but the copyright lines changed: no other +/- lines in the src diff.
changed=$(git diff HEAD -- src | grep '^[+-]' | grep -v '^[+-][+-]' | grep -v 'Copyright' | wc -l || true)
test "$changed" -eq 0
