import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { getFileContentAtHead, getFileContentsAtHead } from "../src/core/git.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

test("getFileContentsAtHead reads multiple paths and preserves missing entries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-head-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "auth", "login.ts"), "export const login = () => true;\n", "utf8");
  await fs.writeFile(path.join(root, "src", "auth", "logout.ts"), "export const logout = () => true;\n", "utf8");
  await fs.writeFile(path.join(root, "src", "auth", "space file.ts"), "export const spaced = true;\n", "utf8");
  await initGitRepo(root);

  await fs.writeFile(path.join(root, "src", "auth", "login.ts"), "export const login = () => false;\n", "utf8");
  await fs.writeFile(path.join(root, "src", "auth", "space file.ts"), "export const spaced = false;\n", "utf8");
  await fs.rm(path.join(root, "src", "auth", "logout.ts"));

  const contents = await getFileContentsAtHead(root, [
    "src/auth/login.ts",
    "src/auth/logout.ts",
    "src/auth/space file.ts",
    "src/auth/missing.ts",
  ]);

  assert.equal(contents.get("src/auth/login.ts"), "export const login = () => true;\n");
  assert.equal(contents.get("src/auth/logout.ts"), "export const logout = () => true;\n");
  assert.equal(contents.get("src/auth/space file.ts"), "export const spaced = true;\n");
  assert.equal(contents.get("src/auth/missing.ts"), null);
});

test("getFileContentAtHead delegates to the batched reader", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-head-single-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.js"), "export const value = 1;\n", "utf8");
  await initGitRepo(root);

  await fs.writeFile(path.join(root, "src", "index.js"), "export const value = 2;\n", "utf8");

  assert.equal(await getFileContentAtHead(root, "src/index.js"), "export const value = 1;\n");
  assert.equal(await getFileContentAtHead(root, "src/missing.js"), null);
});
