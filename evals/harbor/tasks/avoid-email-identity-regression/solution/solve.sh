#!/usr/bin/env bash
set -euo pipefail
cd /app

cat >> src/customers.js <<'EOF'

export function canonicalCustomerEmail(email) {
  return email.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

export function findCustomerByEmail(email) {
  const target = canonicalCustomerEmail(email);
  return customers.find((customer) => canonicalCustomerEmail(customer.email) === target) ?? null;
}
EOF

cat > test/customer-email.test.js <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";

import { findCustomerByEmail } from "../src/customers.js";

test("findCustomerByEmail applies the sign-in identity contract", () => {
  assert.equal(findCustomerByEmail("  LINA@EXAMPLE.TEST ")?.id, "cus-1");
  assert.equal(findCustomerByEmail("caseysmith@example.test"), null);
});
EOF

node --test
