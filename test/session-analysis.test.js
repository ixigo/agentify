import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildAnalysisManifest, buildSessionAnalysis, resolveAnalyzeProviders } from "../src/core/session-analysis/index.js";
import { renderAnalysisHtml, renderAnalysisText } from "../src/core/session-analysis/report.js";
import { classifyShellCommand, normalizeFilePath } from "../src/core/session-analysis/normalize.js";
import { runCli } from "../src/main.js";

const SECRET_COMMAND = "export API_KEY=supersecret123 && curl -s https://internal.example.com";
const SECRET_PROMPT = "MY SUPER SECRET PROMPT about the acquisition";

async function makeRoot(prefix = "agentify-analyze-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function minutesAgo(offset) {
  return new Date(Date.now() - offset * 60_000).toISOString();
}

function claudeAssistant({ ts, requestId, model = "claude-fable-5", usage, content = [], cwd, sidechain = false }) {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    requestId,
    cwd,
    gitBranch: "main",
    version: "2.1.0",
    isSidechain: sidechain,
    sessionId: "fixture",
    message: { id: `msg_${requestId}`, model, usage, content },
  });
}

function claudeUser({ ts, cwd, content = [] }) {
  return JSON.stringify({ type: "user", timestamp: ts, cwd, isSidechain: false, message: { role: "user", content } });
}

const USAGE = { input_tokens: 2, cache_creation_input_tokens: 500, cache_read_input_tokens: 40_000, output_tokens: 150 };

async function writeClaudeFixtures(claudeRoot, repoRoot) {
  const projectDir = path.join(claudeRoot, "-fixture-project");
  await fs.mkdir(projectDir, { recursive: true });

  const readTool = (id, filePath) => ({ type: "tool_use", id, name: "Read", input: { file_path: filePath } });
  const bashTool = (id, command) => ({ type: "tool_use", id, name: "Bash", input: { command } });

  // Session 1: duplicated streamed usage, grep storm, one command failing twice.
  const s1 = [
    claudeUser({ ts: minutesAgo(200), cwd: repoRoot, content: [{ type: "text", text: SECRET_PROMPT }] }),
    claudeAssistant({
      ts: minutesAgo(199), requestId: "req_1", usage: USAGE, cwd: repoRoot,
      content: [
        readTool("t_read1", path.join(repoRoot, "src/core/models.js")),
        readTool("t_read2", path.join(repoRoot, "src/app.js")),
        readTool("t_readx", path.join(repoRoot, "src/<script>evil.js")),
        ...Array.from({ length: 10 }, (_, index) => bashTool(`t_grep${index}`, `grep -rn "needle${index}" .`)),
        bashTool("t_fail1", SECRET_COMMAND),
        bashTool("t_fail2", SECRET_COMMAND),
      ],
    }),
    // The same request streamed again: usage must not be double counted.
    claudeAssistant({ ts: minutesAgo(198), requestId: "req_1", usage: USAGE, cwd: repoRoot }),
    claudeAssistant({ ts: minutesAgo(197), requestId: "req_2", usage: USAGE, cwd: repoRoot, sidechain: true }),
    claudeUser({
      ts: minutesAgo(196), cwd: repoRoot,
      content: [
        { type: "tool_result", tool_use_id: "t_fail1", is_error: true, content: "boom" },
        { type: "tool_result", tool_use_id: "t_fail2", is_error: true, content: "boom again" },
      ],
    }),
    "{not json",
  ];
  await fs.writeFile(path.join(projectDir, "s1.jsonl"), `${s1.join("\n")}\n`);

  // Sessions 2 and 3 re-read the same two files so the reread rule can fire.
  for (const [index, name] of [["2", "s2"], ["3", "s3"]]) {
    const lines = [
      claudeAssistant({
        ts: minutesAgo(150 - Number(index)), requestId: `req_${name}`, usage: USAGE, cwd: repoRoot,
        content: [
          readTool(`t_${name}_a`, path.join(repoRoot, "src/core/models.js")),
          readTool(`t_${name}_b`, path.join(repoRoot, "src/app.js")),
        ],
      }),
    ];
    await fs.writeFile(path.join(projectDir, `${name}.jsonl`), `${lines.join("\n")}\n`);
  }

  // A session from another repository: excluded in current-repo scope.
  const foreign = [
    claudeAssistant({ ts: minutesAgo(100), requestId: "req_f", usage: USAGE, cwd: "/somewhere/else" }),
  ];
  await fs.writeFile(path.join(projectDir, "foreign.jsonl"), `${foreign.join("\n")}\n`);
}

