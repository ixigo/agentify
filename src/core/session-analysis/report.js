function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

function formatTokens(value) {
  if (value === null || value === undefined) return "—";
  const count = Number(value) || 0;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return formatNumber(count);
}

function formatDuration(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return "—";
  const minutes = (Number(milliseconds) || 0) / 60000;
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)}h`;
  if (minutes >= 1) return `${minutes.toFixed(0)}m`;
  return `${(minutes * 60).toFixed(0)}s`;
}

function costLabel(cost) {
  if (cost.estimated_usd === null) return cost.basis;
  return `est. $${cost.estimated_usd} list price, ${cost.coverage.sessions_priced}/${cost.coverage.sessions_total} session(s) priced — not billed spend`;
}

export function renderAnalysisText(report) {
  const totals = report.totals;
  const lines = [
    `Agentify analyze — ${report.scope}, last ${report.window_days} day(s), providers: ${report.providers.join(", ")}`,
    `${totals.sessions} session(s) · active ${formatDuration(totals.active_ms)} · ${formatNumber(totals.tool_calls)} tool call(s) · cost ${costLabel(totals.cost)}`,
    `Tokens: ${formatTokens(totals.usage.fresh_input_tokens)} fresh in · ${formatTokens(totals.usage.cache_read_tokens)} cache read · ${formatTokens(totals.usage.output_tokens)} out`,
  ];
  const scorecard = report.scorecard;
  if (scorecard && scorecard.overall_score !== null) {
    const workMix = Object.entries(scorecard.work_types)
      .filter(([, count]) => count > 0)
      .map(([type, count]) => `${type} ${count}`)
      .join(" · ");
    lines.push(
      "",
      `Scorecard: ${scorecard.overall_score}/100 (${scorecard.grade}) — ${scorecard.grade_quip}`,
      `Matchup: ${scorecard.matchup.text}`,
      `  (${scorecard.matchup.basis})`,
      `Work mix: ${workMix || "nothing classified"}`,
    );
  }
  if (report.config_audit) {
    const audit = report.config_audit;
    lines.push(
      "",
      `Config audit: always-loaded instructions ~${formatNumber(audit.claude.always_loaded_token_estimate)} token(s)/claude session, ~${formatNumber(audit.codex.always_loaded_token_estimate)} token(s)/codex session · ${formatNumber(audit.cross_provider.duplicated_instruction_lines)} line(s) duplicated across CLAUDE.md/AGENTS.md`,
      ...audit.findings.map((finding) => `  - ${finding}`),
    );
  }
  lines.push("", "Where Agentify helps:");
  if (report.opportunities.length === 0) {
    lines.push("- No evidence-backed opportunities fired in this window.");
  }
  for (const item of report.opportunities.slice(0, 3)) {
    lines.push(`- [${item.confidence}] ${item.rationale}`);
    lines.push(`  Try: ${item.suggestion.command}`);
  }
  const remaining = report.opportunities.length - 3;
  if (remaining > 0) {
    lines.push(`  (+${remaining} more in --format json or html)`);
  }
  lines.push(
    "",
    "The roast:",
    `  ${report.roast.text}`,
    `  (basis: ${report.roast.basis} — for entertainment; the numbers above are the real story)`,
    "",
    `Coverage: ${report.coverage.sessions_analyzed} session(s) analyzed, ${report.coverage.sessions_with_usage} with usage data, ${report.coverage.malformed_lines} malformed line(s) skipped.`,
    `Privacy: ${report.privacy.content_mode}; roots read: ${report.privacy.roots_read.join(", ")}${report.privacy.config_sources_read?.length > 0 ? `; config sources read (structural): ${report.privacy.config_sources_read.length}` : ""}; network calls: ${report.privacy.network_calls}; AI spend: $${report.privacy.ai_spend_usd}.`,
  );
  return lines.join("\n");
}

function metricCard(label, value, note, tone = "neutral") {
  return `<article class="card metric metric--${tone}">
    <p class="metric-label">${escapeHtml(label)}</p>
    <p class="metric-value">${escapeHtml(value)}</p>
    <p class="metric-note">${escapeHtml(note)}</p>
  </article>`;
}

function opportunityCard(item, index) {
  const observed = Object.entries(item.observed)
    .filter(([, value]) => typeof value !== "object")
    .map(([key, value]) => `<span class="chip">${escapeHtml(key.replaceAll("_", " "))}: ${escapeHtml(formatNumber(value))}</span>`)
    .join(" ");
  return `<article class="card opp">
    <header class="opp-head">
      <span class="opp-rank">${index + 1}</span>
      <div>
        <p class="opp-category">${escapeHtml(item.category)} · confidence ${escapeHtml(item.confidence)} · impact ${escapeHtml(item.impact)}</p>
        <h3>${escapeHtml(item.rationale)}</h3>
      </div>
    </header>
    <p class="opp-observed">${observed}</p>
    <p class="opp-try">Try: <code>${escapeHtml(item.suggestion.command)}</code></p>
    <p class="opp-verify">Verify: ${escapeHtml(item.verification)}</p>
    <p class="opp-caveat">${escapeHtml(item.caveat)}</p>
  </article>`;
}

function sessionRowsHtml(rows) {
  if (rows.length === 0) {
    return '<tr><td colspan="14" class="empty">No sessions in this window.</td></tr>';
  }
  return rows.map((row) => `<tr class="session-row" data-provider="${escapeHtml(row.provider)}" data-work-type="${escapeHtml(row.work_type)}" data-fit="${escapeHtml(row.fit)}">
    <th scope="row"><code>${escapeHtml(row.session_id)}</code></th>
    <td>${escapeHtml(row.provider)}</td>
    <td>${escapeHtml(row.project)}</td>
    <td>${escapeHtml(row.date || "—")}</td>
    <td>${escapeHtml(row.work_type)}</td>
    <td><span class="fit fit--${escapeHtml(row.fit)}">${escapeHtml(row.fit)}</span></td>
    <td><span class="outcome outcome--${escapeHtml(row.outcome)}">${escapeHtml(row.outcome)}</span></td>
    <td class="number">${escapeHtml(row.score === null || row.score === undefined ? "—" : String(row.score))}</td>
    <td class="number">${escapeHtml(formatDuration(row.active_ms))}</td>
    <td>${escapeHtml(row.models.join(", ") || "—")}</td>
    <td class="number">${escapeHtml(formatNumber(row.user_turns))}</td>
    <td class="number">${escapeHtml(formatNumber(row.tool_calls))}</td>
    <td class="number">${escapeHtml(formatNumber(row.files_touched))}</td>
    <td class="number">${escapeHtml(row.cost_estimate_usd === null || row.cost_estimate_usd === undefined ? "—" : `$${row.cost_estimate_usd.toFixed(2)}`)}</td>
  </tr>`).join("");
}

// CSS-only filtering: the radio chips below pair with `main:has()` rules in
// the stylesheet, so the report keeps its strict no-<script> guarantee.
function filterGroup(name, legend, values) {
  const options = [{ id: `${name}-all`, value: null, label: "all" }]
    .concat(values.map((value) => ({ id: `${name}-${value.replace(/[^a-z-]/gi, "")}`, value, label: value })));
  const inputs = options.map((option, index) => `<input type="radio" class="filter-input" name="${escapeHtml(name)}" id="${escapeHtml(option.id)}"${index === 0 ? " checked" : ""}><label class="chip chip--filter" for="${escapeHtml(option.id)}">${escapeHtml(option.label)}</label>`).join("");
  return `<fieldset class="filters"><legend>${escapeHtml(legend)}</legend>${inputs}</fieldset>`;
}

const WORK_TYPE_VALUES = ["conversation", "research", "quick-fix", "implementation", "debugging", "mixed"];
const FIT_VALUES = ["overkill", "match", "underkill", "unknown"];

function filterCss() {
  const rules = [];
  for (const provider of ["claude", "codex"]) {
    rules.push(`main:has(#f-provider-${provider}:checked) tr.session-row:not([data-provider="${provider}"]) { display: none; }`);
  }
  for (const type of WORK_TYPE_VALUES) {
    rules.push(`main:has(#f-work-${type.replace(/[^a-z-]/gi, "")}:checked) tr.session-row:not([data-work-type="${type}"]) { display: none; }`);
  }
  for (const fit of FIT_VALUES) {
    rules.push(`main:has(#f-fit-${fit}:checked) tr.session-row:not([data-fit="${fit}"]) { display: none; }`);
  }
  return rules.join("\n    ");
}

