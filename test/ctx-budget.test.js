import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CONTEXT_POLICY_VERSION,
  DEFAULT_MAX_INJECTED_TOKENS,
  loadContextEvidence,
  resolveBudgetSettings,
  resolveContextPolicy,
  selectBudgetForProfile,
  selectWithinBudget,
} from "../src/core/ctx-budget.js";
import { DEFAULT_PROFILE_DEFINITIONS } from "../src/core/profiles.js";
import { estimateContextTokens } from "../src/core/value-telemetry.js";

const NOW = Date.parse("2026-07-13T00:00:00Z");

function candidate(overrides = {}) {
  return {
    key: overrides.key || "note:x",
    type: "note",
    score: 1,
    ts: "2026-07-10T00:00:00Z",
    stale: false,
    seen: false,
    line: "- [2026-07-10] a short note about payments",
    ...overrides,
  };
}

test("selectWithinBudget is deterministic and explains every candidate", () => {
  const candidates = [
    candidate({ key: "note:a", score: 3, line: "- retry logic note" }),
    candidate({ key: "note:b", score: 2, line: "- config note" }),
    candidate({ key: "fail:x", type: "failure", score: 4, line: "- `pnpm test` failed" }),
    candidate({ key: "file:src/pay.ts", type: "file", score: 1, ts: null, line: "- src/pay.ts (3 edits)" }),
  ];
  const run = () => selectWithinBudget({ candidates: candidates.map((item) => ({ ...item })), maxTokens: 500, now: NOW });
  const first = run();
  const second = run();
  assert.deepEqual(first, second, "same input must produce byte-identical selection");
  assert.equal(first.selected.length, 4);
  for (const item of first.candidates) {
    assert.ok(item.reason, `every candidate carries a reason (${item.key})`);
    assert.ok(typeof item.tokens === "number" && item.tokens > 0);
  }
  // Output preserves input (render) order, not greedy order.
  assert.deepEqual(first.selected.map((item) => item.key), ["note:a", "note:b", "fail:x", "file:src/pay.ts"]);
});

test("stale, seen, low-score, and too-old candidates are skipped with reasons", () => {
  const result = selectWithinBudget({
    candidates: [
      candidate({ key: "note:stale", stale: true }),
      candidate({ key: "note:seen", seen: true }),
      candidate({ key: "note:weak", score: 0.1 }),
      candidate({ key: "note:old", ts: "2020-01-01T00:00:00Z" }),
      candidate({ key: "note:good", score: 5 }),
    ],
    maxTokens: 500,
    minScore: 0.5,
    maxAgeDays: 365,
    now: NOW,
  });
  const reasons = Object.fromEntries(result.candidates.map((item) => [item.key, item.reason]));
  assert.equal(reasons["note:stale"], "stale_refs");
  assert.equal(reasons["note:seen"], "seen_this_session");
  assert.equal(reasons["note:weak"], "below_min_score");
  assert.equal(reasons["note:old"], "exceeds_max_age");
  assert.equal(reasons["note:good"], "within_budget");
  assert.deepEqual(result.selected.map((item) => item.key), ["note:good"]);
});

test("reserves keep bulky low-priority items from crowding out decisions and failures", () => {
  const filler = "x".repeat(720); // ~180 tokens per file line
  const candidates = [
    // Files score high enough to win a pure value-per-token contest.
    candidate({ key: "file:1", type: "file", score: 50, ts: null, line: `- ${filler} (9 edits)` }),
    candidate({ key: "file:2", type: "file", score: 50, ts: null, line: `- ${filler} (9 edits)` }),
    candidate({ key: "file:3", type: "file", score: 50, ts: null, line: `- ${filler} (9 edits)` }),
    candidate({ key: "decision:1", type: "decision", score: 0.4, line: `- [2026-07-10] [decision] ${"chose flags over env vars because rollouts. ".repeat(4)}` }),
    candidate({ key: "fail:1", type: "failure", score: 0.4, line: `- [2026-07-10] \`pnpm test\` (exit 1) — ${"assertion failed in checkout spec. ".repeat(4)}` }),
  ];
  const result = selectWithinBudget({
    candidates,
    maxTokens: 400,
    reserves: { decisions: 60, failures: 60 },
    now: NOW,
  });
  const selectedKeys = new Set(result.selected.map((item) => item.key));
  assert.ok(selectedKeys.has("decision:1"), "reserved budget must admit the decision");
  assert.ok(selectedKeys.has("fail:1"), "reserved budget must admit the failure");
  assert.ok(result.used_tokens <= 400, `used ${result.used_tokens} > budget`);
  const skippedFiles = result.candidates.filter((item) => item.type === "file" && !item.selected);
  assert.ok(skippedFiles.length >= 1, "at least one bulky file must be skipped for budget");
  for (const item of skippedFiles) {
    assert.match(item.reason, /over_budget|exceeds_total_budget/);
  }
});

