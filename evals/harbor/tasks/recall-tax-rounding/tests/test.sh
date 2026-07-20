#!/usr/bin/env bash
set -euo pipefail

mkdir -p /logs/verifier 2>/dev/null || true
echo 0 > /logs/verifier/reward.txt 2>/dev/null || true
cd /app

node --test

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { calculateTax } from "./src/tax.js";

assert.equal(calculateTax(1000, 725), 72, "values below half a cent must round down");
assert.equal(calculateTax(1, 5000), 0, "0.5 cents must land on even zero");
assert.equal(calculateTax(3, 5000), 2, "1.5 cents must land on even two");
assert.equal(calculateTax(5, 5000), 2, "2.5 cents must remain on even two");
assert.equal(calculateTax(7, 5000), 4, "3.5 cents must land on even four");
NODE

echo 1 > /logs/verifier/reward.txt 2>/dev/null || true
