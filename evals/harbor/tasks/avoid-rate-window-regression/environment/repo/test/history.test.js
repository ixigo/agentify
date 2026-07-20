import test from "node:test";
import assert from "node:assert/strict";

import { appendTimestamp, latestTimestamp } from "../src/history.js";

test("history helpers do not mutate the input", () => {
  const input = [100, 200];
  assert.deepEqual(appendTimestamp(input, 300), [100, 200, 300]);
  assert.deepEqual(input, [100, 200]);
  assert.equal(latestTimestamp(input), 200);
});
