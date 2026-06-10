import fs from "node:fs/promises";
import path from "node:path";

import { garbageCollect } from "./cache.js";
import { exists, readJson, relative, walkFiles } from "./fs.js";
import { closeIndexDatabase, openIndexDatabase } from "./db/connection.js";
import { loadModules } from "./db/structural-store.js";
import { resolveAgentifyPaths } from "./project-store.js";

function toArray(paths) {
  return Array.from(new Set(paths)).sort();
}

async function removePath(targetPath, dryRun) {
  if (dryRun) {
    return;
  }
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function listFiles(dirPath) {
  if (!(await exists(dirPath))) {
    return [];
  }
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

async function listDirs(dirPath) {
  if (!(await exists(dirPath))) {
    return [];
  }
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function normalizeRepoPath(repoPath) {
  if (!repoPath) {
    return null;
  }
  return repoPath.split(/[\\/]+/).filter(Boolean).join("/");
}

function addExpectedDocPath(expectedDocs, docPath) {
  const normalized = normalizeRepoPath(docPath);
  if (normalized) {
    expectedDocs.add(normalized);
  }
}

async function listModuleRootDocs(root) {
  const docs = [];
  for (const filePath of await walkFiles(root)) {
    if (path.basename(filePath) !== "AGENTIFY.md") {
      continue;
    }
    const relativePath = relative(root, filePath);
    if (
      relativePath === "AGENTIFY.md" ||
      relativePath.startsWith(".agentify/") ||
      relativePath.startsWith(".current_session/") ||
      relativePath.startsWith("docs/")
    ) {
      continue;
    }
    docs.push(relativePath);
  }
  return docs;
}

async function pruneOrphanedModuleArtifacts(root, dryRun, agentifyPaths) {
  const expectedDocs = new Set();
  const expectedMetadata = new Set();
  if (await exists(agentifyPaths.indexDb)) {
    const db = openIndexDatabase(agentifyPaths);
    try {
      for (const moduleInfo of loadModules(db)) {
        addExpectedDocPath(expectedDocs, moduleInfo.doc_path);
      }
    } finally {
      closeIndexDatabase(db);
    }
  } else if (await exists(agentifyPaths.legacyIndexJson)) {
    const legacyIndex = await readJson(agentifyPaths.legacyIndexJson);
    for (const moduleInfo of legacyIndex.modules || []) {
      addExpectedDocPath(expectedDocs, moduleInfo.doc_path);
      if (moduleInfo.metadata_path) {
        expectedMetadata.add(path.basename(moduleInfo.metadata_path));
      }
    }
  } else {
    return {
      removed: [],
      skipped: "missing-index",
    };
  }

  const docsDir = path.join(root, "docs", "modules");
  const removed = [];

  for (const file of await listFiles(docsDir)) {
    const relativePath = `docs/modules/${file}`;
    if (!file.endsWith(".md") || expectedDocs.has(relativePath)) {
      continue;
    }
    await removePath(path.join(docsDir, file), dryRun);
    removed.push(relativePath);
  }

  for (const relativePath of await listModuleRootDocs(root)) {
    if (expectedDocs.has(relativePath)) {
      continue;
    }
    await removePath(path.join(root, relativePath), dryRun);
    removed.push(relativePath);
  }

  const metadataDir = agentifyPaths.modulesRoot;
  for (const file of await listFiles(metadataDir)) {
    if (!file.endsWith(".json") || expectedMetadata.has(file)) {
      continue;
    }
    await removePath(path.join(metadataDir, file), dryRun);
    removed.push(`.agentify/modules/${file}`);
  }

  return {
    removed: toArray(removed),
    skipped: null,
  };
}

async function pruneRetainedFiles(dirPath, {
  keep = 0,
  maxAgeDays = 0,
  matcher = () => true,
  relativePrefix,
  dryRun,
}) {
  if (!(await exists(dirPath))) {
    return [];
  }

  const now = Date.now();
  const cutoff = maxAgeDays > 0 ? now - (maxAgeDays * 86400000) : null;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isFile() || !matcher(entry.name)) {
      continue;
    }
    const absolutePath = path.join(dirPath, entry.name);
    const stat = await fs.stat(absolutePath);
    candidates.push({
      name: entry.name,
      absolutePath,
      mtimeMs: stat.mtimeMs,
    });
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));

  const removed = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const tooMany = index >= keep;
    const tooOld = cutoff !== null && candidate.mtimeMs < cutoff;
    if (!tooMany && !tooOld) {
      continue;
    }
    await removePath(candidate.absolutePath, dryRun);
    removed.push(`${relativePrefix}/${candidate.name}`);
  }

  return toArray(removed);
}

