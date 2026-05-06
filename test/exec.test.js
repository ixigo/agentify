import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runDoc, runScan } from "../src/core/commands.js";
import { loadConfig } from "../src/core/config.js";
import { closeIndexDatabase, openIndexDatabase } from "../src/core/db/connection.js";
import { getRepoMeta } from "../src/core/db/metadata-store.js";
import { runExec } from "../src/core/exec.js";
import { getHeadCommit } from "../src/core/git.js";
import { forkSession } from "../src/core/session.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

async function addLocalSubmodule(root, submodulePath) {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-submodule-source-"));
  await fs.writeFile(path.join(source, "readme.md"), "v1\n", "utf8");
  await initGitRepo(source);
  await execFileAsync(
    "git",
    ["-c", "protocol.file.allow=always", "submodule", "add", source, submodulePath],
    { cwd: root }
  );
  await execFileAsync("git", ["commit", "-am", `add ${submodulePath}`], { cwd: root });
}

test("runExec refreshes when the wrapped command commits and exits clean", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-exec-commit-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.js"), "export const version = 1;\n", "utf8");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "local", dryRun: false, tokenReport: false, docs: true });
  await runScan(root, config);
  const initialHead = await getHeadCommit(root);

  const script = [
    "import fs from 'node:fs/promises';",
    "import { execFile } from 'node:child_process';",
    "import { promisify } from 'node:util';",
    "const execFileAsync = promisify(execFile);",
    "const root = process.cwd();",
    "await fs.appendFile('src/index.js', 'export const next = 2;\\n', 'utf8');",
    "await execFileAsync('git', ['add', 'src/index.js'], { cwd: root });",
    "await execFileAsync('git', ['commit', '-m', 'wrapped change'], { cwd: root });",
  ].join("");

  const result = await runExec(root, config, ["node", "--input-type=module", "-e", script], {});

  assert.equal(result.phase, "complete");
  assert.equal(result.exitCode, 0);
  assert.equal(result.skippedRefresh, undefined);
  assert.equal(result.validation?.passed, true);
  assert.equal(await fs.stat(path.join(root, "AGENTIFY.md")).then(() => true), true);

  const db = openIndexDatabase(root);
  try {
    const meta = getRepoMeta(db);
    const currentHead = await getHeadCommit(root);
    assert.notEqual(currentHead, initialHead);
    assert.equal(meta.head_commit, currentHead);
  } finally {
    closeIndexDatabase(db);
  }
});

test("runExec hook-friendly validation allows wrapped source edits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-exec-dirty-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.js"), "export const version = 1;\n", "utf8");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "local", dryRun: false, tokenReport: false, docs: true });
  await runScan(root, config);
  await runDoc(root, config);

  const docPath = path.join(root, "AGENTIFY.md");
  const beforeDocMtime = (await fs.stat(docPath)).mtimeMs;
  await fs.appendFile(path.join(root, "src", "index.js"), "export const preexisting = true;\n", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 25));

  const script = [
    "import fs from 'node:fs/promises';",
    "await fs.appendFile('src/index.js', 'export const fromRunExec = true;\\n', 'utf8');",
  ].join("");

  const result = await runExec(root, config, ["node", "--input-type=module", "-e", script], {
    skipCodeBodyChanges: true,
  });
  const afterDocMtime = (await fs.stat(docPath)).mtimeMs;

  assert.equal(result.phase, "complete");
  assert.equal(result.exitCode, 0);
  assert.equal(result.skippedRefresh, undefined);
  assert.equal(afterDocMtime > beforeDocMtime, true);
  assert.equal(result.validation?.passed, true);
  assert.equal(result.validation?.failures.some((failure) => failure.category === "code-body-changed"), false);
  assert.equal(result.executionTelemetry.phase, "complete");
  assert.equal(result.executionTelemetry.provider, "local");
  assert.equal(result.executionTelemetry.changed_files_count, 1);
  assert.deepEqual(result.executionTelemetry.changed_paths, ["src/index.js"]);

  const output = await fs.readFile(path.join(root, "output.txt"), "utf8");
  const html = await fs.readFile(path.join(root, "agentify-report.html"), "utf8");
  const telemetryPath = path.join(root, ".agents", "runs", `${result.executionTelemetry.run_id}-execution-telemetry.json`);
  const telemetry = JSON.parse(await fs.readFile(telemetryPath, "utf8"));
  assert.match(output, /execution: changed_files=1/);
  assert.match(html, /execution telemetry/);
  assert.deepEqual(telemetry.changed_paths, ["src/index.js"]);
});

