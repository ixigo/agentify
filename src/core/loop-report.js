// Reporting for `agentify loop`.
//
// The thing worth reading after an autonomous run is not "did it pass" — the
// exit code says that — but the *ladder*: which gate was red on each iteration,
// what the agent changed in response, and whether the score was still moving
// when the run stopped. A stalled run and an exhausted run look identical in a
// one-line summary and are completely different problems, so every renderer
// here leads with the per-iteration gate ladder.

import { LOOP_RUN_SCHEMA_VERSION } from "./loop.js";

export const LOOP_REPORT_SCHEMA_VERSION = "loop-report-v1";

export const LOOP_REPORT_FORMATS = ["text", "json", "md", "html"];

const OUTCOME_NOTES = {
  passed: "every blocking gate passed",
  stalled: "the score stopped improving for two consecutive iterations",
  exhausted: "the iteration ceiling was reached with gates still red",
  budget_exhausted: "the run budget was spent with gates still red",
  budget_blocked: "a rolling budget cap refused to start a provider call",
  error: "the run failed before it could be graded",
  running: "the run has not finished",
};

const STATUS_MARK = { pass: "PASS", fail: "FAIL", error: "ERR ", skipped: "SKIP" };

function formatUsd(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "n/a";
}

function formatScore(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "n/a";
  return ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : `${Math.round(ms / 1000)}s`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Normalize a stored run into the report shape.
 *
 * `view` is what `loadLoopRun` returns: run metadata, candidate states, and the
 * summary written when the run finished.
 */
export function buildLoopReport(view) {
  const meta = view.meta || {};
  const brief = meta.plan?.brief || {};
  const summary = view.summary || {};

  const candidates = (view.candidates || []).map((state) => ({
    candidate_id: state.candidate_id,
    branch: state.branch,
    worktree: state.worktree,
    outcome: state.outcome,
    best_score: state.best_score ?? 0,
    spend_usd: state.spend_usd ?? 0,
    cost_unreported: state.cost_unreported === true,
    variation: state.variation ?? null,
    changed_files: state.changed_files ?? null,
    error: state.error ?? null,
    iterations: (state.iterations || []).map((iteration) => ({
      iteration: iteration.iteration,
      status: iteration.status,
      score: iteration.score ?? 0,
      gates_passed: iteration.gates_passed ?? 0,
      gates_total: iteration.gates_total ?? 0,
      changed_files: iteration.changed_files ?? 0,
      violations: iteration.violations || [],
      duration_ms: iteration.duration_ms ?? null,
      agent: {
        status: iteration.agent?.status ?? null,
        provider: iteration.agent?.provider ?? null,
        model: iteration.agent?.model ?? null,
        cost_usd: iteration.agent?.cost_usd ?? null,
        budget_stop_reason: iteration.agent?.budget_stop_reason ?? null,
      },
      verdicts: (iteration.verdicts || []).map((verdict) => ({
        id: verdict.id,
        kind: verdict.kind,
        status: verdict.status,
        blocking: verdict.blocking !== false,
        score: verdict.score ?? null,
        detail: verdict.detail ?? "",
        duration_ms: verdict.duration_ms ?? null,
      })),
    })),
  }));

  return {
    schema: LOOP_REPORT_SCHEMA_VERSION,
    run_schema: meta.schema ?? LOOP_RUN_SCHEMA_VERSION,
    run_id: view.run_id,
    ts: meta.ts ?? null,
    agentify_version: meta.agentify_version ?? null,
    brief: {
      id: brief.id ?? null,
      title: brief.title ?? null,
      intent: brief.intent ?? null,
      source: brief.source ?? null,
      route: brief.route ?? null,
      limits: brief.limits ?? null,
      gates: (brief.gates || []).map((gate) => ({ id: gate.id, kind: gate.kind, blocking: gate.blocking })),
    },
    base_sha: meta.plan?.base_sha ?? null,
    outcome: summary.outcome ?? candidates[0]?.outcome ?? "running",
    outcome_note: OUTCOME_NOTES[summary.outcome ?? candidates[0]?.outcome ?? "running"] ?? null,
    winner: summary.winner ?? null,
    spend_usd: summary.spend_usd ?? candidates.reduce((total, entry) => total + (entry.spend_usd || 0), 0),
    max_spend_usd: meta.plan?.max_spend_usd ?? null,
    cost_unreported: summary.cost_unreported === true || candidates.some((entry) => entry.cost_unreported),
    budget_warning: summary.budget_warning ?? null,
    ship: summary.ship ?? null,
    candidates,
    artifacts_root: summary.artifacts_root ?? null,
  };
}

function shipLine(ship) {
  if (!ship) {
    return "Ship: not attempted.";
  }
  const parts = [];
  parts.push(ship.committed ? `committed ${String(ship.sha || "").slice(0, 12)} — ${ship.subject}` : `not committed (${ship.reason || "no passing candidate"})`);
  if (ship.pr) {
    parts.push(ship.pr.opened ? `draft PR ${ship.pr.url || "(url not reported)"}` : `no PR (${ship.pr.reason})`);
  }
  return `Ship: ${parts.join(" · ")}`;
}

export function renderLoopReportText(report) {
  const lines = [];
  lines.push(`Loop run ${report.run_id} — ${report.brief.title || report.brief.id}`);
  lines.push(`Outcome: ${report.outcome.toUpperCase()}${report.outcome_note ? ` (${report.outcome_note})` : ""}`);
  lines.push(`Base: ${String(report.base_sha || "").slice(0, 12)} · route ${report.brief.route} · spend ${formatUsd(report.spend_usd)} of a ${formatUsd(report.max_spend_usd)} ceiling`);
  if (report.cost_unreported) {
    lines.push("Note: at least one provider call reported no cost, so the dollar total is a lower bound; per-call caps still bounded the run.");
  }
  if (report.budget_warning) {
    lines.push(`Budget warning: ${report.budget_warning}`);
  }
  lines.push("");

  for (const candidate of report.candidates) {
    const marker = candidate.candidate_id === report.winner ? " (winner)" : "";
    lines.push(`${candidate.candidate_id}${marker} — ${candidate.outcome}, best score ${formatScore(candidate.best_score)}, ${candidate.iterations.length} iteration(s), ${formatUsd(candidate.spend_usd)}`);
    lines.push(`  branch ${candidate.branch}`);
    if (candidate.variation) {
      lines.push(`  approach: ${candidate.variation}`);
    }
    if (candidate.error) {
      lines.push(`  error: ${candidate.error}`);
    }
    for (const iteration of candidate.iterations) {
      lines.push(`  iteration ${iteration.iteration}: ${iteration.gates_passed}/${iteration.gates_total} gates, score ${formatScore(iteration.score)}, ${iteration.changed_files} file(s) changed, ${formatDuration(iteration.duration_ms)}`);
      if (iteration.status !== "graded") {
        lines.push(`    ${iteration.status}${iteration.agent.budget_stop_reason ? ` (${iteration.agent.budget_stop_reason})` : ""}`);
      }
      if (iteration.violations.length > 0) {
        lines.push(`    reverted forbidden edits: ${iteration.violations.join(", ")}`);
      }
      for (const verdict of iteration.verdicts) {
        const mark = STATUS_MARK[verdict.status] || verdict.status;
        const advisory = verdict.blocking ? "" : " [advisory]";
        lines.push(`    ${mark} ${verdict.id}${advisory} — ${verdict.detail}`);
      }
    }
    lines.push("");
  }

  lines.push(shipLine(report.ship));
  if (report.artifacts_root) {
    lines.push(`Artifacts: ${report.artifacts_root}`);
  }
  return lines.join("\n");
}

export function renderLoopReportMarkdown(report) {
  const lines = [];
  lines.push(`# Loop run \`${report.run_id}\` — ${report.brief.title || report.brief.id}`);
  lines.push("");
  lines.push(`**Outcome:** ${report.outcome}${report.outcome_note ? ` — ${report.outcome_note}` : ""}`);
  lines.push("");
  lines.push(`| | |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Base commit | \`${String(report.base_sha || "").slice(0, 12)}\` |`);
  lines.push(`| Route | \`${report.brief.route}\` |`);
  lines.push(`| Spend | ${formatUsd(report.spend_usd)} of ${formatUsd(report.max_spend_usd)} ceiling |`);
  lines.push(`| Winner | ${report.winner ? `\`${report.winner}\`` : "none"} |`);
  lines.push("");
  if (report.cost_unreported) {
    lines.push("> At least one provider call reported no cost, so the dollar total is a lower bound. Per-call caps still bounded the run.");
    lines.push("");
  }

  for (const candidate of report.candidates) {
    lines.push(`## ${candidate.candidate_id}${candidate.candidate_id === report.winner ? " (winner)" : ""} — ${candidate.outcome}`);
    lines.push("");
    lines.push(`Branch \`${candidate.branch}\` · best score ${formatScore(candidate.best_score)} · ${formatUsd(candidate.spend_usd)}`);
    lines.push("");
    if (candidate.variation) {
      lines.push(`_Approach: ${candidate.variation}_`);
      lines.push("");
    }
    for (const iteration of candidate.iterations) {
      lines.push(`### Iteration ${iteration.iteration} — ${iteration.gates_passed}/${iteration.gates_total} gates (score ${formatScore(iteration.score)})`);
      lines.push("");
      if (iteration.violations.length > 0) {
        lines.push(`Reverted forbidden edits: ${iteration.violations.map((entry) => `\`${entry}\``).join(", ")}`);
        lines.push("");
      }
      if (iteration.verdicts.length === 0) {
        lines.push(`No gates ran (${iteration.status}).`);
        lines.push("");
        continue;
      }
      lines.push("| Gate | Kind | Result | Detail |");
      lines.push("| --- | --- | --- | --- |");
      for (const verdict of iteration.verdicts) {
        lines.push(`| \`${verdict.id}\`${verdict.blocking ? "" : " _(advisory)_"} | ${verdict.kind} | ${verdict.status} | ${String(verdict.detail).replace(/\|/g, "\\|")} |`);
      }
      lines.push("");
    }
  }

  lines.push(shipLine(report.ship));
  return lines.join("\n");
}

