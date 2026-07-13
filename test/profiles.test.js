import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CAPABILITY_TIERS,
  DEFAULT_PROFILE_DEFINITIONS,
  MIN_EVIDENCE_ATTEMPTS,
  PROFILE_NAMES,
  ROUTE_POLICY_VERSION,
  buildFallbackChain,
  classifyTaskIntent,
  isAliasModel,
  loadRouteEvidence,
  resolveProfileDefinitions,
  resolveProfileSelection,
  resolveRouteTier,
  selectFromChain,
  selectTier,
} from "../src/core/profiles.js";
import { explainRoute, resolveModelRoutes, resolveRoutePolicy, runDelegate } from "../src/core/models.js";
import { resolveDelegationsPath } from "../src/core/stats.js";

function evidenceWith(models) {
  return { source: "eval-runs", runs_scanned: 3, models };
}

function stats({ attempts = MIN_EVIDENCE_ATTEMPTS, passes, costPerPass = null }) {
  return {
    attempts,
    passes,
    pass_rate: attempts > 0 ? passes / attempts : null,
    cost_per_pass_usd: costPerPass,
    provider_p50_ms: 1000,
    provider_p95_ms: 2000,
    sufficient: attempts >= MIN_EVIDENCE_ATTEMPTS,
  };
}

test("resolveProfileSelection follows cli > env > config > default precedence", () => {
  const config = { models: { profile: "cost" } };
  assert.deepEqual(
    resolveProfileSelection(config, { profile: "performance" }, { AGENTIFY_PROFILE: "balanced" }),
    { name: "performance", source: "cli" }
  );
  assert.deepEqual(
    resolveProfileSelection(config, {}, { AGENTIFY_PROFILE: "balanced" }),
    { name: "balanced", source: "env" }
  );
  assert.deepEqual(resolveProfileSelection(config, {}, {}), { name: "cost", source: "config" });
  assert.deepEqual(resolveProfileSelection({}, {}, {}), { name: "balanced", source: "default" });
  // Case-insensitive, but unknown names fail loudly with their source.
  assert.equal(resolveProfileSelection({}, { profile: "COST" }, {}).name, "cost");
  assert.throws(() => resolveProfileSelection({}, { profile: "turbo" }, {}), /Unknown profile "turbo" \(from cli\)/);
  assert.throws(() => resolveProfileSelection({}, {}, { AGENTIFY_PROFILE: "max" }), /from env/);
});

test("resolveProfileDefinitions merges overrides and validates the contract", () => {
  const defaults = resolveProfileDefinitions({});
  assert.deepEqual(Object.keys(defaults).sort(), [...PROFILE_NAMES].sort());
  assert.equal(defaults.cost.objective, "min_cost_subject_to_quality_floor");
  assert.equal(defaults.balanced.objective, "min_cost_per_pass");
  assert.equal(defaults.performance.objective, "max_pass_rate_subject_to_budget");
  assert.equal(defaults.cost.maxTierRaise, 0);

  const overridden = resolveProfileDefinitions({ models: { profiles: { cost: { qualityFloor: 0.95 } } } });
  assert.equal(overridden.cost.qualityFloor, 0.95);
  assert.equal(overridden.balanced.qualityFloor, DEFAULT_PROFILE_DEFINITIONS.balanced.qualityFloor);

  assert.throws(() => resolveProfileDefinitions({ models: { profiles: { turbo: {} } } }), /Unknown profile "turbo"/);
  assert.throws(() => resolveProfileDefinitions({ models: { profiles: { cost: { qualityFloor: 2 } } } }), /between 0 and 1/);
  assert.throws(() => resolveProfileDefinitions({ models: { profiles: { cost: { maxTierRaise: 5 } } } }), /maxTierRaise/);
});

test("classifyTaskIntent is deterministic and keyword-ordered", () => {
  assert.equal(classifyTaskIntent("review the checkout change").kind, "review");
  assert.equal(classifyTaskIntent("fix the typo in README").kind, "quick");
  assert.equal(classifyTaskIntent("design the migration to the new schema").kind, "heavy");
  assert.equal(classifyTaskIntent("how does the retry queue work?").kind, "research");
  assert.equal(classifyTaskIntent("fix the failing checkout flow").kind, "implement");
  assert.equal(classifyTaskIntent("").kind, "implement");
  // Same input, same answer — and the matched rule is reported for explain.
  const first = classifyTaskIntent("audit the auth module");
  assert.deepEqual(first, classifyTaskIntent("audit the auth module"));
  assert.equal(first.matched_rule, "review");
});

