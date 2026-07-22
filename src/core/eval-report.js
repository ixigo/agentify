// Cost-performance report and regression gates for paired eval runs (#294).
//
// The report turns raw attempt artifacts into a decision-quality view:
// per-arm pass rates with confidence intervals, provider-reported vs
// estimated cost kept separate, cost per passing task, paired deltas with
// discordant-pair counts, and a cost-quality frontier. It refuses to declare
// a winner from an underpowered, partial, or unpaired run — labels are
// explicit, never implied by silence.
//
// Privacy: reports never contain the raw prompt (only its hash), provider
// argv, or unredacted command output.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { EVAL_RUN_SCHEMA_VERSION, resolveEvalPaths } from "./eval.js";
import { exists, readJson } from "./fs.js";
import { redactSensitiveText } from "./redact.js";

export const EVAL_REPORT_SCHEMA_VERSION = "eval-report-v1";
export const EVAL_GRID_SCHEMA_VERSION = "eval-grid-v1";
// The grid renders as JSON or markdown only — it is a cross-run aggregate, so
// the single-run HTML/promptfoo adapters don't apply.
export const EVAL_GRID_FORMATS = ["json", "md"];
export const EVAL_REPORT_FORMATS = ["json", "md", "html"];
// "promptfoo" is an export adapter for teams using promptfoo's UI/assertion
// ecosystem, not a report format: it carries per-attempt results, not the
// normalized paired metrics.
export const EVAL_EXPORT_FORMATS = [...EVAL_REPORT_FORMATS, "promptfoo"];

// A paired comparison below this many attempts per arm cannot separate arms
// with any confidence; the verdict stays "insufficient evidence".
export const MIN_ATTEMPTS_PER_ARM = 5;

// Gate metrics understood by `agentify eval compare --fail-on`.
// - pass_rate_drop: absolute drop in pass rate (0.02 = 2 points).
// - cost_per_pass_increase: relative increase (0.10 = +10%).
// - p95_latency_increase: relative increase in provider P95 (0.20 = +20%).
export const COMPARE_GATES = ["pass_rate_drop", "cost_per_pass_increase", "p95_latency_increase"];

// Exit codes for `eval compare`, stable for CI:
// 0 = all gates passed, 1 = at least one gate violated, 2 = invalid input.
export const COMPARE_EXIT_PASS = 0;
export const COMPARE_EXIT_VIOLATION = 1;
export const COMPARE_EXIT_ERROR = 2;

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) {
    return null;
  }
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(fraction * sortedValues.length) - 1));
  return sortedValues[index];
}

function round(value, places = 6) {
  return value === null || value === undefined ? null : Number(value.toFixed(places));
}

// Exact two-sided sign test over discordant pairs — the correct significance
// test for a paired design. Independent per-arm intervals overstate the
// evidence (5/5 discordant wins looks separated by CI but p = 0.0625).
// Computed in log space so large discordant counts neither overflow the
// binomial coefficient nor underflow 0.5^n.
export function signTestPValue(wins, losses) {
  const n = wins + losses;
  if (n === 0) {
    return 1;
  }
  const k = Math.min(wins, losses);
  let cumulative = 0;
  let logTerm = -n * Math.LN2; // log(C(n,0) * 0.5^n)
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) {
      logTerm += Math.log(n - i + 1) - Math.log(i);
    }
    cumulative += Math.exp(logTerm);
  }
  return round(Math.min(1, 2 * cumulative), 6);
}

// Wilson score interval: sane behavior at small n and at 0%/100%, unlike the
// normal approximation.
export function wilsonInterval(passes, attempts, z = 1.96) {
  if (!Number.isFinite(attempts) || attempts <= 0) {
    return null;
  }
  const p = passes / attempts;
  const z2 = z * z;
  const denominator = 1 + z2 / attempts;
  const center = (p + z2 / (2 * attempts)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / attempts + z2 / (4 * attempts * attempts))) / denominator;
  return { low: round(Math.max(0, center - half), 4), high: round(Math.min(1, center + half), 4) };
}

async function loadRun(root, config, runIdInput) {
  const { runsRoot } = resolveEvalPaths(root, config);
  let runId = runIdInput ? String(runIdInput).trim() : "";
  if (!runId) {
    // Default to the most recent run: ids are timestamp-prefixed.
    const entries = (await exists(runsRoot)) ? (await fs.readdir(runsRoot)).sort().reverse() : [];
    for (const name of entries) {
      if (await exists(path.join(runsRoot, name, "run.json"))) {
        runId = name;
        break;
      }
    }
    if (!runId) {
      throw new Error("No eval runs found. Run one with: agentify eval run <task>");
    }
  }
  if (!/^\d{8}-\d{6}-[a-f0-9]{6}$/.test(runId)) {
    throw new Error(`Invalid eval run id "${runId}"`);
  }
  const runDir = path.join(runsRoot, runId);
  const metaPath = path.join(runDir, "run.json");
  if (!(await exists(metaPath))) {
    throw new Error(`No eval run found at ${path.relative(root, metaPath)}`);
  }
  const meta = await readJson(metaPath);
  if (meta?.schema !== EVAL_RUN_SCHEMA_VERSION) {
    throw new Error(`Eval run ${runId} has unrecognized metadata schema "${meta?.schema}"`);
  }
  const attempts = [];
  for (const entry of meta.plan?.order || []) {
    const resultPath = path.join(runDir, "attempts", entry.attempt_id, "result.json");
    if (await exists(resultPath)) {
      attempts.push(await readJson(resultPath));
    }
  }
  return { runId, runDir, meta, attempts };
}

function classifyFailure(record) {
  if (record.pass) {
    return null;
  }
  if (record.status === "error") return "harness_error";
  if ((record.grade?.forbidden_violations || []).length > 0) return "forbidden_change";
  if (record.provider?.timed_out) return "timeout";
  if (record.status === "provider_error") return "provider_error";
  return "grader_failed";
}

