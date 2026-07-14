import test from "node:test";
import assert from "node:assert/strict";

import { total } from "../../src/pricing.js";

test("total rounds half-up to cents", () => {
  assert.equal(total(19.995, 0), "20.00");
  assert.equal(total(0.125, 0), "0.13");
  assert.equal(total(2.675, 0), "2.68");
});

test("total applies the tax rate then rounds", () => {
  assert.equal(total(100, 0.1), "110.00");
});
