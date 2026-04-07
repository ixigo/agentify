import path from "node:path";

import { writeText } from "./fs.js";
import * as ui from "./ui.js";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sanitizeForJsString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

export function renderHtmlReport(summary) {
  const artifacts = summary.artifacts.length > 0
    ? summary.artifacts.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join("")
    : "<li>No generated artifacts recorded.</li>";
  const tokenUsage = summary.doc?.token_usage || {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    by_module: [],
  };
  const validationStatus = summary.validation ? (summary.validation.passed ? "passed" : "failed") : "not-run";
  const validationFailures = summary.validation?.failures?.length
    ? `<ul>${summary.validation.failures.map((item) => {
        const msg = typeof item === "string" ? item : `[${item.category}] ${item.message}`;
        return `<li>${escapeHtml(msg)}</li>`;
      }).join("")}</ul>`
    : summary.validation ? "<p>No validation failures.</p>" : "<p>Validation was not run for this command.</p>";
  const testOutput = summary.tests
    ? `<details><summary>Test output</summary><pre>${escapeHtml([summary.tests.stdout, summary.tests.stderr].filter(Boolean).join("\n"))}</pre></details>`
    : "<p>No test run was recorded.</p>";
  const rerunUpdateCommand = sanitizeForJsString("agentify up --provider local");
  const rerunTestsCommand = sanitizeForJsString(summary.tests?.command || "npm test");
  const testStatus = summary.tests?.status || "not-run";
  const testSummaryText = summary.tests?.status === "passed"
    ? "All configured test cases passed."
    : summary.tests?.status === "failed"
      ? "Some test cases failed. Use the rerun button and inspect the output below."
      : "Tests were skipped because no runnable test script was detected.";
  const validationCount = summary.validation?.failures?.length || 0;
  const artifactCount = summary.artifacts.length || 0;
  const moduleCount = summary.doc?.modules_processed ?? 0;
  const docsWritten = summary.doc?.docs_written ?? 0;
  const headersRefreshed = summary.doc?.files_with_headers ?? 0;
  const totalTokens = tokenUsage.total_tokens ?? 0;
  const validationStatusClass = validationStatus === "passed" ? "passed" : validationStatus === "failed" ? "failed" : "skipped";
  const testStatusClass = testStatus === "passed" ? "passed" : testStatus === "failed" ? "failed" : "skipped";
  const validationTone = validationStatus === "passed" ? "passed" : validationStatus === "failed" ? "failed" : "skipped";
  const testTone = testStatus === "passed" ? "passed" : testStatus === "failed" ? "failed" : "skipped";
  const healthHeadline = validationStatus === "passed" && testStatus === "passed"
    ? "Repository checks completed successfully."
    : validationStatus === "failed" || testStatus === "failed"
      ? "One or more health checks need attention."
      : "Some health checks were skipped.";
  const healthCopy = validationStatus === "passed" && testStatus === "passed"
    ? "The generated outputs, validation results, and test status are aligned for this run."
    : validationStatus === "failed" || testStatus === "failed"
      ? "Review the failed checks, rerun the relevant commands, and regenerate this report."
      : "Run the skipped checks before treating this report as a trustworthy snapshot.";
  const moduleUsageCards = (tokenUsage.by_module || []).length > 0
    ? tokenUsage.by_module.map((moduleSummary) => `
        <article class="module-card">
          <div class="module-card-header">
            <p class="card-label">Module</p>
            <p class="module-id">${escapeHtml(moduleSummary.module_id || "module")}</p>
          </div>
          <p class="module-total">${escapeHtml(moduleSummary.total_tokens ?? 0)}</p>
          <p class="muted">total tokens consumed</p>
          <dl class="module-breakdown">
            <div><dt>Input</dt><dd>${escapeHtml(moduleSummary.input_tokens ?? 0)}</dd></div>
            <div><dt>Output</dt><dd>${escapeHtml(moduleSummary.output_tokens ?? 0)}</dd></div>
          </dl>
        </article>
      `).join("")
    : "<p class=\"muted\">No per-module token usage was recorded.</p>";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agentify Run Report</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #fff8f4;
      --bg-soft: #fff2eb;
      --surface: rgba(255, 255, 255, 0.92);
      --surface-strong: #ffffff;
      --surface-code: #1c2430;
      --ink: #1f2430;
      --muted: #616a76;
      --line: rgba(31, 36, 48, 0.1);
      --line-strong: rgba(31, 36, 48, 0.18);
      --brand: #f15a24;
      --brand-strong: #d84b17;
      --brand-soft: rgba(241, 90, 36, 0.1);
      --brand-glow: rgba(241, 90, 36, 0.18);
      --good: #0f8c6b;
      --good-bg: rgba(15, 140, 107, 0.12);
      --warn: #a65b10;
      --warn-bg: rgba(166, 91, 16, 0.12);
      --bad: #c44426;
      --bad-bg: rgba(196, 68, 38, 0.12);
      --shadow: 0 20px 55px rgba(82, 47, 34, 0.08);
      --radius-xl: 28px;
      --radius-lg: 24px;
      --radius-md: 18px;
      --radius-sm: 12px;
    }
    * { box-sizing: border-box; }
    html {
      scroll-behavior: smooth;
    }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Aptos", "Segoe UI Variable", "Helvetica Neue", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(241, 90, 36, 0.12), transparent 26%),
        radial-gradient(circle at top right, rgba(241, 90, 36, 0.08), transparent 24%),
        linear-gradient(180deg, #fffdfb 0%, var(--bg) 100%);
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.35), transparent 22%),
        linear-gradient(120deg, rgba(241, 90, 36, 0.04), transparent 34%);
    }
    main {
      position: relative;
      width: min(1120px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 24px 0 48px;
      display: grid;
      gap: 20px;
    }
    section {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      padding: 24px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
      overflow-x: hidden;
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 {
      font-size: clamp(2.5rem, 6vw, 4.7rem);
      line-height: 0.95;
      letter-spacing: -0.055em;
      text-wrap: balance;
      margin-bottom: 16px;
      max-width: 11ch;
    }
    h2 {
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      color: var(--muted);
      margin-bottom: 14px;
    }
    p, li, summary, button {
      font-size: 1rem;
      line-height: 1.65;
    }
    a {
      color: inherit;
    }
    .hero {
      padding: clamp(24px, 4vw, 36px);
      border-radius: var(--radius-xl);
      background:
        linear-gradient(140deg, rgba(255, 255, 255, 0.98), rgba(255, 245, 239, 0.96)),
        linear-gradient(180deg, rgba(241, 90, 36, 0.06), transparent 55%);
      position: relative;
    }
    .hero::before {
      content: "";
      position: absolute;
      inset: 0 0 auto 0;
      height: 6px;
      background: linear-gradient(90deg, var(--brand), #ff8354);
    }
    .hero-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.45fr) minmax(280px, 0.85fr);
      gap: 20px;
      align-items: start;
    }
    .hero-copy,
    .hero-summary {
      position: relative;
      z-index: 1;
    }
    .brand-row,
    .meta-row,
    .action-row,
    .summary-stack,
    .panel-head,
    .section-head {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .brand-row {
      align-items: center;
      margin-bottom: 18px;
    }
    .brand-mark {
      width: 16px;
      height: 16px;
      border-radius: 5px;
      background: linear-gradient(135deg, var(--brand), #ff8b5d);
      box-shadow: 0 0 0 8px rgba(241, 90, 36, 0.1);
      flex: 0 0 auto;
    }
    .brand-label,
    .meta-pill,
    .section-note,
    .card-label {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.8);
      white-space: normal;
      color: var(--muted);
      font-size: 0.82rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .brand-label {
      background: var(--brand-soft);
      border-color: rgba(241, 90, 36, 0.14);
      color: var(--brand-strong);
    }
    .meta-row {
      margin: 0 0 22px;
    }
    .meta-pill strong {
      color: var(--ink);
      font-size: 0.84rem;
      letter-spacing: 0;
      text-transform: none;
    }
    .hero-summary,
    .panel,
    .metric-card,
    .module-card,
    .artifact-list li,
    .failure-list li,
    .detail-block {
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: var(--surface-strong);
      min-width: 0;
    }
    .hero-summary {
      padding: 20px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(255, 242, 235, 0.92));
      align-self: stretch;
    }
    .hero-summary::after {
      content: "";
      position: absolute;
      inset: auto 20px 20px 20px;
      height: 1px;
      background: linear-gradient(90deg, rgba(241, 90, 36, 0.16), transparent);
    }
    .muted { color: var(--muted); }
    .lede {
      font-size: 1.08rem;
      max-width: 60ch;
      color: var(--muted);
    }
    .eyebrow {
      margin-bottom: 8px;
      color: var(--brand-strong);
      text-transform: uppercase;
      letter-spacing: 0.16em;
      font-size: 0.76rem;
      font-weight: 700;
    }
    .summary-title {
      font-size: 1.45rem;
      line-height: 1.2;
      letter-spacing: -0.03em;
      margin-bottom: 8px;
    }
    .summary-copy {
      margin-bottom: 18px;
      color: var(--muted);
    }
    .summary-item {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 0;
      border-top: 1px solid var(--line);
    }
    .summary-item:first-of-type {
      border-top: 0;
      padding-top: 0;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border-radius: 999px;
      padding: 8px 12px;
      font-weight: 700;
      text-transform: capitalize;
    }
    .status::before {
      content: "";
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: currentColor;
      flex: 0 0 auto;
    }
    .status-passed { color: var(--good); }
    .status-failed { color: var(--bad); }
    .status-skipped { color: var(--warn); }
    .tone-passed { background: var(--good-bg); }
    .tone-failed { background: var(--bad-bg); }
    .tone-skipped { background: var(--warn-bg); }
    .section-head {
      align-items: end;
      justify-content: space-between;
      margin-bottom: 18px;
    }
    .section-copy,
    .panel-copy {
      color: var(--muted);
      margin-bottom: 0;
      max-width: 62ch;
    }
    .section-note {
      background: rgba(255, 255, 255, 0.72);
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 14px;
    }
    .metric-card {
      padding: 18px;
      position: relative;
      overflow: hidden;
    }
    .metric-card::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: 4px;
      background: linear-gradient(180deg, var(--brand), transparent);
    }
    .metric-value {
      font-size: clamp(1.9rem, 3vw, 2.5rem);
      font-weight: 700;
      margin: 0 0 4px;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.04em;
    }
    .metric-label {
      color: var(--muted);
      margin: 0;
      font-size: 0.9rem;
    }
    ul {
      margin: 0;
      padding-left: 20px;
    }
    li {
      overflow-wrap: anywhere;
    }
    .artifact-list,
    .failure-list {
      display: grid;
      gap: 12px;
      padding-left: 0;
      list-style: none;
    }
    .artifact-list li,
    .failure-list li {
      padding: 14px 16px;
    }
    .artifact-list code,
    .failure-list code,
    pre code {
      word-break: break-word;
    }
    code, pre, .module-total, .module-id, .metric-value {
      font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-variant-numeric: tabular-nums;
    }
    pre {
      overflow: auto;
      background: var(--surface-code);
      color: #eaf2ff;
      padding: 18px;
      border-radius: 14px;
      font-size: 0.9rem;
      line-height: 1.5;
      max-width: 100%;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    button {
      appearance: none;
      border: 1px solid transparent;
      border-radius: 999px;
      padding: 12px 16px;
      background: var(--brand);
      color: white;
      cursor: pointer;
      font: inherit;
      touch-action: manipulation;
      transition: background-color 180ms ease, transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
    }
    button:hover {
      background: var(--brand-strong);
      transform: translateY(-1px);
      box-shadow: 0 14px 28px rgba(241, 90, 36, 0.18);
    }
    button:focus-visible,
    summary:focus-visible {
      outline: 3px solid rgba(241, 90, 36, 0.22);
      outline-offset: 3px;
    }
    .secondary {
      background: rgba(255, 255, 255, 0.86);
      border-color: rgba(241, 90, 36, 0.18);
      color: var(--brand-strong);
    }
    .secondary:hover {
      background: var(--brand-soft);
    }
    .health-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
    .panel {
      padding: 18px;
    }
    .panel-head {
      align-items: start;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .panel-head p:last-child,
    .section-head p:last-child {
      margin-bottom: 0;
    }
    .module-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
      margin-top: 18px;
    }
    .module-card {
      padding: 16px;
    }
    .module-card-header {
      display: grid;
      gap: 4px;
      margin-bottom: 14px;
    }
    .module-id {
      margin: 0;
      font-size: 0.92rem;
      word-break: break-word;
    }
    .module-total {
      font-size: 1.6rem;
      font-weight: 700;
      margin: 0 0 6px;
    }
    .module-breakdown {
      display: grid;
      gap: 8px;
      margin: 12px 0 0;
    }
    .module-breakdown div {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding-top: 8px;
      border-top: 1px solid var(--line);
    }
    .module-breakdown dt,
    .module-breakdown dd {
      margin: 0;
      color: var(--muted);
    }
    details summary {
      cursor: pointer;
      font-weight: 700;
    }
    .detail-block {
      padding: 16px 18px;
      margin-top: 18px;
      background: rgba(255, 255, 255, 0.76);
    }
    .detail-block pre {
      margin-top: 14px;
    }
    .empty-state {
      color: var(--muted);
    }
    .copy-feedback {
      min-height: 1.2rem;
      color: var(--muted);
      margin-top: 12px;
      font-size: 0.9rem;
    }
    small {
      display: block;
      margin-top: 8px;
      color: var(--muted);
    }
    @media (max-width: 980px) {
      .hero-grid,
      .health-grid,
      .metric-grid {
        grid-template-columns: 1fr 1fr;
      }
      .hero-grid {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 720px) {
      main {
        width: min(100vw - 18px, 1120px);
        padding-top: 16px;
      }
      section,
      .hero {
        padding: 20px;
      }
      .metric-grid,
      .health-grid {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 560px) {
      body {
        -webkit-text-size-adjust: 100%;
      }
      main {
        width: calc(100vw - 12px);
        gap: 12px;
        padding-bottom: 32px;
      }
      section,
      .hero {
        padding: 16px;
        border-radius: 18px;
      }
      .metric-grid,
      .module-grid {
        grid-template-columns: 1fr;
      }
      .action-row,
      .meta-row,
      .section-head {
        display: grid;
      }
      button {
        width: 100%;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      html {
        scroll-behavior: auto;
      }
      *,
      *::before,
      *::after {
        transition: none !important;
        animation: none !important;
      }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="hero-grid">
        <div class="hero-copy">
          <p class="eyebrow">Agentify Run Report</p>
          <div class="brand-row">
            <span class="brand-mark" aria-hidden="true"></span>
            <span class="brand-label">Ixigo-inspired minimal interface</span>
          </div>
          <div class="meta-row">
            <p class="meta-pill">Command <strong>${escapeHtml(summary.command || "unknown")}</strong></p>
            <p class="meta-pill">Validation <strong>${escapeHtml(validationStatus)}</strong></p>
            <p class="meta-pill">Tests <strong>${escapeHtml(testStatus)}</strong></p>
          </div>
          <h1>Readable execution evidence for a single Agentify run.</h1>
          <p class="lede">This file records what Agentify changed, how the repository health checks ended, and how much model usage the run consumed. The layout prioritizes scan speed, readable spacing, and a lightweight audit trail.</p>
          <div class="action-row">
            <button type="button" onclick="copyCommand(\`${rerunUpdateCommand}\`)">Copy rerun Agentify command</button>
            <button type="button" class="secondary" onclick="copyCommand(\`${rerunTestsCommand}\`)">Copy rerun tests command</button>
          </div>
          <p id="copy-feedback" class="copy-feedback" aria-live="polite"></p>
        </div>
        <aside class="hero-summary">
          <p class="eyebrow">Health Snapshot</p>
          <p class="summary-title">${healthHeadline}</p>
          <p class="summary-copy">${healthCopy}</p>
          <div class="summary-stack">
            <div class="summary-item">
              <span>Validation</span>
              <span class="status status-${escapeHtml(validationStatusClass)} tone-${escapeHtml(validationTone)}">${escapeHtml(validationStatus)}</span>
            </div>
            <div class="summary-item">
              <span>Tests</span>
              <span class="status status-${escapeHtml(testStatusClass)} tone-${escapeHtml(testTone)}">${escapeHtml(testStatus)}</span>
            </div>
            <div class="summary-item">
              <span>Total tokens</span>
              <strong>${escapeHtml(totalTokens)}</strong>
            </div>
          </div>
        </aside>
      </div>
    </section>

    <section>
      <div class="section-head">
        <div>
          <h2>Run Overview</h2>
          <p class="section-copy">A compact summary of the output footprint for this run. Counts stay visible first so the report remains easy to scan before you read the detailed sections.</p>
        </div>
        <p class="section-note">${escapeHtml(artifactCount)} artifact${artifactCount === 1 ? "" : "s"} recorded</p>
      </div>
      <div class="metric-grid">
        <article class="metric-card">
          <p class="metric-value">${escapeHtml(moduleCount)}</p>
          <p class="metric-label">Modules processed</p>
        </article>
        <article class="metric-card">
          <p class="metric-value">${escapeHtml(docsWritten)}</p>
          <p class="metric-label">Docs written</p>
        </article>
        <article class="metric-card">
          <p class="metric-value">${escapeHtml(headersRefreshed)}</p>
          <p class="metric-label">Headers refreshed</p>
        </article>
        <article class="metric-card">
          <p class="metric-value">${escapeHtml(validationCount)}</p>
          <p class="metric-label">Validation issues</p>
        </article>
        <article class="metric-card">
          <p class="metric-value">${escapeHtml(totalTokens)}</p>
          <p class="metric-label">Total tokens</p>
        </article>
      </div>
    </section>

    <section>
      <div class="section-head">
        <div>
          <h2>Generated Artifacts</h2>
          <p class="section-copy">Every file listed here was recorded as part of the run output, which makes the report useful as both a handoff document and a quick operator checklist.</p>
        </div>
      </div>
      <ul class="artifact-list">${artifacts}</ul>
    </section>

    <section>
      <div class="section-head">
        <div>
          <h2>Health Checks</h2>
          <p class="section-copy">Validation and tests stay next to each other so the run can be trusted or rejected without hunting through the rest of the page.</p>
        </div>
      </div>
      <div class="health-grid">
        <article class="panel">
          <div class="panel-head">
            <div>
              <p class="card-label">Validation</p>
              <p class="panel-copy">Unsafe writes, freshness issues, and invalid generated state are surfaced here.</p>
            </div>
            <p class="status status-${escapeHtml(validationStatusClass)} tone-${escapeHtml(validationTone)}">${escapeHtml(validationStatus)}</p>
          </div>
          ${summary.validation?.failures?.length ? `<ul class="failure-list">${summary.validation.failures.map((item) => {
            const msg = typeof item === "string" ? item : `[${item.category}] ${item.message}`;
            const rem = typeof item === "object" && item.remediation ? `<br><small>${escapeHtml(item.remediation)}</small>` : "";
            return `<li><code>${escapeHtml(msg)}</code>${rem}</li>`;
          }).join("")}</ul>` : validationFailures}
        </article>

        <article class="panel">
          <div class="panel-head">
            <div>
              <p class="card-label">Tests</p>
              <p class="panel-copy">${escapeHtml(testSummaryText)}</p>
            </div>
            <p class="status status-${escapeHtml(testStatusClass)} tone-${escapeHtml(testTone)}">${escapeHtml(testStatus)}</p>
          </div>
          <div class="action-row">
            <button type="button" onclick="copyCommand(\`${rerunTestsCommand}\`)">Copy rerun tests command</button>
            <button type="button" class="secondary" onclick="copyCommand(\`${rerunUpdateCommand}\`)">Copy rerun Agentify command</button>
          </div>
          <div class="detail-block">
            ${testOutput}
          </div>
        </article>
      </div>
    </section>

    <section>
      <div class="section-head">
        <div>
          <h2>Token Usage</h2>
          <p class="section-copy">Model consumption is separated into totals and module-level breakdowns so you can audit cost and activity without reading raw JSON first.</p>
        </div>
      </div>
      <div class="metric-grid">
        <article class="metric-card">
          <p class="metric-value">${escapeHtml(tokenUsage.input_tokens ?? 0)}</p>
          <p class="metric-label">Input tokens</p>
        </article>
        <article class="metric-card">
          <p class="metric-value">${escapeHtml(tokenUsage.output_tokens ?? 0)}</p>
          <p class="metric-label">Output tokens</p>
        </article>
        <article class="metric-card">
          <p class="metric-value">${escapeHtml(tokenUsage.total_tokens ?? 0)}</p>
          <p class="metric-label">Total tokens</p>
        </article>
        <article class="metric-card">
          <p class="metric-value">${escapeHtml((tokenUsage.by_module || []).length)}</p>
          <p class="metric-label">Measured modules</p>
        </article>
        <article class="metric-card">
          <p class="metric-value">${escapeHtml(artifactCount)}</p>
          <p class="metric-label">Recorded artifacts</p>
        </article>
      </div>
      <div class="module-grid">${moduleUsageCards}</div>
      <details class="detail-block">
        <summary>Raw per-module token usage</summary>
        <pre>${escapeHtml(JSON.stringify(tokenUsage.by_module || [], null, 2))}</pre>
      </details>
    </section>

    <section>
      <div class="section-head">
        <div>
          <h2>Machine Summary</h2>
          <p class="section-copy">The complete structured payload is preserved here for debugging, diffing, or downstream tooling.</p>
        </div>
      </div>
      <pre>${escapeHtml(JSON.stringify(summary, null, 2))}</pre>
    </section>
  </main>
  <script>
    async function copyCommand(command) {
      const feedback = document.getElementById("copy-feedback");
      try {
        await navigator.clipboard.writeText(command);
        if (feedback) {
          feedback.textContent = "Copied command to clipboard: " + command;
        }
      } catch {
        if (feedback) {
          feedback.textContent = "Clipboard access failed. Command: " + command;
        }
      }
    }
  </script>
</body>
</html>
`;
}

export function createRunReporter(root) {
  const events = [];
  const summary = {
    command: "",
    artifacts: [],
    scan: null,
    doc: null,
    validation: null,
    tests: null,
  };

  function record(text) {
    events.push(text.endsWith("\n") ? text : `${text}\n`);
  }

  return {
    log(message) {
      const line = `[agentify] ${message}`;
      ui.step(message);
      record(line);
    },
    percent(scope, percent, message) {
      const normalizedPercent = Math.max(0, Math.min(100, Math.round(percent)));
      const line = `[agentify] ${scope}: ${normalizedPercent}%${message ? ` ${message}` : ""}`;
      ui.step(`${scope}: ${normalizedPercent}%${message ? ` ${message}` : ""}`);
      record(line);
    },
    json(value) {
      const text = JSON.stringify(value, null, 2);
      console.log(text);
      record(text);
    },
    appendSection(title, text) {
      if (!text) {
        return;
      }
      const block = `${title}\n${text.endsWith("\n") ? text : `${text}\n`}`;
      record(block);
    },
    setCommand(command) {
      summary.command = command;
    },
    setScan(result) {
      summary.scan = result;
      summary.artifacts = Array.from(new Set([...summary.artifacts, ...(result.wrote || [])]));
    },
    setDoc(result) {
      summary.doc = result;
      summary.artifacts = Array.from(new Set([...summary.artifacts, ...(result.wrote || [])]));
    },
    setValidation(result) {
      summary.validation = result;
    },
    setTests(result) {
      summary.tests = result;
    },
    async finalize() {
      const outputPath = path.join(root, "output.txt");
      const htmlPath = path.join(root, "agentify-report.html");
      await writeText(outputPath, events.join(""));
      await writeText(htmlPath, renderHtmlReport(summary));

      ui.box("Run Complete", [
        ui.label("Artifacts", String(summary.artifacts.length)),
        ui.label("Modules", String(summary.doc?.modules_processed ?? 0)),
        ui.label(
          "Validation",
          summary.validation
            ? (summary.validation.passed ? ui.green("passed") : ui.red("failed"))
            : ui.dim("not run")
        ),
        ui.label("Tests", summary.tests?.status || "not run"),
        ui.label("Report", ui.dim(htmlPath)),
      ]);

      return { outputPath, htmlPath };
    },
  };
}
