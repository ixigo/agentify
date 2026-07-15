import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildAnalysisManifest, buildSessionAnalysis, parseSourceRoots, resolveAnalyzeProviders } from "../src/core/session-analysis/index.js";
import { renderAnalysisHtml, renderAnalysisText } from "../src/core/session-analysis/report.js";
import { classifyShellCommand, normalizeFilePath } from "../src/core/session-analysis/normalize.js";
import {
  buildScorecard,
  classifyWorkType,
  fitVerdict,
  modelTier,
  scoreSession,
} from "../src/core/session-analysis/scorecard.js";
import { createProgressRenderer } from "../src/core/session-analysis/progress.js";
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
  assert.ok(!html.includes("evil.js"), "file paths must not render in the html report");
});

test("cli-assisted insights render as a readable brief with collapsed grounding", async () => {
  const { report } = await fixtureReport();
  report.insights = {
    packet_preview: { bytes: 420 },
    total_cost_usd: 0.03,
    results: [{
      ok: true,
      provider: "claude",
      cost_usd: 0.03,
      summary: "The strongest signal is repeated search work.",
      insights: [{
        title: "Index the repeated search",
        explanation: "Repeated broad search calls point to a structural-query opportunity.",
        category: "search",
        grounded_in: ["patterns.grep_like"],
        confidence: "high",
        suggested_command: "agentify query search",
      }],
    }, {
      ok: true,
      provider: "codex",
      cost_usd: null,
      summary: "The same search signal is visible, but this provider reported no cost.",
      insights: [{
        title: "Use the structural index",
        explanation: "Repeated broad search calls support trying the local query command.",
        category: "search",
        grounded_in: ["patterns.grep_like"],
        confidence: "high",
        suggested_command: "agentify query search",
      }],
    }],
    agreement: null,
  };
  report.privacy.ai_spend_usd = 0.03;
  const html = renderAnalysisHtml(report, { projectName: "fixture" });
  assert.ok(html.includes('class="card insight-report"'));
  assert.ok(html.includes('class="insight-summary"'));
  assert.ok(html.includes('class="insight-list"'));
  assert.match(html, /<details class="insight-grounding">\s*<summary>Show evidence used/);
  assert.equal((html.match(/cost \$0\.03/g) || []).length, 1, "aggregate cost must not repeat in every provider card");
  assert.match(html, /codex analysis[\s\S]*?cost not reported/);
  assert.ok(!html.includes('<details class="insight-grounding" open>'), "grounding must be collapsed by default");
});

function syntheticSession({ calls = 0, byName = {}, writes = 0, failed = 0, models = [], userTurns = 0, outputTokens = null, cacheRead = null, freshInput = null, activeMs = 5 * 60 * 1000, shell = {}, outcome = { status: "completed", evidence: [] } } = {}) {
  return {
    session_id: "synthetic",
    outcome,
    models,
    turns: { user: userTurns, assistant_requests: userTurns },
    usage: { fresh_input_tokens: freshInput, cache_read_tokens: cacheRead, cache_write_tokens: null, output_tokens: outputTokens, reasoning_output_tokens: null },
    tools: { calls, by_name: byName },
    file_access: Array.from({ length: writes }, (_, index) => ({ path: `f${index}.js`, in_repo: true, operation: "write" })),
    failed_tool_calls: failed,
    active_ms: activeMs,
    shell_patterns: { grep_like: 0, find_like: 0, cat_search_like: 0, full_test_run: 0, focused_test_run: 0, opaque_shell_calls: 0, ...shell },
  };
}

test("model tiers classify heavy, standard, light, and unknown identifiers", () => {
  assert.equal(modelTier("claude-fable-5").label, "heavy");
  assert.equal(modelTier("claude-opus-4-8").label, "heavy");
  assert.equal(modelTier("claude-haiku-4-5-20251001").label, "light");
  assert.equal(modelTier("gpt-5.2-codex").label, "standard");
  assert.equal(modelTier("mystery-model-9").label, "unknown");
  // "gemini" must not match the light tier's "mini" marker.
  assert.equal(modelTier("gemini-3.1-pro-preview").label, "heavy");
  assert.equal(modelTier("gemini-3-flash").label, "light");
  assert.equal(modelTier("gemini-3").label, "standard");
  assert.equal(modelTier("gpt-5.1-codex-mini").label, "light");
});

test("work types come from tool mix with an honest mixed fallback", () => {
  assert.equal(classifyWorkType(syntheticSession()), "conversation");
  assert.equal(classifyWorkType(syntheticSession({ calls: 10, byName: { Read: 5, Grep: 3 } })), "research");
  assert.equal(classifyWorkType(syntheticSession({ calls: 6, byName: { Edit: 1 }, writes: 1 })), "quick-fix");
  assert.equal(classifyWorkType(syntheticSession({ calls: 30, byName: { Edit: 5 }, writes: 5 })), "implementation");
  assert.equal(classifyWorkType(syntheticSession({ calls: 20, failed: 4 })), "debugging");
  assert.equal(classifyWorkType(syntheticSession({ calls: 2, byName: { Bash: 2 } })), "mixed");
});

test("fit verdicts flag guns at fist fights and butter knives at sword fights", () => {
  assert.equal(fitVerdict("quick-fix", ["claude-fable-5"]), "overkill");
  assert.equal(fitVerdict("debugging", ["claude-haiku-4-5-20251001"]), "underkill");
  assert.equal(fitVerdict("implementation", ["claude-fable-5"]), "match");
  assert.equal(fitVerdict("research", ["gpt-5.2-codex"]), "match");
  assert.equal(fitVerdict("quick-fix", []), "unknown");
});

test("session scores are bounded, null-safe, and reward clean sessions", () => {
  const clean = syntheticSession({ calls: 6, byName: { Edit: 1 }, writes: 1, models: ["claude-haiku-4-5-20251001"], userTurns: 2, outputTokens: 1_000, cacheRead: 90_000, freshInput: 1_000 });
  const cleanScore = scoreSession(clean, "quick-fix", "match");
  assert.equal(cleanScore.score, 30 + 25 + 20 + 15 + 10);

  const messy = syntheticSession({ calls: 20, failed: 8, models: ["claude-fable-5"], userTurns: 1, outputTokens: 40_000, cacheRead: 0, freshInput: 50_000, shell: { grep_like: 12 } });
  const messyScore = scoreSession(messy, "quick-fix", "overkill");
  assert.ok(messyScore.score < cleanScore.score);
  assert.ok(messyScore.score >= 0 && messyScore.score <= 100);

  const sparse = syntheticSession();
  const sparseScore = scoreSession(sparse, "conversation", "unknown");
  assert.ok(sparseScore.score > 0, "missing telemetry must not zero the score");
});

test("the scorecard aggregates fits, calls the overkill matchup, and lists delegation candidates", () => {
  const sessions = [
    syntheticSession({ calls: 6, byName: { Edit: 1 }, writes: 1, models: ["claude-fable-5"], userTurns: 1, outputTokens: 500 }),
    syntheticSession({ calls: 5, byName: { Edit: 1 }, writes: 1, models: ["claude-fable-5"], userTurns: 1, outputTokens: 500 }),
    syntheticSession({ calls: 30, byName: { Edit: 6 }, writes: 6, models: ["claude-fable-5"], userTurns: 3, outputTokens: 5_000 }),
  ];
  const enriched = sessions.map((session) => {
    const workType = classifyWorkType(session);
    const fit = fitVerdict(workType, session.models);
    return { work_type: workType, fit, ...scoreSession(session, workType, fit) };
  });
  const scorecard = buildScorecard(sessions, enriched);
  assert.equal(scorecard.schema, "usage-scorecard-v1");
  assert.equal(scorecard.sessions_scored, 3);
  assert.equal(scorecard.fit.overkill, 2);
  assert.equal(scorecard.matchup.signal, "overkill");
  assert.match(scorecard.matchup.text, /fist fight|thumb war/);
  assert.match(scorecard.matchup.text, /delegate quick/);
  assert.equal(scorecard.delegation_candidates.length, 2);
  assert.ok(scorecard.overall_score >= 0 && scorecard.overall_score <= 100);
  assert.ok(scorecard.grade);
  assert.match(scorecard.note, /heuristic/i);

  const again = buildScorecard(sessions, enriched);
  assert.deepEqual(again, scorecard);
});

