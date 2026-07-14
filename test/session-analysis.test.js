import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { analyzeSessionHistory } from "../src/core/session-analysis/index.js";
import { createToolFacts, observeCommand } from "../src/core/session-analysis/file-access.js";
import { isSafeInsightCommand, runInsightProcess } from "../src/core/session-analysis/insights.js";
import { collectToolInventory } from "../src/core/session-analysis/inventory.js";
import { renderAnalysisHtml, renderAnalysisText } from "../src/core/session-analysis/report.js";
import { streamJsonl } from "../src/core/session-analysis/stream-jsonl.js";
import { runCli } from "../src/main.js";

const execFileAsync = promisify(execFile);

async function writeJsonl(filePath, records) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

async function captureConsoleLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

async function initializeGitRepository(root) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), "fixture\n");
  await execFileAsync("git", ["-C", root, "init", "-b", "main"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "agentify-tests@example.com"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Agentify Tests"]);
  await execFileAsync("git", ["-C", root, "add", "README.md"]);
  await execFileAsync("git", ["-C", root, "commit", "-m", "test: initialize fixture"]);
}

test("analyzeSessionHistory streams Claude and Codex facts without retaining transcript content", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-"));
  const projectRoot = path.join(tempRoot, "repo");
  const claudeRoot = path.join(tempRoot, "claude");
  const codexRoot = path.join(tempRoot, "codex");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });

  await writeJsonl(path.join(claudeRoot, "claude-session.jsonl"), [
    {
      type: "user",
      sessionId: "claude-raw-session-id",
      timestamp: "2026-07-14T08:00:00.000Z",
      cwd: projectRoot,
      isSidechain: false,
      message: { role: "user", content: "private prompt sk-super-secret-value" },
    },
    {
      type: "assistant",
      sessionId: "claude-raw-session-id",
      timestamp: "2026-07-14T08:01:00.000Z",
      cwd: projectRoot,
      version: "1.2.3",
      gitBranch: "main",
      isSidechain: false,
      message: {
        role: "assistant",
        model: "claude-test-model",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 40,
          output_tokens: 15,
        },
        content: [
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: path.join(projectRoot, "src/app.js") } },
        ],
      },
    },
  ]);

  await writeJsonl(path.join(codexRoot, "2026", "07", "14", "codex-session.jsonl"), [
    {
      timestamp: "2026-07-14T09:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "codex-raw-session-id",
        cwd: projectRoot,
        cli_version: "9.8.7",
        git: { branch: "feat/test" },
      },
    },
    {
      timestamp: "2026-07-14T09:01:00.000Z",
      type: "turn_context",
      payload: { model: "codex-test-model", cwd: projectRoot },
    },
    {
      timestamp: "2026-07-14T09:02:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 25,
            cached_input_tokens: 10,
            output_tokens: 7,
            reasoning_output_tokens: 3,
          },
        },
      },
    },
    {
      timestamp: "2026-07-14T09:03:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "private codex prompt Bearer abcdef123456789012" },
    },
  ]);

  const report = await analyzeSessionHistory(projectRoot, {
    provider: "all",
    scope: "global",
    days: 30,
    now: new Date("2026-07-14T12:00:00.000Z"),
    sourceRoots: [`claude=${claudeRoot}`, `codex=${codexRoot}`],
    yes: true,
    noCache: true,
    noProgress: true,
  });

  assert.equal(report.sessions.length, 2);
  assert.deepEqual(report.totals.usage, {
    fresh_input_tokens: 115,
    cache_read_tokens: 50,
    cache_write_tokens: 20,
    output_tokens: 22,
    reasoning_output_tokens: 3,
  });
  assert.deepEqual(report.providers.map((item) => item.provider), ["claude", "codex"]);
  assert.equal(report.sessions[0].session_id.length, 16);
  assert.deepEqual(report.sessions.find((item) => item.provider === "claude").file_access, [
    {
      path: "File 1",
      operation: "read",
      source: "structured-tool",
      confidence: "high",
      events: 1,
    },
  ]);

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /private prompt|private codex prompt|super-secret|abcdef123456789012/);
  assert.doesNotMatch(serialized, /claude-raw-session-id|codex-raw-session-id/);
  assert.doesNotMatch(serialized, new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("dry-run discloses source counts without parsing record bodies", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-preview-"));
  const sourceRoot = path.join(tempRoot, "claude");
  const sessionPath = path.join(sourceRoot, "untrusted.jsonl");
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.writeFile(sessionPath, "this body must not be parsed\n");

  const report = await analyzeSessionHistory(path.join(tempRoot, "repo"), {
    provider: "claude",
    scope: "global",
    sourceRoots: [sourceRoot],
    dryRun: true,
  });

  assert.equal(report.dry_run, true);
  assert.equal(report.sessions.length, 0);
  assert.equal(report.providers[0].files, 1);
  assert.equal(report.providers[0].bytes, Buffer.byteLength("this body must not be parsed\n"));
  assert.equal(report.providers[0].records, 0);
  assert.equal(report.providers[0].malformed_records, 0);
  assert.equal(report.privacy.record_bodies_read, false);
  assert.match(renderAnalysisText(report), /record bodies were not read/i);
  assert.doesNotMatch(renderAnalysisText(report), /envelopes were read/i);
});

test("streamJsonl discards oversized records before JSON.parse and continues", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-oversized-line-"));
  const filePath = path.join(tempRoot, "session.jsonl");
  await fs.writeFile(filePath, `${JSON.stringify({ payload: "x".repeat(1_024) })}\n${JSON.stringify({ ok: true })}\n`);
  const records = [];

  const coverage = await streamJsonl(filePath, (record) => records.push(record), { maxRecordBytes: 128 });

  assert.deepEqual(records, [{ ok: true }]);
  assert.deepEqual(coverage, { records: 1, malformed: 0, oversized: 1, blank: 0 });
});

