import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  clusterCommits,
  buildGitAnalyzeSummary,
  SUMMARY_SCHEMA,
  DEFAULT_MIN_THEME_COMMITS,
} from "../src/core/git-analyze/cluster.js";
import { computeBranchOwnership } from "../src/core/git-analyze/collect.js";
import { runGitAnalyze } from "../src/core/git-analyze/index.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Synthetic #349 records: cluster.js is a pure transform, so it is tested
// against hand-built records rather than a git fixture (fast, deterministic).
// ---------------------------------------------------------------------------

let shaCounter = 0;
function nextSha() {
  shaCounter += 1;
  return shaCounter.toString(16).padStart(40, "0");
}

function rec(overrides = {}) {
  const sha = overrides.sha || nextSha();
  return {
    sha,
    short: sha.slice(0, 7),
    authoredAt: "2026-06-01T10:00:00+00:00",
    authorName: "Alice Dev",
    authorEmail: "alice@work.com",
    subject: "change",
    body: "",
    type: null,
    scope: null,
    breaking: false,
    issueKeys: [],
    isMerge: false,
    isRevert: false,
    revertOf: null,
    insertions: 1,
    deletions: 0,
    files: [],
    filesExcluded: 0,
    ...overrides,
  };
}

// A local report wrapper around a record set, with totals computed from the
// records so the theme-sum invariant is meaningful.
function makeLocalReport(commits, merges = []) {
  let insertions = 0;
  let deletions = 0;
  const files = new Set();
  const authors = new Set();
  for (const record of commits) {
    insertions += record.insertions || 0;
    deletions += record.deletions || 0;
    for (const file of record.files || []) files.add(file);
    authors.add(record.authorEmail);
  }
  return {
    command: "git analyze",
    scope: "local",
    generated_at: "2026-07-29T00:00:00.000Z",
    window: { label: "test", since: "2026-01-01", until: "2026-08-01", timezone: "UTC" },
    repository: { path: "/tmp/repo", is_git_repository: true },
    counts: { commits: commits.length, authors: authors.size, repositories: 1 },
    totals: {
      insertions,
      deletions,
      distinct_files: files.size,
      file_changes: files.size,
      binary_files: 0,
      files_excluded: 0,
      merges: merges.length,
      issue_refs: 0,
      branches: 0,
    },
    truncated: { commits: false, merges: false, files: false, fileEntries: false },
    commits,
    merges,
    branches: [],
    filters: { applied: false, include_merges: false, identities: null, applied_filters: [], warnings: [] },
    notes: [],
  };
}

test("clusterCommits produces all five cluster kinds and buckets the single-commit tail", () => {
  const commits = [
    // 1. issue key
    rec({ issueKeys: ["#100"], type: "feat", insertions: 5 }),
    rec({ issueKeys: ["#100"], type: "fix", insertions: 3 }),
    // 2. branch (no issue key/scope; owned via the injected map)
    rec({ sha: "b1".padStart(40, "0"), files: ["a/x.js"] }),
    rec({ sha: "b2".padStart(40, "0"), files: ["b/y.js"] }),
    // 3. conventional scope
    rec({ scope: "acp", type: "fix" }),
    rec({ scope: "acp", type: "feat" }),
    // 4. directory overlap
    rec({ files: ["src/core/a.js", "src/core/b.js"] }),
    rec({ files: ["src/main.js"] }),
    // 5. unclustered (root files only, no issue/scope/branch)
    rec({ files: ["README.md"] }),
    rec({ files: ["LICENSE"] }),
    // tail of single-commit themes (unique issue keys) -> bucket
    rec({ issueKeys: ["#900"] }),
    rec({ issueKeys: ["#901"] }),
    rec({ issueKeys: ["#902"] }),
  ];
  const branchOwnership = new Map([
    ["b1".padStart(40, "0"), "feat/x"],
    ["b2".padStart(40, "0"), "feat/x"],
  ]);

  const { themes, smallerChanges } = clusterCommits(commits, {
    branchOwnership,
    repository: "repo",
  });

  const kinds = new Set(themes.map((t) => t.key_kind));
  assert.ok(kinds.has("issue"), "issue kind present");
  assert.ok(kinds.has("branch"), "branch kind present");
  assert.ok(kinds.has("scope"), "scope kind present");
  assert.ok(kinds.has("directory"), "directory kind present");
  assert.ok(kinds.has("unclustered"), "unclustered kind present");

  // The three unique single-commit issue themes collapse into one bucket.
  assert.ok(smallerChanges, "bucket exists");
  assert.equal(smallerChanges.commits, 3);
  assert.equal(smallerChanges.distinct_keys, 3);
});

