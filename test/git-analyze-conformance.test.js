// Zero-install conformance suite for `agentify git analyze` — the gate for epic
// #347. Each `test()` below asserts one row of the epic's contract (10 rows),
// plus the "prove the assertion works" broken-variant controls the issue
// requires, plus a bounded-perf timing check for #352 branch-ownership.
//
// The premise under test: a stranger runs this command on a machine where
// nothing is installed and nothing will be. This repo has Agentify installed, a
// config, an index, a store, and every CLI on PATH — so this suite deliberately
// runs the REAL CLI (src/cli.js) inside a sealed sandbox: a temp HOME and
// XDG_CACHE_HOME outside the analysed repo, a minimal PATH carrying a git argv
// spy and a provider-spawn spy, a pinned TZ, and a planted env secret. The
// fixture repo has NONE of the Agentify install footprint. See
// test/helpers/pristine-repo.js for the harness rationale.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  createPristineRepo,
  createManyBranchRepo,
  createSandbox,
  runAnalyzeCli,
  snapshotTree,
  diffSnapshots,
  findGitViolations,
  gitSubcommand,
  GIT_READONLY_SUBCOMMANDS,
  COMMIT_SECRET_TOKEN,
} from "./helpers/pristine-repo.js";

const execFileAsync = promisify(execFile);

// An ABSOLUTE window that spans the whole fixture history. Assertions that need
// the fixture's commits to actually fall inside the window use this, so the
// suite never depends on the wall clock — the fixture's pinned commit dates and
// this fixed window fully determine what is analysed, today or in 2030.
const WINDOW = ["--since", "2026-04-29", "--until", "2026-08-01"];

// Every window FORM the frozen surface accepts. These are used only where the
// assertion is "runs to completion / resolves the window" (exit 0 + schema),
// which is clock-independent: a relative form that has aged past the fixture
// simply resolves to an empty-but-valid report. Nothing here asserts a commit
// count, so the wall clock cannot change the outcome.
const WINDOW_FORMS = [
  ["--days", "30"],
  ["--months", "3"],
  ["--quarter", "2", "--year", "2026"],
  ["--year", "2026"],
  ["--since", "2026-05-01", "--until", "2026-07-29"],
];

// A representative spread of command variants, all on the DEFAULT (no network)
// path, used by the footprint and git-allowlist rows so those assertions see
// every code path a first-time user might hit. All use the fixed absolute
// WINDOW so the exercised code paths are deterministic.
const DEFAULT_VARIANTS = [
  [...WINDOW, "--format", "json"],
  [...WINDOW, "--format", "text"],
  [...WINDOW, "--format", "md"],
  [...WINDOW, "--format", "html", "--no-open"],
  [...WINDOW, "--me", "--format", "json"],
  [...WINDOW, "--branch", "feature/*", "--format", "json"],
  [...WINDOW, "--type", "feat,fix", "--scope", "report", "--format", "json"],
  [...WINDOW, "--issue", "#353", "--format", "json"],
  [...WINDOW, "--grep", "report", "--path", "src/**", "--format", "json"],
  [...WINDOW, "--include-merges", "--format", "json"],
];

