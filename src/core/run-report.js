import path from "node:path";

import { writeJson, writeText } from "./fs.js";
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

function normalizeProviderCommand(value) {
  if (!value) {
    return null;
  }

  const rawArgv = Array.isArray(value.argv) ? value.argv : [];
  const executable = value.executable || rawArgv[0] || null;
  const argc = Number.isFinite(Number(value.argc)) ? Number(value.argc) : rawArgv.length;

  return {
    executable,
    argc,
    argv_redacted: true,
    display: executable
      ? `${executable} [argv redacted; argc=${argc}]`
      : `[argv redacted; argc=${argc}]`,
  };
}

function normalizeExecutionTelemetry(value) {
  if (!value) {
    return null;
  }

  const changedFiles = Array.isArray(value.changed_files) ? value.changed_files : [];
  const changedPaths = Array.isArray(value.changed_paths)
    ? value.changed_paths
    : changedFiles.map((file) => file?.path).filter(Boolean);

  return {
    run_id: value.run_id || `${Date.now()}-execution`,
    started_at: value.started_at || null,
    finished_at: value.finished_at || null,
    duration_ms: Number.isFinite(Number(value.duration_ms)) ? Number(value.duration_ms) : null,
    phase: value.phase || "unknown",
    exit_code: Number.isFinite(Number(value.exit_code)) ? Number(value.exit_code) : null,
    skipped_refresh: Boolean(value.skipped_refresh),
    provider: value.provider || null,
    provider_model: value.provider_model || null,
    provider_command: normalizeProviderCommand(value.provider_command),
    capture: value.capture || {
      mode: "inherit",
      transcript_available: false,
      raw_log_available: false,
      raw_log_path: null,
    },
    changed_files_count: Number.isFinite(Number(value.changed_files_count))
      ? Number(value.changed_files_count)
      : changedPaths.length,
    changed_paths: changedPaths,
    changed_files: changedFiles,
    head_changed: Boolean(value.head_changed),
    session: value.session || null,
  };
}

function renderExecutionOutputBlock(execution) {
  if (!execution) {
    return "";
  }

  const changedPaths = execution.changed_paths?.length
    ? execution.changed_paths.join(", ")
    : "none";
  const command = execution.provider_command?.display || execution.provider_command?.executable || "unknown";
  const capture = execution.capture || {};

  return [
    "[agentify] execution telemetry",
    `[agentify] execution: phase=${execution.phase} exit=${execution.exit_code ?? "unknown"} duration_ms=${execution.duration_ms ?? "unknown"}`,
    `[agentify] execution: provider=${execution.provider || "unknown"} command=${command}`,
    `[agentify] execution: capture=${capture.mode || "inherit"} transcript=${capture.transcript_available ? "yes" : "no"} raw_log=${capture.raw_log_available ? "yes" : "no"}`,
    `[agentify] execution: changed_files=${execution.changed_files_count} head_changed=${execution.head_changed ? "yes" : "no"}`,
    `[agentify] execution: changed_paths=${changedPaths}`,
  ].join("\n");
}