test("every commit lands somewhere: no prefix, no issue, no branch is never dropped", () => {
  const commits = [
    rec({ files: ["README.md"] }),
    rec({ files: [] }),
    rec({ subject: "wip", files: ["notes.txt"] }),
  ];
  const { themes, smallerChanges } = clusterCommits(commits, { repository: "repo" });
  const placed = themes.reduce((n, t) => n + t.commits, 0) + (smallerChanges ? smallerChanges.commits : 0);
  assert.equal(placed, commits.length, "all commits accounted for");
});

test("a theme's commit count, insertions, and deletions equal the sum over its cited SHAs", () => {
  // A small deterministic PRNG so a failure is reproducible.
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const kinds = ["issue", "scope", "dir", "root"];
  const commits = [];
  const branchOwnership = new Map();
  for (let i = 0; i < 200; i += 1) {
    const kind = kinds[Math.floor(rand() * kinds.length)];
    const base = {
      insertions: Math.floor(rand() * 500),
      deletions: Math.floor(rand() * 200),
    };
    if (kind === "issue") {
      commits.push(rec({ ...base, issueKeys: [`#${1 + Math.floor(rand() * 6)}`] }));
    } else if (kind === "scope") {
      commits.push(rec({ ...base, scope: ["acp", "analyze", "ctx"][Math.floor(rand() * 3)] }));
    } else if (kind === "dir") {
      commits.push(rec({ ...base, files: [`${["src", "test", "docs"][Math.floor(rand() * 3)]}/f${i}.js`] }));
    } else {
      commits.push(rec({ ...base, files: ["root.txt"] }));
    }
  }

  const byResolvedSum = (record) => ({ i: record.insertions, d: record.deletions });
  const bySha = new Map(commits.map((c) => [c.sha, byResolvedSum(c)]));

  const { themes, smallerChanges } = clusterCommits(commits, { branchOwnership, repository: "repo" });

  let totalCommits = 0;
  let totalIns = 0;
  let totalDel = 0;
  for (const theme of themes) {
    let i = 0;
    let d = 0;
    for (const sha of theme.shas) {
      i += bySha.get(sha).i;
      d += bySha.get(sha).d;
    }
    assert.equal(theme.shas.length, theme.commits, `${theme.id} sha count`);
    assert.equal(i, theme.insertions, `${theme.id} insertions`);
    assert.equal(d, theme.deletions, `${theme.id} deletions`);
    totalCommits += theme.commits;
    totalIns += theme.insertions;
    totalDel += theme.deletions;
  }
  if (smallerChanges) {
    totalCommits += smallerChanges.commits;
    totalIns += smallerChanges.insertions;
    totalDel += smallerChanges.deletions;
  }

  const expectedIns = commits.reduce((n, c) => n + c.insertions, 0);
  const expectedDel = commits.reduce((n, c) => n + c.deletions, 0);
  assert.equal(totalCommits, commits.length, "commits partition the input");
  assert.equal(totalIns, expectedIns, "insertions partition the input");
  assert.equal(totalDel, expectedDel, "deletions partition the input");
});