test("first scans fail closed and repeated scans reuse a private content-free cache", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-cache-"));
  const projectRoot = path.join(tempRoot, "repo");
  const sourceRoot = path.join(tempRoot, "claude");
  const cachePath = path.join(tempRoot, "private", "session-analysis.json");
  await fs.mkdir(projectRoot, { recursive: true });
  await writeJsonl(path.join(sourceRoot, "session.jsonl"), [{
    type: "assistant",
    sessionId: "raw-id-must-not-be-cached",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: projectRoot,
    message: {
      model: "claude-test",
      usage: { input_tokens: 5, output_tokens: 2 },
      content: [],
    },
  }]);

  await assert.rejects(
    analyzeSessionHistory(projectRoot, {
      provider: "claude",
      scope: "current-repo",
      sourceRoots: [sourceRoot],
      cachePath,
      now: new Date("2026-07-14T12:00:00.000Z"),
    }),
    /requires explicit consent.*--yes/i,
  );

  const first = await analyzeSessionHistory(projectRoot, {
    provider: "claude",
    scope: "current-repo",
    sourceRoots: [sourceRoot],
    cachePath,
    yes: true,
    now: new Date("2026-07-14T12:00:00.000Z"),
  });
  const second = await analyzeSessionHistory(projectRoot, {
    provider: "claude",
    scope: "current-repo",
    sourceRoots: [sourceRoot],
    cachePath,
    now: new Date("2026-07-14T12:00:00.000Z"),
  });

  assert.deepEqual(first.coverage.cache, { hits: 0, misses: 1, writes: 1 });
  assert.deepEqual(second.coverage.cache, { hits: 1, misses: 0, writes: 0 });
  assert.equal(first.privacy.record_bodies_read, true);
  assert.equal(second.privacy.record_bodies_read, false);
  assert.match(renderAnalysisText(second), /record bodies were not read/i);
  assert.equal(first.totals.usage.cache_read_tokens, null);
  assert.equal(first.totals.usage.cache_write_tokens, null);
  assert.equal(first.totals.usage.reasoning_output_tokens, null);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(cachePath)).mode & 0o777, 0o600);
  }
  const cached = await fs.readFile(cachePath, "utf8");
  assert.doesNotMatch(cached, /raw-id-must-not-be-cached/);
  assert.doesNotMatch(cached, new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("current-repo includes the primary checkout when analysis runs from a linked worktree", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-primary-worktree-"));
  const primaryRoot = path.join(tempRoot, "primary");
  const linkedRoot = path.join(tempRoot, "linked");
  const sourceRoot = path.join(tempRoot, "claude");
  await initializeGitRepository(primaryRoot);
  await execFileAsync("git", ["-C", primaryRoot, "worktree", "add", "-b", "feat/linked", linkedRoot]);
  await writeJsonl(path.join(sourceRoot, "primary-session.jsonl"), [{
    type: "assistant",
    sessionId: "primary-session",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: primaryRoot,
    message: { model: "claude-test", usage: { input_tokens: 3, output_tokens: 1 }, content: [] },
  }]);

  const report = await analyzeSessionHistory(linkedRoot, {
    provider: "claude",
    scope: "current-repo",
    sourceRoots: [sourceRoot],
    yes: true,
    noCache: true,
    now: new Date("2026-07-14T12:00:00.000Z"),
  });

  assert.equal(report.totals.sessions, 1);
  assert.equal(report.providers[0].project_probe_only_files, 0);
});

test("current-repo cache attribution invalidates when linked worktree membership changes", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-worktree-cache-"));
  const primaryRoot = path.join(tempRoot, "primary");
  const futureWorktree = path.join(tempRoot, "future-linked");
  const sourceRoot = path.join(tempRoot, "claude");
  const cachePath = path.join(tempRoot, "cache", "analysis.json");
  await initializeGitRepository(primaryRoot);
  await writeJsonl(path.join(sourceRoot, "future-session.jsonl"), [{
    type: "assistant",
    sessionId: "future-session",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: futureWorktree,
    message: { model: "claude-test", usage: { input_tokens: 4, output_tokens: 1 }, content: [] },
  }]);
  const options = {
    provider: "claude",
    scope: "current-repo",
    sourceRoots: [sourceRoot],
    cachePath,
    yes: true,
    now: new Date("2026-07-14T12:00:00.000Z"),
  };

  const before = await analyzeSessionHistory(primaryRoot, options);
  await execFileAsync("git", ["-C", primaryRoot, "worktree", "add", "-b", "feat/future", futureWorktree]);
  const after = await analyzeSessionHistory(primaryRoot, options);

  assert.equal(before.totals.sessions, 0);
  assert.deepEqual(before.coverage.cache, { hits: 0, misses: 1, writes: 1 });
  assert.equal(after.totals.sessions, 1);
  assert.deepEqual(after.coverage.cache, { hits: 0, misses: 1, writes: 1 });
});

test("cache signatures isolate current-repo and global path-normalization scopes", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-cache-scope-"));
  const projectRoot = path.join(tempRoot, "repo");
  const sourceRoot = path.join(tempRoot, "claude");
  const cachePath = path.join(tempRoot, "cache", "analysis.json");
  await fs.mkdir(projectRoot, { recursive: true });
  await writeJsonl(path.join(sourceRoot, "session.jsonl"), [{
    type: "assistant",
    sessionId: "scope-session",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: projectRoot,
    message: { model: "claude-test", usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
  }]);

  const shared = {
    provider: "claude",
    sourceRoots: [sourceRoot],
    cachePath,
    yes: true,
    now: new Date("2026-07-14T12:00:00.000Z"),
  };
  const current = await analyzeSessionHistory(projectRoot, { ...shared, scope: "current-repo" });
  const global = await analyzeSessionHistory(projectRoot, { ...shared, scope: "global" });

  assert.deepEqual(current.coverage.cache, { hits: 0, misses: 1, writes: 1 });
  assert.deepEqual(global.coverage.cache, { hits: 0, misses: 1, writes: 1 });
  assert.equal(global.sessions[0].project.alias, "Project 1");
});

