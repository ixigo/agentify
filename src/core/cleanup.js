import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { exists, readJson, readText } from "./fs.js";
import {
  isStoreOwnerDir,
  pathContainsAgentifySegment,
  resolveAgentifyPaths,
  resolveSharedBase,
  STORE_KIND,
} from "./project-store.js";
import {
  FULL_BUDGET,
  KNOWN_SKILL_ARTIFACT_DIRS,
  agentifyOwnedNames,
  dirStats,
  measureStore,
} from "./store-size.js";

const execFileAsync = promisify(execFile);

// The only entries a stray/nested store may hold and still be safe to delete.
// events.jsonl and notes.jsonl are MERGED into the owning store; the rest are
// ephemeral (injection ledger, pause marker) or local telemetry/derived data a
// stray has no unique claim to. Anything else — index.db, store.json, cache/,
// repo-map/, embeddings/, eval or harness artifacts, a handoff .md, a symlink —
// marks the store NOT safe, so it is reported and left untouched.
const SAFE_STRAY_FILES = new Set([
  "events.jsonl",
  "notes.jsonl",
  "injected.json",
  "paused",
  "value-events.jsonl",
  "summary-usage.jsonl",
  "summaries.jsonl",
  "acp-capture.jsonl",
  ".lock",
]);
const SAFE_STRAY_DIRS = new Set([".agentify", "context", "archive", "handoffs", "locks"]);
const WALK_SKIP_DIRS = new Set([".git", "node_modules"]);
// Bound the descent inside a store when hunting for nested `.agentify` dirs so a
// multi-GB store does not turn the scan into a full-tree crawl.
const NESTED_SCAN_MAX_DEPTH = 8;

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

async function gitTopLevel(root) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "--show-toplevel"]);
    const trimmed = stdout.trim();
    return trimmed ? path.resolve(trimmed) : null;
  } catch {
    return null;
  }
}

// Collect every `.agentify` directory at or beneath `repoTop`, INCLUDING nested
// ones (`.agentify/.agentify`), without following symlinks and skipping `.git`
// and `node_modules`. Returns absolute paths ending in `.agentify`. The descent
// inside a store is bounded so a huge store does not make this expensive.
async function collectAgentifyDirs(repoTop) {
  const found = [];
  async function walk(dir, insideDepth) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // isDirectory() is false for a symlink (readdir uses lstat), so this also
      // guarantees we never follow a symlink.
      if (!entry.isDirectory() || WALK_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const child = path.join(dir, entry.name);
      if (entry.name === ".agentify") {
        found.push(child);
        await walk(child, 1);
      } else if (insideDepth === 0) {
        await walk(child, 0);
      } else if (insideDepth < NESTED_SCAN_MAX_DEPTH) {
        await walk(child, insideDepth + 1);
      }
    }
  }
  await walk(repoTop, 0);
  return found;
}

// Total size of a directory tree (bytes), skipping `.git`/`node_modules` and not
// following symlinks. Used only to report the size of a store we refuse to touch.
async function dirSize(dir, depth = 0) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name) || depth >= 32) {
        continue;
      }
      total += await dirSize(child, depth + 1);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(child)).size;
      } catch {
        // unreadable file: ignore for the size estimate
      }
    }
  }
  return total;
}

// Classify an `.agentify` directory: is it safe to delete (holds only the
// mergeable/ephemeral files above, in allowed directories), what are its
// mergeable context files, and how big is it. Walks the whole subtree so a
// nested store's own content is judged too.
async function classifyStore(agentifyDir) {
  let safe = true;
  let reason = null;
  const mergeFiles = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      const rel = path.relative(agentifyDir, child);
      if (entry.isSymbolicLink()) {
        safe = false;
        reason = reason || `contains a symlink (${rel})`;
        continue;
      }
      if (entry.isDirectory()) {
        if (!SAFE_STRAY_DIRS.has(entry.name)) {
          safe = false;
          reason = reason || `contains ${rel}/`;
          continue;
        }
        if (depth < NESTED_SCAN_MAX_DEPTH) {
          await walk(child, depth + 1);
        }
        continue;
      }
      if (entry.isFile()) {
        if (!SAFE_STRAY_FILES.has(entry.name)) {
          safe = false;
          reason = reason || `contains ${rel}`;
          continue;
        }
        if (entry.name === "events.jsonl" || entry.name === "notes.jsonl") {
          mergeFiles.push({ fileName: entry.name, absPath: child });
        }
      }
    }
  }
  await walk(agentifyDir, 0);
  const sizeBytes = safe ? 0 : await dirSize(agentifyDir);
  return { safe, reason, sizeBytes, mergeFiles };
}

