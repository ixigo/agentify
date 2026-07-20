import test from "node:test";
import assert from "node:assert/strict";
import { sumAmounts } from "../src/report.js";

test("sumAmounts totals record amounts", () => {
  assert.equal(sumAmounts([{ amount: 10 }, { amount: 5 }]), 15);
});
