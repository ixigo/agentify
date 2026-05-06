import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { CAVEMAN_PREAMBLE_MARKER, resolveCavemanLevel } from "../src/core/caveman.js";
import { forkSession as forkContextSession } from "../src/core/session.js";
import { buildExecutionPrompt, buildMinimalRunPrompt, buildNoTaskRunPrompt, buildSessionPrompt, getProviderTemplateOptions, getSessionCaptureSettings, parseArgs, prepareSessionLaunch, resolveRunContextMode, runCli } from "../src/main.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

async function installFakeCodex(binDir, capturePath) {
  const codexPath = path.join(binDir, "codex");
  await fs.writeFile(codexPath, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));
`, "utf8");
  await fs.chmod(codexPath, 0o755);
  return codexPath;
}

async function installFakeCodexEnvCapture(binDir, capturePath) {
  const codexPath = path.join(binDir, "codex");
  await fs.writeFile(codexPath, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  argv: process.argv.slice(2),
  secret: process.env.AGENTIFY_PROVIDER_SENTINEL_SECRET || null,
  allowed: process.env.AGENTIFY_PROVIDER_ALLOWED || null,
  extra: process.env.AGENTIFY_PROVIDER_EXTRA || null
}));
`, "utf8");
  await fs.chmod(codexPath, 0o755);
  return codexPath;
}

async function captureHelpText() {
  const chunks = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = function write(chunk, encoding, callback) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    if (typeof encoding === "function") {
      encoding();
    } else if (typeof callback === "function") {
      callback();
    }
    return true;
  };

  try {
    await runCli(["--help"]);
  } finally {
    process.stderr.write = originalWrite;
  }

  return chunks.join("").replace(/\u001b\[[0-9;]*m/g, "");
}

async function captureConsoleLog(fn) {
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => {
    output.push(args.join(" "));
  };

  try {
    await fn();
  } finally {
    console.log = originalLog;
  }

  return output;
}

