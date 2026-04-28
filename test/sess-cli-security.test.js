import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(fileURLToPath(import.meta.url), "..", "..", "src", "cli.js");

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

async function runCli(args, cwd) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], { cwd });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout || "",
      stderr: err.stderr || String(err.message || err),
    };
  }
}

test("sess resume rejects path-like ids without touching the filesystem", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-cli-resume-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-cli-probe-"));
  await fs.writeFile(path.join(probeDir, "session-manifest.json"), JSON.stringify({ session_id: "forged" }));
  await fs.writeFile(path.join(probeDir, "context.json"), JSON.stringify({}));
  await fs.writeFile(path.join(probeDir, "bootstrap.md"), "forged");

  const escapeId = path.relative(path.join(root, ".agents", "session"), probeDir);

  for (const malicious of [escapeId, "../escape", "a/../b", "/abs/path", "with space"]) {
    const result = await runCli(["sess", "resume", "--session", malicious, "--json"], root);
    assert.notEqual(result.code, 0, `expected non-zero exit for ${JSON.stringify(malicious)}`);
    assert.match(result.stderr, /Invalid .*id/, `expected validation error for ${JSON.stringify(malicious)}`);
  }

  const positional = await runCli(["sess", "resume", "../escape", "--json"], root);
  assert.notEqual(positional.code, 0);
  assert.match(positional.stderr, /Invalid .*id/);
});

test("sess fork rejects path-like --from values", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-cli-fork-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  for (const malicious of ["../escape", "a/../b", "/abs/path", "with space"]) {
    const result = await runCli(["sess", "fork", "--from", malicious, "--json"], root);
    assert.notEqual(result.code, 0, `expected non-zero exit for ${JSON.stringify(malicious)}`);
    assert.match(result.stderr, /Invalid .*id/, `expected validation error for ${JSON.stringify(malicious)}`);
  }
});

test("sess run rejects path-like --session and --from values", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-cli-run-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const session = await runCli(["sess", "run", "--session", "../escape", "--json"], root);
  assert.notEqual(session.code, 0);
  assert.match(session.stderr, /Invalid .*id/);

  const from = await runCli(["sess", "run", "--from", "../escape", "--json"], root);
  assert.notEqual(from.code, 0);
  assert.match(from.stderr, /Invalid .*id/);
});