function instructionCells(facts) {
  if (!facts?.present) return "<td>not present</td><td class=\"number\">—</td><td class=\"number\">—</td>";
  if (facts.unreadable) return "<td>unreadable</td><td class=\"number\">—</td><td class=\"number\">—</td>";
  return `<td>${facts.oversized ? "present · oversized" : "present"}</td><td class="number">${escapeHtml(formatNumber(facts.lines))}</td><td class="number">~${escapeHtml(formatNumber(facts.always_loaded_token_estimate))}</td>`;
}

function configAuditSection(audit) {
  const nameList = (names) => (names === null ? "—" : names.length === 0 ? "none" : names.map((name) => `<code>${escapeHtml(name)}</code>`).join(" "));
  return `
    <section aria-label="Configuration audit">
      <p class="eyebrow">Configuration audit</p>
      <h2>What every session carries before work starts</h2>
      <article class="card" data-testid="analyze-config-audit">
        <div class="table-wrap"><table><caption>Global instruction files (structural facts only; text is never reproduced)</caption>
          <thead><tr><th scope="col">File</th><th scope="col">Status</th><th scope="col">Lines</th><th scope="col">Token est.</th></tr></thead>
          <tbody>
            <tr><th scope="row"><code>${escapeHtml(audit.homes.claude)}/CLAUDE.md</code></th>${instructionCells(audit.claude.global_instructions)}</tr>
            <tr><th scope="row"><code>${escapeHtml(audit.homes.codex)}/AGENTS.md</code></th>${instructionCells(audit.codex.global_instructions)}</tr>
          </tbody>
        </table></div>
        <p class="score-mix"><strong>Always loaded per session:</strong> claude ~${escapeHtml(formatNumber(audit.claude.always_loaded_token_estimate))} · codex ~${escapeHtml(formatNumber(audit.codex.always_loaded_token_estimate))} token(s) · <strong>duplicated lines across providers:</strong> ${escapeHtml(formatNumber(audit.cross_provider.duplicated_instruction_lines))}</p>
        <p class="score-mix"><strong>Claude skills:</strong> ${nameList(audit.claude.skills)}</p>
        <p class="score-mix"><strong>Claude agents:</strong> ${nameList(audit.claude.agents)} · <strong>commands:</strong> ${nameList(audit.claude.commands)}</p>
        <p class="score-mix"><strong>Codex skills:</strong> ${nameList(audit.codex.skills)}</p>
        ${audit.findings.length > 0 ? `<ul>${audit.findings.map((finding) => `<li>${escapeHtml(finding)}</li>`).join("")}</ul>` : ""}
        <p class="opp-caveat">${escapeHtml(audit.note)}</p>
      </article>
    </section>`;
}

