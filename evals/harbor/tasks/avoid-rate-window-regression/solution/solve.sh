#!/usr/bin/env bash
set -euo pipefail
cd /app

cat > src/rate-limit.js <<'EOF'
export function allowRequest(timestamps, nowMs, { limit, windowMs }) {
  const cutoff = nowMs - windowMs;
  const active = timestamps.filter((timestamp) => timestamp > cutoff && timestamp <= nowMs);
  return active.length < limit;
}
EOF

cat > test/rate-limit.test.js <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";

import { allowRequest } from "../src/rate-limit.js";

test("allowRequest applies the production window boundaries", () => {
  const times = [9000, 9001, 10000, 10001];
  assert.equal(allowRequest(times, 10000, { limit: 3, windowMs: 1000 }), true);
  assert.equal(allowRequest(times, 10000, { limit: 2, windowMs: 1000 }), false);
});
EOF

node --test