export function renderHtmlReport(summary) {
  const artifactsRaw = summary.artifacts || [];
  const artifacts = artifactsRaw.length > 0
    ? artifactsRaw.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join("")
    : `<li class="empty">no generated artifacts recorded.</li>`;
  const execution = normalizeExecutionTelemetry(summary.execution);
  const executionChangedPaths = execution?.changed_paths?.length
    ? execution.changed_paths.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join("")
    : `<li class="empty">no changed paths recorded.</li>`;
  const executionCommand = execution?.provider_command?.display || execution?.provider_command?.executable || "unknown";
  const executionCapture = execution?.capture || {};
  const executionSection = execution
    ? `
      <div class="metrics" style="grid-template-columns: repeat(4, minmax(0, 1fr));">
        <div class="metric">
          <span class="metric-label">phase</span>
          <span class="metric-value">${escapeHtml(execution.phase)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">duration ms</span>
          <span class="metric-value">${escapeHtml(execution.duration_ms ?? "n/a")}</span>
        </div>
        <div class="metric">
          <span class="metric-label">changed files</span>
          <span class="metric-value">${escapeHtml(execution.changed_files_count)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">transcript</span>
          <span class="metric-value">${executionCapture.transcript_available ? "yes" : "no"}</span>
        </div>
      </div>

      <div class="token-wrap" style="margin-top: 16px;">
        <div class="token-scroll">
          <table class="tokens">
            <tbody>
              <tr><th scope="row">provider</th><td><code>${escapeHtml(execution.provider || "unknown")}</code></td></tr>
              <tr><th scope="row">command</th><td><code>${escapeHtml(executionCommand)}</code></td></tr>
              <tr><th scope="row">capture mode</th><td><code>${escapeHtml(executionCapture.mode || "inherit")}</code></td></tr>
              <tr><th scope="row">raw interactive log</th><td><code>${escapeHtml(executionCapture.raw_log_available ? executionCapture.raw_log_path || "available" : "not available")}</code></td></tr>
              <tr><th scope="row">head changed</th><td><code>${escapeHtml(execution.head_changed ? "yes" : "no")}</code></td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <ul class="artifact-list" style="margin-top: 16px;">${executionChangedPaths}</ul>

      <details class="term-details" style="margin-top: 16px;">
        <summary>raw execution telemetry · JSON</summary>
        <pre class="term-body small">${escapeHtml(JSON.stringify(execution, null, 2))}</pre>
      </details>`
    : `<p class="muted mono-sm">no execution telemetry was recorded for this report.</p>`;

  const tokenUsage = summary.doc?.token_usage || {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    by_module: [],
  };

  const validationStatus = summary.validation
    ? (summary.validation.passed ? "passed" : "failed")
    : "not-run";
  const testStatus = summary.tests?.status || "not-run";

  const validationTone = validationStatus === "passed" ? "passed"
    : validationStatus === "failed" ? "failed" : "skipped";
  const testTone = testStatus === "passed" ? "passed"
    : testStatus === "failed" ? "failed" : "skipped";

  const validationGlyph = validationTone === "passed" ? "✓"
    : validationTone === "failed" ? "✗" : "·";
  const testGlyph = testTone === "passed" ? "✓"
    : testTone === "failed" ? "✗" : "·";

  const validationFailures = summary.validation?.failures?.length
    ? `<ul class="fail-list">${summary.validation.failures.map((item) => {
        const msg = typeof item === "string" ? item : `[${item.category}] ${item.message}`;
        const rem = typeof item === "object" && item.remediation
          ? `<div class="fail-rem">${escapeHtml(item.remediation)}</div>`
          : "";
        return `<li><code>${escapeHtml(msg)}</code>${rem}</li>`;
      }).join("")}</ul>`
    : summary.validation
      ? `<p class="muted mono-sm">no validation failures.</p>`
      : `<p class="muted mono-sm">validation was not run for this command.</p>`;

  const testStderr = summary.tests?.stderr || "";
  const testStdout = summary.tests?.stdout || "";
  const testCombined = [testStdout, testStderr].filter(Boolean).join("\n");
  const testTruncationMessages = [];
  if (summary.tests?.stdout_truncated) {
    testTruncationMessages.push(`stdout captured ${summary.tests.output_max_bytes} of ${summary.tests.stdout_bytes} bytes`);
  }
  if (summary.tests?.stderr_truncated) {
    testTruncationMessages.push(`stderr captured ${summary.tests.output_max_bytes} of ${summary.tests.stderr_bytes} bytes`);
  }
  const testOutputNotice = testTruncationMessages.length > 0
    ? `<p class="muted mono-sm">test output was truncated: ${escapeHtml(testTruncationMessages.join("; "))}. Configure <code>tests.outputMaxKb</code> to adjust the limit.</p>`
    : "";
  const testOutput = summary.tests
    ? `${testOutputNotice}<details class="term-details"><summary>test output · stdout/stderr</summary><pre class="term-body small">${escapeHtml(testCombined)}</pre></details>`
    : `<p class="muted mono-sm">no test run was recorded.</p>`;

  const rerunUpdateCommand = sanitizeForJsString("agentify up --provider local");
  const rerunTestsCommand = sanitizeForJsString(summary.tests?.command || "npm test");

  const testSummaryText = summary.tests?.status === "passed"
    ? "All configured test cases passed."
    : summary.tests?.status === "failed"
      ? "Some test cases failed. Use the rerun button and inspect the output below."
      : "Tests were skipped because no runnable test script was detected.";

  const validationCount = summary.validation?.failures?.length || 0;
  const artifactCount = artifactsRaw.length || 0;
  const moduleCount = summary.doc?.modules_processed ?? 0;
  const docsWritten = summary.doc?.docs_written ?? 0;
  const headersRefreshed = summary.doc?.files_with_headers ?? 0;
  const totalTokens = tokenUsage.total_tokens ?? 0;
  const inputTokens = tokenUsage.input_tokens ?? 0;
  const outputTokens = tokenUsage.output_tokens ?? 0;
  const measuredModules = (tokenUsage.by_module || []).length;

  const commandDisplay = summary.command || "unknown";
  const executionPhase = execution?.phase || "not-run";
  const executionChangedCount = execution?.changed_files_count ?? 0;
  const executionTranscriptText = execution?.capture?.transcript_available ? "yes" : "no";

  const healthHeadline = validationStatus === "passed" && testStatus === "passed"
    ? "repository checks completed successfully."
    : validationStatus === "failed" || testStatus === "failed"
      ? "one or more health checks need attention."
      : "some health checks were skipped.";

  const moduleRows = (tokenUsage.by_module || []).length > 0
    ? tokenUsage.by_module.map((m) => `
        <tr>
          <td><code>${escapeHtml(m.module_id || "module")}</code></td>
          <td class="num">${escapeHtml(m.input_tokens ?? 0)}</td>
          <td class="num">${escapeHtml(m.output_tokens ?? 0)}</td>
          <td class="num total">${escapeHtml(m.total_tokens ?? 0)}</td>
        </tr>
      `).join("")
    : `<tr><td colspan="4" class="muted mono-sm">no per-module token usage was recorded.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>agentify · run report</title>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&display=swap");

    :root {
      color-scheme: light dark;
      --bg: #f7f7f4;
      --bg-elev: #ffffff;
      --surface: #ffffff;
      --panel: #0d0f12;
      --panel-text: #d7dbe0;
      --panel-dim: #8892a0;
      --panel-line: #1c2026;
      --text: #0f1012;
      --muted: #5a5d64;
      --faint: #8b8e95;
      --line: #e3e1d9;
      --line-strong: #cecbbf;
      --accent: #2f6feb;
      --accent-soft: rgba(47, 111, 235, 0.08);
      --prompt: #137a53;
      --warn: #a65b10;
      --danger: #b4391f;
      --dot: rgba(15, 16, 18, 0.08);
      --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      --sans: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      --step-1: 0.78rem;
      --step-2: 0.88rem;
      --step-3: 0.98rem;
      --step-4: 1.15rem;
      --step-5: 1.45rem;
      --step-6: 2.1rem;
      --step-7: clamp(2.2rem, 5vw, 3.2rem);
      --radius-md: 6px;
      --radius-sm: 4px;
      --max: 1120px;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b0c0e;
        --bg-elev: #111316;
        --surface: #111316;
        --panel: #07080a;
        --panel-text: #d7dbe0;
        --panel-dim: #7a828f;
        --panel-line: #171a1e;
        --text: #e8e8e4;
        --muted: #9ea1a8;
        --faint: #72757c;
        --line: #1d1f23;
        --line-strong: #2a2d33;
        --accent: #7aa7ff;
        --accent-soft: rgba(122, 167, 255, 0.12);
        --prompt: #6ad2a8;
        --warn: #e2a552;
        --danger: #ef6c50;
        --dot: rgba(230, 232, 236, 0.06);
      }
    }

    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--sans);
      font-size: var(--step-3);
      line-height: 1.6;
      color: var(--text);
      background-color: var(--bg);
      background-image: radial-gradient(circle, var(--dot) 1px, transparent 1px);
      background-size: 24px 24px;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    a { color: var(--accent); text-decoration: none; }
    a:hover, a:focus-visible { text-decoration: underline; text-underline-offset: 3px; }

    code, pre, .mono {
      font-family: var(--mono);
      font-feature-settings: "ss01", "cv02", "cv11";
      font-variant-numeric: tabular-nums;
    }

    :focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-radius: 2px;
    }

    /* ---------- topbar ---------- */
    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      background: color-mix(in srgb, var(--bg) 82%, transparent);
      border-bottom: 1px solid var(--line);
      backdrop-filter: saturate(160%) blur(8px);
    }
    .topbar-inner {
      max-width: var(--max);
      margin: 0 auto;
      padding: 10px 24px;
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: var(--mono);
      font-size: var(--step-1);
      color: var(--muted);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--text);
      font-weight: 600;
    }
    .brand-mark {
      display: inline-block;
      width: 10px;
      height: 10px;
      background: var(--accent);
      transform: rotate(45deg);
    }
    .brand-path { color: var(--faint); font-weight: 400; }
    .topbar .sep { color: var(--line-strong); }
    .topbar .stat-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--faint);
      margin-right: 6px;
      vertical-align: 1px;
    }
    .topbar .stat-dot.passed { background: var(--prompt); }
    .topbar .stat-dot.failed { background: var(--danger); }
    .topbar .stat-dot.skipped { background: var(--warn); }

    main {
      max-width: var(--max);
      margin: 0 auto;
      padding: 32px 24px 64px;
    }
    section { margin-top: 48px; }
    section:first-of-type { margin-top: 0; }

    h1, h2, h3 { margin: 0; font-weight: 600; }
    h1 {
      font-family: var(--mono);
      font-size: var(--step-7);
      line-height: 1.05;
      letter-spacing: -0.02em;
      margin-bottom: 12px;
      text-wrap: balance;
    }
    h2 {
      font-family: var(--mono);
      font-size: var(--step-5);
      line-height: 1.15;
      text-transform: lowercase;
      letter-spacing: -0.01em;
    }
    h3 {
      font-family: var(--mono);
      font-size: var(--step-2);
      text-transform: lowercase;
      letter-spacing: 0.02em;
    }
    p { margin: 0 0 12px; }
    p:last-child { margin-bottom: 0; }
    .muted { color: var(--muted); }
    .mono-sm { font-family: var(--mono); font-size: var(--step-1); }

    .section-head {
      margin-bottom: 20px;
      display: grid;
      gap: 6px;
    }
    .section-mark {
      font-family: var(--mono);
      font-size: var(--step-1);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .section-mark .caret { color: var(--accent); margin-right: 6px; }
    .section-mark .num { color: var(--faint); }
    .section-mark .slash { color: var(--line-strong); margin: 0 6px; }
    .dek {
      color: var(--muted);
      max-width: 68ch;
      font-size: var(--step-3);
    }

    /* ---------- hero ---------- */
    .hero {
      padding: 32px 0 0;
      display: grid;
      gap: 24px;
    }
    .hero-tag {
      font-family: var(--mono);
      font-size: var(--step-1);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }
    .hero-tag .dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--prompt);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--prompt) 18%, transparent);
    }
    .hero-tag.failed .dot { background: var(--danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 18%, transparent); }
    .hero-tag.skipped .dot { background: var(--warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 18%, transparent); }

    .hero h1 { max-width: 24ch; }
    .hero-lede {
      color: var(--muted);
      font-size: var(--step-4);
      line-height: 1.55;
      max-width: 64ch;
    }

    .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      font-family: var(--mono);
      font-size: var(--step-1);
    }
    .chip {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      padding: 4px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: var(--bg-elev);
    }
    .chip .label { color: var(--faint); }
    .chip strong { color: var(--text); font-weight: 500; }
    .chip .glyph { font-weight: 600; }
    .chip.passed .glyph { color: var(--prompt); }
    .chip.failed .glyph { color: var(--danger); }
    .chip.skipped .glyph { color: var(--warn); }

    /* ---------- terminal panel ---------- */
    .term {
      background: var(--panel);
      color: var(--panel-text);
      border: 1px solid var(--panel-line);
      border-radius: var(--radius-md);
      overflow: hidden;
    }
    .term-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--panel-line);
      font-family: var(--mono);
      font-size: 0.74rem;
      color: var(--panel-dim);
      letter-spacing: 0.04em;
    }
    .dots {
      display: inline-flex;
      gap: 6px;
    }
    .dots span {
      display: inline-block;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #2a2d33;
    }
    .term-title { margin-left: 4px; }
    .term-title em { color: var(--panel-text); font-style: normal; }
    .term-body {
      margin: 0;
      padding: 16px 18px;
      font-family: var(--mono);
      font-size: var(--step-2);
      line-height: 1.7;
      overflow-x: auto;
      white-space: pre;
      color: var(--panel-text);
    }
    .term-body.small { font-size: var(--step-1); line-height: 1.6; }
    .term-body .p { color: var(--prompt); }
    .term-body .c { color: #6b7280; }
    .term-body .k { color: #e2a552; }
    .term-body .s { color: #98c379; }
    .term-body .m { color: #7aa7ff; }
    .term-body .r { color: #ef6c50; }
    .term-body .w { color: #e2a552; }
    .term-body .ok { color: #6ad2a8; }
    .term-body .dim { color: var(--panel-dim); }

    /* ---------- button row ---------- */
    .btn-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    button.btn {
      appearance: none;
      cursor: pointer;
      font-family: var(--mono);
      font-size: var(--step-1);
      padding: 8px 12px;
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      background: var(--bg-elev);
      color: var(--text);
      transition: background-color 120ms, border-color 120ms, color 120ms;
    }
    button.btn:hover,
    button.btn:focus-visible {
      background: var(--accent-soft);
      border-color: var(--accent);
      color: var(--accent);
      outline: none;
    }
    button.btn::before { content: "[ "; color: var(--faint); }
    button.btn::after { content: " ]"; color: var(--faint); }
    button.btn:hover::before,
    button.btn:hover::after,
    button.btn:focus-visible::before,
    button.btn:focus-visible::after { color: var(--accent); }
    .copy-feedback {
      min-height: 1.2rem;
      color: var(--muted);
      font-family: var(--mono);
      font-size: var(--step-1);
      margin-top: 10px;
    }

    /* ---------- metric rail ---------- */
    .metrics {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      overflow: hidden;
      background: var(--bg-elev);
    }
    .metric {
      padding: 18px 20px;
      border-right: 1px solid var(--line);
      display: grid;
      gap: 6px;
    }
    .metric:last-child { border-right: 0; }
    .metric-label {
      font-family: var(--mono);
      font-size: var(--step-1);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--faint);
    }
    .metric-value {
      font-family: var(--mono);
      font-size: var(--step-6);
      line-height: 1;
      color: var(--text);
      font-weight: 500;
      letter-spacing: -0.02em;
    }
    .metric-value.warn { color: var(--warn); }
    .metric-value.bad { color: var(--danger); }

    /* ---------- health ---------- */
    .health {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      overflow: hidden;
      background: var(--bg-elev);
    }
    .health-col { padding: 20px 22px; }
    .health-col + .health-col { border-left: 1px solid var(--line); }
    .health-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }
    .health-head h3 { color: var(--text); }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(--mono);
      font-size: var(--step-1);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 4px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--bg);
    }
    .status-pill .glyph { font-weight: 700; }
    .status-pill.passed { color: var(--prompt); border-color: color-mix(in srgb, var(--prompt) 35%, var(--line)); }
    .status-pill.failed { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, var(--line)); }
    .status-pill.skipped { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, var(--line)); }
    .health-col .btn-row { margin-top: 14px; }
    .health-col p { color: var(--muted); }
    .fail-list {
      list-style: none;
      padding: 0;
      margin: 12px 0 0;
      display: grid;
      gap: 8px;
      font-family: var(--mono);
      font-size: var(--step-1);
    }
    .fail-list li {
      padding: 10px 12px;
      border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--line));
      border-left: 3px solid var(--danger);
      border-radius: var(--radius-sm);
      background: var(--bg);
      color: var(--text);
    }
    .fail-list li::before {
      content: "✗ ";
      color: var(--danger);
      font-weight: 700;
    }
    .fail-list code {
      background: transparent;
      border: 0;
      padding: 0;
      color: inherit;
    }
    .fail-rem {
      margin-top: 4px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: var(--step-1);
    }
    .term-details {
      margin-top: 16px;
      border: 1px solid var(--panel-line);
      border-radius: var(--radius-md);
      overflow: hidden;
      background: var(--panel);
    }
    .term-details summary {
      list-style: none;
      cursor: pointer;
      padding: 10px 14px;
      font-family: var(--mono);
      font-size: var(--step-1);
      color: var(--panel-dim);
      letter-spacing: 0.04em;
      background: var(--panel);
      border-bottom: 1px solid transparent;
    }
    .term-details summary::-webkit-details-marker { display: none; }
    .term-details summary::before {
      content: "+";
      color: var(--accent);
      margin-right: 8px;
      font-weight: 700;
    }
    .term-details[open] summary { border-bottom-color: var(--panel-line); }
    .term-details[open] summary::before { content: "−"; }

    /* ---------- tokens table ---------- */
    .token-wrap {
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      overflow: hidden;
      background: var(--bg-elev);
    }
    .token-scroll { overflow-x: auto; }
    table.tokens {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--mono);
      font-size: var(--step-2);
      min-width: 520px;
    }
    table.tokens th {
      text-align: left;
      font-size: var(--step-1);
      font-weight: 500;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--faint);
      padding: 10px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--bg);
    }
    table.tokens td {
      padding: 10px 14px;
      vertical-align: top;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
    }
    table.tokens tr:last-child td { border-bottom: 0; }
    table.tokens td.num { text-align: right; color: var(--text); }
    table.tokens td.num.total { color: var(--accent); font-weight: 500; }
    table.tokens td code {
      background: transparent;
      border: 0;
      padding: 0;
      color: var(--text);
    }

    /* ---------- artifacts ---------- */
    .artifact-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: 2px;
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      overflow: hidden;
      background: var(--bg-elev);
    }
    .artifact-list li {
      padding: 10px 14px;
      border-bottom: 1px solid var(--line);
      font-family: var(--mono);
      font-size: var(--step-2);
      color: var(--muted);
    }
    .artifact-list li:last-child { border-bottom: 0; }
    .artifact-list li::before {
      content: "→ ";
      color: var(--accent);
      font-weight: 600;
    }
    .artifact-list li.empty::before { content: "· "; color: var(--faint); }
    .artifact-list code {
      background: transparent;
      border: 0;
      padding: 0;
      color: var(--text);
    }

    /* inline code */
    code.inline, :not(pre):not(.term-body) > code {
      font-family: var(--mono);
      font-size: 0.86em;
      padding: 1px 6px;
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      background: var(--bg-elev);
      color: var(--text);
    }

    /* ---------- raw ---------- */
    .raw-note {
      margin-top: 12px;
      color: var(--faint);
      font-family: var(--mono);
      font-size: var(--step-1);
    }

    /* ---------- footer ---------- */
    .foot {
      margin-top: 48px;
      padding-top: 18px;
      border-top: 1px solid var(--line);
      font-family: var(--mono);
      font-size: var(--step-1);
      color: var(--faint);
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }
    .foot span::before { content: "$ "; color: var(--accent); }

    /* ---------- responsive ---------- */
    @media (max-width: 980px) {
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric { border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
      .metric:nth-child(2n) { border-right: 0; }
      .metric:nth-last-child(-n+1) { border-bottom: 0; }
      .health { grid-template-columns: 1fr; }
      .health-col + .health-col { border-left: 0; border-top: 1px solid var(--line); }
    }
    @media (max-width: 640px) {
      main { padding: 24px 16px 48px; }
      section { margin-top: 40px; }
      .topbar-inner { padding: 10px 16px; overflow-x: auto; scrollbar-width: none; white-space: nowrap; }
      .topbar-inner::-webkit-scrollbar { display: none; }
      .metrics { grid-template-columns: 1fr; }
      .metric { border-right: 0; }
      .metric:last-child { border-bottom: 0; }
      :root { --step-7: 1.9rem; }
      .hero { padding-top: 20px; gap: 20px; }
      .hero-lede { font-size: var(--step-3); }
      .term-body { font-size: var(--step-1); padding: 12px 14px; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
  </style>
</head>
<body>
  <header class="topbar" role="banner">
    <div class="topbar-inner">
      <span class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <span>agentify</span>
        <span class="brand-path" aria-hidden="true">/report</span>
      </span>
      <span class="sep" aria-hidden="true">·</span>
      <span><code>${escapeHtml(commandDisplay)}</code></span>
      <span class="sep" aria-hidden="true">·</span>
      <span><span class="stat-dot ${escapeHtml(validationTone)}" aria-hidden="true"></span>validation: ${escapeHtml(validationStatus)}</span>
      <span class="sep" aria-hidden="true">·</span>
      <span><span class="stat-dot ${escapeHtml(testTone)}" aria-hidden="true"></span>tests: ${escapeHtml(testStatus)}</span>
    </div>
  </header>

  <main>
    <!-- ===== HERO ===== -->
    <section class="hero" id="top" aria-labelledby="hero-title">
      <span class="hero-tag ${escapeHtml(validationTone === "passed" && testTone === "passed" ? "passed" : validationTone === "failed" || testTone === "failed" ? "failed" : "skipped")}">
        <span class="dot" aria-hidden="true"></span>run report · ${escapeHtml(commandDisplay)}
      </span>
      <h1 id="hero-title">${escapeHtml(healthHeadline)}</h1>
      <p class="hero-lede">
        the file records what agentify changed, how repository health checks ended, and how much model usage the run consumed.
        every number is preserved so the page works as both a handoff document and an audit trail.
      </p>

      <div class="term" role="group" aria-label="run summary">
        <div class="term-head">
          <span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>
          <span class="term-title">agentify@report <em>—</em> zsh</span>
        </div>
<pre class="term-body"><span class="p">$</span> agentify ${escapeHtml(commandDisplay)}
<span class="c"># post-run summary</span>

<span class="dim">→</span> validation  <span class="${validationTone === "passed" ? "ok" : validationTone === "failed" ? "r" : "w"}">${escapeHtml(validationStatus)}</span>   <span class="c">#</span> ${escapeHtml(validationCount)} failure${validationCount === 1 ? "" : "s"} recorded
<span class="dim">→</span> tests       <span class="${testTone === "passed" ? "ok" : testTone === "failed" ? "r" : "w"}">${escapeHtml(testStatus)}</span>   <span class="c">#</span> <span class="s">${escapeHtml(summary.tests?.command || "not-run")}</span>
<span class="dim">→</span> modules     <span class="m">${escapeHtml(moduleCount)}</span>        <span class="c">#</span> ${escapeHtml(docsWritten)} docs · ${escapeHtml(headersRefreshed)} headers
<span class="dim">→</span> execution   <span class="m">${escapeHtml(executionPhase)}</span> <span class="c">#</span> changed: ${escapeHtml(executionChangedCount)} · transcript: ${escapeHtml(executionTranscriptText)}
<span class="dim">→</span> tokens      <span class="m">${escapeHtml(totalTokens)}</span>        <span class="c">#</span> in: ${escapeHtml(inputTokens)} · out: ${escapeHtml(outputTokens)} · modules: ${escapeHtml(measuredModules)}
<span class="dim">→</span> artifacts   <span class="m">${escapeHtml(artifactCount)}</span>        <span class="c">#</span> files produced this run

<span class="p">$</span> <span class="dim">ready.</span></pre>
      </div>

      <div class="chip-row" aria-label="quick status">
        <span class="chip ${escapeHtml(validationTone)}"><span class="label">validation</span><span class="glyph" aria-hidden="true">${validationGlyph}</span><strong>${escapeHtml(validationStatus)}</strong></span>
        <span class="chip ${escapeHtml(testTone)}"><span class="label">tests</span><span class="glyph" aria-hidden="true">${testGlyph}</span><strong>${escapeHtml(testStatus)}</strong></span>
        <span class="chip"><span class="label">phase</span><strong>${escapeHtml(executionPhase)}</strong></span>
        <span class="chip"><span class="label">changed</span><strong>${escapeHtml(executionChangedCount)}</strong></span>
        <span class="chip"><span class="label">tokens</span><strong>${escapeHtml(totalTokens)}</strong></span>
        <span class="chip"><span class="label">artifacts</span><strong>${escapeHtml(artifactCount)}</strong></span>
      </div>

      <div class="btn-row">
        <button type="button" class="btn" onclick="copyCommand(\`${rerunUpdateCommand}\`)">copy rerun agentify command</button>
        <button type="button" class="btn" onclick="copyCommand(\`${rerunTestsCommand}\`)">Copy rerun tests command</button>
      </div>
      <p id="copy-feedback" class="copy-feedback" aria-live="polite"></p>
    </section>

    <!-- ===== OVERVIEW ===== -->
    <section id="overview" aria-labelledby="overview-title">
      <header class="section-head">
        <span class="section-mark"><span class="caret">▶</span><span class="num">01</span><span class="slash">/</span>overview</span>
        <h2 id="overview-title">output footprint</h2>
        <p class="dek">counts of what this run produced — kept first so the rest of the page only needs skimming to confirm.</p>
      </header>

      <div class="metrics">
        <div class="metric">
          <span class="metric-label">modules processed</span>
          <span class="metric-value">${escapeHtml(moduleCount)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">docs written</span>
          <span class="metric-value">${escapeHtml(docsWritten)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">headers refreshed</span>
          <span class="metric-value">${escapeHtml(headersRefreshed)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">validation issues</span>
          <span class="metric-value${validationCount > 0 ? " bad" : ""}">${escapeHtml(validationCount)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Total tokens</span>
          <span class="metric-value">${escapeHtml(totalTokens)}</span>
        </div>
      </div>
    </section>

    <!-- ===== EXECUTION ===== -->
    <section id="execution" aria-labelledby="execution-title">
      <header class="section-head">
        <span class="section-mark"><span class="caret">▶</span><span class="num">02</span><span class="slash">/</span>execution</span>
        <h2 id="execution-title">execution telemetry</h2>
        <p class="dek">provider command behavior, capture availability, and changed-file scope for benchmarking this run.</p>
      </header>
      ${executionSection}
    </section>

    <!-- ===== HEALTH ===== -->
    <section id="health" aria-labelledby="health-title">
      <header class="section-head">
        <span class="section-mark"><span class="caret">▶</span><span class="num">03</span><span class="slash">/</span>health</span>
        <h2 id="health-title">validation &amp; tests</h2>
        <p class="dek">trust or reject the run from this block alone — unsafe writes, freshness drift, and test status sit side by side.</p>
      </header>

      <div class="health">
        <div class="health-col">
          <div class="health-head">
            <h3>validation</h3>
            <span class="status-pill ${escapeHtml(validationTone)}"><span class="glyph" aria-hidden="true">${validationGlyph}</span>${escapeHtml(validationStatus)}</span>
          </div>
          <p class="mono-sm">unsafe writes, freshness issues, and invalid generated state are surfaced here.</p>
          ${validationFailures}
        </div>

        <div class="health-col">
          <div class="health-head">
            <h3>tests</h3>
            <span class="status-pill ${escapeHtml(testTone)}"><span class="glyph" aria-hidden="true">${testGlyph}</span>${escapeHtml(testStatus)}</span>
          </div>
          <p class="mono-sm">${escapeHtml(testSummaryText)}</p>
          <div class="btn-row">
            <button type="button" class="btn" onclick="copyCommand(\`${rerunTestsCommand}\`)">Copy rerun tests command</button>
            <button type="button" class="btn" onclick="copyCommand(\`${rerunUpdateCommand}\`)">copy rerun agentify command</button>
          </div>
          ${testOutput}
        </div>
      </div>
    </section>

    <!-- ===== TOKENS ===== -->
    <section id="tokens" aria-labelledby="tokens-title">
      <header class="section-head">
        <span class="section-mark"><span class="caret">▶</span><span class="num">04</span><span class="slash">/</span>tokens</span>
        <h2 id="tokens-title">model usage</h2>
        <p class="dek">totals first, per-module breakdown second — enough to audit cost and activity without opening raw JSON.</p>
      </header>

      <div class="metrics" style="grid-template-columns: repeat(4, minmax(0, 1fr));">
        <div class="metric">
          <span class="metric-label">input tokens</span>
          <span class="metric-value">${escapeHtml(inputTokens)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">output tokens</span>
          <span class="metric-value">${escapeHtml(outputTokens)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Total tokens</span>
          <span class="metric-value">${escapeHtml(totalTokens)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">measured modules</span>
          <span class="metric-value">${escapeHtml(measuredModules)}</span>
        </div>
      </div>

      <div class="token-wrap" style="margin-top: 16px;">
        <div class="token-scroll">
          <table class="tokens">
            <thead>
              <tr>
                <th scope="col">module</th>
                <th scope="col" style="text-align:right;">input</th>
                <th scope="col" style="text-align:right;">output</th>
                <th scope="col" style="text-align:right;">total</th>
              </tr>
            </thead>
            <tbody>${moduleRows}</tbody>
          </table>
        </div>
      </div>

      <details class="term-details" style="margin-top: 16px;">
        <summary>raw per-module token usage · JSON</summary>
        <pre class="term-body small">${escapeHtml(JSON.stringify(tokenUsage.by_module || [], null, 2))}</pre>
      </details>
    </section>

    <!-- ===== ARTIFACTS ===== -->
    <section id="artifacts" aria-labelledby="artifacts-title">
      <header class="section-head">
        <span class="section-mark"><span class="caret">▶</span><span class="num">05</span><span class="slash">/</span>artifacts</span>
        <h2 id="artifacts-title">generated files</h2>
        <p class="dek">every path agentify recorded for this run. useful as a handoff checklist.</p>
      </header>
      <ul class="artifact-list">${artifacts}</ul>
    </section>

    <!-- ===== RAW ===== -->
    <section id="raw" aria-labelledby="raw-title">
      <header class="section-head">
        <span class="section-mark"><span class="caret">▶</span><span class="num">06</span><span class="slash">/</span>raw</span>
        <h2 id="raw-title">machine summary</h2>
        <p class="dek">the complete structured payload — preserved for debugging, diffing, or downstream tooling.</p>
      </header>
      <div class="term">
        <div class="term-head">
          <span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>
          <span class="term-title"><em>cat</em> summary.json</span>
        </div>
        <pre class="term-body small">${escapeHtml(JSON.stringify(summary, null, 2))}</pre>
      </div>
      <p class="raw-note">this block preserves the exact shape consumed by tooling — do not reformat when copying.</p>
    </section>

    <footer class="foot">
      <span>agentify · run report · ${escapeHtml(commandDisplay)}</span>
      <span>${escapeHtml(artifactCount)} artifact${artifactCount === 1 ? "" : "s"} · ${escapeHtml(totalTokens)} tokens</span>
    </footer>
  </main>

  <script>
    async function copyCommand(command) {
      const feedback = document.getElementById("copy-feedback");
      try {
        await navigator.clipboard.writeText(command);
        if (feedback) {
          feedback.textContent = "copied to clipboard: " + command;
        }
      } catch {
        if (feedback) {
          feedback.textContent = "clipboard access failed. command: " + command;
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
  const loader = ui.createStatusLoader();
  const summary = {
    command: "",
    artifacts: [],
    scan: null,
    doc: null,
    validation: null,
    tests: null,
    execution: null,
  };

  function record(text) {
    events.push(text.endsWith("\n") ? text : `${text}\n`);
  }

  function progressText(scope, percent, message) {
    return `${scope}: ${percent}%${message ? ` ${message}` : ""}`;
  }

  function updateStatus(message) {
    if (loader.enabled) {
      loader.update(message);
      return;
    }
    ui.step(message);
  }

  function finishStatus(kind, message) {
    if (!loader.enabled) {
      return false;
    }
    if (kind === "error") {
      loader.error(message);
    } else if (kind === "warn") {
      loader.warn(message);
    } else {
      loader.success(message);
    }
    return true;
  }

  function classifyLogMilestone(message) {
    if (/^tests: passed\b/.test(message)) {
      return { kind: "success", message: "tests passed" };
    }
    if (/^tests: failed\b/.test(message)) {
      return { kind: "error", message: "tests failed" };
    }
    if (/^tests: (skipped|unsupported)\b/.test(message)) {
      return { kind: "warn", message: message.replace(":", "") };
    }
    return null;
  }

  function classifyProgressMilestone(scope, percent, message) {
    const text = String(message || "").trim();
    const command = summary.command || scope;
    if (scope !== command || percent <= 0) {
      return null;
    }
    if (/failed/i.test(text)) {
      return { kind: "error", message: text };
    }
    if (/skipped/i.test(text)) {
      return { kind: "warn", message: text };
    }
    if (/\b(complete|completed|passed)\b/i.test(text)) {
      return { kind: "success", message: text };
    }
    return null;
  }

  return {
    log(message) {
      const line = `[agentify] ${message}`;
      const milestone = classifyLogMilestone(message);
      if (!milestone || !finishStatus(milestone.kind, milestone.message)) {
        updateStatus(message);
      }
      record(line);
    },
    percent(scope, percent, message) {
      const normalizedPercent = Math.max(0, Math.min(100, Math.round(percent)));
      const line = `[agentify] ${scope}: ${normalizedPercent}%${message ? ` ${message}` : ""}`;
      const milestone = classifyProgressMilestone(scope, normalizedPercent, message);
      if (!milestone || !finishStatus(milestone.kind, milestone.message)) {
        updateStatus(progressText(scope, normalizedPercent, message));
      }
      record(line);
    },
    json(value) {
      loader.clear();
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
    setExecution(result) {
      loader.clear();
      summary.execution = normalizeExecutionTelemetry(result);
      if (summary.execution) {
        const telemetryPath = `.agents/runs/${summary.execution.run_id}-execution-telemetry.json`;
        summary.artifacts = Array.from(new Set([...summary.artifacts, telemetryPath]));
        record(renderExecutionOutputBlock(summary.execution));
      }
    },
    async finalize() {
      const outputPath = path.join(root, "output.txt");
      const htmlPath = path.join(root, "agentify-report.html");
      let telemetryJsonPath = null;
      if (summary.execution) {
        telemetryJsonPath = path.join(root, ".agents", "runs", `${summary.execution.run_id}-execution-telemetry.json`);
        await writeJson(telemetryJsonPath, summary.execution);
      }
      await writeText(outputPath, events.join(""));
      await writeText(htmlPath, renderHtmlReport(summary));

      loader.clear();
      ui.box("Run Complete", [
        ui.label("Artifacts", String(summary.artifacts.length)),
        ui.label("Modules", String(summary.doc?.modules_processed ?? 0)),
        ui.label("Execution", summary.execution?.phase || "not run"),
        ui.label(
          "Validation",
          summary.validation
            ? (summary.validation.passed ? ui.green("passed") : ui.red("failed"))
            : ui.dim("not run")
        ),
        ui.label("Tests", summary.tests?.status || "not run"),
        ui.label("Report", ui.dim(htmlPath)),
      ]);

      return { outputPath, htmlPath, telemetryJsonPath };
    },
    clear() {
      loader.clear();
    },
  };
}