test("new consent is persisted even when every session entry is a cache hit", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-consent-cache-"));
  const projectRoot = path.join(tempRoot, "repo");
  const homeDir = path.join(tempRoot, "home");
  const sourceRoot = path.join(homeDir, ".claude", "projects");
  const cachePath = path.join(tempRoot, "cache", "analysis.json");
  await fs.mkdir(projectRoot, { recursive: true });
  await writeJsonl(path.join(sourceRoot, "session.jsonl"), [{
    type: "assistant",
    sessionId: "consent-cache",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: projectRoot,
    message: { model: "claude-test", usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
  }]);

  const shared = {
    provider: "claude",
    scope: "global",
    homeDir,
    sourceRoots: [sourceRoot],
    cachePath,
    now: new Date("2026-07-14T12:00:00.000Z"),
  };
  await analyzeSessionHistory(projectRoot, { ...shared, yes: true });
  const configRun = await analyzeSessionHistory(projectRoot, { ...shared, includeConfig: true, yes: true });
  const repeatedConfigRun = await analyzeSessionHistory(projectRoot, { ...shared, includeConfig: true });

  assert.deepEqual(configRun.coverage.cache, { hits: 1, misses: 0, writes: 0 });
  assert.deepEqual(repeatedConfigRun.coverage.cache, { hits: 1, misses: 0, writes: 0 });
});

test("repeated and overlapping source roots do not double-count files or sessions", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-roots-"));
  const projectRoot = path.join(tempRoot, "repo");
  const sourceRoot = path.join(tempRoot, "claude");
  const nestedRoot = path.join(sourceRoot, "nested");
  await fs.mkdir(projectRoot, { recursive: true });
  await writeJsonl(path.join(nestedRoot, "session.jsonl"), [{
    type: "assistant",
    sessionId: "deduplicated-session",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: projectRoot,
    message: { model: "claude-test", usage: { input_tokens: 7, output_tokens: 2 }, content: [] },
  }]);

  const report = await analyzeSessionHistory(projectRoot, {
    provider: "claude",
    scope: "current-repo",
    sourceRoots: [sourceRoot, nestedRoot, sourceRoot],
    yes: true,
    noCache: true,
    now: new Date("2026-07-14T12:00:00.000Z"),
  });

  assert.equal(report.providers[0].files, 1);
  assert.equal(report.totals.sessions, 1);
  assert.equal(report.totals.usage.fresh_input_tokens, 7);
});

test("current-repo scope fully parses only sessions from known worktrees", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-project-boundary-"));
  const projectRoot = path.join(tempRoot, "repo");
  const unrelatedRoot = path.join(tempRoot, "unrelated");
  const sourceRoot = path.join(tempRoot, "claude");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(unrelatedRoot, { recursive: true });
  await writeJsonl(path.join(sourceRoot, "matching.jsonl"), [{
    type: "assistant",
    sessionId: "matching",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: projectRoot,
    message: { model: "claude-test", usage: { input_tokens: 2, output_tokens: 1 }, content: [] },
  }]);
  const unrelatedPath = path.join(sourceRoot, "unrelated.jsonl");
  await writeJsonl(unrelatedPath, [{
    type: "user",
    sessionId: "unrelated",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: unrelatedRoot,
    message: { content: "fix TOP-SECRET-UNRELATED prompt" },
  }]);
  await fs.appendFile(unrelatedPath, "malformed unrelated record that must never be parsed\n");

  const report = await analyzeSessionHistory(projectRoot, {
    provider: "claude",
    scope: "current-repo",
    contentMode: "local-extractive",
    sourceRoots: [sourceRoot],
    yes: true,
    noCache: true,
    now: new Date("2026-07-14T12:00:00.000Z"),
  });

  assert.equal(report.totals.sessions, 1);
  assert.equal(report.providers[0].files, 2);
  assert.equal(report.providers[0].records, 1);
  assert.equal(report.providers[0].malformed_records, 0);
  assert.equal(report.providers[0].project_probe_only_files, 1);
  assert.equal(report.privacy.unrelated_project_records_read, false);
  assert.doesNotMatch(JSON.stringify(report), /TOP-SECRET-UNRELATED/);
});

test("undated sessions remain in coverage but are excluded from every date window", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-undated-"));
  const projectRoot = path.join(tempRoot, "repo");
  const sourceRoot = path.join(tempRoot, "claude");
  await fs.mkdir(projectRoot, { recursive: true });
  await writeJsonl(path.join(sourceRoot, "session.jsonl"), [{
    type: "assistant",
    sessionId: "undated-session",
    cwd: projectRoot,
    message: { model: "claude-test", usage: { input_tokens: 99, output_tokens: 1 }, content: [] },
  }]);

  const report = await analyzeSessionHistory(projectRoot, {
    provider: "claude",
    scope: "current-repo",
    sourceRoots: [sourceRoot],
    yes: true,
    noCache: true,
    days: 1,
    now: new Date("2026-07-14T12:00:00.000Z"),
  });

  assert.equal(report.providers[0].files, 1);
  assert.equal(report.providers[0].sessions, 0);
  assert.equal(report.totals.sessions, 0);
  assert.equal(report.totals.usage.fresh_input_tokens, null);
});