test("runExec includes committed edits in execution telemetry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-exec-committed-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.js"), "export const version = 1;\n", "utf8");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "local", dryRun: false, tokenReport: false });
  await runScan(root, config);
  await runDoc(root, config);

  const script = [
    "import fs from 'node:fs/promises';",
    "import { execFile } from 'node:child_process';",
    "import { promisify } from 'node:util';",
    "const execFileAsync = promisify(execFile);",
    "await fs.appendFile('src/index.js', 'export const committed = true;\\n', 'utf8');",
    "await execFileAsync('git', ['add', 'src/index.js']);",
    "await execFileAsync('git', ['commit', '-m', 'update source']);",
  ].join("");

  const result = await runExec(root, config, ["node", "--input-type=module", "-e", script], {});

  assert.equal(result.executionTelemetry.head_changed, true);
  assert.equal(result.executionTelemetry.changed_files_count, 1);
  assert.deepEqual(result.executionTelemetry.changed_paths, ["src/index.js"]);
});

test("runExec provider validation allows non-code app config edits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-exec-env-edit-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.js"), "export const value = true;\n", "utf8");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "local", dryRun: false, tokenReport: false });
  await runScan(root, config);
  await runDoc(root, config);

  const script = [
    "import fs from 'node:fs/promises';",
    "await fs.writeFile('.env.development', 'FEATURE_FLAG=true\\n', 'utf8');",
  ].join("");

  const originalExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    const result = await runExec(
      root,
      config,
      ["node", "--input-type=module", "-e", script],
      { skipCodeBodyChanges: true }
    );

    assert.equal(result.phase, "complete");
    assert.equal(result.exitCode, 0);
    assert.equal(result.validation?.passed, true);
    assert.equal(result.validation?.failures.some((failure) => failure.path === ".env.development"), false);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test("runExec hook-friendly validation still records failing commands after source edits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-exec-failed-refresh-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.js"), "export const version = 1;\n", "utf8");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "local", dryRun: false, tokenReport: false });
  await runScan(root, config);
  await runDoc(root, config);

  const docPath = path.join(root, "AGENTIFY.md");
  const beforeDocMtime = (await fs.stat(docPath)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 25));

  const script = [
    "import fs from 'node:fs/promises';",
    "await fs.appendFile('src/index.js', 'export const failedRunExec = true;\\n', 'utf8');",
    "process.exit(1);",
  ].join("");

  const originalExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    const result = await runExec(
      root,
      config,
      ["node", "--input-type=module", "-e", script],
      { failOnStale: true, skipCodeBodyChanges: true }
    );
    const afterDocMtime = (await fs.stat(docPath)).mtimeMs;

    assert.equal(result.phase, "complete");
    assert.equal(result.exitCode, 1);
    assert.equal(result.skippedRefresh, undefined);
    assert.equal(afterDocMtime > beforeDocMtime, true);
    assert.equal(result.validation?.passed, true);
    assert.equal(result.validation?.failures.some((failure) => failure.category === "code-body-changed"), false);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test("runExec tolerates dirty submodules when capturing dirty-path digests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-exec-submodule-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);
  await addLocalSubmodule(root, ".codex/submod");

  const config = await loadConfig(root, { provider: "local", dryRun: false, tokenReport: false });
  await runScan(root, config);
  await fs.appendFile(path.join(root, ".codex", "submod", "readme.md"), "dirty\n", "utf8");

  const result = await runExec(root, config, ["node", "--input-type=module", "-e", ""], {});

  assert.equal(result.phase, "complete");
  assert.equal(result.exitCode, 0);
  assert.equal(result.skippedRefresh, true);
  assert.equal(result.validation?.passed, true);
});