test("the report carries the scorecard in json, text, and filterable html", async () => {
  const { report } = await fixtureReport();
  assert.equal(report.scorecard.schema, "usage-scorecard-v1");
  assert.equal(report.scorecard.sessions_scored, 4);
  assert.ok(report.scorecard.overall_score !== null);
  for (const row of report.sessions) {
    assert.ok(row.work_type);
    assert.ok(["overkill", "match", "underkill", "unknown"].includes(row.fit));
    assert.ok(row.score >= 0 && row.score <= 100);
    assert.ok(row.user_turns !== undefined);
  }

  const text = renderAnalysisText(report);
  assert.match(text, /Scorecard: \d+\/100 \([SABCD]\)/);
  assert.match(text, /Matchup: /);

  const html = renderAnalysisHtml(report, { projectName: "fixture" });
  assert.ok(html.includes('data-testid="analyze-scorecard"'));
  assert.ok(html.includes('name="f-provider"'), "provider filter chips missing");
  assert.ok(html.includes('name="f-work"'), "work-type filter chips missing");
  assert.ok(html.includes('name="f-fit"'), "matchup filter chips missing");
  assert.ok(html.includes('name="f-outcome"'), "outcome filter chips missing");
  assert.ok(html.includes('name="f-conf"'), "confidence filter chips missing");
  assert.ok(html.includes("main:has(#f-provider-claude:checked)"), "CSS-only filter rules missing");
  assert.ok(html.includes("main:has(#f-conf-high:checked)"), "confidence filter rules missing");
  // Extra opportunity cards live in the same grid (not a <details>), so a
  // confidence filter can always reveal its matches.
  assert.ok(!/<details><summary>\d+ more opportunit/.test(html), "extras must not be trapped in a details section");
  assert.ok(html.includes("main:has(#f-conf-high:checked) article.opp--extra { display: block; }"), "confidence filters must force-reveal extras");
  assert.ok(/data-outcome="/.test(html) && /data-month="/.test(html), "row filter attributes missing");
  assert.ok(!html.includes("data-project-key="), "project filter row attributes must not render");
  assert.ok(!html.includes("<script"), "filters must not require a script tag");

  // Project is a detail column, never a filter, even in global reports with
  // many pseudonymized projects.
  assert.ok(!html.includes('name="f-project"'), "project filter must not render");
  const { report: globalReport } = await fixtureReport({ scope: "global" });
  const globalHtml = renderAnalysisHtml(globalReport, { projectName: "fixture" });
  assert.ok(!globalHtml.includes('name="f-project"'), "global report must not render project filter chips");
  assert.ok(!globalHtml.includes("#f-project-"), "global report must not render project filter CSS");
});

test("local-extractive mode classifies prompts in memory and persists no text", async () => {
  const repoRoot = await makeRoot("agentify-analyze-content-");
  const claudeRoot = path.join(repoRoot, "history", "claude");
  const codexRoot = path.join(repoRoot, "history", "codex");
  const cacheRoot = path.join(repoRoot, "cache", "session-analysis");
  await writeClaudeFixtures(claudeRoot, repoRoot);
  await writeCodexFixtures(codexRoot, repoRoot);
  // A session whose tool mix is inconclusive (bash-only) but whose prompt
  // is clearly debugging work.
  const projectDir = path.join(claudeRoot, "-fixture-project");
  const debugLines = [
    claudeUser({ ts: minutesAgo(40), cwd: repoRoot, content: [{ type: "text", text: "fix the failing test, the error is a regression in the parser bug" }] }),
    claudeAssistant({
      ts: minutesAgo(39), requestId: "req_dbg", usage: USAGE, cwd: repoRoot,
      content: [{ type: "tool_use", id: "t_dbg", name: "Bash", input: { command: "echo hi" } }],
    }),
  ];
  await fs.writeFile(path.join(projectDir, "debug.jsonl"), `${debugLines.join("\n")}\n`);

  // Metadata-only: the session stays mixed and no hint exists.
  const metadataReport = await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot, cacheRoot, days: 30 });
  const metadataRow = metadataReport.sessions.find((row) => row.tool_calls === 1 && row.provider === "claude");
  assert.equal(metadataRow.work_type, "mixed");
  assert.equal(metadataRow.work_type_source, "metadata");
  assert.equal(metadataReport.privacy.content_mode, "metadata-only");

  // Local-extractive: the prompt breaks the tie, provenance is recorded.
  const contentReport = await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot, cacheRoot, days: 30, contentMode: "local-extractive" });
  const contentRow = contentReport.sessions.find((row) => row.tool_calls === 1 && row.provider === "claude");
  assert.equal(contentRow.work_type, "debugging");
  assert.equal(contentRow.work_type_source, "content-hint");
  assert.equal(contentReport.privacy.content_mode, "local-extractive");
  assert.equal(contentReport.privacy.transcript_bodies_analyzed, true);
  assert.equal(contentReport.privacy.content_persisted, false);

  // Mode switch: metadata entries are reused only to decide repo scope;
  // every in-scope session is freshly re-parsed with the classifier.
  const contentClaude = contentReport.sources.find((source) => source.provider === "claude");
  assert.ok(contentClaude.files_parsed >= 4, "in-scope sessions must be re-parsed in content mode");

  // No prompt text in any output or cache file, in either mode.
  for (const output of [JSON.stringify(contentReport), renderAnalysisHtml(contentReport, { projectName: "fixture" }), renderAnalysisText(contentReport)]) {
    assert.ok(!output.includes("failing test"), "prompt text leaked from local-extractive mode");
    assert.ok(!output.includes("SUPER SECRET"), "prompt text leaked");
  }
  for (const name of await fs.readdir(cacheRoot)) {
    const raw = await fs.readFile(path.join(cacheRoot, name), "utf8");
    assert.ok(!raw.includes("failing test"), "prompt text persisted to cache");
    assert.ok(!raw.includes("SUPER SECRET"), "prompt text persisted to cache");
  }

  // Invalid mode is rejected.
  await assert.rejects(
    () => buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot, days: 30, contentMode: "remote" }),
    /--content must be one of/,
  );
});

test("injected context and meta records never influence content classification", async () => {
  const { createContentClassifier, claudePromptText, codexPromptText } = await import("../src/core/session-analysis/content-classify.js");

  const classifier = createContentClassifier();
  classifier.observe("<system-reminder>fix the error bug crash fail regression</system-reminder>");
  classifier.observe("Caveat: the bug fix error messages below were generated by failing hooks");
  assert.equal(classifier.result().category_hint, null, "injected text must not create a hint");

  // isMeta user records are command wrappers, not prompts.
  assert.equal(claudePromptText({ type: "user", isMeta: true, message: { content: "fix the bug error" } }), null);
  assert.equal(claudePromptText({ type: "user", message: { content: "fix the bug error" } }), "fix the bug error");

  // Codex: event_msg is the human turn; response_item duplicates it with
  // injected context and is only a tagged fallback.
  const event = codexPromptText({ type: "event_msg" }, { type: "user_message", message: "fix the bug" });
  assert.deepEqual(event, { source: "event", text: "fix the bug" });
  const response = codexPromptText({ type: "response_item" }, { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] });
  assert.equal(response.source, "response");
});

test("current-repo local-extractive never caches content facts for foreign sessions", async () => {
  const repoRoot = await makeRoot("agentify-analyze-scopegate-");
  const claudeRoot = path.join(repoRoot, "history", "claude");
  const codexRoot = path.join(repoRoot, "history", "codex");
  const cacheRoot = path.join(repoRoot, "cache", "session-analysis");
  await writeClaudeFixtures(claudeRoot, repoRoot);
  await writeCodexFixtures(codexRoot, repoRoot);

  await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot, cacheRoot, days: 30, contentMode: "local-extractive" });
  let foreignEntries = 0;
  let inScopeContentEntries = 0;
  for (const name of await fs.readdir(cacheRoot)) {
    const entry = JSON.parse(await fs.readFile(path.join(cacheRoot, name), "utf8"));
    if (entry.session.cwd && entry.session.cwd !== repoRoot && !entry.session.cwd.startsWith(`${repoRoot}/`)) {
      foreignEntries += 1;
      assert.equal(entry.content_mode, "metadata-only", "foreign session must not be content-classified");
      assert.equal(entry.session.task.content_mode, "metadata-only");
    } else if (entry.content_mode === "local-extractive") {
      inScopeContentEntries += 1;
      assert.equal(entry.content_rules, "content-rules-v1");
    }
  }
  assert.ok(foreignEntries >= 2, "fixture includes foreign claude and codex sessions");
  assert.ok(inScopeContentEntries >= 4, "in-scope sessions are content-classified");
});

