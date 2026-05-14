import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  appendPrivateText,
  ensurePrivateDir,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  resetIgnoreCache,
  walkFiles,
  relative,
  writePrivateJson,
  writePrivateText,
} from "../src/core/fs.js";

async function runGit(root, args) {
  await new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString("utf8") || `git ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function modeOf(targetPath) {
  return (await fs.stat(targetPath)).mode & 0o777;
}

function withUmask(t, mask) {
  const previous = process.umask(mask);
  t.after(() => {
    process.umask(previous);
  });
}

test("private fs helpers create restrictive directories and files independent of umask", async (t) => {
  if (process.platform === "win32") {
    return;
  }
  withUmask(t, 0o000);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-fs-private-"));
  const dir = path.join(root, ".agentify", "session", "sess_private");
  const jsonPath = path.join(dir, "context.json");
  const textPath = path.join(dir, "transcript.md");
  const appendPath = path.join(dir, "turns.jsonl");

  await ensurePrivateDir(dir);
  await writePrivateJson(jsonPath, { ok: true });
  await writePrivateText(textPath, "secret\n");
  await appendPrivateText(appendPath, "{\"ok\":true}\n");

  assert.equal(await modeOf(dir), PRIVATE_DIR_MODE);
  assert.equal(await modeOf(jsonPath), PRIVATE_FILE_MODE);
  assert.equal(await modeOf(textPath), PRIVATE_FILE_MODE);
  assert.equal(await modeOf(appendPath), PRIVATE_FILE_MODE);
});

test("walkFiles respects hard excludes and does not leak ignore cache across roots", async () => {
  resetIgnoreCache();

  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-fs-a-"));
  await fs.writeFile(path.join(rootA, ".agentignore"), "ignored.js\n", "utf8");
  await fs.mkdir(path.join(rootA, "docs"), { recursive: true });
  await fs.mkdir(path.join(rootA, ".agentify"), { recursive: true });
  await fs.mkdir(path.join(rootA, ".codex", "skills"), { recursive: true });
  await fs.mkdir(path.join(rootA, ".claude", "skills"), { recursive: true });
  await fs.mkdir(path.join(rootA, "src"), { recursive: true });
  await fs.mkdir(path.join(rootA, "packages", "app"), { recursive: true });
  await fs.writeFile(path.join(rootA, "ignored.js"), "export const ignored = true;\n", "utf8");
  await fs.writeFile(path.join(rootA, "docs", "manual.md"), "# generated\n", "utf8");
  await fs.writeFile(path.join(rootA, ".agentify", "index.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(rootA, ".codex", "skills", "helper.md"), "# hidden\n", "utf8");
  await fs.writeFile(path.join(rootA, ".claude", "skills", "helper.md"), "# hidden\n", "utf8");
  await fs.writeFile(path.join(rootA, "src", "index.ts"), "export const ok = true;\n", "utf8");
  await fs.writeFile(path.join(rootA, "packages", "app", "AGENTIFY.md"), "# generated module doc\n", "utf8");

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

test("walkFiles picks up same-length .agentignore mutations within the same root", async () => {
  resetIgnoreCache();

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-fs-same-length-"));
  const ignorePath = path.join(root, ".agentignore");
  await fs.writeFile(ignorePath, "ignored.js\n", "utf8");
  await fs.writeFile(path.join(root, "ignored.js"), "export const ignored = true;\n", "utf8");
  await fs.writeFile(path.join(root, "visible.js"), "export const visible = true;\n", "utf8");

  const before = (await walkFiles(root, { respectIgnore: true })).map((file) => relative(root, file));
  assert.deepEqual(before.sort(), [".agentignore", "visible.js"]);

  // Same byte length as "ignored.js\n"; only mtime can invalidate the cache.
  const future = new Date(Date.now() + 2000);
  await fs.writeFile(ignorePath, "visible.js\n", "utf8");
  await fs.utimes(ignorePath, future, future);

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

test("walkFiles skips gitignored transient directories when respecting ignores", async () => {
  resetIgnoreCache();

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-fs-gitignore-"));
  await runGit(root, ["init"]);
  await fs.writeFile(path.join(root, ".gitignore"), "*.tmp\n", "utf8");
  await fs.mkdir(path.join(root, ".tmp", "e2e", "repos", "fixture"), { recursive: true });
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, ".tmp", "e2e", "repos", "fixture", "index.js"), "export const fixture = true;\n", "utf8");
  await fs.writeFile(path.join(root, "src", "index.js"), "export const visible = true;\n", "utf8");

  const files = (await walkFiles(root, { respectIgnore: true })).map((file) => relative(root, file)).sort();

  assert.deepEqual(files, [".gitignore", "src/index.js"]);
});

test("walkFiles treats unreadable .agentignore as an empty ignore list", async () => {
  resetIgnoreCache();

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-fs-unreadable-"));
  await fs.mkdir(path.join(root, ".agentignore"));
  await fs.writeFile(path.join(root, "visible.js"), "export const visible = true;\n", "utf8");

  const files = (await walkFiles(root, { respectIgnore: true })).map((file) => relative(root, file));
  assert.deepEqual(files, ["visible.js"]);
});

test("walkFiles excludes Agentify runtime artifacts even when ignore rules are absent", async () => {
  resetIgnoreCache();

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-fs-artifacts-"));
  await fs.mkdir(path.join(root, ".agentify", "session", "sess_test"), { recursive: true });
  await fs.mkdir(path.join(root, ".current_session", "session"), { recursive: true });
  await fs.mkdir(path.join(root, "docs", "modules"), { recursive: true });
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, ".agentify", "session", "sess_test", "context.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(root, ".current_session", "session", "transcript.md"), "secret\n", "utf8");
  await fs.writeFile(path.join(root, "docs", "repo-map.md"), "# generated\n", "utf8");
  await fs.writeFile(path.join(root, "AGENTIFY.md"), "# generated\n", "utf8");
  await fs.writeFile(path.join(root, "agentify-report.html"), "<html></html>\n", "utf8");
  await fs.writeFile(path.join(root, "output.txt"), "generated\n", "utf8");
  await fs.writeFile(path.join(root, "src", "index.js"), "export const visible = true;\n", "utf8");

  const files = (await walkFiles(root, { respectIgnore: true })).map((file) => relative(root, file)).sort();

  assert.deepEqual(files, ["src/index.js"]);
});