test("runExec writes MemPalace-compatible session memory artifacts when recording is enabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-exec-memory-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex", dryRun: false, tokenReport: false });
  const session = await forkSession(root, config, { name: "memory" });
  const result = await runExec(
    root,
    config,
    ["node", "--input-type=module", "-e", "process.stdout.write('assistant says hello\\n')"],
    {
      captureOutput: true,
      sessionRecord: {
        sessionId: session.sessionId,
        provider: "codex",
        prompt: "Continue this session using the remembered context.",
        task: "Verify transcript persistence.",
        command: ["node", "--input-type=module", "-e", "process.stdout.write('assistant says hello\\n')"],
        memoryContext: {
          sourceSessionId: null,
          transcriptRelativePath: null,
          excerpt: "",
          markdown: "## Automatic Session Memory\nNo prior session transcript was available.\n",
        },
        captureMode: "captured-pipe",
      },
    }
  );

  const transcript = await fs.readFile(path.join(session.sessionDir, "transcript.md"), "utf8");
  const memoryContext = await fs.readFile(path.join(session.sessionDir, "memory-context.md"), "utf8");
  const launches = await fs.readFile(path.join(session.sessionDir, "launches.jsonl"), "utf8");
  const launchRecord = JSON.parse(launches.trim().split(/\r?\n/).at(-1));

  assert.equal(result.phase, "complete");
  assert.equal(result.exitCode, 0);
  assert.match(transcript, /> Current task/);
  assert.match(transcript, /assistant says hello/);
  assert.match(transcript, /> Run status/);
  assert.match(memoryContext, /Automatic Session Memory/);
  assert.match(launches, /captured-pipe/);
  assert.match(launches, /Continue this session using the remembered context/);
  assert.equal(launchRecord.managed_context.estimate, true);
  assert.equal(launchRecord.managed_context.basis, "managed_context_bytes");
  assert.equal(launchRecord.managed_context.rollover_threshold_bytes, 96 * 1024);
  assert.ok(launchRecord.managed_context.estimated_managed_context_bytes >= launchRecord.managed_context.bytes.prompt);
  assert.equal(typeof launchRecord.managed_context.bytes.transcript, "number");
  assert.equal(typeof launchRecord.managed_context.bytes.fetch_outputs, "number");
  assert.equal(typeof launchRecord.managed_context.bytes.memory_artifacts, "number");
  assert.match(launchRecord.managed_context.note, /provider live context usage is not directly observable/);
});

test("runExec skips refresh when only Agentify session artifacts change", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-exec-session-artifacts-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex", dryRun: false, tokenReport: false, docs: true });
  const session = await forkSession(root, config, { name: "artifact-refresh" });
  await execFileAsync("git", ["add", ".agents"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "track session artifact baseline"], { cwd: root });

  const result = await runExec(
    root,
    config,
    ["node", "--input-type=module", "-e", "process.stdout.write('session artifact only\\n')"],
    {
      captureOutput: true,
      sessionRecord: {
        sessionId: session.sessionId,
        provider: "codex",
        prompt: "Continue the session.",
        task: "Verify session artifact refresh behavior.",
        command: ["node", "--input-type=module", "-e", "process.stdout.write('session artifact only\\n')"],
        memoryContext: {
          sourceSessionId: null,
          transcriptRelativePath: null,
          excerpt: "",
          markdown: "## Automatic Session Memory\nNo prior session transcript was available.\n",
        },
        captureMode: "captured-pipe",
      },
    }
  );

  assert.equal(result.phase, "complete");
  assert.equal(result.exitCode, 0);
  assert.equal(result.skippedRefresh, true);
  assert.equal(result.executionTelemetry.changed_files_count, 0);
  assert.deepEqual(result.executionTelemetry.changed_paths, []);
  await assert.rejects(
    () => fs.access(path.join(root, "AGENTIFY.md")),
    /ENOENT/
  );
});