// The directory that owns the outermost store a (possibly nested) `.agentify`
// path lives in: the segment just before its FIRST `.agentify` component.
function outermostStoreOwner(agentifyPath) {
  const parts = path.resolve(agentifyPath).split(path.sep);
  const index = parts.indexOf(".agentify");
  const owner = parts.slice(0, index).join(path.sep);
  return owner || path.sep;
}

async function readJsonlFile(absPath) {
  if (!(await exists(absPath))) {
    return [];
  }
  return (await readText(absPath)).split(/\r?\n/).filter((line) => line.trim().length > 0);
}

// Merge `extra` lines into `base`, dropping lines identical to ones already
// present, then stable-sort by the record's ISO `ts` (which sorts
// chronologically as a string); lines without a usable ts keep insertion order.
function mergeJsonlLines(baseLines, extraLines) {
  const seen = new Set(baseLines);
  const combined = [...baseLines];
  for (const line of extraLines) {
    if (!seen.has(line)) {
      seen.add(line);
      combined.push(line);
    }
  }
  const decorated = combined.map((line, index) => {
    let ts = "";
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.ts === "string") {
        ts = parsed.ts;
      }
    } catch {
      // keep ts empty for unparseable lines
    }
    return { line, index, ts };
  });
  decorated.sort((left, right) => {
    if (left.ts && right.ts && left.ts !== right.ts) {
      return left.ts < right.ts ? -1 : 1;
    }
    if (left.ts && !right.ts) return 1;
    if (!left.ts && right.ts) return -1;
    return left.index - right.index;
  });
  return decorated.map((item) => item.line);
}

// Merge the mergeable context files of a (safe) store into the owner store,
// deduping identical lines and keeping timestamp order. Returns per-file counts.
async function mergeStoreInto(ownerDir, mergeFiles, dryRun) {
  const counts = { event_count: 0, note_count: 0 };
  for (const fileName of ["events.jsonl", "notes.jsonl"]) {
    let extra = [];
    for (const mergeFile of mergeFiles) {
      if (mergeFile.fileName === fileName) {
        extra = extra.concat(await readJsonlFile(mergeFile.absPath));
      }
    }
    const key = fileName === "events.jsonl" ? "event_count" : "note_count";
    counts[key] = extra.length;
    if (dryRun || extra.length === 0) {
      continue;
    }
    const target = path.join(ownerDir, ".agentify", "context", fileName);
    const merged = mergeJsonlLines(await readJsonlFile(target), extra);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, merged.length > 0 ? `${merged.join("\n")}\n` : "", "utf8");
  }
  return counts;
}

