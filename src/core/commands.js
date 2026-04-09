import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { detectModules, detectStacks } from "./detect.js";
import { ensureDir, exists, relative, walkFiles, writeJson, writeText } from "./fs.js";
import { getHeadCommit } from "./git.js";
import { buildDependencyGraph, rankKeyFiles } from "./graph.js";
import { stripLeadingAgentifyHeader, updateFileHeader } from "./headers.js";
import { createProvider, renderModuleMarkdown, summarizeModule } from "./provider.js";
import { runProjectTests } from "./project-tests.js";
import { createRunReporter } from "./run-report.js";
import { validateRepo } from "./validate.js";
import { checkSchema, migrateIndex, SCHEMA_VERSIONS } from "./schema.js";
import { acquireLock } from "./lock.js";
import {
  closeIndexDatabase,
  getArtifact,
  getRepoMeta,
  inTransaction,
  loadCommands,
  loadFiles,
  loadModuleDependencies,
  loadModules,
  loadSemanticModuleContext,
  loadTests,
  openIndexDatabase,
  upsertArtifact,
  writeRepositoryIndex,
} from "./db.js";
import { buildRepositoryIndex } from "./indexer.js";
import { applySemanticHeaders, runSemanticRefresh, writeSemanticRepoMap } from "./semantic.js";
import * as ui from "./ui.js";

export { detectTestCommand } from "./project-tests.js";

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
  const files = (await walkFiles(root, { respectIgnore: true })).map((file) => relative(root, file));
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
- Fingerprint: \`${moduleInfo.fingerprint || "unknown"}\`
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

## Conventions
- Generated docs live under \`docs/\`
- Indexed metadata lives under \`.agents/index.db\` and is best accessed from the host shell
- Repo guardrails live in \`.guardrails\`
- Local working RFCs and notes live under \`.agentify/work/\`
- Use \`.agentignore\` to keep local-only artifacts out of scans
- From the host shell, \`agentify plan "<task>"\` or \`agentify query search --term <term>\` can provide deeper routing

## Artifacts
- Repo map: \`docs/repo-map.md\`
- Machine index: \`.agents/index.db\` (host shell access is the most reliable path)
- Run report: \`.agents/runs/${runReport.run_id}.json\`

## Run Metrics
- Modules processed: ${runReport.results.modules_processed}
- Cached manager plan: ${runReport.results.cached_manager_plan ? "yes" : "no"}
- Cached modules reused: ${runReport.results.cached_modules || 0}
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

function renderDefaultAgentignore() {
  return `# Keep local Agentify work artifacts out of repo scans