async function pruneRetainedDirs(dirPath, {
  keep = 0,
  maxAgeDays = 0,
  nameMatcher = () => true,
  relativePrefix,
  dryRun,
}) {
  if (!(await exists(dirPath))) {
    return [];
  }

  const now = Date.now();
  const cutoff = maxAgeDays > 0 ? now - (maxAgeDays * 86400000) : null;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !nameMatcher(entry.name)) {
      continue;
    }
    const absolutePath = path.join(dirPath, entry.name);
    const stat = await fs.stat(absolutePath);
    candidates.push({
      name: entry.name,
      absolutePath,
      mtimeMs: stat.mtimeMs,
    });
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));

  const removed = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const tooMany = index >= keep;
    const tooOld = cutoff !== null && candidate.mtimeMs < cutoff;
    if (!tooMany && !tooOld) {
      continue;
    }
    await removePath(candidate.absolutePath, dryRun);
    removed.push(`${relativePrefix}/${candidate.name}`);
  }

  return toArray(removed);
}

async function pruneInvalidSessionDirs(root, dryRun, enabled, agentifyPaths) {
  if (!enabled) {
    return [];
  }

  const sessionsRoot = agentifyPaths.sessionRoot;
  const removed = [];
  for (const dirName of await listDirs(sessionsRoot)) {
    const manifestPath = path.join(sessionsRoot, dirName, "session-manifest.json");
    if (await exists(manifestPath)) {
      continue;
    }
    await removePath(path.join(sessionsRoot, dirName), dryRun);
    removed.push(`.agentify/session/${dirName}`);
  }
  return toArray(removed);
}

async function prunePlannedArtifacts(root, dryRun, enabled, agentifyPaths) {
  if (!enabled) {
    return [];
  }
  const plannedRoot = agentifyPaths.plannedRoot;
  const removed = [];
  for (const fileName of await listFiles(plannedRoot)) {
    if (!fileName.endsWith(".md")) {
      continue;
    }
    await removePath(path.join(plannedRoot, fileName), dryRun);
    removed.push(`.agentify/planned/${fileName}`);
  }
  return toArray(removed);
}

async function pruneAfkSessionDirs(root, dryRun, enabled, agentifyPaths) {
  if (!enabled) {
    return [];
  }
  const sessionsRoot = agentifyPaths.sessionRoot;
  const removed = [];
  for (const dirName of await listDirs(sessionsRoot)) {
    if (!dirName.startsWith("afk_")) {
      continue;
    }
    await removePath(path.join(sessionsRoot, dirName), dryRun);
    removed.push(`.agentify/session/${dirName}`);
  }
  return toArray(removed);
}

async function pruneEmptyDirs(basePath, dryRun) {
  const removed = [];

  async function visit(currentPath, relativePath = "") {
    if (!(await exists(currentPath))) {
      return false;
    }

    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    let hasContents = false;

    for (const entry of entries) {
      const childPath = path.join(currentPath, entry.name);
      const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const childHasContents = await visit(childPath, childRelative);
        if (childHasContents) {
          hasContents = true;
        }
      } else {
        hasContents = true;
      }
    }

    if (!hasContents && relativePath) {
      await removePath(currentPath, dryRun);
      removed.push(relativePath);
      return false;
    }

    return hasContents;
  }

  await visit(basePath);
  return toArray(removed);
}

