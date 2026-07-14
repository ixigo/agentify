#!/usr/bin/env bash
# Deterministic verifier: exit 0 iff the trial passes. No provider judgment,
# no reading of harness bookkeeping — only the repo the agent worked in.
set -euo pipefail

# Harbor reward contract: the verifier reads /logs/verifier/reward.txt (or
# reward.json); the exit code alone is never scored. Fail-closed: reward 0 is
# written up front and only flipped to 1 after every check passes. Writes are
# best-effort so the same script runs outside the container for local checks.
mkdir -p /logs/verifier 2>/dev/null || true
echo 0 > /logs/verifier/reward.txt 2>/dev/null || true
cd /app

# The suite must be green under zones on both sides of UTC.
TZ=America/New_York node --test
TZ=Asia/Tokyo node --test

# Behavioral check under a third zone: formatting is timezone-independent.
TZ=America/Los_Angeles node --input-type=module -e '
import { formatDay } from "/app/src/dates.js";
if (formatDay(new Date("2026-03-02T02:30:00Z")) !== "2026-03-02") {
  console.error("formatDay is not timezone-independent under America/Los_Angeles");
  process.exit(1);
}
if (formatDay(new Date("2027-01-01T04:00:00Z")) !== "2027-01-01") {
  console.error("formatDay is not timezone-independent under America/Los_Angeles");
  process.exit(1);
}
'

# The fix must live in the source, not a pinned timezone in tests or scripts.
if grep -rn "TZ=" package.json test; then
  echo "found a pinned timezone in package.json or test/"
  exit 1
fi

echo 1 > /logs/verifier/reward.txt 2>/dev/null || true