function extractHelpSection(help, heading, nextHeading) {
  const start = help.indexOf(heading);
  assert.notEqual(start, -1, `missing help heading ${heading}`);
  const end = nextHeading ? help.indexOf(nextHeading, start + heading.length) : help.length;
  assert.notEqual(end, -1, `missing help heading ${nextHeading}`);
  return help.slice(start + heading.length, end);
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

test("parseArgs treats issue-killer bypass permissions as a boolean flag", () => {
  const args = parseArgs([
    "issue-killer",
    "--bypass-permissions",
    "--label",
    "agentify-ready",
  ]);

  assert.equal(args.bypassPermissions, true);
  assert.equal(args.label, "agentify-ready");
});

test("parseArgs and config resolve context mode explicitly", () => {
  const args = parseArgs(["run", "--context-mode", "routed", "implement login"]);

  assert.equal(args.contextMode, "routed");
  assert.equal(resolveRunContextMode(args, { context: { mode: "compact" } }), "routed");
  assert.equal(resolveRunContextMode(parseArgs(["run", "implement login"]), { context: { mode: "compact" } }), "compact");
  assert.throws(
    () => resolveRunContextMode(parseArgs(["run", "--context-mode", "wide", "implement login"]), {}),
    /--context-mode must be "compact", "direct", or "routed"/,
  );
});

test("README CLI reference includes every command and option from help", async () => {
  const help = await captureHelpText();
  const readme = await fs.readFile(new URL("../README.md", import.meta.url), "utf8");
  const commandSection = extractHelpSection(help, "COMMANDS", "OPTIONS");
  const optionSection = extractHelpSection(help, "OPTIONS", "EXEC FLAGS");
  const execFlagSection = extractHelpSection(help, "EXEC FLAGS", "EXAMPLES");

  const commands = [...commandSection.matchAll(/^\s{4}([a-z][a-z-]*)\s{2,}/gm)].map((match) => match[1]);
  const flags = [...`${optionSection}\n${execFlagSection}`.matchAll(/(--[a-z][a-z-]*(?:\[\=level\])?)/g)]
    .map((match) => match[1])
    .filter((flag, index, all) => all.indexOf(flag) === index);

  assert.ok(commands.length > 0, "expected commands in help");
  assert.ok(flags.length > 0, "expected flags in help");

  for (const command of commands) {
    assert.match(readme, new RegExp(`\\| \`${command}\` \\|`), `README is missing command ${command}`);
  }

  for (const flag of flags) {
    assert.match(readme, new RegExp(`\\| \`${flag.replace("[", "\\[").replace("]", "\\]")}`), `README is missing flag ${flag}`);
  }
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

test("parseArgs supports explicit continue flag for run", () => {
  const args = parseArgs(["run", "--continue", "implement login"]);

  assert.equal(args.continue, true);
  assert.deepEqual(args._, ["run", "implement login"]);
});

test("parseArgs supports explicit resume flag for run and sess aliases", () => {
  const args = parseArgs(["run", "--resume", "implement login"]);

  assert.equal(args.resume, true);
  assert.deepEqual(args._, ["run", "implement login"]);
});

test("parseArgs supports caveman flag forms", () => {
  const bareArgs = parseArgs(["run", "--caveman", "summarize auth"]);
  assert.equal(bareArgs.caveman, true);
  assert.deepEqual(bareArgs._, ["run", "summarize auth"]);

  const levelArgs = parseArgs(["run", "--caveman=ultra", "summarize auth"]);
  assert.equal(levelArgs.caveman, "ultra");

  const spacedLevelArgs = parseArgs(["run", "--caveman", "ultra", "summarize auth"]);
  assert.equal(spacedLevelArgs.caveman, "ultra");
  assert.deepEqual(spacedLevelArgs._, ["run", "summarize auth"]);
});

test("resolveCavemanLevel uses CLI before environment", () => {
  assert.equal(resolveCavemanLevel({ caveman: true }, {}), "full");
  assert.equal(resolveCavemanLevel({ caveman: "ultra" }, { AGENTIFY_CAVEMAN: "lite" }), "ultra");
  assert.equal(resolveCavemanLevel({}, { AGENTIFY_CAVEMAN: "full" }), "full");
  assert.equal(resolveCavemanLevel({ caveman: "false" }, { AGENTIFY_CAVEMAN: "full" }), null);
});

test("runCli rejects removed legacy command names", async () => {
  await assert.rejects(() => runCli(["update"]), /Use "up"/);
  await assert.rejects(() => runCli(["validate"]), /Use "check"/);
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

test("getProviderTemplateOptions allows explicit non-interactive template runs", () => {
  const options = getProviderTemplateOptions({ interactive: false }, "/tmp/repo", "codex", true);
  assert.equal(options.interactive, false);
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

test("prepareSessionLaunch records interactive template sessions through PTY capture for Codex and Claude", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-provider-template-capture-"));
  const task = "Capture the provider transcript.";

  for (const provider of ["codex", "claude"]) {
    const sessionResult = {
      manifest: {
        session_id: `sess_${provider}_capture`,
        provider,
        name: `${provider} capture session`,
      },
      bootstrap: `# Session Context\n- Provider: ${provider}`,
    };
    const config = {
      provider,
      session: {
        memoryPromptMaxKb: 4,
        memoryResults: 3,
        memoryTurns: 6,
      },
    };
    const launch = await prepareSessionLaunch(root, config, parseArgs(["sess", "run", task]), sessionResult, task);

    assert.equal(launch.provider, provider);
    assert.equal(launch.captureSettings.captureMode, "interactive-pty");
    assert.equal(launch.runExecFlags.captureOutputMode, "pty");
    assert.equal(launch.sessionRecord.captureMode, "interactive-pty");
    assert.equal(launch.sessionRecord.provider, provider);
    assert.equal(launch.sessionRecord.task, task);
    assert.equal(launch.runExecFlags.sessionRecord, launch.sessionRecord);
    assert.equal(launch.agentCommand[0], provider);
    assert.doesNotMatch(launch.agentCommand.join(" "), /\bexec\b|-p\b/);
    assert.match(launch.agentCommand.at(-1), /Current task: Capture the provider transcript\./);
  }
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

test("buildMinimalRunPrompt keeps interactive run prompts compact", () => {
  const prompt = buildMinimalRunPrompt("Implement retry handling for checkout refresh.");

  assert.match(prompt, /Agentify-prepared repository/);
  assert.match(prompt, /Task: Implement retry handling/);
  assert.doesNotMatch(prompt, /Planner summary/);
  assert.doesNotMatch(prompt, /Selected file slices/);
  assert.doesNotMatch(prompt, /Automatic Session Memory/);
});

test("buildMinimalRunPrompt rejects empty run tasks", () => {
  assert.throws(
    () => buildMinimalRunPrompt(""),
    /requires a non-empty task/,
  );
});

test("buildNoTaskRunPrompt asks the provider to collect the task", () => {
  const prompt = buildNoTaskRunPrompt("## Automatic Session Memory\n- none");

  assert.match(prompt, /Agentify-prepared repository/);
  assert.match(prompt, /Automatic Session Memory/);
  assert.match(prompt, /No task was provided/);
  assert.match(prompt, /ask the user what task/);
  assert.doesNotMatch(prompt, /Task:/);
});

test("buildExecutionPrompt prepends caveman preamble for run prompts", () => {
  const prompt = buildExecutionPrompt("Summarize the auth module.", "", { caveman: "ultra" });

  assert.match(prompt, new RegExp(CAVEMAN_PREAMBLE_MARKER));
  assert.match(prompt, /Active level: ultra\./);
  assert.ok(prompt.indexOf(CAVEMAN_PREAMBLE_MARKER) < prompt.indexOf("Summarize the auth module."));
});

test("buildExecutionPrompt excludes caveman preamble for commit-message prompts", () => {
  const prompt = buildExecutionPrompt("Write a conventional commit message.", "", {
    caveman: "full",
    promptKind: "commit-message",
  });

  assert.doesNotMatch(prompt, new RegExp(CAVEMAN_PREAMBLE_MARKER));
  assert.equal(prompt, "Write a conventional commit message.");
});

test("buildSessionPrompt prepends caveman preamble for session prompts", () => {
  const prompt = buildSessionPrompt("# Session Context\n- Provider: codex", "Map checkout flow.", "", { caveman: "lite" });

  assert.match(prompt, new RegExp(CAVEMAN_PREAMBLE_MARKER));
  assert.match(prompt, /Active level: lite\./);
});

test("prepareSessionLaunch keeps sess subcommands on the same runExec payload path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-session-launch-"));
  const sessionResult = {
    manifest: {
      session_id: "sess_shared_launch",
      provider: "opencode",
      name: "Shared launch session",
    },
    bootstrap: "# Session Context\n- Provider: opencode",
  };
  const config = {
    provider: "claude",
    session: {
      memoryPromptMaxKb: 4,
      memoryResults: 3,
      memoryTurns: 6,
    },
  };
  const task = "Finish launch preparation";
  const commandArgs = {
    fork: parseArgs(["sess", "fork", task]),
    resume: parseArgs(["sess", "resume", "sess_shared_launch", task]),
    run: parseArgs(["sess", "run", task]),
  };

  const launches = {};
  for (const [subcommand, args] of Object.entries(commandArgs)) {
    launches[subcommand] = await prepareSessionLaunch(root, config, args, sessionResult, task);
  }

  const baseline = launches.fork;
  for (const launch of Object.values(launches)) {
    assert.equal(launch.provider, "opencode");
    assert.equal(launch.captureSettings.captureMode, "interactive-pty");
    assert.equal(launch.runExecFlags.captureOutputMode, "pty");
    assert.equal(launch.sessionRecord.sessionId, "sess_shared_launch");
    assert.equal(launch.sessionRecord.provider, "opencode");
    assert.equal(launch.sessionRecord.task, task);
    assert.equal(launch.sessionRecord.memoryContext.backend, "none");
    assert.equal(launch.sessionRecord.prompt, baseline.sessionRecord.prompt);
    assert.deepEqual(launch.sessionRecord.command, baseline.sessionRecord.command);
    assert.equal(launch.runExecConfig.provider, "opencode");
    assert.equal(launch.runExecFlags.sessionRecord, launch.sessionRecord);
  }

  assert.match(baseline.prompt, /Current task: Finish launch preparation/);
  assert.match(baseline.prompt, /Automatic Session Memory/);
  assert.deepEqual(baseline.agentCommand.slice(0, 3), ["opencode", "--dir", root]);
});

test("runCli passes a minimal prompt to interactive codex run by default", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-minimal-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-bin-"));
  const capturePath = path.join(root, "codex-argv.json");
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);
  await installFakeCodex(binDir, capturePath);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    await runCli([
      "run",
      "--root",
      root,
      "--provider",
      "codex",
      "--skip-refresh",
      "Implement login retries",
    ]);
  } finally {
    process.env.PATH = previousPath;
  }

  const argv = JSON.parse(await fs.readFile(capturePath, "utf8"));
  const prompt = argv.at(-1);
  assert.deepEqual(argv.slice(0, 2), ["--cd", root]);
  assert.notEqual(argv[0], "resume");
  assert.match(prompt, /Task: Implement login retries/);
  assert.doesNotMatch(prompt, /Planner summary/);
  assert.doesNotMatch(prompt, /Selected file slices/);
  assert.doesNotMatch(prompt, /Automatic Session Memory/);
});

test("runCli launches provider run with sanitized provider env config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-provider-env-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-bin-"));
  const capturePath = path.join(root, "codex-env.json");
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(root, ".agentify.yaml"), [
    "providerEnv:",
    "  passthrough:",
    "    - AGENTIFY_PROVIDER_ALLOWED",
    "  extra:",
    "    AGENTIFY_PROVIDER_EXTRA: extra-value",
    "",
  ].join("\n"), "utf8");
  await initGitRepo(root);
  await installFakeCodexEnvCapture(binDir, capturePath);

  const previousPath = process.env.PATH;
  const previousSecret = process.env.AGENTIFY_PROVIDER_SENTINEL_SECRET;
  const previousAllowed = process.env.AGENTIFY_PROVIDER_ALLOWED;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  process.env.AGENTIFY_PROVIDER_SENTINEL_SECRET = "secret-value";
  process.env.AGENTIFY_PROVIDER_ALLOWED = "allowed-value";
  try {
    await runCli([
      "run",
      "--root",
      root,
      "--provider",
      "codex",
      "--skip-refresh",
      "Inspect env",
    ]);
  } finally {
    process.env.PATH = previousPath;
    if (previousSecret === undefined) {
      delete process.env.AGENTIFY_PROVIDER_SENTINEL_SECRET;
    } else {
      process.env.AGENTIFY_PROVIDER_SENTINEL_SECRET = previousSecret;
    }
    if (previousAllowed === undefined) {
      delete process.env.AGENTIFY_PROVIDER_ALLOWED;
    } else {
      process.env.AGENTIFY_PROVIDER_ALLOWED = previousAllowed;
    }
  }

  const captured = JSON.parse(await fs.readFile(capturePath, "utf8"));
  assert.deepEqual(captured.argv.slice(0, 2), ["--cd", root]);
  assert.equal(captured.secret, null);
  assert.equal(captured.allowed, "allowed-value");
  assert.equal(captured.extra, "extra-value");
});