// -------------------------------------------------------------------------
// Row 1 — runs to completion in a repo with no Agentify install, every window
// -------------------------------------------------------------------------
test("row 1: runs to completion with no Agentify install, for every window form", async () => {
  const repo = await createPristineRepo();
  const sandbox = await createSandbox();
  try {
    // The fixture carries none of the install footprint. Assert that up front so
    // a future change to the harness cannot silently reintroduce it.
    for (const marker of [".agentify.yaml", ".agentify", "CLAUDE.md", "AGENTS.md"]) {
      await assert.rejects(fs.access(path.join(repo.root, marker)), `fixture must not contain ${marker}`);
    }
    for (const form of WINDOW_FORMS) {
      const result = await runAnalyzeCli(sandbox, repo.root, [...form, "--format", "json"]);
      assert.equal(result.code, 0, `window ${form.join(" ")} exited ${result.code}\n${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.equal(report.command, "git analyze");
      assert.equal(report.schema_version, 5);
      assert.equal(report.repository.is_git_repository, true);
    }
  } finally {
    await sandbox.cleanup();
    await repo.cleanup();
  }
});

// -------------------------------------------------------------------------
// Rows 2 & 3 — creates/modifies/deletes NOTHING inside the repo (incl.
// gitignored paths), and `git status --porcelain` is byte-identical.
// -------------------------------------------------------------------------
test("rows 2 & 3: zero filesystem footprint inside the analysed repo, incl. gitignored paths", async () => {
  const repo = await createPristineRepo();
  const sandbox = await createSandbox();
  try {
    for (const args of DEFAULT_VARIANTS) {
      const before = await snapshotTree(repo.root);
      const result = await runAnalyzeCli(sandbox, repo.root, args);
      assert.equal(result.code, 0, `variant ${args.join(" ")} exited ${result.code}\n${result.stderr}`);
      const after = await snapshotTree(repo.root);
      const diffs = diffSnapshots(before, after);
      assert.deepEqual(diffs, [], `variant ${args.join(" ")} changed the repo footprint:\n${diffs.join("\n")}`);
      // Row 3 explicitly: porcelain byte-identical. (diffSnapshots covers it,
      // but assert it on its own so a failure names the right contract row.)
      assert.equal(after.porcelain, before.porcelain, `variant ${args.join(" ")} changed git status --porcelain`);
      // Row 2's trap: a cache written into a gitignored path would be invisible
      // to porcelain. Assert no .agentify/ appeared in the working tree at all.
      await assert.rejects(fs.access(path.join(repo.root, ".agentify")), "command must not create .agentify/ in the repo");
    }
  } finally {
    await sandbox.cleanup();
    await repo.cleanup();
  }
});

// -------------------------------------------------------------------------
// Row 4 — never invokes a git subcommand that can mutate state. A spy, not a
// hope: the PATH-shim records the argv of EVERY git call; assert each against
// the read-only allowlist and assert no mutating subcommand ever appears.
// -------------------------------------------------------------------------
test("row 4: every git invocation is read-only (argv spy vs. allowlist)", async () => {
  const repo = await createPristineRepo();
  // providers present so detectEnvironment's `which` probes run too — none of
  // that should turn into a mutating git call.
  const sandbox = await createSandbox({ providers: true });
  try {
    for (const args of DEFAULT_VARIANTS) {
      // Reset the spy log between variants so a failure names the offending one.
      await sandbox.resetSpies();
      const result = await runAnalyzeCli(sandbox, repo.root, args);
      assert.equal(result.code, 0, `variant ${args.join(" ")} exited ${result.code}\n${result.stderr}`);
      const calls = await sandbox.gitCalls();
      assert.ok(calls.length > 0, `variant ${args.join(" ")} made no git calls — spy not wired?`);
      const violations = findGitViolations(calls);
      assert.deepEqual(violations, [], `variant ${args.join(" ")} issued a non-read-only git call:\n${violations.join("\n")}`);
      // Belt-and-braces: none of the classic mutating subcommands appear.
      const MUTATORS = new Set(["fetch", "pull", "push", "clone", "checkout", "switch", "reset",
        "stash", "commit", "add", "rm", "mv", "merge", "rebase", "cherry-pick", "revert", "am",
        "apply", "gc", "prune", "repack", "update-ref", "init", "clean", "restore", "tag", "worktree"]);
      for (const argv of calls) {
        const { subcommand } = gitSubcommand(argv);
        assert.ok(!MUTATORS.has(subcommand), `mutating git subcommand ${subcommand}: git ${argv.join(" ")}`);
        assert.ok(subcommand === "--version" || subcommand === "--help" || GIT_READONLY_SUBCOMMANDS.has(subcommand),
          `unexpected git subcommand ${subcommand}: git ${argv.join(" ")}`);
      }
    }
  } finally {
    await sandbox.cleanup();
    await repo.cleanup();
  }
});

// -------------------------------------------------------------------------
// Row 5 — default path (no --ai, no --jira) opens no socket and spawns no
// provider process. Every network egress in this command goes through a spawned
// provider/tracker CLI, so "no provider process spawned" is the network-
// isolation assertion for the default path.
// -------------------------------------------------------------------------
test("row 5: default path spawns no provider process and opens no socket", async () => {
  const repo = await createPristineRepo();
  const sandbox = await createSandbox({ providers: true });
  try {
    for (const args of DEFAULT_VARIANTS) {
      await sandbox.resetSpies();
      // blockNetwork preloads an in-process tripwire that throws on any
      // fetch/http(s).request/net.connect/dns/tls attempt. Combined with the
      // empty proc-spy (no provider/tracker CHILD spawned), this asserts the
      // default path opens no socket in-process AND spawns nothing network-
      // capable — the complete network-isolation claim. A run that touched the
      // network in-process would be non-zero here.
      const result = await runAnalyzeCli(sandbox, repo.root, args, { blockNetwork: true });
      assert.equal(result.code, 0, `variant ${args.join(" ")} exited ${result.code}\n${result.stderr}`);
      const procs = await sandbox.procCalls();
      assert.deepEqual(procs, [], `default path spawned a provider process for ${args.join(" ")}:\n${procs.join("\n")}`);
    }
  } finally {
    await sandbox.cleanup();
    await repo.cleanup();
  }
});

// -------------------------------------------------------------------------
// Row 6 — works with HOME pointing at an EMPTY directory. Catches code that
// reaches for ~/.claude, ~/.codex, or a global config as a hard requirement.
// -------------------------------------------------------------------------
test("row 6: works with HOME pointing at an empty directory", async () => {
  const repo = await createPristineRepo();
  const emptyHome = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "agentify-empty-home-"));
  const sandbox = await createSandbox({ home: emptyHome });
  try {
    // HOME really is empty.
    assert.deepEqual(await fs.readdir(emptyHome), []);
    for (const form of WINDOW_FORMS) {
      const result = await runAnalyzeCli(sandbox, repo.root, [...form, "--format", "json"]);
      assert.equal(result.code, 0, `HOME=empty ${form.join(" ")} exited ${result.code}\n${result.stderr}`);
      JSON.parse(result.stdout); // valid report
    }
    // And the html path, whose default report dir is derived from HOME/XDG.
    const html = await runAnalyzeCli(sandbox, repo.root, [...WINDOW, "--format", "html", "--no-open"]);
    assert.equal(html.code, 0, `HOME=empty html exited ${html.code}\n${html.stderr}`);
  } finally {
    await sandbox.cleanup();
    await repo.cleanup();
    await fs.rm(emptyHome, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------
// Row 7 — every absent optional dependency yields a stated limitation, not an
// error. The missing-dependency matrix. Providers/trackers are ABSENT from PATH.
// -------------------------------------------------------------------------
test("row 7: absent optional dependencies degrade to a footnote, never an error", async () => {
  const sandbox = await createSandbox({ providers: false }); // no claude/codex/acli/gh on PATH
  try {
    // --ai with no provider CLI: must not throw; narration degrades to
    // unavailable and the deterministic report still renders.
    {
      const repo = await createPristineRepo();
      const r = await runAnalyzeCli(sandbox, repo.root, [...WINDOW, "--ai", "--yes", "--format", "json"]);
      assert.equal(r.code, 0, `--ai (no provider) errored:\n${r.stderr}`);
      const rep = JSON.parse(r.stdout);
      assert.ok(rep.narration, "an --ai run carries a narration block even when unavailable");
      assert.notEqual(rep.narration.status, "ok", "narration must not claim success with no provider");
      assert.ok(Array.isArray(rep.narration.notes) && rep.narration.notes.length > 0, "narration states a limitation");
      await repo.cleanup();
    }
    // --jira with no acli/gh: must not throw; zero network; tracker degrades.
    {
      const repo = await createPristineRepo();
      const r = await runAnalyzeCli(sandbox, repo.root, [...WINDOW, "--jira", "auto", "--format", "json"]);
      assert.equal(r.code, 0, `--jira auto (no acli/gh) errored:\n${r.stderr}`);
      const rep = JSON.parse(r.stdout);
      assert.ok(rep.tracker, "a --jira run carries a tracker block");
      assert.equal(rep.tracker.network_requests, 0, "no acli/gh means zero network");
      assert.equal((await sandbox.procCalls()).length, 0, "no tracker process was spawned");
      await repo.cleanup();
    }
    // Degenerate repo shapes: each is a stated outcome, not a crash.
    for (const shape of ["single", "main-only", "detached"]) {
      const repo = await createPristineRepo({ shape });
      const r = await runAnalyzeCli(sandbox, repo.root, [...WINDOW, "--format", "json"]);
      assert.equal(r.code, 0, `shape=${shape} errored:\n${r.stderr}`);
      JSON.parse(r.stdout);
      await repo.cleanup();
    }
    // No .mailmap present (the default fixture has none) + --me: must not throw.
    {
      const repo = await createPristineRepo();
      await assert.rejects(fs.access(path.join(repo.root, ".mailmap")), "fixture has no .mailmap");
      const r = await runAnalyzeCli(sandbox, repo.root, [...WINDOW, "--me", "--format", "json"]);
      assert.equal(r.code, 0, `--me without .mailmap errored:\n${r.stderr}`);
      await repo.cleanup();
    }
    // The ONE deliberate exception to fail-soft: an ABSENT auto-detected tier is
    // a footnote (asserted above), but EXPLICITLY demanding `--jira rest` with
    // its required env unset is an actionable misconfiguration, not a silent
    // degrade. Asserted as non-zero misuse in row 8; noted here so the contract
    // boundary is explicit.
  } finally {
    await sandbox.cleanup();
  }
});

// -------------------------------------------------------------------------
// Row 8 — exit codes: 0 on success and on explained-empty; non-zero only on
// genuine misuse or a git failure.
// -------------------------------------------------------------------------
test("row 8: exit codes distinguish success/explained-empty from misuse/git-failure", async () => {
  const sandbox = await createSandbox();
  try {
    // Success.
    {
      const repo = await createPristineRepo();
      const r = await runAnalyzeCli(sandbox, repo.root, [...WINDOW, "--format", "json"]);
      assert.equal(r.code, 0, `success should exit 0:\n${r.stderr}`);
      await repo.cleanup();
    }
    // Explained-empty: a window with no commits is a valid, explained outcome.
    {
      const repo = await createPristineRepo({ shape: "empty-window" });
      const r = await runAnalyzeCli(sandbox, repo.root, ["--days", "30", "--format", "json"]);
      assert.equal(r.code, 0, `explained-empty should exit 0:\n${r.stderr}`);
      const rep = JSON.parse(r.stdout);
      assert.equal(rep.counts.commits, 0, "the empty window truly has zero commits");
      await repo.cleanup();
    }
    // Misuse: non-zero. Each is a distinct class of user error.
    {
      const repo = await createPristineRepo();
      const misuses = [
        ["--since", "2026-07-29", "--until", "2026-05-01", "--format", "json"], // reversed window
        ["--months", "3", "--format", "json", "--output", "x.html"],            // --output outside html
        ["--months", "3", "--format", "banana"],                                 // bad format
        ["--months", "3", "--not-a-flag"],                                       // unknown flag
        ["--months", "3", "--format", "html", "--dry-run"],                      // html has no dry-run report
        ["--days", "0", "--format", "json"],                                     // degenerate window
        [...WINDOW, "--jira", "rest", "--format", "json"],                        // explicit REST, env unset (see row 7)
      ];
      for (const args of misuses) {
        const r = await runAnalyzeCli(sandbox, repo.root, args);
        assert.notEqual(r.code, 0, `misuse should be non-zero: ${args.join(" ")}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
      }
      await repo.cleanup();
    }
    // Git failure: --local outside a git repository is a genuine failure.
    {
      const notRepo = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "agentify-notrepo-"));
      const r = await runAnalyzeCli(sandbox, notRepo, [...WINDOW, "--format", "json"]);
      assert.notEqual(r.code, 0, `--local outside a git repo should be non-zero:\n${r.stdout}`);
      await fs.rm(notRepo, { recursive: true, force: true });
    }
  } finally {
    await sandbox.cleanup();
  }
});