test("opaque and unsupported shell calls cannot trigger an RTK recommendation", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-rtk-evidence-"));
  const projectRoot = path.join(tempRoot, "repo");
  const sourceRoot = path.join(tempRoot, "claude");
  await fs.mkdir(projectRoot, { recursive: true });
  await writeJsonl(path.join(sourceRoot, "session.jsonl"), [{
    type: "assistant",
    sessionId: "unsupported-shells",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: projectRoot,
    message: {
      model: "claude-test",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: ["node script.js", "python script.py", "make build"].map((command) => ({ type: "tool_use", name: "Bash", input: { command } })),
    },
  }]);

  const report = await analyzeSessionHistory(projectRoot, {
    provider: "claude",
    scope: "current-repo",
    sourceRoots: [sourceRoot],
    yes: true,
    noCache: true,
    now: new Date("2026-07-14T12:00:00.000Z"),
    toolInventory: { rtk: { available: true } },
  });

  assert.equal(report.workflow_patterns.shell_calls, 3);
  assert.equal(report.workflow_patterns.rtk_supported_calls, 0);
  assert.ok(!report.recommendations.some((item) => item.id === "use-rtk-for-supported-shells"));
});

test("focused test flags and paths are not counted as broad test runs", () => {
  const patterns = createToolFacts().patterns;
  for (const command of [
    "pytest -k focused",
    "pytest tests/test_app.py",
    "pnpm test --filter app",
    "pnpm test src/app.test.js",
    "node --test test/app.test.js",
    "cargo test module_name",
    "pnpm test",
  ]) {
    observeCommand(command, patterns);
  }

  assert.equal(patterns.test_calls, 7);
  assert.equal(patterns.broad_test_calls, 1);
});

test("recommendations expose measured evidence, a concrete action, verification, and caveat", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-recommendations-"));
  const projectRoot = path.join(tempRoot, "repo");
  const sourceRoot = path.join(tempRoot, "claude");
  await fs.mkdir(projectRoot, { recursive: true });
  await writeJsonl(path.join(sourceRoot, "session.jsonl"), [{
    type: "assistant",
    sessionId: "recommendation-session",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: projectRoot,
    message: {
      model: "claude-test",
      usage: { input_tokens: 5, output_tokens: 2 },
      content: [
        { type: "tool_use", id: "1", name: "Bash", input: { command: "grep -R needle ." } },
        { type: "tool_use", id: "2", name: "Bash", input: { command: "find . -name '*.js'" } },
        { type: "tool_use", id: "3", name: "Bash", input: { command: "cat src/app.js" } },
        { type: "tool_use", id: "4", name: "Bash", input: { command: "pnpm test" } },
      ],
    },
  }]);

  const report = await analyzeSessionHistory(projectRoot, {
    provider: "claude",
    scope: "current-repo",
    sourceRoots: [sourceRoot],
    yes: true,
    noCache: true,
    now: new Date("2026-07-14T12:00:00.000Z"),
    toolInventory: {
      rtk: { available: true, version: "0.20.0", gain: { total_commands: 100, total_saved: 25_000, avg_savings_pct: 31.5 } },
      rg: { available: true, version: "14.1.0" },
      agentify: { available: true, index_fresh: false },
    },
  });

  const rtk = report.recommendations.find((item) => item.id === "use-rtk-for-supported-shells");
  assert.equal(rtk.impact.provenance, "measured");
  assert.equal(rtk.observed.unwrapped_supported_calls, 3);
  assert.equal(rtk.observed.supported_shell_calls, 3);
  assert.match(rtk.suggestion.command, /^rtk /);
  assert.match(rtk.verification, /rtk gain/);
  assert.ok(rtk.caveat);

  const search = report.recommendations.find((item) => item.id === "prefer-focused-search-tools");
  assert.deepEqual(search.observed, { grep_calls: 1, find_calls: 1, cat_calls: 1 });
  assert.equal(search.impact.provenance, "expected");
  assert.ok(report.suppressed_recommendations.some((item) => item.id === "select-focused-tests"));
  assert.doesNotMatch(JSON.stringify(report), /needle|src\/app\.js|\*\.js/);
});

