// Repository discovery for `agentify git analyze --global` (and the `--local`
// contract check). It walks one or more roots, finds git repositories, and
// returns a deduplicated, bounded, previewable list — without ever descending
// into a repository, following a symlink, crossing a filesystem, or writing a
// single byte inside any repository it finds.
//
// Zero-install contract (see epic #347): the only cache this module keeps lives
// OUTSIDE every scanned repository, under the user's XDG cache directory. It
// reads git plumbing (`rev-parse`, `rev-list`) read-only; it never writes to,
// checks out, or configures a repository.
//
// The walk is bounded on three independent axes — depth, repository count, and
// wall-clock — because `--global` with the default `$HOME` root is an invasive
// crawl. Any bound that is hit becomes a stated limitation the caller reports,
// never a silent short list.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

// Read-only, no-network env for every git call (mirrors collect.js): stop a
// partial clone from lazily fetching and stop any credential prompt blocking.
function gitEnv() {
  return { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
}

// Discovery bounds. Each is reportable when hit; none is silent. Overridable
// by the caller (and by tests) but never removed.
export const DISCOVERY_DEFAULTS = Object.freeze({
  maxDepth: 4,
  maxRepos: 200,
  wallClockMs: 10_000,
});

// TTL for a cached discovery result. A day balances "don't re-crawl $HOME on
// every invocation" against "a repo cloned this morning shows up by afternoon".
export const DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Cache schema version: bump if the cached entry shape changes so a stale file
// from an older build is ignored rather than misread.
const DISCOVERY_CACHE_VERSION = 1;

// Directory names never worth descending into for repositories: dependency and
// build trees, virtualenvs, and OS/system trees that either contain no user
// repos or are enormous. `.git` is handled separately (it marks a repo). Other
// dotdirs are skipped generically in the walker.
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "vendor",
  "target",
  "venv",
  ".venv",
  "Library",
  "Applications",
  ".Trash",
]);

// ---------------------------------------------------------------------------
// Cache location (OUTSIDE every scanned repository — see the epic constraint).
// ---------------------------------------------------------------------------

/**
 * Resolve the directory that holds the discovery cache, honouring
 * `XDG_CACHE_HOME`. Always outside any scanned repository.
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home]
 * @returns {string} absolute directory path
 */
export function resolveDiscoveryCacheDir({ env = process.env, home } = {}) {
  const xdg = env.XDG_CACHE_HOME && String(env.XDG_CACHE_HOME).trim();
  const base = xdg && path.isAbsolute(xdg)
    ? xdg
    : path.join(home || os.homedir(), ".cache");
  return path.join(base, "agentify", "git-analyze");
}

/**
 * Resolve the discovery cache file path (`.../git-analyze/discovery.json`).
 * @param {object} [options] - forwarded to resolveDiscoveryCacheDir
 * @returns {string} absolute file path
 */
export function resolveDiscoveryCachePath(options = {}) {
  return path.join(resolveDiscoveryCacheDir(options), "discovery.json");
}

// A stable cache key for one root at one depth. Discovery of the same root at a
// different depth is a different result, so depth is part of the key.
function cacheKey(rootAbs, maxDepth) {
  return JSON.stringify([rootAbs, maxDepth]);
}

async function readCacheFile(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== DISCOVERY_CACHE_VERSION || typeof parsed.entries !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Best-effort cache write: a discovery cache is an optimisation, so any failure
// (unwritable cache dir, race) is swallowed — it must never fail the command.
async function writeCacheFile(cachePath, data) {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  } catch {
    // A missing cache degrades to a re-scan next time; never fatal.
  }
}

// Absolute, symlink-resolved path of `target`, following symlinks up to the
// nearest EXISTING ancestor (the target usually does not exist yet) and
// re-appending the not-yet-created suffix. Used so the cache-containment check
// cannot be defeated by a symlinked XDG_CACHE_HOME. Mirrors the report renderer's
// symlink-safe containment (html.js isInside/realPath).
async function realpathNearest(target) {
  let current = path.resolve(target);
  const suffix = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// Git identity helpers (dedup + preview counts).
// ---------------------------------------------------------------------------

// Per-call timeout for every git subprocess here: a hung git (a wedged NFS
// mount, a credential prompt that slipped past GIT_TERMINAL_PROMPT) must not
// stall discovery beyond its wall-clock budget. `killSignal` ensures the child
// is actually reaped on timeout.
const GIT_CALL_TIMEOUT_MS = 5000;

async function gitRevParse(repoPath, args) {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repoPath, "rev-parse", ...args],
    { env: gitEnv(), timeout: GIT_CALL_TIMEOUT_MS, killSignal: "SIGKILL" },
  );
  return stdout.trim();
}

