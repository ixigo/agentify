import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_MODEL_ROUTES,
  buildDelegateCommand,
  buildDelegatePrompt,
  describeModelRoutes,
  normalizeRouteKind,
  parseCodexJsonOutput,
  pickRouteTarget,
  resolveModelRoutes,
  runDelegate,
} from "../src/core/models.js";
import { checkRollingBudget, resolveBudgetPolicy, resolveRouteLimits } from "../src/core/budget.js";
import { recordDelegation } from "../src/core/stats.js";

test("resolveModelRoutes returns defaults and applies config overrides", () => {
  const defaults = resolveModelRoutes({});
  assert.deepEqual(Object.keys(defaults).sort(), Object.keys(DEFAULT_MODEL_ROUTES).sort());
  assert.equal(defaults.quick.provider, "claude");
  assert.equal(defaults.quick.model, "haiku");
  assert.equal(defaults.review.provider, "codex");

  const overridden = resolveModelRoutes({
    models: {
      routes: {
        quick: { model: "sonnet" },
        docs: { provider: "codex", model: "custom-model", use: "docs work" },
      },
    },
  });
  assert.equal(overridden.quick.model, "sonnet");
  assert.equal(overridden.quick.provider, "claude");
  assert.equal(overridden.docs.provider, "codex");
  assert.equal(overridden.docs.model, "custom-model");
  // Custom routes are not an uncapped path: they get default ceilings.
  assert.equal(overridden.docs.maxBudgetUsd, 1.00);
  assert.equal(overridden.docs.maxTurns, 30);
  assert.equal(overridden.docs.timeoutSeconds, 600);
});

test("normalizeRouteKind rejects unknown kinds", () => {
  const routes = resolveModelRoutes({});
  assert.equal(normalizeRouteKind("REVIEW", routes), "review");
  assert.throws(() => normalizeRouteKind("bogus", routes), /Unknown delegate kind/);
});

test("pickRouteTarget uses the route provider and falls back across vendors", () => {
  const route = { provider: "codex", model: null };
  assert.deepEqual(
    pickRouteTarget(route, { claude: true, codex: true }),
    { provider: "codex", model: null, fallback: false }
  );
  assert.deepEqual(
    pickRouteTarget(route, { claude: true, codex: false }),
    { provider: "claude", model: "opus", fallback: true }
  );
  assert.equal(pickRouteTarget(route, { claude: false, codex: false }), null);

  const claudeRoute = { provider: "claude", model: "haiku" };
  assert.deepEqual(
    pickRouteTarget(claudeRoute, { claude: false, codex: true }),
    { provider: "codex", model: null, fallback: true }
  );
});

test("buildDelegateCommand builds provider CLI invocations", () => {
  assert.deepEqual(
    buildDelegateCommand({ provider: "claude", model: "haiku" }, "fix typo"),
    ["claude", "-p", "fix typo", "--output-format", "json", "--model", "haiku", "--no-session-persistence"]
  );
  assert.deepEqual(
    buildDelegateCommand({ provider: "claude", model: "haiku" }, "fix typo", { write: true }),
    ["claude", "-p", "fix typo", "--output-format", "json", "--model", "haiku", "--no-session-persistence", "--permission-mode", "acceptEdits"]
  );
  assert.deepEqual(
    buildDelegateCommand({ provider: "codex", model: null }, "review this"),
    ["codex", "exec", "--skip-git-repo-check", "--json", "--sandbox", "read-only", "review this"]
  );
  assert.deepEqual(
    buildDelegateCommand({ provider: "codex", model: "some-model" }, "do it", { write: true, lastMessagePath: "/tmp/last.md" }),
    ["codex", "exec", "--skip-git-repo-check", "--json", "--model", "some-model", "--full-auto", "--output-last-message", "/tmp/last.md", "do it"]
  );
});

