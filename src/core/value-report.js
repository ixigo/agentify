import path from "node:path";

import { listEvals } from "./eval.js";
import { buildEvalReport } from "./eval-report.js";
import { buildStatsReport } from "./stats.js";
import { readValueEvents } from "./value-telemetry.js";

const VALUE_REPORT_SCHEMA_VERSION = "value-report-v1";
const DEFAULT_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function rounded(value, digits = 6) {
  return Number(finite(value).toFixed(digits));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(finite(value));
}

function formatCost(value, fallback = "not reported") {
  return value === null || value === undefined ? fallback : `$${finite(value).toFixed(4)}`;
}

function formatDuration(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return "not recorded";
  const seconds = finite(milliseconds) / 1000;
  return seconds >= 60 ? `${(seconds / 60).toFixed(1)}m` : `${seconds.toFixed(1)}s`;
}

function contextEventTotals(events) {
  const injections = events.filter((event) => event.type === "context_injection");
  const reasons = {
    previous_decision: 0,
    previous_note: 0,
    session_summary: 0,
    hot_file: 0,
    previous_failure: 0,
    stale_warning: 0,
  };
  for (const event of injections) {
    for (const key of Object.keys(reasons)) {
      reasons[key] += finite(event.reasons?.[key]);
    }
  }
  return {
    injection_events: injections.filter((event) => finite(event.injected_items) > 0).length,
    injected_items: injections.reduce((sum, event) => sum + finite(event.injected_items), 0),
    estimated_tokens: injections.reduce((sum, event) => sum + finite(event.estimated_tokens), 0),
    decisions_reused: injections.reduce((sum, event) => sum + finite(event.decisions_reused), 0),
    stale_context_rejected: injections.reduce((sum, event) => sum + finite(event.stale_context_rejected), 0),
    failed_command_repeats_intercepted: events.filter((event) => event.type === "failed_command_repeat_intercepted").length,
    reasons,
  };
}

function focusedTestTotals(events) {
  const runs = events.filter((event) => event.type === "focused_test_run");
  return {
    runs: runs.length,
    passing_runs: runs.filter((event) => event.passed === true).length,
    selected_test_files: runs.reduce((sum, event) => sum + finite(event.selected_test_files), 0),
    full_suite_files_avoided: runs.reduce((sum, event) => sum + finite(event.full_suite_files_avoided), 0),
    duration_ms: runs.reduce((sum, event) => sum + finite(event.duration_ms), 0),
  };
}