test("runCli launches interactive provider context without prompting when run has no task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-prompt-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-bin-"));
  const capturePath = path.join(root, "codex-argv.json");
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);
  await installFakeCodex(binDir, capturePath);

  const questions = [];
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    await runCli([
      "run",
      "--root",
      root,
      "--provider",
      "codex",
      "--skip-refresh",
    ], {
      prompt: async (question) => {
        questions.push(question);
        return "This should not be called";
      },
    });
  } finally {
    process.env.PATH = previousPath;
  }

  const argv = JSON.parse(await fs.readFile(capturePath, "utf8"));
  const prompt = argv.at(-1);
  assert.deepEqual(questions, []);
  assert.deepEqual(argv.slice(0, 2), ["--cd", root]);
  assert.match(prompt, /No task was provided/);
  assert.match(prompt, /ask the user what task/);
  assert.doesNotMatch(prompt, /Task:/);
});

test("runCli rejects non-interactive bare run instead of inventing a task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-empty-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);

  await assert.rejects(
    () => runCli([
      "run",
      "--root",
      root,
      "--provider",
      "codex",
      "--interactive=false",
      "--skip-refresh",
    ]),
    /requires a task when not launching an interactive provider/,
  );
});

test("runCli resumes the provider session only with --continue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-continue-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-bin-"));
  const capturePath = path.join(root, "codex-argv.json");
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);
  await installFakeCodex(binDir, capturePath);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    await runCli([
      "run",
      "--root",
      root,
      "--provider",
      "codex",
      "--continue",
      "--skip-refresh",
      "Implement login retries",
    ]);
  } finally {
    process.env.PATH = previousPath;
  }

  const argv = JSON.parse(await fs.readFile(capturePath, "utf8"));
  const prompt = argv.at(-1);
  assert.deepEqual(argv.slice(0, 4), ["resume", "--last", "--cd", root]);
  assert.match(prompt, /Task: Implement login retries/);
});

