#!/usr/bin/env bash
# Oracle solution for the graded (recall) phase: lets `harbor run` with the
# oracle agent smoke the task end-to-end without any provider tokens. The seed
# phase is not part of the oracle path — the graded phase must stand alone.
set -euo pipefail
cd /app

cat > src/monthly.js <<'EOF'
// Bucket UTC ISO timestamps by calendar month. Uses UTC accessors so a
// late-in-the-day UTC timestamp is never pulled into the next month by the
// process timezone (the date-handling gotcha the seed phase recorded).
export function bucketByMonth(timestamps) {
  const counts = {};
  for (const iso of timestamps) {
    const key = new Date(iso).toISOString().slice(0, 7);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
EOF

cat > test/monthly.test.js <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { bucketByMonth } from "../src/monthly.js";

test("bucketByMonth groups by UTC month across a day boundary", () => {
  const out = bucketByMonth(["2026-03-31T23:30:00Z", "2026-03-01T00:00:00Z"]);
  assert.equal(out["2026-03"], 2);
  assert.equal(out["2026-04"], undefined);
});
EOF

node --test
