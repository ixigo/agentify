import test from "node:test";
import assert from "node:assert/strict";

import { findEvent } from "../src/events.js";

test("findEvent returns an event by id", () => {
  assert.equal(findEvent("evt-c")?.type, "captured");
  assert.equal(findEvent("missing"), null);
});
