import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildSessionPrompt, getProviderTemplateOptions, parseArgs, runCli } from "../src/main.js";
import { setSilent } from "../src/core/ui.js";

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

test("getProviderTemplateOptions defaults codex template commands to interactive", () => {
  const options = getProviderTemplateOptions({}, "/tmp/repo", "codex", true);
  assert.equal(options.interactive, true);
});

test("getProviderTemplateOptions defaults non-codex template commands to interactive", () => {
  const options = getProviderTemplateOptions({}, "/tmp/repo", "claude", true);
  assert.equal(options.interactive, true);
});

test("buildSessionPrompt injects automatic memory excerpts before the current task", () => {
  const prompt = buildSessionPrompt(
    "# Session Context\n- Provider: codex",
    "Fix the failing refresh path.",
    "## Automatic Session Memory\n- Source session: sess_parent\n\n> Current task\nRemember the earlier trade-off."
  );

  assert.match(prompt, /Automatic Session Memory/);
  assert.match(prompt, /Source session: sess_parent/);
  assert.match(prompt, /Current task: Fix the failing refresh path\./);
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

test("runCli supports skill install all for codex project scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-skill-all-codex-"));
  await runCli(["skill", "install", "all", "--root", root, "--provider", "codex", "--scope", "project"]);

  for (const skillName of ["grill-me", "improve-codebase-architecture", "gh-issue-autopilot", "worktree-verifier", "pr-creator", "commit-creator"]) {
    await assert.doesNotReject(() =>
      fs.access(path.join(root, ".codex", "skills", skillName, "SKILL.md"))
    );
  }
});

test("runCli init writes baseline local work and guardrail files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-init-"));
  await runCli(["init", "--root", root]);

  await assert.doesNotReject(() => fs.access(path.join(root, ".agentignore")));
  await assert.doesNotReject(() => fs.access(path.join(root, ".guardrails")));
  await assert.doesNotReject(() => fs.access(path.join(root, ".agentify", "work")));
});

test("runCli init --json emits a single machine-readable payload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-init-json-"));
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => {
    output.push(args.join(" "));
  };

  try {
    await runCli(["init", "--root", root, "--json"]);
  } finally {
    console.log = originalLog;
    setSilent(false);
  }

  assert.equal(output.length, 1);
  const payload = JSON.parse(output[0]);
  assert.equal(payload.command, "init");
  assert.equal(payload.root, root);
  assert.equal(payload.dry_run, false);
});

test("runCli doctor --json emits a single machine-readable payload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-doctor-json-"));
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => {
    output.push(args.join(" "));
  };

  try {
    await runCli(["doctor", "--root", root, "--json"]);
  } finally {
    console.log = originalLog;
    setSilent(false);
  }

  assert.equal(output.length, 1);
  const payload = JSON.parse(output[0]);
  assert.equal(payload.command, "doctor");
  assert.ok(typeof payload.tier === "number");
  assert.ok(payload.tools && typeof payload.tools === "object");
});