test("buildDelegateCommand passes budget ceilings to claude natively and honors session persistence", () => {
  const limits = { maxBudgetUsd: 0.1, maxTurns: 4, effort: "low" };
  assert.deepEqual(
    buildDelegateCommand({ provider: "claude", model: "haiku" }, "task", { limits }),
    [
      "claude", "-p", "task", "--output-format", "json", "--model", "haiku",
      "--max-budget-usd", "0.1", "--max-turns", "4", "--effort", "low", "--no-session-persistence",
    ]
  );
  const persisted = buildDelegateCommand({ provider: "claude", model: null }, "task", { persistSession: true });
  assert.ok(!persisted.includes("--no-session-persistence"));
  // Codex has no native dollar/turn cap; the ceiling is enforced pre-run + timeout.
  const codex = buildDelegateCommand({ provider: "codex", model: null }, "task", { limits });
  assert.ok(!codex.includes("--max-budget-usd"));
  assert.ok(!codex.includes("--max-turns"));
});

test("buildDelegatePrompt frames review prompts and embeds diff sections", () => {
  const review = buildDelegatePrompt("review", "", { diffSection: "## Diff\nabc" });
  assert.match(review, /independent code review/);
  assert.match(review, /## Diff/);

  const quick = buildDelegatePrompt("quick", "rename a variable");
  assert.equal(quick, "rename a variable");
});

test("runDelegate routes through the injected runtime and reports fallback", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-delegate-"));
  try {
    const calls = [];
    const result = await runDelegate(dir, {}, "quick", "fix the typo in README", {
      runtime: {
        commandExists: async (command) => command === "codex",
        exec: async (command, args) => {
          calls.push([command, ...args]);
          return { code: 0, stdout: "done\n", stderr: "" };
        },
      },
    });
    assert.equal(result.kind, "quick");
    assert.equal(result.provider, "codex");
    assert.equal(result.used_fallback, true);
    assert.equal(result.output, "done");
    assert.equal(result.exit_code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "codex");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runDelegate requires a task for non-review kinds and any available provider", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-delegate-err-"));
  try {
    await assert.rejects(
      () => runDelegate(dir, {}, "quick", "", {
        runtime: { commandExists: async () => true, exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
      }),
      /requires a task/
    );
    await assert.rejects(
      () => runDelegate(dir, {}, "quick", "do something", {
        runtime: { commandExists: async () => false },
      }),
      /No available CLI/
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("describeModelRoutes reports availability, resolution, limits, and enforcement", async () => {
  const described = await describeModelRoutes({}, {
    commandExists: async (command) => command === "claude",
  });
  assert.equal(described.providers.claude, true);
  assert.equal(described.providers.codex, false);
  const review = described.routes.find((route) => route.kind === "review");
  assert.equal(review.available, true);
  assert.match(review.resolves_to, /claude\/opus \(fallback\)/);
  const quick = described.routes.find((route) => route.kind === "quick");
  assert.equal(quick.resolves_to, "claude/haiku");

  // Every default route carries a hard ceiling, and the display reports
  // whether the resolved provider can enforce it natively.
  for (const route of described.routes) {
    assert.ok(route.limits.max_budget_usd > 0, `${route.kind} has a dollar ceiling`);
    assert.ok(route.limits.max_turns > 0, `${route.kind} has a turn ceiling`);
    assert.ok(route.limits.timeout_seconds > 0, `${route.kind} has a timeout`);
  }
  assert.equal(quick.enforcement.budget_usd, "native");
  // review falls back to claude here, which enforces natively.
  assert.equal(review.enforcement.budget_usd, "native");
  const codexDescribed = await describeModelRoutes({}, { commandExists: async (command) => command === "codex" });
  const codexReview = codexDescribed.routes.find((route) => route.kind === "review");
  assert.equal(codexReview.enforcement.budget_usd, "pre-run-only");
  assert.equal(codexReview.enforcement.turns, "unavailable");
});

test("resolveBudgetPolicy and resolveRouteLimits validate before any provider work", () => {
  assert.deepEqual(resolveBudgetPolicy({}), { dailyUsd: null, monthlyUsd: null, onLimit: "block" });
  assert.equal(resolveBudgetPolicy({ models: { budget: { dailyUsd: 2, onLimit: "warn" } } }).dailyUsd, 2);
  assert.throws(() => resolveBudgetPolicy({ models: { budget: { dailyUsd: -1 } } }), /positive number/);
  assert.throws(() => resolveBudgetPolicy({ models: { budget: { onLimit: "explode" } } }), /onLimit/);

  const limits = resolveRouteLimits({ maxBudgetUsd: 0.5, maxTurns: 10, timeoutSeconds: 60 }, { maxBudgetUsd: 0.2 });
  assert.equal(limits.maxBudgetUsd, 0.2); // CLI override wins
  assert.equal(limits.maxTurns, 10);
  assert.throws(() => resolveRouteLimits({}, { maxBudgetUsd: "free" }), /positive number/);
  assert.throws(() => resolveRouteLimits({}, { maxBudgetUsd: -0.5 }), /positive number/);
  assert.throws(() => resolveRouteLimits({}, { maxTurns: 2.5 }), /positive integer/);
  // A valueless `--max-budget-usd` flag parses to boolean true; it must fail
  // validation instead of Number(true) granting a $1 ceiling.
  assert.throws(() => resolveRouteLimits({}, { maxBudgetUsd: true }), /explicit value/);
  assert.throws(() => resolveRouteLimits({}, { maxTurns: true }), /explicit value/);
});

test("runDelegate rejects invalid budgets before starting a provider process", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-budget-invalid-"));
  try {
    let execCalls = 0;
    await assert.rejects(
      () => runDelegate(dir, {}, "quick", "task", {
        maxBudgetUsd: -1,
        runtime: { commandExists: async () => true, exec: async () => { execCalls += 1; return { code: 0, stdout: "", stderr: "" }; } },
      }),
      /positive number/
    );
    assert.equal(execCalls, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runDelegate passes route ceilings to claude and CLI overrides take precedence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-budget-argv-"));
  try {
    const calls = [];
    const exec = async (command, args) => { calls.push([command, ...args]); return { code: 0, stdout: "ok", stderr: "" }; };
    await runDelegate(dir, {}, "quick", "task", { runtime: { commandExists: async (c) => c === "claude", exec } });
    let argv = calls[0];
    assert.ok(argv.includes("--max-budget-usd") && argv[argv.indexOf("--max-budget-usd") + 1] === "0.1");
    assert.ok(argv.includes("--max-turns") && argv[argv.indexOf("--max-turns") + 1] === "4");
    assert.ok(argv.includes("--no-session-persistence"));

    const result = await runDelegate(dir, {}, "quick", "task", {
      maxBudgetUsd: 0.05,
      maxTurns: 2,
      effort: "low",
      runtime: { commandExists: async (c) => c === "claude", exec },
    });
    argv = calls[1];
    assert.equal(argv[argv.indexOf("--max-budget-usd") + 1], "0.05");
    assert.equal(argv[argv.indexOf("--max-turns") + 1], "2");
    assert.equal(argv[argv.indexOf("--effort") + 1], "low");
    assert.equal(result.budget_limit, 0.05);
    assert.equal(result.budget_source, "cli");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("fallback preserves the original route ceiling instead of resetting it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-budget-fallback-"));
  try {
    // quick wants claude/haiku with a $0.10 ceiling; only codex is installed.
    const result = await runDelegate(dir, {}, "quick", "task", {
      runtime: {
        commandExists: async (command) => command === "codex",
        exec: async () => ({ code: 0, stdout: "done", stderr: "" }),
      },
    });
    assert.equal(result.used_fallback, true);
    assert.equal(result.provider, "codex");
    assert.equal(result.budget_limit, DEFAULT_MODEL_ROUTES.quick.maxBudgetUsd);
    assert.equal(result.max_turns, DEFAULT_MODEL_ROUTES.quick.maxTurns);

    const { resolveDelegationsPath } = await import("../src/core/stats.js");
    const record = JSON.parse((await fs.readFile(resolveDelegationsPath(dir), "utf8")).trim());
    assert.equal(record.budget_limit, DEFAULT_MODEL_ROUTES.quick.maxBudgetUsd);
    assert.equal(record.fallback_reason, "provider_unavailable");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("rolling caps block new delegations at the limit and warn mode proceeds", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-budget-rolling-"));
  try {
    await recordDelegation(dir, { kind: "quick", provider: "claude", model: "haiku", exit_code: 0, cost_usd: 1.5 });

    const rolling = await checkRollingBudget(dir, { dailyUsd: 1, monthlyUsd: null, onLimit: "block" });
    assert.equal(rolling.exceeded, true);
    assert.equal(rolling.exceeded_window.window, "daily");
    assert.equal(rolling.remaining_usd, 0);

    const under = await checkRollingBudget(dir, { dailyUsd: 5, monthlyUsd: null, onLimit: "block" });
    assert.equal(under.exceeded, false);
    assert.equal(under.remaining_usd, 3.5);

    let execCalls = 0;
    const runtime = {
      commandExists: async (c) => c === "claude",
      exec: async () => { execCalls += 1; return { code: 0, stdout: "ok", stderr: "" }; },
    };
    const blocked = await runDelegate(dir, { models: { budget: { dailyUsd: 1 } } }, "quick", "task", { runtime });
    assert.equal(blocked.status, "budget_blocked");
    assert.equal(blocked.budget_stop_reason, "rolling_daily_cap");
    assert.equal(blocked.exit_code, 2);
    assert.match(blocked.error, /budget blocked/);
    assert.equal(execCalls, 0);

    const warned = await runDelegate(dir, { models: { budget: { dailyUsd: 1, onLimit: "warn" } } }, "quick", "task", { runtime });
    assert.equal(warned.status, "ok");
    assert.match(warned.budget_warning, /reached the models.budget cap/);
    assert.equal(execCalls, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("budget-triggered termination is distinct from provider failure and timeout", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-budget-stop-"));
  try {
    const runtimeFor = (stdout, code = 1, stderr = "") => ({
      commandExists: async (c) => c === "claude",
      exec: async () => ({ code, stdout, stderr }),
    });
    // A run that attempted more turns than allowed ends with an error subtype
    // envelope and possibly no result text: deterministic budget stop.
    const turns = await runDelegate(dir, {}, "quick", "task", {
      runtime: runtimeFor(JSON.stringify({ type: "result", subtype: "error_max_turns", num_turns: 4, usage: { input_tokens: 10, output_tokens: 5 } })),
    });
    assert.equal(turns.status, "budget_stopped");
    assert.equal(turns.budget_stop_reason, "max_turns");

    const budget = await runDelegate(dir, {}, "quick", "task", {
      runtime: runtimeFor(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", result: "partial", usage: {} })),
    });
    assert.equal(budget.status, "budget_stopped");
    assert.equal(budget.budget_stop_reason, "max_budget_usd");

    const timeout = await runDelegate(dir, {}, "quick", "task", {
      runtime: runtimeFor("", 1, "delegate timed out after 120s"),
    });
    assert.equal(timeout.status, "timeout");
    assert.equal(timeout.budget_stop_reason, null);

    const failure = await runDelegate(dir, {}, "quick", "task", { runtime: runtimeFor("boom", 1, "crash") });
    assert.equal(failure.status, "provider_error");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("parseCodexJsonOutput reads usage and model from the JSONL stream without inventing cost", () => {
  const stream = [
    JSON.stringify({ type: "session.created", model: "gpt-5.1-codex" }),
    "not json",
    JSON.stringify({ msg: { info: { total_token_usage: { input_tokens: 900, cached_input_tokens: 600, output_tokens: 40 } } } }),
    JSON.stringify({ msg: { info: { total_token_usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90 } } } }),
  ].join("\n");
  const parsed = parseCodexJsonOutput(stream);
  assert.equal(parsed.input_tokens, 1200);
  assert.equal(parsed.output_tokens, 90);
  assert.equal(parsed.usage.cache_read_tokens, 800);
  assert.equal(parsed.usage.fresh_input_tokens, 400);
  assert.equal(parsed.cost_usd, null);
  assert.equal(parsed.resolved_model, "gpt-5.1-codex");

  assert.equal(parseCodexJsonOutput("plain text output"), null);
  assert.equal(parseCodexJsonOutput(""), null);
});
