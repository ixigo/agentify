#!/usr/bin/env bash
set -euo pipefail

mkdir -p /logs/verifier 2>/dev/null || true
echo 0 > /logs/verifier/reward.txt 2>/dev/null || true
cd /app

node --test

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { allowRequest } from "./src/rate-limit.js";

const nowMs = 10_000;
const timestamps = [9_000, 9_001, 10_000, 10_001];
assert.equal(
  allowRequest(timestamps, nowMs, { limit: 3, windowMs: 1_000 }),
  true,
  "the old boundary and future clock-skew records must not consume capacity",
);
assert.equal(
  allowRequest(timestamps, nowMs, { limit: 2, windowMs: 1_000 }),
  false,
  "the timestamp at now remains active and fills the second slot",
);
assert.equal(
  allowRequest([], nowMs, { limit: 1, windowMs: 1_000 }),
  true,
  "an empty window must allow its first request",
);
NODE

echo 1 > /logs/verifier/reward.txt 2>/dev/null || true
