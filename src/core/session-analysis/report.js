import path from "node:path";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
    ? new Intl.NumberFormat("en-US").format(Number(value))
    : "—";
}

function formatCompactNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
    ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value))
    : "—";
}

function formatDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1000)} seconds`;
  if (milliseconds < 3_600_000) {
    const minutes = Math.round(milliseconds / 60_000);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = milliseconds / 3_600_000;
  return `${hours.toFixed(hours >= 10 ? 0 : 1)} hours`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function formatPercent(value) {
  if (value === null || value === undefined || value === "") return "—";
  const ratio = Number(value);
  return Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : "—";
}

function formatDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Date(value).toISOString().slice(0, 10);
}

function tokenTotal(usage) {
  const fields = ["fresh_input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens"];
  const observed = fields.map((field) => usage?.[field]).filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
  return observed.length === 0 ? null : observed.reduce((sum, value) => sum + Number(value), 0);
}

function displayRecommendations(report) {
  const generated = (report.insights?.recommendations || []).map((item) => ({
    id: `cli-${stableDisplayId(item)}`,
    category: item.category,
    observed: { evidence_ids: item.evidence_ids.join(", ") },
    suggestion: { capability: item.title, command: item.command },
    rationale: item.rationale,
    impact: { provenance: "CLI-assisted", summary: "Generated from the sanitized evidence packet; no additional local evidence was read." },
    confidence: item.confidence,
    verification: `Run the suggested command and compare the observed workflow metric tied to ${item.evidence_ids.join(", ")}.`,
    caveat: item.caveat,
  }));
  return [...generated, ...(report.recommendations || [])];
}

function stableDisplayId(item) {
  return String(item.title || item.command || "recommendation").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

function costLabel(report) {
  if (report.totals?.reported_cost_usd !== null && report.totals?.reported_cost_usd !== undefined) {
    return `$${Number(report.totals.reported_cost_usd).toFixed(4)} reported`;
  }
  if (report.totals?.estimated_cost_usd !== null && report.totals?.estimated_cost_usd !== undefined) {
    return `$${Number(report.totals.estimated_cost_usd).toFixed(4)} estimated`;
  }
  return "unavailable";
}

function distinct(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function options(values) {
  return values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
}

function metric(label, value, note, tone = "neutral") {
  return `<div class="metric metric--${tone}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd><p>${escapeHtml(note)}</p></div>`;
}

function recommendationCard(item, index) {
  return `<article class="recommendation" data-recommendation-category="${escapeHtml(item.category)}" style="--i:${index}">
    <div class="recommendation__meta"><span class="badge badge--${escapeHtml(item.confidence)}">${escapeHtml(item.confidence)} confidence</span><span>${escapeHtml(item.impact?.provenance || "unavailable")} impact</span></div>
    <h3>${escapeHtml(item.suggestion?.capability || item.id)}</h3>
    <p class="observation">${escapeHtml(Object.entries(item.observed || {}).map(([key, value]) => `${key.replaceAll("_", " ")}: ${value}`).join(" · ") || "No count available")}</p>
    <p><strong>Why this helps:</strong> ${escapeHtml(item.rationale)}</p>
    <pre class="command" tabindex="0"><code>${escapeHtml(item.suggestion?.command || "")}</code></pre>
    <details class="recommendation__details"><summary>Evidence receipt</summary><dl class="recommendation__receipt"><div><dt>Impact</dt><dd>${escapeHtml(item.impact?.summary || "Unavailable")}</dd></div><div><dt>Verify</dt><dd>${escapeHtml(item.verification)}</dd></div><div><dt>Caveat</dt><dd>${escapeHtml(item.caveat)}</dd></div></dl></details>
  </article>`;
}

