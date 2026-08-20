import test from "node:test";
import assert from "node:assert/strict";

import { fetchAll } from "../src/fetchAll.js";

test("returns one result per id, in input order", async () => {
  const ids = ["a", "b", "c", "d"];
  const results = await fetchAll(ids, async (id) => `profile:${id}`);
  assert.deepEqual(results, ["profile:a", "profile:b", "profile:c", "profile:d"]);
});

test("propagates fetcher failures", async () => {
  await assert.rejects(
    fetchAll(["ok", "boom"], async (id) => {
      if (id === "boom") throw new Error("upstream 500");
      return id;
    }),
    /upstream 500/,
  );
});

test("handles an empty id list", async () => {
  assert.deepEqual(await fetchAll([], async () => {
    throw new Error("must not be called");
  }), []);
});
