import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildStatsReport, estimateTokens, recordDelegation, renderStatsReport } from "../src/core/stats.js";
import { parseClaudeJsonOutput, runDelegate } from "../src/core/models.js";
import { trackEvent } from "../src/core/ctx.js";

test("estimateTokens approximates by character count", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("x".repeat(400)), 100);
});

test("parseClaudeJsonOutput extracts result, usage, and cost; rejects non-envelopes", () => {
  const parsed = parseClaudeJsonOutput(JSON.stringify({
    type: "result",
    result: "  the answer  ",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 },
  }));
  assert.equal(parsed.output, "the answer");
  assert.equal(parsed.input_tokens, 150);
  assert.equal(parsed.output_tokens, 20);
  assert.equal(parsed.cost_usd, 0.0123);

  assert.equal(parseClaudeJsonOutput("plain text output"), null);
  assert.equal(parseClaudeJsonOutput(JSON.stringify({ type: "result" })), null);
  assert.equal(parseClaudeJsonOutput(""), null);
});

test("parseClaudeJsonOutput keeps cache categories separate and resolves the model from modelUsage", () => {
  const parsed = parseClaudeJsonOutput(JSON.stringify({
    type: "result",
    result: "done",
    total_cost_usd: 0.2,
    usage: {
      input_tokens: 1000,
      cache_creation_input_tokens: 4000,
      cache_read_input_tokens: 500000,
      output_tokens: 800,
    },
    modelUsage: { "claude-haiku-4-5-20251001": { costUSD: 0.2 } },
  }));
  assert.equal(parsed.usage.fresh_input_tokens, 1000);
  assert.equal(parsed.usage.cache_write_tokens, 4000);
  assert.equal(parsed.usage.cache_read_tokens, 500000);
  assert.equal(parsed.usage.output_tokens, 800);
  assert.equal(parsed.input_tokens, 505000);
  assert.equal(parsed.resolved_model, "claude-haiku-4-5-20251001");

  // Multiple resolved models (subagents) is ambiguous: stays null, not guessed.
  const multi = parseClaudeJsonOutput(JSON.stringify({
    type: "result",
    result: "done",
    usage: {},
    modelUsage: { "model-a": {}, "model-b": {} },
  }));
  assert.equal(multi.resolved_model, null);
  assert.deepEqual(multi.resolved_models, ["model-a", "model-b"]);
});

