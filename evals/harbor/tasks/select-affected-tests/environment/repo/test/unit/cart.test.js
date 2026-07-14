import test from "node:test";
import assert from "node:assert/strict";

import { cartSubtotalCents, itemCount } from "../../src/cart.js";

const items = [
  { priceCents: 4599, qty: 2 },
  { priceCents: 1250, qty: 1 },
];

test("cartSubtotalCents sums price times quantity", () => {
  assert.equal(cartSubtotalCents(items), 10448);
});

test("itemCount sums quantities", () => {
  assert.equal(itemCount(items), 3);
});
