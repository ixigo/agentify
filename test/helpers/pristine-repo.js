// Zero-install conformance harness for `agentify git analyze` (#356, gate for #347).
//
// The epic's central premise — a stranger runs the command on a machine where
// nothing is installed and nothing will be — is invisible in normal development:
// this repo has Agentify installed, a config, an index, a store, and every CLI on
// PATH. A slice that quietly requires one of those passes every other test and
// fails for every real first-time user. This harness makes the constraint
// executable:
//
//   * createPristineRepo   — a temp git repo with real, deterministic commits and
//                            NO .agentify.yaml, .agentify/, index, store, hooks,
//                            CLAUDE.md, or AGENTS.md.
//   * snapshotTree         — a recursive working-tree snapshot (paths + sizes +
//                            mtimes) that INCLUDES gitignored paths, plus
//                            `git status --porcelain`, so a cache written into a
//                            gitignored `.agentify/` (invisible to porcelain) is
//                            still caught (row 2/3).
//   * runAnalyzeCli        — runs the real CLI as a child process inside a
//                            controlled environment with a git argv spy and a
//                            provider-spawn spy on PATH (rows 4/5), a temp HOME
//                            and XDG_CACHE_HOME outside the repo (rows 6/10), a
//                            pinned TZ, and a planted secret env var (row 9).
//
// Everything here is deterministic: pinned GIT_AUTHOR_DATE/GIT_COMMITTER_DATE and
// TZ, no reliance on the wall clock.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CLI = fileURLToPath(new URL("../../src/cli.js", import.meta.url));

// The real git binary, resolved once against the ambient (test-runner) PATH. The
// PATH-shim below execs THIS absolute path, so the analysed repo is read by a
// genuine git regardless of what the sandboxed child's PATH contains.
let REAL_GIT = null;
async function realGitPath() {
  if (REAL_GIT) return REAL_GIT;
  const finder = process.platform === "win32" ? "where" : "which";
  const { stdout } = await execFileAsync(finder, ["git"]);
  REAL_GIT = stdout.split(/\r?\n/)[0].trim();
  if (!REAL_GIT) throw new Error("could not locate a real git binary for the conformance harness");
  return REAL_GIT;
}

// --- fixture construction -------------------------------------------------

// A deterministic identity clock. Every fixture commit gets a fixed author and
// committer date so churn totals, windows, and ordering never depend on the
// wall clock. Dates march backwards from a pinned "now" so a --days/--months
// window lands them predictably.
const FIXTURE_TZ = "UTC";

async function git(root, args, extraEnv = {}) {
  return execFileAsync("git", args, {
    cwd: root,
    env: { ...process.env, TZ: FIXTURE_TZ, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...extraEnv },
  });
}

// Two identities on purpose: the epic calls out the two-identity `--me` case as
// the most common way a first run under-reports (this repo has
// ranveer.kumar@travenues.com and ranveersequeira@gmail.com).
export const IDENTITY_A = { name: "Ranveer Kumar", email: "ranveer.kumar@travenues.com" };
export const IDENTITY_B = { name: "Ranveer Sequeira", email: "ranveersequeira@gmail.com" };
export const IDENTITY_OTHER = { name: "Someone Else", email: "someone@example.com" };

// The token-shaped secret planted in a commit subject (redact-before-render).
export const COMMIT_SECRET_TOKEN = "sk-LEAKED1234567890abcdef";

