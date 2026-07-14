import test from "node:test";
import assert from "node:assert/strict";

import { encodeCursor, decodeCursor } from "../src/cursor.js";

test("cursor roundtrips an offset", () => {
  for (const offset of [0, 1, 10, 137]) {
    assert.equal(decodeCursor(encodeCursor(offset)), offset);
  }
});

test("decodeCursor rejects a malformed token", () => {
  assert.throws(() => decodeCursor("not-a-real-cursor"));
});