test("outcome detection: commits and test results produce conservative evidence", async () => {
  const repoRoot = await makeRoot("agentify-analyze-outcome-");
  const claudeRoot = path.join(repoRoot, "history", "claude");
  const projectDir = path.join(claudeRoot, "-fixture-project");
  await fs.mkdir(projectDir, { recursive: true });
  const bashTool = (id, command) => ({ type: "tool_use", id, name: "Bash", input: { command } });

  // Session A: tests pass, then a git commit succeeds -> completed.
  const done = [
    claudeAssistant({
      ts: minutesAgo(60), requestId: "req_done", usage: USAGE, cwd: repoRoot,
      content: [
        { type: "tool_use", id: "t_edit", name: "Edit", input: { file_path: path.join(repoRoot, "src/a.js") } },
        bashTool("t_test", "npm test"),
        bashTool("t_commit", 'git commit -m "done"'),
      ],
    }),
    claudeUser({
      ts: minutesAgo(59), cwd: repoRoot,
      content: [
        { type: "tool_result", tool_use_id: "t_test", is_error: false, content: "ok" },
        { type: "tool_result", tool_use_id: "t_commit", is_error: false, content: "committed" },
      ],
    }),
  ];
  await fs.writeFile(path.join(projectDir, "done.jsonl"), `${done.join("\n")}\n`);

  // Session B: last test run fails -> likely-incomplete.
  const failing = [
    claudeAssistant({
      ts: minutesAgo(50), requestId: "req_fail", usage: USAGE, cwd: repoRoot,
      content: [bashTool("t_t1", "npm test"), bashTool("t_t2", "node --test test/x.test.js")],
    }),
    claudeUser({
      ts: minutesAgo(49), cwd: repoRoot,
      content: [
        { type: "tool_result", tool_use_id: "t_t1", is_error: false, content: "ok" },
        { type: "tool_result", tool_use_id: "t_t2", is_error: true, content: "1 failing" },
      ],
    }),
  ];
  await fs.writeFile(path.join(projectDir, "failing.jsonl"), `${failing.join("\n")}\n`);

  // Session C: commit succeeds but tests fail AFTERWARDS -> not completed.
  const regressed = [
    claudeAssistant({
      ts: minutesAgo(45), requestId: "req_reg", usage: USAGE, cwd: repoRoot,
      content: [bashTool("t_c2", 'git commit -m "wip"'), bashTool("t_t3", "npm test")],
    }),
    claudeUser({
      ts: minutesAgo(44), cwd: repoRoot,
      content: [
        { type: "tool_result", tool_use_id: "t_c2", is_error: false, content: "committed" },
        { type: "tool_result", tool_use_id: "t_t3", is_error: true, content: "2 failing" },
      ],
    }),
  ];
  await fs.writeFile(path.join(projectDir, "regressed.jsonl"), `${regressed.join("\n")}\n`);

  // Session D: piped/quoted envelopes are not outcome evidence.
  const unreliable = [
    claudeAssistant({
      ts: minutesAgo(42), requestId: "req_unrel", usage: USAGE, cwd: repoRoot,
      content: [bashTool("t_p1", "npm test | tail -5"), bashTool("t_p2", 'printf "git commit"')],
    }),
    claudeUser({
      ts: minutesAgo(41), cwd: repoRoot,
      content: [
        { type: "tool_result", tool_use_id: "t_p1", is_error: false, content: "5 lines" },
        { type: "tool_result", tool_use_id: "t_p2", is_error: false, content: "git commit" },
      ],
    }),
  ];
  await fs.writeFile(path.join(projectDir, "unreliable.jsonl"), `${unreliable.join("\n")}\n`);

  const report = await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot: path.join(repoRoot, "none"), days: 30 });
  const bySession = new Map(report.sessions.map((row) => [row.tool_calls + ":" + row.outcome, row]));
  const outcomes = report.sessions.map((row) => row.outcome).sort();
  assert.deepEqual(outcomes, ["completed", "likely-incomplete", "likely-incomplete", "unknown"]);
  const completedRow = report.sessions.find((row) => row.outcome === "completed");
  assert.ok(completedRow.outcome_evidence.some((entry) => entry.signal === "git-commit-succeeded"));
  const unknownRow = report.sessions.find((row) => row.outcome === "unknown");
  assert.equal(unknownRow.outcome_evidence.length, 0, "piped/quoted envelopes must contribute no evidence");
  assert.ok(bySession, "session map built");
});

test("sidechain transcripts are linked to parents and excluded from totals", async () => {
  const repoRoot = await makeRoot("agentify-analyze-sidechain-");
  const claudeRoot = path.join(repoRoot, "history", "claude");
  const projectDir = path.join(claudeRoot, "-fixture-project");
  await fs.mkdir(projectDir, { recursive: true });

  const primary = [
    JSON.stringify({ type: "assistant", timestamp: minutesAgo(30), requestId: "req_p", cwd: repoRoot, sessionId: "sess-parent", message: { id: "m1", model: "claude-fable-5", usage: USAGE, content: [] } }),
  ];
  await fs.writeFile(path.join(projectDir, "sess-parent.jsonl"), `${primary.join("\n")}\n`);
  // Real layout: <project>/<session-id>/subagents/agent-*.jsonl with its
  // own disjoint request ids.
  const subagentsDir = path.join(projectDir, "sess-parent", "subagents");
  await fs.mkdir(subagentsDir, { recursive: true });
  const sidechain = [
    JSON.stringify({ type: "assistant", timestamp: minutesAgo(29), requestId: "req_s1", cwd: repoRoot, sessionId: "sess-child", isSidechain: true, message: { id: "m2", model: "claude-fable-5", usage: USAGE, content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: path.join(repoRoot, "a.js") } }] } }),
    JSON.stringify({ type: "user", timestamp: minutesAgo(28), cwd: repoRoot, sessionId: "sess-child", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "x" }] } }),
  ];
  await fs.writeFile(path.join(subagentsDir, "agent-abc.jsonl"), `${sidechain.join("\n")}\n`);
  // An orphan transcript whose parent session file does not exist.
  const orphanDir = path.join(projectDir, "sess-gone", "subagents");
  await fs.mkdir(orphanDir, { recursive: true });
  await fs.writeFile(path.join(orphanDir, "agent-orphan.jsonl"), `${JSON.stringify({ type: "assistant", timestamp: minutesAgo(20), requestId: "req_o", cwd: repoRoot, sessionId: "sess-orphan", isSidechain: true, message: { id: "m3", model: "claude-fable-5", usage: USAGE, content: [] } })}\n`);

  const report = await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot: path.join(repoRoot, "none"), days: 30 });
  // Parent + orphan (kept so nothing is dropped); the linked transcript
  // merged into the parent instead of counting as a session.
  assert.equal(report.totals.sessions, 2);
  assert.equal(report.totals.usage.output_tokens, 450, "child usage merges into totals exactly once");
  const parentRow = report.sessions.find((row) => row.tool_calls === 1);
  assert.ok(parentRow, "parent absorbed the child's tool call");
  assert.equal(report.sidechains.transcripts.length, 2);
  const linked = report.sidechains.transcripts.find((entry) => entry.merged_into_parent);
  assert.equal(linked.parent_session_id, parentRow.session_id);
  const orphan = report.sidechains.transcripts.find((entry) => !entry.merged_into_parent);
  assert.equal(orphan.parent_session_id, null);
  const claudeSource = report.sources.find((source) => source.provider === "claude");
  assert.equal(claudeSource.files_sidechain, 2);
});

test("global display opt-ins swap labels only and are badged", async () => {
  const { repoRoot, claudeRoot, codexRoot } = await fixtureReport();
  const pseudo = await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot, days: 30, scope: "global" });
  assert.ok(pseudo.sessions.every((row) => /^Project \d+$/.test(row.project)));
  assert.equal(pseudo.display.project_names_shown, false);

  const named = await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot, days: 30, scope: "global", showProjectNames: true });
  assert.ok(named.sessions.some((row) => row.project === path.basename(repoRoot)), "real basenames shown");
  assert.ok(named.privacy.notes.some((note) => note.includes("--show-project-names")));

  const pathed = await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot, days: 30, scope: "global", showPaths: true });
  assert.ok(pathed.sessions.some((row) => row.project.includes(path.basename(repoRoot))));
  const html = renderAnalysisHtml(pathed, { projectName: "fixture" });
  assert.ok(html.includes("real paths shown"), "display badge missing");

  // Current-repo scope ignores the opt-ins entirely.
  const local = await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot, days: 30, showPaths: true });
  assert.equal(local.display.paths_shown, false);
});

