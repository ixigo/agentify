import test from "node:test";
import assert from "node:assert/strict";

import { paginate } from "../src/paginate.js";

const items = Array.from({ length: 30 }, (_, i) => i + 1);

test("a page never exceeds pageSize items", () => {
  assert.ok(paginate(items, 1, 10).length <= 10);
});

test("empty input yields an empty page", () => {
  assert.deepEqual(paginate([], 1, 10), []);
});