test("an oversized decision is truncated with provenance; an oversized note is skipped", () => {
  const huge = "payment retries idempotency ".repeat(200); // ~1400 tokens
  const result = selectWithinBudget({
    candidates: [
      candidate({ key: "decision:big", type: "decision", score: 5, line: `- [2026-07-10] [decision] ${huge}` }),
      candidate({ key: "note:big", type: "note", score: 5, line: `- [2026-07-10] ${huge}` }),
    ],
    maxTokens: 300,
    reserves: { decisions: 100, failures: 0 },
    now: NOW,
  });
  const decision = result.candidates.find((item) => item.key === "decision:big");
  assert.equal(decision.selected, true);
  assert.equal(decision.truncated, true);
  assert.equal(decision.reason, "truncated_to_fit");
  assert.match(decision.line, /\[truncated from \d+ chars\]$/);
  assert.ok(decision.tokens <= 300, "truncated item must fit the total budget");

  const note = result.candidates.find((item) => item.key === "note:big");
  assert.equal(note.selected, false);
  assert.equal(note.reason, "exceeds_total_budget");
  assert.ok(result.used_tokens <= 300);
});

test("a zero or negative budget disables selection entirely", () => {
  const result = selectWithinBudget({ candidates: [candidate({})], maxTokens: 0, now: NOW });
  assert.equal(result.selected.length, 0);
  assert.equal(result.candidates[0].reason, "budget_disabled");
});

test("property: mixed candidate sets never exceed the budget across many shapes", () => {
  // Deterministic pseudo-random fixtures: a linear congruential generator
  // seeds a wide mix of sizes, scores, and classes without Math.random.
  let state = 42;
  const rand = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const types = ["note", "decision", "summary", "file", "failure"];
  for (let round = 0; round < 200; round += 1) {
    const count = 1 + Math.floor(rand() * 12);
    const candidates = [];
    for (let i = 0; i < count; i += 1) {
      const type = types[Math.floor(rand() * types.length)];
      candidates.push(candidate({
        key: `${type}:${round}:${i}`,
        type,
        score: Number((rand() * 10).toFixed(3)),
        stale: rand() < 0.1,
        seen: rand() < 0.1,
        ts: rand() < 0.9 ? "2026-07-01T00:00:00Z" : null,
        line: `- ${"word ".repeat(1 + Math.floor(rand() * 400))}`,
      }));
    }
    const maxTokens = 50 + Math.floor(rand() * 1500);
    const overhead = { base: 20, sections: { failures: 15, summaries: 6, notes: 9, files: 10 } };
    const result = selectWithinBudget({ candidates, maxTokens, overhead, now: NOW, reserves: { decisions: 250, failures: 250 } });
    assert.ok(result.used_tokens <= maxTokens, `round ${round}: used ${result.used_tokens} > ${maxTokens}`);
    let itemTokens = 0;
    for (const item of result.selected) {
      assert.ok(!item.stale && !item.seen, `round ${round}: stale/seen item selected`);
      itemTokens += estimateContextTokens(item.line);
    }
    assert.ok(itemTokens <= maxTokens, `round ${round}: item tokens ${itemTokens} > ${maxTokens}`);
  }
});

