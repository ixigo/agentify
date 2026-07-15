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

function syntheticSession({ calls = 0, byName = {}, writes = 0, failed = 0, models = [], userTurns = 0, outputTokens = null, cacheRead = null, freshInput = null, activeMs = 5 * 60 * 1000, shell = {} } = {}) {
  return {
    session_id: "synthetic",
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
  assert.ok(html.includes("main:has(#f-provider-claude:checked)"), "CSS-only filter rules missing");
  assert.ok(!html.includes("<script"), "filters must not require a script tag");
});

test("cost estimates use exact model + effective date and never claim billed spend", async () => {
  const { estimateSessionCost, buildCostSummary, priceEntryFor } = await import("../src/core/session-analysis/pricing.js");
  const usage = { fresh_input_tokens: 1_000_000, cache_read_tokens: 2_000_000, cache_write_tokens: 100_000, output_tokens: 500_000, reasoning_output_tokens: null };

  // Dated snapshot suffix maps to the same priced model.
  const haiku = estimateSessionCost({ models: ["claude-haiku-4-5-20251001"], started_at: "2026-07-01T00:00:00Z", usage });
  // 1*1 + 2*0.1 + 0.1*1.25 + 0.5*5 = 3.825
  assert.equal(haiku.estimated_usd, 3.825);
  assert.equal(haiku.basis, "versioned-price-estimate");

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
  assert.ok(summary.coverage.unpriced_reasons["no list price for mystery-9"]);
  assert.match(summary.note, /NOT billed spend/);
});

test("report carries per-session estimates and labeled totals in all formats", async () => {
  const { report } = await fixtureReport();
  // Fixture models: claude-fable-5 (no list price) and gpt-5.2-codex (priced).
  assert.equal(report.totals.cost.basis, "versioned-price-estimate");
  assert.equal(report.totals.cost.coverage.sessions_priced, 1);
  assert.ok(report.totals.cost.coverage.unpriced_reasons["no list price for claude-fable-5"]);
  const codexRow = report.sessions.find((row) => row.provider === "codex");
  assert.ok(codexRow.cost_estimate_usd > 0);
  assert.equal(report.sessions.find((row) => row.provider === "claude").cost_estimate_usd, null);

  const text = renderAnalysisText(report);
  assert.match(text, /est\. \$[\d.]+ list price, 1\/4 session\(s\) priced — not billed spend/);
  const html = renderAnalysisHtml(report, { projectName: "fixture" });
  assert.ok(html.includes("not billed spend"));
  assert.ok(html.includes("Est. $ (list)"));
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
