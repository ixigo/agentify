import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadConfig } from "../src/core/config.js";
import {
  forkSession,
  maybePrepareChildSession,
  resumeSession,
  synthesizeBootstrapFromContext,
} from "../src/core/session.js";
import {
  appendRunSummary,
  getSessionArtifactPaths,
  loadAutomaticSessionMemory,
} from "../src/core/session-memory.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

test("forkSession initializes structured run_history and rolling_summary in context.json", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-structured-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  const result = await forkSession(root, config, { name: "structured" });

  assert.deepEqual(result.context.run_history, []);
  assert.equal(result.context.rolling_summary, "");
  assert.ok(result.context.cache_refs.turns.endsWith("turns.jsonl"));
  assert.ok(result.manifest.metadata.runtime_artifacts.includes("turns.jsonl"));
  assert.ok(result.manifest.cache_refs.some((item) => item.endsWith("context-events.jsonl")));
  assert.ok(result.manifest.metadata.runtime_artifacts.includes("context-events.jsonl"));
  assert.ok(result.manifest.metadata.optional_markdown_artifacts.includes("bootstrap.md"));
});

test("resumeSession synthesizes bootstrap from context when markdown artifacts are disabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-no-markdown-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  config.session.emitMarkdownArtifacts = false;

  const created = await forkSession(root, config, { name: "no-markdown" });
  const bootstrapPath = path.join(created.sessionDir, "bootstrap.md");
  assert.equal(await fileExists(bootstrapPath), false);

  const resumed = await resumeSession(root, created.sessionId);
  assert.match(resumed.bootstrap, /Session Context/);
  assert.match(resumed.bootstrap, /Provider: codex/);
  assert.match(resumed.bootstrap, /Rolling Summary/);
});

test("synthesizeBootstrapFromContext renders recent runs from structured state", () => {
  const manifest = {
    session_id: "sess_synth",
    parent_id: null,
    provider: "codex",
    created_at: "2026-04-21T10:00:00Z",
    head_commit_at_creation: "deadbeef",
  };
  const context = {
    index_snapshot: { module_ids: ["api", "web"], module_count: 2 },
    checklist: [],
    checklist_summary: { total_items: 0, displayed_items: 0, remaining_items: 0 },
    run_history: [
      {
        started_at: "t1",
        ended_at: "t2",
        task: "ship feature X",
        exit_code: 0,
        validation: "passed",
        assistant_summary: "done",
      },
    ],
    rolling_summary: "Feature X shipped cleanly.",
  };
  const rendered = synthesizeBootstrapFromContext(manifest, context);
  assert.match(rendered, /sess_synth/);
  assert.match(rendered, /ship feature X/);
  assert.match(rendered, /Feature X shipped cleanly/);
});

test("appendRunSummary keeps run_history bounded and updates rolling_summary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-rollup-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  config.session.runHistoryMax = 5;
  config.session.runSummaryMaxBytes = 120;
  const created = await forkSession(root, config, { name: "rollup" });

  for (let index = 0; index < 12; index += 1) {
    await appendRunSummary(root, created.sessionId, {
      started_at: `s-${index}`,
      ended_at: `e-${index}`,
      task: `task ${index} ${"x".repeat(300)}`,
      assistant_summary: `summary ${index} ${"y".repeat(300)}`,
      exit_code: index % 2 === 0 ? 0 : 1,
      validation: index % 2 === 0 ? "passed" : "failed",
      phase: "complete",
      memory_backend: "structured-lineage",
    }, config);
  }

  const contextPath = path.join(created.sessionDir, "context.json");
  const context = JSON.parse(await fs.readFile(contextPath, "utf8"));
  assert.equal(context.run_history.length, 5);
  assert.equal(context.run_history[0].started_at, "s-7");
  assert.equal(context.run_history[4].started_at, "s-11");
  for (const entry of context.run_history) {
    assert.ok(Buffer.byteLength(entry.assistant_summary, "utf8") <= 120);
  }
  assert.match(context.rolling_summary, /Last task: task 11/);
});

test("forkSession inherits run_history and rolling_summary from parent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-inherit-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  const parent = await forkSession(root, config, { name: "parent" });
  await appendRunSummary(root, parent.sessionId, {
    started_at: "p-start",
    ended_at: "p-end",
    task: "investigate refresh bug",
    assistant_summary: "refresh bug fixed after wrapping the refresh call.",
    exit_code: 0,
    validation: "passed",
    phase: "complete",
    memory_backend: "structured-lineage",
  }, config);

  const child = await forkSession(root, config, { from: parent.sessionId, name: "child" });
  assert.equal(child.context.run_history.length, 1);
  assert.equal(child.context.run_history[0].task, "investigate refresh bug");
  assert.match(child.context.rolling_summary, /refresh bug fixed/);
});

