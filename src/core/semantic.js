import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";

import { buildRepositoryIndex } from "./indexer.js";
import { closeIndexDatabase, inTransaction, openIndexDatabase } from "./db/connection.js";
import { getRepoMeta } from "./db/metadata-store.js";
import { loadFiles, loadModules } from "./db/structural-store.js";
import {
  clearSemanticProjectState,
  listSemanticProjects,
  replaceSemanticProjectSnapshot,
  upsertSemanticMeta,
  loadSemanticProjectFactsByFile,
  loadSemanticRouteSurfaces,
  loadSemanticReactSurfaces,
} from "./db/semantic-store.js";
import { ensureDir, relative, walkFiles, writeText } from "./fs.js";
import { updateFileHeader } from "./headers.js";

const execFileAsync = promisify(execFile);

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeRepoPath(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

function pathHash(...parts) {
  return sha1(parts.join(":"));
}

function isTsJsFile(filePath) {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath) && !filePath.endsWith(".d.ts");
}

function isConfigCandidate(filePath) {
  const base = path.basename(filePath);
  return base === "tsconfig.json" || base === "jsconfig.json" || /^tsconfig\..+\.json$/.test(base);
}

function isRepoOwned(root, filePath) {
  const resolved = path.resolve(filePath);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  return resolved.startsWith(rootPrefix) && !resolved.includes(`${path.sep}node_modules${path.sep}`);
}

function shouldTreatAsOwned(filePath) {
  if (filePath.endsWith(".d.ts")) {
    return false;
  }
  if (/(^|\/)(dist|build|coverage|generated|__generated__)\//i.test(filePath)) {
    return false;
  }
  return true;
}

function isSupportPath(filePath) {
  return /(^|\/)(__tests__|__mocks__|fixtures?|examples?|stories)\//i.test(filePath)
    || /\.(test|spec|stories)\.[^.]+$/i.test(filePath);
}

function domainForFile(filePath) {
  return isSupportPath(filePath) ? "support" : "runtime";
}

function isTestOwnedPath(filePath) {
  return isSupportPath(filePath)
    || /(^|\/)(test|tests)\//i.test(filePath)
    || /(^|\/)(vitest|jest|playwright|cypress)[^/]*\.[^.]+$/i.test(filePath)
    || /(^|\/)test-extend\.[^.]+$/i.test(filePath);
}

function isToolingPath(filePath) {
  return /(^|\/)(vite|vitest|webpack|rollup|tailwind|eslint|postcss|babel|metro|jest)\.config\.[^.]+$/i.test(filePath)
    || /(^|\/)(vite|vitest|webpack|rollup|tailwind|eslint|postcss|babel|metro)[^/]*\.[^.]+$/i.test(path.basename(filePath));
}

function hasExplicitProjectInputs(rawConfig) {
  return Array.isArray(rawConfig?.files)
    || Array.isArray(rawConfig?.include)
    || Array.isArray(rawConfig?.references);
}

function classifyProjectIntent(configPath, rawConfig) {
  const tokens = [
    configPath,
    ...(rawConfig?.include || []),
    ...(rawConfig?.files || []),
    ...(rawConfig?.exclude || []),
    ...(rawConfig?.compilerOptions?.types || []),
  ].join("\n").toLowerCase();

  if (/(^|[^a-z])(test|spec|vitest|jest|playwright|cypress)([^a-z]|$)/.test(tokens)) {
    return "test";
  }
  if (/(^|[^a-z])(node|vite|webpack|rollup|tailwind|eslint|postcss|babel|scripts?)([^a-z]|$)/.test(tokens)) {
    return "tooling";
  }
  return "runtime";
}

function projectPriority(intent) {
  if (intent === "runtime") {
    return 30;
  }
  if (intent === "tooling") {
    return 20;
  }
  return 10;
}

