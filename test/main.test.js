import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { buildExecutionPrompt, buildSessionPrompt, getProviderTemplateOptions, getSessionCaptureSettings, parseArgs, runCli } from "../src/main.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

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

test("getSessionCaptureSettings preserves inherited stdio for custom session commands", () => {
  assert.deepEqual(
    getSessionCaptureSettings(false, { interactive: false }),
    {
      captureOutputMode: "inherit",
      captureMode: "interactive-inherit",
    }
  );

  assert.deepEqual(
    getSessionCaptureSettings(true, { interactive: false }),
    {
      captureOutputMode: "pipe",
      captureMode: "captured-pipe",
    }
  );

  assert.deepEqual(
    getSessionCaptureSettings(true, { interactive: true }),
    {
      captureOutputMode: "pty",
      captureMode: "interactive-pty",
    }
  );
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

test("buildExecutionPrompt prepends automatic memory before a normal run prompt", () => {
  const prompt = buildExecutionPrompt(
    "Implement retry handling for checkout refresh.",
    "## Automatic Session Memory\n- Backend: local-session-search\n- Source session: sess_parent"
  );

  assert.match(prompt, /Automatic Session Memory/);
  assert.ok(prompt.indexOf("Automatic Session Memory") < prompt.indexOf("Implement retry handling"));
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
  }

  assert.equal(output.length, 1);
  const payload = JSON.parse(output[0]);
  assert.equal(payload.command, "doctor");
  assert.ok(typeof payload.tier === "number");
  assert.ok(payload.tools && typeof payload.tools === "object");
  assert.ok(payload.tools.mempalace && typeof payload.tools.mempalace.available === "boolean");
});

test("runCli sync upgrades repo-owned Agentify assets and emits sync json", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-sync-json-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "auth", "index.ts"), "export const login = () => true;\n");
  await fs.writeFile(path.join(root, ".agentify.yaml"), "provider: codex\n", "utf8");
  await fs.mkdir(path.join(root, ".codex", "skills", "grill-me"), { recursive: true });
  await fs.writeFile(path.join(root, ".codex", "skills", "grill-me", "SKILL.md"), "# stale skill\n", "utf8");
  await initGitRepo(root);
  await fs.writeFile(path.join(root, ".git", "hooks", "post-merge"), "#!/bin/sh\n# @agentify post-merge hook\nagentify scan\n", "utf8");

  const output = [];
  const originalLog = console.log;
  console.log = (...args) => {
    output.push(args.join(" "));
  };

  try {
    await runCli(["sync", "--root", root, "--json"]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(output.length, 1);
  const payload = JSON.parse(output[0]);
  assert.equal(payload.command, "sync");
  assert.equal(payload.validation.passed, true);
  assert.equal(payload.repo_sync.config.status, "updated");
  assert.deepEqual(payload.repo_sync.skills.providers, ["codex"]);
  assert.equal(payload.repo_sync.hooks.results.find((item) => item.name === "post-merge")?.status, "updated");
  assert.equal(payload.repo_sync.baseline.some((item) => item.status === "created"), true);

  const configText = await fs.readFile(path.join(root, ".agentify.yaml"), "utf8");
  const skillText = await fs.readFile(path.join(root, ".codex", "skills", "grill-me", "SKILL.md"), "utf8");
  const hookText = await fs.readFile(path.join(root, ".git", "hooks", "post-merge"), "utf8");

  assert.match(configText, /^semantic:/m);
  assert.match(configText, /^toolchain:/m);
  assert.match(skillText, /Interview the user relentlessly/);
  assert.match(hookText, /agentify scan --json >\/dev\/null 2>&1 \|\| true/);
  await assert.doesNotReject(() => fs.access(path.join(root, ".agentignore")));
  await assert.doesNotReject(() => fs.access(path.join(root, ".guardrails")));
});

