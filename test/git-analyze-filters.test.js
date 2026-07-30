import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { collectCommits } from "../src/core/git-analyze/collect.js";
import { runGitAnalyze } from "../src/core/git-analyze/index.js";
import {
  resolveFilters,
  isFilterActive,
  describeRequestedFilters,
  resolveIdentities,
  resolveBranchRefs,
  applyFilters,
  compileGlob,
} from "../src/core/git-analyze/filters.js";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function git(root, args, env) {
  return execFileAsync("git", args, { cwd: root, env: env ? { ...process.env, ...env } : process.env });
}

const ALICE = { name: "Alice Dev", email: "alice@work.com" };
const ALICE_ALT = { name: "Alice Personal", email: "alice@personal.com" };
const BOB = { name: "Bob Builder", email: "bob@example.com" };

async function commit(root, { author, message, body, file }) {
  const abs = path.join(root, file);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${file}\ncontent\n`);
  await git(root, ["add", "."]);
  const env = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
  const args = ["commit", "-m", message];
  if (body) {
    args.push("-m", body);
  }
  await git(root, args, env);
  const { stdout } = await git(root, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

// A fixture with two identities for one human (linked by .mailmap), a third
// author, conventional and non-conventional subjects, GitHub and Jira issue
// citations, feature branches plus an agent scratch branch, a commit reachable
// from two branches, and paths inside and outside a filtered directory.
async function buildFixture({ withMailmap = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-filters-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", ALICE.name]);
  await git(root, ["config", "user.email", ALICE.email]);
  await git(root, ["config", "commit.gpgsign", "false"]);

  const sha = {};
  sha.core = await commit(root, { author: ALICE, message: "feat(core): add core (#1)", file: "src/core.js" });
  sha.acp = await commit(root, { author: ALICE, message: "fix(acp): patch acp handler", body: "relates to PROJ-1", file: "src/acp.js" });
  sha.wip = await commit(root, { author: BOB, message: "wip scratch", file: "notes.txt" });
  sha.ui = await commit(root, { author: ALICE_ALT, message: "feat(ui): personal ui work", file: "src/ui.js" });
  sha.lib = await commit(root, { author: BOB, message: "chore: bump lib", file: "lib/util.js" });

  const defaultBranch = (await git(root, ["branch", "--show-current"])).stdout.trim();

  // feat/a and feat/b both branch from the main tip (sha.lib), so every main
  // commit is reachable from BOTH — the dedup case for --branch 'feat/*'.
  await git(root, ["checkout", "-q", "-b", "feat/a"]);
  sha.a = await commit(root, { author: ALICE, message: "feat: work on a", file: "src/a.js" });
  await git(root, ["checkout", "-q", defaultBranch]);
  await git(root, ["checkout", "-q", "-b", "feat/b"]);
  sha.b = await commit(root, { author: ALICE, message: "feat: work on b", file: "src/b.js" });
  await git(root, ["checkout", "-q", defaultBranch]);
  await git(root, ["checkout", "-q", "-b", "worktree-agent-x"]);
  sha.agent = await commit(root, { author: ALICE, message: "feat: agent scratch", file: "src/agent.js" });
  await git(root, ["checkout", "-q", defaultBranch]);

  if (withMailmap) {
    // Link Alice's personal email to her canonical work identity.
    await fs.writeFile(path.join(root, ".mailmap"), `${ALICE.name} <${ALICE.email}> <${ALICE_ALT.email}>\n`);
  }

  return { root, sha, defaultBranch };
}

function shasOf(records) {
  return records.map((record) => record.sha).sort();
}

function expected(sha, labels) {
  return labels.map((label) => sha[label]).sort();
}

async function analyze(root, filters) {
  return runGitAnalyze(root, { window: { days: 3650 }, scope: "local", filters });
}

async function cleanup(root) {
  await fs.rm(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// resolveFilters (pure parsing).
// ---------------------------------------------------------------------------

test("resolveFilters normalizes comma lists, issue keys, and repeatable flags", () => {
  const set = resolveFilters({
    type: "feat, fix",
    scope: "ACP,Core",
    issue: ["12", "#7", "proj-1"],
    grep: ["a", "b"],
    author: "alice",
    me: true,
    includeMerges: true,
  });
  assert.deepEqual(set.types, ["feat", "fix"]);
  assert.deepEqual(set.scopes, ["acp", "core"]);
  assert.deepEqual(set.issues, ["#12", "#7", "PROJ-1"]);
  assert.deepEqual(set.grepPatterns, ["a", "b"]);
  assert.deepEqual(set.authorPatterns, ["alice"]);
  assert.equal(set.me, true);
  assert.equal(set.includeMerges, true);
  assert.equal(isFilterActive(set), true);
});

test("resolveFilters drops valueless repeatable occurrences and treats an empty set as inactive", () => {
  const set = resolveFilters({ grep: true, author: [true, "real"], type: "" });
  assert.deepEqual(set.grepPatterns, []);
  assert.deepEqual(set.authorPatterns, ["real"]);
  assert.deepEqual(set.types, []);
  assert.equal(isFilterActive(resolveFilters({})), false);
});

test("compileGlob honours * within a segment and ** across segments", () => {
  assert.equal(compileGlob("feat/*")("feat/a"), true);
  assert.equal(compileGlob("*")("feat/a"), false); // * does not cross '/'
  assert.equal(compileGlob("**")("feat/a"), true);
  // Metacharacters in user input are literal, not regex.
  assert.equal(compileGlob("fix(acp)")("fix(acp)"), true);
  assert.equal(compileGlob("fix(acp)")("fixXacpY"), false);
});

// ---------------------------------------------------------------------------
// Identity resolution.
// ---------------------------------------------------------------------------

test("resolveIdentities unions both emails for one human via .mailmap", async () => {
  const { root } = await buildFixture({ withMailmap: true });
  const identity = await resolveIdentities(root);
  assert.equal(identity.usedMailmap, true);
  assert.ok(identity.emails.includes("alice@work.com"));
  assert.ok(identity.emails.includes("alice@personal.com"), "mailmap alias is unioned in");
  await cleanup(root);
});

test("resolveIdentities without a .mailmap falls back to the config identity alone", async () => {
  const { root } = await buildFixture({ withMailmap: false });
  const identity = await resolveIdentities(root);
  assert.equal(identity.usedMailmap, false);
  assert.deepEqual(identity.emails, ["alice@work.com"]);
  await cleanup(root);
});

test("--me finds commits from both of one human's emails when a .mailmap links them", async () => {
  const { root, sha } = await buildFixture({ withMailmap: true });
  const report = await analyze(root, { me: true });
  // core + acp (work email) AND ui (personal email, canonicalized by mailmap).
  assert.deepEqual(shasOf(report.commits), expected(sha, ["core", "acp", "ui"]));
  assert.equal(report.filters.identities.used_mailmap, true);
  await cleanup(root);
});

test("--me without a .mailmap resolves one identity and states the limitation", async () => {
  const { root, sha } = await buildFixture({ withMailmap: false });
  const report = await analyze(root, { me: true });
  // Only the work-email commits; the personal-email commit is dropped.
  assert.deepEqual(shasOf(report.commits), expected(sha, ["core", "acp"]));
  assert.ok(report.notes.some((note) => /no \.mailmap found/.test(note) && /--author/.test(note)));
  await cleanup(root);
});

test("--me naming a single identity points at the other identities it excluded", async () => {
  const { root } = await buildFixture({ withMailmap: false });
  const report = await analyze(root, { me: true });
  const warnings = report.filters.warnings;

  // The same-name candidate is the actionable one: "Alice Personal" shares a
  // name token with "Alice Dev", so it is called out as probably the same human.
  const kin = warnings.find((warning) => warning.includes(ALICE_ALT.email));
  assert.ok(kin, `expected a hint naming ${ALICE_ALT.email}, got: ${JSON.stringify(warnings)}`);
  assert.match(kin, /shares a name with it/);
  assert.match(kin, /--author/);

  // An unrelated contributor is not insinuated to be the same person.
  assert.ok(!kin.includes(BOB.email), "Bob must not be named as the same person");

  await cleanup(root);
});

test("--me emits no identity hint when it is the only author in the window", async () => {
  // A solo repo: nothing to suggest, so the hint must stay silent rather than
  // nagging every single-contributor project that runs the command.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-filters-solo-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", ALICE.name]);
  await git(root, ["config", "user.email", ALICE.email]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await commit(root, { author: ALICE, message: "feat(core): alone", file: "src/core/a.js" });

  const report = await analyze(root, { me: true });
  assert.ok(
    !report.filters.warnings.some((warning) => /shares a name with it|were excluded|was excluded/.test(warning)),
    `unexpected identity hint: ${JSON.stringify(report.filters.warnings)}`,
  );
  await cleanup(root);
});

// ---------------------------------------------------------------------------
// Branch reachability.
// ---------------------------------------------------------------------------

test("resolveBranchRefs matches globs, ignores agent/bot branches, and reports zero-match globs", async () => {
  const { root } = await buildFixture();
  const feat = await resolveBranchRefs(root, ["feat/*"]);
  assert.deepEqual(feat.matchedNames.sort(), ["feat/a", "feat/b"]);
  assert.deepEqual(feat.refs.sort(), ["refs/heads/feat/a", "refs/heads/feat/b"]);

  // A bare catch-all does not sweep in the default-ignored agent branch...
  const all = await resolveBranchRefs(root, ["**"]);
  assert.ok(!all.matchedNames.includes("worktree-agent-x"), "agent branch is ignored under **");
  // ...but an explicit glob targeting it overrides the ignore.
  const explicit = await resolveBranchRefs(root, ["worktree-agent-*"]);
  assert.deepEqual(explicit.matchedNames, ["worktree-agent-x"]);

  const miss = await resolveBranchRefs(root, ["nope/*"]);
  assert.deepEqual(miss.refs, []);
  assert.deepEqual(miss.zeroGlobs, ["nope/*"]);
  await cleanup(root);
});

test("--branch returns each commit once even when reachable from two matching branches", async () => {
  const { root, sha } = await buildFixture();
  const report = await analyze(root, { branch: "feat/*" });
  const shas = shasOf(report.commits);
  // The main-tip commit is an ancestor of both feat/a and feat/b: exactly once.
  assert.equal(shas.filter((value) => value === sha.lib).length, 1);
  // The union covers the main line plus each branch's own commit, no agent work.
  assert.deepEqual(shas, expected(sha, ["core", "acp", "wip", "ui", "lib", "a", "b"]));
  const branchFilter = report.filters.applied_filters.find((entry) => entry.kind === "branch");
  assert.equal(branchFilter.unit, "refs");
  assert.equal(branchFilter.matched, 2);
  await cleanup(root);
});

test("--branch on an explicit agent glob overrides the default ignore", async () => {
  const { root, sha } = await buildFixture();
  const report = await analyze(root, { branch: "worktree-agent-*" });
  assert.ok(shasOf(report.commits).includes(sha.agent));
  await cleanup(root);
});

test("--branch matching no branch warns and yields an empty-but-explained report (exit-0 shape)", async () => {
  const { root } = await buildFixture();
  const report = await analyze(root, { branch: "release/*" });
  assert.deepEqual(report.commits, []);
  assert.equal(report.counts.commits, 0);
  assert.ok(report.notes.some((note) => /--branch "release\/\*" matched no branches/.test(note)));
  await cleanup(root);
});

// ---------------------------------------------------------------------------
// Composition matrix (exact SHA sets).
// ---------------------------------------------------------------------------

test("composition matrix: each filter and combination resolves to an exact SHA set", async () => {
  const { root, sha } = await buildFixture();
  const cases = [
    [{ type: "feat" }, ["core", "ui"]],
    [{ type: "feat,fix" }, ["core", "acp", "ui"]],
    [{ scope: "acp" }, ["acp"]],
    [{ type: "fix", scope: "acp" }, ["acp"]], // AND across kinds
    [{ grep: "patch acp" }, ["acp"]], // literal message search
    [{ issue: "#1" }, ["core"]], // GitHub ref
    [{ issue: "PROJ-1" }, ["acp"]], // Jira key from the body
    [{ author: "Bob" }, ["wip", "lib"]],
    [{ path: "src/**" }, ["core", "acp", "ui"]],
    [{ path: "lib/**" }, ["lib"]],
    [{ me: true, type: "feat" }, ["core", "ui"]], // identity AND type
    [{ grep: ["patch acp", "bump"] }, ["acp", "lib"]], // OR within a kind
  ];
  for (const [filters, labels] of cases) {
    const report = await analyze(root, filters);
    assert.deepEqual(
      shasOf(report.commits),
      expected(sha, labels),
      `filters ${JSON.stringify(filters)} should match ${labels.join(",")}`,
    );
  }
  await cleanup(root);
});

test("--branch composes with a type post-filter over the reachable set", async () => {
  const { root, sha } = await buildFixture();
  const report = await analyze(root, { branch: "feat/a", type: "feat" });
  // Reachable from feat/a = main line + a; feat-typed = core, ui, a.
  assert.deepEqual(shasOf(report.commits), expected(sha, ["core", "ui", "a"]));
  await cleanup(root);
});

// ---------------------------------------------------------------------------
// Per-filter reporting and zero-match warnings.
// ---------------------------------------------------------------------------

test("every filter reports its own match count and a zero match warns by name", async () => {
  const { root } = await buildFixture();
  const zeroCases = [
    [{ type: "perf,test" }, /--type perf,test matched no commits/],
    [{ scope: "billing" }, /--scope billing matched no commits/],
    [{ grep: "zzz-not-present" }, /--grep "zzz-not-present" matched no commit messages/],
    [{ issue: "#999" }, /--issue #999 matched no commits/],
    [{ author: "nobody-xyz" }, /--author "nobody-xyz" matched no commits/],
    [{ path: "docs/**" }, /--path "docs\/\*\*" matched no changed files/],
  ];
  for (const [filters, pattern] of zeroCases) {
    const report = await analyze(root, filters);
    assert.equal(report.counts.commits, 0, `${JSON.stringify(filters)} should be empty`);
    assert.ok(report.filters.warnings.some((warning) => pattern.test(warning)), `warning for ${JSON.stringify(filters)}`);
    // A zero match is still a successful, explained report.
    assert.ok(report.filters.applied);
  }
  await cleanup(root);
});

test("applyFilters counts each filter independently against the base set", async () => {
  const { root } = await buildFixture();
  const collection = await collectCommits(root);
  const set = resolveFilters({ type: "feat", author: "Bob" });
  const result = applyFilters(collection, set);
  const typeEntry = result.filters.applied_filters.find((entry) => entry.kind === "type");
  const authorEntry = result.filters.applied_filters.find((entry) => entry.kind === "author");
  assert.equal(typeEntry.matched, 2); // core, ui
  assert.equal(authorEntry.matched, 2); // wip, lib
  // The AND of the two is empty, but neither filter is blamed with a warning.
  assert.equal(result.commits.length, 0);
  assert.equal(result.warnings.length, 0);
  await cleanup(root);
});

// ---------------------------------------------------------------------------
// Merge interaction.
// ---------------------------------------------------------------------------

test("--include-merges keeps merges and a --type filter never silently drops them", async () => {
  const { root, defaultBranch } = await buildFixture();
  // Create a real merge commit (Alice) so there is delivery evidence to keep.
  await git(root, ["merge", "--no-ff", "-m", "Merge branch feat/a (#42)", "feat/a"], {
    GIT_AUTHOR_NAME: ALICE.name,
    GIT_AUTHOR_EMAIL: ALICE.email,
    GIT_COMMITTER_NAME: ALICE.name,
    GIT_COMMITTER_EMAIL: ALICE.email,
  });
  assert.equal((await git(root, ["branch", "--show-current"])).stdout.trim(), defaultBranch);

  const report = await analyze(root, { includeMerges: true, type: "feat" });
  // The merge has no conventional type but must survive the --type filter.
  assert.equal(report.merges.length, 1);
  assert.ok(report.merges[0].subject.includes("Merge branch feat/a"));
  await cleanup(root);
});

test("merges stay visible as delivery evidence under a filter; --include-merges makes them count", async () => {
  const { root, defaultBranch } = await buildFixture();
  await git(root, ["merge", "--no-ff", "-m", "Merge branch feat/a (#42)", "feat/a"], {
    GIT_AUTHOR_NAME: ALICE.name,
    GIT_AUTHOR_EMAIL: ALICE.email,
    GIT_COMMITTER_NAME: ALICE.name,
    GIT_COMMITTER_EMAIL: ALICE.email,
  });
  assert.equal((await git(root, ["branch", "--show-current"])).stdout.trim(), defaultBranch);

  const unfiltered = await analyze(root, {});
  assert.equal(unfiltered.totals.merges, 1, "baseline: the merge is evidence");

  // A filter must not make Alice's own merge disappear. Reporting "0 merges
  // landed" to someone who landed one — while the unfiltered report beside it
  // counts it — is the exact reconciliation failure the epic forbids.
  const filtered = await analyze(root, { me: true });
  assert.equal(filtered.totals.merges, 1, "the identity's own merge survives --me");
  assert.equal(filtered.merges.length, 1);

  // Evidence only: it is not folded into the commit count...
  const withoutFlag = filtered.counts.commits;
  // ...until --include-merges opts it in.
  const counted = await analyze(root, { me: true, includeMerges: true });
  assert.equal(counted.counts.commits, withoutFlag + 1);
  assert.equal(counted.totals.merges, 1);

  await cleanup(root);
});

// ---------------------------------------------------------------------------
// Injection safety.
// ---------------------------------------------------------------------------

test("hostile --grep / --author values are literal text with no shell side effect", async () => {
  const { root } = await buildFixture();
  const before = (await fs.readdir(root)).sort();

  // execFile (no shell) via the real CLI: the payloads must be inert text.
  const { stdout } = await execFileAsync(
    "node",
    [CLI, "git", "analyze", "--days", "3650", "--grep", "$(touch pwned)", "--author", "; rm -rf .", "--format", "json"],
    { cwd: root },
  );
  const report = JSON.parse(stdout);
  assert.equal(report.counts.commits, 0); // nothing matches the literal payloads
  assert.ok(report.filters.warnings.length >= 2);

  const after = (await fs.readdir(root)).sort();
  assert.deepEqual(after, before, "no file was created or removed");
  assert.equal(after.includes("pwned"), false);
  await cleanup(root);
});

// ---------------------------------------------------------------------------
// Report surfaces and the unfiltered baseline.
// ---------------------------------------------------------------------------

test("an unfiltered run leaves the report shape unchanged (no filters applied)", async () => {
  const { root } = await buildFixture();
  const report = await analyze(root, {});
  assert.equal(report.filters.applied, false);
  assert.deepEqual(report.filters.applied_filters, []);
  // binary_files stays a number (not the filtered null) on the unfiltered path.
  assert.equal(typeof report.totals.binary_files, "number");
  await cleanup(root);
});

test("describeRequestedFilters echoes requested filters with null counts for dry runs", async () => {
  const { root } = await buildFixture();
  const report = await runGitAnalyze(root, { window: { days: 3650 }, scope: "local", dryRun: true, filters: { me: true, type: "feat" } });
  assert.equal(report.commits_read, false);
  assert.equal(report.filters.applied, true);
  assert.ok(report.filters.applied_filters.every((entry) => entry.matched === null));
  // Sanity: the pure describe helper matches what the dry run embedded.
  assert.deepEqual(report.filters, describeRequestedFilters(resolveFilters({ me: true, type: "feat" })));
  await cleanup(root);
});

test("the resolved filter set with per-filter counts appears in text and json output", async () => {
  const { root } = await buildFixture();
  const { stdout: jsonOut } = await execFileAsync(
    "node",
    [CLI, "git", "analyze", "--days", "3650", "--type", "feat", "--format", "json"],
    { cwd: root },
  );
  const report = JSON.parse(jsonOut);
  const typeEntry = report.filters.applied_filters.find((entry) => entry.kind === "type");
  assert.equal(typeEntry.matched, 2);

  // The human-readable renderer writes via ui.log() to stderr.
  const { stderr: textOut } = await execFileAsync(
    "node",
    [CLI, "git", "analyze", "--days", "3650", "--type", "feat", "--format", "text"],
    { cwd: root },
  );
  assert.match(textOut, /filters:/);
  assert.match(textOut, /--type feat: matched 2 commits/);
  await cleanup(root);
});

// ---------------------------------------------------------------------------
// collect.js branch-reachability pushdown contract.
// ---------------------------------------------------------------------------

test("collectCommits treats an empty refs array as 'no reachable branch', not a HEAD fallback", async () => {
  const { root } = await buildFixture();
  const empty = await collectCommits(root, { refs: [] });
  assert.deepEqual(empty.commits, []);
  assert.deepEqual(empty.merges, []);
  // The branch table is still enumerated (the read proceeds; only history is skipped).
  assert.ok(empty.branches.length >= 3);

  const head = await collectCommits(root, { refs: null });
  assert.ok(head.commits.length > 0, "null refs reads default HEAD reachability");
  await cleanup(root);
});