function filePriority(project, filePath) {
  let score = projectPriority(project.intent);
  if (project.intent === "test") {
    score += isTestOwnedPath(filePath) ? 40 : -10;
  } else if (isTestOwnedPath(filePath)) {
    score -= 20;
  }

  if (project.intent === "tooling") {
    score += isToolingPath(filePath) ? 30 : -10;
  }

  score += project.projectRoot === "." ? 0 : project.projectRoot.split("/").length;
  score -= project.filePaths.length / 1000;
  return score;
}

function resolveExtendedConfigPath(configPath, extendsValue, knownConfigs) {
  if (typeof extendsValue !== "string" || extendsValue.length === 0) {
    return null;
  }
  if (!extendsValue.startsWith(".") && !extendsValue.startsWith("/")) {
    return null;
  }

  const baseDir = path.posix.dirname(normalizeRepoPath(configPath));
  const candidateBase = extendsValue.startsWith("/")
    ? extendsValue.replace(/^\/+/, "")
    : path.posix.normalize(path.posix.join(baseDir, extendsValue));
  const candidates = [
    candidateBase,
    `${candidateBase}.json`,
    path.posix.join(candidateBase, "tsconfig.json"),
  ];

  return candidates.find((candidate) => knownConfigs.has(candidate)) || null;
}

async function loadConfiguredProject(root, configPath) {
  const absoluteConfigPath = path.join(root, configPath);
  const configFile = ts.readConfigFile(absoluteConfigPath, ts.sys.readFile);
  if (configFile.error) {
    return null;
  }

  const rawConfig = configFile.config || {};
  const parsed = ts.parseJsonConfigFileContent(rawConfig, ts.sys, path.dirname(absoluteConfigPath));
  const filePaths = parsed.fileNames
    .filter((filePath) => isRepoOwned(root, filePath))
    .map((filePath) => normalizeRepoPath(path.relative(root, filePath)))
    .filter((filePath) => isTsJsFile(filePath) && shouldTreatAsOwned(filePath))
    .sort();
  const normalizedConfigPath = normalizeRepoPath(configPath);

  return {
    id: `config:${normalizedConfigPath}`,
    configPath: normalizedConfigPath,
    projectRoot: normalizeRepoPath(path.dirname(normalizedConfigPath)),
    inferred: false,
    intent: classifyProjectIntent(normalizedConfigPath, rawConfig),
    filePaths,
    rawConfig,
  };
}

function defaultCompilerConfig(root, filePaths) {
  return {
    id: "inferred:root",
    configPath: null,
    projectRoot: ".",
    inferred: true,
    filePaths,
  };
}

async function computeFingerprint(root, filePaths) {
  const entries = [];
  for (const filePath of filePaths) {
    try {
      const content = await fs.readFile(path.join(root, filePath), "utf8");
      entries.push(`${filePath}:${crypto.createHash("sha256").update(content).digest("hex")}`);
    } catch {
      // Ignore unreadable files.
    }
  }
  return crypto.createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}

function normalizeSourceFiles(files, language) {
  return files
    .filter((fileInfo) => fileInfo.language === language)
    .map((fileInfo) => normalizeRepoPath(fileInfo.path))
    .filter(shouldTreatAsOwned)
    .sort();
}

function findFirstConfig(repoFiles, candidates) {
  return candidates.find((candidate) => repoFiles.includes(candidate)) || null;
}

function semanticAdapterConfig(config, adapterId) {
  return config.semantic?.[adapterId] || {};
}

export function isSemanticEnabled(config) {
  return Boolean(
    config.semantic?.enabled
      || config.semantic?.tsjs?.enabled
      || GENERIC_SEMANTIC_ADAPTERS.some((adapter) => semanticAdapterConfig(config, adapter.id).enabled)
  );
}

function isSemanticAdapterEnabled(config, adapterId) {
  if (adapterId === "tsjs") {
    return Boolean(config.semantic?.enabled || config.semantic?.tsjs?.enabled);
  }
  const adapterConfig = semanticAdapterConfig(config, adapterId);
  return Boolean(
    adapterConfig.enabled
      || (config.semantic?.enabled && adapterConfig.enabled !== false)
  );
}