/**
 * Resolve a repository's git identity in a SINGLE `rev-parse` call: the absolute
 * realpath of its COMMON git dir (the object store shared by a main checkout and
 * all its linked worktrees — the deduplication key) and whether this checkout is
 * itself a linked worktree (its own git dir differs from the common one). One
 * call, not two, halves the subprocess count during dedup.
 * @returns {Promise<{ commonGitDir: string|null, isWorktree: boolean }>}
 */
async function getRepoGitIdentity(repoPath) {
  let gitDir = null;
  let commonDir = null;
  try {
    // --path-format=absolute (git >= 2.31) returns both paths absolute.
    const out = await gitRevParse(repoPath, ["--path-format=absolute", "--git-dir", "--git-common-dir"]);
    const lines = out.split("\n");
    gitDir = lines[0] || null;
    commonDir = lines[1] || null;
  } catch {
    try {
      const raw = await gitRevParse(repoPath, ["--git-common-dir"]);
      commonDir = raw ? path.resolve(repoPath, raw) : null;
    } catch {
      return { commonGitDir: null, isWorktree: false };
    }
  }
  if (!commonDir) {
    return { commonGitDir: null, isWorktree: false };
  }
  const isWorktree = Boolean(gitDir && path.resolve(gitDir) !== path.resolve(commonDir));
  let resolved;
  try {
    resolved = await fs.realpath(commonDir);
  } catch {
    resolved = path.resolve(commonDir);
  }
  return { commonGitDir: resolved, isWorktree };
}

/**
 * Absolute realpath of a repository's COMMON git dir (the deduplication key), or
 * null if it cannot be determined. Thin wrapper over {@link getRepoGitIdentity}.
 * @returns {Promise<string|null>}
 */
export async function getCommonGitDir(repoPath) {
  return (await getRepoGitIdentity(repoPath)).commonGitDir;
}

// ---------------------------------------------------------------------------
// The walk.
// ---------------------------------------------------------------------------

// Does `dir` contain a `.git` entry (directory OR file)? A `.git` FILE marks a
// linked worktree or a submodule checkout; a `.git` DIRECTORY marks a normal
// repository. Either way, `dir` is a repository boundary.
async function hasGitEntry(dir) {
  try {
    await fs.lstat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk one root and collect repository work-tree paths, honouring every bound.
 * Mutates the shared `state` (visited inodes, repo list, counters, deadline) so
 * bounds apply ACROSS roots, not per root.
 */
async function walkRoot(rootAbs, state) {
  const { maxDepth, fsImpl } = state;
  // Depth-first with an explicit stack so a very deep tree cannot overflow the
  // call stack, and so the wall-clock/repo bounds can be checked per directory.
  const stack = [{ dir: rootAbs, depth: 0 }];

  while (stack.length > 0) {
    if (state.repos.length >= state.maxRepos) {
      state.truncated.repos = true;
      return;
    }
    if (Date.now() >= state.deadline) {
      state.truncated.wallClock = true;
      return;
    }

    const { dir, depth } = stack.pop();

    // A repository boundary: record it and DO NOT descend. A monorepo with
    // submodules, or a repo with a nested checkout in its working tree, is one
    // entry — descending would explode a submodule-heavy tree and would report
    // directories that live inside another repository.
    if (await hasGitEntry(dir)) {
      state.repos.push({ path: dir });
      continue;
    }

    if (depth >= maxDepth) {
      // Reached the depth ceiling on a non-repo directory: a repo below it is
      // unreachable, so the listing may be short — report it.
      state.truncated.depth = true;
      continue;
    }

    let entries;
    try {
      entries = await fsImpl.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "EACCES" || error?.code === "EPERM") {
        state.skippedPermission += 1;
        continue;
      }
      // A directory that vanished mid-walk (ENOENT) or any other read error is
      // skipped rather than aborting the whole discovery.
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        // Never follow a symlink — even one that points at a directory. This is
        // the primary defence against a symlink cycle hanging the walk.
        continue;
      }
      const name = entry.name;
      if (name === ".git" || SKIP_DIR_NAMES.has(name)) {
        continue;
      }
      // Skip other dotdirs (config/state trees), but `.git` was handled above.
      if (name.startsWith(".")) {
        continue;
      }

      const childPath = path.join(dir, name);

      // Defence in depth against cycles and re-entry: stat WITHOUT following
      // links, skip anything that is not a real directory here, skip a device
      // change (a different filesystem than the root), and skip an inode we
      // have already visited.
      let st;
      try {
        st = await fsImpl.lstat(childPath);
      } catch (error) {
        if (error?.code === "EACCES" || error?.code === "EPERM") {
          state.skippedPermission += 1;
        }
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        continue;
      }
      if (state.rootDev !== null && st.dev !== state.rootDev) {
        state.crossedFilesystem = true;
        continue;
      }
      const inode = `${st.dev}:${st.ino}`;
      if (state.visited.has(inode)) {
        continue;
      }
      state.visited.add(inode);

      stack.push({ dir: childPath, depth: depth + 1 });
    }
  }
}

