import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runGitAnalyze, GIT_ANALYZE_SCHEMA_VERSION } from "../src/core/git-analyze/index.js";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

// The window resolver reads the process timezone for its calendar arithmetic,
// so pin it around assertions that check absolute instants.
async function withTZ(tz, fn) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
}

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "# fixture\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "feat: initial commit"], { cwd: root });
}

// Recursive listing of the working tree, excluding .git internals. Used to
// assert the analysed repo is untouched.
async function listTree(root) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        await walk(abs);
      } else {
        const stat = await fs.stat(abs);
        out.push(`${rel}:${stat.size}`);
      }
    }
  }
  await walk(root);
  return out.sort();
}

test("runGitAnalyze returns a zero-count report for a git repo without reading commits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-analyze-"));
  await initGitRepo(root);

  const report = await withTZ("UTC", () => runGitAnalyze(root, {
    window: { days: 14 },
    scope: "local",
    dryRun: true,
    now: new Date("2026-07-29T12:00:00.000Z"),
  }));

  assert.equal(report.command, "git analyze");
  assert.equal(report.schema_version, GIT_ANALYZE_SCHEMA_VERSION);
  assert.equal(report.scope, "local");
  assert.equal(report.dry_run, true);
  assert.equal(report.repository.is_git_repository, true);
  // Repository path is the git top-level (canonical real path from git), which
  // may differ from path.resolve(root) under symlinked temp dirs.
  const topLevel = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: root })).stdout.trim();
  assert.equal(report.repository.path, topLevel);
  assert.equal(report.window.form, "days");
  assert.equal(report.window.since, "2026-07-15T12:00:00.000Z");
  assert.equal(report.commits_read, false);
  assert.equal(report.counts.commits, 0);
  assert.equal(report.counts.repositories, 1);
  assert.ok(report.notes.some((note) => /no commit history has been read/i.test(note)));

  await fs.rm(root, { recursive: true, force: true });
});

test("runGitAnalyze --local errors with one actionable line outside a git repo", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-nogit-"));
  await assert.rejects(
    () => runGitAnalyze(root, { window: {}, scope: "local" }),
    /needs a git repository/,
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("runGitAnalyze scope=global is a valid downstream contract that does not require a repo", async () => {
  // The #348 CLI never reaches this path (global is deferred to #350), but the
  // report shape is frozen here so #350 can build on it.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-global-"));
  const report = await runGitAnalyze(root, { window: {}, scope: "global" });
  assert.equal(report.scope, "global");
  assert.equal(report.counts.repositories, 0);
  assert.ok(report.notes.some((note) => /#350/.test(note)));
  await fs.rm(root, { recursive: true, force: true });
});

test("runGitAnalyze reports the git top-level when run from a subdirectory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-subdir-"));
  await initGitRepo(root);
  const subdir = path.join(root, "src", "nested");
  await fs.mkdir(subdir, { recursive: true });

  const report = await runGitAnalyze(subdir, { window: {}, scope: "local" });
  const topLevel = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: subdir })).stdout.trim();
  assert.equal(report.repository.path, topLevel);
  assert.notEqual(report.repository.path, path.resolve(subdir));

  await fs.rm(root, { recursive: true, force: true });
});

test("git analyze --dry-run exits 0 and touches nothing in a repo with no Agentify install", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-zeroinstall-"));
  await initGitRepo(root);

  // Precondition: a pristine repo with no Agentify footprint whatsoever.
  const beforeTree = await listTree(root);
  const beforeStatus = await execFileAsync("git", ["status", "--porcelain"], { cwd: root });

  const result = await execFileAsync("node", [CLI, "git", "analyze", "--dry-run"], { cwd: root });
  assert.match(result.stdout + result.stderr, /Agentify git analyze/);

  // No .agentify.yaml, no .agentify/ directory, no index — created by the run.
  const afterTree = await listTree(root);
  const afterStatus = await execFileAsync("git", ["status", "--porcelain"], { cwd: root });

  assert.deepEqual(afterTree, beforeTree, "the working tree must be byte-identical after the run");
  assert.equal(afterStatus.stdout, beforeStatus.stdout, "git status must be unchanged after the run");
  assert.equal(afterStatus.stdout.trim(), "", "the fixture repo must stay clean");

  // Explicitly assert none of the install artifacts appeared.
  await assert.rejects(() => fs.access(path.join(root, ".agentify.yaml")));
  await assert.rejects(() => fs.access(path.join(root, ".agentify")));

  await fs.rm(root, { recursive: true, force: true });
});

