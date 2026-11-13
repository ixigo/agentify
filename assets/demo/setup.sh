#!/usr/bin/env bash
# Build a throwaway "fare-calc" repo for the README demo and print its path.
# Usage: DEMO_DIR=$(assets/demo/setup.sh)
set -euo pipefail

dir="$(mktemp -d)/fare-calc"
mkdir -p "$dir/src" "$dir/test"
cd "$dir"

git init -q -b main
git config user.name demo
git config user.email demo@example.com

echo '{ "name": "fare-calc", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test" } }' > package.json
echo "export const baseFare = (km) => Math.max(50, km * 1.5);" > src/fare.js
cat > test/fare.test.js <<'JS'
import test from 'node:test'; import assert from 'node:assert';
import { baseFare } from '../src/fare.js';
test('min fare', () => assert.equal(baseFare(1), 50));
JS
git add -A && git commit -qm "feat: base fare"

agentify install --provider claude --skip-mcp --no-progress >/dev/null 2>&1
git add -A && git commit -qm "chore: agentify install"

cat > src/discount.js <<'JS'
import { baseFare } from './fare.js';
export const withCoupon = (km, pct) => baseFare(km) * (1 - pct / 100);
JS
cat > test/discount.test.js <<'JS'
import test from 'node:test'; import assert from 'node:assert';
import { withCoupon } from '../src/discount.js';
test('10% off', () => assert.equal(withCoupon(100, 10), 135));
JS
git add -A && git commit -qm "feat: coupons"

echo "export const gst = (amt) => amt * 0.05;" > src/tax.js
cat > test/tax.test.js <<'JS'
import test from 'node:test'; import assert from 'node:assert';
import { gst } from '../src/tax.js';
test('5% gst', () => assert.equal(gst(200), 10));
JS
git add -A && git commit -qm "feat: gst"

echo "export const gst = (amt) => Math.round(amt * 0.05 * 100) / 100;" > src/tax.js
git add -A && git commit -qm "fix: round gst to paise"

agentify scan >/dev/null 2>&1
echo "$dir"
