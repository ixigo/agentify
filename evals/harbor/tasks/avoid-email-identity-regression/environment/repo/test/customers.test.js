import test from "node:test";
import assert from "node:assert/strict";

import { findCustomerById } from "../src/customers.js";

test("findCustomerById returns known customers and null otherwise", () => {
  assert.equal(findCustomerById("cus-1")?.name, "Lina");
  assert.equal(findCustomerById("missing"), null);
});
