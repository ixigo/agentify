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
    turns: { mean: round(mean(turns), 2), max: turns.length > 0 ? Math.max(...turns) : null },
    changed_files: { mean: round(mean(changedCounts), 2), max: changedCounts.length > 0 ? Math.max(...changedCounts) : null },
    failure_breakdown: failureBreakdown,
    stop_reasons: stopReasons,
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
    provider_duration_ms: record.provider?.duration_ms ?? null,
    duration_ms: record.duration_ms ?? null,
    cost_usd: record.provider?.cost_usd ?? null,
    cost_source: typeof record.provider?.cost_usd === "number" ? "provider" : "unreported",
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
    artifacts_root: path.relative(root, runDir),
    task: {
      id: task.id ?? null,
      // Never the raw prompt: the hash is enough to prove two reports ran
      // the same task.
      prompt_sha256: task.prompt ? createHash("sha256").update(String(task.prompt)).digest("hex") : null,
      // Fingerprint covers everything that defines task identity for a fair
      // comparison — a changed grader or setup is a different task even with
      // the same prompt.
      fingerprint_sha256: createHash("sha256").update(JSON.stringify({
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
    },
    completeness,
    arms,
    paired,
    frontier: costQualityFrontier(arms),
    verdict: buildVerdict(arms, completeness, byArm),
    context_metrics: contextMetricsByArm(byArm, attempts),
    attempts: attempts.map(attemptDrilldown),
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

export function renderEvalReportMarkdown(report) {
  const lines = [
    `# Eval report — ${report.task.id} (${report.run_id})`,
    "",
    `- Model: \`${report.task.model}\` · profile \`${report.task.profile}\` · base \`${String(report.task.base_sha || "").slice(0, 12)}\``,
    `- Harness: ${report.harness ?? "native"}${report.harbor ? ` (job \`${report.harbor.job}\`, dataset ${report.harbor.dataset ? `${report.harbor.dataset.name}@${report.harbor.dataset.version}` : "n/a"})` : ""}`,
    `- Versions: agentify ${report.versions.agentify ?? "n/a"}, claude ${report.versions.claude ?? "n/a"}${report.versions.harbor ? `, harbor ${report.versions.harbor}` : ""}`,
    `- Attempts: ${report.completeness.completed_attempts}/${report.completeness.planned_attempts}${report.completeness.labels.length > 0 ? ` — **${report.completeness.labels.join(", ").toUpperCase()}**` : ""}`,
    `- Verdict: ${report.verdict.winner ? `**${report.verdict.winner}** — ${report.verdict.reason}` : report.verdict.reason}`,
    "",
    "## Arms",
    "",
    "| arm | pass rate | 95% CI | cost/attempt | cost/pass | P50 | P95 | turns | changed files | forbidden fails |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const [arm, metrics] of Object.entries(report.arms)) {
    lines.push(`| ${arm} | ${metrics.passes}/${metrics.attempts} (${formatRate(metrics.pass_rate)}) | ${formatCi(metrics.pass_rate_ci95)} | ${formatUsd(metrics.cost.per_attempt_usd)} | ${formatUsd(metrics.cost.per_pass_usd)} | ${formatMs(metrics.latency.provider_p50_ms)} | ${formatMs(metrics.latency.provider_p95_ms)} | ${metrics.turns.mean ?? "n/a"} | ${metrics.changed_files.mean ?? "n/a"} | ${metrics.failure_breakdown.forbidden_change || 0} |`);
  }
  for (const [arm, metrics] of Object.entries(report.arms)) {
    if (metrics.cost.unreported_attempts > 0) {
      lines.push("", `> ${arm}: provider reported cost for ${metrics.cost.reported_attempts}/${metrics.attempts} attempt(s); per-attempt and per-pass cost are withheld rather than estimated.`);
    }
    if (metrics.tokens.usage_missing_attempts > 0) {
      lines.push("", `> ${arm}: ${metrics.tokens.usage_missing_attempts} attempt(s) reported no token usage.`);
    }
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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

export function renderEvalReportHtml(report) {
  const armRows = Object.entries(report.arms).map(([arm, metrics]) => `
    <tr>
      <td><code>${escapeHtml(arm)}</code></td>
      <td>${metrics.passes}/${metrics.attempts} (${formatRate(metrics.pass_rate)})</td>
      <td>${formatCi(metrics.pass_rate_ci95)}</td>
      <td>${formatUsd(metrics.cost.per_attempt_usd)}</td>
      <td>${formatUsd(metrics.cost.per_pass_usd)}</td>
      <td>${formatMs(metrics.latency.provider_p50_ms)}</td>
      <td>${formatMs(metrics.latency.provider_p95_ms)}</td>
      <td>${metrics.turns.mean ?? "n/a"}</td>
      <td>${metrics.failure_breakdown.forbidden_change || 0}</td>
    </tr>`).join("");

  const pairedRows = report.paired.map((pair) => `
    <tr>
      <td><code>${escapeHtml(pair.baseline)}</code></td>
      <td>${pair.pairs}</td>
      <td>${escapeHtml(pair.paired_sample_ids.join(", ") || "none")}</td>
      <td>${pair.pass_rate_delta ?? "n/a"}</td>
      <td>${pair.discordant.agentify_only_pass} / ${pair.discordant.baseline_only_pass}</td>
      <td>${pair.cost_per_pass_delta_usd ?? "n/a"}</td>
      <td>${pair.provider_p95_delta_ms ?? "n/a"}</td>
    </tr>`).join("");

  const attemptBlocks = report.attempts.map((attempt) => `
    <details>
      <summary><code>${escapeHtml(attempt.attempt_id)}</code> — ${attempt.pass ? "PASS" : `FAIL (${escapeHtml(attempt.failure_kind ?? "")})`} · ${escapeHtml(formatUsd(attempt.cost_usd))} · ${escapeHtml(formatMs(attempt.provider_duration_ms))}</summary>
      <table>
        <tr><th>status</th><td>${escapeHtml(attempt.status)}</td></tr>
        <tr><th>stop reason</th><td>${escapeHtml(attempt.stop_reason ?? "n/a")}</td></tr>
        <tr><th>turns</th><td>${escapeHtml(attempt.num_turns ?? "n/a")}</td></tr>
        <tr><th>changed paths</th><td>${attempt.changed_paths.map((p) => `<code>${escapeHtml(p)}</code>`).join(", ") || "none"}</td></tr>
        <tr><th>forbidden</th><td>${attempt.forbidden_violations.map((v) => `<code>${escapeHtml(v.path)}</code>`).join(", ") || "none"}</td></tr>
        <tr><th>patch</th><td><code>${escapeHtml(attempt.artifacts?.patch ?? "n/a")}</code></td></tr>
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
<title>Eval report — ${escapeHtml(report.task.id)} (${escapeHtml(report.run_id)})</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; color: #1a1a1a; }
  table { border-collapse: collapse; margin: 0.75rem 0; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 0.3rem 0.6rem; text-align: left; }
  th { background: #f5f5f5; }
  code { background: #f2f2f2; padding: 0 0.25rem; border-radius: 3px; }
  pre { background: #f7f7f7; padding: 0.5rem; overflow-x: auto; }
  .labels { color: #b00; font-weight: 600; }
  details { margin: 0.5rem 0; border: 1px solid #eee; border-radius: 4px; padding: 0.4rem 0.6rem; }
</style>
</head>
<body>
<h1>Eval report — ${escapeHtml(report.task.id)}</h1>
<p>
  Run <code>${escapeHtml(report.run_id)}</code> · model <code>${escapeHtml(report.task.model)}</code> · profile <code>${escapeHtml(report.task.profile)}</code> · base <code>${escapeHtml(String(report.task.base_sha || "").slice(0, 12))}</code><br>
  Harness: <code>${escapeHtml(report.harness ?? "native")}</code>${report.harbor ? ` · job <code>${escapeHtml(report.harbor.job)}</code>${report.harbor.dataset ? ` · dataset <code>${escapeHtml(`${report.harbor.dataset.name}@${report.harbor.dataset.version}`)}</code>` : ""}` : ""}<br>
  Versions: agentify ${escapeHtml(report.versions.agentify ?? "n/a")}, claude ${escapeHtml(report.versions.claude ?? "n/a")}${report.versions.harbor ? `, harbor ${escapeHtml(report.versions.harbor)}` : ""} · prompt sha256 <code>${escapeHtml(String(report.task.prompt_sha256 || "").slice(0, 16))}</code><br>
  Attempts ${report.completeness.completed_attempts}/${report.completeness.planned_attempts}
  ${report.completeness.labels.length > 0 ? `<span class="labels">— ${escapeHtml(report.completeness.labels.join(", ").toUpperCase())}</span>` : ""}
</p>
<p><strong>Verdict:</strong> ${escapeHtml(report.verdict.winner ? `${report.verdict.winner} — ${report.verdict.reason}` : report.verdict.reason)}</p>
<h2>Arms</h2>
<table>
  <tr><th>arm</th><th>pass rate</th><th>95% CI</th><th>cost/attempt</th><th>cost/pass</th><th>P50</th><th>P95</th><th>turns</th><th>forbidden fails</th></tr>
  ${armRows}
</table>
${pairedRows ? `<h2>Paired deltas (agentify − baseline)</h2>
<table>
  <tr><th>baseline</th><th>pairs</th><th>paired samples</th><th>Δ pass rate</th><th>discordant (agentify / baseline)</th><th>Δ cost/pass</th><th>Δ P95 (ms)</th></tr>
  ${pairedRows}
</table>` : ""}
${frontierItems ? `<h2>Cost-quality frontier</h2><ul>${frontierItems}${marginalItems}</ul>` : ""}
<h2>Attempts</h2>
${attemptBlocks}
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
