#!/usr/bin/env bash
set -euo pipefail

mkdir -p /logs/verifier 2>/dev/null || true
echo 0 > /logs/verifier/reward.txt 2>/dev/null || true
cd /app

node --test

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { findCustomerByEmail } from "./src/customers.js";

assert.equal(findCustomerByEmail("  LINA@EXAMPLE.TEST ")?.id, "cus-1", "case and surrounding space must canonicalize");
assert.equal(
  findCustomerByEmail(" ＬＩＮＡ＠ＥＸＡＭＰＬＥ．ＴＥＳＴ ")?.id,
  "cus-1",
  "compatibility-equivalent full-width input must resolve to the existing identity",
);
assert.equal(
  findCustomerByEmail("caseysmith+vip@example.test"),
  null,
  "provider-specific dot removal must not merge distinct identities",
);
assert.equal(
  findCustomerByEmail("casey.smith@example.test"),
  null,
  "plus tags remain part of the mailbox identity",
);
NODE

echo 1 > /logs/verifier/reward.txt 2>/dev/null || true