function genericAnalyzerVersion(config, adapterId) {
  return semanticAdapterConfig(config, adapterId).analyzerVersion || `semantic-${adapterId}-v1`;
}

function groupGenericProjects(root, repoIndex, adapter, config) {
  const repoFiles = repoIndex.files.map((fileInfo) => normalizeRepoPath(fileInfo.path)).sort();
  const filePaths = normalizeSourceFiles(repoIndex.files, adapter.language)
    .filter((filePath) => adapter.includeTests || !adapter.isTestFile?.(filePath));
  if (filePaths.length === 0) {
    return [];
  }

  const configPath = adapter.configPath(root, repoFiles, ".");
  const groups = [{
    id: `${adapter.id}:root`,
    configPath,
    projectRoot: ".",
    inferred: configPath ? false : true,
    filePaths,
  }];

  const analyzerVersion = genericAnalyzerVersion(config, adapter.id);
  return groups.map((project) => ({
    ...project,
    adapterId: adapter.id,
    analyzerVersion,
    schemaVersion: `semantic-${adapter.id}-1`,
  }));
}

function symbolIdentity(projectId, filePath, name, kind, startLine, endLine) {
  return `sym_${pathHash(projectId, filePath, name, kind, String(startLine), String(endLine))}`;
}

function semanticSymbolFromStructural(project, symbolInfo) {
  const filePath = normalizeRepoPath(symbolInfo.file_path);
  const startLine = symbolInfo.start_line || 1;
  const endLine = symbolInfo.end_line || startLine;
  const exported = symbolInfo.exported ? 1 : 0;
  return {
    symbol_id: symbolIdentity(project.id, filePath, symbolInfo.name, symbolInfo.kind, startLine, endLine),
    project_id: project.id,
    file_path: filePath,
    name: symbolInfo.name,
    display_name: symbolInfo.name,
    kind: symbolInfo.kind || "symbol",
    export_name: exported ? symbolInfo.name : null,
    start_line: startLine,
    end_line: endLine,
    is_exported: exported,
    is_default: 0,
    domain: domainForFile(filePath),
  };
}

function createGenericSurface(project, symbolInfo) {
  return {
    surface_id: `surface_${pathHash(project.id, symbolInfo.file_path, symbolInfo.symbol_id, "public-api")}`,
    project_id: project.id,
    file_path: symbolInfo.file_path,
    symbol_id: symbolInfo.symbol_id,
    kind: "public-api",
    role: symbolInfo.kind || "symbol",
    surface_key: symbolInfo.export_name || symbolInfo.name,
    display_name: symbolInfo.display_name || symbolInfo.name,
    domain: symbolInfo.domain,
    is_header_target: symbolInfo.domain === "support" ? 0 : 1,
  };
}

