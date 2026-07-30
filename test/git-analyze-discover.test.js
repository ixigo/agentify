import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  discoverRepositories,
  selectRepositories,
  resolveDiscoveryCacheDir,
  resolveDiscoveryCachePath,
  countCommitsInWindow,
  getCommonGitDir,
  DISCOVERY_DEFAULTS,
} from "../src/core/git-analyze/discover.js";
import { runGitAnalyze } from "../src/core/git-analyze/index.js";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function git(root, args, options = {}) {
  return execFileAsync("git", args, { cwd: root, ...options });
}

async function initRepo(dir, { file = "README.md", subject = "feat: initial" } = {}) {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.name", "Fix Ture"]);
  await git(dir, ["config", "user.email", "fixture@example.com"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(dir, file), "hello\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", subject]);
  return dir;
}

// A fixture tree exercising every tricky discovery path: nested repos, a linked
// worktree, a node_modules with a stray .git, a symlink cycle, and an
// unreadable directory.
async function buildFixtureTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-discover-"));
  const group = path.join(root, "group");
  await fs.mkdir(group, { recursive: true });

  const alpha = await initRepo(path.join(group, "alpha"));
  // A repo nested inside alpha's working tree: must NOT be reported separately
  // (we stop at the first .git and do not descend into a found repository).
  await initRepo(path.join(alpha, "inner"), { subject: "feat: inner" });
  const beta = await initRepo(path.join(group, "beta"));
  // A stray repo under node_modules: must never be discovered.
  await initRepo(path.join(group, "node_modules", "pkg"), { subject: "feat: dep" });

  const gamma = await initRepo(path.join(root, "gamma"));
  // A linked worktree of gamma: shares gamma's object store, so it must
  // deduplicate to a single entry.
  const gammaWt = path.join(root, "gamma-wt");
  await git(gamma, ["worktree", "add", "-q", gammaWt]);

  // A symlink cycle back to the root: discovery must not follow it or hang.
  await fs.symlink(root, path.join(root, "loop"), "dir");

  // An unreadable directory: skipped and counted, never fatal.
  const locked = path.join(root, "locked");
  await fs.mkdir(locked, { recursive: true });
  await fs.chmod(locked, 0o000);

  return { root, alpha, beta, gamma, gammaWt, locked };
}

async function cleanupFixture(root) {
  // Restore the locked dir's perms so rm can remove it.
  try {
    await fs.chmod(path.join(root, "locked"), 0o755);
  } catch {
    // already gone or unrestorable
  }
  await fs.rm(root, { recursive: true, force: true });
}

// Recursive listing of a repo's working tree (excluding .git) — to assert
// discovery writes nothing inside it.
async function listTree(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // An unreadable directory (the fixture's locked/) is skipped, matching
      // what discovery itself does; its absence from the listing is expected.
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const abs = path.join(dir, entry.name);
      out.push(path.relative(root, abs));
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(abs);
    }
  }
  await walk(root);
  return out.sort();
}

const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

test("discoverRepositories finds every repo under the root and no directory inside any of them", async () => {
  const { root, alpha, beta, gamma } = await buildFixtureTree();
  try {
    const result = await discoverRepositories({ roots: [root], useCache: false });
    const names = new Set(result.repositories.map((r) => r.name));

    // The three top-level repositories, and only those.
    assert.deepEqual([...names].sort(), ["alpha", "beta", "gamma"]);

    const paths = result.repositories.map((r) => r.path);
    // No directory INSIDE a repository is reported (the nested `inner` repo is
    // folded into alpha; the node_modules repo is never reached).
    assert.ok(!paths.some((p) => p.includes(`${path.sep}inner`)), "nested repo must not be reported");
    assert.ok(!paths.some((p) => p.includes("node_modules")), "node_modules repo must not be reported");
    assert.ok(paths.includes(alpha) && paths.includes(beta) && paths.includes(gamma));
  } finally {
    await cleanupFixture(root);
  }
});