test("route tiers are vendor-neutral and overridable per route", () => {
  assert.equal(resolveRouteTier("quick", {}), "economy");
  assert.equal(resolveRouteTier("heavy", {}), "frontier");
  assert.equal(resolveRouteTier("review", {}), "balanced");
  assert.equal(resolveRouteTier("custom", {}), "balanced");
  assert.equal(resolveRouteTier("quick", { tier: "frontier" }), "frontier");
  assert.throws(() => resolveRouteTier("quick", { tier: "ultra" }), /Unknown capability tier/);
});

test("fallback chains are tier-equivalent and bounded per profile", () => {
  const review = { provider: "codex", model: null };
  // cost: a missing Codex must not raise the cost class — same tier, capped.
  const costChain = buildFallbackChain({ kind: "review", route: review, profileName: "cost" });
  assert.equal(costChain.max_tier, "balanced");
  assert.deepEqual(costChain.entries[1], { provider: "claude", model: "sonnet", tier: "balanced", reason: "provider_unavailable" });

  // performance may allow one bounded tier raise for the chain ceiling, but
  // the fallback entry itself still lands on the selected tier.
  const perfChain = buildFallbackChain({ kind: "review", route: review, profileName: "performance" });
  assert.equal(perfChain.max_tier, "frontier");
  assert.equal(perfChain.max_tier_raise, 1);
  assert.deepEqual(perfChain.entries[1], { provider: "claude", model: "sonnet", tier: "balanced", reason: "provider_unavailable" });

  // heavy is frontier tier in its own right — the fallback keeps it.
  const heavyChain = buildFallbackChain({ kind: "heavy", route: { provider: "claude", model: "opus" }, profileName: "cost" });
  assert.deepEqual(heavyChain.entries[1], { provider: "codex", model: null, tier: "frontier", reason: "provider_unavailable" });

  const target = selectFromChain(costChain, { claude: true, codex: false });
  assert.equal(target.fallback, true);
  assert.equal(target.fallback_reason, "provider_unavailable");
  assert.equal(target.tier, "balanced");
  assert.equal(selectFromChain(costChain, { claude: false, codex: false }), null);
});

test("cost profile downgrades only on sufficient evidence meeting the quality floor", () => {
  const routes = resolveModelRoutes({});
  const definition = resolveProfileDefinitions({}).cost;
  const base = { kind: "implement", route: routes.implement, profileName: "cost", definition };

  // No evidence at all: keep the configured default — no cheap failures.
  const noEvidence = selectTier({ ...base, evidence: evidenceWith({}) });
  assert.equal(noEvidence.selected.tier, "balanced");
  assert.equal(noEvidence.selected.reason, "no_evidence_for_downgrade");

  // Insufficient sample size: still no downgrade.
  const thin = selectTier({
    ...base,
    evidence: evidenceWith({ "claude/haiku": stats({ attempts: 2, passes: 2 }) }),
  });
  assert.equal(thin.selected.tier, "balanced");
  assert.equal(thin.selected.reason, "insufficient_evidence_for_downgrade");

  // Sufficient evidence below the floor: refused.
  const belowFloor = selectTier({
    ...base,
    evidence: evidenceWith({ "claude/haiku": stats({ attempts: 10, passes: 7 }) }),
  });
  assert.equal(belowFloor.selected.tier, "balanced");
  assert.equal(belowFloor.selected.reason, "cheaper_tier_below_quality_floor");

  // Sufficient evidence at/above the floor: the cheaper tier is selected.
  const downgraded = selectTier({
    ...base,
    evidence: evidenceWith({ "claude/haiku": stats({ attempts: 10, passes: 10 }) }),
  });
  assert.equal(downgraded.selected.tier, "economy");
  assert.equal(downgraded.selected.model, "haiku");
  assert.equal(downgraded.selected.reason, "evidence_meets_quality_floor");
});

test("performance profile escalates only on measured improvement, never on price", () => {
  const routes = resolveModelRoutes({});
  const definition = resolveProfileDefinitions({}).performance;
  const base = { kind: "implement", route: routes.implement, profileName: "performance", definition };

  // No evidence: performance does NOT mean "always the most expensive model".
  const noEvidence = selectTier({ ...base, evidence: evidenceWith({}) });
  assert.equal(noEvidence.selected.tier, "balanced");
  assert.equal(noEvidence.selected.reason, "insufficient_evidence_for_escalation");

  // Higher tier measured better with sufficient samples on both sides.
  const escalated = selectTier({
    ...base,
    evidence: evidenceWith({
      "claude/sonnet": stats({ attempts: 10, passes: 7 }),
      "claude/opus": stats({ attempts: 10, passes: 9 }),
    }),
  });
  assert.equal(escalated.selected.tier, "frontier");
  assert.equal(escalated.selected.model, "opus");
  assert.equal(escalated.selected.reason, "evidence_higher_pass_rate");

  // Higher tier measured no better: stay.
  const flat = selectTier({
    ...base,
    evidence: evidenceWith({
      "claude/sonnet": stats({ attempts: 10, passes: 9 }),
      "claude/opus": stats({ attempts: 10, passes: 9 }),
    }),
  });
  assert.equal(flat.selected.tier, "balanced");
  assert.equal(flat.selected.reason, "no_measured_improvement");

  // heavy already sits at the top tier — nothing to escalate to.
  const heavy = selectTier({ kind: "heavy", route: routes.heavy, profileName: "performance", definition, evidence: evidenceWith({}) });
  assert.equal(heavy.selected.tier, "frontier");
  assert.equal(heavy.selected.reason, "route_default");
});

