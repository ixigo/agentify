import test from "node:test";
import assert from "node:assert/strict";

import { capture, captures, resetGateway } from "../src/gateway.js";

test("capture records a gateway receipt", () => {
  resetGateway();
  const receipt = capture("inv-1", 1250);
  assert.equal(receipt.id, "rcpt-1");
  assert.deepEqual(captures, [receipt]);
});