test("headline totals equal the sum over themes plus the smaller-changes bucket", () => {
  const commits = [
    rec({ issueKeys: ["#1"], insertions: 10, deletions: 2 }),
    rec({ issueKeys: ["#1"], insertions: 4, deletions: 1 }),
    rec({ scope: "acp", insertions: 7 }),
    rec({ scope: "acp", insertions: 2 }),
    rec({ issueKeys: ["#99"], insertions: 3 }), // single -> bucket
  ];
  const summary = buildGitAnalyzeSummary(makeLocalReport(commits));

  let commitSum = 0;
  let insSum = 0;
  for (const theme of summary.themes) {
    commitSum += theme.commits;
    insSum += theme.insertions;
  }
  for (const bucket of summary.smaller_changes) {
    commitSum += bucket.commits;
    insSum += bucket.insertions;
  }
  assert.equal(commitSum, summary.totals.commits);
  assert.equal(insSum, summary.totals.insertions);
  assert.equal(summary.totals.commits, commits.length);
});

test("under --include-merges the headline (merge-inclusive) equals the sum over themes", () => {
  const commits = [
    rec({ issueKeys: ["#1"], insertions: 5 }),
    rec({ issueKeys: ["#1"], insertions: 3 }),
  ];
  // Two merges opted into the count; they carry no churn and cite an issue.
  const merges = [
    rec({ isMerge: true, insertions: 0, subject: "Merge #1", issueKeys: ["#1"], authoredAt: "2026-06-05T09:00:00+00:00" }),
    rec({ isMerge: true, insertions: 0, subject: "Merge #9", issueKeys: ["#9"], authoredAt: "2026-06-06T09:00:00+00:00" }),
  ];
  const report = makeLocalReport(commits, merges);
  // Mirror #351 under --include-merges: merges fold into the commit count.
  report.counts.commits = commits.length + merges.length;
  report.totals.merges = merges.length;
  report.filters = { ...report.filters, applied: true, include_merges: true };

  const summary = buildGitAnalyzeSummary(report);
  let commitSum = 0;
  for (const theme of summary.themes) commitSum += theme.commits;
  for (const bucket of summary.smaller_changes) commitSum += bucket.commits;
  assert.equal(summary.totals.commits, 4, "headline counts the two merges too");
  assert.equal(commitSum, summary.totals.commits, "themes+bucket account for every counted commit");
  // A merge-inclusive run has dated activity from the merges, never zero.
  assert.ok(summary.totals.active_days >= 1);
});

test("theme assignment and ordering are independent of input order", () => {
  // A theme's `shas` list follows input (git-log) order — meaningful evidence
  // order — so normalize it before comparing: what must be order-independent is
  // which commits land in which theme, the theme aggregates, and the theme sort.
  const normalize = (themes) => themes.map((t) => ({ ...t, shas: [...t.shas].sort() }));
  const build = (order) => {
    const commits = order.map((n) => rec({ sha: n.toString(16).padStart(40, "0"), issueKeys: [`#${n % 3}`], insertions: n }));
    return JSON.stringify(normalize(clusterCommits(commits, { repository: "repo" }).themes));
  };
  const forward = build([1, 2, 3, 4, 5, 6, 7, 8]);
  const shuffled = build([8, 3, 6, 1, 5, 2, 7, 4]);
  assert.equal(forward, shuffled, "theme assignment/ordering is identical regardless of commit order");
});

test("buildGitAnalyzeSummary is byte-identical across repeated runs", () => {
  const commits = [
    rec({ issueKeys: ["#1"], insertions: 5 }),
    rec({ issueKeys: ["#1"], insertions: 3 }),
    rec({ scope: "acp" }),
    rec({ scope: "acp" }),
  ];
  const report = makeLocalReport(commits);
  const a = JSON.stringify(buildGitAnalyzeSummary(report));
  const b = JSON.stringify(buildGitAnalyzeSummary(report));
  assert.equal(a, b);
  const s = JSON.parse(a);
  assert.equal(s.schema, SUMMARY_SCHEMA);
});

test("themes below minThemeCommits go to the bucket; the default is 2", () => {
  const commits = [rec({ issueKeys: ["#1"] }), rec({ issueKeys: ["#2"] }), rec({ issueKeys: ["#3"] })];
  const { themes, smallerChanges } = clusterCommits(commits, { repository: "repo" });
  assert.equal(DEFAULT_MIN_THEME_COMMITS, 2);
  assert.equal(themes.length, 0, "three distinct single-commit themes are all bucketed");
  assert.equal(smallerChanges.commits, 3);
});

