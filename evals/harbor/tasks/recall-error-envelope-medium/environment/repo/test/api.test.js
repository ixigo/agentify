import test from "node:test";
import assert from "node:assert/strict";

import { getUser } from "../src/api.js";

test("getUser returns the user", () => {
  const response = getUser("u-1");
  assert.equal(response.status, 200);
  assert.equal(response.body.name, "Asha");
});

test("getUser uses the error envelope for unknown ids", () => {
  const response = getUser("u-404");
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "user_not_found");
});
