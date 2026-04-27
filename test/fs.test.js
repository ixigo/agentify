import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resetIgnoreCache, walkFiles, relative } from "../src/core/fs.js";

test("walkFiles respects hard excludes and does not leak ignore cache across roots", async () => {
  resetIgnoreCache();

  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-fs-a-"));
  await fs.writeFile(path.join(rootA, ".agentignore"), "ignored.js\n", "utf8");
  await fs.mkdir(path.join(rootA, "docs"), { recursive: true });
  await fs.mkdir(path.join(rootA, ".agents"), { recursive: true });
  await fs.mkdir(path.join(rootA, ".codex", "skills"), { recursive: true });
  await fs.mkdir(path.join(rootA, ".claude", "skills"), { recursive: true });
  await fs.mkdir(path.join(rootA, "src"), { recursive: true });
  await fs.writeFile(path.join(rootA, "ignored.js"), "export const ignored = true;\n", "utf8");
  await fs.writeFile(path.join(rootA, "docs", "manual.md"), "# generated\n", "utf8");
  await fs.writeFile(path.join(rootA, ".agents", "index.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(rootA, ".codex", "skills", "helper.md"), "# hidden\n", "utf8");
  await fs.writeFile(path.join(rootA, ".claude", "skills", "helper.md"), "# hidden\n", "utf8");
  await fs.writeFile(path.join(rootA, "src", "index.ts"), "export const ok = true;\n", "utf8");

  const filesA = (await walkFiles(rootA, { respectIgnore: true })).map((file) => relative(rootA, file));
  assert.deepEqual(filesA, [".agentignore", "src/index.ts"]);

  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-fs-b-"));
  await fs.writeFile(path.join(rootB, "ignored.js"), "export const kept = true;\n", "utf8");

  const filesB = (await walkFiles(rootB, { respectIgnore: true })).map((file) => relative(rootB, file));
  assert.deepEqual(filesB, ["ignored.js"]);
});

test("walkFiles picks up .agentignore mutations within the same root", async () => {
  resetIgnoreCache();

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-fs-mutate-"));
  await fs.writeFile(path.join(root, ".agentignore"), "ignored.js\n", "utf8");
  await fs.writeFile(path.join(root, "ignored.js"), "export const x = 1;\n", "utf8");

  const before = (await walkFiles(root, { respectIgnore: true })).map((file) => relative(root, file));
  assert.deepEqual(before, [".agentignore"]);

  // Bump mtime far enough that low-resolution filesystems still register a change.
  const future = new Date(Date.now() + 2000);
  await fs.writeFile(path.join(root, ".agentignore"), "", "utf8");
  await fs.utimes(path.join(root, ".agentignore"), future, future);

  const after = (await walkFiles(root, { respectIgnore: true })).map((file) => relative(root, file));
  assert.deepEqual(after.sort(), [".agentignore", "ignored.js"]);
});

test("walkFiles picks up a newly created .agentignore within the same root", async () => {
  resetIgnoreCache();

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-fs-create-"));
  await fs.writeFile(path.join(root, "ignored.js"), "export const x = 1;\n", "utf8");

  const before = (await walkFiles(root, { respectIgnore: true })).map((file) => relative(root, file));
  assert.deepEqual(before, ["ignored.js"]);

  await fs.writeFile(path.join(root, ".agentignore"), "ignored.js\n", "utf8");

  const after = (await walkFiles(root, { respectIgnore: true })).map((file) => relative(root, file));
  assert.deepEqual(after, [".agentignore"]);
});