test("runCli supports --resume as provider session continuity alias", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-resume-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-bin-"));
  const capturePath = path.join(root, "codex-argv.json");
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);
  await installFakeCodex(binDir, capturePath);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    await runCli([
      "run",
      "--root",
      root,
      "--provider",
      "codex",
      "--resume",
      "--skip-refresh",
    ]);
  } finally {
    process.env.PATH = previousPath;
  }

  const argv = JSON.parse(await fs.readFile(capturePath, "utf8"));
  const prompt = argv.at(-1);
  assert.deepEqual(argv.slice(0, 4), ["resume", "--last", "--cd", root]);
  assert.match(prompt, /Resume mode is active/);
  assert.doesNotMatch(prompt, /Task:/);
});

test("runCli passes planner context to interactive codex run when requested", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-context-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-bin-"));
  const capturePath = path.join(root, "codex-argv.json");
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "login.js"), "export function login() { return true; }\n", "utf8");
  await initGitRepo(root);
  await installFakeCodex(binDir, capturePath);
  await runCli(["scan", "--root", root]);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    await runCli([
      "run",
      "--root",
      root,
      "--provider",
      "codex",
      "--with-context",
      "--skip-refresh",
      "Implement login retries",
    ]);
  } finally {
    process.env.PATH = previousPath;
  }

  const argv = JSON.parse(await fs.readFile(capturePath, "utf8"));
  const prompt = argv.at(-1);
  assert.match(prompt, /Planner summary/);
  assert.match(prompt, /Selected file slices/);
  assert.match(prompt, /Task:\nImplement login retries/);
});

test("runCli context search returns ranked repo context without provider CLI", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-context-search-"));
  const output = [];
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "billing"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "auth", "login.js"),
    "export function loginUser() { return true; }\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "src", "billing", "invoice.js"),
    "export function buildInvoice() { return true; }\n",
    "utf8",
  );
  await initGitRepo(root);
  await runCli(["scan", "--root", root]);

  const originalLog = console.log;
  console.log = (...args) => {
    output.push(args.join(" "));
  };
  try {
    await runCli(["context", "search", "login", "--root", root]);
  } finally {
    console.log = originalLog;
  }

  const payload = JSON.parse(output.join("\n"));
  assert.equal(payload.term, "login");
  assert.ok(payload.refs.some((ref) => ref.path === "src/auth/login.js"));
  assert.ok(payload.refs.some((ref) => ref.name === "loginUser"));
});