function externalPackageForImport(adapterId, specifier) {
  const cleaned = String(specifier || "").trim().replace(/^["']|["']$/g, "");
  if (!cleaned) {
    return null;
  }
  if (adapterId === "python") {
    const withoutRelativePrefix = cleaned.replace(/^\.+/, "");
    return withoutRelativePrefix.split(".").filter(Boolean)[0] || null;
  }
  if (adapterId === "go") {
    return cleaned;
  }
  if (adapterId === "java" || adapterId === "dotnet") {
    const parts = cleaned.split(".").filter(Boolean);
    return parts.length > 1 ? parts.slice(0, -1).join(".") : cleaned;
  }
  return cleaned.split(/[/.]/).filter(Boolean)[0] || null;
}

function createSemanticEdge(project, adapterId, importInfo, symbolByFile) {
  const fromFilePath = normalizeRepoPath(importInfo.from_path);
  const toFilePath = importInfo.to_path ? normalizeRepoPath(importInfo.to_path) : null;
  const fromSymbolId = symbolByFile.get(fromFilePath)?.symbol_id || null;
  const toSymbolId = toFilePath ? symbolByFile.get(toFilePath)?.symbol_id || null : null;
  const externalPackage = toFilePath ? null : externalPackageForImport(adapterId, importInfo.specifier);
  if (!toFilePath && !externalPackage) {
    return null;
  }
  return {
    project_id: project.id,
    from_symbol_id: fromSymbolId,
    to_symbol_id: toSymbolId,
    from_file_path: fromFilePath,
    to_file_path: toFilePath,
    to_external_package: externalPackage,
    edge_kind: importInfo.kind || "imports",
    edge_domain: "runtime",
    confidence: toFilePath ? 0.85 : 0.65,
    source: `${adapterId}-semantic-adapter`,
    metadata_json: JSON.stringify({ specifier: importInfo.specifier }),
  };
}

function buildGenericSnapshot(repoIndex, project, adapter) {
  const projectFiles = new Set(project.filePaths.map(normalizeRepoPath));
  const structuralSymbols = repoIndex.symbols
    .filter((symbolInfo) => projectFiles.has(normalizeRepoPath(symbolInfo.file_path)));
  const symbols = structuralSymbols.map((symbolInfo) => semanticSymbolFromStructural(project, symbolInfo));
  const symbolByFile = new Map();
  for (const symbolInfo of symbols) {
    if (!symbolByFile.has(symbolInfo.file_path) || symbolInfo.is_exported) {
      symbolByFile.set(symbolInfo.file_path, symbolInfo);
    }
  }

  const surfaces = symbols
    .filter((symbolInfo) => symbolInfo.is_exported && symbolInfo.domain !== "support")
    .map((symbolInfo) => createGenericSurface(project, symbolInfo));

  const externalPackages = new Map();
  const edgeDedup = new Set();
  const symbolEdges = [];
  for (const importInfo of repoIndex.imports) {
    const fromFilePath = normalizeRepoPath(importInfo.from_path);
    if (!projectFiles.has(fromFilePath)) {
      continue;
    }
    const edge = createSemanticEdge(project, adapter.id, importInfo, symbolByFile);
    if (!edge) {
      continue;
    }
    const dedupeKey = JSON.stringify([
      edge.from_file_path,
      edge.to_file_path,
      edge.to_external_package,
      edge.edge_kind,
      edge.metadata_json,
    ]);
    if (edgeDedup.has(dedupeKey)) {
      continue;
    }
    edgeDedup.add(dedupeKey);
    symbolEdges.push(edge);
    if (edge.to_external_package) {
      externalPackages.set(edge.to_external_package, (externalPackages.get(edge.to_external_package) || 0) + 1);
    }
  }

  const contentEntries = project.filePaths.map((filePath) => {
    const fileInfo = repoIndex.files.find((item) => normalizeRepoPath(item.path) === filePath);
    return `${filePath}:${fileInfo?.fingerprint || ""}`;
  });
  const publicEntries = [
    ...symbols.filter((symbol) => symbol.is_exported).map((symbol) => `export:${symbol.file_path}:${symbol.export_name}:${symbol.kind}`),
    ...surfaces.map((surface) => `surface:${surface.kind}:${surface.surface_key}:${surface.role}:${surface.file_path}`),
  ];

  return {
    project: {
      project_id: project.id,
      config_path: project.configPath || null,
      project_root: project.projectRoot || ".",
      inferred: project.inferred ? 1 : 0,
      analyzer_version: project.analyzerVersion,
      schema_version: project.schemaVersion,
      status: "ready",
      coverage_ratio: 1,
      file_count: project.filePaths.length,
      symbol_count: symbols.length,
      surface_count: surfaces.length,
      edge_count: symbolEdges.length,
      content_fingerprint: sha256(contentEntries.sort().join("\n")),
      public_fingerprint: sha256(publicEntries.sort().join("\n")),
      refreshed_at: new Date().toISOString(),
      last_error: null,
    },
    files: project.filePaths.map((filePath) => ({
      project_id: project.id,
      file_path: filePath,
      domain: domainForFile(filePath),
      is_header_target: surfaces.some((surface) => surface.file_path === filePath) ? 1 : 0,
    })),
    externalPackages: Array.from(externalPackages.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([packageName, usageCount]) => ({
      project_id: project.id,
      package_name: packageName,
      usage_count: usageCount,
    })),
    symbols,
    surfaces,
    symbolEdges,
  };
}

const GENERIC_SEMANTIC_ADAPTERS = [
  {
    id: "python",
    stack: "python",
    language: "python",
    configPath(_root, repoFiles) {
      return findFirstConfig(repoFiles, ["pyproject.toml", "setup.py", "requirements.txt"]);
    },
  },
  {
    id: "go",
    stack: "go",
    language: "go",
    isTestFile: (filePath) => filePath.endsWith("_test.go"),
    configPath(_root, repoFiles) {
      return findFirstConfig(repoFiles, ["go.mod"]);
    },
  },
  {
    id: "java",
    stack: "java",
    language: "java",
    configPath(_root, repoFiles, moduleRoot = ".") {
      const rootPath = normalizeRepoPath(moduleRoot || ".");
      const candidates = rootPath === "."
        ? ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]
        : [`${rootPath}/pom.xml`, `${rootPath}/build.gradle`, `${rootPath}/build.gradle.kts`];
      return findFirstConfig(repoFiles, candidates);
    },
  },
  {
    id: "dotnet",
    stack: "dotnet",
    language: "dotnet",
    configPath(_root, repoFiles, moduleRoot = ".") {
      const rootPath = normalizeRepoPath(moduleRoot || ".");
      const candidates = repoFiles.filter((filePath) => {
        if (!filePath.endsWith(".sln") && !filePath.endsWith(".csproj")) {
          return false;
        }
        return rootPath === "." || filePath.startsWith(`${rootPath}/`);
      });
      return candidates.sort()[0] || null;
    },
  },
];

export async function discoverSemanticProjects(root, config = {}) {
  const relFiles = (await walkFiles(root, { respectIgnore: true })).map((file) => relative(root, file)).sort();
  const tsJsFiles = relFiles.filter(isTsJsFile);
  const configFiles = relFiles.filter(isConfigCandidate).map(normalizeRepoPath).sort();
  const knownConfigs = new Set(configFiles);
  const parsedProjects = [];

  for (const configPath of configFiles) {
    const project = await loadConfiguredProject(root, configPath);
    if (!project) {
      continue;
    }
    parsedProjects.push(project);
  }

  const extendedConfigs = new Set();
  for (const project of parsedProjects) {
    const extended = resolveExtendedConfigPath(project.configPath, project.rawConfig?.extends, knownConfigs);
    if (extended) {
      extendedConfigs.add(extended);
    }
  }

  const configuredProjects = [];
  for (const project of parsedProjects) {
    if (project.filePaths.length === 0) {
      continue;
    }
    if (extendedConfigs.has(project.configPath) && !hasExplicitProjectInputs(project.rawConfig)) {
      continue;
    }
    configuredProjects.push(project);
  }

  const candidatesByFile = new Map();
  for (const project of configuredProjects) {
    for (const filePath of project.filePaths) {
      if (!candidatesByFile.has(filePath)) {
        candidatesByFile.set(filePath, []);
      }
      candidatesByFile.get(filePath).push(project);
    }
  }

  const assignedFiles = new Set();
  const projects = [];
  for (const project of configuredProjects) {
    const ownedFiles = project.filePaths.filter((filePath) => {
      const candidates = candidatesByFile.get(filePath) || [];
      const winner = [...candidates].sort((left, right) => {
        const scoreDelta = filePriority(right, filePath) - filePriority(left, filePath);
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        const sizeDelta = left.filePaths.length - right.filePaths.length;
        if (sizeDelta !== 0) {
          return sizeDelta;
        }
        return left.configPath.localeCompare(right.configPath);
      })[0];
      return winner?.id === project.id;
    });

    if (ownedFiles.length === 0) {
      continue;
    }
    ownedFiles.forEach((filePath) => assignedFiles.add(filePath));
    projects.push({
      id: project.id,
      configPath: project.configPath,
      projectRoot: project.projectRoot,
      inferred: false,
      filePaths: ownedFiles,
    });
  }

  const uncovered = tsJsFiles.filter((filePath) => !assignedFiles.has(filePath));
  if (uncovered.length > 0) {
    projects.push(defaultCompilerConfig(root, uncovered));
  }

  const tsAnalyzerVersion = config.semantic?.tsjs?.analyzerVersion || "semantic-tsjs-v1";
  return projects.map((project) => ({
    ...project,
    adapterId: "tsjs",
    analyzerVersion: tsAnalyzerVersion,
    schemaVersion: "semantic-tsjs-1",
  }));
}

async function discoverAllSemanticProjects(root, config) {
  const tsProjects = isSemanticAdapterEnabled(config, "tsjs")
    ? await discoverSemanticProjects(root, config)
    : [];
  const enabledGenericAdapters = GENERIC_SEMANTIC_ADAPTERS
    .filter((adapter) => isSemanticAdapterEnabled(config, adapter.id));
  const repoIndex = enabledGenericAdapters.length > 0
    ? await buildRepositoryIndex(root, config)
    : null;
  const genericProjects = repoIndex
    ? enabledGenericAdapters.flatMap((adapter) => groupGenericProjects(root, repoIndex, adapter, config))
    : [];
  return { projects: [...tsProjects, ...genericProjects], repoIndex };
}

function shouldRefreshProject(project, existing, contentFingerprint) {
  if (!existing) {
    return true;
  }
  if (existing.status !== "ready") {
    return true;
  }
  if (existing.analyzer_version !== project.analyzerVersion) {
    return true;
  }
  if (existing.content_fingerprint !== contentFingerprint) {
    return true;
  }
  return false;
}

async function analyzeTsJsProject(root, project, config) {
  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "semantic-worker.js");
  const args = [
    `--max-old-space-size=${config.semantic?.tsjs?.memoryMb || 1536}`,
    workerPath,
    root,
    JSON.stringify({
      project,
      analyzerVersion: config.semantic?.tsjs?.analyzerVersion || "semantic-tsjs-v1",
    }),
  ];

  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: root,
    timeout: config.semantic?.tsjs?.timeoutMs || 45000,
    maxBuffer: 50 * 1024 * 1024,
  });

  return JSON.parse(stdout);
}