function aggregateMemoryEconomics(reports) {
  // A report with multiple baseline arms reuses the same Agentify recalls in
  // every comparison. Summing those comparisons would count the treatment
  // sessions (and seed investment) once per baseline. The aggregate receipt
  // therefore accepts only reports with one unambiguous multisession baseline;
  // per-baseline detail remains available in the individual eval report.
  const comparisonsByReport = reports.map((report) => (report.economics?.comparisons || [])
    .filter((comparison) => comparison.multisession_pairs > 0));
  const excludedMultiBaselineReports = comparisonsByReport.filter((comparisons) => comparisons.length > 1).length;
  const multisession = comparisonsByReport.flatMap((comparisons) => (comparisons.length === 1 ? comparisons : []));
  const pairedRecalls = multisession.reduce((sum, comparison) => sum + comparison.multisession_pairs, 0);
  const sumMetric = (pick) => multisession.reduce((sum, comparison) => sum + finite(pick(comparison)), 0);
  const tokensMeasuredPairs = sumMetric((comparison) => comparison.phase_b.tokens.measured_pairs);
  const turnsMeasuredPairs = sumMetric((comparison) => comparison.phase_b.turns.measured_pairs);
  const costMeasuredPairs = sumMetric((comparison) => comparison.phase_b.cost_usd.measured_pairs);
  const seedMeasuredPairs = sumMetric((comparison) => comparison.memory_investment.measured_pairs);
  const rediscoveryTokens = tokensMeasuredPairs > 0 ? rounded(sumMetric((comparison) => comparison.phase_b.tokens.avoided), 2) : null;
  const rediscoveryTurns = turnsMeasuredPairs > 0 ? rounded(sumMetric((comparison) => comparison.phase_b.turns.avoided), 2) : null;

  let breakEvenSessions = null;
  let breakEvenStatus = pairedRecalls === 0 ? "not_applicable" : "unreported";
  let agentifyAmortizedCost = null;
  let baselineRediscoveryCost = null;
  if (pairedRecalls > 0 && seedMeasuredPairs === pairedRecalls && costMeasuredPairs === pairedRecalls) {
    const incrementalSeed = sumMetric((comparison) => comparison.memory_investment.incremental_seed_cost_usd);
    const recallSavings = sumMetric((comparison) => comparison.phase_b.cost_usd.avoided);
    const savingsPerRecall = recallSavings / pairedRecalls;
    if (savingsPerRecall > 0) {
      breakEvenSessions = Math.max(1, Math.ceil(Math.max(0, incrementalSeed / pairedRecalls) / savingsPerRecall));
      breakEvenStatus = "reached";
      const agentifyRecall = sumMetric((comparison) => comparison.phase_b.cost_usd.agentify_total) / pairedRecalls;
      baselineRediscoveryCost = rounded(sumMetric((comparison) => comparison.phase_b.cost_usd.baseline_total) / pairedRecalls);
      agentifyAmortizedCost = rounded((Math.max(0, incrementalSeed / pairedRecalls) + breakEvenSessions * agentifyRecall) / breakEvenSessions);
    } else {
      breakEvenStatus = "not_reached";
    }
  }

  const repeated = multisession.map((comparison) => comparison.repeated_failure_cost_avoided);
  const repeatedPairs = repeated.reduce((sum, receipt) => sum + finite(receipt?.pairs), 0);
  const repeatedCostedPairs = repeated.reduce((sum, receipt) => sum + finite(receipt?.costed_pairs), 0);
  const repeatedTurnsPairs = repeated.reduce((sum, receipt) => sum + finite(receipt?.turns_reported_pairs), 0);
  const reportedRepeatedCost = rounded(repeated.reduce((sum, receipt) => sum + finite(receipt?.reported_cost_usd), 0));
  const reportedRepeatedTurns = repeated.reduce((sum, receipt) => sum + finite(receipt?.reported_turns), 0);

  return {
    source: "paired two-phase eval phase-B telemetry",
    eval_reports: reports.length,
    eligible_eval_reports: multisession.length,
    excluded_multi_baseline_reports: excludedMultiBaselineReports,
    comparisons: multisession.length,
    paired_recalls: pairedRecalls,
    rediscovery_avoided: {
      tokens: rediscoveryTokens,
      token_pairs: tokensMeasuredPairs,
      turns: rediscoveryTurns,
      turn_pairs: turnsMeasuredPairs,
    },
    break_even: {
      status: breakEvenStatus,
      sessions: breakEvenSessions,
      cost_pairs: costMeasuredPairs,
      seed_cost_pairs: seedMeasuredPairs,
      agentify_amortized_cost_per_session_usd: agentifyAmortizedCost,
      baseline_rediscovery_cost_per_session_usd: baselineRediscoveryCost,
    },
    repeated_failure_cost_avoided: {
      pairs: repeatedPairs,
      costed_pairs: repeatedCostedPairs,
      turns_reported_pairs: repeatedTurnsPairs,
      cost_usd: repeatedPairs > 0 && repeatedCostedPairs === repeatedPairs ? reportedRepeatedCost : repeatedPairs === 0 ? 0 : null,
      reported_cost_usd: reportedRepeatedCost,
      turns: repeatedPairs > 0 && repeatedTurnsPairs === repeatedPairs ? reportedRepeatedTurns : repeatedPairs === 0 ? 0 : null,
      reported_turns: reportedRepeatedTurns,
    },
  };
}

async function evalEconomics(root, config, runs, cutoff) {
  const cutoffMs = Date.parse(cutoff);
  const recent = runs.filter((run) => {
    const timestampMs = Date.parse(String(run.ts || ""));
    return Number.isFinite(timestampMs) && timestampMs >= cutoffMs;
  });
  let matchedRuns = 0;
  let attempts = 0;
  let passes = 0;
  let costUsd = 0;
  let costedAttempts = 0;
  for (const run of recent) {
    const bucket = run.summary?.by_arm?.agentify;
    if (!bucket) continue;
    matchedRuns += 1;
    attempts += finite(bucket.attempts);
    passes += finite(bucket.passes);
    costUsd += finite(bucket.cost_usd);
    costedAttempts += finite(bucket.costed_attempts);
  }
  const completeCostCoverage = attempts > 0 && costedAttempts === attempts;
  const reports = (await Promise.all(recent.map(async (run) => {
    try {
      return await buildEvalReport(root, config, run.run_id);
    } catch {
      return null;
    }
  }))).filter(Boolean);
  return {
    source: "deterministic Agentify eval arm",
    runs: matchedRuns,
    attempts,
    passes,
    cost_usd: rounded(costUsd),
    costed_attempts: costedAttempts,
    cost_coverage_ratio: attempts > 0 ? costedAttempts / attempts : null,
    cost_per_passing_task_usd: completeCostCoverage && passes > 0 ? rounded(costUsd / passes) : null,
    memory_economics: aggregateMemoryEconomics(reports),
  };
}

