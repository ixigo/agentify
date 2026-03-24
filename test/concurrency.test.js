import test from "node:test";
import assert from "node:assert/strict";

import { mapWithConcurrency } from "../src/core/commands.js";

test("mapWithConcurrency preserves order and respects concurrency limit", async () => {
  let active = 0;
  let maxActive = 0;

  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(maxActive, 2);
});