async function analyzeProject(root, project, config, repoIndex) {
  if (project.adapterId === "tsjs") {
    return analyzeTsJsProject(root, project, config);
  }
  const adapter = GENERIC_SEMANTIC_ADAPTERS.find((item) => item.id === project.adapterId);
  if (!adapter) {
    throw new Error(`No semantic adapter registered for ${project.adapterId}`);
  }
  return buildGenericSnapshot(repoIndex, project, adapter);
}

function buildStatusSummary(projects, refreshedIds) {
  return projects.map((project) => ({
    project_id: project.project_id,
    config_path: project.config_path,
    project_root: project.project_root,
    inferred: Boolean(project.inferred),
    status: project.status,
    coverage: project.coverage_ratio,
    content_fingerprint: project.content_fingerprint,
    public_fingerprint: project.public_fingerprint,
    refreshed: refreshedIds.has(project.project_id),
    symbol_count: project.symbol_count,
    surface_count: project.surface_count,
    edge_count: project.edge_count,
  }));
}

export async function runSemanticRefresh(root, config, options = {}) {
  if (!isSemanticEnabled(config)) {
    const result = {
      command: "semantic",
      enabled: false,
      refreshed_projects: [],
      skipped_projects: [],
      reason: "semantic.enabled is false",
    };
    if (!options.skipOutput && (config.json || !options.silent)) {
      console.log(JSON.stringify(result, null, 2));
    }
    return result;
  }

  const artifactRoot = options.artifactRoot || root;
  if (!config.dryRun) {
    await ensureDir(path.join(artifactRoot, ".agents"));
  }
  const db = openIndexDatabase(artifactRoot);
  const { projects: discoveredProjects, repoIndex } = await discoverAllSemanticProjects(root, config);
  const existingProjects = new Map(listSemanticProjects(db).map((item) => [item.project_id, item]));
  const refreshedIds = new Set();
  const refreshed = [];
  const skipped = [];

  try {
    const discoveredIds = new Set(discoveredProjects.map((project) => project.id));
    for (const existingProjectId of existingProjects.keys()) {
      if (!discoveredIds.has(existingProjectId)) {
        inTransaction(db, () => {
          clearSemanticProjectState(db, existingProjectId);
        });
      }
    }

    for (const project of discoveredProjects) {
      const contentFingerprint = await computeFingerprint(root, project.filePaths);
      const existing = existingProjects.get(project.id);
      if (!shouldRefreshProject(project, existing, contentFingerprint)) {
        skipped.push(project.id);
        continue;
      }

      const snapshot = await analyzeProject(root, project, config, repoIndex);
      inTransaction(db, () => {
        replaceSemanticProjectSnapshot(db, snapshot);
        upsertSemanticMeta(db, "semantic_enabled", true);
        upsertSemanticMeta(db, `semantic_${project.adapterId}_enabled`, true);
        upsertSemanticMeta(db, `semantic_${project.adapterId}_analyzer_version`, project.analyzerVersion);
      });
      refreshedIds.add(project.id);
      refreshed.push(project.id);
    }
  } finally {
    const projects = listSemanticProjects(db);
    const result = {
      command: "semantic",
      enabled: true,
      refreshed_projects: refreshed,
      skipped_projects: skipped,
      projects: buildStatusSummary(projects, refreshedIds),
    };
    closeIndexDatabase(db);
    if (!options.skipOutput && (config.json || !options.silent)) {
      console.log(JSON.stringify(result, null, 2));
    }
  }

  return {
    command: "semantic",
    enabled: true,
    refreshed_projects: refreshed,
    skipped_projects: skipped,
  };
}

