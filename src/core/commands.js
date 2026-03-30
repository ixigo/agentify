import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { detectModules, detectStacks } from "./detect.js";
import { ensureDir, exists, readJson, relative, walkFiles, writeJson, writeText } from "./fs.js";
import { getHeadCommit } from "./git.js";
import { buildDependencyGraph, rankKeyFiles } from "./graph.js";
import { updateFileHeader } from "./headers.js";
import { createProvider } from "./provider.js";
import { validateRepo } from "./validate.js";
import { checkSchema, migrateIndex, SCHEMA_VERSIONS } from "./schema.js";
import { acquireLock } from "./lock.js";
import * as ui from "./ui.js";

function stableHash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function toSlug(value) {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

function isFileInModule(filePath, moduleRoot) {
  if (moduleRoot === ".") {
    return true;
  }
  return filePath === moduleRoot || filePath.startsWith(`${moduleRoot}/`);
}

function getAllowedExtensions(stack) {
  switch (stack) {
    case "python":
      return [".py"];
    case "dotnet":
      return [".cs"];
    case "java":
      return [".java"];
    case "kotlin":
      return [".kt", ".kts"];
    case "swift":
      return [".swift"];
    case "ts":
    default:
      return [".ts", ".tsx", ".js", ".jsx"];
  }
}

function selectEntrypoints(files, stack) {
  const patterns =
    stack === "python"
      ? [/__main__\.py$/, /main\.py$/]
      : stack === "dotnet"
        ? [/Program\.cs$/]
        : stack === "java"
          ? [/Main\.java$/, /Application\.java$/, /MainActivity\.java$/]
          : stack === "kotlin"
            ? [/Main\.kt$/, /Application\.kt$/, /MainActivity\.kt$/]
            : stack === "swift"
              ? [/main\.swift$/, /AppDelegate\.swift$/, /SceneDelegate\.swift$/, /.+App\.swift$/]
        : [/src\/index\.(ts|tsx|js|jsx)$/, /src\/main\.(ts|tsx|js|jsx)$/, /app\.(ts|tsx|js|jsx)$/, /server\.(ts|tsx|js|jsx)$/];

  return files.filter((file) => patterns.some((pattern) => pattern.test(file))).slice(0, 10);
}

function createProgressReporter() {
  return {
    log(message) {
      ui.step(message);
    },
    percent(scope, percent, message) {
      const normalizedPercent = Math.max(0, Math.min(100, Math.round(percent)));
      ui.step(`${scope}: ${normalizedPercent}%${message ? ` ${message}` : ""}`);
    }
  };
}

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

function createRunReporter(root) {
  const events = [];
  const summary = {
    command: "",
    artifacts: [],
    scan: null,
    doc: null,
    validation: null,
    tests: null
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
        ui.label("Validation", summary.validation?.passed ? ui.green("passed") : ui.red("failed")),
        ui.label("Tests", summary.tests?.status || "not run"),
        ui.label("Report", ui.dim(htmlPath)),
      ]);

      return { outputPath, htmlPath };
    }
  };
}

async function runChildCommand(command, args, { cwd } = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];

  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });
    child.on("error", reject);
    child.on("close", resolve);
  });

  return {
    code: Number(code ?? 1),
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join("")
  };
}

export async function detectTestCommand(root) {
  const packageJsonPath = path.join(root, "package.json");
  if (!(await exists(packageJsonPath))) {
    return null;
  }
  try {
    const packageJson = await readJson(packageJsonPath);
    if (packageJson?.scripts?.test) {
      const packageManager = typeof packageJson.packageManager === "string"
        ? packageJson.packageManager.split("@")[0]
        : null;
      if (packageManager === "pnpm") {
        return { command: "pnpm", args: ["test"] };
      }
      if (packageManager === "yarn") {
        return { command: "yarn", args: ["test"] };
      }
      if (packageManager === "bun") {
        return { command: "bun", args: ["test"] };
      }
      if (await exists(path.join(root, "pnpm-lock.yaml"))) {
        return { command: "pnpm", args: ["test"] };
      }
      if (await exists(path.join(root, "yarn.lock"))) {
        return { command: "yarn", args: ["test"] };
      }
      if (await exists(path.join(root, "bun.lockb")) || await exists(path.join(root, "bun.lock"))) {
        return { command: "bun", args: ["test"] };
      }
      return { command: "npm", args: ["test"] };
    }
  } catch {
    return null;
  }
  return null;
}

async function runProjectTests(root, reporter) {
  const testCommand = await detectTestCommand(root);
  if (!testCommand) {
    const result = {
      status: "skipped",
      passed: false,
      command: null,
      stdout: "",
      stderr: "",
      exit_code: null
    };
    reporter.log("tests: skipped because no package.json test script was found");
    reporter.setTests(result);
    return result;
  }

  reporter.log(`tests: running ${testCommand.command} ${testCommand.args.join(" ")}`);
  const outcome = await runChildCommand(testCommand.command, testCommand.args, { cwd: root });
  if (outcome.stdout) {
    reporter.appendSection("[tests stdout]", outcome.stdout);
  }
  if (outcome.stderr) {
    reporter.appendSection("[tests stderr]", outcome.stderr);
  }

  const result = {
    status: outcome.code === 0 ? "passed" : "failed",
    passed: outcome.code === 0,
    command: `${testCommand.command} ${testCommand.args.join(" ")}`,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exit_code: outcome.code
  };
  reporter.log(`tests: ${result.status}`);
  reporter.setTests(result);
  return result;
}