test("balanced profile picks lowest measured cost per pass above the floor, defaulting safely", () => {
  const routes = resolveModelRoutes({});
  const definition = resolveProfileDefinitions({}).balanced;
  const base = { kind: "implement", route: routes.implement, profileName: "balanced", definition };

  // No evidence: identical to today's manual-route behavior.
  const noEvidence = selectTier({ ...base, evidence: evidenceWith({}) });
  assert.equal(noEvidence.selected.tier, "balanced");
  assert.equal(noEvidence.selected.reason, "insufficient_evidence_for_comparison");

  // Cheaper tier with lower cost per pass and pass rate above the floor wins.
  const cheaper = selectTier({
    ...base,
    evidence: evidenceWith({
      "claude/sonnet": stats({ attempts: 10, passes: 9, costPerPass: 0.5 }),
      "claude/haiku": stats({ attempts: 10, passes: 9, costPerPass: 0.1 }),
    }),
  });
  assert.equal(cheaper.selected.tier, "economy");
  assert.equal(cheaper.selected.reason, "evidence_lower_cost_per_pass");

  // A cheaper candidate below the quality floor is excluded.
  const cheapButBad = selectTier({
    ...base,
    evidence: evidenceWith({
      "claude/sonnet": stats({ attempts: 10, passes: 9, costPerPass: 0.5 }),
      "claude/haiku": stats({ attempts: 10, passes: 6, costPerPass: 0.1 }),
    }),
  });
  assert.equal(cheapButBad.selected.tier, "balanced");
});

test("isAliasModel flags aliases and CLI defaults, not pinned IDs", () => {
  assert.equal(isAliasModel("claude", "sonnet"), true);
  assert.equal(isAliasModel("claude", null), true);
  assert.equal(isAliasModel("codex", null), true);
  assert.equal(isAliasModel("claude", "claude-sonnet-5"), false);
  assert.equal(isAliasModel("codex", "gpt-5.1-codex"), false);
});