test("discoverRepositories deduplicates a linked worktree by common git dir", async () => {
  const { root, gamma, gammaWt } = await buildFixtureTree();
  try {
    // Precondition: the two checkouts genuinely share one object store.
    assert.equal(await getCommonGitDir(gamma), await getCommonGitDir(gammaWt));

    const result = await discoverRepositories({ roots: [root], useCache: false });
    const gammaEntries = result.repositories.filter(
      (r) => r.commonGitDir === (result.repositories.find((x) => x.path === gamma)?.commonGitDir),
    );
    assert.equal(gammaEntries.length, 1, "the worktree and its main checkout collapse to one entry");
    assert.ok(result.stats.dedupedWorktrees >= 1);
    // The main checkout is the canonical entry, not the linked worktree.
    assert.ok(result.repositories.some((r) => r.path === gamma));
    assert.ok(!result.repositories.some((r) => r.path === gammaWt));
  } finally {
    await cleanupFixture(root);
  }
});

test("two forks with the same SHA are reported separately (distinct object stores)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-discover-fork-"));
  try {
    const origin = await initRepo(path.join(root, "origin"));
    const headSha = (await git(origin, ["rev-parse", "HEAD"])).stdout.trim();
    // A clone shares SHAs but has its own object store (distinct common dir).
    await git(root, ["clone", "-q", origin, path.join(root, "fork")]);

    const result = await discoverRepositories({ roots: [root], useCache: false });
    const names = new Set(result.repositories.map((r) => r.name));
    assert.ok(names.has("origin") && names.has("fork"), "both forks are reported");
    assert.equal(result.repositories.length, 2);
    const commonDirs = new Set(result.repositories.map((r) => r.commonGitDir));
    assert.equal(commonDirs.size, 2, "forks have distinct object stores and are not deduped");
    // Both really do contain the same commit.
    assert.equal((await git(path.join(root, "fork"), ["rev-parse", "HEAD"])).stdout.trim(), headSha);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a symlink cycle under a root does not hang discovery", async () => {
  const { root } = await buildFixtureTree();
  try {
    // Completing at all is the assertion; the fixture contains loop -> root.
    const result = await discoverRepositories({ roots: [root], useCache: false, wallClockMs: 5000 });
    assert.ok(Array.isArray(result.repositories));
  } finally {
    await cleanupFixture(root);
  }
});

test("an unreadable directory is skipped and counted, not fatal", { skip: runningAsRoot }, async () => {
  const { root } = await buildFixtureTree();
  try {
    const result = await discoverRepositories({ roots: [root], useCache: false });
    assert.ok(result.stats.skippedPermission >= 1, "the locked directory is counted as a permission skip");
    assert.ok(result.limitations.some((line) => /permission denied/i.test(line)));
  } finally {
    await cleanupFixture(root);
  }
});

test("discovery bounds are reported when hit", async () => {
  const { root } = await buildFixtureTree();
  try {
    const capped = await discoverRepositories({ roots: [root], useCache: false, maxRepos: 1 });
    assert.equal(capped.truncated.repos, true);
    assert.ok(capped.limitations.some((line) => /cap of 1 repositor/i.test(line)));

    const shallow = await discoverRepositories({ roots: [root], useCache: false, maxDepth: 0 });
    // Depth 0 means the root itself is the only candidate; it is not a repo, so
    // nothing is found and the depth bound is reported.
    assert.equal(shallow.repositories.length, 0);
    assert.equal(shallow.truncated.depth, true);
  } finally {
    await cleanupFixture(root);
  }
});