.agentify/work/**
`;
}

function renderDefaultGuardrails() {
  return `# Agentify Guardrails

## Git Safety
- Do not run \`git reset --hard\`, \`git checkout -- <path>\`, \`git clean -fd\`, or other destructive history or workspace resets unless the user explicitly asks.
- Do not force-push, rewrite unrelated history, or delete branches unless the user explicitly asks.

## Commit Quality
- Use clear commit messages that describe the change.
- Do not create placeholder commits like \`wip\`, \`fix\`, or \`misc\` unless the user explicitly asks.
- Do not commit knowingly broken code just to checkpoint progress.

## Protected Paths
- Do not edit \`.agents/\`, \`docs/modules/\`, \`AGENTIFY.md\`, \`output.txt\`, or \`agentify-report.html\` directly; regenerate them through Agentify commands.
- Do not edit provider-installed skill directories under \`.codex/\`, \`.claude/\`, \`.gemini/\`, or \`.opencode/\` unless the task is specifically about those files.
- Put local architecture RFCs, notes, and scratch outputs under \`.agentify/work/\`.

## Files To Avoid Touching Without Intent
- \`node_modules/\`
- lockfiles unless the task changes dependencies
- repo config such as \`.agentify.yaml\`, \`.agentignore\`, and \`.guardrails\` unless the task is about repo policy or tooling
`;
}

async function writeTextIfMissing(targetPath, text) {
  if (await exists(targetPath)) {
    return false;
  }
  await writeText(targetPath, text);
  return true;
}

export async function ensureBaselineArtifacts(root, config) {
  if (config.dryRun) {
    return;
  }
  await ensureDir(path.join(root, ".agents"));
  await ensureDir(path.join(root, ".agents", "runs"));
  await ensureDir(path.join(root, ".agentify", "work"));
  await ensureDir(path.join(root, "docs", "modules"));
  await writeTextIfMissing(path.join(root, ".agentignore"), renderDefaultAgentignore());
  await writeTextIfMissing(path.join(root, ".guardrails"), renderDefaultGuardrails());
}

function resolveArtifactRoot(root, config, runId) {
  if (config.ghost || config.ghostMode) {
    return path.join(root, ".current_session", runId || `ghost_${Date.now()}`);
  }
  return root;
}

function buildRenderableIndex(root, meta, modules) {
  return {
    schema_version: "2.0",
    repo: {
      name: meta.repo_name || path.basename(root),
      root,
      detected_stacks: meta.detected_stacks || [],
      default_stack: meta.default_stack || "ts"
    },
    index: {
      generated_at: meta.generated_at || null,
      head_commit: meta.head_commit || "unknown",
      generator: {
        agentify_version: "0.2.0",
        provider: meta.provider || "local"
      }
    },
    modules: modules.map((moduleInfo) => ({
      id: moduleInfo.id,
      name: moduleInfo.name,
      root_path: moduleInfo.root_path,
      doc_path: moduleInfo.doc_path,
      metadata_path: null,
      tags: [moduleInfo.stack],
      fingerprint: moduleInfo.fingerprint,
      entry_files: moduleInfo.entry_files,
      key_files: moduleInfo.key_files
    })),
    entrypoints: modules.flatMap((moduleInfo) => moduleInfo.entry_files || []),
    symbol_index_hint: {
      enabled: true,
      note: "symbol spans are stored in .agents/index.db"
    }
  };
}

function applyBudgets(files, config) {
  return applyContentBudget(files, {
    perFile: config.budgets?.perFile || 8000,
    totalBudget: config.budgets?.perModule || 32000,
  });
}

function applyContentBudget(files, { perFile, totalBudget }) {
  let totalChars = 0;
  const bounded = [];

  for (const file of files) {
    const clipped = file.content.slice(0, perFile);
    if (clipped.length === 0) {
      continue;
    }

    const remaining = totalBudget - totalChars;
    if (remaining <= 0) {
      break;
    }

    const boundedContent = clipped.slice(0, remaining);
    bounded.push({ path: file.path, content: boundedContent });
    totalChars += boundedContent.length;
  }

  return bounded;
}

async function readFilesWithBudget(root, filePaths, { perFile, totalBudget }) {
  const rawFiles = [];

  for (const file of filePaths) {
    try {
      const content = stripLeadingAgentifyHeader(await fs.readFile(path.join(root, file), "utf8"));
      rawFiles.push({ path: file, content });
    } catch {
      // Ignore unreadable files.
    }
  }

  return applyContentBudget(rawFiles, { perFile, totalBudget });
}

function scoreRepoContextFile(file, signals) {
  const base = path.basename(file).toLowerCase();
  let score = 0;

  if (signals.entryFiles.has(file)) score += 90;
  if (signals.keyFiles.has(file)) score += 75;
  if (base === "readme.md") score += 80;
  if (base === "package.json") score += 80;
  if (/^tsconfig(\..+)?\.json$/.test(base)) score += 65;
  if ([
    "pnpm-workspace.yaml",
    "turbo.json",
    "pyproject.toml",
    "cargo.toml",
    "package.swift",
    ".agentify.yaml",
  ].includes(base)) {
    score += 65;
  }
  if (/^(index|main|app|server|cli)\./.test(base)) score += 55;
  if (/(config|env|settings|constants)/.test(base)) score += 35;
  if (file.split("/").length === 1) score += 12;
  if (/(test|spec)\./.test(base)) score -= 20;

  return score;
}

function selectRepoContextFiles(indexData, config) {
  const entryFiles = new Set(indexData.modules.flatMap((moduleInfo) => moduleInfo.entry_files || []));
  const keyFiles = new Set(indexData.modules.flatMap((moduleInfo) => (moduleInfo.key_files || []).slice(0, 3)));
  const limit = Math.max(config.maxFilesPerModule || 20, indexData.modules.length);

  return [...indexData.files]
    .sort((left, right) => {
      const scoreDelta = scoreRepoContextFile(right, { entryFiles, keyFiles }) - scoreRepoContextFile(left, { entryFiles, keyFiles });
      return scoreDelta || left.localeCompare(right);
    })
    .slice(0, limit);
}

function withFreshness(metadata, { now, headCommit, fingerprint }) {
  return {
    ...metadata,
    freshness: {
      ...(metadata.freshness || {}),
      last_indexed_at: now,
      last_indexed_commit: headCommit,
      content_fingerprint: fingerprint,
    },
  };
}

function computeFingerprintFromEntries(entries) {
  return crypto.createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}

function computeManagerPlanFingerprint(repoContext) {
  return computeFingerprintFromEntries([
    `repo:${repoContext.repoName}`,
    `defaultStack:${repoContext.defaultStack}`,
    ...repoContext.stacks.map((item) => `stack:${item.name}:${item.confidence}`),
    ...repoContext.entrypoints.map((item) => `entry:${item}`),
    ...repoContext.modules.map((item) => `module:${item.id}:${item.rootPath}`),
    ...repoContext.sampleFiles.map((item) => `file:${item.path}:${crypto.createHash("sha256").update(item.content).digest("hex")}`),
  ]);
}

export function computeModuleFingerprint(files) {
  return computeFingerprintFromEntries(
    files
    .map((f) => `${f.path}:${crypto.createHash("sha256").update(f.content).digest("hex")}`)
  );
}

function getModuleArtifactKey(moduleId) {
  return `module-doc:${moduleId}`;
}

function getManagerPlanArtifactKey() {
  return "manager-plan";
}

function createDbSnapshot(root, db) {
  const meta = getRepoMeta(db);
  const modules = loadModules(db);
  const files = loadFiles(db).map((fileInfo) => fileInfo.path);
  return {
    meta,
    modules,
    files,
    index: buildRenderableIndex(root, meta, modules),
  };
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
  const headCommit = await getHeadCommit(root);
  const snapshot = options.scanSnapshot || await buildRepositoryIndex(root, config);
  progress.log(`scan: analyzed ${snapshot.files.length} files and detected ${snapshot.modules.length} modules`);

  if (!config.dryRun) {
    const db = openIndexDatabase(artifactRoot);
    try {
      inTransaction(db, () => {
        writeRepositoryIndex(db, snapshot, {
          headCommit,
          provider: config.provider,
        });
      });
      const index = buildRenderableIndex(root, getRepoMeta(db), loadModules(db));
      await writeText(path.join(artifactRoot, "docs", "repo-map.md"), renderRepoMap(index));
    } finally {
      closeIndexDatabase(db);
    }
  }
  progress.log("scan: wrote SQLite index and repo guidance");

  const result = {
    command: options.commandName || "scan",
    detected_stacks: snapshot.repo.detected_stacks,
    default_stack: snapshot.repo.default_stack,
    modules: snapshot.modules.map((moduleInfo) => ({ id: moduleInfo.id, root_path: moduleInfo.root_path })),
    wrote: config.dryRun ? [] : [".agents/index.db", "docs/repo-map.md"],
  };
  progress.setCommand(options.commandName || "scan");
  progress.setScan(result);
  if (!options.skipOutput && (config.json || !config._suppressProgress)) {
    progress.json(result);
  }
  if (!options.skipFinalize) {
    await progress.finalize();
  }
}

function createDependencyMap(modules, imports) {
  const byModule = new Map(modules.map((moduleInfo) => [
    moduleInfo.id,
    { dependsOn: new Set(), usedBy: new Set() },
  ]));

  for (const edge of imports) {
    if (!edge.from_module_id || !edge.to_module_id || edge.from_module_id === edge.to_module_id) {
      continue;
    }
    byModule.get(edge.from_module_id)?.dependsOn.add(edge.to_module_id);
    byModule.get(edge.to_module_id)?.usedBy.add(edge.from_module_id);
  }

  return byModule;
}

function createIndexDataFromSnapshot(root, snapshot, headCommit, provider) {
  const meta = {
    repo_name: snapshot.repo.name,
    repo_root: root,
    detected_stacks: snapshot.repo.detected_stacks,
    default_stack: snapshot.repo.default_stack,
    generated_at: snapshot.generated_at,
    head_commit: headCommit,
    provider,
  };
  const modules = snapshot.modules.map((moduleInfo) => ({
    ...moduleInfo,
    entry_files: moduleInfo.entry_files || [],
    key_files: moduleInfo.key_files || [],
  }));

  return {
    meta,
    modules,
    files: snapshot.files.map((fileInfo) => fileInfo.path),
    fileRows: snapshot.files,
    testRows: snapshot.tests,
    commandRows: snapshot.commands,
    dependencyMap: createDependencyMap(modules, snapshot.imports),
    index: buildRenderableIndex(root, meta, modules),
  };
}

function prioritizeModuleFiles(moduleInfo, fileRows) {
  const keyFiles = new Set(moduleInfo.key_files || []);
  const entryFiles = new Set(moduleInfo.entry_files || []);
  return [...fileRows]
    .sort((left, right) => {
      const leftScore = (keyFiles.has(left.path) ? 40 : 0)
        + (entryFiles.has(left.path) ? 30 : 0)
        + (left.is_test ? -10 : 0)
        + (left.is_config ? 6 : 0);
      const rightScore = (keyFiles.has(right.path) ? 40 : 0)
        + (entryFiles.has(right.path) ? 30 : 0)
        + (right.is_test ? -10 : 0)
        + (right.is_config ? 6 : 0);
      return rightScore - leftScore || left.path.localeCompare(right.path);
    })
    .map((fileInfo) => fileInfo.path);
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
  const now = new Date().toISOString();
  const headCommit = await getHeadCommit(root);
  const dbPath = path.join(artifactRoot, ".agents", "index.db");
  const scanSnapshot = options.scanSnapshot || null;

  if (!config.dryRun && (scanSnapshot || !(await exists(dbPath)))) {
    const snapshot = scanSnapshot || await buildRepositoryIndex(root, config);
    const writeDb = openIndexDatabase(artifactRoot);
    try {
      inTransaction(writeDb, () => {
        writeRepositoryIndex(writeDb, snapshot, {
          headCommit,
          provider: config.provider,
        });
      });
      const renderable = buildRenderableIndex(root, getRepoMeta(writeDb), loadModules(writeDb));
      await writeText(path.join(artifactRoot, "docs", "repo-map.md"), renderRepoMap(renderable));
    } finally {
      closeIndexDatabase(writeDb);
    }
  }

  const semanticEnabled = Boolean(config.semantic?.tsjs?.enabled);
  if (semanticEnabled && !config.dryRun) {
    progress.log("doc: refreshing semantic TS/JS facts");
    progress.percent("doc", 5, "refreshing semantic TS/JS facts");
    await runSemanticRefresh(root, config, {
      artifactRoot,
      silent: true,
      skipOutput: true,
    });
    await writeSemanticRepoMap(root, artifactRoot);
  }

  let indexData;
  let db = null;
  if (config.dryRun) {
    if (scanSnapshot) {
      indexData = createIndexDataFromSnapshot(root, scanSnapshot, headCommit, config.provider);
    } else if (await exists(dbPath)) {
      db = openIndexDatabase(artifactRoot);
      indexData = createDbSnapshot(root, db);
    } else {
      indexData = createIndexDataFromSnapshot(root, await buildRepositoryIndex(root, config), headCommit, config.provider);
    }
  } else {
    db = openIndexDatabase(artifactRoot);
    indexData = createDbSnapshot(root, db);
  }

  try {
    let filesWithHeaders = 0;
    let docsWritten = 0;
    let cachedModules = 0;
    let cachedManagerPlan = false;
    let inputTokens = 0;
    let outputTokens = 0;
    const byModule = [];
    const repoContextCandidates = selectRepoContextFiles(indexData, config);
    const repoContextFiles = await readFilesWithBudget(root, repoContextCandidates, {
      perFile: config.budgets?.perFile || 8000,
      totalBudget: config.budgets?.repo || 128000,
    });
    progress.log(`doc: prepared repo context from ${repoContextFiles.length} ranked files`);
    progress.percent("doc", 10, `prepared repo context from ${repoContextFiles.length} ranked files`);

    const repoContext = {
      root,
      repoName: path.basename(root),
      defaultStack: indexData.meta.default_stack,
      stacks: indexData.meta.detected_stacks || [],
      entrypoints: indexData.modules.flatMap((moduleInfo) => moduleInfo.entry_files || []),
      modules: indexData.modules.map((moduleInfo) => ({
        id: moduleInfo.id,
        rootPath: moduleInfo.root_path
      })),
      sampleFiles: repoContextFiles
    };
    const managerFingerprint = computeManagerPlanFingerprint(repoContext);
    const cachedPlan = !config.dryRun && db
      ? getArtifact(db, getManagerPlanArtifactKey())
      : null;
    const managerPlan = cachedPlan?.fingerprint === managerFingerprint ? cachedPlan.payload?.plan || cachedPlan.payload : null;
    const managerResult = managerPlan
      ? {
          plan: managerPlan,
          tokenUsage: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0
          }
        }
      : provider.buildManagerPlan
        ? await provider.buildManagerPlan(repoContext)
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
    cachedManagerPlan = Boolean(managerPlan);

    inputTokens += managerResult.tokenUsage.input_tokens;
    outputTokens += managerResult.tokenUsage.output_tokens;
    progress.log(`doc: manager plan ready for ${indexData.modules.length} modules${cachedManagerPlan ? " (cache hit)" : ""}`);
    progress.percent("doc", 20, `manager plan ready for ${indexData.modules.length} modules`);

    const preparedModules = [];
    const fileRowsByModule = new Map(indexData.modules.map((moduleInfo) => [
      moduleInfo.id,
      (indexData.fileRows || loadFiles(db, moduleInfo.id)).filter((fileInfo) => fileInfo.module_id === moduleInfo.id),
    ]));
    for (const moduleInfo of indexData.modules) {
      const prioritizedFiles = prioritizeModuleFiles(moduleInfo, fileRowsByModule.get(moduleInfo.id) || []);
      const boundedFiles = await readFilesWithBudget(root, prioritizedFiles.slice(0, config.maxFilesPerModule), {
        perFile: config.budgets?.perFile || 8000,
        totalBudget: config.budgets?.perModule || 32000,
      });
      const fingerprint = computeModuleFingerprint(boundedFiles);
      const cachedArtifact = !config.dryRun && db
        ? getArtifact(db, getModuleArtifactKey(moduleInfo.id))
        : null;
      const reusableArtifact = cachedArtifact?.fingerprint === fingerprint ? cachedArtifact.payload : null;
      const moduleDeps = indexData.dependencyMap
        ? indexData.dependencyMap.get(moduleInfo.id)
        : loadModuleDependencies(db, moduleInfo.id);
      const semanticContext = semanticEnabled && db
        ? loadSemanticModuleContext(db, moduleInfo.id)
        : null;
      preparedModules.push({
        moduleInfo,
        fingerprint,
        cachedArtifact: reusableArtifact,
        preparedFileCount: boundedFiles.length,
        context: {
          root,
          files: boundedFiles,
          keyFiles: moduleInfo.key_files,
          dependsOn: Array.from(moduleDeps?.dependsOn || []),
          usedBy: Array.from(moduleDeps?.usedBy || []),
          semantic: semanticContext,
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
      async ({ moduleInfo, context, fingerprint, cachedArtifact }) => {
      if (cachedArtifact) {
        const refreshedMetadata = withFreshness({
          ...cachedArtifact.metadata,
          module: {
            ...(cachedArtifact.metadata?.module || {}),
            id: moduleInfo.id,
            name: moduleInfo.name,
            root_path: moduleInfo.rootPath,
            stack: moduleInfo.stack,
          },
          summary: summarizeModule(moduleInfo, context.files.map((item) => item.path), context.semantic),
          docs: [`docs/modules/${moduleInfo.slug}.md`],
          tags: Array.from(new Set([...(cachedArtifact.metadata?.tags || []), moduleInfo.stack])),
        }, {
          now,
          headCommit,
          fingerprint,
        });
        return {
          moduleInfo,
          fingerprint,
          reused: true,
          result: {
            markdown: renderModuleMarkdown(moduleInfo, refreshedMetadata),
            metadata: refreshedMetadata,
            headers: context.keyFiles.map((file) => ({
              path: file,
              summary: refreshedMetadata.summary,
            })),
            tokenUsage: {
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0
            }
          }
        };
      }

      const result = await provider.generateModuleArtifacts(moduleInfo, context);
      return {
        moduleInfo,
        fingerprint,
        reused: false,
        result: {
          ...result,
          metadata: withFreshness(result.metadata, {
            now,
            headCommit,
            fingerprint,
          }),
        }
      };
      },
      {
        onProgress: async ({ moduleInfo, reused }) => {
          completedModules += 1;
          processedFiles += preparedModules.find((item) => item.moduleInfo.id === moduleInfo.id)?.preparedFileCount || 0;
          const percent = totalPreparedFiles > 0 ? Math.min(100, Math.round((processedFiles / totalPreparedFiles) * 100)) : Math.round((completedModules / Math.max(preparedModules.length, 1)) * 100);
          progress.log(`doc: completed ${completedModules}/${preparedModules.length} modules, approx ${percent}% of bounded context processed${reused ? " (cache hit)" : ""}`);
          const stagePercent = 25 + Math.round((completedModules / Math.max(preparedModules.length, 1)) * 70);
          progress.percent("doc", stagePercent, `completed ${completedModules}/${preparedModules.length} modules`);
        }
      }
    );

    const plannedHeaders = [];
    const metadataByModule = new Map();
    for (const { moduleInfo, result, reused, fingerprint } of generatedModules) {
      metadataByModule.set(moduleInfo.id, result.metadata);
      byModule.push({
        module_id: moduleInfo.id,
        input_tokens: result.tokenUsage.input_tokens,
        output_tokens: result.tokenUsage.output_tokens,
        total_tokens: result.tokenUsage.total_tokens,
        cache_hit: reused
      });
      inputTokens += result.tokenUsage.input_tokens;
      outputTokens += result.tokenUsage.output_tokens;
      if (reused) {
        cachedModules += 1;
      }

      if (!config.dryRun) {
        await writeText(path.join(artifactRoot, moduleInfo.doc_path), result.markdown);
        docsWritten += 1;
        if (db) {
          upsertArtifact(db, {
            key: getModuleArtifactKey(moduleInfo.id),
            type: "module-doc",
            scope: moduleInfo.id,
            fingerprint,
            payload: {
              markdown: result.markdown,
              metadata: result.metadata,
            },
            updatedAt: now,
          });
        }

        if (semanticEnabled) {
          continue;
        }

        if (config.headers) {
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
    }

    if (config.headers && semanticEnabled && !config.dryRun) {
      progress.log("doc: applying deterministic semantic headers");
      const semanticHeaderResult = await applySemanticHeaders(root, artifactRoot, config, {
        ghost: Boolean(config.ghost || config.ghostMode),
      });
      filesWithHeaders += semanticHeaderResult.changed;
      plannedHeaders.push(...semanticHeaderResult.plannedHeaders);
      await writeSemanticRepoMap(root, artifactRoot);
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
      modules_processed: indexData.modules.length,
      cached_manager_plan: cachedManagerPlan,
      cached_modules: cachedModules,
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
    if (!config.dryRun && db) {
      upsertArtifact(db, {
        key: getManagerPlanArtifactKey(),
        type: "manager-plan",
        scope: "repo",
        fingerprint: managerFingerprint,
        payload: {
          plan: managerResult.plan,
        },
        updatedAt: now,
      });
      await writeText(path.join(artifactRoot, "AGENTIFY.md"), renderAgentifyMd({
        index: indexData.index,
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
      modules_processed: indexData.modules.length,
      cached_manager_plan: cachedManagerPlan,
      cached_modules: cachedModules,
      files_with_headers: filesWithHeaders,
      docs_written: docsWritten,
      token_usage: runReport.token_usage,
      wrote: config.dryRun ? [] : ["AGENTIFY.md", "docs/modules/*.md", ".agents/index.db", ".agents/runs/*.json"],
    };
    progress.setCommand("doc");
    progress.setDoc(result);
    if (!options.skipOutput && (config.json || !config._suppressProgress)) {
      progress.json(result);
    }
    if (!options.skipFinalize) {
      await progress.finalize();
    }
  } finally {
    if (db) {
      closeIndexDatabase(db);
    }
  }
}

export async function runValidate(root, config, options = {}) {
  const progress = options.reporter || createRunReporter(root);
  progress.percent("check", 0, "starting");
  const result = await validateRepo(root, config, options);
  progress.percent("check", 100, result.passed ? "passed" : `failed with ${result.failures.length} issue(s)`);
  progress.setCommand("check");
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

export async function runUpdate(root, config, options = {}) {
  const commandName = options.commandName || "up";
  const ghostRunId = (config.ghost || config.ghostMode) ? `ghost_${Date.now()}` : null;
  const artifactRoot = resolveArtifactRoot(root, config, ghostRunId);
  const progress = createRunReporter(artifactRoot);
  const scanSnapshot = config.dryRun ? await buildRepositoryIndex(root, config) : null;
  progress.setCommand(commandName);
  progress.percent(commandName, 0, "starting");
  await runScan(root, config, { reporter: progress, skipFinalize: true, skipOutput: true, ghostRunId, scanSnapshot });
  progress.percent(commandName, 33, "scan complete");
  await runDoc(root, config, { reporter: progress, skipFinalize: true, skipOutput: true, ghostRunId, scanSnapshot });
  progress.percent(commandName, 67, "doc complete");
  const result = await validateRepo(root, config, { artifactRoot, skipFreshness: config.dryRun });
  progress.setValidation(result);
  progress.percent(commandName, 100, result.passed ? "validation passed" : `validation failed with ${result.failures.length} issue(s)`);
  const testResult = await runProjectTests(root, progress);
  if (config.tokenReport && !config.dryRun) {
    const db = openIndexDatabase(artifactRoot);
    const meta = getRepoMeta(db);
    closeIndexDatabase(db);
    const runReport = {
      run_id: `${Date.now()}-${commandName}`,
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
        modules_processed: meta.module_count || 0,
        files_with_headers: 0,
        docs_written: 0
      },
      validation: result
    };
    await writeRunReport(artifactRoot, runReport);
  }
  const finalOutput = {
    command: commandName,
    validation: result,
    tests: {
      status: testResult.status,
      passed: testResult.passed,
      command: testResult.command,
      exit_code: testResult.exit_code
    },
    ...(options.preflight ? { repo_sync: options.preflight } : {}),
  };
  progress.json(finalOutput);
  await progress.finalize();
  if (!result.passed) {
    if (config.strict) {
      process.exitCode = 1;
    } else {
      progress.log(`${commandName}: validation warnings found but --strict is false, continuing`);
    }
  }
  if (testResult.status === "failed") {
    process.exitCode = 1;
  }
  return finalOutput;
}