test("runExec redacts obvious secrets from session memory artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-exec-redaction-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex", dryRun: false, tokenReport: false });
  const session = await forkSession(root, config, { name: "redaction" });
  const command = [
    "node",
    "--input-type=module",
    "-e",
    "process.stdout.write('OPENAI_API_KEY=sk-live-secret12345\\nBearer eyJhbGciOiJIUzI1NiJ9.secret\\n')",
  ];

  await runExec(root, config, command, {
    captureOutput: true,
    skipRefresh: true,
    sessionRecord: {
      sessionId: session.sessionId,
      provider: "codex",
      prompt: "Use API_KEY=super-secret-value to test redaction.",
      task: "Rotate PASSWORD=hunter2 before recording.",
      command: ["env", "SERVICE_TOKEN=token-value-123456", ...command],
      memoryContext: {
        sourceSessionId: null,
        transcriptRelativePath: null,
        excerpt: "Prior note had SECRET=do-not-store.",
        markdown: "## Automatic Session Memory\nSECRET=do-not-store\n",
      },
      captureMode: "captured-pipe",
    },
  });

  const transcript = await fs.readFile(path.join(session.sessionDir, "transcript.md"), "utf8");
  const memoryContext = await fs.readFile(path.join(session.sessionDir, "memory-context.md"), "utf8");
  const launches = await fs.readFile(path.join(session.sessionDir, "launches.jsonl"), "utf8");
  const turns = await fs.readFile(path.join(session.sessionDir, "turns.jsonl"), "utf8");
  const context = await fs.readFile(path.join(session.sessionDir, "context.json"), "utf8");
  const combined = [transcript, memoryContext, launches, turns, context].join("\n");

  for (const leaked of [
    "sk-live-secret12345",
    "eyJhbGciOiJIUzI1NiJ9.secret",
    "super-secret-value",
    "hunter2",
    "token-value-123456",
    "do-not-store",
  ]) {
    assert.doesNotMatch(combined, new RegExp(leaked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(combined, /\[REDACTED\]/);
});

test("runExec bounds captured stdout and stderr to the configured capture limit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-exec-buffer-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex", dryRun: false, tokenReport: false });
  config.session.captureMaxKb = 1;

  const stdoutPayload = "a".repeat(1536);
  const stderrPayload = "b".repeat(1536);
  const script = [
    `process.stdout.write(${JSON.stringify(stdoutPayload)});`,
    `process.stderr.write(${JSON.stringify(stderrPayload)});`,
  ].join("");

  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;

  try {
    const result = await runExec(
      root,
      config,
      ["node", "--input-type=module", "-e", script],
      {
        captureOutput: true,
        skipRefresh: true,
      }
    );

    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.byteLength(result.stdout, "utf8"), 1024);
    assert.equal(Buffer.byteLength(result.stderr, "utf8"), 1024);
    assert.equal(result.stdout, stdoutPayload.slice(0, 1024));
    assert.equal(result.stderr, stderrPayload.slice(0, 1024));
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
});

test("runExec records interactive provider output into a raw PTY log and normalized transcript", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-exec-interactive-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);

  for (const provider of ["codex", "claude"]) {
    const config = await loadConfig(root, { provider, dryRun: false, tokenReport: false });
    const session = await forkSession(root, config, { name: `${provider}-interactive` });
    const result = await runExec(
      root,
      config,
      ["node", "--input-type=module", "-e", "process.stdout.write('interactive transcript\\n')"],
      {
        captureOutputMode: "pty",
        sessionRecord: {
          sessionId: session.sessionId,
          provider,
          prompt: `Continue the ${provider} interactive session.`,
          task: `Verify PTY capture for ${provider}.`,
          command: ["node", "--input-type=module", "-e", "process.stdout.write('interactive transcript\\n')"],
          memoryContext: {
            sourceSessionId: null,
            transcriptRelativePath: null,
            excerpt: "",
            markdown: "## Automatic Session Memory\nNo prior session transcript was available.\n",
          },
          captureMode: "interactive-pty",
        },
      }
    );

    const transcript = await fs.readFile(path.join(session.sessionDir, "transcript.md"), "utf8");
    const launches = await fs.readFile(path.join(session.sessionDir, "launches.jsonl"), "utf8");
    const rawLog = await fs.readFile(path.join(session.sessionDir, "interactive.log"), "utf8");

    assert.equal(result.phase, "complete");
    assert.equal(result.exitCode, 0);
    assert.match(transcript, /interactive transcript/);
    assert.match(transcript, /Raw interactive log:/);
    assert.match(launches, /interactive-pty/);
    assert.match(launches, /interactive\.log/);
    assert.match(rawLog, /interactive transcript/);
  }
});

