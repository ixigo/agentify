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

test("getFileContentsAtHead fallback preserves newline paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-head-newline-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "line\nbreak.js"), "export const value = 1;\n", "utf8");
  await initGitRepo(root);
  await fs.writeFile(path.join(root, "src", "line\nbreak.js"), "export const value = 2;\n", "utf8");

  const realGit = (await execFileAsync("which", ["git"])).stdout.trim();
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-fallback-"));
  const logPath = path.join(binDir, "git.log");
  const wrapperPath = path.join(binDir, "git");
  await fs.writeFile(
    wrapperPath,
    [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      'import { spawnSync } from "node:child_process";',
      "",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.AGENTIFY_GIT_LOG, `${JSON.stringify(args)}\\n`);",
      'if (args[0] === "cat-file" && args.includes("-Z")) {',
      '  process.stderr.write("unknown option -Z\\n");',
      "  process.exit(129);",
      "}",
      'const result = spawnSync(process.env.AGENTIFY_REAL_GIT, args, { stdio: "inherit" });',
      "if (result.error) {",
      "  console.error(result.error.message);",
      "  process.exit(1);",
      "}",
      "process.exit(result.status ?? 0);",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(wrapperPath, 0o755);

  const previousPath = process.env.PATH;
  const previousRealGit = process.env.AGENTIFY_REAL_GIT;
  const previousGitLog = process.env.AGENTIFY_GIT_LOG;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  process.env.AGENTIFY_REAL_GIT = realGit;
  process.env.AGENTIFY_GIT_LOG = logPath;

  try {
    const contents = await getFileContentsAtHead(root, ["src/line\nbreak.js"]);
    const calls = (await fs.readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.equal(contents.get("src/line\nbreak.js"), "export const value = 1;\n");
    assert.equal(
      calls.some((args) => args[0] === "cat-file" && args.includes("-Z")),
      true,
    );
    assert.equal(
      calls.some((args) => args[0] === "cat-file" && args.includes("-z")),
      true,
    );
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousRealGit === undefined) {
      delete process.env.AGENTIFY_REAL_GIT;
    } else {
      process.env.AGENTIFY_REAL_GIT = previousRealGit;
    }
    if (previousGitLog === undefined) {
      delete process.env.AGENTIFY_GIT_LOG;
    } else {
      process.env.AGENTIFY_GIT_LOG = previousGitLog;
    }
  }
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