/**
 * Discover git repositories under one or more roots.
 *
 * @param {object} [options]
 * @param {string[]} [options.roots] - discovery roots; default [os.homedir()]
 * @param {number} [options.maxDepth]
 * @param {number} [options.maxRepos]
 * @param {number} [options.wallClockMs]
 * @param {boolean} [options.useCache=true]
 * @param {NodeJS.ProcessEnv} [options.env] - for XDG cache resolution
 * @param {Date} [options.now] - injectable clock for cache TTL (tests)
 * @param {object} [options.fsImpl] - injectable fs (tests); defaults to node fs
 * @param {(repoPath:string)=>Promise<{commonGitDir:string|null,isWorktree:boolean}>} [options.getRepoGitIdentity]
 * @returns {Promise<{
 *   roots: string[],
 *   repositories: Array<{ path: string, name: string, commonGitDir: string|null, isWorktree: boolean }>,
 *   limitations: string[],
 *   truncated: { repos: boolean, depth: boolean, wallClock: boolean },
 *   stats: { rootsWalked: number, skippedPermission: number, dedupedWorktrees: number, crossedFilesystem: boolean },
 *   fromCache: boolean,
 *   bounds: { maxDepth: number, maxRepos: number, wallClockMs: number },
 * }>}
 */
export async function discoverRepositories(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth >= 0
    ? options.maxDepth : DISCOVERY_DEFAULTS.maxDepth;
  const maxRepos = Number.isInteger(options.maxRepos) && options.maxRepos > 0
    ? options.maxRepos : DISCOVERY_DEFAULTS.maxRepos;
  const wallClockMs = Number.isInteger(options.wallClockMs) && options.wallClockMs > 0
    ? options.wallClockMs : DISCOVERY_DEFAULTS.wallClockMs;
  const useCache = options.useCache !== false;
  const identityOf = options.getRepoGitIdentity || getRepoGitIdentity;
  const nowMs = options.now instanceof Date ? options.now.getTime() : Date.now();

  const roots = normalizeRoots(options.roots);
  const cachePath = resolveDiscoveryCachePath({ env: options.env });

  // Try the cache first: an unexpired entry per (root, depth) short-circuits the
  // crawl. A partial hit (some roots cached, some not) still walks the misses.
  const cacheFile = useCache ? await readCacheFile(cachePath) : null;

  // Raw repo paths accumulate here (pre-dedup, pre-glob).
  const state = {
    maxDepth,
    maxRepos,
    fsImpl,
    // The wall-clock budget always uses the real clock; `now` (options.now) is
    // only for cache-TTL comparison, so it must not shorten the live deadline.
    deadline: Date.now() + wallClockMs,
    repos: [],
    visited: new Set(),
    skippedPermission: 0,
    rootDev: null,
    crossedFilesystem: false,
    rootsWalked: 0,
    truncated: { repos: false, depth: false, wallClock: false },
  };

  // Per-root path lists, so a fresh walk of one root can repopulate exactly its
  // slice of the cache without disturbing other roots' cached entries.
  const perRootPaths = new Map();
  const cacheEntriesToWrite = cacheFile && typeof cacheFile.entries === "object"
    ? { ...cacheFile.entries }
    : {};
  let anyCacheHit = false;
  let anyFreshWalk = false;

  for (const rootAbs of roots) {
    const key = cacheKey(rootAbs, maxDepth);
    const cached = useCache && cacheFile ? cacheFile.entries[key] : null;
    if (cached && Number.isFinite(cached.discoveredAt) && (nowMs - cached.discoveredAt) < DISCOVERY_CACHE_TTL_MS
      && Array.isArray(cached.paths)) {
      perRootPaths.set(rootAbs, cached.paths.slice());
      for (const p of cached.paths) {
        state.repos.push({ path: p });
      }
      anyCacheHit = true;
      // A cached root does not re-apply live bounds, but a hit means the crawl
      // that produced it already recorded any bounds it struck.
      if (cached.truncated) {
        state.truncated.repos = state.truncated.repos || Boolean(cached.truncated.repos);
        state.truncated.depth = state.truncated.depth || Boolean(cached.truncated.depth);
        state.truncated.wallClock = state.truncated.wallClock || Boolean(cached.truncated.wallClock);
      }
      continue;
    }

    // Fresh walk of this root. Record the root's device so a descent onto a
    // different filesystem is skipped (and reported).
    anyFreshWalk = true;
    const before = state.repos.length;
    const beforeTruncated = { ...state.truncated };
    try {
      const rootStat = await fsImpl.lstat(rootAbs);
      if (!rootStat.isDirectory()) {
        continue;
      }
      state.rootDev = rootStat.dev;
      state.visited.add(`${rootStat.dev}:${rootStat.ino}`);
    } catch {
      // A missing/unreadable root is skipped, not fatal.
      continue;
    }
    state.rootsWalked += 1;
    await walkRoot(rootAbs, state);

    const walked = state.repos.slice(before).map((r) => r.path);
    perRootPaths.set(rootAbs, walked);
    cacheEntriesToWrite[key] = {
      discoveredAt: nowMs,
      paths: walked,
      truncated: {
        repos: state.truncated.repos && !beforeTruncated.repos,
        depth: state.truncated.depth && !beforeTruncated.depth,
        wallClock: state.truncated.wallClock && !beforeTruncated.wallClock,
      },
    };
  }

  // Deduplicate by common git dir: a linked worktree shares its main checkout's
  // object store, so the same commits are never counted twice. Prefer the main
  // checkout over a worktree; among equals keep the first (shortest path wins as
  // a stable tiebreak so the canonical checkout is chosen deterministically).
  const byCommonDir = new Map();
  let dedupedWorktrees = 0;
  for (const repo of state.repos) {
    // The wall-clock budget covers identification too: once past the deadline,
    // stop spawning git and keep the remaining repositories unidentified (each
    // by its own path, so nothing collapses incorrectly) rather than running on.
    let commonGitDir = null;
    let worktree = false;
    if (Date.now() >= state.deadline) {
      state.truncated.wallClock = true;
    } else {
      ({ commonGitDir, isWorktree: worktree } = await identityOf(repo.path));
    }
    const entry = {
      path: repo.path,
      name: path.basename(repo.path),
      commonGitDir,
      isWorktree: worktree,
    };
    if (!commonGitDir) {
      // Could not identify the object store: keep it, keyed by its own path so
      // it cannot accidentally collapse into another repo.
      byCommonDir.set(`path:${repo.path}`, entry);
      continue;
    }
    const existing = byCommonDir.get(commonGitDir);
    if (!existing) {
      byCommonDir.set(commonGitDir, entry);
      continue;
    }
    dedupedWorktrees += 1;
    // Replace the kept entry only if the new one is a better canonical choice:
    // a main checkout beats a worktree; otherwise the shorter path wins.
    const better = (existing.isWorktree && !entry.isWorktree)
      || (existing.isWorktree === entry.isWorktree && entry.path.length < existing.path.length);
    if (better) {
      byCommonDir.set(commonGitDir, entry);
    }
  }

  const repositories = [...byCommonDir.values()].sort((a, b) => a.path.localeCompare(b.path));

  const limitations = [];
  if (state.truncated.repos) {
    limitations.push(`Repository discovery hit the cap of ${maxRepos} repositories; the list is truncated and totals reflect only the repositories scanned.`);
  }
  if (state.truncated.wallClock) {
    limitations.push(`Repository discovery hit its ${Math.round(wallClockMs / 1000)}s time budget; the list is truncated.`);
  }
  if (state.truncated.depth) {
    limitations.push(`Repository discovery reached the maximum depth of ${maxDepth}; repositories nested deeper than that were not found.`);
  }
  if (state.skippedPermission > 0) {
    limitations.push(`${state.skippedPermission} director${state.skippedPermission === 1 ? "y was" : "ies were"} skipped because they were unreadable (permission denied).`);
  }
  if (state.crossedFilesystem) {
    limitations.push("One or more directories on a different filesystem than the root were skipped.");
  }

  // The zero-install constraint forbids writing inside any scanned repository —
  // not even a cache. If the resolved cache path lands inside a discovered repo
  // (e.g. $HOME is itself a repo, or XDG_CACHE_HOME points into one), skip the
  // write and say so, rather than silently violating the constraint.
  //
  // Resolve symlinks first: a LEXICAL comparison is defeated by an absolute
  // XDG_CACHE_HOME that is a symlink into a repo (the string looks outside while
  // the write lands inside), and on macOS `/tmp` -> `/private/tmp` makes the
  // repo's canonical path and a `/tmp/...` cache path the same directory yet
  // unequal as strings. realpathNearest walks to the nearest existing ancestor
  // because the cache directory usually does not exist yet.
  // Resolve BOTH sides through realpath so the comparison is apples-to-apples:
  // a discovered repo's path may still carry a symlinked prefix (e.g. macOS
  // `/var` -> `/private/var`), so canonicalising only the cache side would make
  // the same directory compare unequal and let the write through.
  //
  // Check against EVERY scanned path (state.repos, pre-deduplication), not just
  // the deduplicated `repositories`: a linked worktree dropped during dedup is
  // still a scanned repository, and a cache inside it would still be a write
  // inside a scanned repository.
  const cacheResolved = await realpathNearest(cachePath);
  const scannedPaths = state.repos.map((repo) => repo.path);
  const repoResolvedList = await Promise.all(scannedPaths.map((p) => realpathNearest(p)));
  const cacheInsideRepo = repoResolvedList.some((repoResolved) =>
    cacheResolved === repoResolved || cacheResolved.startsWith(`${repoResolved}${path.sep}`));
  if (cacheInsideRepo) {
    limitations.push("The discovery cache would fall inside a scanned repository, so it was not written (nothing is ever written inside a scanned repository).");
  }

  // Refresh the cache only when a live walk happened, caching is enabled, and
  // the cache would not land inside a scanned repository.
  if (useCache && anyFreshWalk && !cacheInsideRepo) {
    await writeCacheFile(cachePath, { version: DISCOVERY_CACHE_VERSION, entries: cacheEntriesToWrite });
  }

  return {
    roots,
    repositories,
    limitations,
    truncated: state.truncated,
    stats: {
      rootsWalked: state.rootsWalked,
      skippedPermission: state.skippedPermission,
      dedupedWorktrees,
      crossedFilesystem: state.crossedFilesystem,
    },
    fromCache: anyCacheHit && !anyFreshWalk,
    bounds: { maxDepth, maxRepos, wallClockMs },
  };
}