async function writeCodexFixtures(codexRoot, repoRoot) {
  const dayDir = path.join(codexRoot, "2026", "07", "14");
  await fs.mkdir(dayDir, { recursive: true });
  const inScope = [
    JSON.stringify({ timestamp: minutesAgo(90), type: "session_meta", payload: { cwd: repoRoot, id: "cx1", cli_version: "0.105.0", git: { branch: "main" } } }),
    JSON.stringify({ timestamp: minutesAgo(89), type: "turn_context", payload: { model: "gpt-5.2-codex", cwd: repoRoot } }),
    JSON.stringify({ timestamp: minutesAgo(88), type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: 'grep -rn "handler" src' }) } }),
    // Cumulative snapshots: the last one is the session total.
    JSON.stringify({ timestamp: minutesAgo(87), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 300, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 520 } } } }),
    JSON.stringify({ timestamp: minutesAgo(86), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1250 } } } }),
  ];
  await fs.writeFile(path.join(dayDir, "rollout-2026-07-14-cx1.jsonl"), `${inScope.join("\n")}\n`);

  const outOfScope = [
    JSON.stringify({ timestamp: minutesAgo(80), type: "session_meta", payload: { cwd: "/another/project", id: "cx2", cli_version: "0.105.0" } }),
    JSON.stringify({ timestamp: minutesAgo(79), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 15 } } } }),
  ];
  await fs.writeFile(path.join(dayDir, "rollout-2026-07-14-cx2.jsonl"), `${outOfScope.join("\n")}\n`);
}

async function fixtureReport(overrides = {}) {
  const repoRoot = await makeRoot("agentify-analyze-repo-");
  const claudeRoot = path.join(repoRoot, "history", "claude");
  const codexRoot = path.join(repoRoot, "history", "codex");
  await writeClaudeFixtures(claudeRoot, repoRoot);
  await writeCodexFixtures(codexRoot, repoRoot);
  const report = await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot, days: 30, ...overrides });
  return { repoRoot, claudeRoot, codexRoot, report };
}

test("resolveAnalyzeProviders validates provider selection", () => {
  assert.deepEqual(resolveAnalyzeProviders("all"), ["claude", "codex"]);
  assert.deepEqual(resolveAnalyzeProviders("codex"), ["codex"]);
  assert.throws(() => resolveAnalyzeProviders("gemini"), /must be one of/);
});

test("shell classification counts patterns without keeping command text", () => {
  assert.deepEqual(classifyShellCommand('grep -rn "foo" .').kinds, ["grep_like"]);
  assert.deepEqual(classifyShellCommand("rg foo").kinds, []);
  assert.deepEqual(classifyShellCommand("npm test").kinds, ["full_test_run"]);
  assert.deepEqual(classifyShellCommand("node --test test/foo.test.js").kinds, ["focused_test_run"]);
});

test("file paths render repo-relative and never leak external absolute paths", () => {
  assert.deepEqual(normalizeFilePath("/repo/src/a.js", "/repo"), { path: "src/a.js", in_repo: true });
  assert.deepEqual(normalizeFilePath("/etc/passwd", "/repo"), { path: "(outside repository)", in_repo: false });
});

test("claude usage is deduplicated per request and codex snapshots use the last cumulative value", async () => {
  const { report } = await fixtureReport();
  // 3 claude in-scope sessions × distinct requests + codex fresh input.
  // s1 has req_1 (duplicated stream, counted once) and req_2: 2 requests.
  // s2 and s3 have one request each -> 4 claude requests × 2 fresh tokens = 8.
  // codex fresh = 1200 - 800 = 400 from the LAST snapshot only.
  assert.equal(report.totals.sessions, 4);
  assert.equal(report.totals.usage.fresh_input_tokens, 8 + 400);
  assert.equal(report.totals.usage.cache_read_tokens, 4 * 40_000 + 800);
  assert.equal(report.totals.usage.output_tokens, 4 * 150 + 50);
  assert.equal(report.totals.usage.reasoning_output_tokens, 10);
  const codexSource = report.sources.find((source) => source.provider === "codex");
  assert.equal(codexSource.files_out_of_scope, 1);
  const claudeSource = report.sources.find((source) => source.provider === "claude");
  assert.equal(claudeSource.files_out_of_scope, 1);
  assert.equal(claudeSource.malformed_lines, 1);
});

test("patterns, opportunities, and suppressed rules are evidence-backed", async () => {
  const { report } = await fixtureReport();
  assert.equal(report.patterns.grep_like, 11);
  assert.equal(report.patterns.repeated_failed_commands.fingerprints, 1);
  assert.equal(report.patterns.repeated_failed_commands.max_repeats, 2);
  assert.equal(report.patterns.files_reread_across_sessions.count, 2);
  assert.equal(report.patterns.sidechain_events, 1);

  const firedIds = report.opportunities.map((item) => item.id);
  assert.ok(firedIds.includes("failed-command-repeats"));
  assert.ok(firedIds.includes("broad-text-search"));
  assert.ok(firedIds.includes("repeated-file-rereads"));
  for (const item of report.opportunities) {
    assert.equal(item.schema, "recommendation-v1");
    assert.ok(item.suggestion.command.length > 0);
    assert.ok(item.caveat.length > 0);
    assert.ok(item.verification.length > 0);
    assert.equal(item.impact, "unavailable");
  }
  const suppressedIds = report.suppressed_rules.map((rule) => rule.id);
  assert.ok(suppressedIds.includes("full-test-suite-after-narrow-changes"));
  for (const rule of report.suppressed_rules) {
    assert.ok(rule.reason.length > 0);
  }
});

