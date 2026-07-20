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

# The whole suite (pre-existing + whatever the agent added, in either phase)
# must be green under the container's non-UTC timezone.
node --test

# Behavioral check: bucketByQuarter must bucket by UTC quarter. Under this
# container's UTC+14 timezone a naive local-time implementation pulls a
# late-in-the-day UTC March timestamp into Q2 (April); only UTC-based
# extraction keeps both Q1 timestamps in 2026-Q1. This is the prior-failure
# lesson the recall phase has to carry forward.
node --input-type=module -e '
import * as quarter from "/app/src/quarter.js";

const bucket = quarter.bucketByQuarter;
if (typeof bucket !== "function") {
  console.error("src/quarter.js must export a bucketByQuarter function");
  process.exit(1);
}

const raw = bucket(["2026-03-31T23:30:00Z", "2026-01-15T00:00:00Z"]);
// Accept either a plain object or a Map.
const get = (key) => (raw instanceof Map ? raw.get(key) : raw?.[key]);

if (get("2026-Q1") !== 2) {
  console.error("expected 2 timestamps in 2026-Q1 (UTC), got", JSON.stringify(raw instanceof Map ? Object.fromEntries(raw) : raw));
  process.exit(1);
}
if (get("2026-Q2")) {
  console.error("late-UTC March timestamp leaked into 2026-Q2 — local-time bug", JSON.stringify(raw instanceof Map ? Object.fromEntries(raw) : raw));
  process.exit(1);
}
'

# The agent was asked to add a quarterly test.
grep -qi "bucketByQuarter" test/quarter.test.js

echo 1 > /logs/verifier/reward.txt 2>/dev/null || true