test("loadRouteEvidence aggregates recorded eval attempts per model", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-evidence-"));
  try {
    const runDir = path.join(dir, ".agentify", "evals", "runs", "20260101-000000-abcdef");
    const order = [];
    for (let index = 0; index < 6; index += 1) {
      const attemptId = `agentify-r${index}`;
      order.push({ attempt_id: attemptId });
      const attemptDir = path.join(runDir, "attempts", attemptId);
      await fs.mkdir(attemptDir, { recursive: true });
      await fs.writeFile(path.join(attemptDir, "result.json"), JSON.stringify({
        model: "sonnet",
        pass: index < 5,
        provider: { cost_usd: 0.2, duration_ms: 1000 + index },
      }));
    }
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify({ schema: "eval-run-v1", plan: { order } }));

    const evidence = await loadRouteEvidence(dir);
    assert.equal(evidence.runs_scanned, 1);
    const sonnet = evidence.models["claude/sonnet"];
    assert.equal(sonnet.attempts, 6);
    assert.equal(sonnet.passes, 5);
    assert.equal(sonnet.sufficient, true);
    assert.equal(sonnet.cost_per_pass_usd, Number((1.2 / 5).toFixed(4)));
    assert.ok(sonnet.provider_p95_ms >= sonnet.provider_p50_ms);

    // A repo with no eval runs yields empty evidence, not an error.
    const empty = await loadRouteEvidence(path.join(dir, "nowhere"));
    assert.equal(empty.runs_scanned, 0);
    assert.deepEqual(empty.models, {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resolveRoutePolicy resolves deterministically and honors explicit overrides", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-policy-"));
  try {
    const policy = await resolveRoutePolicy(dir, {}, "review", { env: {} });
    assert.equal(policy.policy_version, ROUTE_POLICY_VERSION);
    assert.equal(policy.profile.name, "balanced");
    assert.equal(policy.profile.source, "default");
    assert.equal(policy.kind, "review");
    assert.equal(policy.requested.tier, "balanced");
    assert.equal(policy.explicit_override, false);
    assert.equal(policy.alias_drift.requested_is_alias, true);

    // Same input twice -> same decision (deterministic for fixed config).
    const again = await resolveRoutePolicy(dir, {}, "review", { env: {} });
    assert.deepEqual(again, policy);

    // Explicit --provider/--model wins over any profile.
    const overridden = await resolveRoutePolicy(dir, {}, "review", {
      env: { AGENTIFY_PROFILE: "cost" },
      provider: "claude",
      model: "claude-sonnet-5",
    });
    assert.equal(overridden.explicit_override, true);
    assert.equal(overridden.selected.reason, "explicit_override");
    assert.equal(overridden.selected.provider, "claude");
    assert.equal(overridden.selected.model, "claude-sonnet-5");
    assert.equal(overridden.profile.name, "cost");
    assert.equal(overridden.alias_drift.selected_is_alias, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runDelegate carries the resolved profile into telemetry and results", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-delegate-profile-"));
  try {
    const result = await runDelegate(dir, {}, "quick", "task", {
      profile: "cost",
      env: {},
      runtime: {
        commandExists: async (command) => command === "claude",
        exec: async () => ({ code: 0, stdout: "ok", stderr: "" }),
      },
    });
    assert.equal(result.profile, "cost");
    assert.equal(result.profile_source, "cli");
    assert.equal(result.policy_version, ROUTE_POLICY_VERSION);
    assert.equal(result.capability_tier, "economy");

    const raw = await fs.readFile(resolveDelegationsPath(dir), "utf8");
    const record = JSON.parse(raw.trim().split("\n").at(-1));
    assert.equal(record.requested_profile, "cost");
    assert.equal(record.resolved_profile, "cost");
    assert.equal(record.profile_source, "cli");
    assert.equal(record.policy_version, ROUTE_POLICY_VERSION);
    assert.equal(record.capability_tier, "economy");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("fallback preserves the original route ceilings — budgets never reset or rise", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-fallback-budget-"));
  try {
    const calls = [];
    // review wants codex; only claude exists. The fallback target must carry
    // review's own $0.75/20-turn ceiling, not a fresh or larger one.
    const result = await runDelegate(dir, {}, "review", "check it", {
      env: {},
      runtime: {
        commandExists: async (command) => command === "claude",
        exec: async (command, args) => { calls.push([command, ...args]); return { code: 0, stdout: "ok", stderr: "" }; },
      },
    });
    assert.equal(result.used_fallback, true);
    assert.equal(result.fallback_reason, "provider_unavailable");
    assert.equal(result.model, "sonnet");
    assert.equal(result.capability_tier, "balanced");
    const argv = calls[0];
    assert.equal(argv[argv.indexOf("--max-budget-usd") + 1], "0.75");
    assert.equal(argv[argv.indexOf("--max-turns") + 1], "20");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runDelegate --dry-run explains without spawning a provider", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-dryrun-"));
  try {
    let execCalls = 0;
    const result = await runDelegate(dir, {}, "quick", "fix the typo", {
      dryRun: true,
      env: {},
      runtime: {
        commandExists: async (command) => command === "claude",
        exec: async () => { execCalls += 1; return { code: 0, stdout: "", stderr: "" }; },
      },
    });
    assert.equal(execCalls, 0);
    assert.equal(result.dry_run, true);
    assert.equal(result.command, "delegate");
    assert.equal(result.policy.kind, "quick");
    assert.equal(result.resolves_to.provider, "claude");
    // Nothing is recorded for a dry run.
    await assert.rejects(() => fs.access(resolveDelegationsPath(dir)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("explainRoute classifies the task, reports limits, chain, and availability", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-explain-"));
  try {
    const result = await explainRoute(dir, {}, "review the payment change", {
      env: {},
      runtime: { commandExists: async (command) => command === "claude" },
    });
    assert.equal(result.command, "route");
    assert.equal(result.intent.kind, "review");
    assert.equal(result.policy.profile.name, "balanced");
    assert.equal(result.limits.max_budget_usd, 0.75);
    assert.equal(result.resolves_to.provider, "claude");
    assert.equal(result.resolves_to.fallback, true);
    assert.equal(result.resolves_to.fallback_reason, "provider_unavailable");

    // Explicit kind skips classification; explicit profile is honored.
    const explicit = await explainRoute(dir, {}, "", {
      kind: "heavy",
      profile: "performance",
      env: {},
      runtime: { commandExists: async () => true },
    });
    assert.equal(explicit.intent, null);
    assert.equal(explicit.policy.kind, "heavy");
    assert.equal(explicit.policy.profile.name, "performance");
    assert.equal(explicit.policy.profile.source, "cli");
    assert.equal(explicit.resolves_to.fallback, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("capability tiers stay a closed vocabulary", () => {
  assert.deepEqual(CAPABILITY_TIERS, ["economy", "balanced", "frontier"]);
});
