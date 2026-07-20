#!/usr/bin/env bash
set -euo pipefail
cd /app

cat > src/settlement.js <<'EOF'
import { capture } from "./gateway.js";

const settledByEvent = new Map();

export function settleInvoice(event) {
  const existing = settledByEvent.get(event.id);
  if (existing) {
    if (existing.invoiceId !== event.invoiceId || existing.amountCents !== event.amountCents) {
      throw new Error("settlement_event_conflict");
    }
    return existing.receipt;
  }

  const receipt = capture(event.invoiceId, event.amountCents);
  settledByEvent.set(event.id, {
    invoiceId: event.invoiceId,
    amountCents: event.amountCents,
    receipt,
  });
  return receipt;
}

export function resetSettlements() {
  settledByEvent.clear();
}
EOF

cat > test/settlement.test.js <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";

import { captures, resetGateway } from "../src/gateway.js";
import { resetSettlements, settleInvoice } from "../src/settlement.js";

test("a repeated settlement returns the original receipt", () => {
  resetGateway();
  resetSettlements();
  const event = { id: "evt-1", invoiceId: "inv-1", amountCents: 1250 };
  assert.equal(settleInvoice(event), settleInvoice(event));
  assert.equal(captures.length, 1);
});
EOF

node --test