function dailySeries({ days, now, events, delegationDaily }) {
  const length = Math.min(days, 14);
  const byDate = new Map();
  for (let offset = length - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
    byDate.set(date, { date, assists: 0, delegations: 0 });
  }
  for (const event of events) {
    const bucket = byDate.get(String(event.ts || "").slice(0, 10));
    if (!bucket) continue;
    if (event.type === "context_injection") {
      bucket.assists += finite(event.decisions_reused) + finite(event.stale_context_rejected);
    } else if (event.type === "failed_command_repeat_intercepted" || event.type === "focused_test_run") {
      bucket.assists += 1;
    }
  }
  for (const item of delegationDaily) {
    const bucket = byDate.get(item.date);
    if (bucket) bucket.delegations += finite(item.runs);
  }
  return [...byDate.values()];
}

export async function buildValueReport(root, options = {}) {
  const days = Number.isFinite(options.days) && options.days > 0 ? Math.floor(options.days) : DEFAULT_WINDOW_DAYS;
  const now = options.now instanceof Date ? options.now : new Date();
  const generatedAt = now.toISOString();
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  const [allEvents, stats, evals] = await Promise.all([
    readValueEvents(root),
    buildStatsReport(root, { days }),
    listEvals(root, options.config || {}),
  ]);
  const events = allEvents.filter((event) => String(event.ts || "") >= cutoff);
  const context = contextEventTotals(events);
  const tests = focusedTestTotals(events);
  const totals = stats.delegations.totals;
  const delegations = {
    runs: totals.count,
    successful_runs: Math.max(0, totals.count - totals.failures),
    failed_runs: totals.failures,
    cost_usd: totals.costed_records > 0 ? rounded(totals.cost_usd) : null,
    costed_runs: totals.costed_records,
    cost_coverage_ratio: stats.delegations.cost_coverage.ratio,
    duration_ms: totals.duration_ms,
    latency_p50_ms: stats.delegations.latency.p50_ms,
    latency_p95_ms: stats.delegations.latency.p95_ms,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    by_kind: stats.delegations.by_kind,
  };
  const costPerPassingTask = await evalEconomics(root, options.config || {}, evals.runs, cutoff);
  const observableAssists = context.decisions_reused
    + context.stale_context_rejected
    + context.failed_command_repeats_intercepted
    + tests.runs;

  return {
    schema_version: VALUE_REPORT_SCHEMA_VERSION,
    command: "value",
    generated_at: generatedAt,
    window_days: days,
    tracking_started_at: allEvents.length > 0 ? allEvents.map((event) => event.ts).filter(Boolean).sort()[0] || null : null,
    headline: {
      observable_assists: observableAssists,
      estimated_context_tokens: context.estimated_tokens,
      focused_test_files_avoided: tests.full_suite_files_avoided,
      delegation_cost_usd: delegations.cost_usd,
      cost_per_passing_task_usd: costPerPassingTask.cost_per_passing_task_usd,
      rediscovery_avoided_tokens: costPerPassingTask.memory_economics.rediscovery_avoided.tokens,
      break_even_sessions: costPerPassingTask.memory_economics.break_even.sessions,
    },
    context,
    delegations,
    tests,
    cost_per_passing_task: costPerPassingTask,
    daily: dailySeries({ days, now, events, delegationDaily: stats.delegations.daily }),
    evidence: {
      value_events: events.length,
      limitations: [
        "A reused decision means it was injected into a later task; Agentify cannot prove the agent acted on it.",
        "An intercepted command repeat means a prior-failure warning was shown before execution; abandonment is not observable.",
        "Injected context tokens are estimated at roughly four characters per token.",
        "Dollar totals include provider-reported cost only; missing costs are not imputed.",
        "Focused-test savings count indexed test files omitted from an executed focused run, not wall-clock time saved.",
        "Rediscovery avoided is the paired baseline minus Agentify phase-B token/turn total; only attempts with telemetry on both arms are counted.",
        "Break-even is the first recall session where incremental phase-A seed cost is no greater than cumulative measured phase-B cost savings.",
      ],
    },
  };
}

