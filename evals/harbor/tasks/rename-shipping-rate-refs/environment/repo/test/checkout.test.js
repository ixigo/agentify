import test from "node:test";
import assert from "node:assert/strict";

import { checkoutTotal } from "../src/checkout.js";
import { calcShipRate } from "../src/shipping.js";

test("checkoutTotal adds shipping to the subtotal", () => {
  const shipping = calcShipRate(1, "domestic");
  assert.equal(checkoutTotal(1000, 1, "domestic"), 1000 + shipping);
});
