#!/usr/bin/env bash
set -euo pipefail

mkdir -p /logs/verifier 2>/dev/null || true
echo 0 > /logs/verifier/reward.txt 2>/dev/null || true
cd /app

node --test

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { listEvents } from "./src/events.js";

const first = listEvents({ limit: 2 });
assert.deepEqual(first.items.map((event) => event.id), ["evt-a", "evt-b"], "first page must preserve order");
assert.deepEqual(Object.keys(first).sort(), ["items", "next_cursor"], "response must use the deployed field shape");
assert.equal(first.next_cursor, Buffer.from("evt-b").toString("base64url"), "cursor must encode the last event id");

const second = listEvents({ limit: 2, cursor: first.next_cursor });
assert.deepEqual(second.items.map((event) => event.id), ["evt-c", "evt-d"], "cursor must be exclusive");
assert.equal(second.next_cursor, null, "the final page must expose a null cursor");
NODE

echo 1 > /logs/verifier/reward.txt 2>/dev/null || true