test("forkSession compacts child context while preserving runtime artifact refs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-child-compact-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  config.session.contextMaxKb = 4;
  config.session.bootstrapMaxKb = 1;
  config.session.emitMarkdownArtifacts = false;
  const parent = await forkSession(root, config, { name: "parent" });
  await fs.writeFile(
    path.join(parent.sessionDir, "checklist.json"),
    `${JSON.stringify(Array.from({ length: 40 }, (_, index) => ({
      done: false,
      text: `large inherited task ${index} ${"x".repeat(160)}`,
    })), null, 2)}\n`,
    "utf8",
  );
  await appendRunSummary(root, parent.sessionId, {
    started_at: "p-start",
    ended_at: "p-end",
    task: "prepare a child session with compact routed context",
    assistant_summary: "child should retain artifact refs while dropping oversized details",
    exit_code: 0,
    validation: "passed",
    phase: "complete",
    memory_backend: "structured-lineage",
  }, config);

  const child = await forkSession(root, config, { from: parent.sessionId, name: "child" });
  const resumed = await resumeSession(root, child.sessionId);

  assert.equal(child.manifest.metadata.context_truncated, true);
  assert.equal(child.manifest.metadata.bootstrap_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(child.context), "utf8") <= 4096);
  assert.match(resumed.bootstrap, /Session Context/);
  assert.match(resumed.bootstrap, /Full routing: host shell -> \.agents\/index\.db/);
  assert.ok(child.context.cache_refs.turns.endsWith("turns.jsonl"));
  assert.ok(child.context.cache_refs.checklist.endsWith("checklist.json"));
  assert.equal(await fileExists(path.join(child.sessionDir, "bootstrap.md")), false);
});

test("maybePrepareChildSession creates child above context threshold without launching provider", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-child-threshold-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  config.session.prepareChildAboveKb = 0.001;
  const parent = await forkSession(root, config, { name: "parent" });
  await appendRunSummary(root, parent.sessionId, {
    started_at: "p-start",
    ended_at: "p-end",
    task: "large context handoff",
    assistant_summary: "prepare child session without launching provider",
    exit_code: 0,
    validation: "passed",
    phase: "complete",
    memory_backend: "structured-lineage",
  }, config);

  const result = await maybePrepareChildSession(root, config, parent.sessionId, { provider: "codex" });
  assert.ok(result.child_session_id.startsWith("sess_"));
  assert.match(result.resume_command, new RegExp(result.child_session_id));

  const childManifest = JSON.parse(await fs.readFile(
    path.join(root, ".agents", "session", result.child_session_id, "session-manifest.json"),
    "utf8"
  ));
  assert.equal(childManifest.parent_id, parent.sessionId);
  const parentManifest = JSON.parse(await fs.readFile(path.join(parent.sessionDir, "session-manifest.json"), "utf8"));
  assert.equal(parentManifest.prepared_child_session.session_id, result.child_session_id);
});

test("loadAutomaticSessionMemory prefers structured lineage over transcript replay", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-structured-lineage-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  const parent = await forkSession(root, config, { name: "parent" });
  await appendRunSummary(root, parent.sessionId, {
    started_at: "p-start",
    ended_at: "p-end",
    task: "wire up structured memory",
    assistant_summary: "context.json now carries the rolling summary.",
    exit_code: 0,
    validation: "passed",
    phase: "complete",
    memory_backend: "structured-lineage",
  }, config);

  const paths = getSessionArtifactPaths(root, parent.sessionId);
  await fs.writeFile(paths.transcriptPath, [
    "# Agentify Session Run",
    "",
    "> Provider response",
    "legacy transcript content",
    "",
  ].join("\n"), "utf8");

  const child = await forkSession(root, config, { from: parent.sessionId, name: "child" });
  const memory = await loadAutomaticSessionMemory(root, child.manifest, config);

  assert.equal(memory.backend, "structured-lineage");
  assert.ok([child.sessionId, parent.sessionId].includes(memory.sourceSessionId));
  assert.match(memory.markdown, /rolling summary/);
  assert.match(memory.markdown, /wire up structured memory/);
});

test("lineage replay falls back to turns.jsonl when transcript.md is absent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-turns-fallback-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  config.session.emitMarkdownArtifacts = false;
  const parent = await forkSession(root, config, { name: "parent" });
  const paths = getSessionArtifactPaths(root, parent.sessionId);

  const turns = [
    {
      schema_version: "1.0",
      turn_type: "task",
      role: "user",
      session_id: parent.sessionId,
      timestamp: "t1",
      content: "Fix the refresh regression after commits.",
    },
    {
      schema_version: "1.0",
      turn_type: "assistant_response",
      role: "assistant",
      session_id: parent.sessionId,
      timestamp: "t2",
      content: "Refresh after the wrapped command lands, then validate.",
    },
  ];
  for (const turn of turns) {
    await fs.appendFile(paths.turnsPath, `${JSON.stringify(turn)}\n`, "utf8");
  }
  assert.equal(await fileExists(paths.transcriptPath), false);

  const child = await forkSession(root, config, { from: parent.sessionId, name: "child" });
  const memory = await loadAutomaticSessionMemory(root, child.manifest, config);

  assert.equal(memory.backend, "lineage-replay");
  assert.equal(memory.sourceSessionId, parent.sessionId);
  assert.match(memory.markdown, /Refresh after the wrapped command lands/);
});