test("resolveBudgetSettings: env beats config, config beats nothing, reserves default", () => {
  const config = { context: { maxInjectedTokens: 800, minScore: 0.2, maxAgeDays: 90, reserve: { decisions: 100 } } };
  const fromEnv = resolveBudgetSettings(config, { AGENTIFY_CTX_BUDGET: "600" });
  assert.equal(fromEnv.explicitMaxTokens, 600);
  assert.equal(fromEnv.explicitSource, "env");
  const fromConfig = resolveBudgetSettings(config, {});
  assert.equal(fromConfig.explicitMaxTokens, 800);
  assert.equal(fromConfig.explicitSource, "config");
  assert.equal(fromConfig.minScore, 0.2);
  assert.equal(fromConfig.maxAgeDays, 90);
  assert.deepEqual(fromConfig.reserves, { decisions: 100, failures: 250 });
  const none = resolveBudgetSettings({}, {});
  assert.equal(none.explicitMaxTokens, null);
  assert.equal(none.explicitSource, null);
  assert.deepEqual(none.reserves, { decisions: 250, failures: 250 });
});

function variant(maxTokens, passRate, costPerPass, { sufficient = true } = {}) {
  return {
    mode: "relevant",
    max_injected_tokens: maxTokens,
    attempts: sufficient ? 10 : 2,
    passes: Math.round((sufficient ? 10 : 2) * passRate),
    pass_rate: passRate,
    cost_per_pass_usd: costPerPass,
    sufficient,
  };
}

test("selectBudgetForProfile: cost takes the smallest budget meeting the floor", () => {
  const evidence = { variants: {
    "relevant@400": variant(400, 0.95, 0.04),
    "relevant@1200": variant(1200, 0.96, 0.06),
  } };
  const picked = selectBudgetForProfile({ profileName: "cost", definition: DEFAULT_PROFILE_DEFINITIONS.cost, evidence });
  assert.equal(picked.max_tokens, 400);
  assert.equal(picked.reason, "smallest_budget_meets_quality_floor");

  const failing = selectBudgetForProfile({
    profileName: "cost",
    definition: DEFAULT_PROFILE_DEFINITIONS.cost,
    evidence: { variants: { "relevant@400": variant(400, 0.5, 0.04) } },
  });
  assert.equal(failing.max_tokens, DEFAULT_MAX_INJECTED_TOKENS);
  assert.equal(failing.reason, "insufficient_evidence_for_change");
});

test("selectBudgetForProfile: balanced takes the best measured cost per pass under the floor", () => {
  const evidence = { variants: {
    "relevant@400": variant(400, 0.85, 0.05),
    "relevant@1200": variant(1200, 0.9, 0.03),
    "relevant@2400": variant(2400, 0.95, 0.08),
  } };
  const picked = selectBudgetForProfile({ profileName: "balanced", definition: DEFAULT_PROFILE_DEFINITIONS.balanced, evidence });
  assert.equal(picked.max_tokens, 1200);
  assert.equal(picked.reason, "evidence_lowest_cost_per_pass");
});

test("selectBudgetForProfile: performance escalates only on measured pass-rate gains", () => {
  const gains = { variants: {
    "relevant@1200": variant(1200, 0.8, 0.05),
    "relevant@2400": variant(2400, 0.9, 0.09),
  } };
  const escalated = selectBudgetForProfile({ profileName: "performance", definition: DEFAULT_PROFILE_DEFINITIONS.performance, evidence: gains });
  assert.equal(escalated.max_tokens, 2400);
  assert.equal(escalated.reason, "evidence_higher_pass_rate");

  const noGain = { variants: {
    "relevant@1200": variant(1200, 0.9, 0.05),
    "relevant@2400": variant(2400, 0.9, 0.09),
  } };
  const kept = selectBudgetForProfile({ profileName: "performance", definition: DEFAULT_PROFILE_DEFINITIONS.performance, evidence: noGain });
  assert.equal(kept.max_tokens, DEFAULT_MAX_INJECTED_TOKENS);

  // Without a measured default baseline, a bigger budget can never win.
  const noBaseline = { variants: { "relevant@2400": variant(2400, 0.99, 0.09) } };
  const held = selectBudgetForProfile({ profileName: "performance", definition: DEFAULT_PROFILE_DEFINITIONS.performance, evidence: noBaseline });
  assert.equal(held.max_tokens, DEFAULT_MAX_INJECTED_TOKENS);
});