export function renderAnalysisHtml(report, options = {}) {
  const project = options.projectName || "this repository";
  const scopeLabel = report.scope === "global" ? "all projects (pseudonymized)" : project;
  const generated = new Date(report.generated_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  const totals = report.totals;
  const cards = [
    metricCard("sessions analyzed", formatNumber(totals.sessions), `${report.providers.join(" + ")} · last ${report.window_days} day(s)`, "signal"),
    metricCard("active time", formatDuration(totals.active_ms), "Idle gaps over 5 minutes excluded", "signal"),
    metricCard("fresh input tokens", formatTokens(totals.usage.fresh_input_tokens), `plus ${formatTokens(totals.usage.cache_read_tokens)} read from cache`, "good"),
    metricCard("output tokens", formatTokens(totals.usage.output_tokens), "Across all models in window", "good"),
    metricCard("tool calls", formatNumber(totals.tool_calls), `${formatNumber(totals.failed_tool_calls)} failed`, "neutral"),
    totals.cost.estimated_usd !== null
      ? metricCard("cost estimate", `$${formatNumber(totals.cost.estimated_usd)}`, `List price · ${formatNumber(totals.cost.coverage.sessions_priced)}/${formatNumber(totals.cost.coverage.sessions_total)} sessions priced · not billed spend`, "guard")
      : metricCard("cost basis", totals.cost.basis, "Local stores carry no billed cost", "guard"),
  ].join("");

  const scorecard = report.scorecard;
  const workTypeChips = scorecard
    ? Object.entries(scorecard.work_types)
      .filter(([, count]) => count > 0)
      .map(([type, count]) => `<span class="chip">${escapeHtml(type)}: ${escapeHtml(formatNumber(count))}</span>`)
      .join(" ")
    : "";
  const fitChips = scorecard
    ? Object.entries(scorecard.fit)
      .filter(([, count]) => count > 0)
      .map(([verdict, count]) => `<span class="chip chip--${escapeHtml(verdict)}">${escapeHtml(verdict)}: ${escapeHtml(formatNumber(count))}</span>`)
      .join(" ")
    : "";
  const delegationRows = scorecard && scorecard.delegation_candidates.length > 0
    ? scorecard.delegation_candidates.map((candidate) => `<tr>
      <th scope="row"><code>${escapeHtml(candidate.session_id)}</code></th>
      <td>${escapeHtml(candidate.work_type)}</td>
      <td>${escapeHtml(candidate.models.join(", ") || "—")}</td>
      <td><code>${escapeHtml(candidate.suggestion)}</code></td>
    </tr>`).join("")
    : "";
  const scorecardSection = scorecard ? `
    <section aria-label="Usage scorecard">
      <p class="eyebrow">The scorecard</p>
      <h2>Was the weapon worth the fight?</h2>
      <p class="lede">Each session is classified by tool mix${scorecard.work_type_sources?.["content-hint"] > 0 ? ` (${formatNumber(scorecard.work_type_sources["content-hint"])} refined by opt-in in-memory prompt classification)` : ""}, matched against the model that fought it, and scored on token generation per turn, failure hygiene, cache use, and search discipline.</p>
      <article class="card scorecard" data-testid="analyze-scorecard">
        <div class="score-hero">
          <p class="score-grade">${escapeHtml(scorecard.grade ?? "—")}</p>
          <div>
            <p class="score-value">${escapeHtml(scorecard.overall_score === null ? "—" : `${scorecard.overall_score}/100`)}</p>
            <p class="score-quip">${escapeHtml(scorecard.grade_quip)}</p>
          </div>
        </div>
        <blockquote class="score-matchup">${escapeHtml(scorecard.matchup.text).replaceAll(/`([^`]+)`/g, "<code>$1</code>")}</blockquote>
        <p class="roast-basis">basis: ${escapeHtml(scorecard.matchup.basis)}</p>
        <p class="score-mix"><strong>Work mix:</strong> ${workTypeChips || '<span class="chip">nothing classified</span>'}</p>
        <p class="score-mix"><strong>Matchups:</strong> ${fitChips || '<span class="chip">none</span>'}</p>
        ${delegationRows ? `<details><summary>Delegation candidates (${scorecard.delegation_candidates.length})</summary>
          <div class="table-wrap"><table><caption>Overkill sessions with a completed outcome that a cheaper Agentify route could carry</caption><thead><tr><th scope="col">Session</th><th scope="col">Type</th><th scope="col">Models</th><th scope="col">Try</th></tr></thead><tbody>${delegationRows}</tbody></table></div>
        </details>` : ""}
        ${scorecard.delegation_candidates_withheld > 0 ? `<p class="opp-caveat">${escapeHtml(`${scorecard.delegation_candidates_withheld} overkill session(s) withheld: ${scorecard.delegation_withheld_reason}`)}</p>` : ""}
        <p class="opp-caveat">${escapeHtml(scorecard.note)}</p>
      </article>
    </section>` : "";

  const primary = report.opportunities.slice(0, 3).map(opportunityCard).join("");
  const extra = report.opportunities.slice(3);
  const suppressedRows = report.suppressed_rules.map((rule) => `<tr>
    <th scope="row"><code>${escapeHtml(rule.id)}</code></th><td>${escapeHtml(rule.category)}</td><td>${escapeHtml(rule.reason)}</td>
  </tr>`).join("");
  const modelRows = report.models.length === 0
    ? '<tr><td colspan="3" class="empty">No model metadata found.</td></tr>'
    : report.models.map((model) => `<tr>
      <th scope="row"><code>${escapeHtml(model.model)}</code></th>
      <td>${escapeHtml(model.provider)}</td>
      <td class="number">${escapeHtml(formatNumber(model.sessions))}</td>
    </tr>`).join("");
  const toolRows = Object.entries(report.tools).slice(0, 12).map(([name, count]) => `<tr>
    <th scope="row"><code>${escapeHtml(name)}</code></th><td class="number">${escapeHtml(formatNumber(count))}</td>
  </tr>`).join("") || '<tr><td colspan="2" class="empty">No tool calls observed.</td></tr>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="Agentify session analysis">
  <title>Agentify analyze · ${escapeHtml(scopeLabel)}</title>
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
        --bg: #ffffff; --bg-soft: #f6f8fa; --border: #d0d7de; --text: #1f2328;
        --text-dim: #59636e; --accent: #0969da; --accent-2: #1a7f37; --amber: #9a6700; --code-bg: #f6f8fa;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; line-height: 1.6; }
    main { max-width: 880px; margin: 0 auto; padding: 0 24px 64px; }
    header.hero { text-align: center; padding: 56px 24px 8px; }
    .hero pre.logo { font-family: var(--mono); font-size: 11px; line-height: 1.25; color: var(--accent); display: inline-block; text-align: left; margin-bottom: 20px; }
    .hero h1 { font-size: 1.9rem; letter-spacing: -0.02em; margin-bottom: 10px; text-wrap: balance; }
    .hero p.tagline { font-size: 1.05rem; color: var(--text-dim); max-width: 640px; margin: 0 auto 20px; }
    .hero .tagline strong { color: var(--text); }
    .meta-row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
    .meta { font-family: var(--mono); font-size: 0.75rem; color: var(--text-dim); background: var(--bg-soft); border: 1px solid var(--border); border-radius: 999px; padding: 3px 12px; white-space: nowrap; }
    section { margin-top: 56px; }
    h2 { font-size: 1.35rem; margin-bottom: 6px; letter-spacing: -0.01em; }
    h3 { font-size: 1.02rem; letter-spacing: -0.01em; }
    .eyebrow { color: var(--accent-2); font-family: var(--mono); font-size: 0.72rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 4px; }
    p.lede { color: var(--text-dim); margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin-top: 18px; }
    .card { background: var(--bg-soft); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; }
    .metric-label { color: var(--text-dim); font-size: 0.75rem; font-weight: 650; letter-spacing: 0.07em; text-transform: uppercase; }
    .metric-value { font-family: var(--mono); font-size: 1.9rem; font-weight: 700; line-height: 1.15; margin: 8px 0 4px; letter-spacing: -0.03em; }
    .metric--good .metric-value { color: var(--accent-2); }
    .metric--guard .metric-value { color: var(--amber); font-size: 1.3rem; }
    .metric--signal .metric-value { color: var(--accent); }
    .metric-note { color: var(--text-dim); font-size: 0.85rem; }
    .opps { display: grid; gap: 14px; margin-top: 18px; }
    .opp-head { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 10px; }
    .opp-rank { flex: none; font-family: var(--mono); font-weight: 700; font-size: 1.1rem; color: var(--accent); border: 1px solid var(--border); border-radius: 8px; width: 34px; height: 34px; display: grid; place-items: center; }
    .opp-category { color: var(--text-dim); font-family: var(--mono); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 2px; }
    .chip { display: inline-block; font-family: var(--mono); font-size: 0.72rem; color: var(--text-dim); border: 1px solid var(--border); border-radius: 999px; padding: 1px 9px; margin: 2px 4px 2px 0; }
    .opp-try { margin-top: 10px; }
    .opp-verify, .opp-caveat { color: var(--text-dim); font-size: 0.86rem; margin-top: 6px; }
    .opp-caveat::before { content: "Caveat: "; color: var(--amber); font-weight: 600; }
    .scorecard { margin-top: 18px; }
    .score-hero { display: flex; gap: 20px; align-items: center; margin-bottom: 14px; }
    .score-grade { flex: none; font-family: var(--mono); font-size: 3rem; font-weight: 800; color: var(--accent); border: 2px solid var(--border); border-radius: 14px; width: 84px; height: 84px; display: grid; place-items: center; }
    .score-value { font-family: var(--mono); font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; }
    .score-quip { color: var(--text-dim); }
    .score-matchup { font-size: 1.08rem; line-height: 1.55; border-left: 4px solid var(--amber); padding-left: 14px; margin: 14px 0 6px; }
    .score-mix { margin-top: 10px; font-size: 0.9rem; }
    .chip--overkill { color: var(--amber); border-color: var(--amber); }
    .chip--underkill { color: var(--accent); }
    .chip--match { color: var(--accent-2); }
    .fit { font-family: var(--mono); font-size: 0.78rem; }
    .fit--overkill { color: var(--amber); }
    .fit--underkill { color: var(--accent); }
    .fit--match { color: var(--accent-2); }
    .fit--unknown { color: var(--text-dim); }
    .outcome { font-family: var(--mono); font-size: 0.78rem; }
    .outcome--completed { color: var(--accent-2); }
    .outcome--likely-incomplete { color: var(--amber); }
    .outcome--unknown { color: var(--text-dim); }
    .filter-bar { display: flex; flex-wrap: wrap; gap: 16px; margin: 14px 0 4px; }
    .filters { border: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
    .filters legend { float: left; color: var(--text-dim); font-family: var(--mono); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.07em; margin-right: 8px; padding: 2px 0; }
    .filter-input { position: absolute; opacity: 0; width: 1px; height: 1px; }
    .chip--filter { cursor: pointer; user-select: none; }
    .filter-input:checked + .chip--filter { color: var(--text); border-color: var(--accent); background: var(--bg-soft); }
    .filter-input:focus-visible + .chip--filter { outline: 2px solid var(--accent); outline-offset: 2px; }
    ${filterCss()}
    .roast { border-left: 4px solid var(--amber); border-radius: 0 10px 10px 0; margin-top: 18px; }
    .roast blockquote { font-size: 1.12rem; line-height: 1.55; }
    .roast blockquote code { font-size: 0.9em; }
    .roast .roast-basis { color: var(--text-dim); font-family: var(--mono); font-size: 0.75rem; margin-top: 10px; }
    .split { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; margin-top: 20px; }
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
    details { margin-top: 14px; }
    summary { width: fit-content; cursor: pointer; color: var(--text-dim); font-family: var(--mono); font-size: 0.78rem; }
    summary:hover { color: var(--text); }
    .receipt { border-left: 4px solid var(--accent-2); border-radius: 0 10px 10px 0; margin-top: 16px; }
    .receipt ul { margin: 10px 0 0; padding-left: 18px; color: var(--text-dim); font-size: 0.9rem; }
    .receipt li + li { margin-top: 6px; }
    footer { border-top: 1px solid var(--border); margin-top: 72px; padding: 24px; text-align: center; color: var(--text-dim); font-family: var(--mono); font-size: 0.75rem; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (max-width: 560px) { header.hero { padding-top: 32px; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; } }
    @media print {
      :root { color-scheme: light; --bg: #fff; --bg-soft: #fff; --text: #111; --text-dim: #555; --border: #ccc; }
      .card { break-inside: avoid; }
      details { display: none; }
    }
  </style>
</head>
<body>
  <header class="hero">
    <pre class="logo">    _                    _   _  __
   / \\   __ _  ___ _ __ | |_(_)/ _|_   _
  / _ \\ / _\` |/ _ \\ '_ \\| __| | |_| | | |
 / ___ \\ (_| |  __/ | | | |_| |  _| |_| |
/_/   \\_\\__, |\\___|_| |_|\\__|_|_|  \\__, |
        |___/                      |___/</pre>
    <h1>What your agent sessions actually did.</h1>
    <p class="tagline">Agentify analyzed <strong>${formatNumber(totals.sessions)} local session(s)</strong> in ${escapeHtml(scopeLabel)} — ${report.privacy.content_mode === "local-extractive" ? "metadata plus in-memory prompt classification (nothing persisted)" : "metadata only"}, nothing uploaded, zero AI spend — and found where it can pull real weight.</p>
    <div class="meta-row">
      <span class="meta">scope ${escapeHtml(report.scope)}</span>
      <span class="meta">content ${escapeHtml(report.privacy.content_mode)}</span>
      <span class="meta">last ${escapeHtml(report.window_days)} day(s)</span>
      <span class="meta">${escapeHtml(report.providers.join(" + "))}</span>
      <span class="meta">generated ${escapeHtml(generated)} UTC</span>
    </div>
  </header>
  <main id="content" data-testid="agentify-analyze-report">
    <section aria-label="Executive summary">
      <p class="eyebrow">At a glance</p>
      <h2>The window in six numbers</h2>
      <div class="grid">${cards}</div>
    </section>
${scorecardSection}
    <section aria-label="Where Agentify helps">
      <p class="eyebrow">Where Agentify helps</p>
      <h2>Evidence-backed opportunities</h2>
      <p class="lede">Each card links an observed pattern to a specific capability. Confidence and caveats are part of the claim.</p>
      <div class="opps">${primary || '<article class="card"><p class="empty">No evidence-backed opportunities fired in this window — thresholds and suppression reasons are listed below.</p></article>'}</div>
      ${extra.length > 0 ? `<details><summary>${extra.length} more opportunit${extra.length === 1 ? "y" : "ies"}</summary><div class="opps">${extra.map(opportunityCard).join("")}</div></details>` : ""}
      <details><summary>Rules that did not fire, and why</summary>
        <div class="table-wrap"><table><caption>Suppressed recommendations</caption><thead><tr><th scope="col">Rule</th><th scope="col">Category</th><th scope="col">Reason</th></tr></thead><tbody>${suppressedRows || '<tr><td colspan="3" class="empty">Every rule fired.</td></tr>'}</tbody></table></div>
      </details>
    </section>
    <section aria-label="The roast">
      <p class="eyebrow">The roast</p>
      <h2>One observation, served warm</h2>
      <article class="card roast" data-testid="analyze-roast">
        <blockquote>${escapeHtml(report.roast.text).replaceAll(/`([^`]+)`/g, "<code>$1</code>")}</blockquote>
        <p class="roast-basis">basis: ${escapeHtml(report.roast.basis)} · for entertainment — the numbers above are the real story</p>
      </article>
    </section>
    <section aria-label="Workflow profile">
      <p class="eyebrow">Workflow profile</p>
      <h2>Models, tools, and files</h2>
      <div class="split">
        <article class="card">
          <h3>Models observed</h3>
          <div class="table-wrap"><table><caption>Exact model identifiers as recorded by each provider</caption><thead><tr><th scope="col">Model</th><th scope="col">Provider</th><th scope="col">Sessions</th></tr></thead><tbody>${modelRows}</tbody></table></div>
        </article>
        <article class="card">
          <h3>Tool mix</h3>
          <div class="table-wrap"><table><caption>Top tool calls across sessions</caption><tbody>${toolRows}</tbody></table></div>
        </article>
        ${report.tool_inventory ? `<article class="card" data-testid="analyze-tool-inventory">
          <h3>Installed tooling</h3>
          <div class="table-wrap"><table><caption>Version/summary probes — nothing installed, nothing from history executed</caption><tbody>
            ${Object.entries(report.tool_inventory.tools).map(([name, tool]) => `<tr><th scope="row"><code>${escapeHtml(name)}</code></th><td>${tool.available ? `v${escapeHtml(tool.version || "?")}` : "not detected"}${name === "rtk" && tool.gain?.parse_coverage === "json" ? ` · ${escapeHtml(formatTokens(tool.gain.total_saved_tokens))} tokens saved (measured)` : ""}</td></tr>`).join("")}
            <tr><th scope="row"><code>agentify index</code></th><td>${escapeHtml(report.tool_inventory.agentify_index.status)}</td></tr>
          </tbody></table></div>
        </article>` : ""}
      </div>
      <details open><summary>Per-session detail (${report.sessions.length})</summary>
        <div class="filter-bar" role="group" aria-label="Session filters (CSS-only, no script)">
          ${filterGroup("f-provider", "provider", ["claude", "codex"])}
          ${filterGroup("f-work", "work type", WORK_TYPE_VALUES)}
          ${filterGroup("f-fit", "matchup", FIT_VALUES)}
        </div>
        <div class="table-wrap"><table><caption>Sessions in window, newest first — filters above narrow this table without any script</caption><thead><tr><th scope="col">Session</th><th scope="col">Provider</th><th scope="col">Project</th><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Matchup</th><th scope="col">Outcome</th><th scope="col">Score</th><th scope="col">Active</th><th scope="col">Models</th><th scope="col">Turns</th><th scope="col">Tools</th><th scope="col">Files</th><th scope="col">Est. $ (list)</th></tr></thead><tbody>${sessionRowsHtml(report.sessions)}</tbody></table></div>
      </details>
    </section>
${report.config_audit ? configAuditSection(report.config_audit) : ""}
    <section aria-label="Privacy receipt">
      <p class="eyebrow">Privacy receipt</p>
      <h2>Exactly what was read</h2>
      <article class="card receipt">
        <p><strong>Mode:</strong> ${escapeHtml(report.privacy.content_mode)} · <strong>network calls:</strong> ${escapeHtml(report.privacy.network_calls)} · <strong>AI spend:</strong> $${escapeHtml(report.privacy.ai_spend_usd)}</p>
        <p><strong>Roots read:</strong> ${report.privacy.roots_read.map((entry) => `<code>${escapeHtml(entry)}</code>`).join(" ")}</p>
        ${report.privacy.config_sources_read?.length > 0 ? `<p><strong>Config sources read (structural, allowlisted):</strong> ${report.privacy.config_sources_read.map((entry) => `<code>${escapeHtml(entry)}</code>`).join(" ")}</p>` : ""}
        <ul>${report.privacy.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>
        <ul>
          <li>Coverage: ${escapeHtml(formatNumber(report.coverage.sessions_analyzed))} session(s) analyzed, ${escapeHtml(formatNumber(report.coverage.sessions_with_usage))} with usage metadata, ${escapeHtml(formatNumber(report.coverage.malformed_lines))} malformed line(s) skipped.</li>
          <li>${escapeHtml(report.totals.cost.note)}</li>
        </ul>
      </article>
    </section>
  </main>
  <footer>Generated locally by Agentify analyze · self-contained, no external assets · session content never leaves this machine</footer>
</body>
</html>\n`;
}
