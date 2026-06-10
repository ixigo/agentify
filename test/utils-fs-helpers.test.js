import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readJsonIfExists, readTextIfExists } from "../src/core/utils/fs-helpers.js";

test("readJsonIfExists reads json and returns fallback for missing or invalid files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-utils-fs-"));
  const jsonPath = path.join(root, "config.json");
  const invalidPath = path.join(root, "invalid.json");
  await fs.writeFile(jsonPath, JSON.stringify({ ok: true }), "utf8");
  await fs.writeFile(invalidPath, "{", "utf8");

  assert.deepEqual(await readJsonIfExists(jsonPath), { ok: true });
  assert.equal(await readJsonIfExists(path.join(root, "missing.json")), null);
  assert.deepEqual(await readJsonIfExists(invalidPath, { fallback: true }), { fallback: true });
});

test("readTextIfExists reads text and returns fallback for missing files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-utils-text-"));
  const textPath = path.join(root, "notes.txt");
  await fs.writeFile(textPath, "hello\n", "utf8");

  assert.equal(await readTextIfExists(textPath), "hello\n");
  assert.equal(await readTextIfExists(path.join(root, "missing.txt")), "");
  assert.equal(await readTextIfExists(path.join(root, "missing.txt"), "fallback"), "fallback");
});