// -------------------------------------------------------------------------
// Row 9 — no secret from the environment appears in any output artifact. Also
// exercises redact-before-render: a token planted in a commit SUBJECT must be
// scrubbed on the way into the record.
// -------------------------------------------------------------------------
test("row 9: no environment secret (and no commit-subject token) reaches any artifact", async () => {
  const repo = await createPristineRepo();
  const sandbox = await createSandbox({ providers: true });
  try {
    const windowArgs = ["--since", "2026-05-01", "--until", "2026-07-29"];
    for (const fmt of ["json", "text", "md"]) {
      const r = await runAnalyzeCli(sandbox, repo.root, [...windowArgs, "--format", fmt]);
      assert.equal(r.code, 0, `format ${fmt} errored:\n${r.stderr}`);
      const combined = r.stdout + r.stderr;
      assert.ok(!combined.includes(sandbox.secret), `env secret leaked into ${fmt} output`);
      assert.ok(!combined.includes(COMMIT_SECRET_TOKEN), `commit-subject token leaked into ${fmt} output (redact-before-render failed)`);
    }
    // HTML artifact on disk.
    const html = await runAnalyzeCli(sandbox, repo.root, [...windowArgs, "--format", "html", "--no-open"]);
    assert.equal(html.code, 0, `html errored:\n${html.stderr}`);
    const m = html.stderr.match(/Report written to (\S+\.html)/);
    assert.ok(m, `could not find the report path in:\n${html.stderr}`);
    const contents = await fs.readFile(m[1], "utf8");
    assert.ok(!contents.includes(sandbox.secret), "env secret leaked into the HTML artifact");
    assert.ok(!contents.includes(COMMIT_SECRET_TOKEN), "commit-subject token leaked into the HTML artifact");
    await fs.rm(m[1], { force: true });
  } finally {
    await sandbox.cleanup();
    await repo.cleanup();
  }
});