test("discovery writes nothing inside any discovered repository", async () => {
  const { root, alpha, beta, gamma } = await buildFixtureTree();
  const cacheHome = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-cache-"));
  try {
    const before = {
      alpha: await listTree(alpha),
      beta: await listTree(beta),
      gamma: await listTree(gamma),
    };
    await discoverRepositories({ roots: [root], useCache: true, env: { ...process.env, XDG_CACHE_HOME: cacheHome } });

    assert.deepEqual(await listTree(alpha), before.alpha);
    assert.deepEqual(await listTree(beta), before.beta);
    assert.deepEqual(await listTree(gamma), before.gamma);

    // No discovery.json anywhere under the fixture root.
    const all = await listTree(root);
    assert.ok(!all.some((p) => p.endsWith("discovery.json")), "no cache file inside the scanned tree");
  } finally {
    await cleanupFixture(root);
    await fs.rm(cacheHome, { recursive: true, force: true });
  }
});

test("the discovery cache path resolves under XDG_CACHE_HOME when set", async () => {
  const xdg = path.join(os.tmpdir(), "xdg-cache-fixture");
  const dir = resolveDiscoveryCacheDir({ env: { XDG_CACHE_HOME: xdg } });
  assert.equal(dir, path.join(xdg, "agentify", "git-analyze"));
  const file = resolveDiscoveryCachePath({ env: { XDG_CACHE_HOME: xdg } });
  assert.equal(file, path.join(xdg, "agentify", "git-analyze", "discovery.json"));

  // Falls back to ~/.cache when XDG is unset.
  const home = path.join(os.tmpdir(), "fake-home");
  const fallback = resolveDiscoveryCacheDir({ env: {}, home });
  assert.equal(fallback, path.join(home, ".cache", "agentify", "git-analyze"));
});

test("the discovery cache is written under XDG_CACHE_HOME and reused", async () => {
  const { root } = await buildFixtureTree();
  const cacheHome = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-cache-"));
  const env = { ...process.env, XDG_CACHE_HOME: cacheHome };
  try {
    const first = await discoverRepositories({ roots: [root], useCache: true, env });
    assert.equal(first.fromCache, false);

    const cachePath = resolveDiscoveryCachePath({ env });
    const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    assert.ok(cached.entries && Object.keys(cached.entries).length >= 1);

    const second = await discoverRepositories({ roots: [root], useCache: true, env });
    assert.equal(second.fromCache, true);
    assert.deepEqual(
      new Set(second.repositories.map((r) => r.name)),
      new Set(first.repositories.map((r) => r.name)),
    );

    // --no-cache bypasses the cache entirely.
    const bypass = await discoverRepositories({ roots: [root], useCache: false, env });
    assert.equal(bypass.fromCache, false);
  } finally {
    await cleanupFixture(root);
    await fs.rm(cacheHome, { recursive: true, force: true });
  }
});

test("selectRepositories narrows by name and path globs", () => {
  const repos = [
    { name: "alpha", path: "/w/alpha" },
    { name: "beta", path: "/w/beta" },
    { name: "web-app", path: "/w/services/web-app" },
  ];
  assert.equal(selectRepositories(repos, undefined).length, 3);
  assert.deepEqual(selectRepositories(repos, ["alpha"]).map((r) => r.name), ["alpha"]);
  assert.deepEqual(selectRepositories(repos, ["alph*"]).map((r) => r.name), ["alpha"]);
  // A glob with a slash matches against the full path.
  assert.deepEqual(selectRepositories(repos, ["**/services/**"]).map((r) => r.name), ["web-app"]);
  // Multiple globs union.
  assert.deepEqual(selectRepositories(repos, ["alpha", "beta"]).map((r) => r.name).sort(), ["alpha", "beta"]);
  assert.equal(selectRepositories(repos, ["nomatch"]).length, 0);
});

