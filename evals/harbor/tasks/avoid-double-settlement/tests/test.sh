#!/usr/bin/env bash
set -euo pipefail

mkdir -p /logs/verifier 2>/dev/null || true
echo 0 > /logs/verifier/reward.txt 2>/dev/null || true
cd /app

node --test

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { captures, resetGateway } from "./src/gateway.js";
import * as settlement from "./src/settlement.js";

assert.equal(typeof settlement.settleInvoice, "function", "settleInvoice must be exported");
resetGateway();
settlement.resetSettlements?.();

const event = { id: "evt-88", invoiceId: "inv-42", amountCents: 9900 };
const first = settlement.settleInvoice(event);
const replay = settlement.settleInvoice({ ...event });
assert.deepEqual(replay, first, "a duplicate event must return the first receipt");
assert.equal(captures.length, 1, "a duplicate event must not capture twice");

assert.throws(
  () => settlement.settleInvoice({ ...event, amountCents: 9901 }),
  /settlement[_ ]event[_ ]conflict/i,
  "a conflicting replay must fail with the stable conflict error",
);
assert.equal(captures.length, 1, "a conflicting replay must not reach the gateway");
NODE

echo 1 > /logs/verifier/reward.txt 2>/dev/null || true