// -------------------------------------------------------------------------
// Row 10 — report artifacts land OUTSIDE the analysed repository.
// -------------------------------------------------------------------------
test("row 10: the HTML report artifact lands outside the analysed repository", async () => {
  const repo = await createPristineRepo();
  const sandbox = await createSandbox();
  try {
    const before = await snapshotTree(repo.root);
    const r = await runAnalyzeCli(sandbox, repo.root, [...WINDOW, "--format", "html", "--no-open"]);
    assert.equal(r.code, 0, `html errored:\n${r.stderr}`);
    const m = r.stderr.match(/Report written to (\S+\.html)/);
    assert.ok(m, `could not find the report path in:\n${r.stderr}`);
    const reportPath = path.resolve(m[1]);
    // The artifact exists…
    await fs.access(reportPath);
    // …and it is NOT inside the analysed repository…
    const rel = path.relative(repo.root, reportPath);
    assert.ok(rel.startsWith(".."), `report landed inside the repo: ${reportPath}`);
    // …and it is under our sandbox cache home (the default XDG location).
    assert.ok(reportPath.startsWith(path.resolve(sandbox.cacheHome)), `report not under XDG_CACHE_HOME: ${reportPath}`);
    // …and the repo footprint is unchanged.
    const after = await snapshotTree(repo.root);
    assert.deepEqual(diffSnapshots(before, after), [], "writing the report changed the repo footprint");
  } finally {
    await sandbox.cleanup();
    await repo.cleanup();
  }
});