// Resolve, absolutize, and de-duplicate the discovery roots. An empty/absent
// list defaults to the user's home directory — the invasive default the CLI is
// required to disclose before walking.
function normalizeRoots(roots) {
  const list = Array.isArray(roots) ? roots : roots ? [roots] : [];
  const cleaned = list
    .map((r) => String(r).trim())
    .filter(Boolean)
    .map((r) => path.resolve(r));
  const unique = [...new Set(cleaned.length > 0 ? cleaned : [os.homedir()])];
  return unique;
}

// ---------------------------------------------------------------------------
// --repo glob selection.
// ---------------------------------------------------------------------------

// Compile one `--repo` glob to a predicate. The glob matches EITHER the
// repository's directory name (basename) or its full path; `*`/`**` behave as
// in a shell (`**` crosses separators, `*` stays within a segment). A glob with
// no slash is treated as a name match; one with a slash matches against the
// full path.
function compileRepoGlob(glob) {
  const trimmed = String(glob || "").trim();
  if (!trimmed) {
    return null;
  }
  const source = globToRegExpSource(trimmed);
  const regex = new RegExp(`^${source}$`);
  const hasSlash = trimmed.includes("/");
  return (repo) => {
    if (regex.test(repo.name)) {
      return true;
    }
    if (hasSlash && regex.test(repo.path)) {
      return true;
    }
    return false;
  };
}