test("selectBudgetForProfile ignores insufficient evidence for every profile", () => {
  const evidence = { variants: { "relevant@400": variant(400, 1, 0.01, { sufficient: false }) } };
  for (const profileName of ["cost", "balanced", "performance"]) {
    const picked = selectBudgetForProfile({ profileName, definition: DEFAULT_PROFILE_DEFINITIONS[profileName], evidence });
    assert.equal(picked.max_tokens, DEFAULT_MAX_INJECTED_TOKENS, profileName);
  }
});

test("resolveContextPolicy: explicit override wins and skips evidence; default is documented", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-policy-"));
  try {
    const explicit = await resolveContextPolicy(root, { context: { maxInjectedTokens: 700 } }, { env: {} });
    assert.equal(explicit.policy_version, CONTEXT_POLICY_VERSION);
    assert.equal(explicit.max_injected_tokens, 700);
    assert.equal(explicit.budget_source, "config");
    assert.equal(explicit.budget_reason, "explicit_override");
    assert.equal(explicit.evidence, null);

    const fallback = await resolveContextPolicy(root, {}, { env: {} });
    assert.equal(fallback.max_injected_tokens, DEFAULT_MAX_INJECTED_TOKENS);
    assert.equal(fallback.budget_source, "default");
    assert.equal(fallback.resolved_profile, "balanced");
    assert.equal(fallback.requested_profile, null);
    assert.equal(fallback.profile_source, "default");
    assert.equal(fallback.evidence.runs_scanned, 0);

    const profiled = await resolveContextPolicy(root, {}, { env: { AGENTIFY_PROFILE: "cost" } });
    assert.equal(profiled.resolved_profile, "cost");
    assert.equal(profiled.requested_profile, "cost");
    assert.equal(profiled.profile_source, "env");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loadContextEvidence buckets agentify-arm attempts by context ablation variant", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-evidence-"));
  try {
    const runDir = path.join(root, ".agentify", "evals", "runs", "20260713-010101-abc123");
    const write = async (attemptId, record) => {
      const dir = path.join(runDir, "attempts", attemptId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(record));
    };
    const order = [];
    for (let i = 1; i <= 5; i += 1) {
      order.push({ attempt_id: `agentify-${i}` }, { attempt_id: `agentify-ctx-relevant-400-${i}` }, { attempt_id: `agentify-pinned-${i}` }, { attempt_id: `plain-safe-${i}` });
      await write(`agentify-${i}`, { arm: "agentify", pass: true, provider: { cost_usd: 0.02 } });
      await write(`agentify-ctx-relevant-400-${i}`, {
        arm: "agentify-ctx-relevant-400",
        context_ablation: { mode: "relevant", max_injected_tokens: 400 },
        pass: i <= 4,
        provider: { cost_usd: 0.01 },
      });
      // A null ablation budget with recorded telemetry buckets by the budget
      // the attempt actually ran under, not the documented default.
      await write(`agentify-pinned-${i}`, {
        arm: "agentify",
        context_ablation: { mode: "relevant", max_injected_tokens: null },
        context_metrics: { budget_max_tokens: 600 },
        pass: true,
        provider: { cost_usd: 0.015 },
      });
      // Baseline arms never count as context evidence.
      await write(`plain-safe-${i}`, { arm: "plain-safe", pass: true, provider: { cost_usd: 0.02 } });
    }
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify({ plan: { order } }));

    const evidence = await loadContextEvidence(root);
    assert.equal(evidence.runs_scanned, 1);
    const defaultVariant = evidence.variants[`relevant@${DEFAULT_MAX_INJECTED_TOKENS}`];
    assert.equal(defaultVariant.attempts, 5);
    assert.equal(defaultVariant.pass_rate, 1);
    assert.equal(defaultVariant.sufficient, true);
    const small = evidence.variants["relevant@400"];
    assert.equal(small.attempts, 5);
    assert.equal(small.pass_rate, 0.8);
    assert.equal(small.cost_per_pass_usd, Number((0.05 / 4).toFixed(4)));
    const pinned = evidence.variants["relevant@600"];
    assert.equal(pinned.attempts, 5);
    assert.equal(pinned.max_injected_tokens, 600);
    assert.equal(Object.keys(evidence.variants).some((key) => key.includes("plain")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
