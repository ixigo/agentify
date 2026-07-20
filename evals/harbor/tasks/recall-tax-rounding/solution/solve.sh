#!/usr/bin/env bash
set -euo pipefail
cd /app

cat > src/tax.js <<'EOF'
function roundHalfEven(numerator, divisor) {
  const quotient = Math.trunc(numerator / divisor);
  const remainder = numerator % divisor;
  if (remainder * 2 < divisor) return quotient;
  if (remainder * 2 > divisor) return quotient + 1;
  return quotient % 2 === 0 ? quotient : quotient + 1;
}

export function calculateTax(amountCents, rateBasisPoints) {
  return roundHalfEven(amountCents * rateBasisPoints, 10_000);
}
EOF

cat > test/tax.test.js <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";

import { calculateTax } from "../src/tax.js";

test("calculateTax rounds exact halves to the even cent", () => {
  assert.equal(calculateTax(1, 5000), 0);
  assert.equal(calculateTax(3, 5000), 2);
  assert.equal(calculateTax(5, 5000), 2);
});
EOF

node --test
