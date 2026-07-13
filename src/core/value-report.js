import path from "node:path";

import { listEvals } from "./eval.js";
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

function evalEconomics(runs, cutoff) {
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
  return {
    source: "deterministic Agentify eval arm",
    runs: matchedRuns,
    attempts,
    passes,
    cost_usd: rounded(costUsd),
    costed_attempts: costedAttempts,
    cost_coverage_ratio: attempts > 0 ? costedAttempts / attempts : null,
    cost_per_passing_task_usd: completeCostCoverage && passes > 0 ? rounded(costUsd / passes) : null,
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
  const costPerPassingTask = evalEconomics(evals.runs, cutoff);
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
      ],
    },
  };
}

export function renderValueReport(report) {
  const context = report.context;
  const delegations = report.delegations;
  const tests = report.tests;
  const economics = report.cost_per_passing_task;
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
    "Evidence notes:",
    ...report.evidence.limitations.map((item) => `- ${item}`),
  ];
  return lines.join("\n");
}

function metricCard(label, value, note, tone = "neutral") {
  return `<article class="metric metric--${tone}">
    <p class="metric-label">${escapeHtml(label)}</p>
    <p class="metric-value">${escapeHtml(value)}</p>
    <p class="metric-note">${escapeHtml(note)}</p>
  </article>`;
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
  return `<section class="signal" aria-labelledby="signal-title">
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
  const costPerPass = economics.cost_per_passing_task_usd === null ? "—" : formatCost(economics.cost_per_passing_task_usd);
  const cards = [
    metricCard("decisions reused", formatNumber(report.context.decisions_reused), "Surfaced in a later task", "good"),
    metricCard("stale context rejected", formatNumber(report.context.stale_context_rejected), "Missing file references kept out", "guard"),
    metricCard("failed repeats intercepted", formatNumber(report.context.failed_command_repeats_intercepted), "Prior failure warning shown", "guard"),
    metricCard("context injected", `~${formatNumber(report.context.estimated_tokens)}`, "Estimated tokens, with reasons", "signal"),
    metricCard("test files avoided", formatNumber(report.tests.full_suite_files_avoided), `${report.tests.runs} focused run(s)`, "good"),
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
      color-scheme: light dark;
      --ink: #18201d;
      --muted: #5f6c66;
      --paper: #f4f1e8;
      --surface: rgba(255, 255, 255, 0.72);
      --surface-solid: #fcfaf4;
      --line: rgba(24, 32, 29, 0.14);
      --green: #087a55;
      --green-soft: #d9efe5;
      --amber: #a45516;
      --amber-soft: #f6e4c9;
      --blue: #315fba;
      --blue-soft: #dfe8fa;
      --shadow: 0 24px 70px rgba(29, 39, 34, 0.10);
      --sans: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --ink: #eef3f0;
        --muted: #a6b2ac;
        --paper: #101512;
        --surface: rgba(27, 35, 31, 0.80);
        --surface-solid: #1b231f;
        --line: rgba(238, 243, 240, 0.14);
        --green: #66d3aa;
        --green-soft: #153c2e;
        --amber: #f1b36f;
        --amber-soft: #432d19;
        --blue: #9cbaff;
        --blue-soft: #202f50;
        --shadow: 0 24px 70px rgba(0, 0, 0, 0.28);
      }
    }
    * { box-sizing: border-box; }
    html { font-family: var(--sans); background: var(--paper); color: var(--ink); }
    body { margin: 0; min-width: 20rem; line-height: 1.55; }
    body::before {
      content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
      background: radial-gradient(circle at 85% 0%, rgba(8, 122, 85, 0.14), transparent 34rem), radial-gradient(circle at 10% 55%, rgba(49, 95, 186, 0.10), transparent 30rem);
    }
    .shell { width: min(74rem, calc(100% - 2rem)); margin: 0 auto; }
    .skip-link { position: fixed; top: 0.75rem; left: 0.75rem; z-index: 10; padding: 0.55rem 0.8rem; border-radius: 0.45rem; background: var(--surface-solid); color: var(--ink); transform: translateY(-180%); }
    .skip-link:focus { transform: translateY(0); }
    header { padding: 4.5rem 0 2.5rem; }
    .mast { display: flex; justify-content: space-between; gap: 1rem; align-items: center; margin-bottom: 4.5rem; font-family: var(--mono); font-size: 0.78rem; color: var(--muted); }
    .brand { display: inline-flex; align-items: center; gap: 0.65rem; color: var(--ink); font-weight: 700; letter-spacing: -0.02em; }
    .brand-mark { width: 0.72rem; height: 0.72rem; border-radius: 0.18rem; background: var(--green); transform: rotate(45deg); box-shadow: 0 0 0 0.28rem var(--green-soft); }
    .hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3rem; align-items: end; }
    .eyebrow { margin: 0 0 0.65rem; color: var(--green); font-family: var(--mono); font-size: 0.72rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
    h1, h2 { margin: 0; text-wrap: balance; letter-spacing: -0.045em; }
    h1 { max-width: 16ch; font-size: clamp(2.75rem, 8vw, 6.5rem); line-height: 0.96; font-weight: 750; }
    h2 { font-size: clamp(1.65rem, 4vw, 2.65rem); line-height: 1.05; }
    .lede { max-width: 62ch; margin: 1.5rem 0 0; color: var(--muted); font-size: 1.08rem; }
    .score { width: 10rem; aspect-ratio: 1; display: grid; place-content: center; border-radius: 50%; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); text-align: center; }
    .score strong { display: block; font-family: var(--mono); font-size: 3rem; line-height: 1; color: var(--green); }
    .score span { display: block; margin-top: 0.55rem; color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.09em; }
    main { padding-bottom: 5rem; }
    .metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.85rem; }
    .metric { min-height: 12.5rem; display: flex; flex-direction: column; justify-content: space-between; padding: 1.35rem; border: 1px solid var(--line); border-radius: 1.15rem; background: var(--surface); box-shadow: 0 10px 30px rgba(29, 39, 34, 0.05); }
    .metric--good { border-top: 0.22rem solid var(--green); }
    .metric--guard { border-top: 0.22rem solid var(--amber); }
    .metric--signal { border-top: 0.22rem solid var(--blue); }
    .metric-label, .metric-note { margin: 0; }
    .metric-label { color: var(--muted); font-size: 0.78rem; font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; }
    .metric-value { margin: 1.1rem 0; font-family: var(--mono); font-size: clamp(2rem, 5vw, 3.35rem); font-weight: 700; line-height: 1; letter-spacing: -0.07em; }
    .metric-note { color: var(--muted); font-size: 0.85rem; }
    section, figure { margin: 4.5rem 0 0; }
    .section-heading { display: flex; justify-content: space-between; gap: 1.5rem; align-items: end; margin-bottom: 1.4rem; }
    .legend { display: flex; gap: 1rem; color: var(--muted); font-family: var(--mono); font-size: 0.72rem; }
    .key { display: inline-block; width: 0.6rem; height: 0.6rem; margin-right: 0.35rem; border-radius: 0.15rem; }
    .key--assist, .bar--assist { background: var(--green); }
    .key--delegate, .bar--delegate { background: var(--blue); }
    .signal { padding: 1.5rem; border: 1px solid var(--line); border-radius: 1.25rem; background: var(--surface); }
    .chart { height: 15rem; display: grid; grid-template-columns: repeat(${Math.max(1, report.daily.length)}, minmax(1.35rem, 1fr)); gap: 0.65rem; align-items: end; padding-top: 1rem; border-bottom: 1px solid var(--line); }
    .day { height: 100%; min-width: 0; display: grid; grid-template-rows: 1fr auto; gap: 0.55rem; align-items: end; }
    .bar-pair { height: 100%; display: flex; align-items: end; justify-content: center; gap: 0.2rem; }
    .bar { width: min(0.78rem, 40%); height: max(0.18rem, var(--bar-height)); border-radius: 0.35rem 0.35rem 0 0; opacity: 0.9; }
    .day-label { overflow: hidden; color: var(--muted); font-family: var(--mono); font-size: 0.65rem; text-align: center; white-space: nowrap; }
    details { margin-top: 1rem; }
    summary { width: fit-content; cursor: pointer; color: var(--muted); font-family: var(--mono); font-size: 0.76rem; }
    summary:hover { color: var(--ink); }
    .split { display: grid; grid-template-columns: 0.9fr 1.1fr; gap: 1rem; }
    .panel { padding: 1.5rem; border: 1px solid var(--line); border-radius: 1.25rem; background: var(--surface); overflow: hidden; }
    .panel h2 { margin-bottom: 0.35rem; }
    .panel-copy { margin: 0 0 1.4rem; color: var(--muted); }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    caption { padding: 0 0 0.8rem; color: var(--muted); text-align: left; font-size: 0.78rem; }
    th, td { padding: 0.8rem 0.7rem; border-bottom: 1px solid var(--line); text-align: left; }
    thead th { color: var(--muted); font-size: 0.7rem; letter-spacing: 0.07em; text-transform: uppercase; }
    tbody th { font-weight: 550; }
    .number { font-family: var(--mono); text-align: right; font-variant-numeric: tabular-nums; }
    .empty { color: var(--muted); text-align: center; }
    code { font-family: var(--mono); font-size: 0.86em; }
    .evidence { display: grid; grid-template-columns: auto 1fr; gap: 1.5rem; align-items: start; padding: 1.5rem; border-left: 0.25rem solid var(--amber); background: var(--amber-soft); border-radius: 0 1rem 1rem 0; }
    .evidence strong { font-family: var(--mono); font-size: 2rem; color: var(--amber); }
    .evidence p { margin: 0 0 0.5rem; }
    .evidence ul { margin: 0.8rem 0 0; padding-left: 1.2rem; color: var(--muted); }
    .evidence li + li { margin-top: 0.45rem; }
    footer { padding: 1.5rem 0 3rem; border-top: 1px solid var(--line); color: var(--muted); font-family: var(--mono); font-size: 0.72rem; }
    :focus-visible { outline: 0.18rem solid var(--blue); outline-offset: 0.2rem; }
    @media (max-width: 52rem) {
      header { padding-top: 2rem; }
      .mast { margin-bottom: 3rem; }
      .hero { grid-template-columns: 1fr; }
      .score { width: 8rem; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .split { grid-template-columns: 1fr; }
    }
    @media (max-width: 35rem) {
      .shell { width: min(100% - 1.1rem, 74rem); }
      .mast { align-items: flex-start; flex-direction: column; }
      .metrics { grid-template-columns: 1fr; }
      .metric { min-height: 10rem; }
      .section-heading { align-items: flex-start; flex-direction: column; }
      .legend { flex-wrap: wrap; }
      .chart { gap: 0.25rem; }
      .evidence { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; } }
    @media print {
      :root { color-scheme: light; --paper: #fff; --surface: #fff; --ink: #111; --muted: #555; --line: #ccc; }
      body::before { display: none; }
      .shell { width: 100%; }
      header { padding-top: 1rem; }
      .metric, .panel, .signal { break-inside: avoid; box-shadow: none; }
      details { display: none; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#content">Skip to value report</a>
  <header class="shell">
    <div class="mast"><span class="brand"><i class="brand-mark" aria-hidden="true"></i>agentify / value</span><span>${escapeHtml(project)} · ${escapeHtml(report.window_days)} day window</span></div>
    <div class="hero">
      <div>
        <p class="eyebrow">Evidence-backed impact</p>
        <h1>Quiet work, made visible.</h1>
        <p class="lede">Agentify recorded <strong>${formatNumber(report.headline.observable_assists)} observable assist(s)</strong> while keeping its claims tied to durable local evidence. This report shows what was surfaced, guarded, routed, and selectively tested.</p>
      </div>
      <div class="score"><strong>${formatNumber(report.headline.observable_assists)}</strong><span>observable<br>assists</span></div>
    </div>
  </header>
  <main class="shell" id="content" data-testid="agentify-value-report">
    <section aria-label="Value summary" class="metrics">${cards}</section>
    ${dailyChart(report.daily, report.window_days)}
    <section class="split" aria-label="Value details">
      <article class="panel">
        <p class="eyebrow">Context receipts</p><h2>Why context appeared</h2>
        <p class="panel-copy">${formatNumber(report.context.injected_items)} item(s) across ${formatNumber(report.context.injection_events)} task injection(s).</p>
        <div class="table-wrap"><table><caption>Injected context by evidence source</caption><tbody>${reasonRows(report.context.reasons)}</tbody></table></div>
      </article>
      <article class="panel">
        <p class="eyebrow">Routing economics</p><h2>Delegation cost and latency</h2>
        <p class="panel-copy">${formatNumber(report.delegations.runs)} run(s), ${formatCost(report.delegations.cost_usd)}, P50 ${formatDuration(report.delegations.latency_p50_ms)}.</p>
        <div class="table-wrap"><table><caption>Delegations by task kind</caption><thead><tr><th scope="col">Kind</th><th scope="col">Runs</th><th scope="col">Success</th><th scope="col">Cost</th><th scope="col">Avg latency</th></tr></thead><tbody>${delegationRows(report.delegations.by_kind)}</tbody></table></div>
      </article>
    </section>
    <section>
      <div class="section-heading"><div><p class="eyebrow">Honest accounting</p><h2>What the numbers mean</h2></div></div>
      <div class="evidence"><strong>${formatNumber(report.evidence.value_events)}</strong><div><p><strong>value events in this window</strong></p><p>${escapeHtml(trackingNote)} Generated ${escapeHtml(generated)} UTC.</p><ul>${report.evidence.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div></div>
    </section>
  </main>
  <footer><div class="shell">Generated locally by Agentify · no external assets · provider costs are reported, never guessed</div></footer>
</body>
</html>\n`;
}

export function defaultValueReportPath(root) {
  return path.join(root, "agentify-value-report.html");
}