test("runCli passes routed context guidance without source by context mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-routed-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-routed-bin-"));
  const capturePath = path.join(root, "codex-argv.json");
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "login.js"), "export function login() { return 'source stays out'; }\n", "utf8");
  await initGitRepo(root);
  await installFakeCodex(binDir, capturePath);
  await runCli(["scan", "--root", root]);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    await runCli([
      "run",
      "--root",
      root,
      "--provider",
      "codex",
      "--context-mode",
      "routed",
      "--skip-refresh",
      "Implement login retries",
    ]);
  } finally {
    process.env.PATH = previousPath;
  }

  const argv = JSON.parse(await fs.readFile(capturePath, "utf8"));
  const prompt = argv.at(-1);
  assert.match(prompt, /Context mode: routed/);
  assert.match(prompt, /Source included: false/);
  assert.match(prompt, /agentify context search <terms>/);
  assert.match(prompt, /agentify context fetch <path> --symbol <name>/);
  assert.match(prompt, /Do not invoke nested `agentify plan`, `agentify query`, `agentify up`, `agentify doc`, or raw SQLite inspection/);
  assert.doesNotMatch(prompt, /Selected file slices/);
  assert.doesNotMatch(prompt, /source stays out/);
});

test("runCli lets --with-context explicitly include source in routed context mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-routed-with-context-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-run-routed-with-context-bin-"));
  const capturePath = path.join(root, "codex-argv.json");
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "login.js"), "export function login() { return 'explicit source included'; }\n", "utf8");
  await initGitRepo(root);
  await installFakeCodex(binDir, capturePath);
  await runCli(["scan", "--root", root]);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    await runCli([
      "run",
      "--root",
      root,
      "--provider",
      "codex",
      "--context-mode",
      "routed",
      "--with-context",
      "--skip-refresh",
      "Implement login retries",
    ]);
  } finally {
    process.env.PATH = previousPath;
  }

  const argv = JSON.parse(await fs.readFile(capturePath, "utf8"));
  const prompt = argv.at(-1);
  assert.match(prompt, /Context mode: routed/);
  assert.match(prompt, /Source included: true/);
  assert.match(prompt, /Selected file slices/);
  assert.match(prompt, /explicit source included/);
});

test("runCli sess run builds routed context with a fake codex provider", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-sess-default-context-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-sess-bin-"));
  const capturePath = path.join(root, "codex-argv.json");
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "route.js"), "export function routeRequest() { return true; }\n", "utf8");
  await initGitRepo(root);
  await runCli(["scan", "--root", root]);
  await installFakeCodex(binDir, capturePath);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    await runCli([
      "sess",
      "run",
      "--root",
      root,
      "--provider",
      "codex",
      "--interactive=false",
      "--skip-refresh",
      "--name",
      "routed-context",
      "Use routed context",
    ]);
  } finally {
    process.env.PATH = previousPath;
  }

  const argv = JSON.parse(await fs.readFile(capturePath, "utf8"));
  const prompt = argv.at(-1);
  assert.deepEqual(argv.slice(0, 2), ["exec", prompt]);
  assert.match(prompt, /Full routing: host shell -> \.agentify\/index\.db/);
  assert.match(prompt, /Current task: Use routed context/);
  assert.match(prompt, /Automatic Session Memory/);
});

test("runCli sess run without a task asks the provider to collect one", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-sess-no-task-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-sess-no-task-bin-"));
  const capturePath = path.join(root, "codex-argv.json");
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);
  await installFakeCodex(binDir, capturePath);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    await runCli([
      "sess",
      "run",
      "--root",
      root,
      "--provider",
      "codex",
      "--skip-refresh",
      "--name",
      "context-only",
    ]);
  } finally {
    process.env.PATH = previousPath;
  }

  const argv = JSON.parse(await fs.readFile(capturePath, "utf8"));
  const prompt = argv.at(-1);
  assert.match(prompt, /No task was provided/);
  assert.match(prompt, /ask the user what task/);
  assert.doesNotMatch(prompt, /Current task: Continue this session/);

  const sessionsRoot = path.join(root, ".agentify", "session");
  const [sessionId] = await fs.readdir(sessionsRoot);
  const launches = await fs.readFile(path.join(sessionsRoot, sessionId, "launches.jsonl"), "utf8");
  assert.match(launches, /"task":""/);
});

test("runCli supports session --resume as a sess resume alias", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-session-resume-alias-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-session-resume-bin-"));
  const capturePath = path.join(root, "codex-argv.json");
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);
  await installFakeCodex(binDir, capturePath);
  const created = await forkContextSession(root, {
    provider: "codex",
    session: {
      memoryPromptMaxKb: 4,
      memoryResults: 3,
      memoryTurns: 6,
    },
  }, { name: "resume alias" });

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    await runCli([
      "session",
      "--resume",
      "--session",
      created.sessionId,
      "--root",
      root,
      "--skip-refresh",
    ]);
  } finally {
    process.env.PATH = previousPath;
  }

  const argv = JSON.parse(await fs.readFile(capturePath, "utf8"));
  const prompt = argv.at(-1);
  assert.match(prompt, /Resume mode is active|Current task: Continue this session/);
  const launches = await fs.readFile(path.join(created.sessionDir, "launches.jsonl"), "utf8");
  assert.match(launches, /Continue this session from the latest repository state/);
});