// -------------------------------------------------------------------------
// --global scope — the same contract must hold when the command discovers and
// analyses MANY repositories under a root: no writes into any discovered repo,
// read-only git only, no provider spawned, artifact outside every repo. A
// regression in discovery/global caching could otherwise write into a
// discovered repo or reach the network while the local-scope rows stay green.
// -------------------------------------------------------------------------
test("rows 2/4/5/10 hold under --global across multiple discovered repositories", async () => {
  const os = await import("node:os");
  const discoveryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-global-root-"));
  const repoA = await createPristineRepo({ parent: discoveryRoot });
  const repoB = await createPristineRepo({ parent: discoveryRoot, shape: "main-only" });
  const sandbox = await createSandbox({ providers: true });
  try {
    const beforeA = await snapshotTree(repoA.root);
    const beforeB = await snapshotTree(repoB.root);
    await sandbox.resetSpies();

    const r = await runAnalyzeCli(
      sandbox,
      discoveryRoot,
      ["--global", "--root", discoveryRoot, ...WINDOW, "--format", "html", "--no-open"],
      { blockNetwork: true },
    );
    assert.equal(r.code, 0, `--global run errored:\n${r.stderr}`);

    // Row 2/3: neither discovered repo changed.
    assert.deepEqual(diffSnapshots(beforeA, await snapshotTree(repoA.root)), [], "--global wrote into repo A");
    assert.deepEqual(diffSnapshots(beforeB, await snapshotTree(repoB.root)), [], "--global wrote into repo B");
    // Row 4: read-only git only, across discovery + per-repo analysis.
    const violations = findGitViolations(await sandbox.gitCalls());
    assert.deepEqual(violations, [], `--global issued a non-read-only git call:\n${violations.join("\n")}`);
    // Row 5: no provider process spawned.
    assert.deepEqual(await sandbox.procCalls(), [], "--global spawned a provider process");
    // Row 10: the artifact landed outside every discovered repo.
    const m = r.stderr.match(/Report written to (\S+\.html)/);
    assert.ok(m, `no report path in:\n${r.stderr}`);
    const reportPath = path.resolve(m[1]);
    assert.ok(path.relative(repoA.root, reportPath).startsWith(".."), "report landed inside repo A");
    assert.ok(path.relative(repoB.root, reportPath).startsWith(".."), "report landed inside repo B");
  } finally {
    await sandbox.cleanup();
    await repoA.cleanup();
    await repoB.cleanup();
    await fs.rm(discoveryRoot, { recursive: true, force: true });
  }
});