function verdictRows(iteration) {
  return iteration.verdicts.map((verdict) => `
      <tr class="v-${escapeHtml(verdict.status)}">
        <th scope="row"><code>${escapeHtml(verdict.id)}</code>${verdict.blocking ? "" : ' <small class="dim">advisory</small>'}</th>
        <td>${escapeHtml(verdict.kind)}</td>
        <td><span class="pill p-${escapeHtml(verdict.status)}">${escapeHtml(verdict.status)}</span></td>
        <td>${verdict.score === null ? "" : escapeHtml(formatScore(verdict.score))}</td>
        <td>${escapeHtml(verdict.detail)}</td>
      </tr>`).join("");
}

export function renderLoopReportHtml(report) {
  const candidateSections = report.candidates.map((candidate) => {
    const iterations = candidate.iterations.map((iteration) => `
    <details${iteration.iteration === candidate.iterations.length ? " open" : ""}>
      <summary>Iteration ${iteration.iteration} — ${iteration.gates_passed}/${iteration.gates_total} gates · score ${escapeHtml(formatScore(iteration.score))} · ${escapeHtml(iteration.changed_files)} file(s) · ${escapeHtml(formatDuration(iteration.duration_ms))}</summary>
      ${iteration.violations.length > 0 ? `<p class="warn">Reverted forbidden edits: ${iteration.violations.map((entry) => `<code>${escapeHtml(entry)}</code>`).join(", ")}</p>` : ""}
      ${iteration.verdicts.length === 0
    ? `<p class="dim">No gates ran (${escapeHtml(iteration.status)}${iteration.agent.budget_stop_reason ? `, ${escapeHtml(iteration.agent.budget_stop_reason)}` : ""}).</p>`
    : `<div class="table-wrap"><table>
        <thead><tr><th>Gate</th><th>Kind</th><th>Result</th><th>Score</th><th>Detail</th></tr></thead>
        <tbody>${verdictRows(iteration)}</tbody>
      </table></div>`}
    </details>`).join("");

    return `
  <section>
    <h2>${escapeHtml(candidate.candidate_id)}${candidate.candidate_id === report.winner ? ' <span class="pill p-pass">winner</span>' : ""} — ${escapeHtml(candidate.outcome)}</h2>
    <p class="dim">Branch <code>${escapeHtml(candidate.branch)}</code> · best score ${escapeHtml(formatScore(candidate.best_score))} · ${escapeHtml(formatUsd(candidate.spend_usd))}</p>
    ${candidate.variation ? `<p class="dim">Approach: ${escapeHtml(candidate.variation)}</p>` : ""}
    ${candidate.error ? `<p class="warn">${escapeHtml(candidate.error)}</p>` : ""}
    ${iterations}
  </section>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Agentify loop report">
<title>Loop report — ${escapeHtml(report.brief.title || report.brief.id)} (${escapeHtml(report.run_id)})</title>
<style>
  :root {
    color-scheme: dark light;
    --bg: #0d1117;
    --surface: #161b22;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --good: #7ee787;
    --bad: #ff7b72;
    --amber: #d29922;
    --border: #30363d;
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
      --bad: #cf222e;
      --amber: #9a6700;
      --border: #d0d7de;
    }
  }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; line-height: 1.6; }
  header.hero { max-width: 70rem; margin-inline: auto; padding: 3rem 1.5rem 1rem; }
  main { max-width: 70rem; margin-inline: auto; padding: 0 1.5rem 4rem; }
  section { margin-block-start: 3rem; }
  h1, h2 { line-height: 1.15; letter-spacing: -0.02em; text-wrap: balance; }
  h1 { margin: 0 0 0.75rem; font-size: clamp(1.7rem, 1.3rem + 2vw, 2.5rem); }
  h2 { margin-block-end: 0.4rem; font-size: 1.3rem; }
  p { max-width: 80ch; text-wrap: pretty; }
  .eyebrow { margin-block-end: 0.25rem; color: var(--good); font-family: var(--mono); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
  .dim { color: var(--text-dim); }
  .warn { color: var(--amber); }
  .meta-row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-block-start: 1rem; }
  .meta { border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text-dim); font-family: var(--mono); font-size: 0.75rem; padding: 0.2rem 0.75rem; }
  .pill { border-radius: 999px; font-family: var(--mono); font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em; padding: 0.1rem 0.55rem; text-transform: uppercase; }
  .p-pass { background: color-mix(in srgb, var(--good) 18%, transparent); color: var(--good); }
  .p-fail { background: color-mix(in srgb, var(--bad) 18%, transparent); color: var(--bad); }
  .p-error { background: color-mix(in srgb, var(--amber) 18%, transparent); color: var(--amber); }
  .p-skipped { background: var(--surface); color: var(--text-dim); }
  .verdict-card { border: 1px solid var(--border); border-inline-start: 0.25rem solid var(--accent); border-radius: 0.5rem; background: var(--surface); padding: 1rem 1.25rem; margin-block-start: 1.5rem; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { border-block-end: 1px solid var(--border); padding: 0.5rem 0.65rem; text-align: start; vertical-align: top; }
  thead th { color: var(--text-dim); font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; }
  tbody tr:last-child > :is(th, td) { border-block-end: 0; }
  code { border: 1px solid var(--border); border-radius: 0.3rem; background: var(--surface); font-family: var(--mono); font-size: 0.86em; padding: 0.05rem 0.35rem; overflow-wrap: anywhere; }
  details { margin-block: 0.6rem; border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.55rem 0.75rem; }
  summary { min-block-size: 1.5rem; cursor: pointer; font-family: var(--mono); font-size: 0.85rem; }
  footer { border-block-start: 1px solid var(--border); padding: 1.5rem; color: var(--text-dim); font-family: var(--mono); font-size: 0.75rem; text-align: center; }
</style>
</head>
<body>
<header class="hero">
  <p class="eyebrow">Agentify loop</p>
  <h1>${escapeHtml(report.brief.title || report.brief.id)}</h1>
  <p class="dim">${escapeHtml(report.outcome_note || "")}</p>
  <div class="meta-row">
    <span class="meta">run ${escapeHtml(report.run_id)}</span>
    <span class="meta">outcome ${escapeHtml(report.outcome)}</span>
    <span class="meta">base ${escapeHtml(String(report.base_sha || "").slice(0, 12))}</span>
    <span class="meta">route ${escapeHtml(report.brief.route ?? "n/a")}</span>
    <span class="meta">spend ${escapeHtml(formatUsd(report.spend_usd))} / ${escapeHtml(formatUsd(report.max_spend_usd))}</span>
    <span class="meta">agentify ${escapeHtml(report.agentify_version ?? "n/a")}</span>
  </div>
</header>
<main>
  <div class="verdict-card">
    <p><strong>${escapeHtml(shipLine(report.ship))}</strong></p>
    ${report.cost_unreported ? '<p class="warn">At least one provider call reported no cost, so the dollar total is a lower bound. Per-call caps and the iteration ceiling still bounded the run.</p>' : ""}
    ${report.budget_warning ? `<p class="warn">${escapeHtml(report.budget_warning)}</p>` : ""}
  </div>
  ${candidateSections}
</main>
<footer>Generated by Agentify ${escapeHtml(report.agentify_version ?? "")} · artifacts in ${escapeHtml(report.artifacts_root ?? "n/a")}</footer>
</body>
</html>
`;
}

export function renderLoopReport(report, format = "text") {
  switch (format) {
    case "json": return JSON.stringify(report, null, 2);
    case "md": return renderLoopReportMarkdown(report);
    case "html": return renderLoopReportHtml(report);
    default: return renderLoopReportText(report);
  }
}