test("HTML output is a self-contained Agentify report with progressive, accessible offline filtering", async () => {
  const report = {
    schema_version: "session-analysis-v1",
    command: "analyze",
    generated_at: "2026-07-14T12:00:00.000Z",
    window_days: 30,
    scope: "global",
    content_mode: "metadata-only",
    dry_run: false,
    providers: [{ provider: "claude", files: 1, bytes: 100, sessions: 1, records: 2, malformed_records: 0, sidechain_records_deduplicated: 0 }],
    totals: {
      sessions: 1,
      active_duration_ms: 60_000,
      usage: { fresh_input_tokens: 10, cache_read_tokens: 5, cache_write_tokens: 2, output_tokens: 3, reasoning_output_tokens: null },
      reported_cost_usd: null,
      estimated_cost_usd: null,
      tool_calls: 1,
      file_access_events: 1,
    },
    sessions: [{
      provider: "claude",
      session_id: "0123456789abcdef",
      started_at: "2026-07-14T11:00:00.000Z",
      ended_at: "2026-07-14T11:01:00.000Z",
      duration_ms: 60_000,
      project: { scope: "global", alias: "Project <script>", branch: null },
      models: ["model <unsafe>"],
      usage: { fresh_input_tokens: 10, cache_read_tokens: 5, cache_write_tokens: 2, output_tokens: 3, reasoning_output_tokens: null },
      cost: { reported_usd: null, estimated_usd: null, basis: "unavailable", coverage: 0 },
      tools: { calls: 1, by_name: { Read: 1 }, patterns: {} },
      file_access: [{ path: "src/<unsafe>.js", operation: "read", source: "structured-tool", confidence: "high", events: 1 }],
      task: { category: "research", confidence: 0.5, content_mode: "metadata-only" },
      outcome: { status: "unknown", evidence: [] },
      opportunities: [],
      parser: { name: "claude-jsonl", version: 1, cli_version: "1.0" },
    }],
    recommendations: [{
      schema: "recommendation-v1",
      id: "prefer-focused-search-tools",
      category: "search",
      observed: { grep_calls: 3 },
      suggestion: { capability: "focused search", command: "rg <pattern>" },
      rationale: "Repeated scans produced avoidable output.",
      impact: { provenance: "expected", summary: "Expected lower output." },
      confidence: "medium",
      verification: "Compare one repeated query.",
      caveat: "No historical replay was performed.",
    }],
    suppressed_recommendations: [{ id: "select-focused-tests", reason: "no broad tests" }],
    workflow_patterns: {},
    capabilities: {},
    config_audit: null,
    insights: { mode: "deterministic", providers: [], spend_usd: 0, packet_sent: false },
    coverage: { cache: { hits: 0, misses: 1, writes: 1 }, ratios: { model: 1, cost: 0, file_access: 1, tokens: { fresh_input_tokens: 1 } } },
    privacy: {
      record_bodies_read: true,
      uploads: false,
      provider_processes_started: false,
      raw_transcript_retained: false,
      command_bodies_retained: false,
      source_roots: [{ provider: "claude", category: "session-jsonl" }],
    },
  };

  const html = renderAnalysisHtml(report);
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /data-testid="session-analysis-report"/);
  assert.match(html, /A G E N T I F Y|AGENTIFY/);
  assert.match(html, /<a class="skip-link" href="#main-content">/);
  assert.match(html, /<caption>Analyzed sessions<\/caption>/);
  assert.match(html, /<details/);
  assert.match(html, /id="provider-filter"/);
  assert.match(html, /id="task-filter"/);
  assert.match(html, /id="confidence-filter"/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /@media print/);
  assert.match(html, /addEventListener/);
  assert.doesNotMatch(html, /<script>Project|<unsafe>|https?:\/\//);
  assert.match(html, /Project &lt;script&gt;/);
  assert.match(html, /Why this helps/);
  assert.match(html, /Privacy receipt/);
  assert.match(renderAnalysisText(report), /Cost: unavailable/);

  const reasoningReport = structuredClone(report);
  reasoningReport.sessions[0].usage.reasoning_output_tokens = 99;
  assert.match(renderAnalysisHtml(reasoningReport), /data-tokens="20"/);
  const unknownReport = structuredClone(report);
  unknownReport.sessions[0].usage = {
    fresh_input_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
  };
  const unknownHtml = renderAnalysisHtml(unknownReport);
  assert.match(unknownHtml, /data-tokens="-1"/);
  assert.match(unknownHtml, /<td class="number">—<\/td>/);
});

test("global config audit reads only allowlisted shapes and emits no instruction or secret content", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-config-"));
  const homeDir = path.join(tempRoot, "home");
  await fs.mkdir(path.join(homeDir, ".claude", "skills", "one"), { recursive: true });
  await fs.mkdir(path.join(homeDir, ".codex", "plugins", "one"), { recursive: true });
  await fs.mkdir(path.join(homeDir, ".claude", "projects"), { recursive: true });
  await fs.mkdir(path.join(homeDir, ".codex", "sessions"), { recursive: true });
  await fs.writeFile(path.join(homeDir, ".claude", "CLAUDE.md"), "Always run focused tests.\nNever expose TOP-SECRET-INSTRUCTION.\nAlways run focused tests.\n");
  await fs.writeFile(path.join(homeDir, ".codex", "AGENTS.md"), "Always run focused tests.\n");
  await fs.writeFile(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
    model: "claude-test",
    hooks: { PreToolUse: [{ command: "private-command" }] },
    API_KEY: "sk-config-secret",
  }));
  await fs.writeFile(path.join(homeDir, ".codex", "config.toml"), "model = \"codex-test\"\nauth_token = \"secret-token\"\n[features]\nmulti_agent = true\n");
  await fs.writeFile(path.join(homeDir, ".codex", "auth.json"), "{\"token\":\"must-never-be-read\"}");

  const report = await analyzeSessionHistory(path.join(tempRoot, "repo"), {
    provider: "all",
    scope: "global",
    includeConfig: true,
    homeDir,
    yes: true,
    noCache: true,
    noProgress: true,
  });

  assert.equal(report.config_audit.instructions.files, 2);
  assert.equal(report.config_audit.instructions.duplicate_rules, 1);
  assert.ok(report.config_audit.instructions.estimated_tokens > 0);
  assert.deepEqual(report.config_audit.providers.claude.settings_keys, ["hooks", "model"]);
  assert.deepEqual(report.config_audit.providers.codex.settings_keys, ["features.multi_agent", "model"]);
  assert.equal(report.config_audit.providers.claude.secret_keys_excluded, 1);
  assert.equal(report.config_audit.providers.codex.secret_keys_excluded, 1);
  assert.equal(report.config_audit.providers.claude.integrations.skills, 1);
  assert.equal(report.config_audit.providers.codex.integrations.plugins, 1);
  assert.ok(report.config_audit.excluded_categories.includes("auth and credential files"));

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /TOP-SECRET|private-command|sk-config-secret|secret-token|must-never-be-read/);
  assert.doesNotMatch(serialized, new RegExp(homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const html = renderAnalysisHtml(report);
  assert.match(html, /Global configuration audit/);
  assert.match(html, /Duplicate rules<\/dt><dd>1/);
  assert.doesNotMatch(html, /TOP-SECRET|private-command|sk-config-secret|secret-token|must-never-be-read/);
});