async function commit(root, { message, author, date, files = {}, allowEmpty = false }) {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents, "utf8");
  }
  if (Object.keys(files).length > 0) {
    await git(root, ["add", "-A"]);
  }
  const args = ["commit", "-m", message];
  if (allowEmpty) args.push("--allow-empty");
  await git(root, args, {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
}

/**
 * Build a pristine git repo: real commits, deterministic dates, and NONE of the
 * Agentify install footprint. Returns { root, cleanup }.
 *
 * The default fixture spans 2026-05 → 2026-07 (inside a 90-day window ending
 * 2026-07-29), carries conventional types/scopes, issue references (#NNN and
 * PROJ-NNN), two authoring identities, a merged feature branch, and a gitignored
 * path — enough for every filter to have something to bite on while staying
 * small and fast.
 *
 * @param {object} [opts]
 * @param {"full"|"single"|"empty-window"|"detached"|"main-only"} [opts.shape]
 * @param {boolean} [opts.gitignore] - write a .gitignore that hides .agentify/ and node_modules/
 */
export async function createPristineRepo(opts = {}) {
  const shape = opts.shape || "full";
  const gitignore = opts.gitignore !== false;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-pristine-"));

  await git(root, ["init", "-b", "main"]);
  // Local identity so a bare `git commit` never falls back to a global config
  // (which, under GIT_CONFIG_GLOBAL=/dev/null, does not exist). Committer env
  // per-commit still overrides this for authorship.
  await git(root, ["config", "user.name", IDENTITY_A.name]);
  await git(root, ["config", "user.email", IDENTITY_A.email]);

  if (gitignore) {
    await fs.writeFile(path.join(root, ".gitignore"), ".agentify/\nnode_modules/\n*.log\n", "utf8");
  }

  await commit(root, {
    message: "chore: initial commit",
    author: IDENTITY_A,
    date: "2026-05-01T09:00:00+00:00",
    files: { ".gitignore": gitignore ? ".agentify/\nnode_modules/\n*.log\n" : "", "README.md": "# fixture\n" },
  });

  if (shape === "single") {
    return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
  }

  if (shape === "empty-window") {
    // All commits sit well BEFORE any recent window, so a --days 30 ending in
    // 2026-07 resolves to zero commits — the "explained-empty" case (row 8).
    await commit(root, {
      message: "feat(core): seed feature (#1)",
      author: IDENTITY_A,
      date: "2020-01-02T09:00:00+00:00",
      files: { "src/a.js": "export const a = 1;\n" },
    });
    return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
  }

  // Common history for full / main-only / detached.
  await commit(root, {
    message: "feat(collect): stream git log for the window (#348)",
    author: IDENTITY_A,
    date: "2026-05-10T10:00:00+00:00",
    files: { "src/collect.js": "export function collect() { return []; }\n" },
  });
  await commit(root, {
    message: "fix(parse): handle empty subjects (#349)",
    author: IDENTITY_B,
    date: "2026-06-01T11:00:00+00:00",
    files: { "src/parse.js": "export function parse(s) { return s.trim(); }\n" },
  });
  await commit(root, {
    message: "refactor(filters): tighten branch reachability PROJ-42",
    author: IDENTITY_OTHER,
    date: "2026-06-15T12:00:00+00:00",
    files: { "src/filters.js": "export const filters = {};\n", "node_modules/pkg/index.js": "// vendored\n" },
  });

  if (shape !== "main-only") {
    // A feature branch merged back into main, so --branch reachability and
    // merge handling have something real to work with.
    await git(root, ["checkout", "-b", "feature/report"]);
    await commit(root, {
      message: "feat(report): render html summary (#353)",
      author: IDENTITY_A,
      date: "2026-07-02T13:00:00+00:00",
      files: { "src/report.js": "export function render() { return '<html>'; }\n" },
    });
    await git(root, ["checkout", "main"]);
    await git(
      root,
      ["merge", "--no-ff", "feature/report", "-m", "Merge branch 'feature/report' (#353)"],
      {
        GIT_AUTHOR_NAME: IDENTITY_A.name, GIT_AUTHOR_EMAIL: IDENTITY_A.email,
        GIT_COMMITTER_NAME: IDENTITY_A.name, GIT_COMMITTER_EMAIL: IDENTITY_A.email,
        GIT_AUTHOR_DATE: "2026-07-03T09:00:00+00:00", GIT_COMMITTER_DATE: "2026-07-03T09:00:00+00:00",
      },
    );
  }

  // A token-shaped secret in the commit SUBJECT. The epic guardrail is
  // "redact before you render": redactSensitiveText() must scrub this on the way
  // INTO the record so it can never reach a report, packet, or stdout. The
  // conformance suite asserts the raw token is absent from every artifact.
  await commit(root, {
    message: "fix(auth): rotate leaked key sk-LEAKED1234567890abcdef (#77)",
    author: IDENTITY_A,
    date: "2026-07-18T14:00:00+00:00",
    files: { "src/auth.js": "export const rotate = () => true;\n" },
  });
  await commit(root, {
    message: "docs(readme): document zero-install run (#356)",
    author: IDENTITY_B,
    date: "2026-07-20T14:00:00+00:00",
    files: { "README.md": "# fixture\n\nRun it.\n" },
  });

  if (shape === "detached") {
    const { stdout } = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["checkout", "--detach", stdout.trim()]);
  }

  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/**
 * Build a repo with MANY feature branches carrying non-issue commits, to
 * exercise #352 branch-ownership attribution — which can issue up to one
 * window-bounded `git rev-list` walk per candidate branch. Used for the
 * conformance suite's timing check (bounded and terminating).
 *
 * @param {object} [opts]
 * @param {number} [opts.branches] - number of feature branches (default 30)
 */
export async function createManyBranchRepo(opts = {}) {
  const branches = opts.branches || 30;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-branches-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", IDENTITY_A.name]);
  await git(root, ["config", "user.email", IDENTITY_A.email]);
  await commit(root, {
    message: "chore: base",
    author: IDENTITY_A,
    date: "2026-05-01T09:00:00+00:00",
    files: { "base.txt": "0\n" },
  });
  // Trunk commits with NO issue key, so branch-ownership attribution cannot
  // short-circuit on issue references and must walk the branches.
  for (let i = 0; i < 20; i++) {
    await commit(root, {
      message: `refactor: trunk step ${i}`,
      author: IDENTITY_A,
      date: `2026-06-${String((i % 27) + 1).padStart(2, "0")}T09:00:00+00:00`,
      files: { "base.txt": `${i + 1}\n` },
    });
  }
  for (let b = 0; b < branches; b++) {
    await git(root, ["checkout", "-b", `feature/branch-${b}`, "main"]);
    await commit(root, {
      message: `feat: work on branch ${b}`,
      author: IDENTITY_A,
      date: `2026-07-${String((b % 27) + 1).padStart(2, "0")}T10:00:00+00:00`,
      files: { [`feat-${b}.txt`]: `${b}\n` },
    });
    await git(root, ["checkout", "main"]);
  }
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

// --- footprint snapshotting ----------------------------------------------

/**
 * Recursive snapshot of the working tree (paths + sizes + mtimes), INCLUDING
 * gitignored paths, plus `git status --porcelain`. `.git/` internals are
 * excluded because a read-only git command legitimately refreshes its own index
 * timestamp and pack access — that is not a write inside the analysed repo. What
 * matters for the epic is the working tree: a cache dropped into a gitignored
 * `.agentify/` is invisible to `git status` yet still violates the constraint,
 * and the full walk below catches it where porcelain cannot.
 */
export async function snapshotTree(root) {
  const entries = {};
  async function walk(dir) {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.name === ".git") continue;
      const abs = path.join(dir, dirent.name);
      const rel = path.relative(root, abs);
      const stat = await fs.lstat(abs);
      if (dirent.isDirectory()) {
        entries[`${rel}/`] = "dir";
        await walk(abs);
      } else {
        // size + mtime (ns) so a same-size in-place overwrite is still caught.
        entries[rel] = `${stat.size}:${stat.mtimeMs}`;
      }
    }
  }
  await walk(root);

  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: root,
    env: { ...process.env, TZ: FIXTURE_TZ },
  });
  return { entries, porcelain: stdout };
}

