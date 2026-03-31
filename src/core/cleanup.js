import fs from "node:fs/promises";
import path from "node:path";

import { garbageCollect } from "./cache.js";
import { exists, readJson } from "./fs.js";
import { closeIndexDatabase, listArtifacts, loadModules, openIndexDatabase } from "./db.js";

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

async function pruneOrphanedModuleArtifacts(root, dryRun) {
  const expectedDocs = new Set();
  if (await exists(path.join(root, ".agents", "index.db"))) {
    const db = openIndexDatabase(root);
    try {
      for (const moduleInfo of loadModules(db)) {
        expectedDocs.add(path.basename(moduleInfo.doc_path || ""));
      }
    } finally {
      closeIndexDatabase(db);
    }
  } else if (await exists(path.join(root, ".agents", "index.json"))) {
    const legacyIndex = await readJson(path.join(root, ".agents", "index.json"));
    for (const moduleInfo of legacyIndex.modules || []) {
      expectedDocs.add(path.basename(moduleInfo.doc_path || ""));
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
    if (!file.endsWith(".md") || expectedDocs.has(file)) {
      continue;
    }
    await removePath(path.join(docsDir, file), dryRun);
    removed.push(`docs/modules/${file}`);
  }

  const metadataDir = path.join(root, ".agents", "modules");
  for (const file of await listFiles(metadataDir)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    await removePath(path.join(metadataDir, file), dryRun);
    removed.push(`.agents/modules/${file}`);
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

async function pruneInvalidSessionDirs(root, dryRun, enabled) {
  if (!enabled) {
    return [];
  }

  const sessionsRoot = path.join(root, ".agents", "session");
  const removed = [];
  for (const dirName of await listDirs(sessionsRoot)) {
    const manifestPath = path.join(sessionsRoot, dirName, "session-manifest.json");
    if (await exists(manifestPath)) {
      continue;
    }
    await removePath(path.join(sessionsRoot, dirName), dryRun);
    removed.push(`.agents/session/${dirName}`);
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

export async function runClean(root, config) {
  const dryRun = Boolean(config.dryRun);
  const cleanupConfig = config.cleanup || {};

  const orphaned = await pruneOrphanedModuleArtifacts(root, dryRun);
  const runReports = await pruneRetainedFiles(path.join(root, ".agents", "runs"), {
    keep: cleanupConfig.keepRuns ?? 20,
    maxAgeDays: cleanupConfig.maxRunAgeDays ?? 14,
    matcher: (name) => name.endsWith(".json"),
    relativePrefix: ".agents/runs",
    dryRun,
  });
  const ghostRuns = await pruneRetainedDirs(path.join(root, ".current_session"), {
    keep: cleanupConfig.keepGhostRuns ?? 3,
    maxAgeDays: cleanupConfig.maxGhostAgeDays ?? 3,
    nameMatcher: (name) => name.startsWith("ghost_"),
    relativePrefix: ".current_session",
    dryRun,
  });
  const invalidSessions = await pruneInvalidSessionDirs(root, dryRun, cleanupConfig.pruneInvalidSessions !== false);
  const cacheRemoved = cleanupConfig.pruneCache === false
    ? 0
    : (await garbageCollect(path.join(root, ".agents", "cache"), config.cache?.maxAgeDays || 7, { dryRun })).removed;

  const emptyDirs = [
    ...(await pruneEmptyDirs(path.join(root, "docs", "modules"), dryRun)).map((item) => `docs/modules/${item}`),
    ...(await pruneEmptyDirs(path.join(root, ".agents", "modules"), dryRun)).map((item) => `.agents/modules/${item}`),
    ...(await pruneEmptyDirs(path.join(root, ".agents", "runs"), dryRun)).map((item) => `.agents/runs/${item}`),
    ...(await pruneEmptyDirs(path.join(root, ".agents", "session"), dryRun)).map((item) => `.agents/session/${item}`),
    ...(await pruneEmptyDirs(path.join(root, ".current_session"), dryRun)).map((item) => `.current_session/${item}`),
    ...(await pruneEmptyDirs(path.join(root, ".agents", "cache"), dryRun)).map((item) => `.agents/cache/${item}`),
  ];

  const removedPaths = toArray([
    ...orphaned.removed,
    ...runReports,
    ...ghostRuns,
    ...invalidSessions,
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
    empty_dirs: toArray(emptyDirs),
    skipped: orphaned.skipped ? ["module-artifacts:no-index"] : [],
  };
}