test("codex custom_tool_call records count as tools and drive outcomes", async () => {
  const repoRoot = await makeRoot("agentify-analyze-codex-custom-");
  const codexRoot = path.join(repoRoot, "history", "codex");
  const dayDir = path.join(codexRoot, "2026", "07", "14");
  await fs.mkdir(dayDir, { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: minutesAgo(30), type: "session_meta", payload: { cwd: repoRoot, id: "cxc", cli_version: "0.110.0" } }),
    JSON.stringify({ timestamp: minutesAgo(29), type: "turn_context", payload: { model: "gpt-5.2-codex", cwd: repoRoot } }),
    JSON.stringify({ timestamp: minutesAgo(28), type: "response_item", payload: { type: "custom_tool_call", name: "shell", call_id: "c1", input: 'git commit -m "ship"' } }),
    JSON.stringify({ timestamp: minutesAgo(27), type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: JSON.stringify({ output: "ok", metadata: { exit_code: 0 } }) } }),
    JSON.stringify({ timestamp: minutesAgo(26), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c2", input: "*** Begin Patch\ngit commit inside patch text\n*** End Patch" } }),
    JSON.stringify({ timestamp: minutesAgo(25), type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c2", output: JSON.stringify({ output: "done", metadata: { exit_code: 0 } }) } }),
  ];
  await fs.writeFile(path.join(dayDir, "rollout-2026-07-14-cxc.jsonl"), `${lines.join("\n")}\n`);

  const report = await buildSessionAnalysis(repoRoot, { providers: ["codex"], codexRoot, days: 30 });
  assert.equal(report.totals.sessions, 1);
  const row = report.sessions[0];
  assert.equal(row.tool_calls, 2, "custom_tool_call records must count as tool activity");
  assert.equal(row.outcome, "completed", "exit_code 0 on a shell git commit is completion evidence");
  assert.equal(report.tools.shell, 1);
  assert.equal(report.tools.apply_patch, 1);
  // Patch bodies must never be classified as shell commands.
  assert.equal(report.patterns.grep_like, 0);
});

test("delegation confidence climbs the evidence ladder: heuristic, local history, eval", () => {
  const base = { calls: 6, byName: { Edit: 1 }, writes: 1, models: ["claude-fable-5"], userTurns: 1, outputTokens: 500 };
  const overkillSession = syntheticSession(base);
  const enrichedFor = (sessions) => sessions.map((session) => {
    const workType = classifyWorkType(session);
    const fit = fitVerdict(workType, session.models);
    return { work_type: workType, work_type_source: "metadata", fit, ...scoreSession(session, workType, fit) };
  });

  // No evidence at all -> low, and the basis says so.
  const low = buildScorecard([overkillSession], enrichedFor([overkillSession]));
  assert.equal(low.delegation_candidates[0].confidence, "low");
  assert.match(low.delegation_candidates[0].evidence_basis, /heuristic only/);

  // 3+ completed same-type sessions on cheaper tiers -> medium.
  const cheapDone = Array.from({ length: 3 }, () => syntheticSession({ ...base, models: ["claude-haiku-4-5-20251001"] }));
  const withLocal = [overkillSession, ...cheapDone];
  const medium = buildScorecard(withLocal, enrichedFor(withLocal));
  assert.equal(medium.delegation_candidates[0].confidence, "medium");
  assert.match(medium.delegation_candidates[0].evidence_basis, /3 completed quick-fix session/);

  // Sufficient LIGHT-tier eval evidence above the quality floor -> high
  // (keys use the router's provider/model format).
  const routeEvidence = { models: { "claude/haiku": { attempts: 8, passes: 8, pass_rate: 1, sufficient: true } } };
  const high = buildScorecard([overkillSession], enrichedFor([overkillSession]), { routeEvidence });
  assert.equal(high.delegation_candidates[0].confidence, "high");
  assert.match(high.delegation_candidates[0].evidence_basis, /claude\/haiku passed 8\/8/);

  // Insufficient, standard-tier, or heavy-tier evidence never upgrades:
  // the suggested quick/research routes run light models.
  const weak = { models: {
    "claude/haiku": { attempts: 2, passes: 2, pass_rate: 1, sufficient: false },
    "claude/sonnet": { attempts: 10, passes: 10, pass_rate: 1, sufficient: true },
    "claude/opus": { attempts: 10, passes: 10, pass_rate: 1, sufficient: true },
    "gemini/gemini-3.1-pro-preview": { attempts: 10, passes: 10, pass_rate: 1, sufficient: true },
  } };
  const stillLow = buildScorecard([overkillSession], enrichedFor([overkillSession]), { routeEvidence: weak });
  assert.equal(stillLow.delegation_candidates[0].confidence, "low");

  // Standard-tier local sessions do not count as comparable either.
  const sonnetDone = Array.from({ length: 3 }, () => syntheticSession({ ...base, models: ["claude-sonnet-4-5"] }));
  const withSonnet = [overkillSession, ...sonnetDone];
  const sonnetCard = buildScorecard(withSonnet, enrichedFor(withSonnet));
  assert.equal(sonnetCard.delegation_candidates[0].confidence, "low");
});

test("overkill sessions without a completed outcome are withheld from delegation", async () => {
  const enrichedFor = (sessions) => sessions.map((session) => {
    const workType = classifyWorkType(session);
    const fit = fitVerdict(workType, session.models);
    return { work_type: workType, work_type_source: "metadata", fit, ...scoreSession(session, workType, fit) };
  });
  const base = { calls: 6, byName: { Edit: 1 }, writes: 1, models: ["claude-fable-5"], userTurns: 1, outputTokens: 500 };
  const completed = syntheticSession(base);
  const unknown = syntheticSession({ ...base, outcome: { status: "unknown", evidence: [] } });
  const scorecard = buildScorecard([completed, unknown], enrichedFor([completed, unknown]));
  assert.equal(scorecard.fit.overkill, 2);
  assert.equal(scorecard.delegation_candidates.length, 1);
  assert.equal(scorecard.delegation_candidates[0].outcome, "completed");
  assert.equal(scorecard.delegation_candidates_withheld, 1);
  assert.match(scorecard.delegation_withheld_reason, /cannot be assumed/);
});

test("tool inventory probes read-only and gates recommendations on availability", async () => {
  const { detectToolInventory } = await import("../src/core/session-analysis/tool-inventory.js");
  const { buildOpportunities } = await import("../src/core/session-analysis/opportunities.js");

  const calls = [];
  const fakeExec = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "rtk" && args[0] === "--version") return { stdout: "rtk 0.43.0\n" };
    if (command === "rtk" && args[0] === "gain") return { stdout: JSON.stringify({ summary: { total_commands: 100, total_saved: 5000, avg_savings_pct: 30.5 } }) };
    if (command === "rg") throw new Error("not found");
    return { stdout: `${command} version 1.2.3` };
  };
  const inventory = await detectToolInventory({ exec: fakeExec });
  assert.equal(inventory.schema, "tool-inventory-v1");
  assert.equal(inventory.tools.rtk.available, true);
  assert.equal(inventory.tools.rtk.version, "0.43.0");
  assert.equal(inventory.tools.rtk.gain.parse_coverage, "json");
  assert.equal(inventory.tools.rtk.gain.total_saved_tokens, 5000);
  assert.equal(inventory.tools.rg.available, false);
  assert.equal(inventory.agentify_index.status, "unknown");
  assert.ok(calls.every((call) => /--version|gain --format json/.test(call)), "probes must be read-only version/summary queries");

  const patterns = {
    sessions: 5, grep_like: 20, find_like: 0, cat_search_like: 0, full_test_runs: 0, focused_test_runs: 0,
    opaque_shell_calls: 500, failed_tool_calls: 0, files_written: 0, research_heavy_sessions: 0,
    mechanical_candidate_sessions: 0, longest_session_ms: 0, sidechain_events: 0,
    files_reread_across_sessions: { count: 0, top: [] },
    repeated_failed_commands: { fingerprints: 0, max_repeats: 0 },
  };
  // rtk installed -> the install tip is suppressed with the measured basis.
  const withRtk = buildOpportunities(patterns, { windowDays: 30, inventory });
  const rtkSuppressed = withRtk.suppressed.find((rule) => rule.id === "rtk-token-compression");
  assert.match(rtkSuppressed.reason, /already installed/);
  assert.match(rtkSuppressed.reason, /5,000 tokens saved/);
  // rg missing -> the search suggestion names the install step.
  const search = withRtk.opportunities.find((item) => item.id === "broad-text-search");
  assert.match(search.suggestion.command, /brew install ripgrep/);

  // rtk absent with heavy shell volume -> low-confidence tip, no savings claim.
  const noRtk = { ...inventory, tools: { ...inventory.tools, rtk: { available: false, version: null }, rg: { available: true, version: "14.0.0" } } };
  const withoutRtk = buildOpportunities(patterns, { windowDays: 30, inventory: noRtk });
  const rtkTip = withoutRtk.opportunities.find((item) => item.id === "rtk-token-compression");
  assert.equal(rtkTip.confidence, "low");
  assert.equal(rtkTip.impact, "unavailable");
  assert.match(rtkTip.caveat, /No savings are claimed/);
  assert.ok(!withoutRtk.opportunities.find((item) => item.id === "broad-text-search").suggestion.command.includes("brew install"));

  // A binary answering --version but failing `rtk gain` is NOT treated as
  // a working install: the tip still fires, with the name-collision caveat.
  const brokenRtk = { ...inventory, tools: { ...inventory.tools, rtk: { available: true, version: "1.0.0", gain: { parse_coverage: "unavailable" } } } };
  const withBrokenRtk = buildOpportunities(patterns, { windowDays: 30, inventory: brokenRtk });
  const brokenTip = withBrokenRtk.opportunities.find((item) => item.id === "rtk-token-compression");
  assert.match(brokenTip.caveat, /unrelated tool or an incomplete install/);
  assert.match(brokenTip.suggestion.command, /rtk-ai\/rtk/);

  // Library calls without probes remain pure and say so.
  const pure = buildOpportunities(patterns, { windowDays: 30 });
  assert.match(pure.suppressed.find((rule) => rule.id === "rtk-token-compression").reason, /inventory unavailable/);
});