/**
 * Compare two snapshots. Returns an array of human-readable differences (empty
 * means byte-identical footprint). Callers assert the array is empty.
 */
export function diffSnapshots(before, after) {
  const diffs = [];
  const beforeKeys = new Set(Object.keys(before.entries));
  const afterKeys = new Set(Object.keys(after.entries));
  for (const key of afterKeys) {
    if (!beforeKeys.has(key)) diffs.push(`created: ${key}`);
    else if (before.entries[key] !== after.entries[key]) diffs.push(`modified: ${key}`);
  }
  for (const key of beforeKeys) {
    if (!afterKeys.has(key)) diffs.push(`deleted: ${key}`);
  }
  if (before.porcelain !== after.porcelain) {
    diffs.push(`git status --porcelain changed:\n--- before ---\n${before.porcelain}--- after ---\n${after.porcelain}`);
  }
  return diffs;
}

// --- the sandbox: PATH shims + controlled environment ---------------------

// A /bin/sh git shim that appends every invocation's argv to $GIT_SPY_LOG
// (record-delimited, one arg per line) and then execs the REAL git by absolute
// path. Because gitEnv() in the git-analyze modules spreads process.env, this
// shim — first on the child's PATH — intercepts EVERY git call the command
// makes, which is the only way row 4 catches a future slice adding a `fetch`.
function gitShimSource(realGit) {
  return `#!/bin/sh
{
  printf 'GITCALL\\n'
  for a in "$@"; do printf '%s\\n' "$a"; done
  printf 'ENDGITCALL\\n'
} >> "$GIT_SPY_LOG"
exec ${JSON.stringify(realGit)} "$@"
`;
}

// A provider shim: records that the binary was spawned (name + argv) to
// $PROC_SPY_LOG and exits 0. Its mere presence on PATH makes the tool "detected"
// by detectEnvironment (via `which`), but the default path must never actually
// SPAWN it — asserted by an empty PROC_SPY_LOG. This is the network-isolation
// assertion for the default path: every network egress in this command goes
// through a spawned provider/tracker CLI, so "no provider process spawned"
// means "no socket opened".
function procShimSource(name) {
  return `#!/bin/sh
{
  printf '%s' ${JSON.stringify(name)}
  for a in "$@"; do printf ' %s' "$a"; done
  printf '\\n'
} >> "$PROC_SPY_LOG"
exit 0
`;
}