test("tool inventory records read-only capabilities and measured RTK counters without starting provider CLIs", async () => {
  const calls = [];
  const available = new Set(["rtk", "rg", "agentify", "git", "claude", "codex"]);
  const execFile = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "which") {
      if (!available.has(args[0])) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return { stdout: `/usr/local/bin/${args[0]}\n`, stderr: "" };
    }
    if (command === "rtk" && args[0] === "gain") {
      return { stdout: JSON.stringify({ summary: { total_commands: 42, total_saved: 9000, avg_savings_pct: 30.25 } }), stderr: "" };
    }
    return { stdout: `${command} version 1.2.3\n`, stderr: "" };
  };

  const inventory = await collectToolInventory("/tmp/repo", { execFile, indexStatus: "warm" });

  assert.deepEqual(inventory.rtk.gain, { total_commands: 42, total_saved: 9000, avg_savings_pct: 30.25 });
  assert.equal(inventory.rg.available, true);
  assert.equal(inventory.agentify.index_fresh, true);
  assert.equal(inventory.providers.claude.available, true);
  assert.equal(inventory.providers.codex.available, true);
  assert.ok(calls.some((call) => call.join(" ") === "rtk gain --format json"));
  assert.ok(calls.some((call) => call.join(" ") === "which claude"));
  assert.ok(!calls.some((call) => call[0] === "claude" || call[0] === "codex"));
});

test("CLI insight dry-run exposes one sanitized packet and fails closed for Codex execution", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-insights-"));
  const homeDir = path.join(tempRoot, "home");
  await fs.mkdir(path.join(homeDir, ".claude", "projects"), { recursive: true });
  await fs.mkdir(path.join(homeDir, ".codex", "sessions"), { recursive: true });
  const inventory = {
    rtk: { available: true, gain: { total_commands: 10, total_saved: 500, avg_savings_pct: 20 } },
    rg: { available: true },
    agentify: { available: true, index_fresh: false },
    providers: { claude: { available: true }, codex: { available: true } },
  };

  const dryRun = await analyzeSessionHistory(path.join(tempRoot, "repo"), {
    provider: "all",
    scope: "global",
    homeDir,
    yes: true,
    noCache: true,
    toolInventory: inventory,
    insights: "cli",
    insightsProvider: "both",
    insightsDryRun: true,
    maxInsightsBudgetUsd: 0.5,
  });

  assert.equal(dryRun.insights.mode, "cli");
  assert.equal(dryRun.insights.dry_run, true);
  assert.equal(dryRun.insights.packet.schema_version, "insight-packet-v1");
  assert.equal(dryRun.insights.packet_sent, false);
  assert.equal(dryRun.insights.plans.length, 2);
  assert.equal(dryRun.insights.plans.find((plan) => plan.provider === "claude").enforceable, true);
  assert.equal(dryRun.insights.plans.find((plan) => plan.provider === "codex").enforceable, false);
  assert.deepEqual(dryRun.insights.packet, dryRun.insights.plans[0].packet);
  assert.deepEqual(dryRun.insights.packet, dryRun.insights.plans[1].packet);
  assert.equal(dryRun.privacy.provider_processes_started, false);

  await assert.rejects(
    analyzeSessionHistory(path.join(tempRoot, "repo"), {
      provider: "all",
      scope: "global",
      homeDir,
      yes: true,
      noCache: true,
      toolInventory: inventory,
      insights: "cli",
      insightsProvider: "codex",
      maxInsightsBudgetUsd: 0.5,
      runClaude: async () => { throw new Error("must not run"); },
    }),
    /Codex.*cannot enforce.*spend ceiling.*tool-free/i,
  );
});

test("CLI insight commands reject multiline, proxy, executable search, and destructive find forms", () => {
  assert.equal(isSafeInsightCommand("rtk git status"), true);
  assert.equal(isSafeInsightCommand("agentify risk --since HEAD~1"), true);
  assert.equal(isSafeInsightCommand("rg needle src"), true);
  assert.equal(isSafeInsightCommand("rg foo\nrm -rf /"), false);
  assert.equal(isSafeInsightCommand("rtk proxy rm -rf /"), false);
  assert.equal(isSafeInsightCommand("rg --pre 'rm -rf /' needle"), false);
  assert.equal(isSafeInsightCommand("rtk find . -delete"), false);
  assert.equal(isSafeInsightCommand("rtk find . -fprint /tmp/result"), false);
  assert.equal(isSafeInsightCommand("agentify test --since HEAD --run"), false);
  assert.equal(isSafeInsightCommand("agentify value --format html"), false);
  assert.equal(isSafeInsightCommand("agentify value --output report.json"), false);
  assert.equal(isSafeInsightCommand("agentify test --since HEAD"), true);
  assert.equal(isSafeInsightCommand("agentify value --format text"), true);
  assert.equal(isSafeInsightCommand("agentify uninstall"), false);
});

test("Claude insight mode uses a tool-free ephemeral capped invocation and records its own spend", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-claude-insights-"));
  const homeDir = path.join(tempRoot, "home");
  await writeJsonl(path.join(homeDir, ".claude", "projects", "session.jsonl"), [{
    type: "assistant",
    sessionId: "insight-evidence",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: path.join(tempRoot, "repo"),
    message: {
      model: "claude-test",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: ["git status", "git diff", "git log"].map((command, index) => ({
        type: "tool_use",
        id: `shell-${index}`,
        name: "Bash",
        input: { command },
      })),
    },
  }]);
  const requests = [];
  const report = await analyzeSessionHistory(path.join(tempRoot, "repo"), {
    provider: "claude",
    scope: "global",
    homeDir,
    yes: true,
    noCache: true,
    toolInventory: {
      rtk: { available: true },
      rg: { available: false },
      agentify: { available: true, index_fresh: false },
      providers: { claude: { available: true }, codex: { available: false } },
    },
    insights: "cli",
    insightsProvider: "claude",
    maxInsightsBudgetUsd: 0.5,
    runClaude: async (request) => {
      requests.push(request);
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          result: JSON.stringify({ recommendations: [{
            title: "CLI-assisted RTK review",
            category: "shell",
            evidence_ids: ["use-rtk-for-supported-shells"],
            rationale: "Three unwrapped supported shell calls were observed.",
            command: "rtk git status",
            confidence: "medium",
            caveat: "Validate the measured output reduction locally.",
          }] }),
          total_cost_usd: 0.0123,
          usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 },
          modelUsage: { "claude-test-model": {} },
        }),
        stderr: "",
        code: 0,
      };
    },
  });

  assert.equal(requests.length, 1);
  const argv = requests[0].argv;
  assert.ok(argv.includes("--no-session-persistence"));
  assert.ok(argv.includes("--safe-mode"));
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.equal(argv[argv.indexOf("--max-budget-usd") + 1], "0.5");
  assert.equal(argv[argv.indexOf("--tools") + 1], "");
  assert.ok(!argv.some((value) => /dangerously|bypass/i.test(value)));
  assert.match(requests[0].input, /<normalized_evidence_packet>/);
  assert.doesNotMatch(requests[0].input, new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(report.insights.spend_usd, 0.0123);
  assert.equal(report.insights.model, "claude-test-model");
  assert.equal(report.insights.recommendations.length, 1);
  assert.equal(report.privacy.provider_processes_started, true);
  assert.equal(report.privacy.uploads, true);
  assert.match(renderAnalysisHtml(report), /CLI-assisted RTK review/);
  assert.match(renderAnalysisHtml(report), /sanitized insight packet sent/);
  assert.doesNotMatch(renderAnalysisHtml(report), />no uploads</);
  assert.match(renderAnalysisText(report), /CLI-assisted RTK review/);
  assert.match(renderAnalysisText(report), /sanitized evidence packet was sent/);
});

