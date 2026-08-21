#!/usr/bin/env bash
set -euo pipefail

mkdir -p /logs/verifier 2>/dev/null || true
echo 0 > /logs/verifier/reward.txt 2>/dev/null || true
cd /app

node --test

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { queued, resetQueue } from "./src/queue.js";
import { scheduleRetry } from "./src/retry.js";

resetQueue();
const job = { id: "invoice-19", payload: { amount: 4200 } };
const first = scheduleRetry(job, 1);
const third = scheduleRetry(job, 3);
const capped = scheduleRetry(job, 12);

assert.equal(first.payload, job, "retry must preserve the original job object");
assert.deepEqual(
  [first.delayMs, third.delayMs, capped.delayMs],
  [1000, 2000, 5000],
  "retry delays must follow the recorded one-based schedule and cap",
);
assert.ok(queued.every((entry) => entry.lane === "recoverable"), "retries must use the recoverable queue lane");
NODE

echo 1 > /logs/verifier/reward.txt 2>/dev/null || true