test("--include-config audits allowlisted sources structurally and leaks no values", async () => {
  const home = await makeRoot("agentify-analyze-config-");
  const claudeHome = path.join(home, "claude-home");
  const codexHome = path.join(home, "codex-home");
  await fs.mkdir(path.join(claudeHome, "skills", "my-skill"), { recursive: true });
  await fs.mkdir(path.join(claudeHome, "agents"), { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  const sharedLine = "Always run the linter before committing anything at all.";
  await fs.writeFile(path.join(claudeHome, "CLAUDE.md"), `# Global rules\n${sharedLine}\nUse pnpm not npm for this machine.\n`);
  await fs.writeFile(path.join(codexHome, "AGENTS.md"), `# Codex rules\n${sharedLine}\n${"x".repeat(9000)}\n`);
  await fs.writeFile(path.join(claudeHome, "agents", "reviewer.md"), "agent body SHOULD NOT LEAK");
  await fs.writeFile(path.join(claudeHome, "settings.json"), JSON.stringify({
    model: "opus",
    permissions: { allow: ["Bash(ls:*)", "Read"], deny: ["WebFetch"] },
    hooks: { PreToolUse: [], SessionStart: [] },
    env: { MY_API_KEY: "supersecret-env-value", OTHER: "v" },
  }));
  await fs.writeFile(path.join(codexHome, "config.toml"), [
    'model = "gpt-5.2-codex"',
    'approval_policy = "on-request"',
    'api_key = "supersecret-toml-value"',
    "[profiles.fast] # inline comment on a table header",
    'model = "supersecret-nested-model"',
    "[mcp_servers.foo]",
    'url = "https://example.com"',
  ].join("\n"));
  await fs.writeFile(path.join(codexHome, "auth.json"), '{"token":"supersecret-auth-token"}');

  const { buildConfigAudit } = await import("../src/core/session-analysis/config-audit.js");
  const audit = await buildConfigAudit({ claudeHome, codexHome });
  assert.equal(audit.schema, "config-audit-v1");
  assert.equal(audit.claude.settings.permission_allow_rules, 2);
  assert.equal(audit.claude.settings.permission_deny_rules, 1);
  assert.equal(audit.claude.settings.hook_events, 2);
  assert.equal(audit.claude.settings.env_vars, 2);
  assert.deepEqual(audit.claude.skills, ["my-skill"]);
  assert.deepEqual(audit.claude.agents, ["reviewer"]);
  assert.equal(audit.codex.config.allowlisted.model, "gpt-5.2-codex");
  assert.equal(audit.codex.config.secret_like_keys_counted_not_read, 1);
  assert.equal(audit.cross_provider.duplicated_instruction_lines, 1);
  assert.equal(audit.codex.global_instructions.oversized, true);
  assert.equal(audit.claude.always_loaded_token_estimate > 0, true);
  assert.ok(audit.findings.some((finding) => /oversized|2k tokens/.test(finding)));

  const serialized = JSON.stringify(audit);
  for (const secret of ["supersecret-env-value", "supersecret-toml-value", "supersecret-auth-token", "supersecret-nested-model", "SHOULD NOT LEAK", "MY_API_KEY", sharedLine, "Use pnpm not npm"]) {
    assert.ok(!serialized.includes(secret), `config audit leaked: ${secret}`);
  }

  // Non-identifier values under allowlisted keys are withheld, not echoed.
  const gatedHome = path.join(home, "gated-claude");
  await fs.mkdir(gatedHome, { recursive: true });
  await fs.writeFile(path.join(gatedHome, "settings.json"), JSON.stringify({ model: "custom: `curl https://evil.example`" }));
  const gated = await buildConfigAudit({ claudeHome: gatedHome, codexHome: path.join(home, "missing") });
  assert.equal(gated.claude.settings.allowlisted.model, "(value withheld)");

  // Wired through the full report + html when includeConfig is set.
  const { repoRoot, claudeRoot, codexRoot } = await fixtureReport();
  const report = await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot, days: 30, includeConfig: true, claudeHome, codexHome });
  assert.equal(report.config_audit.schema, "config-audit-v1");
  const html = renderAnalysisHtml(report, { projectName: "fixture" });
  assert.ok(html.includes('data-testid="analyze-config-audit"'));
  assert.ok(!html.includes("supersecret"), "secret leaked into html");
  assert.ok(html.includes("Config sources read"), "privacy receipt must list config sources");
  assert.equal(report.privacy.config_sources_read.length > 0, true);
  const withoutFlag = await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot, days: 30 });
  assert.equal(withoutFlag.config_audit, null);

  // Dry-run manifest discloses the allowlisted config sources.
  const manifest = await buildAnalysisManifest(repoRoot, { claudeRoot, codexRoot, days: 30, includeConfig: true, claudeHome, codexHome });
  assert.ok(manifest.config_sources.some((source) => source.endsWith("CLAUDE.md")));
  assert.ok(manifest.config_sources.some((source) => source.includes("config.toml")));
});