export function renderValueReport(report) {
  const context = report.context;
  const delegations = report.delegations;
  const tests = report.tests;
  const economics = report.cost_per_passing_task;
  const memory = economics.memory_economics;
  const rediscovery = memory.paired_recalls > 0
    ? `${memory.rediscovery_avoided.tokens ?? "not reported"} token(s), ${memory.rediscovery_avoided.turns ?? "not reported"} turn(s)`
    : "no paired two-phase recalls in this window";
  const breakEven = memory.break_even.status === "reached"
    ? `by recall session ${memory.break_even.sessions}`
    : memory.break_even.status.replaceAll("_", " ");
  const amortized = memory.break_even.status === "reached"
    ? `${formatCost(memory.break_even.agentify_amortized_cost_per_session_usd)} Agentify vs ${formatCost(memory.break_even.baseline_rediscovery_cost_per_session_usd)} baseline per recall`
    : "not reported";
  const repeated = memory.repeated_failure_cost_avoided;
  const lines = [
    `Agentify value — last ${report.window_days} day(s)`,
    `${report.headline.observable_assists} observable assist(s), ${formatNumber(context.estimated_tokens)} estimated context token(s) injected`,
    "",
    "Context:",
    `- ${context.decisions_reused} previous decision(s) reused`,
    `- ${context.stale_context_rejected} stale context item(s) rejected`,
    `- ${context.failed_command_repeats_intercepted} failed-command repeat(s) intercepted`,
    `- ${context.injected_items} item(s) injected across ${context.injection_events} task(s), ~${formatNumber(context.estimated_tokens)} token(s)`,
    "",
    "Delegation:",
    `- ${delegations.runs} run(s), ${delegations.successful_runs} successful, cost ${formatCost(delegations.cost_usd)}`,
    `- latency P50 ${formatDuration(delegations.latency_p50_ms)}, P95 ${formatDuration(delegations.latency_p95_ms)}`,
    `- cost coverage ${delegations.runs > 0 ? `${delegations.costed_runs}/${delegations.runs} run(s)` : "no runs"}`,
    "",
    "Focused tests:",
    `- ${tests.runs} run(s), ${tests.passing_runs} passing`,
    `- ${tests.selected_test_files} selected test file(s); ${tests.full_suite_files_avoided} indexed full-suite file(s) avoided`,
    "",
    "Cost per passing task:",
    `- ${formatCost(economics.cost_per_passing_task_usd)} (${economics.passes} deterministic pass(es), ${economics.costed_attempts}/${economics.attempts} attempt cost(s) reported)`,
    "",
    "Memory economics:",
    `- rediscovery avoided: ${rediscovery}`,
    `- break-even: ${breakEven}`,
    `- amortized cost at break-even: ${amortized}`,
    `- repeated-failure cost avoided: ${formatCost(repeated.cost_usd)} across ${repeated.pairs} paired failure(s); ${repeated.turns ?? "not reported"} turn(s)`,
    `- coverage: ${memory.eligible_eval_reports}/${memory.eval_reports} eval report(s) with one multisession baseline; ${memory.excluded_multi_baseline_reports} multi-baseline report(s) excluded`,
    "",
    "Evidence notes:",
    ...report.evidence.limitations.map((item) => `- ${item}`),
  ];
  return lines.join("\n");
}

function metricCard(label, value, note, tone = "neutral") {
  return `<article class="card metric metric--${tone}">
    <p class="metric-label">${escapeHtml(label)}</p>
    <p class="metric-value">${escapeHtml(value)}</p>
    <p class="metric-note">${escapeHtml(note)}</p>
  </article>`;
}

function formatTokens(value) {
  const count = finite(value);
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return formatNumber(count);
}

function reasonRows(reasons) {
  const labels = {
    previous_decision: "Previous decisions",
    previous_note: "Notes and gotchas",
    session_summary: "Past session summaries",
    hot_file: "Previously relevant files",
    previous_failure: "Related command failures",
    stale_warning: "Stale notes shown with warnings",
  };
  return Object.entries(labels).map(([key, label]) => `<tr>
    <th scope="row">${escapeHtml(label)}</th>
    <td class="number">${formatNumber(reasons[key])}</td>
  </tr>`).join("");
}

function delegationRows(byKind) {
  const entries = Object.entries(byKind);
  if (entries.length === 0) {
    return '<tr><td colspan="5" class="empty">No delegations were recorded in this window.</td></tr>';
  }
  return entries.map(([kind, bucket]) => `<tr>
    <th scope="row"><code>${escapeHtml(kind)}</code></th>
    <td class="number">${formatNumber(bucket.count)}</td>
    <td class="number">${formatNumber(Math.max(0, bucket.count - bucket.failures))}</td>
    <td class="number">${escapeHtml(bucket.costed_records > 0 ? formatCost(bucket.cost_usd) : "—")}</td>
    <td class="number">${escapeHtml(formatDuration(bucket.count > 0 ? bucket.duration_ms / bucket.count : null))}</td>
  </tr>`).join("");
}