function armMetrics(records) {
  const attempts = records.length;
  const passes = records.filter((record) => record.pass).length;

  let reportedCost = 0;
  let reportedAttempts = 0;
  const providerDurations = [];
  const totalDurations = [];
  const turns = [];
  const turnsToFirstEdit = [];
  const turnScopes = new Set();
  const changedCounts = [];
  const tokens = { fresh_input: 0, cache_read: 0, cache_write: 0, output: 0 };
  let usageAttempts = 0;
  const failureBreakdown = {};
  const stopReasons = {};

  for (const record of records) {
    const cost = record.provider?.cost_usd;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      reportedCost += cost;
      reportedAttempts += 1;
    }
    if (typeof record.provider?.duration_ms === "number") {
      providerDurations.push(record.provider.duration_ms);
    }
    if (typeof record.duration_ms === "number") {
      totalDurations.push(record.duration_ms);
    }
    if (typeof record.provider?.num_turns === "number") {
      turns.push(record.provider.num_turns);
      turnScopes.add(record.provider?.multisession === true ? "phase_b_recall" : "attempt");
    }
    if (typeof record.provider?.turns_to_first_edit === "number") {
      turnsToFirstEdit.push(record.provider.turns_to_first_edit);
    }
    changedCounts.push((record.grade?.changed_paths || []).length);
    const usage = record.provider?.usage;
    if (usage && typeof usage === "object") {
      usageAttempts += 1;
      tokens.fresh_input += usage.fresh_input_tokens || 0;
      tokens.cache_read += usage.cache_read_tokens || 0;
      tokens.cache_write += usage.cache_write_tokens || 0;
      tokens.output += usage.output_tokens || 0;
    }
    const failure = classifyFailure(record);
    if (failure) {
      failureBreakdown[failure] = (failureBreakdown[failure] || 0) + 1;
    }
    const stop = record.provider?.subtype || record.status || "unknown";
    stopReasons[stop] = (stopReasons[stop] || 0) + 1;
  }

  providerDurations.sort((a, b) => a - b);
  const mean = (values) => (values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  const fullyCosted = attempts > 0 && reportedAttempts === attempts;

  return {
    attempts,
    passes,
    failures: attempts - passes,
    pass_rate: attempts > 0 ? round(passes / attempts, 4) : null,
    pass_rate_ci95: wilsonInterval(passes, attempts),
    cost: {
      // Provider-reported dollars only; attempts without a reported cost are
      // counted, never guessed at.
      reported_usd: round(reportedCost),
      reported_attempts: reportedAttempts,
      unreported_attempts: attempts - reportedAttempts,
      per_attempt_usd: fullyCosted ? round(reportedCost / attempts) : null,
      // Null when passes are zero or any attempt lacks reported cost — a
      // partial subtotal divided by all passes would read falsely cheap.
      per_pass_usd: fullyCosted && passes > 0 ? round(reportedCost / passes) : null,
    },
    tokens: { ...tokens, usage_reported_attempts: usageAttempts, usage_missing_attempts: attempts - usageAttempts },
    latency: {
      provider_p50_ms: percentile(providerDurations, 0.5),
      provider_p95_ms: percentile(providerDurations, 0.95),
      provider_mean_ms: round(mean(providerDurations), 0),
      total_mean_ms: round(mean(totalDurations), 0),
    },
    turns: {
      mean: round(mean(turns), 2),
      max: turns.length > 0 ? Math.max(...turns) : null,
      scope: turnScopes.size === 0 ? null : turnScopes.size === 1 ? [...turnScopes][0] : "mixed",
    },
    turns_to_first_edit: {
      mean: round(mean(turnsToFirstEdit), 2),
      max: turnsToFirstEdit.length > 0 ? Math.max(...turnsToFirstEdit) : null,
      reported_attempts: turnsToFirstEdit.length,
      unreported_attempts: attempts - turnsToFirstEdit.length,
    },
    changed_files: { mean: round(mean(changedCounts), 2), max: changedCounts.length > 0 ? Math.max(...changedCounts) : null },
    failure_breakdown: failureBreakdown,
    stop_reasons: stopReasons,
  };
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Harbor's imported usage describes the graded phase-B recall only. Count all
// provider tokens because rediscovery may show up as extra prompt/cache reads,
// extra generated exploration, or both. Missing usage remains null; it is never
// converted to a zero-token attempt.
function recallTokens(record) {
  const usage = record.provider?.usage;
  if (!usage || typeof usage !== "object") return null;
  const fields = ["fresh_input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens"];
  const values = fields.map((field) => finiteNumber(usage[field]));
  if (values.every((value) => value === null)) return null;
  return values.reduce((total, value) => total + (value ?? 0), 0);
}

function recallCost(record) {
  // A multi-session provider.cost_usd includes seed + recall after Harbor
  // import. Falling back to it would count the seed twice in break-even.
  return record.provider?.multisession === true
    ? finiteNumber(record.provider?.recall_cost_usd)
    : finiteNumber(record.provider?.cost_usd);
}

function recallTurns(record) {
  return finiteNumber(record.provider?.num_turns);
}

function recallTurnsToFirstEdit(record) {
  return finiteNumber(record.provider?.turns_to_first_edit);
}

// A single-phase baseline made no phase-A investment, so zero is observed,
// not imputed. A two-phase arm with missing seed cost stays unreported.
function seedCost(record) {
  if (record.provider?.multisession !== true) return 0;
  return finiteNumber(record.provider?.seed_cost_usd);
}

function pairedTelemetry(pairs, agentifyValue, baselineValue) {
  const measured = [];
  for (const pair of pairs) {
    const agentify = agentifyValue(pair.left);
    const baseline = baselineValue(pair.right);
    if (agentify !== null && baseline !== null) {
      measured.push({ agentify, baseline });
    }
  }
  const agentifyTotal = measured.reduce((sum, item) => sum + item.agentify, 0);
  const baselineTotal = measured.reduce((sum, item) => sum + item.baseline, 0);
  const avoided = baselineTotal - agentifyTotal;
  const improvedPairs = measured.filter((item) => item.agentify < item.baseline).length;
  const regressedPairs = measured.filter((item) => item.agentify > item.baseline).length;
  const tiedPairs = measured.length - improvedPairs - regressedPairs;
  return {
    paired_attempts: pairs.length,
    measured_pairs: measured.length,
    agentify_total: measured.length > 0 ? round(agentifyTotal) : null,
    baseline_total: measured.length > 0 ? round(baselineTotal) : null,
    avoided: measured.length > 0 ? round(avoided) : null,
    avoided_per_attempt: measured.length > 0 ? round(avoided / measured.length) : null,
    improved_pairs: improvedPairs,
    regressed_pairs: regressedPairs,
    tied_pairs: tiedPairs,
    sign_test_p: signTestPValue(improvedPairs, regressedPairs),
  };
}

function repeatedFailureReceipt(pairs, category) {
  const failures = category === "prior-failure-avoidance"
    ? pairs.filter((pair) => pair.left.pass === true && pair.right.pass !== true)
    : [];
  const costs = failures.map((pair) => recallCost(pair.right)).filter((value) => value !== null);
  const turns = failures.map((pair) => recallTurns(pair.right)).filter((value) => value !== null);
  return {
    pairs: failures.length,
    costed_pairs: costs.length,
    turns_reported_pairs: turns.length,
    // Only call the full failed-attempt spend "avoided" with complete
    // coverage. Partial subtotals are still exposed as reported_* evidence.
    cost_avoided_usd: failures.length > 0 && costs.length === failures.length
      ? round(costs.reduce((sum, value) => sum + value, 0))
      : failures.length === 0 ? 0 : null,
    reported_cost_usd: round(costs.reduce((sum, value) => sum + value, 0)),
    turns_avoided: failures.length > 0 && turns.length === failures.length
      ? turns.reduce((sum, value) => sum + value, 0)
      : failures.length === 0 ? 0 : null,
    reported_turns: turns.reduce((sum, value) => sum + value, 0),
  };
}

function breakEvenReceipt(memoryPairs, seed, recall) {
  if (memoryPairs.length === 0) {
    return { status: "not_applicable", sessions: null, reason: "no paired two-phase attempts" };
  }
  if (seed.measured_pairs !== memoryPairs.length || recall.measured_pairs !== memoryPairs.length) {
    return { status: "unreported", sessions: null, reason: "seed or phase-B recall cost coverage is incomplete" };
  }
  const pairCount = memoryPairs.length;
  const incrementalSeedPerPair = ((seed.agentify_total ?? 0) - (seed.baseline_total ?? 0)) / pairCount;
  const recallSavingsPerSession = (recall.avoided ?? 0) / pairCount;
  if (recallSavingsPerSession <= 0) {
    return {
      status: "not_reached",
      sessions: null,
      reason: "phase-B recall has no measured per-session cost saving",
      incremental_seed_cost_usd: round(incrementalSeedPerPair),
      recall_savings_per_session_usd: round(recallSavingsPerSession),
    };
  }
  // S is the first recall session where:
  // seed investment + S * agentify recall <= S * baseline rediscovery.
  const sessions = Math.max(1, Math.ceil(Math.max(0, incrementalSeedPerPair) / recallSavingsPerSession));
  const agentifyRecallPerSession = (recall.agentify_total ?? 0) / pairCount;
  const baselineRecallPerSession = (recall.baseline_total ?? 0) / pairCount;
  return {
    status: "reached",
    sessions,
    reason: `memory investment is recovered by recall session ${sessions}`,
    incremental_seed_cost_usd: round(incrementalSeedPerPair),
    recall_savings_per_session_usd: round(recallSavingsPerSession),
    agentify_amortized_cost_per_session_usd: round((Math.max(0, incrementalSeedPerPair) + sessions * agentifyRecallPerSession) / sessions),
    baseline_rediscovery_cost_per_session_usd: round(baselineRecallPerSession),
  };
}

function evalEconomics(byArm, task) {
  const agentifyRecords = byArm.get("agentify") || [];
  const comparisons = [];
  if (agentifyRecords.length > 0) {
    for (const [baseline, baselineRecords] of [...byArm.entries()].sort()) {
      if (isAgentifyArm(baseline)) continue;
      const { pairs } = discordantPairs(agentifyRecords, baselineRecords);
      const memoryPairs = pairs.filter((pair) => pair.left.provider?.multisession === true);
      const agentifyMetrics = armMetrics(pairs.map((pair) => pair.left));
      const baselineMetrics = armMetrics(pairs.map((pair) => pair.right));
      const tokens = pairedTelemetry(memoryPairs, recallTokens, recallTokens);
      const turns = pairedTelemetry(memoryPairs, recallTurns, recallTurns);
      const turnsToFirstEdit = pairedTelemetry(memoryPairs, recallTurnsToFirstEdit, recallTurnsToFirstEdit);
      const recall = pairedTelemetry(memoryPairs, recallCost, recallCost);
      const seed = pairedTelemetry(memoryPairs, seedCost, seedCost);
      const incrementalSeed = seed.measured_pairs > 0
        ? round((seed.agentify_total ?? 0) - (seed.baseline_total ?? 0))
        : null;
      comparisons.push({
        baseline,
        paired_attempts: pairs.length,
        multisession_pairs: memoryPairs.length,
        cost_per_pass: {
          agentify_usd: agentifyMetrics.cost.per_pass_usd,
          baseline_usd: baselineMetrics.cost.per_pass_usd,
        },
        phase_b: {
          tokens,
          turns,
          turns_to_first_edit: turnsToFirstEdit,
          cost_usd: recall,
        },
        memory_investment: {
          paired_attempts: seed.paired_attempts,
          measured_pairs: seed.measured_pairs,
          agentify_seed_cost_usd: seed.agentify_total,
          baseline_seed_cost_usd: seed.baseline_total,
          incremental_seed_cost_usd: incrementalSeed,
          incremental_seed_cost_per_attempt_usd: seed.measured_pairs > 0
            ? round((incrementalSeed ?? 0) / seed.measured_pairs)
            : null,
        },
        break_even: breakEvenReceipt(memoryPairs, seed, recall),
        repeated_failure_cost_avoided: repeatedFailureReceipt(pairs, task.category),
      });
    }
  }
  return {
    source: "paired provider telemetry; phase B is the graded recall session",
    formulas: {
      rediscovery_avoided: "baseline phase-B total - agentify phase-B total (paired attempts with complete telemetry)",
      break_even: "ceil(incremental phase-A seed cost per pair / phase-B cost avoided per recall session)",
      repeated_failure_cost_avoided: "baseline phase-B spend where agentify passed and baseline failed on a prior-failure-avoidance task",
    },
    comparisons,
  };
}

// Pair attempts across arms by repeat index (agentify-2 pairs with
// plain-safe-2): same task, same commit, same limits, differing only in arm.
function discordantPairs(leftRecords, rightRecords) {
  const byIndex = (records) => new Map(records.map((record) => [record.repeat_index, record]));
  const left = byIndex(leftRecords);
  const right = byIndex(rightRecords);
  const pairs = [];
  for (const [index, leftRecord] of left) {
    const rightRecord = right.get(index);
    if (rightRecord) {
      pairs.push({ repeat_index: index, left: leftRecord, right: rightRecord });
    }
  }
  let leftOnly = 0;
  let rightOnly = 0;
  for (const pair of pairs) {
    if (pair.left.pass && !pair.right.pass) leftOnly += 1;
    if (!pair.left.pass && pair.right.pass) rightOnly += 1;
  }
  return { pairs, leftOnly, rightOnly };
}

function pairedComparison(agentifyRecords, baselineArm, baselineRecords) {
  const { pairs, leftOnly, rightOnly } = discordantPairs(agentifyRecords, baselineRecords);
  // Deltas are computed over the paired subset only: an attempt without a
  // counterpart on the other arm must not leak into a "paired" delta.
  const agentifyMetrics = armMetrics(pairs.map((pair) => pair.left));
  const baselineMetrics = armMetrics(pairs.map((pair) => pair.right));
  const delta = (a, b) => (a === null || b === null ? null : round(a - b));
  return {
    baseline: baselineArm,
    pairs: pairs.length,
    paired_sample_ids: pairs.map((pair) => `repeat-${pair.repeat_index}`),
    pass_rate_delta: delta(agentifyMetrics.pass_rate, baselineMetrics.pass_rate),
    // Discordant pairs carry the actual evidence in a paired design: how
    // often each arm succeeded where the other failed on the same repeat.
    discordant: { agentify_only_pass: leftOnly, baseline_only_pass: rightOnly },
    sign_test_p: signTestPValue(leftOnly, rightOnly),
    cost_per_pass_delta_usd: delta(agentifyMetrics.cost.per_pass_usd, baselineMetrics.cost.per_pass_usd),
    provider_p95_delta_ms: delta(agentifyMetrics.latency.provider_p95_ms, baselineMetrics.latency.provider_p95_ms),
  };
}

// Pareto frontier over (pass rate up, cost per pass down). Arms without full
// cost coverage cannot sit on a cost frontier.
function costQualityFrontier(arms) {
  const points = Object.entries(arms)
    .filter(([, metrics]) => metrics.pass_rate !== null)
    .map(([arm, metrics]) => ({
      arm,
      pass_rate: metrics.pass_rate,
      cost_per_pass_usd: metrics.cost.per_pass_usd,
      total_reported_usd: metrics.cost.reported_usd,
      passes: metrics.passes,
      costed: metrics.cost.unreported_attempts === 0,
    }));
  for (const point of points) {
    point.on_frontier = point.costed && point.cost_per_pass_usd !== null && !points.some((other) => other !== point
      && other.costed && other.cost_per_pass_usd !== null
      && other.pass_rate >= point.pass_rate
      && other.cost_per_pass_usd <= point.cost_per_pass_usd
      && (other.pass_rate > point.pass_rate || other.cost_per_pass_usd < point.cost_per_pass_usd));
  }
  const frontier = points.filter((point) => point.on_frontier).sort((a, b) => a.pass_rate - b.pass_rate);
  const marginal = [];
  for (let index = 1; index < frontier.length; index += 1) {
    const from = frontier[index - 1];
    const to = frontier[index];
    marginal.push({
      from: from.arm,
      to: to.arm,
      additional_passes: to.passes - from.passes,
      // What each extra successful task costs when stepping up the frontier.
      marginal_usd_per_additional_pass: to.passes > from.passes
        ? round((to.total_reported_usd - from.total_reported_usd) / (to.passes - from.passes))
        : null,
    });
  }
  return { points, marginal };
}

function buildVerdict(arms, completeness, recordsByArm) {
  const reasons = [];
  if (completeness.partial) reasons.push("run is partial (planned attempts missing)");
  if (!completeness.paired) reasons.push("arms are not fully paired across repeat indices");
  if (completeness.underpowered) reasons.push(`fewer than ${MIN_ATTEMPTS_PER_ARM} attempts per arm`);
  if (reasons.length > 0) {
    return { winner: null, eligible: false, reason: `no winner declared: ${reasons.join("; ")}` };
  }
  // A winner needs two things: its pass-rate CI floor above every other
  // arm's ceiling, AND a significant exact sign test over the discordant
  // pairs against every other arm — independent intervals alone overstate
  // paired evidence.
  const entries = Object.entries(arms);
  for (const [arm, metrics] of entries) {
    const ci = metrics.pass_rate_ci95;
    if (!ci) continue;
    const separated = entries.every(([other, otherMetrics]) => other === arm
      || (otherMetrics.pass_rate_ci95 && ci.low > otherMetrics.pass_rate_ci95.high));
    if (!separated) continue;
    const pairwiseSignificant = entries.every(([other]) => {
      if (other === arm) return true;
      const { leftOnly, rightOnly } = discordantPairs(recordsByArm.get(arm), recordsByArm.get(other));
      return signTestPValue(leftOnly, rightOnly) < 0.05 && leftOnly > rightOnly;
    });
    if (pairwiseSignificant) {
      return { winner: arm, eligible: true, reason: `${arm} pass-rate CI is separated above every other arm and the paired sign test is significant (p < 0.05)` };
    }
    return { winner: null, eligible: true, reason: `no winner declared: ${arm} leads on pass rate but the paired sign test is not significant at 5%` };
  }
  return { winner: null, eligible: true, reason: "no winner declared: pass-rate confidence intervals overlap" };
}

// Per-arm context injection metrics (#296), aggregated from the attempt
// telemetry the agentify arm's own hooks recorded. Null when no attempt
// carried metrics (older runs, baseline-only reports).
function contextMetricsByArm(byArm, attempts) {
  const ablationByArm = new Map(attempts.map((record) => [record.arm, record.context_ablation ?? null]));
  const result = {};
  let any = false;
  for (const [arm, records] of [...byArm.entries()].sort()) {
    const withMetrics = records.filter((record) => record.context_metrics && typeof record.context_metrics === "object");
    if (withMetrics.length === 0) {
      continue;
    }
    any = true;
    const sum = (pick) => withMetrics.reduce((total, record) => total + (Number(pick(record.context_metrics)) || 0), 0);
    const matchLatencies = withMetrics.map((record) => record.context_metrics.max_match_ms).filter((value) => Number.isFinite(value));
    result[arm] = {
      context_ablation: ablationByArm.get(arm) ?? null,
      attempts_with_metrics: withMetrics.length,
      injections: sum((metrics) => metrics.injections),
      injected_items: sum((metrics) => metrics.injected_items),
      estimated_tokens: sum((metrics) => metrics.estimated_tokens),
      decisions_reused: sum((metrics) => metrics.decisions_reused),
      stale_context_rejected: sum((metrics) => metrics.stale_context_rejected),
      truncated_items: sum((metrics) => metrics.truncated_items),
      over_budget_skips: sum((metrics) => metrics.over_budget_skips),
      max_match_ms: matchLatencies.length > 0 ? Math.max(...matchLatencies) : null,
      budget_max_tokens: withMetrics.map((record) => record.context_metrics.budget_max_tokens).find((value) => Number.isFinite(value)) ?? null,
    };
  }
  return any ? result : null;
}

// RepoBench line completions are graded on exact match, but the benchmark's
// standard secondary metrics (edit similarity, identifier F1) carry most of
// the signal on a small sample; surface them per arm rather than losing them
// in the binary pass rate. The answer-in-context tally is an honesty receipt:
// retrieved cross-file snippets can legitimately quote the answer line.
function repobenchArmMetrics(records) {
  const scored = records.filter((record) => record.repobench);
  if (scored.length === 0) return null;
  const mean = (values) => {
    const usable = values.filter((value) => typeof value === "number" && Number.isFinite(value));
    return usable.length > 0 ? Number((usable.reduce((sum, value) => sum + value, 0) / usable.length).toFixed(2)) : null;
  };
  return {
    attempts: scored.length,
    exact_match_rate: Number((scored.filter((record) => record.repobench.exact_match === true).length / scored.length).toFixed(4)),
    mean_edit_similarity: mean(scored.map((record) => record.repobench.edit_similarity)),
    mean_identifier_f1: mean(scored.map((record) => record.repobench.identifier_f1)),
    answer_in_context_attempts: scored.filter((record) => record.repobench.context?.answer_in_context === true).length,
  };
}

function attemptDrilldown(record) {
  return {
    attempt_id: record.attempt_id,
    arm: record.arm,
    context_ablation: record.context_ablation ?? null,
    context_metrics: record.context_metrics ?? null,
    repeat_index: record.repeat_index,
    status: record.status,
    pass: record.pass === true,
    failure_kind: classifyFailure(record),
    stop_reason: record.provider?.subtype ?? null,
    num_turns: record.provider?.num_turns ?? null,
    turns_to_first_edit: record.provider?.turns_to_first_edit ?? null,
    provider_duration_ms: record.provider?.duration_ms ?? null,
    duration_ms: record.duration_ms ?? null,
    cost_usd: record.provider?.cost_usd ?? null,
    cost_source: typeof record.provider?.cost_usd === "number" ? "provider" : "unreported",
    multisession: record.provider?.multisession === true,
    recall_cost_usd: record.provider?.recall_cost_usd ?? null,
    seed_cost_usd: record.provider?.seed_cost_usd ?? null,
    seed_num_turns: record.provider?.seed_num_turns ?? null,
    usage: record.provider?.usage ?? null,
    changed_paths: record.grade?.changed_paths ?? [],
    forbidden_violations: record.grade?.forbidden_violations ?? [],
    checks: (record.grade?.checks || []).map((check) => ({
      command: redactSensitiveText(check.command),
      passed: check.passed === true,
      exit_code: check.exit_code,
      timed_out: check.timed_out === true,
      output_tail: redactSensitiveText(check.output_tail || ""),
    })),
    ...(record.error ? { error: redactSensitiveText(record.error) } : {}),
    artifacts: record.artifacts ?? null,
    ...(record.swebench ? { swebench: record.swebench } : {}),
    ...(record.repobench ? { repobench: record.repobench } : {}),
    agentify_version: record.agentify_version ?? null,
    claude_version: record.claude_version ?? null,
  };
}

export async function buildEvalReport(root, config, runIdInput) {
  const { runId, runDir, meta, attempts } = await loadRun(root, config, runIdInput);
  const task = meta.plan?.task || {};
  const planned = (meta.plan?.order || []).length;

  const byArm = new Map();
  for (const record of attempts) {
    if (!byArm.has(record.arm)) byArm.set(record.arm, []);
    byArm.get(record.arm).push(record);
  }
  const arms = {};
  for (const [arm, records] of [...byArm.entries()].sort()) {
    arms[arm] = armMetrics(records);
    if (meta.harness === "repobench") {
      const extras = repobenchArmMetrics(records);
      if (extras) arms[arm].repobench = extras;
    }
  }

  const counts = [...byArm.values()].map((records) => records.length);
  // Paired means every arm completed the same repeat indices — equal counts
  // over disjoint repeats are not a paired sample.
  const indexSets = [...byArm.values()].map((records) => [...new Set(records.map((record) => record.repeat_index))].sort().join(","));
  const completeness = {
    planned_attempts: planned,
    completed_attempts: attempts.length,
    partial: attempts.length < planned,
    paired: indexSets.length >= 2 && new Set(indexSets).size === 1,
    underpowered: counts.length === 0 || Math.min(...counts) < MIN_ATTEMPTS_PER_ARM,
    min_attempts_per_arm: MIN_ATTEMPTS_PER_ARM,
  };
  completeness.labels = [
    ...(completeness.partial ? ["partial"] : []),
    ...(completeness.paired ? [] : ["unpaired"]),
    ...(completeness.underpowered ? ["underpowered"] : []),
  ];

  const paired = [];
  if (byArm.has("agentify")) {
    for (const [arm, records] of [...byArm.entries()].sort()) {
      if (arm !== "agentify") {
        paired.push(pairedComparison(byArm.get("agentify"), arm, records));
      }
    }
  }

  return {
    schema: EVAL_REPORT_SCHEMA_VERSION,
    command: "eval",
    action: "report",
    run_id: runId,
    run_ts: meta.ts ?? null,
    // Which harness produced the attempts: "native" for the local paired
    // runner, "harbor" for imported container runs (#298). Provenance rides
    // along so cross-harness comparisons are always labeled.
    harness: meta.harness ?? "native",
    ...(meta.harbor ? { harbor: meta.harbor } : {}),
    ...(meta.swebench ? { swebench: meta.swebench } : {}),
    ...(meta.repobench ? { repobench: meta.repobench } : {}),
    artifacts_root: path.relative(root, runDir),
    task: {
      id: task.id ?? null,
      // Never the raw prompt: the hash is enough to prove two reports ran
      // the same task.
      prompt_sha256: task.prompt ? createHash("sha256").update(String(task.prompt)).digest("hex") : null,
      // Fingerprint covers everything that defines task identity for a fair
      // comparison — a changed grader or setup is a different task even with
      // the same prompt. Imported harness runs have null prompt/grader, so
      // their identity comes from their pinned harness metadata. Native and
      // pre-existing Harbor fingerprints remain unchanged.
      fingerprint_sha256: createHash("sha256").update(JSON.stringify({
        ...(meta.harness && meta.harness !== "native" ? {
          harness: meta.harness,
        } : {}),
        ...(meta.harbor ? {
          harbor_dataset: meta.harbor.dataset ?? null,
          harbor_version: meta.harbor.harbor_version ?? null,
          harbor_task: task.id ?? null,
        } : {}),
        ...(meta.swebench ? {
          swebench_dataset: meta.swebench.dataset ?? null,
          swebench_version: meta.swebench.harness_version ?? null,
          swebench_suite: meta.swebench.suite ?? null,
          swebench_sample_sha256: meta.swebench.sample_sha256 ?? null,
          swebench_sample: meta.swebench.sample ?? null,
        } : {}),
        ...(meta.repobench ? {
          repobench_dataset: meta.repobench.dataset ?? null,
          repobench_suite: meta.repobench.suite ?? null,
          repobench_sample_sha256: meta.repobench.sample_sha256 ?? null,
          repobench_sample: meta.repobench.sample ?? null,
        } : {}),
        prompt: task.prompt ?? null,
        model: task.model ?? null,
        effort: task.effort ?? null,
        seed_context: task.seed_context !== false,
        setup: task.setup ?? [],
        grader: task.grader ?? null,
        forbidden_paths: task.forbidden_paths ?? [],
        max_budget_usd: task.max_budget_usd ?? null,
        max_turns: task.max_turns ?? null,
        timeout_seconds: task.timeout_seconds ?? null,
      })).digest("hex"),
      base_sha: meta.plan?.base_sha ?? null,
      model: task.model ?? null,
      effort: task.effort ?? null,
      profile: task.profile ?? null,
      category: task.category ?? null,
      phases: task.phases ?? null,
      max_budget_usd: task.max_budget_usd ?? null,
      max_turns: task.max_turns ?? null,
      timeout_seconds: task.timeout_seconds ?? null,
      forbidden_paths: task.forbidden_paths ?? [],
      arms: meta.plan?.arms ?? Object.keys(arms),
      repeat: meta.plan?.repeat ?? null,
    },
    versions: {
      agentify: meta.agentify_version ?? null,
      claude: meta.claude_version ?? null,
      ...(meta.harbor?.harbor_version ? { harbor: meta.harbor.harbor_version } : {}),
      ...(meta.swebench?.harness_version ? { swebench: meta.swebench.harness_version } : {}),
    },
    completeness,
    arms,
    paired,
    economics: evalEconomics(byArm, task),
    frontier: costQualityFrontier(arms),
    verdict: buildVerdict(arms, completeness, byArm),
    context_metrics: contextMetricsByArm(byArm, attempts),
    attempts: attempts.map(attemptDrilldown),
  };
}

// ---------------------------------------------------------------------------
// Model × difficulty grid (#317)
// ---------------------------------------------------------------------------
//
// The paired report answers "did the agentify arm win on THIS run"; the grid
// answers "at which (model × difficulty) operating point is the win largest and
// honest". It aggregates many imported single-(task,model) runs into cells and,
// per cell, reports the agentify−baseline pass-rate delta, discordant-pair
// count, and cost/pass — the frontier #317 needs to pick where context is most
// load-bearing.

const DIFFICULTY_ORDER = { easy: 0, medium: 1, hard: 2 };

function difficultyRank(difficulty) {
  return DIFFICULTY_ORDER[difficulty] ?? 99;
}

// Load the runs the grid aggregates: the explicit ids, or (when none given)
// the runs of the single most-recent Harbor import job. Auto-discovery is
// scoped to ONE job on purpose: every imported run now carries a difficulty
// (defaulted to "easy"), so vacuuming all harbor runs would silently blend an
// unrelated nightly/crossvendor import into the matrix. A down-shift suite is
// one `harbor run` -> one import job, so "latest job" is exactly its runs.
// Runs that lack a model/difficulty axis are dropped (silently in auto mode,
// reported in explicit mode so a bad id is never swallowed). Duplicate
// explicit ids are collapsed — counting the same run twice would inflate the
// discordant tally and manufacture significance.
async function loadGridRuns(root, config, runIds) {
  const { runsRoot } = resolveEvalPaths(root, config);
  const explicit = Array.isArray(runIds) && runIds.length > 0;
  let ids;
  if (explicit) {
    ids = [...new Set(runIds.map((id) => String(id).trim()).filter(Boolean))];
  } else {
    ids = [];
    const entries = (await exists(runsRoot)) ? (await fs.readdir(runsRoot)).sort() : [];
    for (const name of entries) {
      if (await exists(path.join(runsRoot, name, "run.json"))) ids.push(name);
    }
  }
  const runs = [];
  const skipped = [];
  for (const id of ids) {
    let loaded;
    try {
      loaded = await loadRun(root, config, id);
    } catch (error) {
      if (explicit) skipped.push({ run_id: id, reason: String(error.message || error) });
      continue;
    }
    const task = loaded.meta.plan?.task || {};
    const model = task.model || null;
    const difficulty = task.difficulty || null;
    if (!model || !difficulty) {
      if (explicit) skipped.push({ run_id: id, reason: "run carries no model/difficulty axis (not a matrix run)" });
      continue;
    }
    runs.push({
      runId: loaded.runId,
      job: loaded.meta.harbor?.job ?? null,
      // A re-import of the same job directory produces runs with the SAME job
      // basename but a fresh imported_at, so imported_at (not job name) is what
      // identifies a single import batch.
      importedAt: loaded.meta.harbor?.imported_at ?? null,
      taskId: task.id ?? null,
      model,
      difficulty,
      attempts: loaded.attempts,
    });
  }
  if (!explicit && runs.length > 0) {
    // Keep only the single most recent import BATCH (run ids are
    // timestamp-prefixed, so the max run id identifies the latest batch). Scope
    // by imported_at, falling back to job name only when a run carries no
    // import timestamp (hand-authored runs) — scoping by job name alone would
    // keep stale earlier imports of the same job dir and double-count trials.
    const latestRun = runs.reduce((max, run) => (run.runId > max.runId ? run : max), runs[0]);
    const batchKey = (run) => run.importedAt ?? run.job ?? null;
    const scopeKey = batchKey(latestRun);
    const scoped = runs.filter((run) => batchKey(run) === scopeKey);
    return { runs: scoped, skipped, scoped_to_job: latestRun.job, scoped_to_import: latestRun.importedAt };
  }
  return { runs, skipped, scoped_to_job: null, scoped_to_import: null };
}

function isAgentifyArm(arm) {
  return arm === "agentify" || (typeof arm === "string" && arm.startsWith("agentify"));
}

export async function buildEvalGrid(root, config, runIds) {
  const { runs, skipped, scoped_to_job: scopedToJob, scoped_to_import: scopedToImport } = await loadGridRuns(root, config, runIds);
  if (runs.length === 0) {
    throw new Error("No matrix runs to grid: need imported runs carrying a model and difficulty (see the downshift suite in docs/harbor.md).");
  }

  // One baseline arm across the whole grid keeps every cell comparable. Pick
  // the most common non-agentify arm among the loaded attempts (the down-shift
  // suite's baseline is plain claude-code). Only the balanced "agentify" arm is
  // the treatment; profile variants (agentify-cost, …) are not part of the
  // capability-vs-context frontier and are excluded from both arms here.
  const baselineCounts = new Map();
  for (const run of runs) {
    for (const record of run.attempts) {
      if (record.arm && !isAgentifyArm(record.arm)) {
        baselineCounts.set(record.arm, (baselineCounts.get(record.arm) || 0) + 1);
      }
    }
  }
  const baselineArm = [...baselineCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const cellMap = new Map();
  for (const run of runs) {
    const key = `${run.model}::${run.difficulty}`;
    if (!cellMap.has(key)) cellMap.set(key, { model: run.model, difficulty: run.difficulty, runs: [] });
    cellMap.get(key).runs.push(run);
  }

  const cells = [];
  for (const cell of cellMap.values()) {
    // Everything the cell reports is computed over the PAIRED subset only: for
    // each run (one task), match the agentify and baseline attempts by
    // repeat_index and keep only matched pairs. The report describes a paired
    // comparison, so pass-rate delta, cost/pass, and the discordant tally must
    // all come from the same matched attempts — an unpaired attempt (a run
    // missing the baseline arm, or uneven attempt counts) would otherwise skew
    // the delta and cost/pass while the discordant count stayed paired.
    const agentifyRecords = [];
    const baselineRecords = [];
    let leftOnly = 0;
    let rightOnly = 0;
    const tasks = new Set();
    for (const run of cell.runs) {
      const ag = run.attempts.filter((record) => record.arm === "agentify");
      const bl = run.attempts.filter((record) => record.arm === baselineArm);
      const { pairs, leftOnly: l, rightOnly: r } = discordantPairs(ag, bl);
      if (pairs.length === 0) continue; // a run with no baseline counterpart contributes nothing
      tasks.add(run.taskId);
      for (const pair of pairs) {
        agentifyRecords.push(pair.left);
        baselineRecords.push(pair.right);
      }
      leftOnly += l;
      rightOnly += r;
    }
    const agentify = armMetrics(agentifyRecords);
    const baseline = armMetrics(baselineRecords);
    const delta = agentify.pass_rate === null || baseline.pass_rate === null
      ? null
      : round(agentify.pass_rate - baseline.pass_rate);
    const signP = signTestPValue(leftOnly, rightOnly);
    const favorsAgentify = leftOnly > rightOnly;
    const significant = signP !== null && signP < 0.05 && favorsAgentify;
    // #317 acceptance target: >=5 discordant pairs favoring agentify at p<0.05.
    const qualifiesAcceptance = significant && leftOnly >= 5;
    cells.push({
      model: cell.model,
      difficulty: cell.difficulty,
      tasks: [...tasks].filter(Boolean).sort(),
      agentify: {
        arm: "agentify",
        attempts: agentify.attempts,
        passes: agentify.passes,
        pass_rate: agentify.pass_rate,
        cost_per_pass_usd: agentify.cost.per_pass_usd,
      },
      baseline: {
        arm: baselineArm,
        attempts: baseline.attempts,
        passes: baseline.passes,
        pass_rate: baseline.pass_rate,
        cost_per_pass_usd: baseline.cost.per_pass_usd,
      },
      pass_rate_delta: delta,
      discordant: { agentify_only_pass: leftOnly, baseline_only_pass: rightOnly },
      sign_test_p: signP,
      significant,
      qualifies_acceptance: qualifiesAcceptance,
    });
  }

  // Order models weakest-first by their aggregate baseline pass rate (a
  // capability proxy). The weakest model is the top row, so the "context is
  // load-bearing" story is the delta being LARGEST at the top and shrinking as
  // you move down toward the stronger models.
  const modelBaseline = new Map();
  for (const cell of cells) {
    const acc = modelBaseline.get(cell.model) || { passes: 0, attempts: 0 };
    acc.passes += cell.baseline.passes;
    acc.attempts += cell.baseline.attempts;
    modelBaseline.set(cell.model, acc);
  }
  const rate = (model) => {
    const acc = modelBaseline.get(model);
    return acc && acc.attempts ? acc.passes / acc.attempts : 0;
  };
  const models = [...new Set(cells.map((cell) => cell.model))].sort((a, b) => rate(a) - rate(b) || a.localeCompare(b));
  const difficulties = [...new Set(cells.map((cell) => cell.difficulty))].sort((a, b) => difficultyRank(a) - difficultyRank(b));
  cells.sort((a, b) => models.indexOf(a.model) - models.indexOf(b.model)
    || difficultyRank(a.difficulty) - difficultyRank(b.difficulty));

  const qualifying = cells.filter((cell) => cell.qualifies_acceptance)
    .sort((a, b) => (b.pass_rate_delta ?? -Infinity) - (a.pass_rate_delta ?? -Infinity));
  const best = qualifying[0] ?? null;

  return {
    schema: EVAL_GRID_SCHEMA_VERSION,
    command: "eval",
    action: "grid",
    generated_from: { runs: runs.map((run) => run.runId), count: runs.length, scoped_to_job: scopedToJob, scoped_to_import: scopedToImport, skipped },
    baseline_arm: baselineArm,
    models,
    difficulties,
    cells,
    best_cell: best
      ? {
        model: best.model,
        difficulty: best.difficulty,
        pass_rate_delta: best.pass_rate_delta,
        discordant: best.discordant,
        sign_test_p: best.sign_test_p,
      }
      : null,
    verdict: {
      acceptance_met: Boolean(best),
      reason: best
        ? `cell (model ${best.model}, difficulty ${best.difficulty}) is a significant agentify win: ${best.discordant.agentify_only_pass} discordant pairs favor agentify vs ${best.discordant.baseline_only_pass} for baseline, sign-test p=${best.sign_test_p}`
        : "no cell reached >=5 discordant pairs favoring agentify at p<0.05 — context is not yet decisively load-bearing in this grid",
    },
  };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function formatRate(value) {
  return value === null || value === undefined ? "n/a" : `${Math.round(value * 100)}%`;
}

function formatUsd(value) {
  return value === null || value === undefined ? "n/a" : `$${value.toFixed(4)}`;
}

function formatMs(value) {
  return value === null || value === undefined ? "n/a" : `${(value / 1000).toFixed(1)}s`;
}

function formatCi(ci) {
  return ci ? `${formatRate(ci.low)}–${formatRate(ci.high)}` : "n/a";
}

function formatCount(value, unit) {
  if (value === null || value === undefined) return "n/a";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)} ${unit}`;
}

function formatTurnScope(scope) {
  if (scope === "phase_b_recall") return "phase-B recall";
  if (scope === "attempt") return "whole attempt";
  return scope ?? "n/a";
}

function formatBreakEven(receipt) {
  return receipt?.status === "reached" ? `≤ ${receipt.sessions} recall session(s)` : receipt?.reason ?? "n/a";
}

function formatAmortizedCost(receipt) {
  return receipt?.status === "reached"
    ? `${formatUsd(receipt.agentify_amortized_cost_per_session_usd)} vs ${formatUsd(receipt.baseline_rediscovery_cost_per_session_usd)}`
    : "n/a";
}

export function renderEvalReportMarkdown(report) {
  const harnessDetail = report.harbor
    ? ` (job \`${report.harbor.job}\`, dataset ${report.harbor.dataset ? `${report.harbor.dataset.name}@${report.harbor.dataset.version}` : "n/a"})`
    : report.swebench
      ? ` (job \`${report.swebench.job}\`, dataset ${report.swebench.dataset ? `${report.swebench.dataset.name}@${String(report.swebench.dataset.revision || "").slice(0, 12)}` : "n/a"}, suite ${report.swebench.suite ?? "n/a"})`
      : report.repobench
        ? ` (job \`${report.repobench.job}\`, dataset ${report.repobench.dataset ? `${report.repobench.dataset.name}@${String(report.repobench.dataset.revision || "").slice(0, 12)}` : "n/a"}, suite ${report.repobench.suite ?? "n/a"})`
        : "";
  const lines = [
    `# Eval report — ${report.task.id} (${report.run_id})`,
    "",
    `- Model: \`${report.task.model}\` · profile \`${report.task.profile}\` · base \`${String(report.task.base_sha || "").slice(0, 12)}\``,
    `- Harness: ${report.harness ?? "native"}${harnessDetail}`,
    `- Versions: agentify ${report.versions.agentify ?? "n/a"}, claude ${report.versions.claude ?? "n/a"}${report.versions.harbor ? `, harbor ${report.versions.harbor}` : ""}${report.versions.swebench ? `, swebench ${report.versions.swebench}` : ""}`,
    `- Attempts: ${report.completeness.completed_attempts}/${report.completeness.planned_attempts}${report.completeness.labels.length > 0 ? ` — **${report.completeness.labels.join(", ").toUpperCase()}**` : ""}`,
    `- Verdict: ${report.verdict.winner ? `**${report.verdict.winner}** — ${report.verdict.reason}` : report.verdict.reason}`,
    "",
    "## Arms",
    "",
    "| arm | pass rate | 95% CI | cost/attempt | cost/pass | P50 | P95 | mean turns (scope) | mean turns to first edit | changed files | forbidden fails |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const [arm, metrics] of Object.entries(report.arms)) {
    lines.push(`| ${arm} | ${metrics.passes}/${metrics.attempts} (${formatRate(metrics.pass_rate)}) | ${formatCi(metrics.pass_rate_ci95)} | ${formatUsd(metrics.cost.per_attempt_usd)} | ${formatUsd(metrics.cost.per_pass_usd)} | ${formatMs(metrics.latency.provider_p50_ms)} | ${formatMs(metrics.latency.provider_p95_ms)} | ${metrics.turns.mean ?? "n/a"} (${formatTurnScope(metrics.turns.scope)}) | ${metrics.turns_to_first_edit.mean ?? "n/a"} | ${metrics.changed_files.mean ?? "n/a"} | ${metrics.failure_breakdown.forbidden_change || 0} |`);
  }
  if (Object.values(report.arms).some((metrics) => metrics.turns.scope === "phase_b_recall")) {
    lines.push("", "> Multisession turn counts cover the graded phase-B recall only; Agentify cost/attempt and cost/pass include both the phase-A seed and phase-B recall.");
  }
  if (Object.values(report.arms).some((metrics) => metrics.repobench)) {
    lines.push("", "## Completion quality (repobench)", "");
    lines.push("| arm | exact match | mean edit similarity | mean identifier F1 | answer-in-context attempts |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const [arm, metrics] of Object.entries(report.arms)) {
      if (!metrics.repobench) continue;
      lines.push(`| ${arm} | ${formatRate(metrics.repobench.exact_match_rate)} | ${metrics.repobench.mean_edit_similarity ?? "n/a"} | ${metrics.repobench.mean_identifier_f1 ?? "n/a"} | ${metrics.repobench.answer_in_context_attempts}/${metrics.repobench.attempts} |`);
    }
  }
  if (report.repobench?.retrieval) {
    const retrieval = report.repobench.retrieval;
    lines.push("", "## Index retrieval vs gold cross-file context (token-free)", "");
    lines.push(`- Gold defining file retrieved: ${formatRate(retrieval.def_hit_rate)} (hit@1 ${formatRate(retrieval.hit_at_1)}, hit@5 ${formatRate(retrieval.hit_at_5)}, MRR ${retrieval.mrr ?? "n/a"})`);
    lines.push(`- Gold snippet region matched: ${formatRate(retrieval.snippet_hit_rate)} · macro precision ${formatRate(retrieval.macro_precision)} · mean candidates ${retrieval.mean_candidates ?? "n/a"}`);
    lines.push(`- Dependency edge known to the index: refs ${formatRate(retrieval.ref_edge_hit_rate)}, impacts ${formatRate(retrieval.impact_hit_rate)} — over ${retrieval.tasks} task(s) at $0 provider spend.`);
  }
  for (const [arm, metrics] of Object.entries(report.arms)) {
    if (metrics.cost.unreported_attempts > 0) {
      lines.push("", `> ${arm}: provider reported cost for ${metrics.cost.reported_attempts}/${metrics.attempts} attempt(s); per-attempt and per-pass cost are withheld rather than estimated.`);
    }
    if (metrics.tokens.usage_missing_attempts > 0) {
      lines.push("", `> ${arm}: ${metrics.tokens.usage_missing_attempts} attempt(s) reported no token usage.`);
    }
  }

  if (report.economics.comparisons.length > 0) {
    lines.push("", "## Memory economics", "");
    lines.push("| baseline | cost/pass agentify | cost/pass baseline | paired phase-B recalls | rediscovery avoided | break-even | amortized cost/recall at break-even (agentify vs baseline) | repeated-failure cost avoided |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const comparison of report.economics.comparisons) {
      const rediscovery = [
        formatCount(comparison.phase_b.tokens.avoided, "tokens"),
        formatCount(comparison.phase_b.turns.avoided, "turns"),
        `${formatCount(comparison.phase_b.turns_to_first_edit.avoided, "turns-to-first-edit")} (${comparison.phase_b.turns_to_first_edit.improved_pairs}/${comparison.phase_b.turns_to_first_edit.regressed_pairs} improved/regressed, p=${formatP(comparison.phase_b.turns_to_first_edit.sign_test_p)})`,
      ].join(" / ");
      const repeated = comparison.repeated_failure_cost_avoided;
      const repeatedReceipt = repeated.pairs > 0
        ? `${formatUsd(repeated.cost_avoided_usd)} / ${formatCount(repeated.turns_avoided, "turns")} (${repeated.pairs} pair(s))`
        : "none observed";
      lines.push(`| ${comparison.baseline} | ${formatUsd(comparison.cost_per_pass.agentify_usd)} | ${formatUsd(comparison.cost_per_pass.baseline_usd)} | ${comparison.multisession_pairs} | ${rediscovery} | ${formatBreakEven(comparison.break_even)} | ${formatAmortizedCost(comparison.break_even)} | ${repeatedReceipt} |`);
    }
    lines.push(
      "",
      `> Rediscovery avoided: ${report.economics.formulas.rediscovery_avoided}. Break-even: ${report.economics.formulas.break_even}. Missing phase telemetry is shown as n/a, never zero.`,
    );
  }

  if (report.paired.length > 0) {
    lines.push("", "## Paired deltas (agentify − baseline)", "");
    lines.push("| baseline | pairs | paired samples | Δ pass rate | discordant (agentify-only / baseline-only) | Δ cost/pass | Δ P95 |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const pair of report.paired) {
      lines.push(`| ${pair.baseline} | ${pair.pairs} | ${pair.paired_sample_ids.join(", ") || "none"} | ${pair.pass_rate_delta ?? "n/a"} | ${pair.discordant.agentify_only_pass} / ${pair.discordant.baseline_only_pass} | ${pair.cost_per_pass_delta_usd ?? "n/a"} | ${pair.provider_p95_delta_ms ?? "n/a"} |`);
    }
  }

  if (report.context_metrics) {
    lines.push("", "## Context injection (agentify arms)", "");
    lines.push("| arm | ablation | budget | injections | items | ~tokens | decisions | stale rejected | truncated | over-budget skips | max match |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const [arm, metrics] of Object.entries(report.context_metrics)) {
      const ablation = metrics.context_ablation
        ? `${metrics.context_ablation.mode}${metrics.context_ablation.max_injected_tokens !== null ? `@${metrics.context_ablation.max_injected_tokens}` : ""}`
        : "default";
      lines.push(`| ${arm} | ${ablation} | ${metrics.budget_max_tokens ?? "n/a"} | ${metrics.injections} | ${metrics.injected_items} | ${metrics.estimated_tokens} | ${metrics.decisions_reused} | ${metrics.stale_context_rejected} | ${metrics.truncated_items} | ${metrics.over_budget_skips} | ${metrics.max_match_ms !== null ? `${metrics.max_match_ms}ms` : "n/a"} |`);
    }
  }

  const frontier = report.frontier.points.filter((point) => point.on_frontier);
  if (frontier.length > 0) {
    lines.push("", "## Cost-quality frontier", "");
    for (const point of frontier) {
      lines.push(`- ${point.arm}: ${formatRate(point.pass_rate)} pass rate at ${formatUsd(point.cost_per_pass_usd)}/pass`);
    }
    for (const step of report.frontier.marginal) {
      lines.push(`- ${step.from} → ${step.to}: ${step.marginal_usd_per_additional_pass !== null ? `${formatUsd(step.marginal_usd_per_additional_pass)} per additional passing task` : "no additional passes"}`);
    }
  }

  lines.push("", "## Attempts", "");
  for (const attempt of report.attempts) {
    const bits = [
      attempt.pass ? "PASS" : `FAIL (${attempt.failure_kind})`,
      `status ${attempt.status}`,
      attempt.stop_reason ? `stop ${attempt.stop_reason}` : null,
      attempt.cost_usd !== null ? formatUsd(attempt.cost_usd) : "cost unreported",
      formatMs(attempt.provider_duration_ms),
      `${attempt.changed_paths.length} file(s)`,
    ].filter(Boolean);
    lines.push(`- **${attempt.attempt_id}** — ${bits.join(" · ")}${attempt.artifacts?.patch ? ` — patch: \`${attempt.artifacts.patch}\`` : ""}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatDeltaPp(value) {
  if (value === null || value === undefined) return "n/a";
  const pp = Math.round(value * 100);
  return `${pp >= 0 ? "+" : ""}${pp}pp`;
}

function formatP(value) {
  return value === null || value === undefined ? "n/a" : value.toFixed(4);
}

export function renderEvalGridMarkdown(grid) {
  const lines = [];
  lines.push("# Model x difficulty grid");
  lines.push("");
  lines.push(`Aggregated from ${grid.generated_from.count} run(s). Baseline arm: \`${grid.baseline_arm ?? "n/a"}\`.`);
  lines.push("Cells show the agentify-baseline pass-rate delta and the discordant-pair count (agentify-only / baseline-only). Models are ordered weakest-first (top row = weakest baseline), so context is load-bearing when the delta is largest at the top and shrinks downward toward the stronger models.");
  if (grid.generated_from.scoped_to_job || grid.generated_from.scoped_to_import) {
    const at = grid.generated_from.scoped_to_import ? ` imported ${grid.generated_from.scoped_to_import}` : "";
    lines.push(`Scoped to the latest import batch (job \`${grid.generated_from.scoped_to_job ?? "n/a"}\`${at}). Pass explicit run ids to aggregate across batches.`);
  }
  lines.push("");

  // Delta grid: rows = models (weakest -> strongest), cols = difficulties.
  const cellAt = (model, difficulty) => grid.cells.find((cell) => cell.model === model && cell.difficulty === difficulty);
  const header = ["model \\ difficulty", ...grid.difficulties];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const model of grid.models) {
    const row = [model];
    for (const difficulty of grid.difficulties) {
      const cell = cellAt(model, difficulty);
      if (!cell) {
        row.push("-");
        continue;
      }
      const marker = cell.qualifies_acceptance ? " [x]" : cell.significant ? " *" : "";
      row.push(`${formatDeltaPp(cell.pass_rate_delta)} (${cell.discordant.agentify_only_pass}/${cell.discordant.baseline_only_pass})${marker}`);
    }
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");
  lines.push("`[x]` = >=5 discordant pairs favoring agentify at p<0.05 (the #317 acceptance target); `*` = significant but fewer than 5 discordant.");
  lines.push("");

  // Per-cell detail.
  lines.push("## Cells");
  lines.push("");
  lines.push("| model | difficulty | agentify | baseline | delta | discordant (a/b) | sign p | cost/pass a | cost/pass b |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const cell of grid.cells) {
    lines.push([
      "",
      cell.model,
      cell.difficulty,
      `${cell.agentify.passes}/${cell.agentify.attempts} (${formatRate(cell.agentify.pass_rate)})`,
      `${cell.baseline.passes}/${cell.baseline.attempts} (${formatRate(cell.baseline.pass_rate)})`,
      formatDeltaPp(cell.pass_rate_delta),
      `${cell.discordant.agentify_only_pass}/${cell.discordant.baseline_only_pass}`,
      formatP(cell.sign_test_p),
      formatUsd(cell.agentify.cost_per_pass_usd),
      formatUsd(cell.baseline.cost_per_pass_usd),
      "",
    ].join(" | ").trim());
  }
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(grid.verdict.acceptance_met ? `PASS: ${grid.verdict.reason}` : `NOT MET: ${grid.verdict.reason}`);
  if (grid.generated_from.skipped.length > 0) {
    lines.push("");
    lines.push(`Skipped ${grid.generated_from.skipped.length} run(s): ${grid.generated_from.skipped.map((entry) => `${entry.run_id} (${entry.reason})`).join("; ")}`);
  }
  return lines.join("\n");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

export function renderEvalReportHtml(report) {
  const harnessProvenance = report.harbor
    ? ` · job <code>${escapeHtml(report.harbor.job)}</code>${report.harbor.dataset ? ` · dataset <code>${escapeHtml(`${report.harbor.dataset.name}@${report.harbor.dataset.version}`)}</code>` : ""}`
    : report.swebench
      ? ` · job <code>${escapeHtml(report.swebench.job)}</code>${report.swebench.dataset ? ` · dataset <code>${escapeHtml(`${report.swebench.dataset.name}@${String(report.swebench.dataset.revision || "").slice(0, 12)}`)}</code>` : ""} · suite <code>${escapeHtml(report.swebench.suite ?? "n/a")}</code>`
      : report.repobench
        ? ` · job <code>${escapeHtml(report.repobench.job)}</code>${report.repobench.dataset ? ` · dataset <code>${escapeHtml(`${report.repobench.dataset.name}@${String(report.repobench.dataset.revision || "").slice(0, 12)}`)}</code>` : ""} · suite <code>${escapeHtml(report.repobench.suite ?? "n/a")}</code>`
        : "";
  const armRows = Object.entries(report.arms).map(([arm, metrics]) => `
    <tr>
      <th scope="row"><code>${escapeHtml(arm)}</code></th>
      <td>${metrics.passes}/${metrics.attempts} (${formatRate(metrics.pass_rate)})</td>
      <td>${formatCi(metrics.pass_rate_ci95)}</td>
      <td>${formatUsd(metrics.cost.per_attempt_usd)}</td>
      <td>${formatUsd(metrics.cost.per_pass_usd)}</td>
      <td>${formatMs(metrics.latency.provider_p50_ms)}</td>
      <td>${formatMs(metrics.latency.provider_p95_ms)}</td>
      <td>${metrics.turns.mean ?? "n/a"} <small>${escapeHtml(formatTurnScope(metrics.turns.scope))}</small></td>
      <td>${metrics.turns_to_first_edit.mean ?? "n/a"}</td>
      <td>${metrics.failure_breakdown.forbidden_change || 0}</td>
    </tr>`).join("");

  const pairedRows = report.paired.map((pair) => `
    <tr>
      <th scope="row"><code>${escapeHtml(pair.baseline)}</code></th>
      <td>${pair.pairs}</td>
      <td>${escapeHtml(pair.paired_sample_ids.join(", ") || "none")}</td>
      <td>${pair.pass_rate_delta ?? "n/a"}</td>
      <td>${pair.discordant.agentify_only_pass} / ${pair.discordant.baseline_only_pass}</td>
      <td>${pair.cost_per_pass_delta_usd ?? "n/a"}</td>
      <td>${pair.provider_p95_delta_ms ?? "n/a"}</td>
    </tr>`).join("");

  const economicsRows = report.economics.comparisons.map((comparison) => {
    const repeated = comparison.repeated_failure_cost_avoided;
    const repeatedReceipt = repeated.pairs > 0
      ? `${formatUsd(repeated.cost_avoided_usd)} / ${formatCount(repeated.turns_avoided, "turns")} (${repeated.pairs} pair(s))`
      : "none observed";
    return `
    <tr>
      <th scope="row"><code>${escapeHtml(comparison.baseline)}</code></th>
      <td>${escapeHtml(formatUsd(comparison.cost_per_pass.agentify_usd))}</td>
      <td>${escapeHtml(formatUsd(comparison.cost_per_pass.baseline_usd))}</td>
      <td>${comparison.multisession_pairs}</td>
      <td>${escapeHtml(formatCount(comparison.phase_b.tokens.avoided, "tokens"))}</td>
      <td>${escapeHtml(formatCount(comparison.phase_b.turns.avoided, "turns"))}</td>
      <td>${escapeHtml(`${formatCount(comparison.phase_b.turns_to_first_edit.avoided, "turns-to-first-edit")} (${comparison.phase_b.turns_to_first_edit.improved_pairs}/${comparison.phase_b.turns_to_first_edit.regressed_pairs}, p=${formatP(comparison.phase_b.turns_to_first_edit.sign_test_p)})`)}</td>
      <td>${escapeHtml(formatBreakEven(comparison.break_even))}</td>
      <td>${escapeHtml(formatAmortizedCost(comparison.break_even))}</td>
      <td>${escapeHtml(repeatedReceipt)}</td>
    </tr>`;
  }).join("");

  const attemptBlocks = report.attempts.map((attempt) => `
    <details>
      <summary><code>${escapeHtml(attempt.attempt_id)}</code> — ${attempt.pass ? "PASS" : `FAIL (${escapeHtml(attempt.failure_kind ?? "")})`} · ${escapeHtml(formatUsd(attempt.cost_usd))} · ${escapeHtml(formatMs(attempt.provider_duration_ms))}</summary>
      <table>
        <tr><th scope="row">status</th><td>${escapeHtml(attempt.status)}</td></tr>
        <tr><th scope="row">stop reason</th><td>${escapeHtml(attempt.stop_reason ?? "n/a")}</td></tr>
        <tr><th scope="row">turns</th><td>${escapeHtml(attempt.num_turns ?? "n/a")}</td></tr>
        <tr><th scope="row">turns to first edit</th><td>${escapeHtml(attempt.turns_to_first_edit ?? "n/a")}</td></tr>
        <tr><th scope="row">changed paths</th><td>${attempt.changed_paths.map((p) => `<code>${escapeHtml(p)}</code>`).join(", ") || "none"}</td></tr>
        <tr><th scope="row">forbidden</th><td>${attempt.forbidden_violations.map((v) => `<code>${escapeHtml(v.path)}</code>`).join(", ") || "none"}</td></tr>
        <tr><th scope="row">patch</th><td><code>${escapeHtml(attempt.artifacts?.patch ?? "n/a")}</code></td></tr>
      </table>
      ${attempt.checks.map((check) => `
        <p><code>${escapeHtml(check.command)}</code> — ${check.passed ? "passed" : `exit ${escapeHtml(check.exit_code)}${check.timed_out ? " (timed out)" : ""}`}</p>
        ${check.output_tail ? `<pre>${escapeHtml(check.output_tail)}</pre>` : ""}`).join("")}
      ${attempt.error ? `<pre>${escapeHtml(attempt.error)}</pre>` : ""}
    </details>`).join("");

  const frontierItems = report.frontier.points.filter((point) => point.on_frontier)
    .map((point) => `<li><code>${escapeHtml(point.arm)}</code>: ${formatRate(point.pass_rate)} at ${formatUsd(point.cost_per_pass_usd)}/pass</li>`)
    .join("");
  const marginalItems = report.frontier.marginal
    .map((step) => `<li>${escapeHtml(step.from)} → ${escapeHtml(step.to)}: ${step.marginal_usd_per_additional_pass !== null ? `${formatUsd(step.marginal_usd_per_additional_pass)} per additional passing task` : "no additional passes"}</li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Agentify eval report">
<title>Eval report — ${escapeHtml(report.task.id)} (${escapeHtml(report.run_id)})</title>
<style>
  :root {
    color-scheme: dark light;
    --bg: #0d1117;
    --surface: #161b22;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --good: #7ee787;
    --amber: #d29922;
    --border: #30363d;
    --term-bg: #010409;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #ffffff;
      --surface: #f6f8fa;
      --text: #1f2328;
      --text-dim: #59636e;
      --accent: #0969da;
      --good: #1a7f37;
      --amber: #9a6700;
      --border: #d0d7de;
      --term-bg: #f6f8fa;
    }
  }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; line-height: 1.6; }
  header.hero { max-width: 70rem; margin-inline: auto; padding: 3.5rem 1.5rem 1rem; text-align: center; }
  main { max-width: 70rem; margin-inline: auto; padding: 0 1.5rem 4rem; }
  section { margin-block-start: 3.5rem; }
  h1, h2 { line-height: 1.15; letter-spacing: -0.02em; text-wrap: balance; }
  h1 { margin: 0 0 0.75rem; font-size: clamp(1.8rem, 1.4rem + 2vw, 2.8rem); }
  h2 { margin-block-end: 0.4rem; font-size: 1.35rem; }
  p { max-width: 80ch; text-wrap: pretty; }
  .hero p { margin-inline: auto; }
  .tagline, .lede, .formula { color: var(--text-dim); }
  .eyebrow { margin-block-end: 0.25rem; color: var(--good); font-family: var(--mono); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
  .meta-row { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: center; }
  .meta { border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text-dim); font-family: var(--mono); font-size: 0.75rem; padding: 0.2rem 0.75rem; }
  .card { border: 1px solid var(--border); border-radius: 0.65rem; background: var(--surface); padding: 1rem 1.25rem; }
  .verdict { margin: 1.5rem auto 0; border-inline-start: 0.25rem solid var(--amber); text-align: start; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  caption { padding-block: 0 0.5rem; color: var(--text-dim); text-align: start; font-size: 0.8rem; }
  th, td { border-block-end: 1px solid var(--border); padding: 0.55rem 0.65rem; text-align: start; vertical-align: top; }
  thead th { color: var(--text-dim); font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; text-wrap: balance; }
  tbody tr:last-child > :is(th, td) { border-block-end: 0; }
  code { border: 1px solid var(--border); border-radius: 0.3rem; background: var(--surface); font-family: var(--mono); font-size: 0.86em; padding: 0.05rem 0.35rem; overflow-wrap: anywhere; }
  pre { border: 1px solid var(--border); border-radius: 0.4rem; background: var(--term-bg); color: var(--text); font-family: var(--mono); padding: 0.75rem; overflow-x: auto; }
  pre code { background: transparent; color: inherit; padding: 0; }
  .labels { color: var(--good); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
  details { margin-block: 0.6rem; border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.55rem 0.75rem; }
  summary { min-block-size: 1.5rem; cursor: pointer; }
  footer { border-block-start: 1px solid var(--border); padding: 1.5rem; color: var(--text-dim); font-family: var(--mono); font-size: 0.75rem; text-align: center; }
  .skip-link { position: fixed; inset-block-start: 0.75rem; inset-inline-start: 0.75rem; z-index: 10; border: 1px solid var(--border); border-radius: 0.4rem; background: var(--surface); color: var(--text); padding: 0.5rem 0.75rem; transform: translateY(-250%); }
  .skip-link:focus { transform: translateY(0); }
  :focus-visible { outline: 0.15rem solid var(--accent); outline-offset: 0.15rem; }
  @media (max-width: 35rem) {
    header.hero { padding-block-start: 2.5rem; }
    main { padding-inline: 1rem; }
  }
  @media print {
    :root { color-scheme: light; --bg: #fff; --surface: #fff; --text: #111; --text-dim: #555; --border: #ccc; }
    details, section { break-inside: avoid; }
  }
</style>
</head>
<body>
<a class="skip-link" href="#content">Skip to eval report</a>
<header class="hero">
  <p class="eyebrow">Agentify eval receipt</p>
  <h1>Eval report — ${escapeHtml(report.task.id)}</h1>
  <p class="tagline">Paired quality, cost, and memory economics from one reproducible run.</p>
  <div class="meta-row">
    <span class="meta">run ${escapeHtml(report.run_id)}</span>
    <span class="meta">${escapeHtml(report.harness ?? "native")} harness</span>
    <span class="meta">${report.completeness.completed_attempts}/${report.completeness.planned_attempts} attempts</span>
    ${report.completeness.labels.length > 0 ? `<span class="meta labels">${escapeHtml(report.completeness.labels.join(", ").toUpperCase())}</span>` : ""}
  </div>
  <p class="card verdict"><strong>Verdict:</strong> ${escapeHtml(report.verdict.winner ? `${report.verdict.winner} — ${report.verdict.reason}` : report.verdict.reason)}</p>
</header>
<main id="content" tabindex="-1" data-testid="agentify-eval-report">
<section aria-labelledby="run-title">
<p class="eyebrow">Provenance</p>
<h2 id="run-title">Run identity</h2>
<p class="lede">
  Model <code>${escapeHtml(report.task.model)}</code> · profile <code>${escapeHtml(report.task.profile)}</code> · base <code>${escapeHtml(String(report.task.base_sha || "").slice(0, 12))}</code><br>
  Harness: <code>${escapeHtml(report.harness ?? "native")}</code>${harnessProvenance}<br>
  Versions: agentify ${escapeHtml(report.versions.agentify ?? "n/a")}, claude ${escapeHtml(report.versions.claude ?? "n/a")}${report.versions.harbor ? `, harbor ${escapeHtml(report.versions.harbor)}` : ""}${report.versions.swebench ? `, swebench ${escapeHtml(report.versions.swebench)}` : ""} · prompt sha256 <code>${escapeHtml(String(report.task.prompt_sha256 || "").slice(0, 16))}</code>
</p>
</section>
<section aria-labelledby="arms-title">
<p class="eyebrow">Outcome and spend</p>
<h2 id="arms-title">Arms</h2>
<div class="table-wrap"><table>
  <caption>Per-arm quality, cost, latency, and turn totals</caption>
  <thead><tr><th scope="col">arm</th><th scope="col">pass rate</th><th scope="col">95% CI</th><th scope="col">cost/attempt</th><th scope="col">cost/pass</th><th scope="col">P50</th><th scope="col">P95</th><th scope="col">mean turns (scope)</th><th scope="col">mean turns to first edit</th><th scope="col">forbidden fails</th></tr></thead>
  <tbody>${armRows}</tbody>
</table></div>
${Object.values(report.arms).some((metrics) => metrics.turns.scope === "phase_b_recall") ? '<p class="formula">Multisession turn counts cover the graded phase-B recall only; Agentify cost/attempt and cost/pass include both the phase-A seed and phase-B recall.</p>' : ""}
</section>
${Object.values(report.arms).some((metrics) => metrics.repobench) ? `<section aria-labelledby="repobench-title">
<p class="eyebrow">Repo-context benchmark</p>
<h2 id="repobench-title">Completion quality (repobench)</h2>
<div class="table-wrap"><table>
  <caption>RepoBench line-completion metrics per arm; answer-in-context counts retrieved snippets that quote the target line</caption>
  <thead><tr><th scope="col">arm</th><th scope="col">exact match</th><th scope="col">mean edit similarity</th><th scope="col">mean identifier F1</th><th scope="col">answer-in-context attempts</th></tr></thead>
  <tbody>${Object.entries(report.arms).filter(([, metrics]) => metrics.repobench).map(([arm, metrics]) => `
    <tr>
      <th scope="row"><code>${escapeHtml(arm)}</code></th>
      <td>${formatRate(metrics.repobench.exact_match_rate)}</td>
      <td>${metrics.repobench.mean_edit_similarity ?? "n/a"}</td>
      <td>${metrics.repobench.mean_identifier_f1 ?? "n/a"}</td>
      <td>${metrics.repobench.answer_in_context_attempts}/${metrics.repobench.attempts}</td>
    </tr>`).join("")}</tbody>
</table></div>
${report.repobench?.retrieval ? `<p class="formula">Index retrieval vs gold cross-file context (token-free, ${report.repobench.retrieval.tasks} task(s), $0): gold file ${escapeHtml(formatRate(report.repobench.retrieval.def_hit_rate))} (hit@1 ${escapeHtml(formatRate(report.repobench.retrieval.hit_at_1))}, hit@5 ${escapeHtml(formatRate(report.repobench.retrieval.hit_at_5))}, MRR ${escapeHtml(String(report.repobench.retrieval.mrr ?? "n/a"))}) · snippet ${escapeHtml(formatRate(report.repobench.retrieval.snippet_hit_rate))} · dependency edge via refs ${escapeHtml(formatRate(report.repobench.retrieval.ref_edge_hit_rate))} / impacts ${escapeHtml(formatRate(report.repobench.retrieval.impact_hit_rate))}.</p>` : ""}
</section>` : ""}
${economicsRows ? `<section aria-labelledby="economics-title">
<p class="eyebrow">Value receipt</p>
<h2 id="economics-title">Memory economics</h2>
<p class="lede">Cost belongs next to successful work. Rediscovery is the paired phase-B baseline total minus the Agentify total; missing telemetry stays unavailable rather than becoming zero.</p>
<div class="table-wrap"><table>
  <caption>Amortized context economics from paired provider telemetry</caption>
  <thead><tr><th scope="col">baseline</th><th scope="col">cost/pass agentify</th><th scope="col">cost/pass baseline</th><th scope="col">phase-B pairs</th><th scope="col">tokens avoided</th><th scope="col">turns avoided</th><th scope="col">first-edit turns avoided</th><th scope="col">break-even</th><th scope="col">amortized cost/recall at break-even</th><th scope="col">repeated failure avoided</th></tr></thead>
  <tbody>${economicsRows}</tbody>
</table></div>
<p class="formula"><strong>Formula:</strong> ${escapeHtml(report.economics.formulas.break_even)}.</p>
</section>` : ""}
${pairedRows ? `<section aria-labelledby="paired-title"><h2 id="paired-title">Paired deltas (agentify − baseline)</h2>
<div class="table-wrap"><table>
  <caption>Matched repeat indices only</caption>
  <thead><tr><th scope="col">baseline</th><th scope="col">pairs</th><th scope="col">paired samples</th><th scope="col">Δ pass rate</th><th scope="col">discordant (agentify / baseline)</th><th scope="col">Δ cost/pass</th><th scope="col">Δ P95 (ms)</th></tr></thead>
  <tbody>${pairedRows}</tbody>
</table></div></section>` : ""}
${frontierItems ? `<section aria-labelledby="frontier-title"><h2 id="frontier-title">Cost-quality frontier</h2><ul>${frontierItems}${marginalItems}</ul></section>` : ""}
<section aria-labelledby="attempts-title">
<p class="eyebrow">Drill-down</p>
<h2 id="attempts-title">Attempts</h2>
${attemptBlocks}
</section>
</main>
<footer>Generated locally by Agentify · provider costs are reported, never guessed</footer>
</body>
</html>
`;
}

// Best-effort interchange with promptfoo's eval-results file so teams can
// load Agentify runs into its UI/assertion ecosystem. Deliberately built as
// plain JSON with zero promptfoo dependency, and under the same privacy
// rules as the native report: no raw prompt (label carries the task id and
// prompt hash), no provider argv, drill-down fields already redacted.
export function buildPromptfooExport(report) {
  const promptLabel = `${report.task.id} (prompt sha256:${String(report.task.prompt_sha256 || "").slice(0, 16)})`;
  const results = report.attempts.map((attempt) => {
    const usage = attempt.usage || {};
    const prompt = (usage.fresh_input_tokens || 0) + (usage.cache_write_tokens || 0) + (usage.cache_read_tokens || 0);
    return {
      description: attempt.attempt_id,
      vars: {
        task: report.task.id,
        arm: attempt.arm,
        repeat_index: attempt.repeat_index,
        model: report.task.model,
        profile: report.task.profile,
        base_sha: report.task.base_sha,
      },
      provider: { id: `claude:${report.task.model}`, label: attempt.arm },
      prompt: { raw: "", label: promptLabel },
      success: attempt.pass,
      score: attempt.pass ? 1 : 0,
      latencyMs: attempt.provider_duration_ms,
      cost: attempt.cost_usd,
      tokenUsage: { total: prompt + (usage.output_tokens || 0), prompt, completion: usage.output_tokens || 0, cached: usage.cache_read_tokens || 0 },
      gradingResult: {
        pass: attempt.pass,
        score: attempt.pass ? 1 : 0,
        reason: attempt.pass ? "all deterministic checks passed" : `failed: ${attempt.failure_kind}`,
        componentResults: attempt.checks.map((check) => ({
          pass: check.passed,
          score: check.passed ? 1 : 0,
          reason: check.passed ? "passed" : `exit ${check.exit_code}${check.timed_out ? " (timed out)" : ""}`,
          assertion: { type: "python", value: check.command },
        })),
      },
      ...(attempt.error ? { error: attempt.error } : {}),
    };
  });
  return {
    evalId: `agentify-eval-${report.run_id}`,
    results: {
      version: 2,
      timestamp: report.run_ts,
      results,
      stats: {
        successes: results.filter((result) => result.success).length,
        failures: results.filter((result) => !result.success).length,
        tokenUsage: results.reduce((totals, result) => ({
          total: totals.total + result.tokenUsage.total,
          prompt: totals.prompt + result.tokenUsage.prompt,
          completion: totals.completion + result.tokenUsage.completion,
          cached: totals.cached + result.tokenUsage.cached,
        }), { total: 0, prompt: 0, completion: 0, cached: 0 }),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Regression gates
// ---------------------------------------------------------------------------

export function parseFailOnExpressions(raw) {
  const values = (Array.isArray(raw) ? raw : [raw]).filter((value) => value !== undefined && value !== null);
  if (values.some((value) => typeof value === "boolean")) {
    // A valueless --fail-on parses to boolean true; failing it loudly beats
    // silently dropping the gate the user thought they set.
    throw new Error("--fail-on requires an explicit 'gate>threshold' expression");
  }
  const inputs = values
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (inputs.length === 0) {
    throw new Error(`eval compare requires at least one --fail-on 'gate>threshold' (gates: ${COMPARE_GATES.join(", ")})`);
  }
  return inputs.map((expression) => {
    const match = expression.match(/^([a-z0-9_]+)\s*>\s*([0-9.]+)$/i);
    if (!match || !COMPARE_GATES.includes(match[1])) {
      throw new Error(`Unrecognized --fail-on expression "${expression}". Use one of: ${COMPARE_GATES.map((gate) => `'${gate}>0.05'`).join(", ")}`);
    }
    const threshold = Number(match[2]);
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw new Error(`--fail-on threshold must be a non-negative number, got "${match[2]}"`);
    }
    return { metric: match[1], threshold };
  });
}

function gateValue(metrics, metric) {
  const raw = metric === "pass_rate_drop"
    ? metrics?.pass_rate
    : metric === "cost_per_pass_increase"
      ? metrics?.cost?.per_pass_usd
      : metric === "p95_latency_increase"
        ? metrics?.latency?.provider_p95_ms
        : null;
  // Absent or malformed metrics normalize to null (unavailable) — NaN
  // arithmetic would classify every comparison as "passed".
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function evaluateGate(gate, arm, current, baseline) {
  const currentValue = gateValue(current, gate.metric);
  const baselineValue = gateValue(baseline, gate.metric);
  const base = {
    gate: gate.metric,
    threshold: gate.threshold,
    arm,
    baseline_value: baselineValue,
    current_value: currentValue,
  };
  if (baselineValue === null) {
    // Nothing to regress from — recorded, never silently ignored, and if
    // every gate ends up skipped the comparison as a whole errors out.
    return { ...base, status: "skipped", reason: "baseline metric unavailable" };
  }
  if (currentValue === null) {
    // The metric existed and is now gone (e.g. zero passes): that is a
    // regression, not an excuse.
    return { ...base, status: "violated", reason: "current metric unavailable while baseline had one" };
  }
  let delta;
  if (gate.metric === "pass_rate_drop") {
    delta = round(baselineValue - currentValue, 4);
  } else {
    if (baselineValue === 0) {
      // Any increase from a zero baseline is an infinite relative increase.
      return currentValue > 0
        ? { ...base, delta: null, status: "violated", reason: "baseline value is zero and current is positive (unbounded relative increase)" }
        : { ...base, delta: 0, status: "passed" };
    }
    delta = round((currentValue - baselineValue) / baselineValue, 4);
  }
  return {
    ...base,
    delta,
    status: delta > gate.threshold ? "violated" : "passed",
  };
}

function assertComparable(currentReport, baselineReport, force) {
  const mismatches = [];
  const current = currentReport.task;
  const baseline = baselineReport.task;
  // Old reports without a fingerprint fall back to the prompt hash.
  const fingerprint = (task) => task.fingerprint_sha256 ?? task.prompt_sha256;
  if (fingerprint(current) !== fingerprint(baseline)) mismatches.push("task fingerprint (prompt/grader/setup/limits)");
  if (current.model !== baseline.model) mismatches.push("model");
  if (current.base_sha !== baseline.base_sha) mismatches.push("base commit");
  // A native run and an imported Harbor run measure different environments;
  // gating one against the other needs an explicit --force.
  if ((currentReport.harness ?? "native") !== (baselineReport.harness ?? "native")) mismatches.push("harness");
  for (const [label, report] of [["current", currentReport], ["baseline", baselineReport]]) {
    // Canonical completeness fields, not the derived labels — a report with
    // stale or stripped labels must not slip through.
    const states = [
      ...(report.completeness?.partial === true ? ["partial"] : []),
      ...(report.completeness?.paired === false ? ["unpaired"] : []),
    ];
    if (states.length > 0) mismatches.push(`${label} run is ${states.join(" and ")}`);
  }
  if (mismatches.length > 0 && !force) {
    throw new Error(`Reports are not comparable: ${mismatches.join("; ")}. Pass --force to gate anyway (results may not be like-for-like).`);
  }
  return mismatches;
}

export function compareEvalReports(currentReport, baselineReport, failOnRaw, options = {}) {
  for (const [label, report] of [["current", currentReport], ["baseline", baselineReport]]) {
    if (report?.schema !== EVAL_REPORT_SCHEMA_VERSION) {
      throw new Error(`${label} report has schema "${report?.schema}"; expected "${EVAL_REPORT_SCHEMA_VERSION}" (generate it with: agentify eval report --format json)`);
    }
  }
  const gates = parseFailOnExpressions(failOnRaw);
  const comparabilityIssues = assertComparable(currentReport, baselineReport, options.force === true);

  const baselineArms = Object.keys(baselineReport.arms);
  const sharedArms = baselineArms.filter((arm) => currentReport.arms[arm]);
  if (sharedArms.length === 0) {
    throw new Error("current and baseline reports share no arms; nothing to compare");
  }
  const results = [];
  // A baseline arm that vanished from the current run is a regression in
  // coverage, not something to skip quietly.
  for (const arm of baselineArms) {
    if (!currentReport.arms[arm]) {
      results.push({ gate: "arm_presence", threshold: null, arm, status: "violated", reason: "arm present in baseline but missing from current" });
    }
  }
  for (const gate of gates) {
    for (const arm of sharedArms) {
      results.push(evaluateGate(gate, arm, currentReport.arms[arm], baselineReport.arms[arm]));
    }
  }
  if (!results.some((result) => result.status !== "skipped")) {
    throw new Error("No gate could be evaluated: every metric was unavailable in the baseline report. Fix telemetry or gate on a different metric.");
  }
  const violations = results.filter((result) => result.status === "violated");
  return {
    schema: "eval-compare-v1",
    command: "eval",
    action: "compare",
    current: { run_id: currentReport.run_id, profile: currentReport.task.profile, labels: currentReport.completeness.labels },
    baseline: { run_id: baselineReport.run_id, profile: baselineReport.task.profile, labels: baselineReport.completeness.labels },
    comparability_issues: comparabilityIssues,
    forced: options.force === true && comparabilityIssues.length > 0,
    arms: sharedArms,
    gates: results,
    violations,
    passed: violations.length === 0,
    exit_code: violations.length === 0 ? COMPARE_EXIT_PASS : COMPARE_EXIT_VIOLATION,
  };
}
