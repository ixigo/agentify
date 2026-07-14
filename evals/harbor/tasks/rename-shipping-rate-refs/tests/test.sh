#!/usr/bin/env bash
# Deterministic verifier: exit 0 iff the trial passes. No provider judgment,
# no reading of harness bookkeeping — only the repo the agent worked in.
set -euo pipefail

# Harbor reward contract: the verifier reads /logs/verifier/reward.txt (or
# reward.json); the exit code alone is never scored. Fail-closed: reward 0 is
# written up front and only flipped to 1 after every check passes. Writes are
# best-effort so the same script runs outside the container for local checks.
mkdir -p /logs/verifier 2>/dev/null || true
echo 0 > /logs/verifier/reward.txt 2>/dev/null || true
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

echo 1 > /logs/verifier/reward.txt 2>/dev/null || true