test("runCli passes routed context prompt to codex sess run and compacts facts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-sess-routed-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-sess-routed-bin-"));
  const capturePath = path.join(root, "codex-argv.json");
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);
  await installFakeCodex(binDir, capturePath);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    await runCli([
      "sess",
      "run",
      "--root",
      root,
      "--provider",
      "codex",
      "--interactive=false",
      "--context-mode",
      "routed",
      "--skip-refresh",
      "--name",
      "routed-session",
      "Continue checkout work",
    ]);
  } finally {
    process.env.PATH = previousPath;
  }

  const argv = JSON.parse(await fs.readFile(capturePath, "utf8"));
  const prompt = argv.at(-1);
  assert.match(prompt, /Agentify routed context mode/);
  assert.match(prompt, /Session bootstrap:/);
  assert.match(prompt, /agentify context fetch <path> --symbol X/);

  const sessionsRoot = path.join(root, ".agentify", "session");
  const entries = await fs.readdir(sessionsRoot);
  assert.equal(entries.length, 1);
  const facts = JSON.parse(await fs.readFile(path.join(sessionsRoot, entries[0], "context-facts.json"), "utf8"));
  assert.equal(facts.event_counts.launches, 1);
  assert.equal(facts.latest_task, "Continue checkout work");
});

test("runCli context commands search, fetch, compact, and status", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-context-cmd-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "login.js"), [
    "export function login() {",
    "  return true;",
    "}",
    "",
  ].join("\n"), "utf8");
  await initGitRepo(root);
  await runCli(["scan", "--root", root]);

  const output = [];
  const originalLog = console.log;
  console.log = (...args) => {
    output.push(args.join(" "));
  };
  try {
    await runCli(["context", "search", "login", "--root", root]);
    await runCli(["context", "fetch", "src/login.js", "--lines", "1:2", "--root", root]);
    const config = { provider: "codex", session: { emitMarkdownArtifacts: true } };
    const created = await forkContextSession(root, config, { name: "context commands" });
    await fs.appendFile(path.join(created.sessionDir, "turns.jsonl"), `${JSON.stringify({
      turn_type: "task",
      content: "Index login context",
    })}\n`, "utf8");
    await runCli(["context", "compact", "--session", created.sessionId, "--root", root]);
    await runCli(["context", "status", "--session", created.sessionId, "--root", root]);
  } finally {
    console.log = originalLog;
  }

  const [search, fetch, compact, status] = output.map((line) => JSON.parse(line));
  assert.equal(search.command, "context search");
  assert.ok(search.refs.some((ref) => ref.path === "src/login.js"));
  assert.equal(fetch.command, "context fetch");
  assert.match(fetch.content, /1: export function login/);
  assert.equal(compact.facts.latest_task, "Index login context");
  assert.equal(status.has_context_facts, true);
});

test("runCli supports skill install with provider all", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-skill-"));
  await runCli(["skill", "install", "god-mode", "--root", root, "--provider", "all", "--scope", "project"]);

  await assert.doesNotReject(() =>
    fs.access(path.join(root, ".claude", "skills", "worktree-autopilot", "SKILL.md"))
  );
  await assert.doesNotReject(() =>
    fs.access(path.join(root, ".opencode", "skills", "worktree-autopilot", "SKILL.md"))
  );
});

test("runCli supports skill install all for codex project scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-skill-all-codex-"));
  await runCli(["skill", "install", "all", "--root", root, "--provider", "codex", "--scope", "project"]);

  for (const skillName of ["grill-me", "improve-codebase-architecture", "gh-autopilot", "copy-mode", "worktree-autopilot", "pr-creator", "commit-creator"]) {
    await assert.doesNotReject(() =>
      fs.access(path.join(root, ".codex", "skills", skillName, "SKILL.md"))
    );
  }
});

test("runCli hooks install honors hook settings from .agentify.yaml", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-hooks-config-"));
  await fs.mkdir(path.join(root, ".git", "hooks"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".agentify.yaml"),
    "hooks:\n  preCommit: true\n  postMerge: false\n",
    "utf8",
  );

  const output = [];
  const originalLog = console.log;
  console.log = (...args) => {
    output.push(args.join(" "));
  };

  try {
    await runCli(["hooks", "install", "--root", root]);
  } finally {
    console.log = originalLog;
  }

  const preCommit = await fs.readFile(path.join(root, ".git", "hooks", "pre-commit"), "utf8");
  assert.match(preCommit, /agentify check --hook/);
  await assert.rejects(() => fs.access(path.join(root, ".git", "hooks", "post-merge")), { code: "ENOENT" });
});