function escapeRegExp(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegExpSource(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExp(ch);
    }
  }
  return out;
}

/**
 * Narrow a discovered repository list by `--repo` globs (a repo matching ANY
 * glob is kept). With no globs the list is returned unchanged.
 * @param {Array<{name:string,path:string}>} repositories
 * @param {string[]} globs
 * @returns {Array} the kept subset
 */
export function selectRepositories(repositories, globs) {
  const patterns = (Array.isArray(globs) ? globs : globs ? [globs] : [])
    .map(compileRepoGlob)
    .filter(Boolean);
  if (patterns.length === 0) {
    return repositories.slice();
  }
  return repositories.filter((repo) => patterns.some((match) => match(repo)));
}

// ---------------------------------------------------------------------------
// Dry-run window preview count (reads NO commit bodies).
// ---------------------------------------------------------------------------

// Does `expr` resolve to a commit in this repo (a ref) rather than a date? A ref
// bound becomes a revision range; a date bound becomes a `--since`/`--until`
// filter. Mirrors collect.js's committish probe, with a timeout.
async function isCommittish(repoPath, expr) {
  try {
    await gitRevParse(repoPath, ["--verify", "--quiet", `${expr}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Count commits in the window for one repository WITHOUT reading a single commit
 * body — a `git rev-list --count`. This is the dry-run preview number, so it is
 * approximate at the boundary (git's date filter is inclusive, and it does not
 * apply the real run's exact half-open author-date refinement) and best-effort:
 * any failure yields null, reported as an unknown count rather than aborting the
 * preview.
 *
 * The window's bounds are honoured the same way the real collector resolves
 * them: an absolute/date bound becomes a `--since`/`--until` date filter, while
 * a ref bound becomes a revision range — so a user-supplied `--since`/`--until`
 * is reflected in the preview rather than silently ignored.
 *
 * @param {string} repoPath
 * @param {{ since?: string, until?: string, since_kind?: string, until_kind?: string }} window
 * @param {object} [options]
 * @param {boolean} [options.includeMerges=false]
 * @returns {Promise<number|null>}
 */
export async function countCommitsInWindow(repoPath, window = {}, options = {}) {
  const args = ["-C", repoPath, "rev-list", "--count"];
  if (options.includeMerges !== true) {
    args.push("--no-merges");
  }

  let sinceRef = null;
  let untilRef = null;

  if (window.since) {
    if (window.since_kind === "instant") {
      args.push(`--since=${window.since}`);
    } else if (await isCommittish(repoPath, window.since)) {
      sinceRef = window.since;
    } else {
      // A date/relative expression git can parse (a typo resolves to ~now, same
      // as the real run's git filter would).
      args.push(`--since=${window.since}`);
    }
  }
  if (window.until) {
    if (window.until_kind === "instant") {
      args.push(`--until=${window.until}`);
    } else if (await isCommittish(repoPath, window.until)) {
      untilRef = window.until;
    } else {
      args.push(`--until=${window.until}`);
    }
  }

  // Ref bounds become a revision range, matching collect.js: `A..B` excludes A
  // and includes B; `A..HEAD` is history after the ref.
  if (sinceRef && untilRef) {
    args.push(`${sinceRef}..${untilRef}`);
  } else if (sinceRef) {
    args.push(`${sinceRef}..HEAD`);
  } else if (untilRef) {
    args.push(untilRef);
  } else {
    args.push("HEAD");
  }

  try {
    const { stdout } = await execFileAsync("git", args, { env: gitEnv(), timeout: GIT_CALL_TIMEOUT_MS, killSignal: "SIGKILL" });
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
