import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runScan } from "../src/core/commands.js";
import { loadConfig } from "../src/core/config.js";
import { getRepoMeta, openIndexDatabase, closeIndexDatabase } from "../src/core/db.js";
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

test("runExec refreshes when the wrapped command commits and exits clean", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-exec-commit-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.js"), "export const version = 1;\n", "utf8");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "local", dryRun: false, tokenReport: false });
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

  assert.equal(result.phase, "complete");
  assert.equal(result.exitCode, 0);
  assert.match(transcript, /> Current task/);
  assert.match(transcript, /assistant says hello/);
  assert.match(transcript, /> Run status/);
  assert.match(memoryContext, /Automatic Session Memory/);
  assert.match(launches, /captured-pipe/);
  assert.match(launches, /Continue this session using the remembered context/);
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