test("countCommitsInWindow counts without reading commit bodies", async () => {
  const repo = await initRepo(await fs.mkdtemp(path.join(os.tmpdir(), "agentify-count-")));
  try {
    const all = await countCommitsInWindow(repo, {}, {});
    assert.equal(all, 1);
    // An upper bound before the commit excludes it.
    const past = await countCommitsInWindow(repo, {
      until: "2000-01-01T00:00:00.000Z",
      until_kind: "instant",
    });
    assert.equal(past, 0);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("countCommitsInWindow honours ref and date expression bounds", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-count-expr-"));
  try {
    await initRepo(repo, { subject: "feat: one" });
    await fs.writeFile(path.join(repo, "b.txt"), "x\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "feat: two"]);
    await fs.writeFile(path.join(repo, "c.txt"), "y\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "feat: three"]);

    // A ref lower bound is applied as a range (HEAD~2..HEAD => 2 commits), not
    // silently ignored (which would return the full history of 3).
    const sinceRef = await countCommitsInWindow(repo, { since: "HEAD~2", since_kind: "expression" });
    assert.equal(sinceRef, 2);

    // A future date lower bound excludes everything via git's own filter.
    const past = await countCommitsInWindow(repo, { until: "2000-01-01", until_kind: "expression" });
    assert.equal(past, 0);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("the cache is not written when it would land inside a scanned repository", async () => {
  // A repository whose own tree contains the resolved cache dir: writing the
  // cache there would violate the zero-install constraint, so it is skipped.
  const repo = await initRepo(await fs.mkdtemp(path.join(os.tmpdir(), "agentify-cache-inrepo-")));
  const xdgInsideRepo = path.join(repo, ".cache-fixture");
  try {
    const result = await discoverRepositories({
      roots: [repo],
      useCache: true,
      env: { ...process.env, XDG_CACHE_HOME: xdgInsideRepo },
    });
    assert.ok(result.repositories.some((r) => r.path === repo));
    assert.ok(result.limitations.some((line) => /inside a scanned repository/i.test(line)));
    // No cache file was written anywhere under the repository.
    await assert.rejects(() => fs.access(resolveDiscoveryCachePath({ env: { XDG_CACHE_HOME: xdgInsideRepo } })));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("CLI: git analyze --global --no-cache is accepted", async () => {
  const { root } = await buildFixtureTree();
  const cacheHome = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-cache-"));
  try {
    const result = await execFileAsync(
      "node",
      [CLI, "git", "analyze", "--global", "--root", root, "--no-cache", "--dry-run", "--format", "json"],
      { cwd: os.tmpdir(), env: { ...process.env, XDG_CACHE_HOME: cacheHome } },
    );
    assert.equal(JSON.parse(result.stdout).scope, "global");
    // --no-cache wrote nothing to the cache location.
    await assert.rejects(() => fs.access(resolveDiscoveryCachePath({ env: { XDG_CACHE_HOME: cacheHome } })));
  } finally {
    await cleanupFixture(root);
    await fs.rm(cacheHome, { recursive: true, force: true });
  }
});

test("CLI: git analyze --repo with a blank value is rejected", async () => {
  const { root } = await buildFixtureTree();
  try {
    await assert.rejects(
      () => execFileAsync("node", [CLI, "git", "analyze", "--global", "--root", root, "--repo=", "--dry-run"], { cwd: os.tmpdir() }),
      (error) => {
        assert.match(error.stderr || error.message, /--repo requires a non-empty pattern/i);
        return true;
      },
    );
  } finally {
    await cleanupFixture(root);
  }
});

test("global dry-run previews counts and never invokes the collector", async () => {
  let collectorCalls = 0;
  const collectSpy = async () => {
    collectorCalls += 1;
    throw new Error("collector must not run on a dry run");
  };
  const countCalls = [];
  const countSpy = async (repoPath) => {
    countCalls.push(repoPath);
    return 7;
  };

  const report = await runGitAnalyze("/unused", {
    scope: "global",
    dryRun: true,
    window: { days: 30 },
    repositories: [
      { path: "/w/alpha", name: "alpha" },
      { path: "/w/beta", name: "beta" },
    ],
    discovery: { roots: ["/w"], repositoriesFound: 2, fromCache: false, limitations: [] },
    collectCommits: collectSpy,
    countCommits: countSpy,
  });

  assert.equal(collectorCalls, 0, "the collector is never called on a dry run");
  assert.deepEqual(countCalls, ["/w/alpha", "/w/beta"]);
  assert.equal(report.scope, "global");
  assert.equal(report.dry_run, true);
  assert.equal(report.repositories.length, 2);
  assert.equal(report.repositories[0].window_commit_count, 7);
  assert.equal(report.counts.commits, 14);
  assert.ok(report.notes.some((n) => /Dry run/i.test(n)));
});

test("global real run keeps repositories separate and labels the aggregate", async () => {
  const collectSpy = async (repoPath) => {
    const isAlpha = repoPath.endsWith("alpha");
    return {
      commits: [
        {
          sha: isAlpha ? "a".repeat(40) : "b".repeat(40),
          authorEmail: isAlpha ? "one@example.com" : "two@example.com",
          issueKeys: isAlpha ? ["#1"] : ["#2"],
        },
      ],
      merges: [],
      branches: [],
      truncated: { commits: false, merges: false, files: false },
      notes: [],
      stats: {
        commits: isAlpha ? 3 : 5,
        merges: isAlpha ? 1 : 2,
        authors: 1,
        insertions: isAlpha ? 10 : 20,
        deletions: isAlpha ? 1 : 2,
        fileChanges: isAlpha ? 4 : 6,
        distinctFiles: isAlpha ? 4 : 6,
        binaryFiles: 0,
        filesExcluded: 0,
        issueRefs: 1,
        branches: isAlpha ? 1 : 2,
      },
    };
  };

  const report = await runGitAnalyze("/unused", {
    scope: "global",
    dryRun: false,
    window: { days: 30 },
    repositories: [
      { path: "/w/alpha", name: "alpha" },
      { path: "/w/beta", name: "beta" },
    ],
    discovery: { roots: ["/w"], repositoriesFound: 2, fromCache: false, limitations: ["a limitation"] },
    collectCommits: collectSpy,
  });

  assert.equal(report.repositories.length, 2);
  assert.equal(report.repositories[0].counts.commits, 3);
  assert.equal(report.repositories[1].counts.commits, 5);
  // Cross-repository aggregate: sum of commits, union of authors and issue refs.
  assert.equal(report.counts.commits, 8);
  assert.equal(report.counts.authors, 2);
  assert.equal(report.totals.insertions, 30);
  assert.equal(report.totals.merges, 3);
  assert.equal(report.totals.issue_refs, 2);
  // Discovery limitations surface as top-level notes.
  assert.ok(report.notes.includes("a limitation"));
  // Every commit record carries its repository so a downstream flatten never
  // blends two repos or loses provenance.
  assert.equal(report.repositories[0].commits[0].repository, "alpha");
  assert.equal(report.repositories[1].commits[0].repository, "beta");
});

// Integration guard for the #350 + #351 seam: discovery and filtering were
// built independently, and the global path originally collected commits without
// ever applying the filter set — so `--global --me --type feat` silently
// reported every commit in the window as if no filter had been passed.
test("global run applies filters per repository and reports each repo's match counts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-global-filters-"));
  const alpha = path.join(root, "alpha");
  const beta = path.join(root, "beta");
  await initRepo(alpha, { subject: "feat(core): alpha feature" });
  await initRepo(beta, { subject: "fix(core): beta fix" });
  // A second commit in alpha that the --type filter must exclude.
  await fs.writeFile(path.join(alpha, "chore.txt"), "x\n");
  await git(alpha, ["add", "."]);
  await git(alpha, ["commit", "-q", "-m", "chore: alpha housekeeping"]);

  const report = await runGitAnalyze("/unused", {
    scope: "global",
    dryRun: false,
    window: { days: 3650 },
    repositories: [
      { path: alpha, name: "alpha" },
      { path: beta, name: "beta" },
    ],
    discovery: { roots: [root], repositoriesFound: 2, fromCache: false, limitations: [] },
    filters: { type: "feat" },
  });

  // Only alpha's feat commit survives: the filter really ran.
  assert.equal(report.counts.commits, 1);
  const [alphaSection, betaSection] = report.repositories;
  assert.equal(alphaSection.counts.commits, 1);
  assert.equal(betaSection.counts.commits, 0);

  // Each repository carries its OWN match counts — a filter matching in one
  // repo and not another is normal and must not read as a global miss.
  const alphaType = alphaSection.filters.applied_filters.find((entry) => entry.kind === "type");
  const betaType = betaSection.filters.applied_filters.find((entry) => entry.kind === "type");
  assert.equal(alphaType.matched, 1);
  assert.equal(betaType.matched, 0);

  // The requested set is stated once at the top level.
  assert.ok(report.filters, "global report states the requested filter set");

  await fs.rm(root, { recursive: true, force: true });
});

test("CLI: git analyze --global --dry-run reports discovered repos and stays clean", async () => {
  const { root, alpha } = await buildFixtureTree();
  const cacheHome = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-cache-"));
  try {
    const before = await listTree(alpha);
    const result = await execFileAsync(
      "node",
      [CLI, "git", "analyze", "--global", "--root", root, "--dry-run", "--format", "json"],
      { cwd: os.tmpdir(), env: { ...process.env, XDG_CACHE_HOME: cacheHome } },
    );
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.scope, "global");
    assert.equal(payload.dry_run, true);
    const names = new Set(payload.repositories.map((r) => r.name));
    assert.deepEqual([...names].sort(), ["alpha", "beta", "gamma"]);

    // Nothing written inside a discovered repo, and no cache under the tree.
    assert.deepEqual(await listTree(alpha), before);
    const all = await listTree(root);
    assert.ok(!all.some((p) => p.endsWith("discovery.json")));
  } finally {
    await cleanupFixture(root);
    await fs.rm(cacheHome, { recursive: true, force: true });
  }
});

test("CLI: git analyze --repo matching nothing errors with the found list", async () => {
  const { root } = await buildFixtureTree();
  const cacheHome = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-cache-"));
  try {
    await assert.rejects(
      () => execFileAsync(
        "node",
        [CLI, "git", "analyze", "--global", "--root", root, "--repo", "does-not-exist", "--dry-run", "--format", "json"],
        { cwd: os.tmpdir(), env: { ...process.env, XDG_CACHE_HOME: cacheHome } },
      ),
      (error) => {
        assert.match(error.stderr || error.message, /matched none/i);
        assert.match(error.stderr || error.message, /alpha/);
        return true;
      },
    );
  } finally {
    await cleanupFixture(root);
    await fs.rm(cacheHome, { recursive: true, force: true });
  }
});

test("CLI: git analyze --repo requires --global; --local rejects multiple roots", async () => {
  const repo = await initRepo(await fs.mkdtemp(path.join(os.tmpdir(), "agentify-local-")));
  try {
    await assert.rejects(
      () => execFileAsync("node", [CLI, "git", "analyze", "--repo", "x", "--dry-run"], { cwd: repo }),
      (error) => {
        assert.match(error.stderr || error.message, /--repo .*requires --global/i);
        return true;
      },
    );
    await assert.rejects(
      () => execFileAsync("node", [CLI, "git", "analyze", "--root", repo, "--root", repo, "--dry-run"], { cwd: repo }),
      (error) => {
        assert.match(error.stderr || error.message, /single --root/i);
        return true;
      },
    );
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("DISCOVERY_DEFAULTS are the documented bounds", () => {
  assert.equal(DISCOVERY_DEFAULTS.maxDepth, 4);
  assert.equal(DISCOVERY_DEFAULTS.maxRepos, 200);
  assert.equal(DISCOVERY_DEFAULTS.wallClockMs, 10_000);
});