test("runExec writes a fallback transcript when PTY capture is unavailable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-exec-interactive-fallback-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex", dryRun: false, tokenReport: false });
  const session = await forkSession(root, config, { name: "interactive-fallback" });
  const command = [process.execPath, "--input-type=module", "-e", ""];
  const originalPath = process.env.PATH;
  process.env.PATH = "";

  try {
    const result = await runExec(
      root,
      config,
      command,
      {
        captureOutputMode: "pty",
        skipRefresh: true,
        sessionRecord: {
          sessionId: session.sessionId,
          provider: "codex",
          prompt: "Continue the interactive fallback session.",
          task: "Verify interactive fallback transcript persistence.",
          command,
          memoryContext: {
            sourceSessionId: null,
            transcriptRelativePath: null,
            excerpt: "",
            markdown: "## Automatic Session Memory\nNo prior session transcript was available.\n",
          },
          captureMode: "interactive-pty",
        },
      }
    );

    const transcript = await fs.readFile(path.join(session.sessionDir, "transcript.md"), "utf8");
    const launches = await fs.readFile(path.join(session.sessionDir, "launches.jsonl"), "utf8");
    const launch = JSON.parse(launches.trim().split(/\r?\n/).at(-1));

    assert.equal(result.phase, "complete");
    assert.equal(result.exitCode, 0);
    assert.match(transcript, /full assistant transcript was not captured/);
    assert.match(transcript, /Capture mode used: interactive-fallback/);
    assert.equal(launch.capture_mode, "interactive-fallback");
    assert.equal(launch.raw_interactive_log_path, null);
    await assert.rejects(
      () => fs.access(path.join(session.sessionDir, "interactive.log")),
      /ENOENT/
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("runExec finalizes session memory when the PTY recorder log is unavailable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-exec-interactive-log-missing-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex", dryRun: false, tokenReport: false });
  const session = await forkSession(root, config, { name: "codex-interactive-log-missing" });
  const script = [
    "import fs from 'node:fs/promises';",
    `await fs.unlink(${JSON.stringify(path.join(session.sessionDir, "interactive.log"))});`,
    "process.stdout.write('transcript hidden in removed pty log\\n');",
  ].join("");
  const result = await runExec(
    root,
    config,
    ["node", "--input-type=module", "-e", script],
    {
      captureOutputMode: "pty",
      sessionRecord: {
        sessionId: session.sessionId,
        provider: "codex",
        prompt: "Continue the codex interactive session.",
        task: "Verify PTY capture fallback finalization.",
        command: ["node", "--input-type=module", "-e", script],
        memoryContext: {
          sourceSessionId: null,
          transcriptRelativePath: null,
          excerpt: "",
          markdown: "## Automatic Session Memory\nNo prior session transcript was available.\n",
        },
        captureMode: "interactive-pty",
      },
    }
  );

  const transcript = await fs.readFile(path.join(session.sessionDir, "transcript.md"), "utf8");
  const launches = await fs.readFile(path.join(session.sessionDir, "launches.jsonl"), "utf8");

  assert.equal(result.phase, "complete");
  assert.equal(result.exitCode, 0);
  assert.match(transcript, /full assistant transcript was not captured/);
  assert.match(transcript, /Interactive capture warning: Unable to read PTY transcript log:/);
  assert.doesNotMatch(transcript, /Raw interactive log:/);
  assert.match(launches, /"raw_interactive_log_path":null/);
  assert.match(launches, /"interactive_capture_error":"Unable to read PTY transcript log:/);
});
