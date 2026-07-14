#!/usr/bin/env bash
# Deterministic verifier: exit 0 iff the trial passes. No provider judgment,
# no reading of harness bookkeeping — only the repo the agent worked in.
set -euo pipefail
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
