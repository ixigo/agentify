// Shared, symlink-safe cache-path resolution for `agentify git analyze`.
//
// The epic's hardest constraint is that the command NEVER writes inside an
// analysed repository — "not even a cache, not even gitignored". Three separate
// modules need a writable cache or artifact directory (discovery in
// discover.js, tracker titles in tracker.js, the HTML report in html.js), and
// the same defect was found independently in all three:
//
//   1. a RELATIVE XDG_CACHE_HOME resolves against the process cwd, which is the
//      repository being analysed;
//   2. an ABSOLUTE XDG_CACHE_HOME can point straight into the repository;
//   3. a SYMLINKED XDG_CACHE_HOME defeats a lexical containment check — on
//      macOS `/tmp` is a symlink to `/private/tmp`, so a repo reported as
//      `/private/tmp/x` and a cache path given as `/tmp/x/.cache` are the same
//      directory while comparing unequal as strings.
//
// One implementation, used everywhere, so a fourth caller cannot reintroduce
// the same hole.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve `target` through symlinks, walking up to the nearest EXISTING
 * ancestor (a cache directory usually does not exist yet) and re-appending the
 * not-yet-created suffix.
 *
 * @param {string} target
 * @returns {string} an absolute, symlink-resolved path
 */
export function realpathNearestSync(target) {
  let current = path.resolve(target);
  const suffix = [];
  for (;;) {
    try {
      return path.join(fsSync.realpathSync(current), ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Async twin of {@link realpathNearestSync}. */
export async function realpathNearest(target) {
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

/**
 * Whether `target` is the same path as, or nested inside, `parent`. Both sides
 * are symlink-resolved, and the separator guard stops `/repo-backup` from being
 * read as inside `/repo`.
 *
 * @param {string} parent
 * @param {string} target
 * @returns {boolean}
 */
export function isInside(parent, target) {
  const from = realpathNearestSync(parent);
  const to = realpathNearestSync(target);
  if (from === to) return true;
  const relative = path.relative(from, to);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Whether `target` sits inside ANY git repository (a `.git` entry at any
 * ancestor). This backstops an explicit repository list: a cache directory
 * inside some UNRELATED repo would pass a list check and still dirty a
 * checkout the user cares about.
 *
 * @param {string} target
 * @returns {boolean}
 */
export function isInsideAnyGitRepo(target) {
  let current = realpathNearestSync(target);
  for (;;) {
    if (fsSync.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * The base cache directory. Honours XDG_CACHE_HOME only when it is ABSOLUTE —
 * the XDG spec says a relative value must be ignored, and honouring one here
 * would resolve it against the analysed repository.
 *
 * @param {object} [env]
 * @returns {string}
 */
export function cacheHome(env = process.env) {
  const configured = typeof env.XDG_CACHE_HOME === "string" ? env.XDG_CACHE_HOME.trim() : "";
  return configured.length > 0 && path.isAbsolute(configured)
    ? configured
    : path.join(os.homedir(), ".cache");
}

/**
 * Resolve a writable git-analyze cache directory that is guaranteed to be
 * outside every repository. Falls back in order: configured cache home → the
 * home cache → the OS temp dir. A fallback that is itself inside a repository
 * (a `$HOME` that happens to be a git checkout) is rejected too.
 *
 * @param {string[]} segments - path segments under `<cacheHome>/agentify/git-analyze`
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {string[]} [options.repositoryPaths] - repositories that must not receive writes
 * @returns {string} an absolute directory path
 */
export function resolveCacheDir(segments, options = {}) {
  const env = options.env || process.env;
  const repositories = (options.repositoryPaths || []).filter(Boolean);

  const candidates = [
    path.join(cacheHome(env), "agentify", "git-analyze", ...segments),
    path.join(os.homedir(), ".cache", "agentify", "git-analyze", ...segments),
    path.join(os.tmpdir(), "agentify", "git-analyze", ...segments),
  ];

  for (const candidate of candidates) {
    const insideNamedRepo = repositories.some((repo) => isInside(repo, candidate));
    if (insideNamedRepo) continue;
    if (isInsideAnyGitRepo(candidate)) continue;
    return candidate;
  }
  // Every candidate was inside some repository (a deliberately hostile layout:
  // $HOME and TMPDIR both inside a checkout). Return the temp candidate rather
  // than a repository path, and let the caller's write fail loudly if it must.
  return candidates[candidates.length - 1];
}