function sessionRows(report) {
  if (report.sessions.length === 0) {
    return '<tr class="empty-row"><td colspan="10">No sessions matched this scope and time window.</td></tr>';
  }
  return report.sessions.map((session) => {
    const tokens = tokenTotal(session.usage);
    const confidence = session.task?.confidence >= 0.7 ? "high" : session.task?.confidence >= 0.4 ? "medium" : "low";
    return `<tr data-session-row data-provider="${escapeHtml(session.provider)}" data-project="${escapeHtml(session.project?.alias)}" data-date="${escapeHtml(formatDate(session.started_at))}" data-task="${escapeHtml(session.task?.category)}" data-confidence="${confidence}" data-duration="${Number(session.duration_ms) || 0}" data-tokens="${tokens ?? -1}">
      <th scope="row"><code>${escapeHtml(session.session_id.slice(0, 8))}</code></th>
      <td>${escapeHtml(formatDate(session.started_at))}</td>
      <td>${escapeHtml(session.provider)}</td>
      <td>${escapeHtml(session.project?.alias || "Current project")}</td>
      <td>${escapeHtml(formatDuration(session.duration_ms))}</td>
      <td>${escapeHtml(session.models.join(", ") || "unavailable")}</td>
      <td class="number">${escapeHtml(formatNumber(tokens))}</td>
      <td>${escapeHtml(session.cost?.basis || "unavailable")}</td>
      <td>${escapeHtml(session.task?.category || "unknown")} · ${escapeHtml(confidence)}</td>
      <td class="number">${escapeHtml(formatNumber(session.opportunities?.length || 0))}</td>
    </tr>`;
  }).join("");
}

function providerRows(report) {
  return report.providers.map((provider) => `<tr><th scope="row">${escapeHtml(provider.provider)}</th><td class="number">${formatNumber(provider.files)}</td><td class="number">${formatBytes(provider.bytes)}</td><td class="number">${formatNumber(provider.sessions)}</td><td class="number">${formatNumber(provider.records)}</td><td class="number">${formatNumber(provider.project_probe_only_files)}</td><td class="number">${formatNumber(provider.malformed_records)}</td><td class="number">${formatNumber(provider.oversized_records)}</td></tr>`).join("");
}

function fileRows(report) {
  const rows = report.sessions.flatMap((session) => (session.file_access || []).map((event) => ({ session, event })));
  if (rows.length === 0) return '<tr><td colspan="7">No structured file access was attributable at high or medium confidence.</td></tr>';
  return rows.map(({ session, event }) => `<tr><th scope="row"><code>${escapeHtml(event.path)}</code></th><td>${escapeHtml(session.project?.alias)}</td><td>${escapeHtml(session.provider)}</td><td>${escapeHtml(event.operation)}</td><td>${escapeHtml(event.source)}</td><td>${escapeHtml(event.confidence)}</td><td class="number">${formatNumber(event.events)}</td></tr>`).join("");
}