// =========================================================================
// PROVE THE ASSERTIONS WORK — deliberately-broken variants must FAIL the
// relevant assertion. The issue requires proving each assertion catches a
// violation rather than assuming green means correct.
// =========================================================================

test("proof: the footprint assertion FAILS on a write inside the repo (incl. a gitignored path)", async () => {
  const repo = await createPristineRepo();
  try {
    const before = await snapshotTree(repo.root);

    // (a) A visible (tracked-area) write.
    await fs.writeFile(path.join(repo.root, "src", "leaked.js"), "// oops\n", "utf8");
    let diffs = diffSnapshots(before, await snapshotTree(repo.root));
    assert.ok(diffs.some((d) => d.includes("created: src/leaked.js")), "footprint assertion failed to catch a visible write");
    await fs.rm(path.join(repo.root, "src", "leaked.js"), { force: true });

    // (b) The trap: a cache in a GITIGNORED path. `git status --porcelain` stays
    // clean (proving porcelain-blindness), but the full working-tree walk catches
    // it. This is the assertion that stops a cache in .agentify/ from slipping by.
    const before2 = await snapshotTree(repo.root);
    await fs.mkdir(path.join(repo.root, ".agentify"), { recursive: true });
    await fs.writeFile(path.join(repo.root, ".agentify", "cache.json"), "{}\n", "utf8");
    const after2 = await snapshotTree(repo.root);
    assert.equal(after2.porcelain, before2.porcelain, "sanity: a gitignored write is invisible to porcelain");
    diffs = diffSnapshots(before2, after2);
    assert.ok(diffs.some((d) => d.includes(".agentify")), "footprint assertion failed to catch a gitignored write");
    await fs.rm(path.join(repo.root, ".agentify"), { recursive: true, force: true });

    // (c) An identical-bytes rewrite is caught by the mtime change.
    const before3 = await snapshotTree(repo.root);
    const readme = path.join(repo.root, "README.md");
    const original = await fs.readFile(readme);
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(readme, original); // identical bytes, new mtime
    diffs = diffSnapshots(before3, await snapshotTree(repo.root));
    assert.ok(diffs.some((d) => d.includes("modified: README.md")), "footprint assertion failed to catch an mtime change");

    // (d) The subtle case: a SAME-SIZE, different-content write with the mtime
    // RESTORED. Size and mtime match; only the content hash catches it. This is
    // why the snapshot hashes contents rather than trusting size+mtime.
    await fs.writeFile(readme, original); // reset baseline content
    const before4 = await snapshotTree(repo.root);
    const st = await fs.stat(readme);
    const flipped = Buffer.from(original);
    flipped[0] ^= 0xff; // same length, different bytes
    await fs.writeFile(readme, flipped);
    await fs.utimes(readme, st.atime, st.mtime); // restore the timestamp
    const after4 = await snapshotTree(repo.root);
    diffs = diffSnapshots(before4, after4);
    assert.ok(diffs.some((d) => d.includes("modified: README.md")), "content hash failed to catch a same-size mtime-restored write");
    await fs.writeFile(readme, original); // restore
  } finally {
    await repo.cleanup();
  }
});