function renderHtmlReport(summary) {
  const artifacts = summary.artifacts.length > 0
    ? summary.artifacts.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join("")
    : "<li>No generated artifacts recorded.</li>";
  const tokenUsage = summary.doc?.token_usage || {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    by_module: []
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
  const rerunUpdateCommand = sanitizeForJsString("agentify update --provider local");
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
  const validationTone = validationStatus === "passed" ? "passed" : validationStatus === "failed" ? "failed" : "skipped";
  const testTone = testStatus === "passed" ? "passed" : testStatus === "failed" ? "failed" : "skipped";
  const moduleUsageCards = (tokenUsage.by_module || []).length > 0
    ? tokenUsage.by_module.map((moduleSummary) => `
        <article class="module-card">
          <div class="module-card-header">
            <p class="eyebrow">Module</p>
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
      --bg: oklch(0.97 0.008 235);
      --bg-grid: rgba(28, 47, 74, 0.07);
      --surface: rgba(248, 250, 252, 0.88);
      --surface-strong: rgba(241, 245, 249, 0.97);
      --surface-code: #0d1726;
      --ink: oklch(0.23 0.03 252);
      --muted: oklch(0.5 0.025 245);
      --line: rgba(36, 58, 89, 0.14);
      --line-strong: rgba(36, 58, 89, 0.3);
      --accent: oklch(0.45 0.11 240);
      --accent-soft: rgba(46, 104, 181, 0.12);
      --good: oklch(0.52 0.12 170);
      --good-bg: rgba(16, 137, 107, 0.1);
      --warn: oklch(0.66 0.14 78);
      --warn-bg: rgba(181, 123, 19, 0.11);
      --bad: oklch(0.56 0.2 28);
      --bad-bg: rgba(201, 72, 43, 0.1);
      --shadow: 0 18px 48px rgba(14, 25, 42, 0.08);
      --radius-xl: 30px;
      --radius-lg: 22px;
      --radius-md: 16px;
      --radius-sm: 12px;
    }
    * { box-sizing: border-box; }
    html {
      scroll-behavior: smooth;
    }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Aptos", "Segoe UI", "Helvetica Neue", sans-serif;
      color: var(--ink);
      background:
        linear-gradient(var(--bg-grid) 1px, transparent 1px),
        linear-gradient(90deg, var(--bg-grid) 1px, transparent 1px),
        radial-gradient(circle at top left, rgba(59, 130, 246, 0.08), transparent 26%),
        linear-gradient(180deg, #f8fbff 0%, var(--bg) 100%);
      background-size: 24px 24px, 24px 24px, auto, auto;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(130deg, rgba(59, 130, 246, 0.08), transparent 30%),
        linear-gradient(330deg, rgba(14, 165, 233, 0.05), transparent 28%);
      opacity: 0.9;
    }
    main {
      position: relative;
      width: min(1320px, calc(100vw - 28px));
      margin: 0 auto;
      padding: 20px 0 48px;
      display: grid;
      gap: 18px;
    }
    section {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      padding: 24px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
      overflow-x: hidden;
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 {
      font-size: clamp(2.7rem, 6vw, 5.4rem);
      line-height: 0.92;
      letter-spacing: -0.06em;
      text-wrap: balance;
      margin-bottom: 16px;
    }
    h2 {
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      color: var(--muted);
      margin-bottom: 14px;
    }
    p, li, summary, button {
      font-size: 0.98rem;
      line-height: 1.6;
    }
    a {
      color: inherit;
    }
    .page-shell {
      display: grid;
      grid-template-columns: minmax(0, 1.55fr) minmax(290px, 0.85fr);
      gap: 18px;
      align-items: start;
    }
    .hero {
      padding: clamp(26px, 4vw, 40px);
      border-radius: var(--radius-xl);
      background:
        linear-gradient(180deg, rgba(249, 252, 255, 0.96), rgba(239, 245, 252, 0.9)),
        linear-gradient(135deg, rgba(59, 130, 246, 0.08), transparent 45%);
      position: relative;
      overflow: hidden;
    }
    .hero::after {
      content: "";
      position: absolute;
      inset: auto -8% -22% auto;
      width: clamp(180px, 32vw, 360px);
      aspect-ratio: 1;
      border-radius: 50%;
      border: 1px solid rgba(46, 104, 181, 0.14);
      box-shadow:
        0 0 0 28px rgba(46, 104, 181, 0.04),
        0 0 0 56px rgba(46, 104, 181, 0.025);
    }
    .hero-copy,
    .hero-top,
    .hero-actions,
    .summary-rail,
    .rail-block {
      position: relative;
      z-index: 1;
    }
    .hero-top {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 18px;
    }
    .label {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.7);
      white-space: normal;
      color: var(--muted);
      font-size: 0.82rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .label strong {
      color: var(--ink);
      font-size: 0.84rem;
      letter-spacing: 0;
      text-transform: none;
    }
    .hero-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 24px;
    }
    .summary-rail {
      display: grid;
      gap: 14px;
      position: sticky;
      top: 18px;
    }
    .rail-block,
    .panel,
    .metric,
    .timeline-item,
    .module-card {
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: var(--surface-strong);
      min-width: 0;
    }
    .rail-block {
      padding: 18px;
    }
    .muted { color: var(--muted); }
    .lede {
      font-size: 1.08rem;
      max-width: 60ch;
      color: color-mix(in oklab, var(--ink) 85%, white);
    }
    .eyebrow {
      margin-bottom: 8px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.16em;
      font-size: 0.76rem;
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
    .status-passed { color: var(--accent); }
    .status-failed { color: var(--bad); }
    .status-skipped { color: var(--warn); }
    .tone-passed { background: var(--good-bg); }
    .tone-failed { background: var(--bad-bg); }
    .tone-skipped { background: var(--warn-bg); }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .metric {
      padding: 16px;
      position: relative;
      overflow: hidden;
    }
    .metric::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: 4px;
      background: linear-gradient(180deg, var(--accent), transparent);
    }
    .value {
      font-size: clamp(1.8rem, 3vw, 2.5rem);
      font-weight: 700;
      margin: 0 0 4px;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.04em;
    }
    .value-label {
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
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.68);
      padding: 14px 16px;
    }
    .artifact-list code,
    .failure-list code,
    pre code {
      word-break: break-word;
    }
    code, pre, .module-total, .module-id, .terminal-note {
      font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-variant-numeric: tabular-nums;
    }
    pre {
      overflow: auto;
      background: var(--surface-code);
      color: #dbeafe;
      padding: 18px;
      border-radius: 14px;
      font-size: 0.9rem;
      line-height: 1.5;
      max-width: 100%;
      border: 1px solid rgba(148, 163, 184, 0.16);
    }
    button {
      appearance: none;
      border: 1px solid transparent;
      border-radius: 999px;
      padding: 12px 16px;
      background: var(--ink);
      color: white;
      cursor: pointer;
      font: inherit;
      touch-action: manipulation;
      transition: background-color 160ms ease, transform 160ms ease, border-color 160ms ease;
    }
    button:hover {
      background: color-mix(in oklab, var(--ink) 88%, white);
      transform: translateY(-1px);
    }
    button:focus-visible,
    summary:focus-visible {
      outline: 3px solid rgba(46, 104, 181, 0.25);
      outline-offset: 3px;
    }
    .secondary {
      background: transparent;
      border-color: var(--line-strong);
      color: var(--ink);
    }
    .secondary:hover {
      background: rgba(15, 23, 42, 0.04);
    }
    .stack {
      display: grid;
      gap: 18px;
    }
    .intro-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(260px, 0.9fr);
      gap: 16px;
    }
    .panel {
      padding: 18px;
    }
    .panel p:last-child,
    .rail-block p:last-child {
      margin-bottom: 0;
    }
    .timeline {
      display: grid;
      gap: 12px;
      margin-top: 16px;
    }
    .timeline-item {
      padding: 16px;
      position: relative;
    }
    .timeline-item::before {
      content: "";
      position: absolute;
      inset: 16px auto 16px 16px;
      width: 2px;
      background: linear-gradient(180deg, var(--accent), rgba(46, 104, 181, 0.08));
    }
    .timeline-item > * {
      position: relative;
      margin-left: 18px;
    }
    .section-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: end;
      margin-bottom: 16px;
    }
    .section-head p:last-child {
      margin-bottom: 0;
    }
    .stat-strip {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .module-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
      margin-top: 14px;
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
    .action-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 16px;
    }
    .kicker,
    .section-kicker {
      margin-bottom: 12px;
      color: var(--accent);
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-size: 0.8rem;
    }
    .rule {
      height: 1px;
      background: linear-gradient(90deg, var(--line-strong), transparent);
      margin: 18px 0;
    }
    .terminal-note {
      color: var(--muted);
      font-size: 0.84rem;
      margin-top: 10px;
    }
    .copy-feedback {
      min-height: 1.2rem;
      color: var(--muted);
      margin-top: 12px;
      font-size: 0.9rem;
    }
    @media (max-width: 980px) {
      .page-shell,
      .intro-grid {
        grid-template-columns: 1fr;
      }
      .summary-rail {
        position: static;
      }
    }
    @media (max-width: 860px) {
      main {
        width: min(100vw - 16px, 1180px);
        padding-top: 16px;
      }
      section,
      .hero {
        padding: 20px;
      }
      .grid,
      .stat-strip {
        grid-template-columns: 1fr 1fr;
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
      .grid,
      .stat-strip,
      .module-grid {
        grid-template-columns: 1fr;
      }
      .action-row,
      .hero-actions {
        display: grid;
      }
      button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <main>
    <div class="page-shell">
      <section class="hero">
        <div class="hero-copy">
          <p class="kicker">Agentify Change Documentation</p>
          <div class="hero-top">
            <p class="label">Command <strong>${escapeHtml(summary.command || "unknown")}</strong></p>
            <p class="label">Validation <strong>${escapeHtml(validationStatus)}</strong></p>
            <p class="label">Tests <strong>${escapeHtml(testStatus)}</strong></p>
          </div>
          <h1>Generated changes, execution health, and evidence in one technical document.</h1>
          <p class="lede">This report is the portable record for an Agentify run. It explains what changed, why those outputs exist, how much model usage the run consumed, and whether validation and tests left the repository in a trustworthy state.</p>
          <div class="hero-actions">
            <button type="button" onclick="copyCommand(\`${rerunUpdateCommand}\`)">Copy rerun Agentify command</button>
            <button type="button" class="secondary" onclick="copyCommand(\`${rerunTestsCommand}\`)">Copy rerun tests command</button>
          </div>
          <p id="copy-feedback" class="copy-feedback" aria-live="polite"></p>
        </div>
      </section>

      <aside class="summary-rail">
        <section class="rail-block">
          <p class="section-kicker">Run Overview</p>
          <div class="grid">
            <article class="metric">
              <p class="value">${escapeHtml(moduleCount)}</p>
              <p class="value-label">Modules processed</p>
            </article>
            <article class="metric">
              <p class="value">${escapeHtml(docsWritten)}</p>
              <p class="value-label">Docs written</p>
            </article>
            <article class="metric">
              <p class="value">${escapeHtml(headersRefreshed)}</p>
              <p class="value-label">Headers refreshed</p>
            </article>
            <article class="metric">
              <p class="value">${escapeHtml(validationCount)}</p>
              <p class="value-label">Validation issues</p>
            </article>
          </div>
          <div class="rule"></div>
          <p class="status status-${escapeHtml(validationStatus)} tone-${escapeHtml(validationTone)}">${escapeHtml(validationStatus)}</p>
          <p class="status status-${escapeHtml(testStatus)} tone-${escapeHtml(testTone)}">${escapeHtml(testStatus)}</p>
          <p class="terminal-note">Re-run tests before trusting a failed or skipped health state.</p>
        </section>
      </aside>
    </div>

    <div class="stack">
      <section>
        <div class="section-head">
          <div>
            <h2>Operational Intent</h2>
            <p class="lede">Agentify generates repository-facing documentation artifacts so both humans and agents can navigate the codebase with less ambiguity and lower onboarding cost.</p>
          </div>
        </div>
        <div class="intro-grid">
          <article class="panel">
            <p class="eyebrow">Why These Outputs Exist</p>
            <p>Repo maps, module docs, metadata, and bounded file headers give future sessions enough structure to reason about the project without editing core business logic blindly. This report is the audit layer over that generated state.</p>
          </article>
          <article class="panel">
            <p class="eyebrow">Operator Guidance</p>
            <p>If validation or tests fail, treat this file as evidence rather than approval. Fix the underlying issue, rerun the failing command, and regenerate the report so the documented state matches the repository state.</p>
          </article>
        </div>
        <div class="timeline">
          <article class="timeline-item">
            <p class="eyebrow">Step 01</p>
            <p>Scan establishes the deterministic project map and dependency graph.</p>
          </article>
          <article class="timeline-item">
            <p class="eyebrow">Step 02</p>
            <p>Documentation generation writes module docs, metadata, and bounded file headers.</p>
          </article>
          <article class="timeline-item">
            <p class="eyebrow">Step 03</p>
            <p>Validation and tests determine whether the generated outputs can be treated as current and safe.</p>
          </article>
        </div>
      </section>

      <section>
        <div class="section-head">
          <div>
            <h2>Change Inventory</h2>
            <p class="muted">${escapeHtml(artifactCount)} artifact${artifactCount === 1 ? "" : "s"} recorded for this run.</p>
          </div>
        </div>
        <ul class="artifact-list">${artifacts}</ul>
      </section>

      <section>
        <div class="section-head">
          <div>
            <h2>Token Usage</h2>
            <p class="muted">Model consumption is separated into total counters and per-module breakdown for traceability.</p>
          </div>
        </div>
        <div class="stat-strip">
          <article class="metric"><p class="value">${escapeHtml(tokenUsage.input_tokens ?? 0)}</p><p class="value-label">Input tokens</p></article>
          <article class="metric"><p class="value">${escapeHtml(tokenUsage.output_tokens ?? 0)}</p><p class="value-label">Output tokens</p></article>
          <article class="metric"><p class="value">${escapeHtml(tokenUsage.total_tokens ?? 0)}</p><p class="value-label">Total tokens</p></article>
        </div>
        <div class="module-grid">${moduleUsageCards}</div>
        <details>
          <summary>Raw per-module token usage</summary>
          <pre>${escapeHtml(JSON.stringify(tokenUsage.by_module || [], null, 2))}</pre>
        </details>
      </section>

      <section>
        <div class="section-head">
          <div>
            <h2>Validation</h2>
            <p class="muted">Unsafe writes, freshness issues, and invalid generated state are surfaced here.</p>
          </div>
          <p class="status status-${escapeHtml(validationStatus)} tone-${escapeHtml(validationTone)}">${escapeHtml(validationStatus)}</p>
        </div>
        ${summary.validation?.failures?.length ? `<ul class="failure-list">${summary.validation.failures.map((item) => {
          const msg = typeof item === "string" ? item : `[${item.category}] ${item.message}`;
          const rem = typeof item === "object" && item.remediation ? `<br><small>${escapeHtml(item.remediation)}</small>` : "";
          return `<li><code>${escapeHtml(msg)}</code>${rem}</li>`;
        }).join("")}</ul>` : validationFailures}
      </section>

      <section>
        <div class="section-head">
          <div>
            <h2>Tests</h2>
            <p class="muted">${escapeHtml(testSummaryText)}</p>
          </div>
          <p class="status status-${escapeHtml(testStatus)} tone-${escapeHtml(testTone)}">${escapeHtml(testStatus)}</p>
        </div>
        <div class="action-row">
          <button type="button" onclick="copyCommand(\`${rerunTestsCommand}\`)">Copy rerun tests command</button>
          <button type="button" class="secondary" onclick="copyCommand(\`${rerunUpdateCommand}\`)">Copy rerun Agentify command</button>
        </div>
        ${testOutput}
      </section>

      <section>
        <div class="section-head">
          <div>
            <h2>Machine Summary</h2>
            <p class="muted">Full structured payload preserved for debugging, diffing, or downstream tooling.</p>
          </div>
        </div>
        <pre>${escapeHtml(JSON.stringify(summary, null, 2))}</pre>
      </section>
    </div>
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

export async function mapWithConcurrency(items, concurrency, mapper, options = {}) {
  const results = new Array(items.length);
  const limit = Math.max(1, Number(concurrency) || 1);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      if (options.onProgress) {
        await options.onProgress(results[currentIndex], currentIndex);
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function findModuleDeps(modules, graph) {
  const byFile = new Map();
  for (const moduleInfo of modules) {
    byFile.set(moduleInfo.id, { dependsOn: new Set(), usedBy: new Set() });
  }

  for (const edge of graph.edges) {
    const fromModule = modules.find((moduleInfo) => isFileInModule(edge.from, moduleInfo.rootPath));
    const toModule = modules.find((moduleInfo) => isFileInModule(edge.to, moduleInfo.rootPath));
    if (!fromModule || !toModule || fromModule.id === toModule.id) {
      continue;
    }
    byFile.get(fromModule.id).dependsOn.add(toModule.id);
    byFile.get(toModule.id).usedBy.add(fromModule.id);
  }

  return byFile;
}

async function buildScanState(root, config) {
  const stacks = await detectStacks(root, config);
  const defaultStack = stacks[0]?.name || "ts";
  const modules = await detectModules(root, config, defaultStack);
  const files = (await walkFiles(root)).map((file) => relative(root, file));
  const graph = await buildDependencyGraph(root, defaultStack);
  const moduleDeps = findModuleDeps(modules, graph);

  const hydratedModules = modules.map((moduleInfo) => {
    const moduleFiles = files.filter((file) => isFileInModule(file, moduleInfo.rootPath) && getAllowedExtensions(moduleInfo.stack).some((ext) => file.endsWith(ext)));
    const keyFiles = rankKeyFiles(moduleFiles, graph, config.topKeyFilesPerModule || 15);

    return {
      ...moduleInfo,
      slug: toSlug(moduleInfo.name),
      hash: stableHash(moduleInfo.rootPath),
      entryFiles: selectEntrypoints(moduleFiles, moduleInfo.stack),
      keyFiles: keyFiles.slice(0, config.maxFilesPerModule),
      files: moduleFiles.slice(0, config.maxFilesPerModule),
      dependsOn: Array.from(moduleDeps.get(moduleInfo.id)?.dependsOn || []),
      usedBy: Array.from(moduleDeps.get(moduleInfo.id)?.usedBy || [])
    };
  });

  return {
    stacks,
    defaultStack,
    modules: hydratedModules,
    graph,
    files
  };
}

function renderAgentsMd(index) {
  return `# AGENTS.md

## Overview
This repository is Agentify-enabled. Start with \`docs/repo-map.md\`, then use \`.agents/index.json\` for machine-readable routing.

## Conventions
- Generated docs live under \`docs/\`
- Generated metadata lives under \`.agents/\`
- Code headers marked with \`@agentify\` are safe to refresh

## Modules
${index.modules.map((moduleInfo) => `- \`${moduleInfo.name}\`: \`${moduleInfo.root_path}\``).join("\n")}
`;
}

function renderAgentifyMd({ index, metadataByModule, runReport, managerPlan }) {
  const detectedStacks = index.repo.detected_stacks.map((stack) => `- \`${stack.name}\` (${stack.confidence})`).join("\n");
  const moduleBlocks = index.modules.map((moduleInfo) => {
    const metadata = metadataByModule.get(moduleInfo.id);
    const startHere = metadata?.start_here?.length
      ? metadata.start_here.map((item) => `- \`${item.path}\`: ${item.why}`).join("\n")
      : "- No start-here guidance available.";
    const publicApi = metadata?.public_api?.length
      ? metadata.public_api.map((item) => `- \`${item.path}\` (${item.kind})`).join("\n")
      : "- No public API identified.";
    return `## ${moduleInfo.name}

- Root: \`${moduleInfo.root_path}\`
- Doc: \`${moduleInfo.doc_path}\`
- Metadata: \`${moduleInfo.metadata_path}\`
- Key files indexed: ${moduleInfo.key_files.length}

### Summary
${metadata?.summary || "No summary generated."}

### Start Here
${startHere}

### Public Surface
${publicApi}`;
  }).join("\n\n");

  const sharedConventions = managerPlan?.shared_conventions?.length
    ? managerPlan.shared_conventions.map((item) => `- ${item}`).join("\n")
    : "- No shared conventions captured.";

  return `# AGENTIFY.md

## Overview
- Repository: \`${index.repo.name}\`
- Root: \`${index.repo.root}\`
- Default stack: \`${index.repo.default_stack}\`
- Generated at: \`${index.index.generated_at}\`
- Head commit: \`${index.index.head_commit}\`
- Provider: \`${runReport.provider}\`
- Provider model: \`${runReport.provider_model}\`

## Repo Summary
${managerPlan?.repo_summary || "No repo-level summary captured."}

## Detected Stacks
${detectedStacks}

## Shared Conventions
${sharedConventions}

## Artifacts
- Root guidance: \`AGENTS.md\`
- Repo map: \`docs/repo-map.md\`
- Machine index: \`.agents/index.json\`
- Dependency graph: \`.agents/graphs/deps.json\`
- Run report: \`.agents/runs/${runReport.run_id}.json\`

## Run Metrics
- Modules processed: ${runReport.results.modules_processed}
- Docs written: ${runReport.results.docs_written}
- Files with headers: ${runReport.results.files_with_headers}
- Total input tokens: ${runReport.token_usage.input_tokens}
- Total output tokens: ${runReport.token_usage.output_tokens}
- Total tokens: ${runReport.token_usage.total_tokens}

## Modules
${moduleBlocks}
`;
}

