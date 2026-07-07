import fs from "node:fs/promises";
import path from "node:path";

import { exists } from "./fs.js";
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
    removed_count: removedPaths.length,
    removed_paths: removedPaths,
    stale_run_reports: runReports,
    stale_ghost_runs: ghostRuns,
    invalid_sessions: invalidSessions,
    planned_artifacts: plannedArtifacts,
    afk_sessions: afkSessions,
    empty_dirs: toArray(emptyDirs),
    skipped: [],
  };
}