function dailyChart(daily, reportWindowDays) {
  const max = Math.max(1, ...daily.flatMap((item) => [item.assists, item.delegations]));
  const coverageLabel = daily.length < reportWindowDays
    ? `Most recent ${daily.length} of ${reportWindowDays} days`
    : `Last ${reportWindowDays} days`;
  const bars = daily.map((item) => {
    const assistHeight = Math.round((item.assists / max) * 100);
    const delegationHeight = Math.round((item.delegations / max) * 100);
    return `<div class="day">
      <div class="bar-pair" aria-hidden="true">
        <span class="bar bar--assist" style="--bar-height:${assistHeight}%"></span>
        <span class="bar bar--delegate" style="--bar-height:${delegationHeight}%"></span>
      </div>
      <span class="day-label">${escapeHtml(item.date.slice(5))}</span>
    </div>`;
  }).join("");
  const rows = daily.map((item) => `<tr><th scope="row">${escapeHtml(item.date)}</th><td class="number">${item.assists}</td><td class="number">${item.delegations}</td></tr>`).join("");
  return `<section class="signal card" aria-labelledby="signal-title">
    <div class="section-heading">
      <div><p class="eyebrow">Signal over time · ${escapeHtml(coverageLabel)}</p><h2 id="signal-title">Visible proof, day by day</h2></div>
      <div class="legend" aria-hidden="true"><span><i class="key key--assist"></i> assists</span><span><i class="key key--delegate"></i> delegations</span></div>
    </div>
    <div class="chart">${bars}</div>
    <details>
      <summary>View chart data</summary>
      <div class="table-wrap"><table><caption>Daily observable assists and delegations · ${escapeHtml(coverageLabel)}</caption><thead><tr><th scope="col">Date</th><th scope="col">Assists</th><th scope="col">Delegations</th></tr></thead><tbody>${rows}</tbody></table></div>
    </details>
  </section>`;
}

