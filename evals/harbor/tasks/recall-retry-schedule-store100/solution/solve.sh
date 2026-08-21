#!/usr/bin/env bash
set -euo pipefail
cd /app

cat > src/retry.js <<'EOF'
import { enqueue } from "./queue.js";

const RETRY_SECONDS = [1, 1, 2, 3, 5];

export function scheduleRetry(job, attempt) {
  const index = Math.max(0, Math.min(Math.trunc(attempt) - 1, RETRY_SECONDS.length - 1));
  return enqueue(job, {
    delayMs: RETRY_SECONDS[index] * 1000,
    lane: "recoverable",
  });
}
EOF

cat > test/retry.test.js <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";

import { resetQueue } from "../src/queue.js";
import { scheduleRetry } from "../src/retry.js";

test("scheduleRetry follows the recovery schedule", () => {
  resetQueue();
  const job = { id: "job-7" };
  assert.deepEqual(scheduleRetry(job, 3), {
    payload: job,
    delayMs: 2000,
    lane: "recoverable",
  });
});
EOF

node --test
