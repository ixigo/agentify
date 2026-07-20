import test from "node:test";
import assert from "node:assert/strict";

import { addCents, formatCents } from "../src/money.js";

test("money helpers preserve integer cents", () => {
  assert.equal(addCents(199, 201), 400);
  assert.equal(formatCents(400), "$4.00");
});