function renderRepoMap(index) {
  return `# Repo Map

## Stacks
${index.repo.detected_stacks.map((stack) => `- \`${stack.name}\` (${stack.confidence})`).join("\n")}

## Entrypoints
${index.entrypoints.length > 0 ? index.entrypoints.map((entry) => `- \`${entry}\``).join("\n") : "- No entrypoints detected."}

## Modules
${index.modules.map((moduleInfo) => `- [${moduleInfo.name}](./modules/${path.basename(moduleInfo.doc_path)})`).join("\n")}
`;
}

async function writeRunReport(root, report) {
  const runPath = path.join(root, ".agents", "runs", `${report.run_id}.json`);
  await writeJson(runPath, report);
  return runPath;
}

export async function ensureBaselineArtifacts(root, config) {
  if (config.dryRun) {
    return;
  }
  await ensureDir(path.join(root, ".agents", "graphs"));
  await ensureDir(path.join(root, ".agents", "modules"));
  await ensureDir(path.join(root, ".agents", "runs"));
  await ensureDir(path.join(root, "docs", "modules"));
  if (!(await exists(path.join(root, "AGENTS.md")))) {
    await writeText(path.join(root, "AGENTS.md"), "# AGENTS.md\n");
  }
  if (!(await exists(path.join(root, "docs", "repo-map.md")))) {
    await writeText(path.join(root, "docs", "repo-map.md"), "# Repo Map\n");
  }
}

function resolveArtifactRoot(root, config, runId) {
  if (config.ghost || config.ghostMode) {
    return path.join(root, ".current_session", runId || `ghost_${Date.now()}`);
  }
  return root;
}

function applyBudgets(files, config) {
  const perFile = config.budgets?.perFile || 8000;
  const perModule = config.budgets?.perModule || 32000;

  let totalChars = 0;
  const bounded = [];

  for (const file of files) {
    const clipped = file.content.slice(0, perFile);
    if (totalChars + clipped.length > perModule) break;
    bounded.push({ path: file.path, content: clipped });
    totalChars += clipped.length;
  }

  return bounded;
}

export function computeModuleFingerprint(files) {
  const entries = files
    .map((f) => `${f.path}:${crypto.createHash("sha256").update(f.content).digest("hex")}`)
    .sort();
  return crypto.createHash("sha256").update(entries.join("\n")).digest("hex");
}

export async function runScan(root, config, options = {}) {
  const progress = options.reporter || createRunReporter(root);
  progress.log("scan: starting deterministic repository scan");

  const lock = await acquireLock(root, "scan");
  if (!lock.acquired) {
    progress.log(`scan: ${lock.message}`);
    return;
  }

  try {
    await _runScanInner(root, config, options, progress);
  } finally {
    await lock.release();
  }
}

async function _runScanInner(root, config, options, progress) {
  const ghostRunId = (config.ghost || config.ghostMode)
    ? (options.ghostRunId || `ghost_${Date.now()}`)
    : null;
  const artifactRoot = resolveArtifactRoot(root, config, ghostRunId);

  await ensureBaselineArtifacts(artifactRoot, config);
  const now = new Date().toISOString();
  const headCommit = await getHeadCommit(root);
  const state = await buildScanState(root, config);
  progress.log(`scan: analyzed ${state.files.length} files and detected ${state.modules.length} modules`);
  const repoName = path.basename(root);
  const index = {
    schema_version: SCHEMA_VERSIONS.INDEX,
    repo: {
      name: repoName,
      root,
      detected_stacks: state.stacks,
      default_stack: state.defaultStack
    },
    index: {
      generated_at: now,
      head_commit: headCommit,
      generator: {
        agentify_version: "0.1.0",
        provider: config.provider
      }
    },
    modules: state.modules.map((moduleInfo) => ({
      id: moduleInfo.id,
      name: moduleInfo.name,
      root_path: moduleInfo.rootPath,
      doc_path: `docs/modules/${moduleInfo.slug}.md`,
      metadata_path: `.agents/modules/${moduleInfo.hash}.json`,
      tags: [moduleInfo.stack],
      entry_files: moduleInfo.entryFiles,
      key_files: moduleInfo.keyFiles
    })),
    entrypoints: state.modules.flatMap((moduleInfo) => moduleInfo.entryFiles),
    symbol_index_hint: {
      enabled: false,
      note: "reserved for future symbol-level indexing"
    }
  };

  if (!config.dryRun) {
    await writeJson(path.join(artifactRoot, ".agents", "index.json"), index);
    await writeJson(path.join(artifactRoot, ".agents", "graphs", "deps.json"), state.graph);
    await writeText(path.join(artifactRoot, "AGENTS.md"), renderAgentsMd(index));
    await writeText(path.join(artifactRoot, "docs", "repo-map.md"), renderRepoMap(index));
  }
  progress.log("scan: wrote index artifacts");

  const result = {
    command: "scan",
    detected_stacks: state.stacks,
    default_stack: state.defaultStack,
    modules: state.modules.map((moduleInfo) => ({ id: moduleInfo.id, root_path: moduleInfo.rootPath })),
    wrote: config.dryRun ? [] : [".agents/index.json", ".agents/graphs/deps.json", "AGENTS.md", "docs/repo-map.md"],
  };
  progress.setCommand("scan");
  progress.setScan(result);
  if (config.json || !config._suppressProgress) {
    progress.json(result);
  }
  if (!options.skipFinalize) {
    await progress.finalize();
  }
}

export async function runDoc(root, config, options = {}) {
  const progress = options.reporter || createRunReporter(root);
  progress.log("doc: starting documentation and metadata generation");
  progress.percent("doc", 0, "starting");

  const lock = await acquireLock(root, "doc");
  if (!lock.acquired) {
    progress.log(`doc: ${lock.message}`);
    return;
  }

  try {
    await _runDocInner(root, config, options, progress);
  } finally {
    await lock.release();
  }
}

async function _runDocInner(root, config, options, progress) {
  const ghostRunId = (config.ghost || config.ghostMode)
    ? (options.ghostRunId || `ghost_${Date.now()}`)
    : null;
  const artifactRoot = resolveArtifactRoot(root, config, ghostRunId);

  await ensureBaselineArtifacts(artifactRoot, config);
  const provider = createProvider(config.provider, config);
  const indexPath = path.join(artifactRoot, ".agents", "index.json");
  let state;
  if (await exists(indexPath)) {
    const index = await readJson(indexPath);
    const graphPath = path.join(artifactRoot, ".agents", "graphs", "deps.json");
    const graph = (await exists(graphPath))
      ? await readJson(graphPath)
      : { nodes: {}, edges: [] };
    const repoFiles = (await walkFiles(root)).map((file) => relative(root, file));
    state = {
      stacks: index.repo.detected_stacks,
      defaultStack: index.repo.default_stack,
      graph,
      files: repoFiles,
      modules: index.modules.map((moduleInfo) => ({
        id: moduleInfo.id,
        name: moduleInfo.name,
        rootPath: moduleInfo.root_path,
        slug: path.basename(moduleInfo.doc_path, ".md"),
        hash: path.basename(moduleInfo.metadata_path, ".json"),
        stack: moduleInfo.tags?.[0] || index.repo.default_stack,
        entryFiles: moduleInfo.entry_files,
        keyFiles: moduleInfo.key_files,
        files: moduleInfo.key_files
      }))
    };
  } else {
    state = await buildScanState(root, config);
  }

  const now = new Date().toISOString();
  const headCommit = await getHeadCommit(root);
  let filesWithHeaders = 0;
  let docsWritten = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const byModule = [];
  const repoBudgetPerFile = config.budgets?.perFile || 8000;
  const topLevelFiles = [];
  for (const file of state.files.slice(0, config.maxFilesPerModule || 20)) {
    try {
      const content = await fs.readFile(path.join(root, file), "utf8");
      topLevelFiles.push({
        path: file,
        content: content.slice(0, repoBudgetPerFile),
      });
    } catch {
      // Ignore unreadable files.
    }
  }
  progress.log(`doc: prepared repo context from ${topLevelFiles.length} top-level files`);
  progress.percent("doc", 10, `prepared repo context from ${topLevelFiles.length} top-level files`);

  const managerResult = provider.buildManagerPlan
    ? await provider.buildManagerPlan({
        root,
        repoName: path.basename(root),
        defaultStack: state.defaultStack,
        stacks: state.stacks,
        entrypoints: state.modules.flatMap((moduleInfo) => moduleInfo.entryFiles || []),
        modules: state.modules.map((moduleInfo) => ({
          id: moduleInfo.id,
          rootPath: moduleInfo.rootPath
        })),
        sampleFiles: topLevelFiles
      })
    : {
        plan: {
          repo_summary: "",
          shared_conventions: [],
          module_focus: []
        },
        tokenUsage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0
      }
      };

  inputTokens += managerResult.tokenUsage.input_tokens;
  outputTokens += managerResult.tokenUsage.output_tokens;
  progress.log(`doc: manager plan ready for ${state.modules.length} modules`);
  progress.percent("doc", 20, `manager plan ready for ${state.modules.length} modules`);

  const preparedModules = [];
  for (const moduleInfo of state.modules) {
    const moduleRoot = moduleInfo.rootPath === "." ? root : path.join(root, moduleInfo.rootPath);
    const allFiles = (await walkFiles(moduleRoot))
      .map((file) => relative(root, file))
      .filter((file) => file.startsWith(moduleInfo.rootPath === "." ? "" : moduleInfo.rootPath));
    const rawFiles = [];
    for (const file of allFiles.slice(0, config.maxFilesPerModule)) {
      const content = await fs.readFile(path.join(root, file), "utf8");
      rawFiles.push({ path: file, content });
    }
    const boundedFiles = applyBudgets(rawFiles, config);
    preparedModules.push({
      moduleInfo,
      context: {
        root,
        files: boundedFiles,
        keyFiles: moduleInfo.keyFiles,
        dependsOn: moduleInfo.dependsOn || [],
        usedBy: moduleInfo.usedBy || [],
        managerPlan: managerResult.plan,
        managerFocus: managerResult.plan.module_focus.find((item) => item.module_id === moduleInfo.id)?.focus || "",
        now,
        headCommit
      }
    });
  }
  const totalPreparedFiles = preparedModules.reduce((sum, item) => sum + item.context.files.length, 0);
  let completedModules = 0;
  let processedFiles = 0;
  progress.log(`doc: dispatching ${preparedModules.length} module jobs with concurrency ${config.moduleConcurrency}`);
  progress.percent("doc", 25, `dispatched ${preparedModules.length} module jobs`);

  const generatedModules = await mapWithConcurrency(
    preparedModules,
    config.moduleConcurrency,
    async ({ moduleInfo, context }) => ({
      moduleInfo,
      result: await provider.generateModuleArtifacts(moduleInfo, context)
    }),
    {
      onProgress: async ({ moduleInfo, result }) => {
        completedModules += 1;
        processedFiles += result.metadata.tests?.length >= 0 ? preparedModules.find((item) => item.moduleInfo.id === moduleInfo.id)?.context.files.length || 0 : 0;
        const percent = totalPreparedFiles > 0 ? Math.min(100, Math.round((processedFiles / totalPreparedFiles) * 100)) : Math.round((completedModules / Math.max(preparedModules.length, 1)) * 100);
        progress.log(`doc: completed ${completedModules}/${preparedModules.length} modules, approx ${percent}% of bounded context processed`);
        const stagePercent = 25 + Math.round((completedModules / Math.max(preparedModules.length, 1)) * 70);
        progress.percent("doc", stagePercent, `completed ${completedModules}/${preparedModules.length} modules`);
      }
    }
  );

  const plannedHeaders = [];
  const metadataByModule = new Map();
  for (const { moduleInfo, result } of generatedModules) {
    metadataByModule.set(moduleInfo.id, result.metadata);
    byModule.push({
      module_id: moduleInfo.id,
      input_tokens: result.tokenUsage.input_tokens,
      output_tokens: result.tokenUsage.output_tokens,
      total_tokens: result.tokenUsage.total_tokens
    });
    inputTokens += result.tokenUsage.input_tokens;
    outputTokens += result.tokenUsage.output_tokens;

    if (!config.dryRun) {
      await writeText(path.join(artifactRoot, "docs", "modules", `${moduleInfo.slug}.md`), result.markdown);
      await writeJson(path.join(artifactRoot, ".agents", "modules", `${moduleInfo.hash}.json`), result.metadata);
      docsWritten += 2;

      if (config.ghost || config.ghostMode) {
        for (const header of result.headers) {
          plannedHeaders.push({
            path: header.path,
            module: moduleInfo.name,
            summary: header.summary,
            action: "would_update",
          });
        }
      } else {
        for (const header of result.headers) {
          const update = await updateFileHeader(root, moduleInfo.name, header.path, header.summary, moduleInfo.stack);
          if (update.changed) {
            filesWithHeaders += 1;
          }
        }
      }
    }
  }

  const runReport = {
    run_id: `${Date.now()}`,
    started_at: now,
    finished_at: new Date().toISOString(),
    provider: provider.name,
    provider_model: provider.providerModel,
    token_usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      by_module: [
        {
          module_id: "__manager__",
          input_tokens: managerResult.tokenUsage.input_tokens,
          output_tokens: managerResult.tokenUsage.output_tokens,
          total_tokens: managerResult.tokenUsage.total_tokens
        },
        ...byModule
      ],
      note: "token counts are best-effort and depend on provider support"
    },
    results: {
      modules_processed: state.modules.length,
      files_with_headers: filesWithHeaders,
      docs_written: docsWritten
    },
    validation: {
      passed: true,
      failures: []
    }
  };

  if (config.tokenReport && !config.dryRun) {
    await writeRunReport(artifactRoot, runReport);
  }
  if (!config.dryRun) {
    const index = await readJson(path.join(artifactRoot, ".agents", "index.json"));
    await writeText(path.join(artifactRoot, "AGENTIFY.md"), renderAgentifyMd({
      index,
      metadataByModule,
      runReport,
      managerPlan: managerResult.plan,
    }));
  }

  if ((config.ghost || config.ghostMode) && !config.dryRun) {
    await writeJson(path.join(artifactRoot, "header-plan.json"), {
      run_id: ghostRunId,
      planned_headers: plannedHeaders,
      total_files_affected: plannedHeaders.length,
    });
    await writeJson(path.join(artifactRoot, "ghost-report.json"), {
      run_id: ghostRunId,
      artifacts_written: docsWritten,
      headers_planned: plannedHeaders.length,
      validation: { passed: true, failures: [] },
    });
  }

  progress.log("doc: wrote module docs, metadata, run report, and AGENTIFY.md");
  progress.percent("doc", 100, "completed");

  const result = {
    command: "doc",
    modules_processed: state.modules.length,
    files_with_headers: filesWithHeaders,
    docs_written: docsWritten,
    token_usage: runReport.token_usage,
    wrote: config.dryRun ? [] : ["AGENTIFY.md", "docs/modules/*.md", ".agents/modules/*.json", ".agents/runs/*.json"],
  };
  progress.setCommand("doc");
  progress.setDoc(result);
  if (config.json || !config._suppressProgress) {
    progress.json(result);
  }
  if (!options.skipFinalize) {
    await progress.finalize();
  }
}

export async function runValidate(root, config, options = {}) {
  const progress = options.reporter || createRunReporter(root);
  progress.percent("validate", 0, "starting");
  const result = await validateRepo(root, config, options);
  progress.percent("validate", 100, result.passed ? "passed" : `failed with ${result.failures.length} issue(s)`);
  progress.setCommand("validate");
  progress.setValidation(result);
  if (config.json || !config._suppressProgress) {
    progress.json(result);
  }

  if (result.passed) {
    ui.success("Validation passed");
  } else {
    ui.newline();
    for (const failure of result.failures) {
      process.stderr.write(ui.formatFailure(failure) + "\n");
    }
    ui.newline();
  }

  if (!options.skipFinalize) {
    await progress.finalize();
  }
  if (!result.passed) {
    if (config.strict) {
      process.exitCode = 1;
    } else {
      ui.warn("Validation warnings found but --strict is false, continuing");
    }
  }
}

export async function runUpdate(root, config) {
  const ghostRunId = (config.ghost || config.ghostMode) ? `ghost_${Date.now()}` : null;
  const artifactRoot = resolveArtifactRoot(root, config, ghostRunId);
  const progress = createRunReporter(artifactRoot);
  progress.setCommand("update");
  progress.percent("update", 0, "starting");
  await runScan(root, config, { reporter: progress, skipFinalize: true, ghostRunId });
  progress.percent("update", 33, "scan complete");
  await runDoc(root, config, { reporter: progress, skipFinalize: true, ghostRunId });
  progress.percent("update", 67, "doc complete");
  const result = await validateRepo(root, config, { artifactRoot });
  progress.setValidation(result);
  progress.percent("update", 100, result.passed ? "validation passed" : `validation failed with ${result.failures.length} issue(s)`);
  const testResult = await runProjectTests(root, progress);
  if (config.tokenReport && !config.dryRun) {
    const runReport = {
      run_id: `${Date.now()}-update`,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      provider: config.provider,
      provider_model: config.provider === "codex" ? "codex-external" : "local-deterministic",
      token_usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        by_module: [],
        note: "token counts are best-effort and depend on provider support"
      },
      results: {
        modules_processed: (await readJson(path.join(artifactRoot, ".agents", "index.json"))).modules.length,
        files_with_headers: 0,
        docs_written: 0
      },
      validation: result
    };
    await writeRunReport(artifactRoot, runReport);
  }
  const finalOutput = {
    command: "update",
    validation: result,
    tests: {
      status: testResult.status,
      passed: testResult.passed,
      command: testResult.command,
      exit_code: testResult.exit_code
    }
  };
  progress.json(finalOutput);
  await progress.finalize();
  if (!result.passed) {
    if (config.strict) {
      process.exitCode = 1;
    } else {
      progress.log("update: validation warnings found but --strict is false, continuing");
    }
  }
  if (testResult.status === "failed") {
    process.exitCode = 1;
  }
}