test("runCli sync tolerates --provider local while syncing detected project skill roots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-sync-local-provider-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "auth", "index.ts"), "export const login = () => true;\n");
  await fs.writeFile(path.join(root, ".agentify.yaml"), "provider: codex\n", "utf8");
  await fs.mkdir(path.join(root, ".codex", "skills", "grill-me"), { recursive: true });
  await fs.writeFile(path.join(root, ".codex", "skills", "grill-me", "SKILL.md"), "# stale skill\n", "utf8");
  await initGitRepo(root);

  const output = [];
  const originalLog = console.log;
  console.log = (...args) => {
    output.push(args.join(" "));
  };

  try {
    await runCli(["sync", "--root", root, "--provider", "local", "--json"]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(output.length, 1);
  const payload = JSON.parse(output[0]);
  assert.equal(payload.command, "sync");
  assert.equal(payload.validation.passed, true);
  assert.deepEqual(payload.repo_sync.skills.providers, ["codex"]);

  const configText = await fs.readFile(path.join(root, ".agentify.yaml"), "utf8");
  assert.match(configText, /^provider: codex$/m);
});

test("runCli doctor reports MemPalace available via AGENTIFY_MEMPALACE_CMD", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-doctor-mempalace-cmd-"));
  const customBinDir = path.join(root, "custom-bin");
  const mempalacePath = path.join(customBinDir, "mempalace-custom");
  await fs.mkdir(customBinDir, { recursive: true });
  await fs.writeFile(mempalacePath, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.chmod(mempalacePath, 0o755);

  const output = [];
  const originalLog = console.log;
  const originalMemPalaceCmd = process.env.AGENTIFY_MEMPALACE_CMD;
  console.log = (...args) => {
    output.push(args.join(" "));
  };
  process.env.AGENTIFY_MEMPALACE_CMD = mempalacePath;

  try {
    await runCli(["doctor", "--root", root, "--json"]);
  } finally {
    console.log = originalLog;
    if (originalMemPalaceCmd === undefined) {
      delete process.env.AGENTIFY_MEMPALACE_CMD;
    } else {
      process.env.AGENTIFY_MEMPALACE_CMD = originalMemPalaceCmd;
    }
  }

  assert.equal(output.length, 1);
  const payload = JSON.parse(output[0]);
  assert.equal(payload.command, "doctor");
  assert.equal(payload.tools.mempalace.available, true);
  assert.equal(payload.tools.mempalace.path, mempalacePath);
});

test("runCli restores stderr output after a failing json invocation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-json-reset-"));
  const stderrChunks = [];
  const originalWrite = process.stderr.write.bind(process.stderr);

  process.stderr.write = ((chunk, encoding, callback) => {
    stderrChunks.push(String(chunk));
    if (typeof encoding === "function") {
      encoding();
    } else if (typeof callback === "function") {
      callback();
    }
    return true;
  });

  try {
    await assert.rejects(() => runCli(["exec", "--root", root, "--json"]), /exec requires a command after --/);
    await runCli(["init", "--root", root]);
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.match(stderrChunks.join(""), /Initialized agentify artifacts/);
});

test("runCli exec refreshes stale artifacts after a failing command mutates tracked files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-exec-failed-refresh-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.js"), "export const version = 1;\n", "utf8");
  await initGitRepo(root);

  await runCli(["scan", "--root", root]);
  await runCli(["doc", "--root", root]);

  const docPath = path.join(root, "AGENTIFY.md");
  const beforeDocMtime = (await fs.stat(docPath)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 25));

  const script = [
    "import fs from 'node:fs/promises';",
    "await fs.appendFile('src/index.js', 'export const failedViaCli = true;\\n', 'utf8');",
    "process.exit(1);",
  ].join("");

  const originalExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await runCli(["exec", "--root", root, "--fail-on-stale", "--", "node", "--input-type=module", "-e", script]);
    const afterDocMtime = (await fs.stat(docPath)).mtimeMs;

    assert.equal(process.exitCode, 1);
    assert.equal(afterDocMtime > beforeDocMtime, true);
  } finally {
    process.exitCode = originalExitCode;
  }
});
