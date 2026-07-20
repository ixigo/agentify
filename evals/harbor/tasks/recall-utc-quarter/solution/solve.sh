#!/usr/bin/env bash
# Oracle solution for the graded (recall) phase: lets `harbor run` with the
# oracle agent smoke the task end-to-end without any provider tokens. The seed
# phase is not part of the oracle path — the graded phase must stand alone.
set -euo pipefail
cd /app

cat > src/quarter.js <<'EOF'
// Bucket UTC ISO timestamps by calendar quarter (YYYY-Qn). Uses UTC accessors
// so a late-in-the-day UTC timestamp is never pulled into the next quarter by
// the process timezone (the date-handling gotcha the seed phase recorded).
export function bucketByQuarter(timestamps) {
  const counts = {};
  for (const iso of timestamps) {
    const date = new Date(iso);
    const year = date.getUTCFullYear();
    const q = Math.floor(date.getUTCMonth() / 3) + 1;
    const key = `${year}-Q${q}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
EOF

cat > test/quarter.test.js <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { bucketByQuarter } from "../src/quarter.js";

test("bucketByQuarter groups by UTC quarter across a quarter boundary", () => {
  const out = bucketByQuarter(["2026-03-31T23:30:00Z", "2026-01-15T00:00:00Z"]);
  assert.equal(out["2026-Q1"], 2);
  assert.equal(out["2026-Q2"], undefined);
});
EOF

node --test
