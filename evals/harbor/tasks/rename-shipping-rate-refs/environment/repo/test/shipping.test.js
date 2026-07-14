import test from "node:test";
import assert from "node:assert/strict";

import { calcShipRate } from "../src/shipping.js";

test("calcShipRate scales by the zone multiplier", () => {
  const domestic = calcShipRate(1, "domestic");
  const international = calcShipRate(1, "international");
  assert.ok(international > domestic);
});

test("calcShipRate falls back to domestic for unknown zones", () => {
  assert.equal(calcShipRate(2, "mars"), calcShipRate(2, "domestic"));
});