test("buildStatsReport aggregates delegations by kind and target within the window", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-stats-"));
  try {
    await recordDelegation(dir, {
      kind: "quick", provider: "claude", model: "haiku", exit_code: 0,
      duration_ms: 1000, input_tokens: 100, output_tokens: 50, tokens_estimated: false, cost_usd: 0.01,
    });
    await recordDelegation(dir, {
      kind: "quick", provider: "claude", model: "haiku", exit_code: 1, used_fallback: true,
      duration_ms: 500, input_tokens: 200, output_tokens: 10, tokens_estimated: true, cost_usd: null,
    });
    await recordDelegation(dir, {
      kind: "review", provider: "codex", model: null, exit_code: 0,
      duration_ms: 3000, input_tokens: 400, output_tokens: 300, tokens_estimated: true, cost_usd: null,
    });
    await trackEvent(dir, {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: { exit_code: 1, stderr: "boom" },
    });

    const report = await buildStatsReport(dir, { days: 7 });
    assert.equal(report.delegations.totals.count, 3);
    assert.equal(report.delegations.totals.failures, 1);
    assert.equal(report.delegations.totals.fallbacks, 1);
    assert.equal(report.delegations.totals.input_tokens, 700);
    assert.equal(report.delegations.totals.cost_usd, 0.01);
    assert.equal(report.delegations.totals.costed_records, 1);
    assert.equal(report.delegations.by_kind.quick.count, 2);
    assert.equal(report.delegations.by_kind.review.count, 1);
    assert.ok(report.delegations.by_target["claude/haiku"]);
    assert.ok(report.delegations.by_target.codex);
    assert.equal(report.sessions.commands, 1);
    assert.equal(report.sessions.failed_commands, 1);

    const rendered = renderStatsReport(report);
    assert.match(rendered, /quick: 2 run\(s\)/);
    assert.match(rendered, /estimates/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildStatsReport excludes records outside the window and handles empty stores", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-stats-window-"));
  try {
    const empty = await buildStatsReport(dir, {});
    assert.equal(empty.delegations.totals.count, 0);
    assert.match(renderStatsReport(empty), /none recorded/);

    // Write an old record directly (recordDelegation always stamps now).
    const { resolveDelegationsPath } = await import("../src/core/stats.js");
    const old = { ts: "2020-01-01T00:00:00Z", kind: "quick", provider: "claude", model: "haiku", exit_code: 0, input_tokens: 1, output_tokens: 1 };
    await fs.mkdir(path.dirname(resolveDelegationsPath(dir)), { recursive: true });
    await fs.appendFile(resolveDelegationsPath(dir), `${JSON.stringify(old)}\n`, "utf8");
    const report = await buildStatsReport(dir, { days: 30 });
    assert.equal(report.delegations.totals.count, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildStatsReport separates cache categories, reports percentiles, daily trend, and marks legacy records", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-stats-v2-"));
  try {
    const { resolveDelegationsPath } = await import("../src/core/stats.js");
    await fs.mkdir(path.dirname(resolveDelegationsPath(dir)), { recursive: true });
    const today = new Date().toISOString();
    const v2 = (overrides) => JSON.stringify({
      ts: today,
      schema: "delegation-v2",
      kind: "quick",
      provider: "claude",
      model: "haiku",
      exit_code: 0,
      tokens_estimated: false,
      ...overrides,
    });
    const legacy = JSON.stringify({
      ts: today, kind: "quick", provider: "claude", model: "haiku", exit_code: 0,
      input_tokens: 100, output_tokens: 10, cost_usd: 0.01,
    });
    const lines = [
      v2({
        duration_ms: 1000, input_tokens: 505000, output_tokens: 800, cost_usd: 0.2,
        usage: { fresh_input_tokens: 1000, cache_read_tokens: 500000, cache_write_tokens: 4000, output_tokens: 800 },
        used_fallback: true, fallback_reason: "provider_unavailable",
      }),
      v2({
        duration_ms: 9000, input_tokens: 2000, output_tokens: 100,
        usage: { fresh_input_tokens: 2000, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 100 },
        budget_stop_reason: "max_turns", exit_code: 1,
      }),
      legacy,
      "{corrupt json line",
      "null",
      "[1,2]",
      '"just a string"',
    ];
    await fs.appendFile(resolveDelegationsPath(dir), `${lines.join("\n")}\n`, "utf8");

    const report = await buildStatsReport(dir, { days: 7 });
    assert.equal(report.schema_version, "stats-v2");
    assert.equal(report.delegations.totals.count, 3);
    assert.equal(report.delegations.totals.fresh_input_tokens, 3000);
    assert.equal(report.delegations.totals.cache_read_tokens, 500000);
    assert.equal(report.delegations.totals.cache_write_tokens, 4000);
    assert.equal(report.delegations.totals.legacy_records, 1);
    assert.equal(report.delegations.totals.budget_stops, 1);
    assert.equal(report.delegations.latency.p50_ms, 1000);
    assert.equal(report.delegations.latency.p95_ms, 9000);
    assert.ok(Math.abs(report.delegations.cache.read_ratio - 500000 / 507000) < 1e-9);
    assert.equal(report.delegations.cost_coverage.reported_records, 2);
    assert.equal(report.delegations.cost_coverage.total_records, 3);
    assert.equal(report.delegations.fallback_reasons.provider_unavailable, 1);
    assert.equal(report.delegations.daily.length, 1);
    assert.equal(report.delegations.daily[0].runs, 3);
    assert.ok(Math.abs(report.delegations.daily[0].cost_usd - 0.21) < 1e-9);

    const rendered = renderStatsReport(report);
    assert.match(rendered, /cache: /);
    assert.match(rendered, /P50 /);
    assert.match(rendered, /legacy aggregate/);
    assert.match(rendered, /budget-stopped/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("delegation telemetry stores a prompt hash but never the prompt text", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-stats-privacy-"));
  try {
    const secretTask = "rotate the AWS key sk-super-secret-value in prod";
    await runDelegate(dir, {}, "quick", secretTask, {
      runtime: {
        commandExists: async (command) => command === "claude",
        exec: async () => ({ code: 0, stdout: "ok", stderr: "" }),
      },
    });
    const { resolveDelegationsPath } = await import("../src/core/stats.js");
    const line = (await fs.readFile(resolveDelegationsPath(dir), "utf8")).trim();
    assert.ok(!line.includes("sk-super-secret-value"));
    assert.ok(!line.includes(secretTask));
    const record = JSON.parse(line);
    assert.equal(record.schema, "delegation-v2");
    assert.match(record.prompt_sha256, /^[0-9a-f]{16}$/);
    assert.ok(record.run_id);
    assert.equal(record.requested_profile, null);
    assert.ok(record.latency.provider_ms >= 0);
    assert.equal(record.cost_source, "unreported");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runDelegate parses claude JSON output and logs a delegation record", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-stats-delegate-"));
  try {
    const stdout = JSON.stringify({
      type: "result",
      result: "looks good",
      total_cost_usd: 0.002,
      usage: { input_tokens: 300, output_tokens: 12 },
    });
    const result = await runDelegate(dir, {}, "quick", "check something", {
      runtime: {
        commandExists: async (command) => command === "claude",
        exec: async () => ({ code: 0, stdout, stderr: "" }),
      },
    });
    assert.equal(result.output, "looks good");
    assert.equal(result.cost_usd, 0.002);

    const { resolveDelegationsPath } = await import("../src/core/stats.js");
    const lines = (await fs.readFile(resolveDelegationsPath(dir), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.kind, "quick");
    assert.equal(record.input_tokens, 300);
    assert.equal(record.output_tokens, 12);
    assert.equal(record.tokens_estimated, false);
    assert.equal(record.cost_usd, 0.002);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runDelegate falls back to text output and token estimates for codex", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-stats-codex-"));
  try {
    const result = await runDelegate(dir, {}, "review", "", {
      runtime: {
        commandExists: async (command) => command === "codex",
        exec: async () => ({ code: 0, stdout: "review output text", stderr: "" }),
      },
    });
    assert.equal(result.output, "review output text");
    assert.equal(result.cost_usd, undefined);

    const { resolveDelegationsPath } = await import("../src/core/stats.js");
    const record = JSON.parse((await fs.readFile(resolveDelegationsPath(dir), "utf8")).trim());
    assert.equal(record.tokens_estimated, true);
    assert.ok(record.input_tokens > 0);
    assert.equal(record.cost_usd, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