function renderSemanticSurfaceGroups(title, groups, mapper, emptyLine) {
  if (groups.length === 0) {
    return `## ${title}\n${emptyLine}`;
  }
  return `## ${title}\n${groups.map(mapper).join("\n")}`;
}

export function renderSemanticRepoMap(root, meta, modules, semanticProjects, routeSurfaces, reactSurfaces) {
  const structuralEntrypoints = modules.flatMap((moduleInfo) => moduleInfo.entry_files || []);
  const projectLines = semanticProjects.length > 0
    ? semanticProjects.map((project) => `- \`${project.config_path || "inferred"}\` (${project.status}, ${project.file_count} files, ${project.symbol_count} symbols, ${project.edge_count} edges)`)
    : ["- No semantic projects indexed."];
  const routeLines = routeSurfaces.length > 0
    ? routeSurfaces.map((surface) => `- \`${surface.surface_key}\` (${surface.role}) -> \`${surface.file_path}\``)
    : ["- No route surfaces detected."];
  const reactLines = reactSurfaces.length > 0
    ? reactSurfaces.map((surface) => `- \`${surface.display_name}\` (${surface.role}) -> \`${surface.file_path}\``)
    : ["- No exported React surfaces detected."];

  return `# Repo Map

## Stacks
${(meta.detected_stacks || []).map((stack) => `- \`${stack.name}\` (${stack.confidence})`).join("\n") || "- No stacks detected."}