test("Claude insight mode rejects recommendations grounded only in a suppressed rule", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-suppressed-insight-"));
  const homeDir = path.join(tempRoot, "home");
  await fs.mkdir(path.join(homeDir, ".claude", "projects"), { recursive: true });

  await assert.rejects(analyzeSessionHistory(path.join(tempRoot, "repo"), {
    provider: "claude",
    scope: "global",
    homeDir,
    yes: true,
    noCache: true,
    toolInventory: {
      rtk: { available: false },
      rg: { available: false },
      agentify: { available: true, index_fresh: false },
      providers: { claude: { available: true }, codex: { available: false } },
    },
    insights: "cli",
    insightsProvider: "claude",
    maxInsightsBudgetUsd: 0.5,
    runClaude: async () => ({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        result: JSON.stringify({ recommendations: [{
          title: "Unsupported context advice",
          category: "context",
          evidence_ids: ["reuse-repository-context"],
          rationale: "No qualifying evidence exists.",
          command: "agentify ctx status",
          confidence: "low",
          caveat: "This must be rejected.",
        }] }),
        total_cost_usd: 0.01,
        usage: {},
        modelUsage: { "claude-test-model": {} },
      }),
      stderr: "",
      code: 0,
    }),
  }), /unsupported command or evidence reference/);
});

test("insight process timeout waits for close and escalates when SIGTERM is ignored", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runInsightProcess(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    ], "", { timeoutSeconds: 1 }),
    /timed out and was terminated/,
  );
  assert.ok(Date.now() - startedAt < 4_000);
});

test("agentify analyze CLI emits clean JSON and writes a private self-contained HTML report", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-cli-"));
  const projectRoot = path.join(tempRoot, "repo");
  const sourceRoot = path.join(tempRoot, "claude");
  const htmlPath = path.join(tempRoot, "shared-analysis.html");
  await fs.mkdir(projectRoot, { recursive: true });
  await writeJsonl(path.join(sourceRoot, "session.jsonl"), [{
    type: "assistant",
    sessionId: "cli-session",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: projectRoot,
    message: { model: "claude-test", usage: { input_tokens: 4, output_tokens: 1 }, content: [] },
  }]);
  const runtime = {
    toolInventory: {
      rtk: { available: false },
      rg: { available: true },
      agentify: { available: true, index_fresh: false },
      providers: { claude: { available: true }, codex: { available: false } },
    },
  };

  const output = await captureConsoleLog(() => runCli([
    "analyze",
    "--root", projectRoot,
    "--provider", "claude",
    "--scope", "current-repo",
    "--source-root", sourceRoot,
    "--format", "json",
    "--yes",
    "--no-cache",
    "--no-progress",
  ], runtime));
  const parsed = JSON.parse(output);
  assert.equal(parsed.command, "analyze");
  assert.equal(parsed.totals.sessions, 1);

  await runCli([
    "analyze",
    "--root", projectRoot,
    "--provider", "claude",
    "--scope", "current-repo",
    "--source-root", sourceRoot,
    "--format", "html",
    "--output", htmlPath,
    "--yes",
    "--no-cache",
    "--no-progress",
  ], runtime);
  const html = await fs.readFile(htmlPath, "utf8");
  assert.match(html, /data-testid="session-analysis-report"/);
  if (process.platform !== "win32") assert.equal((await fs.stat(htmlPath)).mode & 0o777, 0o600);

  const dryRunPath = path.join(tempRoot, "must-not-exist.html");
  await runCli([
    "analyze",
    "--root", projectRoot,
    "--provider", "claude",
    "--scope", "current-repo",
    "--source-root", sourceRoot,
    "--format", "html",
    "--output", dryRunPath,
    "--dry-run",
    "--no-progress",
  ], runtime);
  await assert.rejects(fs.stat(dryRunPath), { code: "ENOENT" });
});

