#!/usr/bin/env bash
# Oracle solution: lets `harbor run` with the oracle agent smoke the task
# end-to-end without any provider tokens.
set -euo pipefail
cd /app

cat > src/pricing.js <<'EOF'
// pricekit — order total helper.
// total() returns a dollars-and-cents string, e.g. "19.99".
export function total(subtotal, taxRate) {
  const cents = Math.round((subtotal * (1 + taxRate) + Number.EPSILON) * 100);
  return (cents / 100).toFixed(2);
}
EOF

node --test test/unit/*.test.js
