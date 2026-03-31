import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseArgs, runCli } from "../src/main.js";

test("parseArgs normalizes dashed flags to camelCase", () => {
  const args = parseArgs([
    "doc",
    "--provider",
    "codex",
    "--module-concurrency",
    "6",
    "--max-files-per-module=12"
  ]);

  assert.equal(args.provider, "codex");
  assert.equal(args.moduleConcurrency, 6);
  assert.equal(args.maxFilesPerModule, 12);
});

test("parseArgs supports short help and version flags", () => {
  const args = parseArgs(["-h", "-V"]);
  assert.equal(args.help, true);
  assert.equal(args.version, true);
});

test("parseArgs supports interactive flags", () => {
  const shortArgs = parseArgs(["run", "-i"]);
  assert.equal(shortArgs.interactive, true);

  const longArgs = parseArgs(["run", "--interactive"]);
  assert.equal(longArgs.interactive, true);

  const promptArgs = parseArgs(["run", "--interactive", "implement login"]);
  assert.equal(promptArgs.interactive, true);
  assert.deepEqual(promptArgs._, ["run", "implement login"]);
});

test("runCli rejects removed legacy command names", async () => {
  await assert.rejects(() => runCli(["update"]), /Use "up"/);
  await assert.rejects(() => runCli(["validate"]), /Use "check"/);
  await assert.rejects(() => runCli(["session"]), /Use "sess"/);
});

test("runCli rejects removed --tool flag", async () => {
  await assert.rejects(() => runCli(["scan", "--tool", "codex"]), /--tool was removed/);
});

test("runCli rejects --interactive for non-codex provider templates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-"));
  await assert.rejects(
    () => runCli(["run", "--root", root, "--provider", "claude", "--interactive", "implement login"]),
    /--interactive is currently supported only with --provider codex/,
  );
});

test("runCli supports skill install with provider all", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-skill-"));
  await runCli(["skill", "install", "god-mode", "--root", root, "--provider", "all", "--scope", "project"]);

  await assert.doesNotReject(() =>
    fs.access(path.join(root, ".claude", "skills", "worktree-verifier", "SKILL.md"))
  );
  await assert.doesNotReject(() =>
    fs.access(path.join(root, ".opencode", "skills", "worktree-verifier", "SKILL.md"))
  );
});

test("runCli init writes baseline local work and guardrail files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-init-"));
  await runCli(["init", "--root", root]);

  await assert.doesNotReject(() => fs.access(path.join(root, ".agentignore")));
  await assert.doesNotReject(() => fs.access(path.join(root, ".guardrails")));
  await assert.doesNotReject(() => fs.access(path.join(root, ".agentify", "work")));
});
