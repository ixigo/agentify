import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildGitAnalyzeSummary } from "../src/core/git-analyze/cluster.js";
import { renderMarkdown, renderText, renderJson } from "../src/core/git-analyze/render.js";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

// A tiny fixed fixture (records only; render.js is pure) whose summary produces
// a short, human-verifiable golden document.
function rec(overrides) {
  const sha = overrides.sha;
  return {
    sha,
    short: sha.slice(0, 7),
    authoredAt: overrides.authoredAt || "2026-06-01T10:00:00+00:00",
    authorName: "Alice Dev",
    authorEmail: "alice@work.com",
    subject: overrides.subject || "change",
    body: "",
    type: overrides.type ?? null,
    scope: overrides.scope ?? null,
    breaking: false,
    issueKeys: overrides.issueKeys || [],
    isMerge: false,
    isRevert: false,
    revertOf: null,
    insertions: overrides.insertions ?? 1,
    deletions: overrides.deletions ?? 0,
    files: overrides.files || [],
    filesExcluded: 0,
  };
}

function fixedReport() {
  const commits = [
    rec({ sha: "a".repeat(40), issueKeys: ["#42"], type: "feat", insertions: 20, deletions: 4, files: ["src/a.js"], authoredAt: "2026-06-01T10:00:00+00:00" }),
    rec({ sha: "b".repeat(40), issueKeys: ["#42"], type: "fix", insertions: 6, deletions: 2, files: ["src/a.js", "src/b.js"], authoredAt: "2026-06-02T10:00:00+00:00" }),
    rec({ sha: "c".repeat(40), issueKeys: ["#42"], type: "fix", insertions: 3, deletions: 1, files: ["src/a.js"], authoredAt: "2026-06-03T10:00:00+00:00" }),
    rec({ sha: "d".repeat(40), issueKeys: ["#7"], type: "chore", insertions: 2, deletions: 0, files: ["docs/x.md"], authoredAt: "2026-06-04T10:00:00+00:00" }),
  ];
  const merges = [rec({ sha: "e".repeat(40), issueKeys: ["#42"], subject: "Merge pull request #50 from feat/42" })];
  return {
    command: "git analyze",
    scope: "local",
    generated_at: "2026-07-29T00:00:00.000Z",
    window: { label: "2026-06-01 .. 2026-06-30", since: "2026-06-01", until: "2026-06-30", timezone: "UTC" },
    repository: { path: "/tmp/myrepo", is_git_repository: true },
    counts: { commits: commits.length, authors: 1, repositories: 1 },
    totals: { insertions: 31, deletions: 7, distinct_files: 3, file_changes: 4, binary_files: 0, files_excluded: 0, merges: 1, issue_refs: 2, branches: 0 },
    truncated: { commits: false, merges: false, files: false, fileEntries: false },
    commits,
    merges,
    branches: [],
    filters: { applied: false, include_merges: false, identities: null, applied_filters: [], warnings: [] },
    notes: [],
  };
}

test("markdown golden: a fixed fixture renders a stable, pasteable document", () => {
  const summary = buildGitAnalyzeSummary(fixedReport());
  const md = renderMarkdown({ ...fixedReport(), summary });

  const expected = [
    "# git analyze — 2026-06-01 .. 2026-06-30",
    "",
    "Repository: **myrepo**",
    "",
    "**4 commits** by 1 author · +31 / -7 across 3 files · 4 active days · 1 merge landed",
    "",
    "Window: 2026-06-01 → 2026-06-04 (resolved 2026-06-01 → 2026-06-30)",
    "",
    "## Themes",
    "",
    "### Issue #42 — 3 commits (+29/-7)",
    "",
    "- Key: #42",
    "- Types: fix×2, feat×1",
    "- Span: 2026-06-01 → 2026-06-03 · 2 files touched",
    "- Top files: `src/a.js` (3), `src/b.js` (1)",
    "- Delivered: _Merge pull request #50 from feat/42_",
    "- Iteration: 3 commits on #42 (repeated work, not noise)",
    "- Evidence: aaaaaaa bbbbbbb ccccccc",
    "",
    "### Smaller changes — 1 commit across 1 small theme (+2/-0)",
    "",
    "- Evidence: ddddddd",
    "",
    "## Distribution",
    "",
    "- **By type** (4 of 4 commits): fix 2, chore 1, feat 1",
    "- **By author** (4 of 4 commits): alice@work.com 4",
    "- **By repository** (4 of 4 commits): myrepo 4",
    "- **By week** (4 of 4 commits): 2026-W23 4",
    "",
    "## Limitations",
    "",
    "- 1 merge commit(s) are reported as delivery evidence but excluded from commit and churn counts (pass --include-merges to count them).",
    "",
  ].join("\n");

  assert.equal(md, expected);
});

test("markdown and text are byte-stable across repeated renders", () => {
  const report = { ...fixedReport(), summary: buildGitAnalyzeSummary(fixedReport()) };
  assert.equal(renderMarkdown(report), renderMarkdown(report));
  assert.equal(renderText(report), renderText(report));
});

test("json render nests the versioned summary and keeps the full report top level", () => {
  const report = { ...fixedReport(), summary: buildGitAnalyzeSummary(fixedReport()) };
  const parsed = JSON.parse(renderJson(report));
  assert.equal(parsed.command, "git analyze");
  assert.equal(parsed.counts.commits, 4);
  assert.equal(parsed.summary.schema, "git-analyze-v1");
  assert.equal(parsed.summary.totals.commits, 4);
});

// ---------------------------------------------------------------------------
// CLI end-to-end: --format md, and the explained empty report.
// ---------------------------------------------------------------------------

async function git(root, args, env) {
  return execFileAsync("git", args, { cwd: root, env: env ? { ...process.env, ...env } : process.env });
}

async function initRepo(root) {
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Alice"]);
  await git(root, ["config", "user.email", "alice@work.com"]);
  await fs.writeFile(path.join(root, "a.js"), "a\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "feat: first"]);
}

test("git analyze --format md prints a pasteable document to stdout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-md-"));
  try {
    await initRepo(root);
    const { stdout } = await execFileAsync("node", [CLI, "git", "analyze", "--days", "3650", "--format", "md"], { cwd: root });
    assert.match(stdout, /^# git analyze —/m);
    assert.match(stdout, /## Themes/);
    assert.match(stdout, /\*\*1 commit\*\*/);
    assert.match(stdout, /## Limitations/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("git analyze renders an explained empty report and exits 0 when filters match nothing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-empty-"));
  try {
    await initRepo(root);
    // A grep that matches no commit message: the run must still succeed.
    const md = await execFileAsync("node", [CLI, "git", "analyze", "--days", "3650", "--grep", "zzz-no-such-commit", "--format", "md"], { cwd: root });
    assert.match(md.stdout, /\*\*0 commits\*\*/);
    assert.match(md.stdout, /_No themes: no commits matched the filters._/);

    const json = await execFileAsync("node", [CLI, "git", "analyze", "--days", "3650", "--grep", "zzz-no-such-commit", "--format", "json"], { cwd: root });
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.summary.totals.commits, 0);
    assert.deepEqual(payload.summary.themes, []);
    assert.deepEqual(payload.summary.smaller_changes, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