function privacyRows(report) {
  const privacy = report.privacy || {};
  const sources = (privacy.source_roots || []).map((source) => `${source.provider}: ${source.category}`).join(", ") || "none";
  return [
    ["Sources read", sources],
    ["Record bodies read", privacy.record_bodies_read ? "Yes — matching JSONL records were parsed in this run" : "No — dry-run, cache-only, or no matching records"],
    ["Current-repo boundary", privacy.current_repo_boundary || "Not applicable — global scope was explicitly selected"],
    ["Unrelated project records read", privacy.unrelated_project_records_read === false ? "No" : "Not applicable"],
    ["Transcript bodies retained", privacy.raw_transcript_retained ? "Yes" : "No"],
    ["Command bodies retained", privacy.command_bodies_retained ? "Yes" : "No"],
    ["Uploaded", privacy.uploads ? "Yes" : "No"],
    ["Provider processes started", privacy.provider_processes_started ? "Yes" : "No"],
    ["Content mode", report.content_mode],
    ["Insight packet sent", report.insights?.packet_sent ? "Yes" : "No"],
    ["Report-generation spend", report.insights?.spend_usd ? `$${Number(report.insights.spend_usd).toFixed(4)}` : "$0.0000"],
  ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
}

function configAuditDetails(audit) {
  if (!audit) return "";
  const claude = audit.providers?.claude || {};
  const codex = audit.providers?.codex || {};
  const integrations = (value) => Object.entries(value || {}).map(([key, count]) => `${key}: ${count}`).join(" · ") || "none";
  return `<details><summary>Global configuration audit</summary><dl class="receipt"><div><dt>Instruction files</dt><dd>${formatNumber(audit.instructions?.files)} · ${formatBytes(audit.instructions?.bytes)} · ~${formatNumber(audit.instructions?.estimated_tokens)} always-loaded tokens</dd></div><div><dt>Duplicate rules</dt><dd>${formatNumber(audit.instructions?.duplicate_rules)}</dd></div><div><dt>Potential conflicts</dt><dd>${formatNumber(audit.instructions?.potential_conflicts)}</dd></div><div><dt>Claude setting keys</dt><dd>${escapeHtml((claude.settings_keys || []).join(", ") || "none")}</dd></div><div><dt>Codex setting keys</dt><dd>${escapeHtml((codex.settings_keys || []).join(", ") || "none")}</dd></div><div><dt>Secret keys excluded</dt><dd>${formatNumber((claude.secret_keys_excluded || 0) + (codex.secret_keys_excluded || 0))}</dd></div><div><dt>Claude integrations</dt><dd>${escapeHtml(integrations(claude.integrations))}</dd></div><div><dt>Codex integrations</dt><dd>${escapeHtml(integrations(codex.integrations))}</dd></div><div><dt>Always excluded</dt><dd>${escapeHtml((audit.excluded_categories || []).join(" · "))}</dd></div></dl></details>`;
}

export function defaultAnalysisReportPath(root) {
  return path.join(root, "agentify-session-analysis.html");
}

export function renderAnalysisText(report) {
  const recommendations = displayRecommendations(report);
  const privacy = report.privacy || {};
  const lines = [
    `Agentify analysis — ${report.scope}, last ${report.window_days} day(s)`,
    `Sessions: ${report.totals.sessions}`,
    `Active time: ${formatDuration(report.totals.active_duration_ms)}`,
    `Fresh input tokens: ${formatNumber(report.totals.usage.fresh_input_tokens)}`,
    `Cache read tokens: ${formatNumber(report.totals.usage.cache_read_tokens)}`,
    `Tool calls: ${formatNumber(report.totals.tool_calls)}`,
    `Cost: ${costLabel(report)}`,
    "",
    "Where Agentify may help:",
    ...(recommendations.length > 0
      ? recommendations.slice(0, 3).map((item) => `- [${item.confidence}] ${item.suggestion.capability}: ${item.rationale} Try: ${item.suggestion.command} Caveat: ${item.caveat}`)
      : ["- No recommendation cleared the evidence threshold."]),
    "",
    `Coverage: ${report.coverage.cache.hits} cache hit(s), ${report.coverage.cache.misses} miss(es), ${report.providers.reduce((sum, item) => sum + item.malformed_records, 0)} malformed record(s)`,
    `Privacy: JSONL record bodies were ${privacy.record_bodies_read ? "read" : "not read"}; raw prompt/response/thinking and command bodies were not retained. ${privacy.uploads ? "One sanitized evidence packet was sent to the selected provider CLI." : "Nothing was uploaded."}`,
  ];
  return lines.join("\n");
}

export function renderAnalysisHtml(report) {
  const providerValues = distinct(report.sessions.map((session) => session.provider));
  const projectValues = distinct(report.sessions.map((session) => session.project?.alias));
  const taskValues = distinct(report.sessions.map((session) => session.task?.category));
  const allRecommendations = displayRecommendations(report);
  const recommendationValues = distinct(allRecommendations.map((item) => item.category));
  const topRecommendations = allRecommendations.slice(0, 3);
  const recommendations = topRecommendations.length > 0
    ? topRecommendations.map(recommendationCard).join("")
    : '<div class="empty-state"><strong>No evidence-backed action yet.</strong><p>The analyzer suppressed generic tips because the required local evidence was not present.</p></div>';
  const suppressed = (report.suppressed_recommendations || []).map((item) => `<li><code>${escapeHtml(item.id)}</code> — ${escapeHtml(item.reason)}</li>`).join("") || "<li>None</li>";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <title>Local usage analysis | Agentify</title>
  <style>
    :root { color-scheme:dark; --bg:#0d1117; --surface:#161b22; --border:#30363d; --text:#e6edf3; --muted:#8b949e; --accent:#58a6ff; --green:#7ee787; --warn:#d29922; --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace; --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
    @media (prefers-color-scheme:light) { :root { color-scheme:light; --bg:#fff; --surface:#f6f8fa; --border:#d0d7de; --text:#1f2328; --muted:#59636e; --accent:#0969da; --green:#1a7f37; --warn:#9a6700; } }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; min-width:20rem; background:var(--bg); color:var(--text); font:400 1rem/1.6 var(--sans); }
    .shell { width:min(55rem,100%); margin:auto; padding:0 1.5rem 4rem; }
    .skip-link { position:fixed; left:1rem; top:1rem; z-index:20; padding:.6rem 1rem; background:var(--accent); color:#fff; transform:translateY(-200%); }
    .skip-link:focus { transform:none; }
    :where(a,button,select,input,summary):focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    code,pre { font-family:var(--mono); }
    .masthead { padding:4.5rem 0 2.5rem; text-align:center; }
    .brand { display:inline-block; margin:0 0 1.25rem; padding:0; border:0; background:none; color:var(--accent); font:600 .68rem/1.22 var(--mono); text-align:left; white-space:pre; }
    .eyebrow { margin:0 0 .35rem; color:var(--green); font:700 .72rem/1.4 var(--mono); letter-spacing:.1em; text-transform:uppercase; }
    h1,h2,h3 { margin:0; line-height:1.2; letter-spacing:-.02em; }
    h1 { font-size:clamp(2rem,6vw,3rem); }
    h2 { font-size:1.5rem; }
    h3 { font-size:1.05rem; }
    .lede { max-width:40rem; margin:.75rem auto 0; color:var(--muted); font-size:1.08rem; }
    .meta-line { display:flex; flex-wrap:wrap; justify-content:center; gap:.45rem; margin-top:1.25rem; }
    .meta-line span,.badge { display:inline-flex; align-items:center; padding:.2rem .65rem; border:1px solid var(--border); border-radius:999px; color:var(--muted); font:600 .72rem/1.4 var(--mono); }
    .badge--high { color:var(--green); border-color:var(--green); } .badge--medium { color:var(--warn); border-color:var(--warn); }
    .metrics { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.75rem; margin:2rem 0 0; text-align:left; }
    .metric { min-width:0; padding:1rem; border:1px solid var(--border); border-radius:.625rem; background:var(--surface); }
    .metric dt { color:var(--muted); font:600 .72rem/1.3 var(--mono); text-transform:uppercase; }
    .metric dd { margin:.35rem 0 0; color:var(--text); font:700 clamp(1.45rem,5vw,2rem)/1.15 var(--mono); overflow-wrap:anywhere; }
    .metric p { margin:.3rem 0 0; color:var(--muted); font-size:.78rem; }
    section { margin-top:3.5rem; }
    .section-heading { margin-bottom:1rem; }
    .section-heading p { max-width:42rem; margin:.35rem 0 0; color:var(--muted); }
    .recommendations { display:grid; gap:1rem; }
    .recommendation { padding:1.25rem; border:1px solid var(--border); border-radius:.625rem; background:var(--surface); }
    .recommendation__meta { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem; margin-bottom:1rem; color:var(--muted); font:600 .72rem/1.4 var(--mono); }
    .recommendation p { margin:.7rem 0; }
    .observation { color:var(--muted); font:500 .82rem/1.55 var(--mono); }
    pre.command { max-width:100%; overflow-wrap:anywhere; white-space:pre-wrap; margin:1rem 0 0; padding:.8rem 1rem; border:1px solid var(--border); border-radius:.4rem; background:var(--bg); color:var(--green); font-size:.84rem; }
    .recommendation__details { margin-top:.8rem; }
    .recommendation__receipt { margin:0; }
    .recommendation__receipt div { display:grid; gap:.15rem; padding:.7rem 0; border-top:1px solid var(--border); }
    .recommendation__receipt dt { color:var(--muted); font:600 .7rem/1.4 var(--mono); text-transform:uppercase; }
    .recommendation__receipt dd { margin:0; }
    .explainer { display:grid; gap:.65rem; margin:0; }
    .explainer div { display:grid; grid-template-columns:4rem 1fr; gap:1rem; padding:.85rem 0; border-bottom:1px solid var(--border); }
    .explainer dt { color:var(--accent); font:700 .75rem/1.5 var(--mono); text-transform:uppercase; }
    .explainer dd { margin:0; color:var(--muted); }
    details { border-top:1px solid var(--border); }
    summary { min-height:3rem; padding:.85rem 0; cursor:pointer; font-weight:650; }
    details[open]>summary { color:var(--accent); }
    .evidence { padding:.25rem 0 1.5rem; }
    .filters { display:grid; gap:.75rem; padding:1rem; border:1px solid var(--border); border-radius:.625rem; background:var(--surface); }
    .filter { display:grid; gap:.2rem; }
    label { color:var(--muted); font:600 .72rem/1.3 var(--mono); }
    select,input,button { width:100%; min-height:2.6rem; padding:.55rem .7rem; border:1px solid var(--border); border-radius:.4rem; background:var(--bg); color:var(--text); font:inherit; }
    button { cursor:pointer; }
    .result-count { margin:.7rem 0 0; color:var(--muted); font-size:.85rem; }
    .table-wrap { overflow:auto; margin-top:.75rem; border:1px solid var(--border); border-radius:.4rem; }
    table { width:100%; min-width:52rem; border-collapse:collapse; font-size:.84rem; }
    caption { padding:.7rem .8rem; color:var(--muted); text-align:left; font:600 .72rem/1.4 var(--mono); }
    th,td { padding:.65rem .8rem; border-top:1px solid var(--border); text-align:left; vertical-align:top; }
    thead th { color:var(--muted); background:var(--surface); font:600 .7rem/1.3 var(--mono); text-transform:uppercase; }
    tbody th { font-weight:600; }
    .number { text-align:right; font-variant-numeric:tabular-nums; }
    .receipt { margin:0; border:1px solid var(--border); border-radius:.4rem; overflow:hidden; }
    .receipt div { display:grid; grid-template-columns:minmax(8rem,1fr) 2fr; gap:1rem; padding:.65rem .8rem; border-top:1px solid var(--border); }
    .receipt div:first-child { border-top:0; }
    .receipt dt { color:var(--muted); }
    .receipt dd { margin:0; overflow-wrap:anywhere; }
    .suppressed { color:var(--muted); }
    .empty-state { padding:1.25rem; border:1px dashed var(--border); border-radius:.625rem; }
    .empty-state p { margin:.35rem 0 0; color:var(--muted); }
    footer { margin-top:4rem; padding:1.5rem 0; border-top:1px solid var(--border); color:var(--muted); text-align:center; font-size:.85rem; }
    [hidden] { display:none !important; }
    @media (min-width:42rem) { .metrics,.recommendations { grid-template-columns:repeat(2,minmax(0,1fr)); } .filters { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior:auto !important; transition:none !important; } }
    @media print { :root { color-scheme:light; --bg:#fff; --surface:#fff; --text:#1f2328; --muted:#59636e; --border:#d0d7de; --accent:#0969da; --green:#1a7f37; } .shell { width:100%; padding:0; } .skip-link,.filters { display:none !important; } details { break-inside:avoid; } pre,.table-wrap { overflow:visible; } }
  </style>
</head>
<body data-testid="session-analysis-report">
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <div class="shell">
    <header class="masthead">
      <pre class="brand" aria-label="AGENTIFY">AGENTIFY
LOCAL · PRIVATE · EVIDENCE-BASED</pre>
      <p class="eyebrow">Session analysis · ${escapeHtml(report.scope)}</p>
      <h1>Where Agentify can save work.</h1>
      <p class="lede">A private, local summary of the last ${escapeHtml(report.window_days)} days. Only recommendations backed by your Claude Code and Codex metadata appear here.</p>
      <div class="meta-line"><span>${report.privacy?.uploads ? "sanitized insight packet sent" : "no uploads"}</span><span>${escapeHtml(report.content_mode)}</span><span>${report.dry_run ? "dry-run" : report.insights?.mode === "cli" ? "CLI-assisted insights" : "deterministic rules"}</span><span>cache read ${escapeHtml(formatCompactNumber(report.totals.usage.cache_read_tokens))}</span><span>cost ${escapeHtml(costLabel(report))}</span></div>
      <dl class="metrics">
        ${metric("Sessions", formatCompactNumber(report.totals.sessions), `${providerValues.length} provider${providerValues.length === 1 ? "" : "s"}`, "accent")}
        ${metric("Active time", formatDuration(report.totals.active_duration_ms), "timestamp span")}
        ${metric("Fresh input", formatCompactNumber(report.totals.usage.fresh_input_tokens), "observed tokens")}
        ${metric("Tool calls", formatCompactNumber(report.totals.tool_calls), "metadata envelopes")}
      </dl>
    </header>

    <main id="main-content" tabindex="-1">
      <section aria-labelledby="recommendations-title">
        <div class="section-heading"><p class="eyebrow">Do next</p><h2 id="recommendations-title">${topRecommendations.length} evidence-backed action${topRecommendations.length === 1 ? "" : "s"}</h2><p>These are the only opportunities that cleared the local evidence threshold.</p></div>
        <div class="recommendations">${recommendations}</div>
      </section>

      <section aria-labelledby="method-title">
        <div class="section-heading"><p class="eyebrow">What · why · how</p><h2 id="method-title">The short version</h2></div>
        <dl class="explainer">
          <div><dt>What</dt><dd>${formatNumber(report.totals.sessions)} session${report.totals.sessions === 1 ? "" : "s"} from ${providerValues.length} provider${providerValues.length === 1 ? "" : "s"}, using timing, token counters, tool names, and structured file events.</dd></div>
          <div><dt>Why</dt><dd>Agentify telemetry alone cannot show repeated work happening across the full Claude Code and Codex workflow.</dd></div>
          <div><dt>How</dt><dd>Provider JSONL is streamed locally, raw prompt and response content is discarded, and deterministic rules either produce or suppress advice.</dd></div>
          <div><dt>Helps</dt><dd>You get a small list of changes worth trying, the local evidence behind them, and a concrete verification step.</dd></div>
        </dl>
      </section>

      <section aria-labelledby="evidence-title">
        <div class="section-heading"><p class="eyebrow">Optional detail</p><h2 id="evidence-title">Evidence and privacy receipts</h2><p>Everything below stays collapsed until you need to audit a number.</p></div>
        <details><summary>Explore the ${formatNumber(report.sessions.length)} analyzed session${report.sessions.length === 1 ? "" : "s"}</summary><div class="evidence">
          <form class="filters" id="report-filters">
            <div class="filter"><label for="provider-filter">Provider</label><select id="provider-filter"><option value="">All providers</option>${options(providerValues)}</select></div>
            <div class="filter"><label for="project-filter">Project alias</label><select id="project-filter"><option value="">All projects</option>${options(projectValues)}</select></div>
            <div class="filter"><label for="date-filter">On or after</label><input id="date-filter" type="date"></div>
            <div class="filter"><label for="task-filter">Task category</label><select id="task-filter"><option value="">All tasks</option>${options(taskValues)}</select></div>
            <div class="filter"><label for="confidence-filter">Task confidence</label><select id="confidence-filter"><option value="">All confidence</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></div>
            <div class="filter"><label for="recommendation-filter">Recommendation category</label><select id="recommendation-filter"><option value="">All recommendations</option>${options(recommendationValues)}</select></div>
            <div class="filter"><label for="sort-sessions">Sort sessions</label><select id="sort-sessions"><option value="date-desc">Newest first</option><option value="date-asc">Oldest first</option><option value="duration-desc">Longest duration</option><option value="tokens-desc">Most tokens</option></select></div>
            <div class="filter"><label for="reset-filters">Reset report view</label><button id="reset-filters" type="reset">Reset filters</button></div>
          </form>
          <p class="result-count" id="result-count" aria-live="polite">Showing ${report.sessions.length} of ${report.sessions.length} sessions.</p>
          <div class="table-wrap" tabindex="0"><table id="sessions-table"><caption>Analyzed sessions</caption><thead><tr><th scope="col">Session</th><th scope="col">Date</th><th scope="col">Provider</th><th scope="col">Project</th><th scope="col">Duration</th><th scope="col">Model</th><th scope="col">Tokens</th><th scope="col">Cost basis</th><th scope="col">Task</th><th scope="col">Opportunities</th></tr></thead><tbody>${sessionRows(report)}</tbody></table></div>
        </div></details>
        <details><summary>Provider and parser coverage</summary><div class="table-wrap" tabindex="0"><table><caption>Provider scan coverage</caption><thead><tr><th scope="col">Provider</th><th scope="col">Files</th><th scope="col">Bytes</th><th scope="col">Sessions</th><th scope="col">Records parsed</th><th scope="col">Project probe only</th><th scope="col">Malformed</th><th scope="col">Oversized</th></tr></thead><tbody>${providerRows(report)}</tbody></table></div></details>
        <details><summary>Observed and inferred file activity</summary><div class="table-wrap" tabindex="0"><table><caption>File-access attribution</caption><thead><tr><th scope="col">Path</th><th scope="col">Project</th><th scope="col">Provider</th><th scope="col">Operation</th><th scope="col">Source</th><th scope="col">Confidence</th><th scope="col">Events</th></tr></thead><tbody>${fileRows(report)}</tbody></table></div></details>
        <details><summary>Suppressed recommendation rules</summary><ul class="suppressed">${suppressed}</ul></details>
        ${configAuditDetails(report.config_audit)}
        <details><summary>Cache and schema coverage</summary><dl class="receipt"><div><dt>Schema</dt><dd>${escapeHtml(report.schema_version)}</dd></div><div><dt>Cache</dt><dd>${formatNumber(report.coverage.cache.hits)} hit(s), ${formatNumber(report.coverage.cache.misses)} miss(es), ${formatNumber(report.coverage.cache.writes)} write(s)</dd></div><div><dt>Model coverage</dt><dd>${formatPercent(report.coverage.ratios?.model)}</dd></div><div><dt>File coverage</dt><dd>${formatPercent(report.coverage.ratios?.file_access)}</dd></div><div><dt>Cost coverage</dt><dd>${formatPercent(report.coverage.ratios?.cost)}</dd></div></dl></details>
        <details><summary>Privacy receipt</summary><dl class="receipt">${privacyRows(report)}</dl></details>
      </section>
    </main>
    <footer>Generated locally by <code>agentify analyze</code> on ${escapeHtml(formatDate(report.generated_at))}. No raw transcript, instruction, command, or file content is embedded.</footer>
  </div>
  <script>
    (() => {
      const form = document.getElementById("report-filters");
      const rows = [...document.querySelectorAll("[data-session-row]")];
      const cards = [...document.querySelectorAll("[data-recommendation-category]")];
      const tbody = document.querySelector("#sessions-table tbody");
      const resultCount = document.getElementById("result-count");
      const controls = {
        provider: document.getElementById("provider-filter"), project: document.getElementById("project-filter"),
        date: document.getElementById("date-filter"), task: document.getElementById("task-filter"),
        confidence: document.getElementById("confidence-filter"), recommendation: document.getElementById("recommendation-filter"),
        sort: document.getElementById("sort-sessions")
      };
      const apply = () => {
        let visible = 0;
        for (const row of rows) {
          const show = (!controls.provider.value || row.dataset.provider === controls.provider.value)
            && (!controls.project.value || row.dataset.project === controls.project.value)
            && (!controls.date.value || row.dataset.date >= controls.date.value)
            && (!controls.task.value || row.dataset.task === controls.task.value)
            && (!controls.confidence.value || row.dataset.confidence === controls.confidence.value);
          row.hidden = !show; if (show) visible += 1;
        }
        for (const card of cards) card.hidden = Boolean(controls.recommendation.value && card.dataset.recommendationCategory !== controls.recommendation.value);
        const [key, direction] = controls.sort.value.split("-");
        const factor = direction === "asc" ? 1 : -1;
        rows.sort((a, b) => {
          const av = key === "date" ? a.dataset.date : Number(a.dataset[key]);
          const bv = key === "date" ? b.dataset.date : Number(b.dataset[key]);
          return (av < bv ? -1 : av > bv ? 1 : 0) * factor;
        }).forEach((row) => tbody.append(row));
        resultCount.textContent = "Showing " + visible + " of " + rows.length + " sessions.";
      };
      form.addEventListener("input", apply);
      form.addEventListener("reset", () => setTimeout(apply, 0));
      const detailStates = new Map();
      addEventListener("beforeprint", () => document.querySelectorAll("details").forEach((item) => { detailStates.set(item, item.open); item.open = true; }));
      addEventListener("afterprint", () => detailStates.forEach((open, item) => { item.open = open; }));
      apply();
    })();
  </script>
</body>
</html>`;
}