export function renderValueHtml(report, options = {}) {
  const project = options.projectName || "this repository";
  const generated = new Date(report.generated_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  const trackingNote = report.tracking_started_at
    ? `Value-event tracking began ${String(report.tracking_started_at).slice(0, 10)}.`
    : "No context or focused-test value events have been recorded yet.";
  const economics = report.cost_per_passing_task;
  const memory = economics.memory_economics;
  const costPerPass = economics.cost_per_passing_task_usd === null ? "—" : formatCost(economics.cost_per_passing_task_usd);
  const rediscoveryTokens = memory.rediscovery_avoided.tokens === null ? "—" : formatNumber(memory.rediscovery_avoided.tokens);
  const rediscoveryTurns = memory.rediscovery_avoided.turns === null ? "—" : formatNumber(memory.rediscovery_avoided.turns);
  const breakEven = memory.break_even.status === "reached" ? `≤ ${memory.break_even.sessions} recall session(s)` : "—";
  const amortizedCost = memory.break_even.status === "reached"
    ? `${formatCost(memory.break_even.agentify_amortized_cost_per_session_usd)} vs ${formatCost(memory.break_even.baseline_rediscovery_cost_per_session_usd)}`
    : "—";
  const repeatedFailure = memory.repeated_failure_cost_avoided;
  const repeatedFailureCost = repeatedFailure.cost_usd === null ? "—" : formatCost(repeatedFailure.cost_usd);
  const repeatedFailureTurns = repeatedFailure.turns === null ? "—" : formatNumber(repeatedFailure.turns);
  const delegations = report.delegations;
  const tests = report.tests;
  const costCoverage = delegations.runs > 0 ? `${delegations.costed_runs}/${delegations.runs} run(s) reported cost` : "no runs in window";
  const evalCoverage = economics.attempts > 0
    ? `${economics.costed_attempts}/${economics.attempts} attempt(s) reported cost`
    : "no eval runs in window";
  const cards = [
    metricCard("decisions reused", formatNumber(report.context.decisions_reused), "Surfaced in a later task", "good"),
    metricCard("stale context rejected", formatNumber(report.context.stale_context_rejected), "Missing file references kept out", "guard"),
    metricCard("failed repeats intercepted", formatNumber(report.context.failed_command_repeats_intercepted), "Prior failure warning shown", "guard"),
    metricCard("context injected", `~${formatTokens(report.context.estimated_tokens)}`, "Estimated tokens, with reasons below", "signal"),
    metricCard("test files avoided", formatNumber(tests.full_suite_files_avoided), `${tests.runs} focused run(s)`, "good"),
    metricCard("cost per passing task", costPerPass, "Deterministic Agentify evals only", "signal"),
  ].join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="Agentify value report">
  <title>Agentify value · ${escapeHtml(project)}</title>
  <style>
    :root {
      color-scheme: dark light;
      --bg: #0d1117;
      --bg-soft: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --text-dim: #8b949e;
      --accent: #58a6ff;
      --accent-2: #7ee787;
      --amber: #d29922;
      --code-bg: #161b22;
      --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #ffffff;
        --bg-soft: #f6f8fa;
        --border: #d0d7de;
        --text: #1f2328;
        --text-dim: #59636e;
        --accent: #0969da;
        --accent-2: #1a7f37;
        --amber: #9a6700;
        --code-bg: #f6f8fa;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      line-height: 1.6;
    }
    main { max-width: 880px; margin: 0 auto; padding: 0 24px 64px; }
    .skip-link { position: fixed; top: 12px; left: 12px; z-index: 10; padding: 8px 12px; border-radius: 8px; background: var(--bg-soft); border: 1px solid var(--border); color: var(--text); transform: translateY(-300%); }
    .skip-link:focus { transform: translateY(0); }
    header.hero { text-align: center; padding: 56px 24px 8px; }
    .hero pre.logo {
      font-family: var(--mono); font-size: 11px; line-height: 1.25;
      color: var(--accent); display: inline-block; text-align: left; margin-bottom: 20px;
    }
    .hero h1 { font-size: 1.9rem; letter-spacing: -0.02em; margin-bottom: 10px; text-wrap: balance; }
    .hero p.tagline { font-size: 1.05rem; color: var(--text-dim); max-width: 620px; margin: 0 auto 20px; }
    .hero .tagline strong { color: var(--text); }
    .meta-row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
    .meta {
      font-family: var(--mono); font-size: 0.75rem; color: var(--text-dim);
      background: var(--bg-soft); border: 1px solid var(--border);
      border-radius: 999px; padding: 3px 12px; white-space: nowrap;
    }
    section { margin-top: 56px; }
    h2 { font-size: 1.35rem; margin-bottom: 6px; letter-spacing: -0.01em; }
    .eyebrow {
      color: var(--accent-2); font-family: var(--mono); font-size: 0.72rem;
      font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 4px;
    }
    p.lede { color: var(--text-dim); margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin-top: 18px; }
    .card { background: var(--bg-soft); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; }
    .metric-label { color: var(--text-dim); font-size: 0.75rem; font-weight: 650; letter-spacing: 0.07em; text-transform: uppercase; }
    .metric-value { font-family: var(--mono); font-size: 2rem; font-weight: 700; line-height: 1.15; margin: 8px 0 4px; letter-spacing: -0.03em; }
    .metric--good .metric-value { color: var(--accent-2); }
    .metric--guard .metric-value { color: var(--amber); }
    .metric--signal .metric-value { color: var(--accent); }
    .metric-note { color: var(--text-dim); font-size: 0.85rem; }
    .section-heading { display: flex; justify-content: space-between; gap: 16px; align-items: end; margin-bottom: 14px; }
    .legend { display: flex; gap: 14px; color: var(--text-dim); font-family: var(--mono); font-size: 0.72rem; }
    .key { display: inline-block; width: 10px; height: 10px; margin-right: 5px; border-radius: 3px; }
    .key--assist, .bar--assist { background: var(--accent-2); }
    .key--delegate, .bar--delegate { background: var(--accent); }
    .signal { margin-top: 20px; }
    .chart { height: 200px; display: grid; grid-template-columns: repeat(${Math.max(1, report.daily.length)}, minmax(18px, 1fr)); gap: 8px; align-items: end; padding-top: 12px; border-bottom: 1px solid var(--border); }
    .day { height: 100%; min-width: 0; display: grid; grid-template-rows: 1fr auto; gap: 6px; align-items: end; }
    .bar-pair { height: 100%; display: flex; align-items: end; justify-content: center; gap: 3px; }
    .bar { width: min(10px, 40%); height: max(3px, var(--bar-height)); border-radius: 3px 3px 0 0; }
    .day-label { overflow: hidden; color: var(--text-dim); font-family: var(--mono); font-size: 0.62rem; text-align: center; white-space: nowrap; }
    details { margin-top: 12px; }
    summary { width: fit-content; cursor: pointer; color: var(--text-dim); font-family: var(--mono); font-size: 0.76rem; }
    summary:hover { color: var(--text); }
    .split { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; margin-top: 20px; }
    .panel h2 { margin-bottom: 4px; }
    .panel-copy { margin: 0 0 12px; color: var(--text-dim); font-size: 0.92rem; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    caption { padding: 0 0 8px; color: var(--text-dim); text-align: left; font-size: 0.78rem; }
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; }
    thead th { color: var(--text-dim); font-size: 0.7rem; letter-spacing: 0.06em; text-transform: uppercase; }
    tbody tr:last-child th, tbody tr:last-child td { border-bottom: none; }
    tbody th { font-weight: 550; }
    .number { font-family: var(--mono); text-align: right; font-variant-numeric: tabular-nums; }
    .empty { color: var(--text-dim); text-align: center; }
    code { font-family: var(--mono); font-size: 0.86em; background: var(--code-bg); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }
    .evidence {
      display: grid; grid-template-columns: auto 1fr; gap: 20px; align-items: start;
      padding: 18px 20px; border: 1px solid var(--border); border-left: 4px solid var(--amber);
      background: var(--bg-soft); border-radius: 0 10px 10px 0; margin-top: 16px;
    }
    .evidence > strong { font-family: var(--mono); font-size: 1.8rem; color: var(--amber); }
    .evidence p { margin: 0 0 6px; }
    .evidence ul { margin: 10px 0 0; padding-left: 18px; color: var(--text-dim); font-size: 0.9rem; }
    .evidence li + li { margin-top: 6px; }
    footer {
      border-top: 1px solid var(--border); margin-top: 72px; padding: 24px;
      text-align: center; color: var(--text-dim); font-family: var(--mono); font-size: 0.75rem;
    }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (max-width: 560px) {
      header.hero { padding-top: 32px; }
      .section-heading { align-items: flex-start; flex-direction: column; }
      .chart { gap: 3px; }
      .evidence { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; } }
    @media print {
      :root { color-scheme: light; --bg: #fff; --bg-soft: #fff; --text: #111; --text-dim: #555; --border: #ccc; }
      .card, .signal { break-inside: avoid; }
      details { display: none; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#content">Skip to value report</a>
  <header class="hero">
    <pre class="logo">    _                    _   _  __
   / \\   __ _  ___ _ __ | |_(_)/ _|_   _
  / _ \\ / _\` |/ _ \\ '_ \\| __| | |_| | | |
 / ___ \\ (_| |  __/ | | | |_| |  _| |_| |
/_/   \\_\\__, |\\___|_| |_|\\__|_|_|  \\__, |
        |___/                      |___/</pre>
    <h1>Quiet work, made visible.</h1>
    <p class="tagline">Agentify recorded <strong>${formatNumber(report.headline.observable_assists)} observable assist(s)</strong> in ${escapeHtml(project)}, with every claim tied to durable local evidence — what was surfaced, guarded, routed, and selectively tested.</p>
    <div class="meta-row">
      <span class="meta">last ${escapeHtml(report.window_days)} day(s)</span>
      <span class="meta">${formatNumber(report.evidence.value_events)} value event(s)</span>
      <span class="meta">generated ${escapeHtml(generated)} UTC</span>
    </div>
  </header>
  <main id="content" data-testid="agentify-value-report">
    <section aria-label="Value summary">
      <p class="eyebrow">Headline</p>
      <h2>What Agentify did for this repo</h2>
      <div class="grid">${cards}</div>
    </section>
    ${dailyChart(report.daily, report.window_days)}
    <section aria-label="Value details">
      <p class="eyebrow">Receipts</p>
      <h2>Where the numbers come from</h2>
      <div class="split">
        <article class="card panel">
          <h2>Why context appeared</h2>
          <p class="panel-copy">${formatNumber(report.context.injected_items)} item(s) across ${formatNumber(report.context.injection_events)} task injection(s), ~${formatTokens(report.context.estimated_tokens)} estimated token(s).</p>
          <div class="table-wrap"><table><caption>Injected context by evidence source</caption><tbody>${reasonRows(report.context.reasons)}</tbody></table></div>
        </article>
        <article class="card panel">
          <h2>Delegation cost and latency</h2>
          <p class="panel-copy">${formatNumber(delegations.runs)} run(s) · ${formatCost(delegations.cost_usd)} · ${formatTokens(delegations.input_tokens)} in / ${formatTokens(delegations.output_tokens)} out · P50 ${formatDuration(delegations.latency_p50_ms)} · P95 ${formatDuration(delegations.latency_p95_ms)} · ${escapeHtml(costCoverage)}.</p>
          <div class="table-wrap"><table><caption>Delegations by task kind — cheap work routed to cheap models</caption><thead><tr><th scope="col">Kind</th><th scope="col">Runs</th><th scope="col">Success</th><th scope="col">Cost</th><th scope="col">Avg latency</th></tr></thead><tbody>${delegationRows(delegations.by_kind)}</tbody></table></div>
        </article>
        <article class="card panel">
          <h2>Focused tests, not full suites</h2>
          <p class="panel-copy">Impact-aware selection runs only the tests your change touches.</p>
          <div class="table-wrap"><table><caption>Focused test runs in this window</caption><tbody>
            <tr><th scope="row">Focused runs</th><td class="number">${formatNumber(tests.runs)}</td></tr>
            <tr><th scope="row">Passing runs</th><td class="number">${formatNumber(tests.passing_runs)}</td></tr>
            <tr><th scope="row">Test files selected</th><td class="number">${formatNumber(tests.selected_test_files)}</td></tr>
            <tr><th scope="row">Full-suite files avoided</th><td class="number">${formatNumber(tests.full_suite_files_avoided)}</td></tr>
            <tr><th scope="row">Time in focused runs</th><td class="number">${escapeHtml(formatDuration(tests.duration_ms))}</td></tr>
          </tbody></table></div>
        </article>
        <article class="card panel">
          <h2>Cost per passing task</h2>
          <p class="panel-copy">From deterministic paired evals — cost only means something next to task success, and it is only claimed when every attempt reported cost.</p>
          <div class="table-wrap"><table><caption>Agentify eval arm, this window</caption><tbody>
            <tr><th scope="row">Eval runs</th><td class="number">${formatNumber(economics.runs)}</td></tr>
            <tr><th scope="row">Attempts</th><td class="number">${formatNumber(economics.attempts)}</td></tr>
            <tr><th scope="row">Deterministic passes</th><td class="number">${formatNumber(economics.passes)}</td></tr>
            <tr><th scope="row">Cost coverage</th><td class="number">${escapeHtml(evalCoverage)}</td></tr>
            <tr><th scope="row">Cost per passing task</th><td class="number">${escapeHtml(costPerPass)}</td></tr>
          </tbody></table></div>
        </article>
        <article class="card panel">
          <h2>Memory economics</h2>
          <p class="panel-copy">A value receipt from paired phase-B telemetry: baseline total minus Agentify total. Break-even is the first recall session where measured savings repay the incremental seed cost.</p>
          <div class="table-wrap"><table><caption>Amortized and rediscovery-avoided eval economics</caption><tbody>
            <tr><th scope="row">Paired recall sessions</th><td class="number">${formatNumber(memory.paired_recalls)}</td></tr>
            <tr><th scope="row">Eligible eval reports</th><td class="number">${formatNumber(memory.eligible_eval_reports)}/${formatNumber(memory.eval_reports)} <small>(${formatNumber(memory.excluded_multi_baseline_reports)} multi-baseline excluded)</small></td></tr>
            <tr><th scope="row">Rediscovery tokens avoided</th><td class="number">${escapeHtml(rediscoveryTokens)} <small>(${memory.rediscovery_avoided.token_pairs}/${memory.paired_recalls} pairs)</small></td></tr>
            <tr><th scope="row">Rediscovery turns avoided</th><td class="number">${escapeHtml(rediscoveryTurns)} <small>(${memory.rediscovery_avoided.turn_pairs}/${memory.paired_recalls} pairs)</small></td></tr>
            <tr><th scope="row">Break-even</th><td class="number">${escapeHtml(breakEven)}</td></tr>
            <tr><th scope="row">Amortized cost/recall at break-even</th><td class="number">${escapeHtml(amortizedCost)} <small>(Agentify vs baseline)</small></td></tr>
            <tr><th scope="row">Repeated-failure cost avoided</th><td class="number">${escapeHtml(repeatedFailureCost)}</td></tr>
            <tr><th scope="row">Repeated-failure turns avoided</th><td class="number">${escapeHtml(repeatedFailureTurns)} <small>(${repeatedFailure.pairs} pair(s))</small></td></tr>
          </tbody></table></div>
        </article>
      </div>
    </section>
    <section>
      <p class="eyebrow">Honest accounting</p>
      <h2>What the numbers mean — and what they don't</h2>
      <div class="evidence"><strong>${formatNumber(report.evidence.value_events)}</strong><div><p><strong>value events in this window</strong></p><p>${escapeHtml(trackingNote)} Generated ${escapeHtml(generated)} UTC.</p><ul>${report.evidence.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div></div>
    </section>
  </main>
  <footer>Generated locally by Agentify · no external assets · provider costs are reported, never guessed</footer>
</body>
</html>\n`;
}

export function defaultValueReportPath(root) {
  return path.join(root, "agentify-value-report.html");
}
