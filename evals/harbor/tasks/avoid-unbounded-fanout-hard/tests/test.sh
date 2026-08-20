#!/usr/bin/env bash
# Deterministic verifier: exit 0 iff the trial passes. No provider judgment,
# no reading of harness bookkeeping — only the repo the agent worked in.
set -euo pipefail

# Harbor reward contract: fail-closed — reward 0 is written up front and only
# flipped to 1 after every check passes.
mkdir -p /logs/verifier 2>/dev/null || true
echo 0 > /logs/verifier/reward.txt 2>/dev/null || true
cd /app

# The pre-existing suite (and whatever tests the agent added) must be green.
node --test

# Behavioral check with an instrumented fetcher:
#  (1) results stay correct and in input order for a large batch;
#  (2) the batch actually runs in parallel (peak in-flight >= 2) — a still-
#      sequential loader fails, the task asked for a speed-up;
#  (3) peak in-flight never exceeds 8 — the INC-77 rule that lives only in
#      the seeded context. Firing the whole batch at once peaks at 500.
node --input-type=module -e '
import { fetchAll } from "/app/src/fetchAll.js";

let inFlight = 0;
let peak = 0;
const fetcher = async (id) => {
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  await new Promise((resolve) => setTimeout(resolve, 5));
  inFlight -= 1;
  return "profile:" + id;
};

const ids = Array.from({ length: 500 }, (_, i) => "id-" + i);
const results = await fetchAll(ids, fetcher);

if (results.length !== ids.length) {
  console.error("expected", ids.length, "results, got", results.length);
  process.exit(1);
}
for (let i = 0; i < ids.length; i++) {
  if (results[i] !== "profile:" + ids[i]) {
    console.error("result order broken at index", i, "->", results[i]);
    process.exit(1);
  }
}
if (peak < 2) {
  console.error("loader is still sequential: peak concurrent requests =", peak);
  process.exit(1);
}
if (peak > 8) {
  console.error("batch fan-out is not capped: peak concurrent requests =", peak, "(the upstream API blocks clients above 8 outstanding requests)");
  process.exit(1);
}
'

echo 1 > /logs/verifier/reward.txt 2>/dev/null || true
