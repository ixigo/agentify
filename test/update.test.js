import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { applyHeaderToSource, renderHeader } from "../src/core/headers.js";
import { loadConfig } from "../src/core/config.js";
import { detectTestCommand, runDoc, runScan, runUpdate } from "../src/core/commands.js";
import { validateRepo } from "../src/core/validate.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

test("scan and doc generate required artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-update-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "auth", "index.ts"), "export const login = () => true;\n");

  const config = await loadConfig(root, { provider: "local", dryRun: false, tokenReport: true });
  await runScan(root, config);
  await runDoc(root, config);
  const result = await validateRepo(root, config);

  assert.equal(result.passed, true);
  assert.equal(await fs.stat(path.join(root, ".agents", "index.json")).then(() => true), true);
  assert.equal(await fs.stat(path.join(root, "docs", "modules", "auth.md")).then(() => true), true);
  assert.equal(await fs.stat(path.join(root, "AGENTIFY.md")).then(() => true), true);
  const summary = await fs.readFile(path.join(root, "AGENTIFY.md"), "utf8");
  assert.match(summary, /# AGENTIFY\.md/);
  assert.match(summary, /## Run Metrics/);
});

test("validateRepo allows tracked header-only code changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-validate-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  const filePath = path.join(root, "src", "auth", "index.ts");
  const source = "export const login = () => true;\n";
  await fs.writeFile(filePath, source);
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "local", dryRun: false, tokenReport: false });
  await runScan(root, config);
  await runDoc(root, config);

  const header = renderHeader({
    moduleName: "auth",
    summary: "Authentication entrypoints refreshed",
    relativePath: "src/auth/index.ts",
    stack: "ts"
  });
  const current = await fs.readFile(filePath, "utf8");
  await fs.writeFile(filePath, applyHeaderToSource(current, header), "utf8");

  const result = await validateRepo(root, config);

  assert.equal(result.passed, true);
});

test("runUpdate emits percentage progress logs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-progress-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      test: "node --test"
    }
  }, null, 2));
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  await fs.mkdir(path.join(root, "test"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "auth", "index.ts"), "export const login = () => true;\n");
  await fs.writeFile(path.join(root, "test", "pass.test.js"), `import test from "node:test";
import assert from "node:assert/strict";

test("passes", () => {
  assert.equal(1, 1);
});
`);

  const config = await loadConfig(root, { provider: "local", dryRun: false, tokenReport: false });
  const stderrChunks = [];
  const stdoutMessages = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalLog = console.log;

  process.stderr.write = ((chunk, encoding, callback) => {
    stderrChunks.push(String(chunk));
    return originalWrite(chunk, encoding, callback);
  });
  console.log = (...args) => {
    stdoutMessages.push(args);
  };

  try {
    await runUpdate(root, config);
  } finally {
    process.stderr.write = originalWrite;
    console.log = originalLog;
  }

  const stderr = stderrChunks.join("");
  assert.match(stderr, /\[agentify\] update: 0% starting/);
  assert.match(stderr, /\[agentify\] update: 33% scan complete/);
  assert.match(stderr, /\[agentify\] update: 67% doc complete/);
  assert.match(stderr, /\[agentify\] update: 100% validation passed/);
  assert.match(stderr, /\[agentify\] doc: 100% completed/);
  assert.ok(stdoutMessages.length > 0);
  assert.equal(await fs.stat(path.join(root, "output.txt")).then(() => true), true);
  assert.equal(await fs.stat(path.join(root, "agentify-report.html")).then(() => true), true);
  const output = await fs.readFile(path.join(root, "output.txt"), "utf8");
  const html = await fs.readFile(path.join(root, "agentify-report.html"), "utf8");
  assert.match(output, /\[agentify\] tests: passed/);
  assert.match(html, /All configured test cases passed\./);
  assert.match(html, /Copy rerun tests command/);
  assert.match(html, /Total tokens/);
});

test("detectTestCommand prefers the declared package manager", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-command-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    packageManager: "pnpm@9.0.0",
    scripts: {
      test: "vitest run"
    }
  }, null, 2));

  const result = await detectTestCommand(root);

  assert.deepEqual(result, { command: "pnpm", args: ["test"] });
});

test("detectTestCommand falls back to lockfile detection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-lockfile-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      test: "jest"
    }
  }, null, 2));
  await fs.writeFile(path.join(root, "yarn.lock"), "");

  const result = await detectTestCommand(root);

  assert.deepEqual(result, { command: "yarn", args: ["test"] });
});