test("proof: the git allowlist FAILS on mutating subcommands", () => {
  // Feed the assertion representative denied invocations (what a future slice
  // adding a fetch, or a config write, would produce). The spy records real
  // argv verbatim (demonstrated by rows 4/5), so if any of these ever appeared
  // in a real run, findGitViolations would flag it exactly like this.
  const denied = [
    ["fetch", "origin"],
    ["checkout", "main"],
    ["-C", "/x", "reset", "--hard"],
    ["stash"],
    ["commit", "-m", "x"],
    ["config", "user.email", "x@example.com"],       // write: no read flag
    ["config", "--unset", "core.bare"],              // write: mutating flag
    ["remote", "add", "origin", "https://x"],        // write: remote mutation
    ["remote", "show", "origin"],                    // network: remote show w/o -n
    ["remote", "update"],                            // network: remote update
    ["symbolic-ref", "HEAD", "refs/heads/x"],        // write: two positionals
    ["gc"],
    ["update-ref", "refs/heads/x", "HEAD"],
  ];
  const violations = findGitViolations(denied);
  assert.equal(violations.length, denied.length, `every denied call must be flagged; got:\n${violations.join("\n")}`);

  // And the allowlist must PASS the read-only calls the command really makes.
  const allowed = [
    ["--version"],
    ["rev-parse", "--show-toplevel"],
    ["log", "--no-merges", "-z", "--format=%H"],
    ["for-each-ref", "--format=%(refname)", "refs/heads"],
    ["rev-list", "--count", "HEAD"],
    ["-C", "/x", "rev-list", "HEAD"],
    ["config", "--get", "user.email"],
    ["remote"],
    ["remote", "-v"],
    ["remote", "get-url", "origin"],
    ["remote", "show", "-n", "origin"],
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ["show", "--stat", "HEAD"],
    ["diff", "--numstat", "A", "B"],
    ["check-ignore", "-q", "--", "x"],
  ];
  assert.deepEqual(findGitViolations(allowed), [], "read-only calls must pass the allowlist");
});

test("proof: the git spy captures a real invocation's argv verbatim", async () => {
  // A positive control that the PATH-shim actually records — otherwise row 4
  // could be green because NOTHING was captured.
  const repo = await createPristineRepo({ shape: "single" });
  const sandbox = await createSandbox();
  try {
    await execFileAsync("git", ["-C", repo.root, "rev-parse", "--show-toplevel"], { env: sandbox.env });
    const calls = await sandbox.gitCalls();
    assert.ok(
      calls.some((c) => c.join(" ") === `-C ${repo.root} rev-parse --show-toplevel`),
      `spy did not capture the real argv; captured:\n${calls.map((c) => c.join(" ")).join("\n")}`,
    );
  } finally {
    await sandbox.cleanup();
    await repo.cleanup();
  }
});

test("proof: the provider-spawn spy FAILS when a provider is actually spawned", async () => {
  // Row 5 asserts the proc log stays EMPTY on the default path. Prove the spy
  // isn't silently broken: spawn a provider shim directly through the sandbox
  // env and confirm the log records it. All network egress in this command is a
  // provider/tracker spawn, so this is the network-stub positive control.
  const sandbox = await createSandbox({ providers: true });
  try {
    await execFileAsync("claude", ["--print", "hello"], { env: sandbox.env }).catch(() => {});
    const procs = await sandbox.procCalls();
    assert.ok(procs.some((line) => line.startsWith("claude ")), `proc spy did not record the spawn; log:\n${procs.join("\n")}`);
  } finally {
    await sandbox.cleanup();
  }
});

// =========================================================================
// PERFORMANCE — #352 branch-ownership attribution can issue up to ~one
// window-bounded `git rev-list` walk per candidate branch. Bounded and
// terminating; a coarse timing guard so a future regression that turns it
// quadratic (or unbounded) fails loudly rather than merely getting slow.
// =========================================================================
test("perf: branch-ownership attribution over many branches stays bounded", async () => {
  const repo = await createManyBranchRepo({ branches: 30 });
  const sandbox = await createSandbox();
  try {
    const started = Date.now();
    const r = await runAnalyzeCli(sandbox, repo.root, [...WINDOW, "--format", "json"]);
    const elapsedMs = Date.now() - started;
    assert.equal(r.code, 0, `many-branch run errored:\n${r.stderr}`);
    // Generous bound: this fixture completes in ~1–3s; 60s catches a genuine
    // blow-up (quadratic/unbounded walks) without flaking on a slow CI box.
    assert.ok(elapsedMs < 60_000, `branch-ownership took ${elapsedMs}ms — investigate for an unbounded walk`);
  } finally {
    await sandbox.cleanup();
    await repo.cleanup();
  }
});
