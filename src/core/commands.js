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
        : [/src\/index\.(ts|tsx|js|jsx)$/, /src\/main\.(ts|tsx|js|jsx)$/, /app\.(ts|tsx|js|jsx)$/, /server\.(ts|tsx|js|jsx)$/];

  return files.filter((file) => patterns.some((pattern) => pattern.test(file))).slice(0, 10);
}

function createProgressReporter() {
  return {
    log(message) {
      process.stderr.write(`[agentify] ${message}\n`);
    },
    percent(scope, percent, message) {
      const normalizedPercent = Math.max(0, Math.min(100, Math.round(percent)));
      process.stderr.write(`[agentify] ${scope}: ${normalizedPercent}%${message ? ` ${message}` : ""}\n`);
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
      process.stderr.write(`${line}\n`);
      record(line);
    },
    percent(scope, percent, message) {
      const normalizedPercent = Math.max(0, Math.min(100, Math.round(percent)));
      const line = `[agentify] ${scope}: ${normalizedPercent}%${message ? ` ${message}` : ""}`;
      process.stderr.write(`${line}\n`);
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

async function detectTestCommand(root) {
  const packageJsonPath = path.join(root, "package.json");
  if (!(await exists(packageJsonPath))) {
    return null;
  }
  try {
    const packageJson = await readJson(packageJsonPath);
    if (packageJson?.scripts?.test) {
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
    ? `<ul>${summary.validation.failures.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agentify Run Report</title>
  <style>
    :root {
      --bg: #f6f1e8;
      --panel: rgba(255, 255, 255, 0.82);
      --ink: #1e2430;
      --muted: #5f6b7a;
      --line: rgba(30, 36, 48, 0.14);
      --accent: #0e7c66;
      --warn: #b75d1c;
      --bad: #a4372f;
      --shadow: 0 24px 60px rgba(38, 38, 52, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(14, 124, 102, 0.18), transparent 32%),
        radial-gradient(circle at top right, rgba(183, 93, 28, 0.16), transparent 28%),
        linear-gradient(180deg, #f7f4ee 0%, #efe5d6 100%);
    }
    main {
      width: min(1080px, calc(100vw - 32px));
      margin: 32px auto 64px;
      display: grid;
      gap: 18px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 22px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { font-size: clamp(2.2rem, 5vw, 4rem); line-height: 0.95; letter-spacing: -0.04em; }
    h2 { font-size: 1.05rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); }
    .hero {
      display: grid;
      grid-template-columns: 1.6fr 1fr;
      gap: 18px;
      align-items: end;
    }
    .pill {
      display: inline-block;
      padding: 7px 12px;
      border-radius: 999px;
      border: 1px solid var(--line);
      margin-right: 8px;
      margin-bottom: 8px;
      font-size: 0.92rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px;
      background: rgba(255,255,255,0.6);
    }
    .value {
      font-size: 1.7rem;
      font-weight: 700;
      margin: 0 0 6px;
    }
    .muted { color: var(--muted); }
    .status-passed { color: var(--accent); }
    .status-failed { color: var(--bad); }
    .status-skipped { color: var(--warn); }
    ul { margin-bottom: 0; }
    pre {
      overflow: auto;
      background: #1c2330;
      color: #ecf3ff;
      padding: 16px;
      border-radius: 14px;
      font-size: 0.9rem;
      line-height: 1.45;
    }
    button {
      appearance: none;
      border: 0;
      border-radius: 999px;
      padding: 12px 16px;
      margin-right: 10px;
      background: #1e2430;
      color: white;
      cursor: pointer;
      font: inherit;
    }
    .secondary { background: #dbe4ea; color: #1e2430; }
    @media (max-width: 720px) {
      .hero { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <p class="pill">Command: <strong>${escapeHtml(summary.command || "unknown")}</strong></p>
        <p class="pill">Validation: <strong>${escapeHtml(validationStatus)}</strong></p>
        <p class="pill">Tests: <strong class="status-${escapeHtml(testStatus)}">${escapeHtml(testStatus)}</strong></p>
        <h1>Agentify run output, changes, and why they happened.</h1>
        <p>This report captures the repository changes created by Agentify, the reason for those changes, the token usage consumed during doc generation, and the latest validation and test results.</p>
      </div>
      <div class="grid">
        <div class="stat">
          <p class="value">${escapeHtml(summary.doc?.modules_processed ?? 0)}</p>
          <p class="muted">Modules processed</p>
        </div>
        <div class="stat">
          <p class="value">${escapeHtml(summary.doc?.docs_written ?? 0)}</p>
          <p class="muted">Docs written</p>
        </div>
        <div class="stat">
          <p class="value">${escapeHtml(summary.doc?.files_with_headers ?? 0)}</p>
          <p class="muted">Headers refreshed</p>
        </div>
        <div class="stat">
          <p class="value">${escapeHtml(tokenUsage.total_tokens ?? 0)}</p>
          <p class="muted">Total tokens</p>
        </div>
      </div>
    </section>

    <section>
      <h2>Why</h2>
      <p>Agentify writes repo maps, module docs, metadata, and safe top-of-file headers so agents can navigate the codebase faster without changing business logic. Validation is run afterward to catch unsafe writes or stale generated state before those outputs are trusted.</p>
    </section>

    <section>
      <h2>Changes</h2>
      <ul>${artifacts}</ul>
    </section>

    <section>
      <h2>Token Usage</h2>
      <div class="grid">
        <div class="stat"><p class="value">${escapeHtml(tokenUsage.input_tokens ?? 0)}</p><p class="muted">Input tokens</p></div>
        <div class="stat"><p class="value">${escapeHtml(tokenUsage.output_tokens ?? 0)}</p><p class="muted">Output tokens</p></div>
        <div class="stat"><p class="value">${escapeHtml(tokenUsage.total_tokens ?? 0)}</p><p class="muted">Total tokens</p></div>
      </div>
      <details>
        <summary>Per-module token usage</summary>
        <pre>${escapeHtml(JSON.stringify(tokenUsage.by_module || [], null, 2))}</pre>
      </details>
    </section>

    <section>
      <h2>Validation</h2>
      ${validationFailures}
    </section>

    <section>
      <h2>Tests</h2>
      <p class="status-${escapeHtml(testStatus)}">${escapeHtml(testSummaryText)}</p>
      <p class="muted">If a test fails, rerun it first and then rerun Agentify after the underlying issue is fixed.</p>
      <button type="button" onclick="copyCommand(\`${rerunTestsCommand}\`)">Copy rerun tests command</button>
      <button type="button" class="secondary" onclick="copyCommand(\`${rerunUpdateCommand}\`)">Copy rerun agentify command</button>
      ${testOutput}
    </section>

    <section>
      <h2>Machine Summary</h2>
      <pre>${escapeHtml(JSON.stringify(summary, null, 2))}</pre>
    </section>
  </main>
  <script>
    async function copyCommand(command) {
      try {
        await navigator.clipboard.writeText(command);
        alert("Copied: " + command);
      } catch {
        alert(command);
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
  const graph = defaultStack === "ts" ? await buildDependencyGraph(root) : { nodes: {}, edges: [] };
  const moduleDeps = findModuleDeps(modules, graph);

  const hydratedModules = modules.map((moduleInfo) => {
    const moduleFiles = files.filter((file) => isFileInModule(file, moduleInfo.rootPath) && getAllowedExtensions(moduleInfo.stack).some((ext) => file.endsWith(ext)));
    const keyFiles = moduleInfo.stack === "ts"
      ? rankKeyFiles(moduleFiles, graph, config.topKeyFilesPerModule || 15)
      : moduleFiles.slice(0, config.topKeyFilesPerModule || 15);

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

export async function runScan(root, config, options = {}) {
  const progress = options.reporter || createRunReporter(root);
  progress.log("scan: starting deterministic repository scan");
  await ensureBaselineArtifacts(root, config);
  const now = new Date().toISOString();
  const headCommit = await getHeadCommit(root);
  const state = await buildScanState(root, config);
  progress.log(`scan: analyzed ${state.files.length} files and detected ${state.modules.length} modules`);
  const repoName = path.basename(root);
  const index = {
    schema_version: "1.0",
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
    await writeJson(path.join(root, ".agents", "index.json"), index);
    await writeJson(path.join(root, ".agents", "graphs", "deps.json"), state.graph);
    await writeText(path.join(root, "AGENTS.md"), renderAgentsMd(index));
    await writeText(path.join(root, "docs", "repo-map.md"), renderRepoMap(index));
  }
  progress.log("scan: wrote index artifacts");

  const result = {
    command: "scan",
    detected_stacks: state.stacks,
    default_stack: state.defaultStack,
    modules: state.modules.map((moduleInfo) => ({ id: moduleInfo.id, root_path: moduleInfo.rootPath })),
    wrote: config.dryRun ? [] : [".agents/index.json", ".agents/graphs/deps.json", "AGENTS.md", "docs/repo-map.md"]
  };
  progress.setCommand("scan");
  progress.setScan(result);
  progress.json(result);
  if (!options.skipFinalize) {
    await progress.finalize();
  }
}

export async function runDoc(root, config, options = {}) {
  const progress = options.reporter || createRunReporter(root);
  progress.log("doc: starting documentation and metadata generation");
  progress.percent("doc", 0, "starting");
  await ensureBaselineArtifacts(root, config);
  const provider = createProvider(config.provider, config);
  const indexPath = path.join(root, ".agents", "index.json");
  let state;
  if (await exists(indexPath)) {
    const index = await readJson(indexPath);
    const graph = (await exists(path.join(root, ".agents", "graphs", "deps.json")))
      ? await readJson(path.join(root, ".agents", "graphs", "deps.json"))
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
        stack: index.repo.default_stack,
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
  const topLevelFiles = [];
  for (const file of state.files.slice(0, config.maxFilesPerModule || 20)) {
    try {
      const content = await fs.readFile(path.join(root, file), "utf8");
      topLevelFiles.push({
        path: file,
        content: content.slice(0, 4000)
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
    const boundedFiles = [];
    for (const file of allFiles.slice(0, config.maxFilesPerModule)) {
      const content = await fs.readFile(path.join(root, file), "utf8");
      boundedFiles.push({
        path: file,
        content: content.slice(0, 6000)
      });
    }
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
      await writeText(path.join(root, "docs", "modules", `${moduleInfo.slug}.md`), result.markdown);
      await writeJson(path.join(root, ".agents", "modules", `${moduleInfo.hash}.json`), result.metadata);
      docsWritten += 2;

      for (const header of result.headers) {
        const update = await updateFileHeader(root, moduleInfo.name, header.path, header.summary, moduleInfo.stack);
        if (update.changed) {
          filesWithHeaders += 1;
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
    await writeRunReport(root, runReport);
  }
  if (!config.dryRun) {
    const index = await readJson(path.join(root, ".agents", "index.json"));
    await writeText(path.join(root, "AGENTIFY.md"), renderAgentifyMd({
      index,
      metadataByModule,
      runReport,
      managerPlan: managerResult.plan
    }));
  }
  progress.log("doc: wrote module docs, metadata, run report, and AGENTIFY.md");
  progress.percent("doc", 100, "completed");

  const result = {
    command: "doc",
    modules_processed: state.modules.length,
    files_with_headers: filesWithHeaders,
    docs_written: docsWritten,
    token_usage: runReport.token_usage,
    wrote: config.dryRun ? [] : ["AGENTIFY.md", "docs/modules/*.md", ".agents/modules/*.json", ".agents/runs/*.json"]
  };
  progress.setCommand("doc");
  progress.setDoc(result);
  progress.json(result);
  if (!options.skipFinalize) {
    await progress.finalize();
  }
}

export async function runValidate(root, config, options = {}) {
  const progress = options.reporter || createRunReporter(root);
  progress.percent("validate", 0, "starting");
  const result = await validateRepo(root, config);
  progress.percent("validate", 100, result.passed ? "passed" : `failed with ${result.failures.length} issue(s)`);
  progress.setCommand("validate");
  progress.setValidation(result);
  progress.json(result);
  if (!options.skipFinalize) {
    await progress.finalize();
  }
  if (!result.passed) {
    process.exitCode = 1;
  }
}

export async function runUpdate(root, config) {
  const progress = createRunReporter(root);
  progress.setCommand("update");
  progress.percent("update", 0, "starting");
  await runScan(root, config, { reporter: progress, skipFinalize: true });
  progress.percent("update", 33, "scan complete");
  await runDoc(root, config, { reporter: progress, skipFinalize: true });
  progress.percent("update", 67, "doc complete");
  const result = await validateRepo(root, config);
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
        modules_processed: (await readJson(path.join(root, ".agents", "index.json"))).modules.length,
        files_with_headers: 0,
        docs_written: 0
      },
      validation: result
    };
    await writeRunReport(root, runReport);
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
  if (!result.passed || testResult.status === "failed") {
    process.exitCode = 1;
  }
}