test("cost estimates use exact model + effective date and never claim billed spend", async () => {
  const { estimateSessionCost, buildCostSummary, priceEntryFor } = await import("../src/core/session-analysis/pricing.js");
  const usage = { fresh_input_tokens: 1_000_000, cache_read_tokens: 2_000_000, cache_write_tokens: 100_000, output_tokens: 500_000, reasoning_output_tokens: null };

  // Dated snapshot suffix maps to the same priced model.
  const haiku = estimateSessionCost({ models: ["claude-haiku-4-5-20251001"], started_at: "2026-07-01T00:00:00Z", usage });
  // 1*1 + 2*0.1 + 0.1*1.25 + 0.5*5 = 3.825
  assert.equal(haiku.estimated_usd, 3.825);
  assert.equal(haiku.basis, "versioned-price-estimate");
  assert.deepEqual(
    haiku.line_items.map(({ token_type, tokens, rate_usd_per_million }) => ({ token_type, tokens, rate_usd_per_million })),
    [
      { token_type: "fresh_input", tokens: 1_000_000, rate_usd_per_million: 1 },
      { token_type: "cache_read", tokens: 2_000_000, rate_usd_per_million: 0.1 },
      { token_type: "cache_write", tokens: 100_000, rate_usd_per_million: 1.25 },
      { token_type: "output", tokens: 500_000, rate_usd_per_million: 5 },
    ],
  );

  // Unknown model, multi-model, pre-effective-date, and undated sessions stay unpriced.
  assert.equal(estimateSessionCost({ models: ["mystery-9"], started_at: "2026-07-01T00:00:00Z", usage }).estimated_usd, null);
  assert.equal(estimateSessionCost({ models: ["claude-haiku-4-5", "gpt-5.1"], started_at: "2026-07-01T00:00:00Z", usage }).estimated_usd, null);
  assert.equal(priceEntryFor("claude-haiku-4-5", "2024-01-01T00:00:00Z"), null);
  assert.equal(priceEntryFor("claude-haiku-4-5", null), null, "undated sessions must stay unpriced");
  assert.equal(estimateSessionCost({ models: ["claude-haiku-4-5"], started_at: "2026-07-01T00:00:00Z", usage: { ...usage, output_tokens: null } }).estimated_usd, null);

  // Cache-write TTL split: 1-hour writes cost 2x input, 5-minute 1.25x.
  const splitUsage = { fresh_input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 200_000, cache_write_5m_tokens: 100_000, cache_write_1h_tokens: 100_000, output_tokens: 0 };
  const split = estimateSessionCost({ models: ["claude-haiku-4-5"], started_at: "2026-07-01T00:00:00Z", usage: splitUsage });
  assert.equal(split.estimated_usd, Number(((100_000 * 1.25 + 100_000 * 2) / 1e6).toFixed(4)));
  assert.equal(split.assumption, null);
  // Without the split, the 5m default rate applies and the assumption is labeled.
  const unsplit = estimateSessionCost({ models: ["claude-haiku-4-5"], started_at: "2026-07-01T00:00:00Z", usage: { ...splitUsage, cache_write_5m_tokens: null, cache_write_1h_tokens: null } });
  assert.match(unsplit.assumption, /5-minute TTL rate/);

  // Aggregation sums raw precision and rounds once at the end.
  const tiny = Array.from({ length: 1000 }, () => ({ models: ["claude-haiku-4-5"], started_at: "2026-07-01T00:00:00Z", usage: { fresh_input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 2 } }));
  const tinySummary = buildCostSummary(tiny, tiny.map((session) => estimateSessionCost(session)));
  assert.equal(tinySummary.estimated_usd, 0.01, "1000 x $0.00001 must not vanish to $0.00");

  const sessions = [
    { models: ["claude-haiku-4-5"], started_at: "2026-07-01T00:00:00Z", usage },
    { models: ["mystery-9"], started_at: "2026-07-01T00:00:00Z", usage },
  ];
  const summary = buildCostSummary(sessions, sessions.map((session) => estimateSessionCost(session)));
  assert.equal(summary.reported_usd, null, "estimates must never masquerade as reported cost");
  assert.equal(summary.estimated_usd, 3.83);
  assert.equal(summary.coverage.sessions_priced, 1);
  assert.equal(summary.coverage.priced_output_token_share, 0.5);
  assert.equal(summary.breakdown.find((item) => item.token_type === "fresh_input").estimated_usd, 1);
  assert.equal(summary.breakdown.find((item) => item.token_type === "output").estimated_usd, 2.5);
  assert.ok(summary.coverage.unpriced_reasons["no list price for mystery-9"]);
  assert.match(summary.note, /NOT billed spend/);
});

test("report carries per-session estimates and labeled totals in all formats", async () => {
  const { report } = await fixtureReport();
  // Fixture models: claude-fable-5 and gpt-5.2-codex are both exactly priced.
  assert.equal(report.totals.cost.basis, "versioned-price-estimate");
  assert.equal(report.totals.cost.coverage.sessions_priced, 4);
  assert.deepEqual(report.totals.cost.coverage.unpriced_reasons, {});
  const codexRow = report.sessions.find((row) => row.provider === "codex");
  assert.ok(codexRow.cost_estimate_usd > 0);
  assert.ok(report.sessions.find((row) => row.provider === "claude").cost_estimate_usd > 0);

  const text = renderAnalysisText(report);
  assert.match(text, /est\. \$[\d.]+ list price, 4\/4 session\(s\) priced — not billed spend/);
  const html = renderAnalysisHtml(report, { projectName: "fixture" });
  assert.ok(html.includes("not billed spend"));
  assert.ok(html.includes("Est. $ (list)"));
  assert.ok(html.includes('data-testid="analyze-cost-breakdown"'));
  assert.ok(html.includes("Tokens used × public list rate"));
  assert.match(html, /<details class="card cost-breakdown">\s*<summary>Show expected cost calculation/);
  assert.ok(!html.includes('<details class="card cost-breakdown" open>'), "cost table must be collapsed by default");
  assert.ok(html.includes("Rate since"));
  assert.ok(html.includes("Rate / 1M"));
  assert.ok(html.includes("Expected total"));
});

test("parseSourceRoots validates provider=path entries and resolves paths", () => {
  const roots = parseSourceRoots(["claude=fixtures/a", "claude=/abs/b", "codex=fixtures/c"], { root: "/repo" });
  assert.deepEqual(roots.claude, ["/repo/fixtures/a", "/abs/b"]);
  assert.deepEqual(roots.codex, ["/repo/fixtures/c"]);
  assert.deepEqual(parseSourceRoots(undefined, { root: "/repo" }), { claude: [], codex: [] });
  assert.deepEqual(parseSourceRoots("codex=x", { root: "/repo" }).codex, ["/repo/x"]);
  assert.throws(() => parseSourceRoots(["gemini=x"], { root: "/repo" }), /claude=<path> or codex=<path>/);
  assert.throws(() => parseSourceRoots(["claude="], { root: "/repo" }), /claude=<path> or codex=<path>/);
  assert.throws(() => parseSourceRoots([true], { root: "/repo" }), /claude=<path> or codex=<path>/);
});

test("multiple source roots per provider are scanned, deduplicated, and reported separately", async () => {
  const repoRoot = await makeRoot("agentify-analyze-multiroot-");
  const claudeRootA = path.join(repoRoot, "history", "claude-a");
  const claudeRootB = path.join(repoRoot, "history", "claude-b");
  const codexRoot = path.join(repoRoot, "history", "codex");
  await writeClaudeFixtures(claudeRootA, repoRoot);
  await writeCodexFixtures(codexRoot, repoRoot);
  // Second claude root holds one extra in-repo session.
  const extraDir = path.join(claudeRootB, "-fixture-project");
  await fs.mkdir(extraDir, { recursive: true });
  await fs.writeFile(path.join(extraDir, "extra.jsonl"), `${claudeAssistant({ ts: minutesAgo(50), requestId: "req_extra", usage: USAGE, cwd: repoRoot })}\n`);

  const report = await buildSessionAnalysis(repoRoot, {
    claudeRoots: [claudeRootA, claudeRootB, claudeRootA], // duplicate collapses
    codexRoot,
    days: 30,
  });
  assert.equal(report.totals.sessions, 5, "3 from root A + 1 from root B + 1 codex");
  const claudeSources = report.sources.filter((source) => source.provider === "claude");
  assert.equal(claudeSources.length, 2, "each claude root reports its own coverage");
  assert.equal(claudeSources.find((source) => source.root.endsWith("claude-b")).sessions, 1);

  const manifest = await buildAnalysisManifest(repoRoot, { claudeRoots: [claudeRootA, claudeRootB], codexRoot, days: 30 });
  assert.equal(manifest.sources.filter((source) => source.provider === "claude").length, 2);
});

test("overlapping roots never double count the same session file", async () => {
  const repoRoot = await makeRoot("agentify-analyze-overlap-");
  const codexRoot = path.join(repoRoot, "history", "codex");
  await writeCodexFixtures(codexRoot, repoRoot);
  const baseline = await buildSessionAnalysis(repoRoot, { providers: ["codex"], codexRoot, days: 30 });

  // The same store passed twice: once as-is and once via a nested subdir.
  const overlapping = await buildSessionAnalysis(repoRoot, {
    providers: ["codex"],
    codexRoots: [codexRoot, path.join(codexRoot, "2026")],
    days: 30,
  });
  assert.equal(overlapping.totals.sessions, baseline.totals.sessions);
  assert.deepEqual(overlapping.totals.usage, baseline.totals.usage);
  const nested = overlapping.sources.find((source) => source.root.endsWith("2026"));
  assert.equal(nested.files_discovered, 0, "files already claimed by the outer root are not re-counted");
});

test("cache sweep is scoped to scanned roots so switching stores keeps other entries", async () => {
  const repoRoot = await makeRoot("agentify-analyze-sweepscope-");
  const codexRootA = path.join(repoRoot, "history", "codex-a");
  const codexRootB = path.join(repoRoot, "history", "codex-b");
  const cacheRoot = path.join(repoRoot, "cache", "session-analysis");
  await writeCodexFixtures(codexRootA, repoRoot);
  await writeCodexFixtures(codexRootB, repoRoot);

  await buildSessionAnalysis(repoRoot, { providers: ["codex"], codexRoot: codexRootA, cacheRoot, days: 30 });
  await buildSessionAnalysis(repoRoot, { providers: ["codex"], codexRoot: codexRootB, cacheRoot, days: 30 });
  const afterBoth = (await fs.readdir(cacheRoot)).length;
  assert.equal(afterBoth, 4, "both stores keep their entries");

  // Re-scanning store A must not evict store B's entries...
  const rescanA = await buildSessionAnalysis(repoRoot, { providers: ["codex"], codexRoot: codexRootA, cacheRoot, days: 30 });
  assert.equal(rescanA.coverage.cache.pruned, 0);
  assert.equal(rescanA.coverage.cache.hits, 2);
  assert.equal((await fs.readdir(cacheRoot)).length, 4);

  // ...but deleting a file inside the scanned store still sweeps it.
  await fs.rm(path.join(codexRootA, "2026", "07", "14", "rollout-2026-07-14-cx2.jsonl"));
  const afterDelete = await buildSessionAnalysis(repoRoot, { providers: ["codex"], codexRoot: codexRootA, cacheRoot, days: 30 });
  assert.equal(afterDelete.coverage.cache.pruned, 1);
  assert.equal((await fs.readdir(cacheRoot)).length, 3);
});