test("git analyze --dry-run ignores a stale .agentify/link.json (zero-install, no project store)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-staleklink-"));
  await initGitRepo(root);
  // A valid-schema link missing project_store makes resolveAgentifyPaths throw.
  // git analyze must not consult the project store at all, so this must not fail.
  await fs.mkdir(path.join(root, ".agentify"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".agentify", "link.json"),
    JSON.stringify({ kind: "agentify-linked-project", schema_version: 2 }),
    "utf8",
  );

  const result = await execFileAsync("node", [CLI, "git", "analyze", "--dry-run"], { cwd: root });
  assert.match(result.stdout + result.stderr, /Agentify git analyze/);

  await fs.rm(root, { recursive: true, force: true });
});

test("git analyze accepts a single --root but rejects repeated discovery roots", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-oneroot-"));
  await initGitRepo(repo);

  // Single --root: the standard command root, analyzed from elsewhere.
  const ok = await execFileAsync("node", [CLI, "git", "analyze", "--dry-run", "--root", repo, "--format", "json"], { cwd: os.tmpdir() });
  const payload = JSON.parse(ok.stdout);
  const topLevel = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: repo })).stdout.trim();
  assert.equal(payload.repository.path, topLevel);

  // Repeated --root: the (unimplemented) discovery-roots semantics.
  await assert.rejects(
    () => execFileAsync("node", [CLI, "git", "analyze", "--dry-run", "--root", "/tmp", "--root", repo], { cwd: os.tmpdir() }),
    (error) => {
      assert.match(error.stderr, /multiple --root values \(repeatable discovery roots, #350\)/);
      return true;
    },
  );

  await fs.rm(repo, { recursive: true, force: true });
});

test("git analyze --format json emits clean machine-readable output on stdout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-json-"));
  await initGitRepo(root);

  const result = await execFileAsync("node", [CLI, "git", "analyze", "--quarter", "1", "--year", "2024", "--dry-run", "--format", "json"], {
    cwd: root,
    env: { ...process.env, TZ: "UTC" },
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "git analyze");
  assert.equal(payload.window.since, "2024-01-01T00:00:00.000Z");
  assert.equal(payload.window.until, "2024-04-01T00:00:00.000Z");

  await fs.rm(root, { recursive: true, force: true });
});

test("git analyze --since preserves ref-like values verbatim (no numeric/boolean coercion)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-refs-"));
  await initGitRepo(root);

  for (const [ref, expected] of [["007", "007"], ["true", "true"]]) {
    const result = await execFileAsync(
      "node",
      [CLI, "git", "analyze", "--dry-run", "--since", ref, "--format", "json"],
      { cwd: root },
    );
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.window.form, "range");
    assert.equal(payload.window.since, expected);
    assert.equal(payload.window.since_kind, "expression");
  }

  await fs.rm(root, { recursive: true, force: true });
});

test("git analyze rejects not-yet-implemented surface flags with the slice they land in", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-deferred-"));
  await initGitRepo(root);

  const cases = [
    [["--global"], /--global \(repository discovery, #350\)/],
    [["--author", "alice"], /--author \(filtering, #351\)/],
    [["--provider", "claude"], /--provider \(provider narration, #354\)/],
    [["--jira", "auto"], /--jira \(tracker enrichment, #355\)/],
    [["--output", "/tmp/x.html"], /--output \(report output, #353\)/],
  ];
  for (const [flags, pattern] of cases) {
    await assert.rejects(
      () => execFileAsync("node", [CLI, "git", "analyze", "--dry-run", ...flags], { cwd: root }),
      (error) => {
        assert.match(error.stderr, pattern);
        assert.match(error.stderr, /window and --dry-run only/);
        return true;
      },
    );
  }

  await fs.rm(root, { recursive: true, force: true });
});

test("git analyze without --dry-run fails clearly rather than returning an empty success", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-nodry-"));
  await initGitRepo(root);
  await assert.rejects(
    () => execFileAsync("node", [CLI, "git", "analyze", "--days", "7"], { cwd: root }),
    (error) => {
      assert.match(error.stderr, /only --dry-run/);
      assert.match(error.stderr, /#349/);
      return true;
    },
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("git with an unknown subcommand lists the available subcommands", async () => {
  await assert.rejects(
    () => execFileAsync("node", [CLI, "git", "badsubcommand"], { cwd: os.tmpdir() }),
    (error) => {
      assert.match(error.stderr, /unknown subcommand "badsubcommand"/);
      assert.match(error.stderr, /Available subcommands: analyze/);
      return true;
    },
  );
});
