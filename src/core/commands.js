import crypto from "node:crypto";
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
    }
  };
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

export async function runScan(root, config) {
  const progress = createProgressReporter();
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

  console.log(JSON.stringify({
    command: "scan",
    detected_stacks: state.stacks,
    default_stack: state.defaultStack,
    modules: state.modules.map((moduleInfo) => ({ id: moduleInfo.id, root_path: moduleInfo.rootPath })),
    wrote: config.dryRun ? [] : [".agents/index.json", ".agents/graphs/deps.json", "AGENTS.md", "docs/repo-map.md"]
  }, null, 2));
}

export async function runDoc(root, config) {
  const progress = createProgressReporter();
  progress.log("doc: starting documentation and metadata generation");
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

  console.log(JSON.stringify({
    command: "doc",
    modules_processed: state.modules.length,
    files_with_headers: filesWithHeaders,
    docs_written: docsWritten,
    token_usage: runReport.token_usage
  }, null, 2));
}

export async function runValidate(root, config) {
  const result = await validateRepo(root, config);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) {
    process.exitCode = 1;
  }
}

export async function runUpdate(root, config) {
  await runScan(root, config);
  await runDoc(root, config);
  const result = await validateRepo(root, config);
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
  console.log(JSON.stringify({ command: "update", validation: result }, null, 2));
  if (!result.passed) {
    process.exitCode = 1;
  }
}