test("themes are never merged across repositories on an identical issue key (global)", () => {
  const globalReport = {
    command: "git analyze",
    scope: "global",
    generated_at: "2026-07-29T00:00:00.000Z",
    window: { label: "test", since: "2026-01-01", until: "2026-08-01", timezone: "UTC" },
    counts: { repositories: 2, commits: 4, authors: 1 },
    totals: { insertions: 4, deletions: 0, distinct_files: 0, merges: 0, issue_refs: 1, across_repositories: 2 },
    repositories: [
      {
        name: "repo-a", path: "/a", is_git_repository: true, commits_read: true,
        counts: { commits: 2, authors: 1 },
        totals: { insertions: 2, deletions: 0, distinct_files: 0, merges: 0 },
        commits: [rec({ issueKeys: ["#5"], repository: "repo-a" }), rec({ issueKeys: ["#5"], repository: "repo-a" })],
        merges: [], branches: [], notes: [],
      },
      {
        name: "repo-b", path: "/b", is_git_repository: true, commits_read: true,
        counts: { commits: 2, authors: 1 },
        totals: { insertions: 2, deletions: 0, distinct_files: 0, merges: 0 },
        commits: [rec({ issueKeys: ["#5"], repository: "repo-b" }), rec({ issueKeys: ["#5"], repository: "repo-b" })],
        merges: [], branches: [], notes: [],
      },
    ],
    notes: [],
  };
  const summary = buildGitAnalyzeSummary(globalReport);
  const issueThemes = summary.themes.filter((t) => t.key === "#5");
  assert.equal(issueThemes.length, 2, "one #5 theme per repository, never merged");
  assert.deepEqual(issueThemes.map((t) => t.repository).sort(), ["repo-a", "repo-b"]);
});

test("global summary carries per-repository filter receipts (self-contained)", () => {
  const mkRepo = (name, matched) => ({
    name, path: `/${name}`, is_git_repository: true, commits_read: true,
    counts: { commits: 1, authors: 1 },
    totals: { insertions: 1, deletions: 0, distinct_files: 0, merges: 0 },
    commits: [rec({ type: "feat", repository: name })],
    merges: [], branches: [], notes: [],
    // The per-repo resolved receipt the pipeline stores under --global.
    filters: {
      applied: true, include_merges: false,
      identities: { emails: [`${name}@x`], names: [name], used_mailmap: false, resolved: 1 },
      applied_filters: [{ kind: "type", flag: "--type", values: ["feat"], matched, unit: "commits" }],
      warnings: [],
    },
  });
  const report = {
    command: "git analyze", scope: "global", generated_at: "x",
    window: { label: "t", since: "2026-01-01", until: "2026-08-01", timezone: "UTC" },
    counts: { repositories: 2, commits: 2, authors: 2 },
    totals: { insertions: 2, deletions: 0, distinct_files: 0, merges: 0, issue_refs: 0, across_repositories: 2 },
    repositories: [mkRepo("repo-a", 1), mkRepo("repo-b", 1)],
    filters: { applied: true, include_merges: false, identities: null, applied_filters: [], warnings: [] },
    notes: [],
  };
  const summary = buildGitAnalyzeSummary(report);
  for (const repo of summary.repositories) {
    assert.ok(repo.filters, `${repo.name} carries a filter receipt`);
    assert.ok(repo.filters.identities, `${repo.name} carries identities`);
    const typeEntry = repo.filters.applied_filters.find((e) => e.kind === "type");
    assert.equal(typeEntry.matched, 1);
  }
});

// ---------------------------------------------------------------------------
// computeBranchOwnership: the bounded, read-only git pass that feeds tier 2.
// ---------------------------------------------------------------------------

async function git(root, args, env) {
  return execFileAsync("git", args, { cwd: root, env: env ? { ...process.env, ...env } : process.env });
}

