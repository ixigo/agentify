// Self-contained HTML report for `agentify git analyze` (#353).
//
// This is the deliverable most users keep, and the only place Agentify gets to
// introduce itself. Two constraints shape everything here:
//
//   1. EVERY FIGURE COMES FROM `summary` (the `git-analyze-v1` object built by
//      cluster.js). Nothing is re-derived, so the HTML can never disagree with
//      the text/md/json renderings of the same run.
//   2. The file must render correctly with the network off: inline CSS, inline
//      SVG, no CDN, no webfont URL, no remote image, and no beacon of any kind.
//
// Everything interpolated here — commit subjects, branch names, author names,
// file paths, repository names — is untrusted text out of a git repository, so
// it goes through escapeHtml() at every single interpolation.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Escaping and formatting.
// ---------------------------------------------------------------------------

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return new Intl.NumberFormat("en-US").format(n);
}

function formatSigned(value, sign) {
  return `${sign}${formatNumber(Math.abs(Number(value) || 0))}`;
}

// An ISO instant reduced to its calendar date. Rendering the full timestamp in
// a summary is noise; the resolved window in the header carries the precision.
function formatDate(value) {
  if (!value) return "—";
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : text;
}

function pluralize(count, singular, plural) {
  return Number(count) === 1 ? singular : (plural || `${singular}s`);
}

// ---------------------------------------------------------------------------
// Environment detection for the Agentify panel.
//
// Read-only and honest: it reports what is actually on THIS machine. Nothing
// here installs, writes, or runs an install-shaped command — the panel must
// never claim a benefit that requires something absent.
// ---------------------------------------------------------------------------