export async function runClean(root, config, options = {}) {
  const dryRun = Boolean(config.dryRun);
  const cleanupConfig = config.cleanup || {};
  const cleanPlanned = options.planned === true || options.all === true;
  const cleanSessions = options.sessions === true || options.all === true;
  const agentifyPaths = config._agentifyPaths || await resolveAgentifyPaths(root, config);

  const orphaned = await pruneOrphanedModuleArtifacts(root, dryRun, agentifyPaths);
  const runReports = await pruneRetainedFiles(agentifyPaths.runsRoot, {
    keep: cleanupConfig.keepRuns ?? 20,
    maxAgeDays: cleanupConfig.maxRunAgeDays ?? 14,
    matcher: (name) => name.endsWith(".json"),
    relativePrefix: ".agentify/runs",
    dryRun,
  });
  const ghostRuns = await pruneRetainedDirs(path.join(root, ".current_session"), {
    keep: cleanupConfig.keepGhostRuns ?? 3,
    maxAgeDays: cleanupConfig.maxGhostAgeDays ?? 3,
    nameMatcher: (name) => name.startsWith("ghost_"),
    relativePrefix: ".current_session",
    dryRun,
  });
  const invalidSessions = await pruneInvalidSessionDirs(root, dryRun, cleanupConfig.pruneInvalidSessions !== false, agentifyPaths);
  const plannedArtifacts = await prunePlannedArtifacts(root, dryRun, cleanPlanned, agentifyPaths);
  const afkSessions = await pruneAfkSessionDirs(root, dryRun, cleanSessions, agentifyPaths);
  const cacheRemoved = cleanupConfig.pruneCache === false
    ? 0
    : (await garbageCollect(agentifyPaths.cacheRoot, config.cache?.maxAgeDays || 7, { dryRun })).removed;

  const emptyDirs = [
    ...(await pruneEmptyDirs(path.join(root, "docs", "modules"), dryRun)).map((item) => `docs/modules/${item}`),
    ...(await pruneEmptyDirs(agentifyPaths.modulesRoot, dryRun)).map((item) => `.agentify/modules/${item}`),
    ...(await pruneEmptyDirs(agentifyPaths.runsRoot, dryRun)).map((item) => `.agentify/runs/${item}`),
    ...(await pruneEmptyDirs(agentifyPaths.plannedRoot, dryRun)).map((item) => `.agentify/planned/${item}`),
    ...(await pruneEmptyDirs(agentifyPaths.sessionRoot, dryRun)).map((item) => `.agentify/session/${item}`),
    ...(await pruneEmptyDirs(path.join(root, ".current_session"), dryRun)).map((item) => `.current_session/${item}`),
    ...(await pruneEmptyDirs(agentifyPaths.cacheRoot, dryRun)).map((item) => `.agentify/cache/${item}`),
  ];

  const removedPaths = toArray([
    ...orphaned.removed,
    ...runReports,
    ...ghostRuns,
    ...invalidSessions,
    ...plannedArtifacts,
    ...afkSessions,
    ...emptyDirs,
  ]);

  return {
    command: "clean",
    dry_run: dryRun,
    removed_count: removedPaths.length + cacheRemoved,
    removed_paths: removedPaths,
    removed_cache_blobs: cacheRemoved,
    orphaned_module_artifacts: orphaned.removed,
    stale_run_reports: runReports,
    stale_ghost_runs: ghostRuns,
    invalid_sessions: invalidSessions,
    planned_artifacts: plannedArtifacts,
    afk_sessions: afkSessions,
    empty_dirs: toArray(emptyDirs),
    skipped: orphaned.skipped ? ["module-artifacts:no-index"] : [],
  };
}
