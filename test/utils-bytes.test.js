import test from "node:test";
import assert from "node:assert/strict";

import { bytes, clipToBytes } from "../src/core/utils/bytes.js";

test("bytes counts utf8 bytes with null-safe string conversion", () => {
  assert.equal(bytes("abc"), 3);
  assert.equal(bytes("é"), 2);
  assert.equal(bytes(null), 0);
  assert.equal(bytes(123), 3);
});

test("clipToBytes returns original text when it fits", () => {
  assert.equal(clipToBytes("short", 10), "short");
});

test("clipToBytes trims to byte budget with ellipsis", () => {
  const clipped = clipToBytes("hello world", 8);
  assert.equal(clipped, "hello...");
  assert.ok(bytes(clipped) <= 8);
});

test("clipToBytes returns empty string when no ellipsis can fit", () => {
  assert.equal(clipToBytes("hello", 2), "");
  assert.equal(clipToBytes("hello", 0), "");
});
