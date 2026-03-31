import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  closeIndexDatabase,
  clearSemanticProjectState,
  getRepoMeta,
  inTransaction,
  listSemanticProjects,
  loadFiles,
  loadModules,
  openIndexDatabase,
  replaceSemanticProjectSnapshot,
  upsertSemanticMeta,
  loadSemanticProjectFactsByFile,
  loadSemanticRouteSurfaces,
  loadSemanticReactSurfaces,
} from "./db.js";
import { ensureDir, relative, walkFiles, writeText } from "./fs.js";
import { updateFileHeader } from "./headers.js";

const execFileAsync = promisify(execFile);

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function normalizeRepoPath(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

function isTsJsFile(filePath) {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath) && !filePath.endsWith(".d.ts");
}

function isConfigCandidate(filePath) {
  const base = path.basename(filePath);
  return base === "tsconfig.json" || base === "jsconfig.json" || /^tsconfig\..+\.json$/.test(base);
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

export async function discoverSemanticProjects(root) {
  const relFiles = (await walkFiles(root, { respectIgnore: true })).map((file) => relative(root, file)).sort();
  const tsJsFiles = relFiles.filter(isTsJsFile);
  const configFiles = relFiles.filter(isConfigCandidate);
  const projects = [];
  const coveredFiles = new Set();

  for (const configPath of configFiles) {
    const projectRoot = path.dirname(configPath);
    const projectFiles = tsJsFiles.filter((filePath) => projectRoot === "." || filePath.startsWith(`${projectRoot}/`));
    if (projectFiles.length === 0) {
      continue;
    }
    for (const filePath of projectFiles) {
      coveredFiles.add(filePath);
    }
    projects.push({
      id: `config:${configPath}`,
      configPath,
      projectRoot,
      inferred: false,
      filePaths: projectFiles,
    });
  }

  const uncovered = tsJsFiles.filter((filePath) => !coveredFiles.has(filePath));
  if (uncovered.length > 0) {
    projects.push(defaultCompilerConfig(root, uncovered));
  }

  return projects;
}

function shouldRefreshProject(project, existing, analyzerVersion, contentFingerprint) {
  if (!existing) {
    return true;
  }
  if (existing.status !== "ready") {
    return true;
  }
  if (existing.analyzer_version !== analyzerVersion) {
    return true;
  }
  if (existing.content_fingerprint !== contentFingerprint) {
    return true;
  }
  return false;
}

async function analyzeProject(root, project, config) {
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
  if (!config.semantic?.tsjs?.enabled) {
    const result = {
      command: "semantic",
      enabled: false,
      refreshed_projects: [],
      skipped_projects: [],
      reason: "semantic.tsjs.enabled is false",
    };
    if (config.json || !options.silent) {
      console.log(JSON.stringify(result, null, 2));
    }
    return result;
  }

  const artifactRoot = options.artifactRoot || root;
  if (!config.dryRun) {
    await ensureDir(path.join(artifactRoot, ".agents"));
  }
  const db = openIndexDatabase(artifactRoot);
  const discoveredProjects = await discoverSemanticProjects(root);
  const analyzerVersion = config.semantic?.tsjs?.analyzerVersion || "semantic-tsjs-v1";
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
      if (!shouldRefreshProject(project, existing, analyzerVersion, contentFingerprint)) {
        skipped.push(project.id);
        continue;
      }

      const snapshot = await analyzeProject(root, project, config);
      inTransaction(db, () => {
        replaceSemanticProjectSnapshot(db, snapshot);
        upsertSemanticMeta(db, "semantic_tsjs_enabled", true);
        upsertSemanticMeta(db, "semantic_tsjs_analyzer_version", analyzerVersion);
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
    if (config.json || (!options.silent && !options.skipOutput)) {
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
    : ["- No semantic TS/JS projects indexed."];
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
${modules.map((moduleInfo) => `- [${moduleInfo.name}](./modules/${path.basename(moduleInfo.doc_path)})`).join("\n")}

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
    parts.push("Semantic facts indexed from the TypeScript/JavaScript project graph");
  }
  const summary = parts.join("; ");
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

export async function applySemanticHeaders(root, artifactRoot, config, { ghost = false } = {}) {
  if (!config.semantic?.tsjs?.enabled || config.dryRun) {
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