test("runCli memory compress reports placeholder status", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-memory-compress-"));
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => {
    output.push(args.join(" "));
  };

  try {
    await runCli(["memory", "compress", "AGENTIFY.md", "--root", root, "--json"]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(output.length, 1);
  const payload = JSON.parse(output[0]);
  assert.equal(payload.command, "memory compress");
  assert.equal(payload.status, "not_implemented");
  assert.match(payload.message, /^TODO:/);
});

test("runCli init writes baseline local work and guardrail files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-init-"));
  await runCli(["init", "--root", root]);

  const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /# >>> agentify generated artifacts/);
  assert.match(gitignore, /^\.agentify\/$/m);
  assert.match(gitignore, /^docs\/modules\/$/m);
  assert.match(gitignore, /^agentify-report\.html$/m);
  assert.doesNotMatch(gitignore, /^\.agentify\.yaml$/m);
  await assert.doesNotReject(() => fs.access(path.join(root, ".agentignore")));
  await assert.doesNotReject(() => fs.access(path.join(root, ".guardrails")));
  await assert.doesNotReject(() => fs.access(path.join(root, ".agentify", "work")));
  await assert.rejects(() => fs.access(path.join(root, ".codex", "skills")), { code: "ENOENT" });
  await assert.rejects(() => fs.access(path.join(root, ".claude", "skills")), { code: "ENOENT" });
});

test("runCli init preserves existing gitignore entries while adding Agentify ignores", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-init-gitignore-"));
  await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");
  await runCli(["init", "--root", root]);

  const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /^node_modules\/$/m);
  assert.match(gitignore, /# >>> agentify generated artifacts/);
  assert.match(gitignore, /^AGENTIFY\.md$/m);
  assert.match(gitignore, /^output\.txt$/m);
});

test("runCli init updates gitignore Agentify block without dropping user additions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-init-gitignore-merge-"));
  await fs.writeFile(path.join(root, ".gitignore"), [
    "node_modules/",
    "",
    "# >>> agentify generated artifacts",
    ".agents/",
    ".agentify/",
    ".agentify/work/",
    "local.env",
    "# <<< agentify generated artifacts",
    "",
    "coverage-local/",
    "",
  ].join("\n"), "utf8");

  await runCli(["init", "--root", root]);

  const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /^node_modules\/$/m);
  assert.match(gitignore, /^coverage-local\/$/m);
  assert.match(gitignore, /^local\.env$/m);
  assert.match(gitignore, /^\.current_session\/$/m);
  assert.match(gitignore, /^agentify-report\.html$/m);
  assert.doesNotMatch(gitignore, /^\.agents\/$/m);
  assert.doesNotMatch(gitignore, /^\.agentify\/work\/$/m);
  assert.equal((gitignore.match(/^local\.env$/gm) || []).length, 1);
});

test("runCli generated artifacts stay out of git status after repo config is committed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-gitignore-clean-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "auth", "index.ts"), "export const login = () => true;\n", "utf8");

  await runCli(["init", "--root", root]);
  await initGitRepo(root);
  await runCli(["scan", "--root", root]);
  await runCli(["doc", "--root", root]);

  const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd: root });
  assert.equal(stdout, "");
});

test("runCli plan reports actionable guidance when the index is missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-plan-missing-index-"));
  await runCli(["init", "--root", root]);

  await assert.rejects(
    () => runCli(["plan", "--root", root, "summarize setup"]),
    new RegExp(`Agentify index missing for ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  await assert.rejects(
    () => runCli(["plan", "--root", root, "summarize setup"]),
    /Run "agentify scan --root .*" or "agentify up --root .*" before using plan\/query\/context commands\./,
  );
});

test("runCli plan reports actionable guidance when the index is unreadable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-plan-invalid-index-"));
  await runCli(["init", "--root", root]);
  await fs.mkdir(path.join(root, ".agentify"), { recursive: true });
  await fs.writeFile(path.join(root, ".agentify", "index.db"), "not sqlite", "utf8");

  await assert.rejects(
    () => runCli(["plan", "--root", root, "summarize setup"]),
    new RegExp(`Agentify index unreadable for ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  await assert.rejects(
    () => runCli(["plan", "--root", root, "summarize setup"]),
    /Run "agentify scan --root .*" or "agentify up --root .*" to rebuild it before using plan\/query\/context commands\./,
  );
});

