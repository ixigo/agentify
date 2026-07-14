import test from "node:test";
import assert from "node:assert/strict";

import { createLogger, formatLine, levelValue } from "../src/index.js";

test("logger emits lines at or above the threshold", () => {
  const log = createLogger("info");
  assert.equal(log.log("debug", "hidden"), null);
  const line = log.log("warn", "shown", { a: 1 });
  assert.deepEqual(JSON.parse(line), { level: "warn", message: "shown", a: 1 });
});

test("levelValue falls back to info for unknown names", () => {
  assert.equal(levelValue("nope"), 20);
});

test("formatLine serializes level, message, and fields", () => {
  assert.deepEqual(JSON.parse(formatLine("info", "hi", { x: 2 })), {
    level: "info",
    message: "hi",
    x: 2,
  });
});