test("inline --flag=value parsing keeps '=' inside the value", async () => {
  const { parseArgs } = await import("../src/core/cli-args.js");
  const args = parseArgs(["analyze", "--source-root=codex=./fixtures/codex", "--source-root", "claude=./a=b"]);
  assert.deepEqual(args.sourceRoot, ["codex=./fixtures/codex", "claude=./a=b"]);
});

test("progress renders throttled TTY lines to stderr and clears on finish", () => {
  const writes = [];
  const stream = { isTTY: true, write: (chunk) => writes.push(chunk) };
  let clock = 0;
  const renderer = createProgressRenderer({ stream, enabled: true, intervalMs: 80, now: () => clock });

  renderer.update({ provider: "claude", filesDone: 1, filesTotal: 10, bytesDone: 1_000_000, sessions: 1 });
  clock += 10;
  renderer.update({ provider: "claude", filesDone: 2, filesTotal: 10, bytesDone: 2_000_000, sessions: 2 });
  clock += 200;
  renderer.update({ provider: "claude", filesDone: 5, filesTotal: 10, bytesDone: 5_000_000, sessions: 5 });
  renderer.update({ provider: "claude", filesDone: 10, filesTotal: 10, bytesDone: 9_500_000, sessions: 8 });
  renderer.finish();

  // Throttling: the 10ms-later update was skipped; the final update always renders.
  assert.equal(writes.filter((chunk) => chunk.includes("file(s)")).length, 3);
  assert.ok(writes.some((chunk) => chunk.includes("claude 10/10 file(s)")));
  assert.ok(writes.every((chunk) => chunk.startsWith("\r")), "progress must overwrite one line, not scroll");
  // finish() clears the line.
  assert.match(writes[writes.length - 1], /^\r +\r$/);

  // Disabled renderer (non-TTY or --no-progress) emits nothing at all.
  const silentWrites = [];
  const silent = createProgressRenderer({ stream: { isTTY: false, write: (chunk) => silentWrites.push(chunk) } });
  silent.update({ provider: "codex", filesDone: 1, filesTotal: 2, bytesDone: 10, sessions: 1 });
  silent.finish();
  assert.equal(silentWrites.length, 0);
});

test("buildSessionAnalysis reports per-provider progress with totals", async () => {
  const repoRoot = await makeRoot("agentify-analyze-progress-");
  const claudeRoot = path.join(repoRoot, "history", "claude");
  const codexRoot = path.join(repoRoot, "history", "codex");
  await writeClaudeFixtures(claudeRoot, repoRoot);
  await writeCodexFixtures(codexRoot, repoRoot);
  const updates = [];
  await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot, days: 30, onProgress: (update) => updates.push(update) });

  const claudeUpdates = updates.filter((update) => update.provider === "claude");
  const codexUpdates = updates.filter((update) => update.provider === "codex");
  assert.equal(claudeUpdates.length, 4, "one progress tick per discovered claude file");
  assert.equal(codexUpdates.length, 2);
  const last = claudeUpdates[claudeUpdates.length - 1];
  assert.equal(last.filesDone, last.filesTotal);
  assert.ok(last.bytesDone > 0);
  assert.equal(last.sessions, 3, "foreign-repo session stays out of scope");
});

test("incremental cache: second scan hits, edits invalidate, --no-cache bypasses", async () => {
  const repoRoot = await makeRoot("agentify-analyze-cache-");
  const claudeRoot = path.join(repoRoot, "history", "claude");
  const codexRoot = path.join(repoRoot, "history", "codex");
  const cacheRoot = path.join(repoRoot, "cache", "session-analysis");
  await writeClaudeFixtures(claudeRoot, repoRoot);
  await writeCodexFixtures(codexRoot, repoRoot);
  const options = { claudeRoot, codexRoot, cacheRoot, days: 30 };

  const first = await buildSessionAnalysis(repoRoot, options);
  assert.equal(first.coverage.cache.enabled, true);
  assert.equal(first.coverage.cache.hits, 0);
  assert.ok(first.coverage.cache.misses >= 6, "first scan should miss for every parsed file");

  const second = await buildSessionAnalysis(repoRoot, options);
  assert.equal(second.coverage.cache.misses, 0);
  assert.equal(second.coverage.cache.hits, first.coverage.cache.misses);
  // Cached and fresh scans must produce identical analysis.
  assert.deepEqual(second.totals, first.totals);
  assert.deepEqual(second.scorecard, first.scorecard);
  // Coverage stays auditable: warm files are counted as from-cache, not parsed.
  const warmClaude = second.sources.find((source) => source.provider === "claude");
  assert.equal(warmClaude.files_parsed, 0);
  assert.equal(warmClaude.bytes_parsed, 0);
  assert.ok(warmClaude.files_from_cache >= 4);

  // Touching one file invalidates exactly that entry.
  const target = path.join(claudeRoot, "-fixture-project", "s2.jsonl");
  const content = await fs.readFile(target, "utf8");
  await fs.writeFile(target, `${content}${claudeAssistant({ ts: minutesAgo(1), requestId: "req_s2b", usage: USAGE, cwd: repoRoot })}\n`);
  const third = await buildSessionAnalysis(repoRoot, options);
  assert.equal(third.coverage.cache.misses, 1);
  assert.equal(third.coverage.cache.hits, first.coverage.cache.misses - 1);

  // Cache entries hold only normalized facts, never transcript content.
  const cacheFiles = await fs.readdir(cacheRoot);
  assert.ok(cacheFiles.length >= 6);
  for (const name of cacheFiles) {
    const raw = await fs.readFile(path.join(cacheRoot, name), "utf8");
    assert.ok(!raw.includes("supersecret123"), "secret leaked into cache");
    assert.ok(!raw.includes("SUPER SECRET"), "prompt leaked into cache");
    assert.ok(!raw.includes("internal.example.com"), "command leaked into cache");
  }

  const bypass = await buildSessionAnalysis(repoRoot, { ...options, cache: false });
  assert.equal(bypass.coverage.cache.enabled, false);
  assert.equal(bypass.coverage.cache.hits, 0);
  assert.deepEqual(bypass.totals, third.totals);

  // Without a cache root (default in unit tests), caching is off.
  const noRoot = await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot, days: 30 });
  assert.equal(noRoot.coverage.cache.enabled, false);

  // A structurally corrupt entry is discarded and re-parsed, not trusted.
  const cacheEntries = await fs.readdir(cacheRoot);
  const victim = path.join(cacheRoot, cacheEntries[0]);
  const corrupt = JSON.parse(await fs.readFile(victim, "utf8"));
  corrupt.session = {};
  await fs.writeFile(victim, JSON.stringify(corrupt));
  const healed = await buildSessionAnalysis(repoRoot, options);
  assert.equal(healed.coverage.cache.invalidated, 1);
  assert.deepEqual(healed.totals, third.totals);

  // Deleting a source file sweeps its cache entry on the next scan.
  await fs.unlink(path.join(claudeRoot, "-fixture-project", "s3.jsonl"));
  const swept = await buildSessionAnalysis(repoRoot, options);
  assert.equal(swept.coverage.cache.pruned, 1);
  const remaining = await fs.readdir(cacheRoot);
  assert.equal(remaining.length, cacheEntries.length - 1);
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
  let opened = false;
  const out = await captureStdout(() => runCli([
    "analyze", "--root", repoRoot, "--yes", "--json",
    "--claude-root", claudeRoot, "--codex-root", codexRoot,
  ], {
    openBrowser: async () => { opened = true; },
  }));
  const parsed = JSON.parse(out);
  assert.equal(parsed.schema_version, "session-analysis-v1");
  assert.equal(parsed.privacy.ai_spend_usd, 0);
  assert.ok(parsed.roast.text.length > 0);
  assert.equal(opened, false);
});