test("computeBranchOwnership attributes commits unique to one branch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ownership-"));
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.name", "Alice"]);
    await git(root, ["config", "user.email", "alice@work.com"]);
    await fs.writeFile(path.join(root, "base.txt"), "base\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-q", "-m", "base"]);
    const mainSha = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    // Capture the mainline branch name BEFORE switching away from it.
    const defaultBranch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();

    await git(root, ["checkout", "-q", "-b", "feat/x"]);
    await fs.writeFile(path.join(root, "x.txt"), "x\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-q", "-m", "feature work"]);
    const featSha = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();

    // With BOTH branches as candidates, base.txt's commit is reachable from both
    // (count 2 -> not owned), while the feature commit is unique to feat/x
    // (count 1 -> owned). This is the "reachable only from one branch" test.
    const windowShas = new Set([mainSha, featSha]);
    const { ownership } = await computeBranchOwnership(root, {
      candidateNames: ["feat/x", defaultBranch],
      windowShas,
    });
    assert.equal(ownership.get(featSha), "feat/x", "feature commit owned by feat/x");
    assert.equal(ownership.has(mainSha), false, "shared base commit is not owned");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("no branch themes form when the mainline cannot be identified (correctness over completeness)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-notrunk-"));
  try {
    // A non-standard default branch (no main/master, no origin HEAD) plus a
    // feature branch. Without a known trunk we cannot tell feature from trunk,
    // so branch clustering must be skipped entirely — never mislabel trunk
    // commits as a "Branch develop" theme.
    await git(root, ["init", "-q", "-b", "develop"]);
    await git(root, ["config", "user.name", "Alice"]);
    await git(root, ["config", "user.email", "alice@work.com"]);
    for (const f of ["a.txt", "b.txt"]) {
      await fs.writeFile(path.join(root, f), "x\n");
      await git(root, ["add", "."]);
      await git(root, ["commit", "-q", "-m", `work ${f}`]);
    }
    await git(root, ["checkout", "-q", "-b", "feat/x"]);
    await fs.writeFile(path.join(root, "c.txt"), "y\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-q", "-m", "feature"]);
    // Make a develop-only commit after the fork (the one prior code mislabeled).
    await git(root, ["checkout", "-q", "develop"]);
    await fs.writeFile(path.join(root, "d.txt"), "z\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-q", "-m", "more trunk"]);

    const report = await runGitAnalyze(root, { window: { days: 3650 }, scope: "local" });
    const branchThemes = report.summary.themes.filter((t) => t.key_kind === "branch");
    assert.equal(branchThemes.length, 0, "no branch themes without an identifiable trunk");
    assert.ok(
      report.notes.some((n) => /no mainline branch/i.test(n)),
      "the skip is disclosed as a limitation",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runGitAnalyze clusters unmerged feature-branch commits under a branch theme (real git)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-branchtheme-"));
  try {
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.name", "Alice"]);
    await git(root, ["config", "user.email", "alice@work.com"]);
    // Trunk history: conventional commits that would cluster by scope/directory.
    for (const [file, msg] of [["src/a.js", "feat(core): a"], ["src/b.js", "feat(core): b"]]) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), "x\n");
      await git(root, ["add", "."]);
      await git(root, ["commit", "-q", "-m", msg]);
    }
    // An unmerged feature branch with NON-conventional, NON-issue commits that
    // touch unrelated root files — so only branch attribution can group them.
    await git(root, ["checkout", "-q", "-b", "feat/work"]);
    for (const [file, msg] of [["notes-one.txt", "wip one"], ["notes-two.txt", "wip two"]]) {
      await fs.writeFile(path.join(root, file), "y\n");
      await git(root, ["add", "."]);
      await git(root, ["commit", "-q", "-m", msg]);
    }

    const report = await runGitAnalyze(root, { window: { days: 3650 }, scope: "local" });
    const branchTheme = report.summary.themes.find((t) => t.key_kind === "branch");
    assert.ok(branchTheme, "a branch theme was formed for the feature-branch work");
    assert.equal(branchTheme.key, "feat/work");
    assert.equal(branchTheme.commits, 2);
    // Trunk commits are not swept into the branch theme (mainline exclusion).
    assert.ok(!branchTheme.shas.includes((await git(root, ["rev-parse", "main"])).stdout.trim()));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
