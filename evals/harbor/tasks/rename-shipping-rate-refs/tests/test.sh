#!/usr/bin/env bash
# Deterministic verifier: exit 0 iff the trial passes. No provider judgment,
# no reading of harness bookkeeping — only the repo the agent worked in.
set -euo pipefail
cd /app

# The pre-existing suite (renamed to the new symbol) must be green.
node --test

# No trace of the old name may remain anywhere in src or test.
if grep -rn "calcShipRate" src test; then
  echo "the old name calcShipRate still appears in the tree" >&2
  exit 1
fi

# The new name must be present in the definition and every source call site,
# including the nested admin report.
grep -rq "quoteShippingRate" src/shipping.js src/checkout.js src/quote.js src/admin/report.js