async function writeShim(dir, name, source) {
  const file = path.join(dir, name);
  await fs.writeFile(file, source, "utf8");
  await fs.chmod(file, 0o755);
}

/**
 * Build a sandbox: a bin dir with a git spy shim (and optionally provider
 * shims), a temp HOME and XDG_CACHE_HOME outside the analysed repo, a pinned TZ,
 * and a planted secret. Returns handles plus a reader for the spy logs.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.providers] - install claude/codex/acli/gh spy shims so
 *   "present but must-not-be-spawned" can be asserted (default false = absent,
 *   for the missing-dependency matrix).
 * @param {string}  [opts.home] - override HOME (e.g. an empty dir for row 6).
 * @param {string}  [opts.secret] - value planted in a fake secret env var (row 9).
 */
export async function createSandbox(opts = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-sandbox-"));
  const binDir = path.join(base, "bin");
  const home = opts.home || path.join(base, "home");
  const cacheHome = path.join(base, "cache");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(cacheHome, { recursive: true });

  const gitSpyLog = path.join(base, "git-spy.log");
  const procSpyLog = path.join(base, "proc-spy.log");
  await fs.writeFile(gitSpyLog, "", "utf8");
  await fs.writeFile(procSpyLog, "", "utf8");

  await writeShim(binDir, "git", gitShimSource(await realGitPath()));
  if (opts.providers) {
    for (const name of ["claude", "codex", "acli", "gh"]) {
      await writeShim(binDir, name, procShimSource(name));
    }
  }

  // A deliberately secret-looking value in the environment. Row 9 asserts it
  // never surfaces in any output artifact. It is deliberately NOT shaped like a
  // token redactSensitiveText() would scrub (no `sk-`/`Bearer`/URL-cred form):
  // if it leaked it would leak RAW, so the assertion catches an env dump rather
  // than being masked by redaction that only runs on commit text.
  const secret = opts.secret || "CONFORMANCE-ENV-SENTINEL-8f3a91-do-not-leak";

  // A minimal PATH: the shim dir first, then only the standard system dirs that
  // hold sh / which / env. Deliberately EXCLUDES the dirs where claude / codex /
  // acli / gh normally live, so (unless we planted shims) those tools are truly
  // absent — the missing-dependency matrix (row 7).
  const systemDirs = process.platform === "win32"
    ? [process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32") : "C:\\Windows\\System32"]
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const PATH = [binDir, ...systemDirs].join(path.delimiter);

  const env = {
    PATH,
    Path: PATH, // Windows env var casing
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: cacheHome,
    TZ: FIXTURE_TZ,
    GIT_SPY_LOG: gitSpyLog,
    PROC_SPY_LOG: procSpyLog,
    // Keep git hermetic inside the sandbox: no global/system config, no prompts,
    // no implicit network.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    // Planted secret (row 9).
    AGENTIFY_CONFORMANCE_SECRET: secret,
    // Force plain output so assertions match on un-coloured strings.
    NO_COLOR: "1",
  };

  return {
    base,
    binDir,
    home,
    cacheHome,
    env,
    secret,
    gitSpyLog,
    procSpyLog,
    async gitCalls() {
      return parseGitSpyLog(await fs.readFile(gitSpyLog, "utf8"));
    },
    async procCalls() {
      const raw = await fs.readFile(procSpyLog, "utf8");
      return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    },
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}

// Parse the git spy log into an array of argv arrays.
export function parseGitSpyLog(raw) {
  const calls = [];
  let current = null;
  for (const line of raw.split("\n")) {
    if (line === "GITCALL") { current = []; continue; }
    if (line === "ENDGITCALL") { if (current) calls.push(current); current = null; continue; }
    if (current) current.push(line);
  }
  return calls;
}

// --- git argv allowlist (row 4) ------------------------------------------

// Read-only subcommands the command is permitted to invoke. This is the epic's
// stated set (log, for-each-ref, rev-parse, show, diff, cat-file, check-ignore,
// var, config read-only) plus `rev-list` — used by #352 branch-ownership
// attribution and #350 discovery counts, and read-only — and the `remote` list
// form (read-only) used when resolving a repo's canonical remote for the tracker
// cache key. `--version` is a probe, not a subcommand.
// `symbolic-ref` (read form) is included: #352's getMainlineBranch reads
// `symbolic-ref --short refs/remotes/origin/HEAD` to find the trunk WITHOUT a
// network round-trip. It is read-only, but it is outside the epic's enumerated
// allowlist — a deviation the conformance suite surfaces (see the suite's
// row-4 comment). The write forms are guarded in findGitViolations.
export const GIT_READONLY_SUBCOMMANDS = new Set([
  "log", "rev-list", "for-each-ref", "rev-parse", "show", "diff",
  "cat-file", "check-ignore", "var", "config", "remote", "symbolic-ref",
]);

// Global options that consume the following token as a value; used to skip past
// leading globals (e.g. `git -C <path> rev-list ...`) to the real subcommand.
const GLOBAL_OPTS_WITH_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix",
]);