## Entrypoints
${structuralEntrypoints.length > 0 ? structuralEntrypoints.map((entry) => `- \`${entry}\``).join("\n") : "- No entrypoints detected."}

## Modules
${modules.map((moduleInfo) => {
  const relativePath = path.posix.relative("docs", moduleInfo.doc_path);
  const href = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
  return `- [${moduleInfo.name}](${href})`;
}).join("\n")}

## Semantic Projects
${projectLines.join("\n")}

## Routes
${routeLines.join("\n")}

## React Surfaces
${reactLines.join("\n")}
`;
}

function clipList(items, limit) {
  return Array.from(new Set(items.filter(Boolean))).slice(0, limit);
}

function buildDeterministicSummary(facts) {
  const runtimeDeps = clipList(facts.runtimeDeps, 5);
  const exports = clipList(facts.exports, 5);
  const parts = [];
  if (facts.surface) {
    if (facts.surface.kind === "route" && facts.surface.surfaceKey) {
      parts.push(`${facts.surface.role || "route"} for ${facts.surface.surfaceKey}`);
    } else if (facts.surface.displayName) {
      parts.push(`${facts.surface.role || facts.surface.kind} ${facts.surface.displayName}`);
    }
  }
  if (exports.length > 0) {
    parts.push(`exports ${exports.join(", ")}`);
  }
  if (runtimeDeps.length > 0) {
    parts.push(`runtime deps: ${runtimeDeps.join(", ")}`);
  }
  if (parts.length === 0) {
    parts.push("Semantic facts indexed from the project graph");
  }
  const summary = parts.join("; ");
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

export async function applySemanticHeaders(root, artifactRoot, config, { ghost = false } = {}) {
  if (!isSemanticEnabled(config) || config.dryRun) {
    return { plannedHeaders: [], changed: 0 };
  }

  const db = openIndexDatabase(artifactRoot);
  try {
    const files = loadFiles(db);
    const modules = loadModules(db);
    const moduleByPath = new Map(files.filter((fileInfo) => fileInfo.module_id).map((fileInfo) => {
      const moduleInfo = modules.find((item) => item.id === fileInfo.module_id);
      return [fileInfo.path, moduleInfo];
    }));

    const fileFacts = loadSemanticProjectFactsByFile(db);
    const selected = fileFacts.filter((facts) => facts.is_header_target);
    const plannedHeaders = [];
    let changed = 0;

    for (const facts of selected) {
      const moduleInfo = moduleByPath.get(facts.file_path);
      const payload = {
        summary: buildDeterministicSummary(facts),
        project: facts.project_label,
        surface: facts.surface ? {
          kind: facts.surface.kind,
          role: facts.surface.role,
          surfaceKey: facts.surface.surfaceKey,
          displayName: facts.surface.displayName,
        } : null,
        exports: clipList(facts.exports, 5),
        runtimeDeps: clipList(facts.runtimeDeps, 5),
        typeDeps: clipList(facts.typeDeps, 3),
        freshness: facts.status || "ready",
        schema: "semantic-v1",
      };

      if (ghost) {
        plannedHeaders.push({
          path: facts.file_path,
          module: moduleInfo?.name || path.basename(path.dirname(facts.file_path)),
          summary: payload.summary,
          action: "would_update",
        });
        continue;
      }

      const update = await updateFileHeader(
        root,
        moduleInfo?.name || path.basename(path.dirname(facts.file_path)),
        facts.file_path,
        payload,
        moduleInfo?.stack || "ts"
      );
      if (update.changed) {
        changed += 1;
      }
    }

    return { plannedHeaders, changed };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function writeSemanticRepoMap(root, artifactRoot) {
  const db = openIndexDatabase(artifactRoot);
  try {
    const meta = getRepoMeta(db);
    const modules = loadModules(db);
    const semanticProjects = listSemanticProjects(db);
    const routeSurfaces = loadSemanticRouteSurfaces(db);
    const reactSurfaces = loadSemanticReactSurfaces(db);
    const rendered = renderSemanticRepoMap(root, meta, modules, semanticProjects, routeSurfaces, reactSurfaces);
    await writeText(path.join(artifactRoot, "docs", "repo-map.md"), rendered);
    return rendered;
  } finally {
    closeIndexDatabase(db);
  }
}