test("cli: analyze refuses to scan non-interactively without --yes", async () => {
  const { repoRoot, claudeRoot, codexRoot } = await fixtureReport();
  await assert.rejects(
    () => runCli(["analyze", "--root", repoRoot, "--json", "--claude-root", claudeRoot, "--codex-root", codexRoot]),
    /explicit consent/,
  );
});

test("cli: analyze defaults to HTML and opens the generated report", async () => {
  const { repoRoot, claudeRoot, codexRoot } = await fixtureReport();
  const outputPath = path.join(repoRoot, "agentify-session-analysis.html");
  const opened = [];
  await captureStdout(() => runCli([
    "analyze", "--root", repoRoot, "--yes",
    "--claude-root", claudeRoot, "--codex-root", codexRoot,
  ], {
    openBrowser: async (targetPath) => opened.push(targetPath),
  }));
  const html = await fs.readFile(outputPath, "utf8");
  assert.ok(html.includes('data-testid="agentify-analyze-report"'));
  assert.deepEqual(opened, [outputPath]);
});

test("cli: analyze --format html writes a self-contained themed report", async () => {
  const { repoRoot, claudeRoot, codexRoot } = await fixtureReport();
  const outputPath = path.join(repoRoot, "analysis.html");
  let opened = false;
  await captureStdout(() => runCli([
    "analyze", "--root", repoRoot, "--yes", "--format", "html", "--output", outputPath, "--no-open",
    "--claude-root", claudeRoot, "--codex-root", codexRoot,
  ], {
    openBrowser: async () => { opened = true; },
  }));
  const html = await fs.readFile(outputPath, "utf8");
  assert.ok(html.includes('data-testid="agentify-analyze-report"'));
  assert.ok(!html.includes("supersecret123"));
  assert.equal(opened, false);
});

test("insights packet is sanitized, invocations carry only safety flags, output is strictly validated", async () => {
  const {
    buildInsightsPacket, packetPreview, validateInsightsOutput, buildInsightInvocation,
    runCliInsights, resolveInsightsMode, resolveInsightsProviders,
  } = await import("../src/core/session-analysis/insights.js");
  const { report } = await fixtureReport();

  // Packet: only normalized facts; fixture secrets/prompts cannot appear.
  const packet = buildInsightsPacket(report);
  const serialized = JSON.stringify(packet);
  for (const secret of ["supersecret123", "SUPER SECRET", "internal.example.com", "needle0"]) {
    assert.ok(!serialized.includes(secret), `packet leaked: ${secret}`);
  }
  assert.ok(!serialized.includes("session_id"), "packet must not carry per-session ids");
  // Repo file paths (reread top-list, rule top_files) must not travel.
  assert.ok(!serialized.includes("src/core/models.js"), "packet leaked a repo file path");
  assert.ok(!serialized.includes('"top"'), "packet carries the path-bearing top list");
  assert.equal(packet.patterns.files_reread_across_sessions.count, report.patterns.files_reread_across_sessions.count);
  assert.equal(packet.schema, "insights-packet-v1");
  assert.ok(packetPreview(packet).bytes > 0);

  // Invocations: exactly the safety flags, never a bypass flag.
  const claude = buildInsightInvocation("claude", { model: null, budgetUsd: 0.25, timeoutSec: 60, schemaPath: "/tmp/s.json" });
  assert.ok(claude.args.includes("--no-session-persistence"));
  assert.ok(claude.args.includes("--max-budget-usd"));
  assert.deepEqual(claude.args[claude.args.indexOf("--tools") + 1], "", "--tools \"\" disables all tools");
  assert.ok(claude.args.includes("--safe-mode"), "user hooks/MCP/instructions must stay out of the run");
  assert.equal(claude.args[claude.args.indexOf("--model") + 1], "haiku", "insights default to the light tier");
  assert.match(claude.args[claude.args.indexOf("--json-schema") + 1], /^\{/, "schema is passed inline, not as a path");
  const codex = buildInsightInvocation("codex", { model: null, budgetUsd: 0.25, timeoutSec: 60, schemaPath: "/tmp/s.json" });
  assert.ok(codex.args.includes("--ephemeral"));
  assert.ok(codex.args.includes("--ignore-user-config"));
  assert.deepEqual(codex.args[codex.args.indexOf("--sandbox") + 1], "read-only");
  for (const invocation of [claude, codex]) {
    assert.ok(!invocation.args.some((arg) => /dangerously|bypass/.test(arg)), "bypass flag in insight invocation");
  }

  // Validation: ungrounded or unknown output is rejected, not repaired.
  const good = { summary: "ok", insights: [{ title: "t", explanation: "e", category: "search", grounded_in: ["patterns.grep_like"], confidence: "medium" }] };
  assert.equal(validateInsightsOutput(good, packet).valid, true);
  assert.equal(validateInsightsOutput({ ...good, extra: 1 }, packet).valid, false);
  assert.equal(validateInsightsOutput({ summary: "ok", insights: [{ ...good.insights[0], grounded_in: ["made.up.field"] }] }, packet).valid, false);
  assert.equal(validateInsightsOutput({ summary: "ok", insights: [{ ...good.insights[0], category: "hacking" }] }, packet).valid, false);
  assert.equal(validateInsightsOutput({ summary: "ok", insights: [{ ...good.insights[0], suggested_command: "rm -rf /" }] }, packet).valid, false);
  // Schema limits are enforced, not just declared.
  assert.equal(validateInsightsOutput({ summary: "x".repeat(601), insights: good.insights }, packet).valid, false);
  assert.equal(validateInsightsOutput({ summary: "ok", insights: [{ ...good.insights[0], title: "t".repeat(121) }] }, packet).valid, false);
  assert.equal(validateInsightsOutput({ summary: "ok", insights: [{ ...good.insights[0], explanation: "e".repeat(501) }] }, packet).valid, false);
  assert.equal(validateInsightsOutput({ summary: "ok", insights: [{ ...good.insights[0], grounded_in: Array(7).fill("patterns.grep_like") }] }, packet).valid, false);
  // Cost coverage: a provider reporting no cost makes the total a floor.
  const noCostExec = async () => ({ stdout: JSON.stringify({ result: JSON.stringify(good) }) });
  const floor = await runCliInsights({ providers: ["claude"], packet, exec: noCostExec });
  assert.match(floor.cost_coverage, /partial/);

  // Fake-exec end-to-end: claude envelope parsed, cost recorded separately.
  const fakeExec = async (command, args) => {
    assert.equal(command, "claude");
    assert.ok(args.join(" ").includes("PACKET START"), "prompt must delimit the packet as data");
    return { stdout: JSON.stringify({ result: JSON.stringify(good), total_cost_usd: 0.03 }) };
  };
  const outcome = await runCliInsights({ providers: ["claude"], packet, exec: fakeExec });
  assert.equal(outcome.results[0].ok, true);
  assert.equal(outcome.total_cost_usd, 0.03);
  assert.match(outcome.note, /agreement, not proof/);

  // A provider whose output fails validation fails closed.
  const badExec = async () => ({ stdout: JSON.stringify({ result: JSON.stringify({ summary: "x", insights: [{ title: "t", explanation: "e", category: "search", grounded_in: ["nope"], confidence: "low" }] }) }) });
  const rejected = await runCliInsights({ providers: ["claude"], packet, exec: badExec });
  assert.equal(rejected.results[0].ok, false);
  assert.match(rejected.results[0].error, /unknown packet field/);

  assert.equal(resolveInsightsMode(undefined), "deterministic");
  assert.deepEqual(resolveInsightsProviders("both"), ["claude", "codex"]);
  assert.throws(() => resolveInsightsMode("remote"), /--insights must be one of/);
});

test("cli: analyze --insights cli --insights-dry-run prints the packet and invokes nothing", async () => {
  const { repoRoot, claudeRoot, codexRoot } = await fixtureReport();
  const out = await captureStdout(() => runCli([
    "analyze", "--root", repoRoot, "--yes", "--json",
    "--claude-root", claudeRoot, "--codex-root", codexRoot,
    "--insights", "cli", "--insights-provider", "both", "--insights-dry-run",
  ]));
  const parsed = JSON.parse(out);
  assert.equal(parsed.insights_dry_run, true);
  assert.equal(parsed.packet.schema, "insights-packet-v1");
  assert.equal(parsed.plan.length, 2);
  assert.ok(parsed.plan.every((entry) => entry.args.includes("<packet prompt>")), "prompt is a placeholder in the plan");
  assert.ok(parsed.plan.find((entry) => entry.provider === "codex").enforcement.includes("no native USD cap"));
  assert.ok(!out.includes("supersecret123"));
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
