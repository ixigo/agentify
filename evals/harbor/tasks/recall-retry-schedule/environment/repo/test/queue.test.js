import test from "node:test";
import assert from "node:assert/strict";

import { enqueue, queued, resetQueue } from "../src/queue.js";

test("enqueue records payload and options", () => {
  resetQueue();
  const job = { id: "job-7" };
  const entry = enqueue(job, { delayMs: 25 });
  assert.equal(entry.payload, job);
  assert.equal(entry.delayMs, 25);
  assert.deepEqual(queued, [entry]);
});