test("runCli plan --explain renders text and JSON score breakdowns", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-plan-explain-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "auth", "service.js"),
    "export function loginUser(rawToken) {\n  return rawToken.trim();\n}\n",
    "utf8",
  );
  await initGitRepo(root);
  await runCli(["scan", "--root", root]);

  const stdoutChunks = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk, encoding, callback) => {
    stdoutChunks.push(String(chunk));
    if (typeof encoding === "function") {
      encoding();
    } else if (typeof callback === "function") {
      callback();
    }
    return true;
  });

  try {
    await runCli(["plan", "--root", root, "--explain", "fix loginUser"]);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  const text = stdoutChunks.join("");
  assert.match(text, /Agentify plan explanation/);
  assert.match(text, /lexical\/token match=/);
  assert.match(text, /recency\/changed-file boost=/);
  assert.match(text, /lexical\.symbol\.direct_name_match/);

  const jsonOutput = [];
  const originalLog = console.log;
  console.log = (...args) => {
    jsonOutput.push(args.join(" "));
  };

  try {
    await runCli(["plan", "--root", root, "--explain", "--json", "fix loginUser"]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(jsonOutput.length, 1);
  const payload = JSON.parse(jsonOutput[0]);
  assert.equal(payload.explain.schema_version, 1);
  assert.ok(payload.selected_files.some((fileInfo) => typeof fileInfo.score_breakdown?.total === "number"));
  assert.ok(payload.selected_symbols.some((symbolInfo) => symbolInfo.reasons.some((reason) => reason.code === "lexical.symbol.direct_name_match")));
});

test("runCli query reports actionable guidance when the index is missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-query-missing-index-"));
  await runCli(["init", "--root", root]);

  await assert.rejects(
    () => runCli(["query", "owner", "--root", root, "--file", "src/app.ts"]),
    /before using plan\/query\/context commands\./,
  );
});

test("runCli context fetch returns exact bounded slices by lines and symbol", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-main-context-fetch-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src", "analytics"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "analytics", "report.js"),
    [
      "export function buildReport(events) {",
      "  return events.length;",
      "}",
      "",
      "export const reportName = 'analytics';",
      "",
    ].join("\n"),
    "utf8",
  );
  await initGitRepo(root);
  await runCli(["scan", "--root", root]);

  const searchOutput = await captureConsoleLog(() =>
    runCli(["context", "search", "analytics", "--root", root])
  );
  const searchPayload = JSON.parse(searchOutput[0]);
  assert.ok(searchPayload.refs.some((ref) => ref.path === "src/analytics/report.js"));

  const lineOutput = await captureConsoleLog(() =>
    runCli(["context", "fetch", "src/analytics/report.js", "--root", root, "--lines", "1:2"])
  );
  const linePayload = JSON.parse(lineOutput[0]);
  assert.equal(linePayload.path, "src/analytics/report.js");
  assert.equal(linePayload.command, "context fetch");
  assert.equal(linePayload.content, "   1: export function buildReport(events) {\n   2:   return events.length;");

  const symbolOutput = await captureConsoleLog(() =>
    runCli(["context", "fetch", "src/analytics/report.js", "--root", root, "--symbol", "buildReport"])
  );
  const symbolPayload = JSON.parse(symbolOutput[0]);
  assert.equal(symbolPayload.command, "context fetch");
  assert.equal(symbolPayload.symbol.symbol, "buildReport");
  assert.match(symbolPayload.content, /export function buildReport/);
  assert.doesNotMatch(symbolPayload.content, /reportName/);
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
  assert.equal(payload.skill_install_hint.installed, false);
  assert.equal(payload.skill_install_hint.reason, "skills_are_opt_in");
  assert.match(payload.skill_install_hint.command, /^agentify skill install all --provider codex --scope project$/);
  await assert.rejects(() => fs.access(path.join(root, ".codex", "skills")), { code: "ENOENT" });
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
  const gitignoreText = await fs.readFile(path.join(root, ".gitignore"), "utf8");
  const skillText = await fs.readFile(path.join(root, ".codex", "skills", "grill-me", "SKILL.md"), "utf8");
  const hookText = await fs.readFile(path.join(root, ".git", "hooks", "post-merge"), "utf8");

  assert.match(configText, /^semantic:/m);
  assert.match(configText, /^toolchain:/m);
  assert.match(gitignoreText, /# >>> agentify generated artifacts/);
  assert.match(gitignoreText, /^\.agentify\/$/m);
  assert.match(skillText, /Interview the user relentlessly/);
  assert.match(hookText, /agentify scan --json >\/dev\/null 2>&1 && agentify doc --provider local --json >\/dev\/null 2>&1 \|\| true/);
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
  const stderrChunks = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.exitCode = undefined;
  process.stderr.write = ((chunk, encoding, callback) => {
    stderrChunks.push(String(chunk));
    return originalWrite(chunk, encoding, callback);
  });

  try {
    await runCli(["exec", "--root", root, "--fail-on-stale", "--", "node", "--input-type=module", "-e", script]);
    const afterDocMtime = (await fs.stat(docPath)).mtimeMs;

    assert.equal(process.exitCode, 1);
    assert.equal(afterDocMtime > beforeDocMtime, true);
    assert.doesNotMatch(stderrChunks.join(""), /code-body-changed/);
  } finally {
    process.stderr.write = originalWrite;
    process.exitCode = originalExitCode;
  }
});