test("global projects stay pseudonymous unless display-only name or path opt-ins are explicit", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-project-alias-"));
  const homeDir = path.join(tempRoot, "home");
  const sourceRoot = path.join(homeDir, ".claude", "projects");
  const alpha = path.join(tempRoot, "work", "alpha-private");
  await fs.mkdir(alpha, { recursive: true });
  await writeJsonl(path.join(sourceRoot, "session.jsonl"), [{
    type: "assistant",
    sessionId: "alias-session",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: alpha,
    message: {
      model: "claude-test",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{
        type: "tool_use",
        name: "Read",
        input: { file_path: path.join(alpha, "src", "private-module.js") },
      }],
    },
  }]);

  const baseOptions = {
    provider: "claude",
    scope: "global",
    homeDir,
    yes: true,
    noCache: true,
    toolInventory: {},
    now: new Date("2026-07-14T12:00:00.000Z"),
  };
  const privateReport = await analyzeSessionHistory(path.join(tempRoot, "repo"), baseOptions);
  const namedReport = await analyzeSessionHistory(path.join(tempRoot, "repo"), { ...baseOptions, showProjectNames: true });
  const pathReport = await analyzeSessionHistory(path.join(tempRoot, "repo"), { ...baseOptions, showPaths: true });

  assert.equal(privateReport.sessions[0].project.alias, "Project 1");
  assert.equal(privateReport.sessions[0].project.branch, null);
  assert.equal(privateReport.sessions[0].file_access[0].path, "File 1");
  assert.equal(namedReport.sessions[0].project.alias, "alpha-private");
  assert.equal(pathReport.sessions[0].project.alias, alpha);
  assert.equal(pathReport.sessions[0].file_access[0].path, "src/private-module.js");
  assert.deepEqual(pathReport.privacy.source_roots, [{
    provider: "claude",
    category: "session-jsonl",
    display_path: "~/.claude/projects",
  }]);
  assert.doesNotMatch(JSON.stringify(privateReport), /alpha-private/);
  assert.doesNotMatch(JSON.stringify(privateReport), /private-module/);
});

test("unreadable session files are skipped with explicit coverage instead of failing the scan", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX file modes are required");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-unreadable-"));
  const projectRoot = path.join(tempRoot, "repo");
  const sourceRoot = path.join(tempRoot, "claude");
  const unreadable = path.join(sourceRoot, "unreadable.jsonl");
  await fs.mkdir(projectRoot, { recursive: true });
  await writeJsonl(path.join(sourceRoot, "readable.jsonl"), [{
    type: "assistant",
    sessionId: "readable",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: projectRoot,
    message: { model: "claude-test", usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
  }]);
  await writeJsonl(unreadable, [{
    type: "assistant",
    sessionId: "unreadable",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: projectRoot,
    message: { model: "claude-test", usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
  }]);
  await fs.chmod(unreadable, 0o000);
  t.after(() => fs.chmod(unreadable, 0o600).catch(() => {}));

  const report = await analyzeSessionHistory(projectRoot, {
    provider: "claude",
    scope: "current-repo",
    sourceRoots: [sourceRoot],
    yes: true,
    noCache: true,
    toolInventory: {},
    now: new Date("2026-07-14T12:00:00.000Z"),
  });

  assert.equal(report.totals.sessions, 1);
  assert.equal(report.providers[0].files, 2);
  assert.equal(report.providers[0].skipped_files, 1);
  assert.equal(report.providers[0].unreadable_files, 1);
});

test("current-repo scope recognizes sessions created from a sibling git worktree", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-worktree-"));
  const primary = path.join(tempRoot, "primary");
  const sibling = path.join(tempRoot, "sibling");
  const sourceRoot = path.join(tempRoot, "claude");
  await fs.mkdir(primary, { recursive: true });
  await execFileAsync("git", ["init", "-q", primary]);
  await execFileAsync("git", ["-C", primary, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", primary, "config", "user.name", "Test User"]);
  await fs.writeFile(path.join(primary, "README.md"), "test\n");
  await execFileAsync("git", ["-C", primary, "add", "README.md"]);
  await execFileAsync("git", ["-C", primary, "commit", "-qm", "initial"]);
  await execFileAsync("git", ["-C", primary, "worktree", "add", "-qb", "feat/sibling", sibling]);
  await writeJsonl(path.join(sourceRoot, "session.jsonl"), [{
    type: "assistant",
    sessionId: "worktree-session",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: sibling,
    message: { model: "claude-test", usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
  }]);

  const report = await analyzeSessionHistory(primary, {
    provider: "claude",
    scope: "current-repo",
    sourceRoots: [sourceRoot],
    yes: true,
    noCache: true,
    toolInventory: {},
    now: new Date("2026-07-14T12:00:00.000Z"),
  });

  assert.equal(report.totals.sessions, 1);
  assert.equal(report.sessions[0].project.alias, "primary");
});

test("Codex patch headers are attributed without evaluating nested wrapper or shell content", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-codex-paths-"));
  const projectRoot = path.join(tempRoot, "repo");
  const sourceRoot = path.join(tempRoot, "codex");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await writeJsonl(path.join(sourceRoot, "session.jsonl"), [
    { timestamp: "2026-07-14T08:00:00.000Z", type: "session_meta", payload: { id: "codex-paths", cwd: projectRoot } },
    {
      timestamp: "2026-07-14T08:01:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "apply_patch",
        arguments: "*** Begin Patch\n*** Update File: src/app.js\n@@\n-old\n+new\n*** End Patch",
      },
    },
    {
      timestamp: "2026-07-14T08:02:00.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "functions.exec",
        input: "const secret = await tools.exec_command({cmd: 'cat /private/should-not-attribute'});",
      },
    },
  ]);

  const report = await analyzeSessionHistory(projectRoot, {
    provider: "codex",
    scope: "current-repo",
    sourceRoots: [sourceRoot],
    yes: true,
    noCache: true,
    toolInventory: {},
    now: new Date("2026-07-14T12:00:00.000Z"),
  });

  assert.deepEqual(report.sessions[0].file_access, [{
    path: "src/app.js",
    operation: "write",
    source: "patch-header",
    confidence: "high",
    events: 1,
  }]);
  assert.equal(report.sessions[0].tools.patterns.opaque_shell_calls, 1);
  assert.doesNotMatch(JSON.stringify(report), /should-not-attribute|\/private\//);
});
