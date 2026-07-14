#!/usr/bin/env bash
# Oracle solution: lets `harbor run` with the oracle agent smoke the task
# end-to-end without any provider tokens.
set -euo pipefail
cd /app

for f in \
  src/shipping.js \
  src/checkout.js \
  src/quote.js \
  src/admin/report.js \
  test/shipping.test.js \
  test/checkout.test.js; do
  perl -pi -e 's/calcShipRate/quoteShippingRate/g' "$f"
done

node --test