// Config read forms; a `config` invocation is allowed only if it names one of
// these and none of the mutating flags below.
const CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--get-color", "--get-colorbool"]);
const CONFIG_WRITE_FLAGS = new Set([
  "--add", "--unset", "--unset-all", "--replace-all", "--set", "--set-all",
  "--rename-section", "--remove-section", "--edit", "-e", "--fixed-value",
]);

/**
 * Extract the effective subcommand from a git argv, skipping leading global
 * options. Returns { subcommand, index } — subcommand is "--version"/"--help"
 * when the argv is a bare probe, or null if none found.
 */
export function gitSubcommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--version" || tok === "--help") return { subcommand: tok, index: i };
    if (GLOBAL_OPTS_WITH_VALUE.has(tok)) { i++; continue; }
    if (tok.startsWith("-")) continue; // valueless global flag (e.g. --no-pager, --bare)
    return { subcommand: tok, index: i };
  }
  return { subcommand: null, index: -1 };
}

/**
 * Assert an array of git argvs against the read-only allowlist. Returns an array
 * of violation strings (empty means clean). A `config` write form or any
 * subcommand outside the allowlist is a violation.
 */
export function findGitViolations(calls) {
  const violations = [];
  for (const argv of calls) {
    const { subcommand } = gitSubcommand(argv);
    if (subcommand === "--version" || subcommand === "--help") continue;
    if (subcommand === null) {
      violations.push(`no subcommand found in: git ${argv.join(" ")}`);
      continue;
    }
    if (!GIT_READONLY_SUBCOMMANDS.has(subcommand)) {
      violations.push(`disallowed git subcommand "${subcommand}": git ${argv.join(" ")}`);
      continue;
    }
    if (subcommand === "config") {
      const flags = argv.filter((t) => t.startsWith("-"));
      if (flags.some((f) => CONFIG_WRITE_FLAGS.has(f))) {
        violations.push(`mutating git config: git ${argv.join(" ")}`);
      } else if (!flags.some((f) => CONFIG_READ_FLAGS.has(f))) {
        // A bare `git config name value` (no read flag) is a write.
        violations.push(`git config without a read flag (possible write): git ${argv.join(" ")}`);
      }
    }
    if (subcommand === "remote") {
      // Only the bare list / `remote -v` / `remote show` forms are read-only.
      const mutators = ["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune", "update"];
      if (argv.slice(1).some((t) => mutators.includes(t))) {
        violations.push(`mutating git remote: git ${argv.join(" ")}`);
      }
    }
    if (subcommand === "symbolic-ref") {
      // Read form: `symbolic-ref [-q] [--short] <name>` (exactly one non-flag
      // arg). Write forms: `symbolic-ref <name> <ref>` (two non-flag args) or
      // `-d`/`--delete <name>`.
      const rest = argv.slice(argv.indexOf(subcommand) + 1);
      const flags = rest.filter((t) => t.startsWith("-"));
      const positionals = rest.filter((t) => !t.startsWith("-"));
      if (flags.includes("-d") || flags.includes("--delete") || positionals.length >= 2) {
        violations.push(`mutating git symbolic-ref: git ${argv.join(" ")}`);
      }
    }
  }
  return violations;
}

// --- running the CLI ------------------------------------------------------

/**
 * Run `agentify git analyze <args>` as a child process inside a sandbox. Never
 * throws on a non-zero exit — returns { code, stdout, stderr } so exit-code
 * assertions (row 8) can inspect the code directly.
 *
 * @param {object} sandbox - from createSandbox()
 * @param {string} cwd - the analysed repo root
 * @param {string[]} analyzeArgs - args AFTER `git analyze`
 */
export async function runAnalyzeCli(sandbox, cwd, analyzeArgs = []) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, "git", "analyze", ...analyzeArgs],
      { cwd, env: sandbox.env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === "number" ? error.code : (error ? 1 : 0),
          stdout,
          stderr,
        });
      },
    );
  });
}