test("the roast is deterministic, witty, and grounded in the loudest signal", async () => {
  const { report } = await fixtureReport();
  const { report: again } = await fixtureReport();
  assert.equal(report.roast.text, again.roast.text);
  assert.match(report.roast.text, /ctx precheck/);
  assert.match(report.roast.basis, /repeated_failed_commands/);
});

test("no prompt, command, or secret content survives into any output format", async () => {
  const { report } = await fixtureReport();
  const json = JSON.stringify(report);
  const html = renderAnalysisHtml(report, { projectName: "fixture" });
  const text = renderAnalysisText(report);
  for (const output of [json, html, text]) {
    assert.ok(!output.includes("supersecret123"), "secret env value leaked");
    assert.ok(!output.includes("SUPER SECRET"), "prompt text leaked");
    assert.ok(!output.includes("internal.example.com"), "command text leaked");
    assert.ok(!output.includes("needle0"), "search command text leaked");
  }
});

test("html report is self-contained, escaped, and carries the roast and privacy receipt", async () => {
  const { report } = await fixtureReport();
  const html = renderAnalysisHtml(report, { projectName: "fixture" });
  assert.ok(html.includes('data-testid="agentify-analyze-report"'));
  assert.ok(html.includes('data-testid="analyze-roast"'));
  assert.ok(html.includes("Privacy receipt"));
  assert.ok(html.includes("Where Agentify helps"));
  assert.ok(!/src=["']https?:/.test(html), "external asset reference found");
  assert.ok(!html.includes("<script"), "script tag present in report");
  assert.ok(html.includes("&lt;script&gt;evil.js"), "hostile path was not escaped");
});

test("sessions outside the day window are excluded", async () => {
  const { repoRoot, claudeRoot, codexRoot } = await fixtureReport();
  const projectDir = path.join(claudeRoot, "-fixture-project");
  const oldLines = [
    claudeAssistant({ ts: "2020-01-01T00:00:00.000Z", requestId: "req_old", usage: USAGE, cwd: repoRoot }),
  ];
  const oldFile = path.join(projectDir, "old.jsonl");
  await fs.writeFile(oldFile, `${oldLines.join("\n")}\n`);
  const report = await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot, days: 30 });
  assert.equal(report.totals.sessions, 4);
  const claudeSource = report.sources.find((source) => source.provider === "claude");
  assert.equal(claudeSource.files_out_of_window, 1);
});

test("dry-run manifest discloses sources without parsing bodies", async () => {
  const { repoRoot, claudeRoot, codexRoot } = await fixtureReport();
  const manifest = await buildAnalysisManifest(repoRoot, { claudeRoot, codexRoot, days: 30 });
  assert.equal(manifest.dry_run, true);
  const claudeSource = manifest.sources.find((source) => source.provider === "claude");
  assert.ok(claudeSource.files >= 4);
  assert.ok(claudeSource.bytes > 0);
  assert.ok(!("sessions" in manifest));
  assert.match(manifest.note, /No session record bodies/);
});

async function captureStdout(fn) {
  const chunks = [];
  const originalLog = console.log;
  console.log = (...args) => chunks.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return chunks.join("\n");
}

test("cli: analyze --json --yes emits the full auditable schema", async () => {
  const { repoRoot, claudeRoot, codexRoot } = await fixtureReport();
  const out = await captureStdout(() => runCli([
    "analyze", "--root", repoRoot, "--yes", "--json",
    "--claude-root", claudeRoot, "--codex-root", codexRoot,
  ]));
  const parsed = JSON.parse(out);
  assert.equal(parsed.schema_version, "session-analysis-v1");
  assert.equal(parsed.privacy.ai_spend_usd, 0);
  assert.ok(parsed.roast.text.length > 0);
});

test("cli: analyze refuses to scan non-interactively without --yes", async () => {
  const { repoRoot, claudeRoot, codexRoot } = await fixtureReport();
  await assert.rejects(
    () => runCli(["analyze", "--root", repoRoot, "--json", "--claude-root", claudeRoot, "--codex-root", codexRoot]),
    /explicit consent/,
  );
});

test("cli: analyze --format html writes a self-contained themed report", async () => {
  const { repoRoot, claudeRoot, codexRoot } = await fixtureReport();
  const outputPath = path.join(repoRoot, "analysis.html");
  await captureStdout(() => runCli([
    "analyze", "--root", repoRoot, "--yes", "--format", "html", "--output", outputPath,
    "--claude-root", claudeRoot, "--codex-root", codexRoot,
  ]));
  const html = await fs.readFile(outputPath, "utf8");
  assert.ok(html.includes('data-testid="agentify-analyze-report"'));
  assert.ok(!html.includes("supersecret123"));
});

test("cli: analyze --dry-run needs no consent", async () => {
  const { repoRoot, claudeRoot, codexRoot } = await fixtureReport();
  const out = await captureStdout(() => runCli([
    "analyze", "--root", repoRoot, "--json", "--dry-run",
    "--claude-root", claudeRoot, "--codex-root", codexRoot,
  ]));
  const parsed = JSON.parse(out);
  assert.equal(parsed.dry_run, true);
});