// `agentify clean --strays`: beneath the current repo, find stores created by a
// stray shell (hooks running wherever the shell sat) and nested stores inside a
// real store, merge their context events and notes into the owning store, and
// remove them — but ONLY when the store holds nothing but mergeable/ephemeral
// context files. Anything heavier (index.db, eval artifacts, ...) is reported as
// skipped and left untouched. Dry-run unless `options.apply`. Never touches
// anything outside the repo top-level.
export async function runCleanStrays(root, config, options = {}) {
  const apply = options.apply === true;
  const repoTop = await gitTopLevel(root);
  if (!repoTop) {
    return { command: "clean --strays", apply, repo_top_level: null, strays: [], skipped: [], applied: 0 };
  }

  const agentifyDirs = await collectAgentifyDirs(repoTop);

  // Split into top-level store holders and nested `.agentify` paths.
  const topLevelHolders = [];
  const nestedDirs = [];
  for (const agentifyDir of agentifyDirs) {
    const holder = path.dirname(agentifyDir);
    if (pathContainsAgentifySegment(holder)) {
      nestedDirs.push(agentifyDir);
    } else {
      topLevelHolders.push(holder);
    }
  }

  // Owners (never removed): the repo top-level plus any store owner (git
  // top-level / has .agentify.yaml / has index.db) — the SAME predicate the
  // resolver uses, so the two never disagree about what a stray is.
  const owners = [repoTop];
  for (const holder of topLevelHolders) {
    if (holder !== repoTop && (await isStoreOwnerDir(holder))) {
      owners.push(holder);
    }
  }
  const ownerSet = new Set(owners);
  const relOwner = (dir) => `${path.relative(repoTop, dir) || "."}/.agentify`;
  const ownerFor = (strayDir) => {
    let best = repoTop;
    let bestLen = -1;
    for (const owner of owners) {
      if (owner === strayDir) {
        continue;
      }
      const rel = path.relative(owner, strayDir);
      if (!rel.startsWith("..") && !path.isAbsolute(rel) && owner.length > bestLen) {
        best = owner;
        bestLen = owner.length;
      }
    }
    return best;
  };

  const strays = [];
  const skipped = [];
  let applied = 0;

  const handleStore = async ({ agentifyDir, ownerDir, nested }) => {
    const info = await classifyStore(agentifyDir);
    const relativePath = `${path.relative(repoTop, path.dirname(agentifyDir)) || "."}/.agentify`;
    if (!info.safe) {
      skipped.push({
        path: agentifyDir,
        relative_path: relativePath,
        owner_relative_path: relOwner(ownerDir),
        reason: info.reason || "store holds content beyond context events/notes",
        size_bytes: info.sizeBytes,
        nested,
      });
      return;
    }
    const counts = await mergeStoreInto(ownerDir, info.mergeFiles, !apply);
    if (apply) {
      await fs.rm(agentifyDir, { recursive: true, force: true });
      applied += 1;
    }
    strays.push({
      path: agentifyDir,
      relative_path: relativePath,
      owner_path: ownerDir,
      owner_relative_path: relOwner(ownerDir),
      event_count: counts.event_count,
      note_count: counts.note_count,
      nested,
    });
  };

  // 1. Nested stores whose enclosing store is an OWNER (so step 2 will not sweep
  //    them up). Process only the shallowest per chain; classifyStore recurses
  //    into deeper nests, and removing the shallowest removes them too.
  const nestedSorted = [...nestedDirs].sort((left, right) => left.length - right.length);
  const removalRoots = [];
  for (const agentifyDir of nestedSorted) {
    if (!removalRoots.some((chosen) => agentifyDir === chosen || agentifyDir.startsWith(`${chosen}${path.sep}`))) {
      removalRoots.push(agentifyDir);
    }
  }
  for (const agentifyDir of removalRoots) {
    const ownerDir = outermostStoreOwner(agentifyDir);
    if (!ownerSet.has(ownerDir)) {
      // Enclosing store is itself a stray; step 2 rolls this up when it removes it.
      continue;
    }
    await handleStore({ agentifyDir, ownerDir, nested: true });
  }

  // 2. Top-level strays: any holder that is not an owner.
  for (const holder of topLevelHolders) {
    if (ownerSet.has(holder)) {
      continue;
    }
    await handleStore({ agentifyDir: path.join(holder, ".agentify"), ownerDir: ownerFor(holder), nested: false });
  }

  return {
    command: "clean --strays",
    apply,
    repo_top_level: repoTop,
    strays,
    skipped,
    applied,
  };
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

// `agentify clean --artifacts`: prune per-task-key directories under KNOWN skill
// artifact dirs (`ui-eval/`) once their newest contained file is older than the
// retention, reporting reclaimable bytes per group. Unknown top-level entries of
// the store are reported with their size and NEVER deleted. Dry-run unless
// `options.apply`. Symlinks are neither followed for size nor deleted through.
export async function runCleanArtifacts(root, config, options = {}) {
  const apply = options.apply === true;
  const cleanupConfig = config.cleanup || {};
  const maxAgeDays = cleanupConfig.artifactMaxAgeDays ?? 14;
  const agentifyPaths = config._agentifyPaths || await resolveAgentifyPaths(root, config);
  const runtimeRoot = agentifyPaths.runtimeRoot;
  const ownedNames = agentifyOwnedNames(root);
  const cutoff = Date.now() - (maxAgeDays * 86400000);

  const groups = [];
  let reclaimableBytes = 0;
  let removed = 0;

  for (const artifactDir of KNOWN_SKILL_ARTIFACT_DIRS) {
    const base = path.join(runtimeRoot, artifactDir);
    let dirents;
    try {
      dirents = await fs.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    const items = [];
    let groupReclaim = 0;
    for (const dirent of dirents) {
      // Only real per-task-key directories are candidates; a symlink (or a stray
      // file) is reported but never pruned.
      if (dirent.isSymbolicLink() || !dirent.isDirectory()) {
        continue;
      }
      const child = path.join(base, dirent.name);
      // Full walk so sizes are exact and the age decision is authoritative.
      const stats = await dirStats(child, FULL_BUDGET);
      // Non-exact walk → we could not confirm the newest file, so treat as fresh
      // and never delete; otherwise an empty dir (newest 0) is also kept.
      const stale = stats.measured === "exact" && stats.newest > 0 && stats.newest < cutoff;
      if (stale) {
        groupReclaim += stats.size;
        if (apply) {
          await fs.rm(child, { recursive: true, force: true });
          removed += 1;
        }
      }
      items.push({
        path: `.agentify/${artifactDir}/${dirent.name}`,
        size_bytes: stats.size,
        measured: stats.measured,
        newest_mtime_ms: stats.newest,
        stale,
      });
    }
    items.sort((left, right) => right.size_bytes - left.size_bytes || left.path.localeCompare(right.path));
    reclaimableBytes += groupReclaim;
    groups.push({ group: artifactDir, max_age_days: maxAgeDays, reclaimable_bytes: groupReclaim, items });
  }

  // Full walk so unknown-directory sizes are exact (not starved by a status budget).
  const measured = await measureStore(runtimeRoot, { ownedNames, ...FULL_BUDGET });
  const unknown = measured.entries
    .filter((entry) => entry.kind === "unknown")
    .map((entry) => ({
      path: `.agentify/${entry.name}`,
      size_bytes: entry.sizeBytes,
      measured: entry.measured,
      is_symlink: entry.isSymlink,
    }));

  return {
    command: "clean --artifacts",
    apply,
    max_age_days: maxAgeDays,
    reclaimable_bytes: reclaimableBytes,
    removed,
    groups,
    unknown,
  };
}

function isAgentifyStoreMeta(meta) {
  return Boolean(meta && typeof meta === "object" && !Array.isArray(meta) && meta.kind === STORE_KIND);
}

// `agentify clean --global`: inspect per-repo project stores in the shared store
// base (resolved exactly as project-store.js resolves it, so the two never point
// at different caches). A store is stale when its repo's git_common_dir no longer
// exists, or it has not been used in `globalMaxAgeDays` (from store.json
// last_used_at). Only directories carrying a valid store.json with the expected
// kind are ever deletable; everything else (invocations.json, model-catalog.json,
// git-analyze/, stray files, symlinks, dirs without a valid store.json) is
// reported and left untouched. Dry-run unless `options.apply`.
export async function runCleanGlobal(config, options = {}, env = process.env) {
  const apply = options.apply === true;
  const cleanupConfig = config.cleanup || {};
  const maxAgeDays = cleanupConfig.globalMaxAgeDays ?? 90;
  const base = resolveSharedBase(config, env);
  const cutoff = Date.now() - (maxAgeDays * 86400000);

  const result = {
    command: "clean --global",
    apply,
    base,
    max_age_days: maxAgeDays,
    reclaimable_bytes: 0,
    removed: 0,
    stores: [],
    unrecognized: [],
  };

  let dirents;
  try {
    dirents = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const dirent of dirents) {
    const name = dirent.name;
    const child = path.join(base, name);
    if (dirent.isSymbolicLink()) {
      result.unrecognized.push({ name, reason: "symlink", size_bytes: 0 });
      continue;
    }
    if (!dirent.isDirectory()) {
      // invocations.json, model-catalog.json, stray HTML reports, ...: leave be.
      let size = 0;
      try {
        size = (await fs.stat(child)).size;
      } catch {
        // ignore
      }
      result.unrecognized.push({ name, reason: "file", size_bytes: size });
      continue;
    }

    let meta = null;
    try {
      meta = await readJson(path.join(child, "store.json"));
    } catch {
      meta = null;
    }
    if (!isAgentifyStoreMeta(meta)) {
      // e.g. git-analyze/ or any dir that is not a recognisable project store.
      const stats = await dirStats(child, FULL_BUDGET);
      result.unrecognized.push({ name, reason: "no valid store.json", size_bytes: stats.size });
      continue;
    }

    const commonDir = typeof meta.git_common_dir === "string" ? meta.git_common_dir : null;
    const repoMissing = commonDir ? !(await exists(commonDir)) : true;
    const lastUsedMs = Date.parse(meta.last_used_at || "");
    const unused = Number.isFinite(lastUsedMs) ? lastUsedMs < cutoff : false;
    const stale = repoMissing || unused;
    const stats = await dirStats(child, FULL_BUDGET);
    const reason = repoMissing
      ? "repo gone"
      : (unused ? `unused ${maxAgeDays}d+` : "active");

    if (stale) {
      result.reclaimable_bytes += stats.size;
      if (apply) {
        await fs.rm(child, { recursive: true, force: true });
        result.removed += 1;
      }
    }

    result.stores.push({
      name,
      size_bytes: stats.size,
      git_remote: typeof meta.git_remote === "string" ? meta.git_remote : null,
      git_common_dir: commonDir,
      last_used_at: typeof meta.last_used_at === "string" ? meta.last_used_at : null,
      repo_missing: repoMissing,
      stale,
      reason,
    });
  }

  result.stores.sort((left, right) => right.size_bytes - left.size_bytes || left.name.localeCompare(right.name));
  return result;
}