async function onPath(binary) {
  try {
    // `command -v` via execFile with an argument array: the binary name is not
    // interpolated into a shell string.
    await execFileAsync(process.platform === "win32" ? "where" : "which", [binary]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe the machine for what Agentify can actually do here. Read-only.
 *
 * @param {string} repositoryPath - the analysed repository (may be null under --global)
 * @param {object} [injected] - test seam: `{ hasBinary: (name) => Promise<boolean> }`
 * @returns {Promise<{agentifyOnPath: boolean, hasConfig: boolean, providers: string[]}>}
 */
export async function detectEnvironment(repositoryPath, injected = {}) {
  const hasBinary = injected.hasBinary || onPath;
  // Under --global there is no single repository to make a claim about, so the
  // panel reports "not applicable" instead of asserting "not configured" about
  // a repository it never inspected.
  const multiRepository = injected.multiRepository === true;

  const [agentifyOnPath, claude, codex] = await Promise.all([
    hasBinary("agentify"),
    hasBinary("claude"),
    hasBinary("codex"),
  ]);

  let hasConfig = false;
  if (repositoryPath) {
    try {
      await fs.access(path.join(repositoryPath, ".agentify.yaml"));
      hasConfig = true;
    } catch {
      hasConfig = false;
    }
  }

  const providers = [];
  if (claude) providers.push("claude");
  if (codex) providers.push("codex");

  return { agentifyOnPath, hasConfig: multiRepository ? null : hasConfig, providers };
}

// ---------------------------------------------------------------------------
// Charts: hand-rolled inline SVG, each paired with a table fallback so the data
// is readable without the graphic (and by a screen reader).
// ---------------------------------------------------------------------------

const BAR_COLORS = ["--accent", "--accent-2", "--amber"];

function barChart({ items, labelKey, valueKey, title, colorIndex = 0 }) {
  const rows = items.filter((item) => Number(item[valueKey]) > 0);
  if (rows.length === 0) {
    return `<p class="empty">No ${escapeHtml(title.toLowerCase())} to chart.</p>`;
  }
  const max = Math.max(...rows.map((item) => Number(item[valueKey])));
  const barHeight = 22;
  const gap = 8;
  const labelWidth = 130;
  const chartWidth = 620;
  const trackWidth = chartWidth - labelWidth - 60;
  const height = rows.length * (barHeight + gap);
  const color = `var(${BAR_COLORS[colorIndex % BAR_COLORS.length]})`;

  const bars = rows.map((item, index) => {
    const value = Number(item[valueKey]);
    const width = max > 0 ? Math.max(2, Math.round((value / max) * trackWidth)) : 2;
    const y = index * (barHeight + gap);
    const label = escapeHtml(item[labelKey]);
    return `
      <g>
        <text x="0" y="${y + barHeight - 6}" class="bar-label">${label}</text>
        <rect x="${labelWidth}" y="${y}" width="${width}" height="${barHeight}" rx="4" fill="${color}" />
        <text x="${labelWidth + width + 8}" y="${y + barHeight - 6}" class="bar-value">${formatNumber(value)}</text>
      </g>`;
  }).join("");

  const tableRows = rows.map((item) => `<tr><th scope="row">${escapeHtml(item[labelKey])}</th><td class="number">${formatNumber(item[valueKey])}</td></tr>`).join("");

  return `
    <figure class="chart">
      <svg viewBox="0 0 ${chartWidth} ${height}" role="img" aria-label="${escapeHtml(title)}" preserveAspectRatio="xMinYMin meet">
        ${bars}
      </svg>
      <details>
        <summary>Show ${escapeHtml(title.toLowerCase())} as a table</summary>
        <div class="table-wrap">
          <table>
            <caption>${escapeHtml(title)}</caption>
            <thead><tr><th scope="col">Key</th><th scope="col">Commits</th></tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </details>
    </figure>`;
}

function weekChart(byWeek) {
  const items = Array.isArray(byWeek?.items) ? byWeek.items : [];
  if (items.length === 0) {
    return `<p class="empty">No commits to chart over time.</p>`;
  }
  const max = Math.max(...items.map((item) => Number(item.commits) || 0), 1);
  const width = 620;
  const height = 140;
  const slot = width / items.length;
  const barWidth = Math.max(2, Math.min(28, slot - 4));

  const bars = items.map((item, index) => {
    const value = Number(item.commits) || 0;
    const barHeight = Math.round((value / max) * (height - 24));
    const x = index * slot + (slot - barWidth) / 2;
    const y = height - barHeight;
    return `<rect x="${x.toFixed(1)}" y="${y}" width="${barWidth.toFixed(1)}" height="${barHeight}" rx="2" fill="var(--accent)"><title>${escapeHtml(item.key)}: ${formatNumber(value)} commits</title></rect>`;
  }).join("");

  const tableRows = items.map((item) => `<tr><th scope="row">${escapeHtml(item.key)}</th><td class="number">${formatNumber(item.commits)}</td></tr>`).join("");

  return `
    <figure class="chart">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Commits per week" preserveAspectRatio="xMinYMin meet">${bars}</svg>
      <figcaption>Commits per week · earliest to latest</figcaption>
      <details>
        <summary>Show commits per week as a table</summary>
        <div class="table-wrap">
          <table>
            <caption>Commits per week</caption>
            <thead><tr><th scope="col">Week</th><th scope="col">Commits</th></tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </details>
    </figure>`;
}

// ---------------------------------------------------------------------------
// Sections.
// ---------------------------------------------------------------------------

function renderHeader(summary, report) {
  const window = summary.window || {};
  const filters = summary.filters || {};
  const applied = Array.isArray(filters.applied_filters) ? filters.applied_filters : [];

  const filterRows = applied.map((entry) => {
    const values = Array.isArray(entry.values) && entry.values.length > 0
      ? ` ${entry.values.map((value) => escapeHtml(value)).join(", ")}`
      : "";
    const matched = entry.matched === null || entry.matched === undefined
      ? ""
      : ` <span class="muted">— matched ${formatNumber(entry.matched)} ${escapeHtml(entry.unit || "commits")}</span>`;
    return `<li><code>${escapeHtml(entry.flag)}</code>${values}${matched}</li>`;
  }).join("");

  const repoLabel = summary.scope === "global"
    ? `${formatNumber((summary.repositories || []).length)} ${pluralize((summary.repositories || []).length, "repository", "repositories")}`
    : escapeHtml((summary.repositories || [])[0]?.name || report?.repository?.path || "this repository");

  // Filter semantics must be honest about what each kind restricts (#347).
  const semantics = [];
  if (applied.some((entry) => entry.kind === "branch")) {
    semantics.push("<code>--branch</code> restricts reachability");
  }
  if (applied.some((entry) => entry.kind === "grep")) {
    semantics.push("<code>--grep</code> restricts commit messages");
  }

  return `
  <header class="hero">
    <h1>What changed in ${repoLabel}</h1>
    <p class="tagline">${escapeHtml(window.label || "")} · <span class="muted">${escapeHtml(formatDate(window.since))} → ${escapeHtml(formatDate(window.until))}</span></p>
    <dl class="meta">
      <div><dt>Scope</dt><dd>${escapeHtml(summary.scope === "global" ? "all discovered repositories" : "this repository")}</dd></div>
      <div><dt>Window</dt><dd>${escapeHtml(window.form || "days")} · ${escapeHtml(window.timezone || "local")}</dd></div>
      <div><dt>Authors</dt><dd>${formatNumber(summary.totals?.authors)}</dd></div>
    </dl>
    ${filterRows
      ? `<section class="filters" aria-label="Applied filters">
           <h2>Filters applied</h2>
           <ul>${filterRows}</ul>
           ${semantics.length > 0 ? `<p class="muted">${semantics.join(" · ")}.</p>` : ""}
           ${Array.isArray(filters.warnings) && filters.warnings.length > 0
             ? `<ul class="warnings">${filters.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
             : ""}
         </section>`
      : `<p class="muted">No filters applied — this is the whole window.</p>`}
  </header>`;
}

function renderHeadline(summary) {
  const totals = summary.totals || {};
  const stat = (label, value, note) => `
    <div class="stat">
      <p class="stat-label">${escapeHtml(label)}</p>
      <p class="stat-value">${value}</p>
      <p class="stat-note">${escapeHtml(note || "")}</p>
    </div>`;

  return `
  <section aria-labelledby="headline-title">
    <h2 id="headline-title">Headline</h2>
    <div class="stats">
      ${stat("Commits", formatNumber(totals.commits), `${formatNumber(totals.active_days)} active ${pluralize(totals.active_days, "day")}`)}
      ${stat("Churn", `<span class="add">${formatSigned(totals.insertions, "+")}</span> <span class="del">${formatSigned(totals.deletions, "−")}</span>`, `${formatNumber(totals.files)} ${pluralize(totals.files, "file")} touched`)}
      ${stat("Merges landed", formatNumber(totals.merges), "delivery evidence")}
      ${stat("Span", `${escapeHtml(formatDate(totals.first_commit))} → ${escapeHtml(formatDate(totals.last_commit))}`, `${formatNumber(totals.repositories)} ${pluralize(totals.repositories, "repository", "repositories")}`)}
    </div>
  </section>`;
}

function renderDistributions(summary) {
  const distributions = summary.distributions || {};
  const denominatorNote = (dist) => {
    if (!dist || dist.counted === undefined || dist.denominator === undefined) return "";
    if (dist.counted === dist.denominator) return "";
    // State denominators everywhere: "33 of 276" not "33" (#352).
    return `<p class="muted">${formatNumber(dist.counted)} of ${formatNumber(dist.denominator)} commits carry this dimension.</p>`;
  };

  return `
  <section aria-labelledby="dist-title">
    <h2 id="dist-title">Distribution</h2>
    <h3>Over time</h3>
    ${weekChart(distributions.by_week)}
    <h3>By type</h3>
    ${denominatorNote(distributions.by_type)}
    ${barChart({ items: distributions.by_type?.items || [], labelKey: "key", valueKey: "commits", title: "Commits by conventional type", colorIndex: 0 })}
    <h3>By scope</h3>
    ${denominatorNote(distributions.by_scope)}
    ${barChart({ items: (distributions.by_scope?.items || []).slice(0, 12), labelKey: "key", valueKey: "commits", title: "Commits by conventional scope", colorIndex: 1 })}
    <h3>By author</h3>
    ${barChart({ items: (distributions.by_author?.items || []).slice(0, 12), labelKey: "key", valueKey: "commits", title: "Commits by author", colorIndex: 2 })}
  </section>`;
}

// `iteration_signal` is a STRUCTURED value ({kind, key, commits}), not a
// sentence — interpolating it directly renders "[object Object]" in the one
// place the report is meant to surface repeated work on a single unit.
function formatIterationSignal(signal) {
  if (!signal) return "";
  if (typeof signal === "string") {
    return `<p class="iteration">${escapeHtml(signal)}</p>`;
  }
  const commits = Number(signal.commits);
  if (!Number.isFinite(commits) || !signal.key) return "";
  return `<p class="iteration">${formatNumber(commits)} ${pluralize(commits, "commit")} on ${escapeHtml(signal.key)} — repeated work, not noise.</p>`;
}

// A URL is only emitted as an href when it is http(s); anything else (a
// `javascript:` or `data:` URL that somehow reached a tracker field) is dropped
// rather than linked. The visible text is escaped regardless.
function safeHref(value) {
  const raw = String(value || "").trim();
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") return raw;
  } catch {
    return null;
  }
  return null;
}

// The tracker chip for one theme: the resolved issue TITLE, a status/type badge,
// and a link. The title is rendered here (not only in the <h3>) so that provider
// narration, which replaces the heading with its own phrasing, can never hide
// the ticket summary. All values are untrusted remote text and are escaped; the
// link is protocol-guarded.
function renderThemeTracker(tracker) {
  if (!tracker) return "";
  const bits = [];
  if (tracker.resolved) {
    if (tracker.type) bits.push(`<span class="chip">${escapeHtml(tracker.type)}</span>`);
    if (tracker.status) bits.push(`<span class="chip">${escapeHtml(tracker.status)}</span>`);
  }
  const href = safeHref(tracker.url);
  const link = href
    ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow">${escapeHtml(tracker.key)}</a>`
    : `<span>${escapeHtml(tracker.key)}</span>`;
  const title = tracker.resolved && tracker.title ? ` — ${escapeHtml(tracker.title)}` : "";
  if (bits.length === 0 && !href && !title) return "";
  return `<p class="tracker">${link}${title}${bits.length > 0 ? ` ${bits.join(" ")}` : ""}</p>`;
}

// Other tickets a theme cites (tracker_refs), each escaped and, when a safe
// link exists, linked. Untrusted remote text throughout.
function renderThemeTrackerRefs(refs) {
  const entries = refs && typeof refs === "object" ? Object.values(refs) : [];
  if (entries.length === 0) return "";
  const items = entries.map((entry) => {
    const label = entry.resolved && entry.title
      ? `${escapeHtml(entry.key)} — ${escapeHtml(entry.title)}`
      : escapeHtml(entry.key);
    const href = safeHref(entry.url);
    return `<li>${href ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow">${label}</a>` : label}</li>`;
  }).join("");
  return `<details class="tracker-refs"><summary>Also referenced</summary><ul>${items}</ul></details>`;
}

function renderTheme(theme, narrationByThemeId) {
  const types = Object.entries(theme.type_histogram || {})
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `<li><code>${escapeHtml(type)}</code> ×${formatNumber(count)}</li>`)
    .join("");

  const topFiles = (theme.top_files || []).map((file) => `<li><code>${escapeHtml(file.path)}</code> <span class="muted">(${formatNumber(file.commits)})</span></li>`).join("");
  const shas = (theme.shas || []).slice(0, 12).map((sha) => `<code>${escapeHtml(String(sha).slice(0, 7))}</code>`).join(" ");
  const moreShas = (theme.shas || []).length > 12 ? ` <span class="muted">+${formatNumber(theme.shas.length - 12)} more</span>` : "";

  // The narration slot is ADDITIVE. With --ai off there is none, and the theme
  // must read correctly without it.
  const narration = narrationByThemeId.get(theme.id);
  const narrationBlock = narration
    ? `<div class="narration">
         <p class="narration-what">${escapeHtml(narration.what || "")}</p>
         ${narration.how_it_helped ? `<p class="narration-how">${escapeHtml(narration.how_it_helped)}</p>` : ""}
         ${narration.confidence ? `<p class="muted">Confidence: ${escapeHtml(narration.confidence)}</p>` : ""}
       </div>`
    : "";

  const merges = (theme.merge_subjects || []).slice(0, 5)
    .map((subject) => `<li>${escapeHtml(subject)}</li>`)
    .join("");

  // Tracker enrichment (#355). A resolved issue TITLE already rides in
  // `theme.title`; here we add the status/type chip and a link. Every value is
  // untrusted remote text out of a tracker — a Jira summary can contain anything
  // — so it goes through escapeHtml, and the link href is safe-guarded to
  // http(s) before it is ever emitted.
  const trackerBlock = renderThemeTracker(theme.tracker);
  const trackerRefsBlock = renderThemeTrackerRefs(theme.tracker_refs);

  return `
  <article class="theme">
    <h3>${escapeHtml(narration?.title || theme.title)}</h3>
    <p class="theme-stats">
      <strong>${formatNumber(theme.commits)}</strong> ${pluralize(theme.commits, "commit")}
      · <span class="add">${formatSigned(theme.insertions, "+")}</span> <span class="del">${formatSigned(theme.deletions, "−")}</span>
      · ${formatNumber(theme.files_changed)} ${pluralize(theme.files_changed, "file")}
      · ${escapeHtml(formatDate(theme.first_commit))} → ${escapeHtml(formatDate(theme.last_commit))}
    </p>
    ${trackerBlock}
    ${trackerRefsBlock}
    ${narrationBlock}
    ${formatIterationSignal(theme.iteration_signal)}
    ${types ? `<ul class="chips">${types}</ul>` : ""}
    ${topFiles ? `<details><summary>Top files</summary><ul class="files">${topFiles}</ul></details>` : ""}
    ${merges ? `<details><summary>Merges landed</summary><ul>${merges}</ul></details>` : ""}
    <p class="evidence"><span class="muted">Evidence:</span> ${shas}${moreShas}</p>
  </article>`;
}

function renderThemes(summary, narrationByThemeId) {
  const themes = summary.themes || [];
  const smaller = summary.smaller_changes || [];

  // Under --global, group by repository with a per-repo subtotal — never one
  // blended list (#353).
  if (summary.scope === "global") {
    // Group by the repository's PATH, not its display name. Two checkouts can
    // share a basename (`~/work/app` and `~/oss/app`), and grouping on the name
    // silently blends two repositories into one section — exactly what the epic
    // forbids. Themes carry the display name, so map name+path via the
    // repositories list and fall back to the name only when a path is unknown.
    const repositories = summary.repositories || [];
    const themeGroupKey = (theme) => {
      const matches = repositories.filter((entry) => entry.name === theme.repository);
      if (matches.length === 1) return matches[0].path || theme.repository;
      // Ambiguous name: recover the path from the theme id, which is prefixed
      // with the repository path (`<path>::<kind>:<key>`).
      const prefix = String(theme.id || "").split("::")[0];
      return prefix || theme.repository;
    };

    const byRepo = new Map();
    for (const theme of themes) {
      const key = themeGroupKey(theme);
      if (!byRepo.has(key)) byRepo.set(key, []);
      byRepo.get(key).push(theme);
    }
    const groups = [...byRepo.entries()].map(([repoKey, repoThemes]) => {
      const repoTotals = repositories.find((entry) => entry.path === repoKey)
        || repositories.find((entry) => entry.name === repoKey);
      const displayName = repoTotals?.name || repoThemes[0]?.repository || repoKey;
      // Disambiguate in the heading when the name alone is not unique.
      const sameName = repositories.filter((entry) => entry.name === displayName).length > 1;
      const heading = sameName && repoTotals?.path
        ? `${displayName} <span class="muted">${repoTotals.path}</span>`
        : escapeHtml(displayName);
      const subtotal = repoTotals
        ? `<p class="muted">${formatNumber(repoTotals.commits)} ${pluralize(repoTotals.commits, "commit")} · <span class="add">${formatSigned(repoTotals.insertions, "+")}</span> <span class="del">${formatSigned(repoTotals.deletions, "−")}</span> · ${formatNumber(repoTotals.files)} ${pluralize(repoTotals.files, "file")}</p>`
        : "";
      return `
      <section class="repo-group">
        <h3>${sameName && repoTotals?.path ? `${escapeHtml(displayName)} <span class="muted">${escapeHtml(repoTotals.path)}</span>` : heading}</h3>
        ${subtotal}
        ${repoThemes.map((theme) => renderTheme(theme, narrationByThemeId)).join("")}
      </section>`;
    }).join("");
    return `
  <section aria-labelledby="themes-title">
    <h2 id="themes-title">Themes</h2>
    ${groups || `<p class="empty">No themes in this window.</p>`}
    ${renderSmaller(smaller)}
  </section>`;
  }

  return `
  <section aria-labelledby="themes-title">
    <h2 id="themes-title">Themes</h2>
    ${themes.length > 0 ? themes.map((theme) => renderTheme(theme, narrationByThemeId)).join("") : `<p class="empty">No themes in this window.</p>`}
    ${renderSmaller(smaller)}
  </section>`;
}

function renderSmaller(smaller) {
  const buckets = (smaller || []).filter((bucket) => Number(bucket.commits) > 0);
  if (buckets.length === 0) return "";
  return buckets.map((bucket) => `
    <article class="theme smaller">
      <h3>Smaller changes${bucket.repository ? ` · ${escapeHtml(bucket.repository)}` : ""}</h3>
      <p class="theme-stats">
        <strong>${formatNumber(bucket.commits)}</strong> ${pluralize(bucket.commits, "commit")}
        · <span class="add">${formatSigned(bucket.insertions, "+")}</span> <span class="del">${formatSigned(bucket.deletions, "−")}</span>
        · ${formatNumber(bucket.files_changed)} ${pluralize(bucket.files_changed, "file")}
      </p>
      <p class="muted">Individually below the theme threshold, grouped so nothing is lost.</p>
    </article>`).join("");
}

function renderLimitations(summary, narrationReceipt) {
  const limitations = summary.limitations || [];
  const evidence = summary.evidence || {};
  const evidenceRows = Object.entries(evidence)
    .filter(([, value]) => Number(value) > 0)
    .map(([key, value]) => `<tr><th scope="row">${escapeHtml(key.replaceAll("_", " "))}</th><td class="number">${formatNumber(value)}</td></tr>`)
    .join("");

  if (limitations.length === 0 && !evidenceRows && !narrationReceipt) return "";

  return `
  <section aria-labelledby="limits-title">
    <h2 id="limits-title">What this report could not show</h2>
    ${limitations.length > 0 ? `<ul>${limitations.map((limit) => `<li>${escapeHtml(limit)}</li>`).join("")}</ul>` : ""}
    ${evidenceRows
      ? `<div class="table-wrap"><table><caption>Excluded from the counts</caption><thead><tr><th scope="col">Reason</th><th scope="col">Count</th></tr></thead><tbody>${evidenceRows}</tbody></table></div>`
      : ""}
    ${narrationReceipt || ""}
  </section>`;
}

// The privacy receipt for a run that used --ai (#354). Absent when no provider
// ran — which is the default.
function renderNarrationReceipt(narration) {
  if (!narration) return "";
  if (narration.status && narration.status !== "ok") {
    return `<p class="muted">Narration was not applied: ${escapeHtml(narration.reason || narration.status)}. Every figure above is computed from git regardless.</p>`;
  }
  const receipt = narration.receipt;
  if (!receipt) return "";
  const rows = [
    ["Provider", receipt.provider],
    ["Model", receipt.model],
    ["Bytes sent", receipt.bytes_sent === undefined ? undefined : formatNumber(receipt.bytes_sent)],
    ["Network calls", receipt.network_calls === undefined ? undefined : formatNumber(receipt.network_calls)],
    ["Spend (USD)", receipt.cost_usd === undefined ? undefined : String(receipt.cost_usd)],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (rows.length === 0) return "";
  return `
    <div class="table-wrap">
      <table>
        <caption>Privacy receipt — what left this machine</caption>
        <thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead>
        <tbody>${rows.map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------------------
// The Agentify panel. After the content, never above the fold. It states what
// Agentify does, what is genuinely present on this machine, and ONE next
// command chosen from what actually exists. No countdown, no badge, no
// "upgrade", no beacon.
// ---------------------------------------------------------------------------

function renderAgentifyPanel(environment) {
  const { agentifyOnPath, hasConfig, providers } = environment;

  // Phrased as what the user gets, not as subcommand names.
  const capabilities = [
    "Keep what you decided and why across sessions, so the next one does not relitigate it.",
    "Ask structural questions about the code — who calls this, what breaks if it changes.",
    "See the blast radius of a change before you finish it.",
    "Know which tests a change actually affects, instead of running everything.",
  ];
  if (providers.length > 0) {
    capabilities.push("Send a task to whichever model suits it, and get an independent review from a different vendor.");
  }

  // Exactly one suggested next command, chosen from what is actually available.
  // hasConfig === null means "several repositories were analysed", so no claim
  // about a single repository's setup can honestly be made.
  const configUnknown = hasConfig === null;

  let nextCommand;
  let nextExplanation;
  if (!agentifyOnPath) {
    nextCommand = null;
    nextExplanation = "Agentify is not on this machine's PATH. This report was produced by the command you just ran, and needed nothing installed.";
  } else if (configUnknown) {
    nextCommand = "agentify scan";
    nextExplanation = "Agentify is on your PATH. Run this inside whichever of these repositories you want set up first.";
  } else if (!hasConfig) {
    nextCommand = "agentify scan";
    nextExplanation = "Agentify is on your PATH but this repository is not set up yet. One scan builds the index the structural queries read.";
  } else {
    nextCommand = "agentify ctx load";
    nextExplanation = "This repository is already set up. That command shows what earlier sessions recorded here.";
  }

  const present = [];
  present.push(`<li><code>agentify</code> on PATH: <strong>${agentifyOnPath ? "yes" : "no"}</strong></li>`);
  present.push(configUnknown
    ? `<li><code>.agentify.yaml</code>: <strong>not checked</strong> <span class="muted">(several repositories were analysed)</span></li>`
    : `<li><code>.agentify.yaml</code> in this repository: <strong>${hasConfig ? "yes" : "no"}</strong></li>`);
  present.push(`<li>Provider CLI detected: <strong>${providers.length > 0 ? escapeHtml(providers.join(", ")) : "none"}</strong></li>`);

  return `
  <section class="panel" aria-labelledby="panel-title">
    <h2 id="panel-title">This report needed nothing installed</h2>
    <p>Everything above came from your local git history. Agentify does more when it is set up:</p>
    <ul class="capabilities">${capabilities.map((capability) => `<li>${escapeHtml(capability)}</li>`).join("")}</ul>
    <h3>On this machine, right now</h3>
    <ul class="present">${present.join("")}</ul>
    <p>${escapeHtml(nextExplanation)}</p>
    ${nextCommand ? `<p class="next"><code>${escapeHtml(nextCommand)}</code></p>` : ""}
  </section>`;
}

// ---------------------------------------------------------------------------
// Styles. Inline, theme-aware, and containing every wide element in its own
// horizontally-scrolling wrapper so the page body never scrolls sideways.
// ---------------------------------------------------------------------------

const STYLES = `
    :root {
      color-scheme: dark light;
      --bg: #0d1117; --bg-soft: #161b22; --border: #30363d;
      --text: #e6edf3; --text-dim: #8b949e;
      --accent: #58a6ff; --accent-2: #7ee787; --amber: #d29922;
      --add: #3fb950; --del: #f85149;
      --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #ffffff; --bg-soft: #f6f8fa; --border: #d0d7de;
        --text: #1f2328; --text-dim: #59636e;
        --accent: #0969da; --accent-2: #1a7f37; --amber: #9a6700;
        --add: #1a7f37; --del: #cf222e;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); line-height: 1.6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      overflow-x: hidden; }
    main { max-width: 900px; margin: 0 auto; padding: 0 24px 64px; }
    h1 { font-size: 1.9rem; letter-spacing: -0.02em; margin-bottom: 8px; text-wrap: balance; }
    h2 { font-size: 1.3rem; margin: 40px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
    h3 { font-size: 1.05rem; margin: 24px 0 8px; }
    p, ul, ol { margin-bottom: 10px; }
    ul, ol { padding-left: 20px; }
    code { font-family: var(--mono); font-size: 0.87em; background: var(--bg-soft);
      padding: 1px 5px; border-radius: 4px; border: 1px solid var(--border); }
    .muted { color: var(--text-dim); font-size: 0.9rem; }
    .empty { color: var(--text-dim); font-style: italic; }
    .add { color: var(--add); } .del { color: var(--del); }
    header.hero { padding: 48px 0 8px; }
    .tagline { font-size: 1.05rem; color: var(--text-dim); }
    dl.meta { display: flex; flex-wrap: wrap; gap: 20px; margin: 16px 0; }
    dl.meta dt { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim); }
    dl.meta dd { font-size: 0.95rem; }
    .filters { background: var(--bg-soft); border: 1px solid var(--border); border-radius: 10px; padding: 14px 18px; margin-top: 12px; }
    .filters h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--text-dim); border: 0; margin: 0 0 8px; padding: 0; }
    .filters ul { margin-bottom: 0; }
    .warnings { margin-top: 8px; color: var(--amber); }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; }
    .stat { background: var(--bg-soft); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
    .stat-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim); }
    .stat-value { font-size: 1.45rem; font-weight: 600; letter-spacing: -0.01em; }
    .stat-note { font-size: 0.85rem; color: var(--text-dim); }
    .chart { margin: 12px 0 20px; }
    .chart svg { width: 100%; height: auto; overflow: visible; }
    .chart text { font-size: 12px; fill: var(--text-dim); font-family: var(--mono); }
    .chart .bar-value { fill: var(--text); }
    figcaption { font-size: 0.85rem; color: var(--text-dim); margin-top: 6px; }
    details { margin: 8px 0; }
    summary { cursor: pointer; font-size: 0.9rem; color: var(--text-dim); }
    .table-wrap { overflow-x: auto; max-width: 100%; margin: 10px 0; }
    table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
    caption { text-align: left; font-size: 0.85rem; color: var(--text-dim); padding-bottom: 6px; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); }
    td.number { text-align: right; font-family: var(--mono); }
    .theme { background: var(--bg-soft); border: 1px solid var(--border); border-radius: 10px;
      padding: 16px 18px; margin-bottom: 14px; }
    .theme h3 { margin-top: 0; }
    .theme-stats { font-size: 0.92rem; }
    .iteration { color: var(--amber); font-size: 0.9rem; }
    .tracker { font-size: 0.9rem; margin: 4px 0 8px; }
    .tracker a { color: var(--accent); }
    .chip { display: inline-block; font-size: 0.75rem; padding: 1px 8px; border-radius: 999px;
      border: 1px solid var(--border); background: var(--bg); color: var(--text-dim); margin-left: 4px; }
    .narration { border-left: 3px solid var(--accent); padding-left: 12px; margin: 10px 0; }
    .narration-what { font-size: 1rem; }
    .narration-how { color: var(--text-dim); }
    ul.chips { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
    ul.files { list-style: none; padding: 0; overflow-x: auto; }
    ul.files li { white-space: nowrap; }
    .evidence { font-size: 0.85rem; overflow-x: auto; white-space: nowrap; }
    .repo-group { margin-bottom: 28px; }
    .panel { background: var(--bg-soft); border: 1px solid var(--border); border-radius: 12px;
      padding: 22px 24px; margin-top: 48px; }
    .panel h2 { border: 0; margin-top: 0; }
    .capabilities li, .present li { margin-bottom: 4px; }
    .next code { font-size: 1rem; padding: 6px 10px; display: inline-block; }
    footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border);
      color: var(--text-dim); font-size: 0.85rem; }
`;

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Render the `git-analyze-v1` summary as a self-contained HTML document.
 *
 * @param {object} report - the full report object (its `summary` block is the source of every figure)
 * @param {object} [options] - `{ environment }` (from detectEnvironment; defaults to "nothing detected")
 * @returns {string} a complete HTML document
 */
export function renderGitAnalyzeHtml(report, options = {}) {
  const summary = report?.summary || {};
  const environment = options.environment || { agentifyOnPath: false, hasConfig: false, providers: [] };

  // Narration (#354) is optional and additive: index by theme id so a theme
  // without an entry simply renders deterministically.
  const narration = report.narration || null;
  const narrationByThemeId = new Map();
  for (const entry of narration?.entries || []) {
    for (const themeId of entry.theme_ids || []) {
      if (!narrationByThemeId.has(themeId)) narrationByThemeId.set(themeId, entry);
    }
  }

  const title = summary.scope === "global"
    ? `git analyze · ${(summary.repositories || []).length} repositories`
    : `git analyze · ${(summary.repositories || [])[0]?.name || "repository"}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
${renderHeader(summary, report)}
${renderHeadline(summary)}
${renderDistributions(summary)}
${renderThemes(summary, narrationByThemeId)}
${renderLimitations(summary, renderNarrationReceipt(narration))}
${renderAgentifyPanel(environment)}
<footer>
  <p>Generated ${escapeHtml(formatDate(report.generated_at))} by <code>agentify git analyze</code> — read-only, from local git history.</p>
</footer>
</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Output path resolution.
// ---------------------------------------------------------------------------

// A filesystem-safe slug for a repository name or window label.
function slugify(value) {
  return String(value || "report")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "report";
}

/**
 * The DEFAULT report path, which must never be inside the analysed repository —
 * a report appearing in `git status` fails the epic's constraint. `--output`
 * pointing into a repo is the user's explicit choice and is honoured elsewhere.
 *
 * @param {object} report
 * @param {object} [env] - defaults to process.env
 * @returns {string} an absolute path under the user's cache directory
 */
export function defaultReportPath(report, env = process.env, repositoryPath = null) {
  const summary = report?.summary || {};
  const name = summary.scope === "global"
    ? "global"
    : slugify((summary.repositories || [])[0]?.name || "repository");
  const window = slugify(summary.window?.label || report?.window?.label || "window");

  const homeCache = path.join(os.homedir(), ".cache");
  // XDG_CACHE_HOME is only honoured when it is ABSOLUTE. The spec says a
  // relative value must be ignored, and honouring one here would resolve
  // against the process cwd — i.e. write the report straight into the
  // repository being analysed.
  const configured = typeof env.XDG_CACHE_HOME === "string" ? env.XDG_CACHE_HOME.trim() : "";
  let cacheHome = configured.length > 0 && path.isAbsolute(configured) ? configured : homeCache;

  // Even an absolute XDG_CACHE_HOME can point inside an analysed repository.
  // The DEFAULT path must never do that — a report appearing in `git status`
  // fails the epic's constraint. (An explicit --output inside a repo is the
  // user's own choice and is honoured elsewhere.)
  //
  // A destination is unsafe if it is inside a named analysed repository OR
  // inside ANY git repository (a `.git` ancestor). The `.git`-ancestor check is
  // what makes this robust regardless of how the repo set was filtered: under
  // `--global` the report carries only the SELECTED, deduplicated repositories,
  // so guarding by that list alone would miss a cache inside an unselected repo
  // or a dropped linked worktree. We then fall back through candidates and
  // VALIDATE each fallback (a bare `~/.cache` can itself be inside a repo), so
  // the returned path is never inside a repository.
  const guardPaths = [];
  if (repositoryPath) guardPaths.push(repositoryPath);
  if (summary.scope === "global" || report?.scope === "global") {
    for (const repo of (report?.repositories || [])) {
      if (repo?.path) guardPaths.push(repo.path);
    }
  }
  const unsafe = (dir) => guardPaths.some((repoPath) => isInside(repoPath, dir)) || isInsideGitRepo(dir);
  for (const fallback of [cacheHome, homeCache, os.tmpdir()]) {
    const dir = path.join(fallback, "agentify", "git-analyze");
    if (!unsafe(dir)) {
      cacheHome = fallback;
      break;
    }
    cacheHome = os.tmpdir(); // last resort if every candidate is unsafe
  }

  return path.join(cacheHome, "agentify", "git-analyze", `${name}-${window}.html`);
}

// Whether `target` (or the nearest existing ancestor it resolves to) sits inside
// a git repository — detected by a `.git` entry at any ancestor. Read-only; used
// to keep the default report path out of every repository, not just the ones the
// report happened to list.
function isInsideGitRepo(target) {
  let current = realPath(path.resolve(target));
  for (;;) {
    if (fsSync.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Whether `target` is the same path as, or nested inside, `parent`. Compared on
 * resolved paths with a separator guard so `/repo-backup` is not read as being
 * inside `/repo`.
 */
export function isInside(parent, target) {
  const from = realPath(path.resolve(parent));
  const to = realPath(path.resolve(target));
  if (from === to) return true;
  const relative = path.relative(from, to);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Resolve symlinks so the containment check is not defeated by them. On macOS
// `/tmp` is a symlink to `/private/tmp`, so a repo reported as `/private/tmp/x`
// and a cache path given as `/tmp/x/.cache` are the SAME directory while
// comparing unequal as strings — which would let the default report land inside
// the analysed repository. Walks up to the nearest existing ancestor, because
// the cache directory usually does not exist yet.
function realPath(target) {
  let current = target;
  const suffix = [];
  for (;;) {
    try {
      return path.join(fsSync.realpathSync(current), ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}
