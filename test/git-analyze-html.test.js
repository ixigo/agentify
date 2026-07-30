import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  renderGitAnalyzeHtml,
  detectEnvironment,
  defaultReportPath,
  escapeHtml,
} from "../src/core/git-analyze/html.js";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function git(root, args, options = {}) {
  return execFileAsync("git", args, { cwd: root, ...options });
}

// A `git-analyze-v1` summary with every section populated, so the renderer is
// exercised on realistic shape rather than an empty object.
function fixtureReport(overrides = {}) {
  return {
    command: "git analyze",
    schema_version: 3,
    generated_at: "2026-07-30T00:00:00.000Z",
    scope: "local",
    dry_run: false,
    repository: { path: "/tmp/fixture", is_git_repository: true },
    counts: { commits: 6, authors: 2, repositories: 1 },
    summary: {
      schema: "git-analyze-v1",
      command: "git analyze",
      scope: "local",
      window: {
        form: "days", since: "2026-05-01T00:00:00.000Z", until: "2026-07-30T00:00:00.000Z",
        since_kind: "instant", until_kind: "instant", label: "Last 90 days", timezone: "UTC",
      },
      identities: null,
      repositories: [{
        name: "fixture", path: "/tmp/fixture", commits: 6, authors: 2, active_days: 4,
        first_commit: "2026-05-02T10:00:00Z", last_commit: "2026-07-20T10:00:00Z",
        insertions: 120, deletions: 30, files: 9, merges: 2,
      }],
      filters: {
        applied: true, include_merges: false, identities: null,
        applied_filters: [
          { kind: "branch", flag: "--branch", values: ["feat/*"], matched: 3, unit: "refs" },
          { kind: "grep", flag: "--grep", values: ["acp"], matched: 4, unit: "commits" },
        ],
        warnings: ["--grep \"acp\" matched few commits."],
      },
      totals: {
        commits: 6, insertions: 120, deletions: 30, files: 9, active_days: 4,
        first_commit: "2026-05-02T10:00:00Z", last_commit: "2026-07-20T10:00:00Z",
        repositories: 1, merges: 2, authors: 2,
      },
      distributions: {
        by_type: { denominator: 6, counted: 5, items: [{ key: "feat", commits: 3, insertions: 90, deletions: 10 }, { key: "fix", commits: 2, insertions: 30, deletions: 20 }] },
        by_scope: { denominator: 6, counted: 4, items: [{ key: "acp", commits: 4, insertions: 100, deletions: 20 }] },
        by_author: { denominator: 6, counted: 6, items: [{ key: "a@example.com", commits: 4 }, { key: "b@example.com", commits: 2 }] },
        by_week: { denominator: 6, counted: 6, items: [{ key: "2026-W18", commits: 2 }, { key: "2026-W29", commits: 4 }] },
      },
      themes: [{
        id: "fixture::issue:#336",
        repository: "fixture",
        key_kind: "issue",
        key: "#336",
        title: "Issue #336",
        issue_keys: ["#336"],
        branches: ["feat/acp"],
        scopes: ["acp"],
        type_histogram: { feat: 3, fix: 1 },
        commits: 4,
        first_commit: "2026-07-01T10:00:00Z",
        last_commit: "2026-07-20T10:00:00Z",
        insertions: 100, deletions: 20, files_changed: 6,
        top_files: [{ path: "src/core/acp/inject.js", commits: 3 }],
        merge_subjects: ["Merge pull request #340"],
        iteration_signal: "4 commits on #336 (repeated work, not noise)",
        shas: ["a".repeat(40), "b".repeat(40)],
      }],
      smaller_changes: [{
        repository: "fixture", commits: 2, insertions: 20, deletions: 10, files_changed: 3,
        type_histogram: { chore: 2 }, first_commit: "2026-05-02T10:00:00Z",
        last_commit: "2026-05-03T10:00:00Z", distinct_keys: 2, shas: ["c".repeat(40)],
      }],
      evidence: { merges_excluded: 2, generated_files_excluded: 1, commits_capped: 0, repositories_unreadable: 0 },
      limitations: ["2 merge commit(s) are reported as delivery evidence but excluded from commit and churn counts."],
    },
    ...overrides,
  };
}

const NO_TOOLS = { agentifyOnPath: false, hasConfig: false, providers: [] };

test("escapeHtml neutralizes every HTML-significant character", () => {
  assert.equal(escapeHtml(`<script>"x"&'y'</script>`), "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("the report renders every required section from the summary", () => {
  const html = renderGitAnalyzeHtml(fixtureReport(), { environment: NO_TOOLS });

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<h1>What changed in/);
  assert.match(html, /Headline/);
  assert.match(html, /Distribution/);
  assert.match(html, /Themes/);
  assert.match(html, /What this report could not show/);
  // The applied filter set appears in the header (#351 + epic DoD).
  assert.match(html, /--branch/);
  assert.match(html, /--grep/);
  assert.match(html, /restricts reachability/);
  assert.match(html, /restricts commit messages/);
  // Figures come from the summary, unaltered.
  assert.match(html, /120/);
  assert.match(html, /Issue #336/);
  assert.match(html, /repeated work, not noise/);
  // The "smaller changes" bucket is not silently dropped.
  assert.match(html, /Smaller changes/);
});

// Commit subjects, branch names, author names and file paths are untrusted text
// out of a git repository. redactSensitiveText strips angle brackets upstream,
// but the renderer must not DEPEND on that: it is the last line of defence and
// is tested directly on raw payloads.
test("untrusted text renders as visible text and executes nothing", () => {
  const payload = `<script>alert('xss')</script>`;
  const imgPayload = `<img src=x onerror=alert(1)>`;
  const report = fixtureReport();
  report.summary.themes[0].title = `Theme ${payload}`;
  report.summary.themes[0].branches = [`feat/${payload}`];
  report.summary.themes[0].top_files = [{ path: `src/${imgPayload}.js`, commits: 2 }];
  report.summary.themes[0].merge_subjects = [`Merge ${payload}`];
  report.summary.themes[0].iteration_signal = `signal ${payload}`;
  report.summary.distributions.by_author.items = [{ key: `author ${payload}`, commits: 4 }];
  report.summary.distributions.by_type.items = [{ key: `type ${imgPayload}`, commits: 3 }];
  report.summary.limitations = [`limitation ${payload}`];
  report.summary.filters.warnings = [`warning ${payload}`];
  report.summary.repositories[0].name = `repo ${payload}`;

  const html = renderGitAnalyzeHtml(report, { environment: NO_TOOLS });

  // Not a single executable tag from the payload survives. Note the escaped
  // text still CONTAINS "onerror=alert" as inert characters — what matters is
  // that no `<` ever opens a tag around it, so it can never be parsed as one.
  assert.equal(/<script[^>]*>/i.test(html), false, "no live <script> tag");
  assert.equal(/<img[^>]*onerror/i.test(html), false, "no live <img onerror>");
  assert.equal(/<[a-z][^>]*\son\w+\s*=/i.test(html), false, "no inline event handler on any live tag");
  // It is present, escaped, so the user still sees what the commit said.
  assert.ok(html.includes("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"), "payload rendered as text");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "img payload rendered as text");
});

test("the document is self-contained: no remote asset of any kind", () => {
  const html = renderGitAnalyzeHtml(fixtureReport(), { environment: NO_TOOLS });
  // No CDN, webfont, remote image, or beacon — it must render with the network
  // off. Checks the attribute forms that would actually fetch something.
  assert.equal(/(?:src|href)\s*=\s*["']https?:\/\//i.test(html), false, "no remote src/href");
  assert.equal(/url\(\s*["']?https?:\/\//i.test(html), false, "no remote CSS url()");
  assert.equal(/<link\b/i.test(html), false, "no <link> element");
  assert.equal(/@import/i.test(html), false, "no CSS @import");
  // Styles are inline.
  assert.match(html, /<style>/);
});

test("the report is theme-aware and contains wide content horizontally", () => {
  const html = renderGitAnalyzeHtml(fixtureReport(), { environment: NO_TOOLS });
  assert.match(html, /prefers-color-scheme: light/);
  assert.match(html, /color-scheme: dark light/);
  // Wide content scrolls in its own container; the body never scrolls sideways.
  assert.match(html, /\.table-wrap \{ overflow-x: auto/);
  assert.match(html, /body \{[^}]*overflow-x: hidden/s);
});

test("the Agentify panel tells the truth about an empty machine", () => {
  const html = renderGitAnalyzeHtml(fixtureReport(), { environment: NO_TOOLS });
  assert.match(html, /This report needed nothing installed/);
  assert.match(html, /<code>agentify<\/code> on PATH: <strong>no<\/strong>/);
  assert.match(html, /in this repository: <strong>no<\/strong>/);
  assert.match(html, /Provider CLI detected: <strong>none<\/strong>/);
  // With nothing installed there is no command to suggest, and no benefit is
  // claimed that would require something absent.
  assert.equal(html.includes("agentify scan"), false);
  assert.equal(html.includes("agentify ctx load"), false);
  assert.equal(/upgrade/i.test(html), false, "no upgrade nag");
});

test("the Agentify panel suggests exactly one command that actually exists", () => {
  const installedNoConfig = renderGitAnalyzeHtml(fixtureReport(), {
    environment: { agentifyOnPath: true, hasConfig: false, providers: ["claude"] },
  });
  assert.match(installedNoConfig, /<code>agentify scan<\/code>/);
  assert.equal(installedNoConfig.includes("agentify ctx load"), false, "only one suggestion");
  // A provider-dependent capability is claimed only when a provider exists.
  assert.match(installedNoConfig, /independent review from a different vendor/);

  const fullySetUp = renderGitAnalyzeHtml(fixtureReport(), {
    environment: { agentifyOnPath: true, hasConfig: true, providers: [] },
  });
  assert.match(fullySetUp, /<code>agentify ctx load<\/code>/);
  assert.equal(fullySetUp.includes("agentify scan"), false);
  assert.equal(fullySetUp.includes("independent review from a different vendor"), false,
    "no delegation claim without a provider CLI");
});

test("the report is complete with no narration and splices it in when present", () => {
  const withoutNarration = renderGitAnalyzeHtml(fixtureReport(), { environment: NO_TOOLS });
  assert.match(withoutNarration, /Issue #336/, "deterministic title is used");

  const report = fixtureReport();
  report.narration = {
    status: "ok",
    entries: [{
      title: "Context injection at session start",
      what: "Shipped ACP context injection.",
      how_it_helped: "Editors that speak the protocol now get durable context.",
      theme_ids: ["fixture::issue:#336"],
      confidence: "high",
    }],
    receipt: { provider: "claude", model: "sonnet", bytes_sent: 4096, network_calls: 1, cost_usd: "0.02" },
  };
  const withNarration = renderGitAnalyzeHtml(report, { environment: NO_TOOLS });
  assert.match(withNarration, /Context injection at session start/);
  assert.match(withNarration, /Editors that speak the protocol/);
  // The privacy receipt is present only when a provider actually ran.
  assert.match(withNarration, /Privacy receipt/);
  assert.equal(withoutNarration.includes("Privacy receipt"), false);
});

test("a declined or failed narration states the reason and keeps the report", () => {
  const report = fixtureReport();
  report.narration = { status: "declined", reason: "consent was refused" };
  const html = renderGitAnalyzeHtml(report, { environment: NO_TOOLS });
  assert.match(html, /Narration was not applied: consent was refused/);
  assert.match(html, /Issue #336/, "the deterministic report is intact");
  assert.equal(html.includes("Privacy receipt"), false);
});

test("global scope groups themes by repository instead of blending them", () => {
  const report = fixtureReport();
  report.scope = "global";
  report.summary.scope = "global";
  report.summary.repositories = [
    { name: "alpha", path: "/w/alpha", commits: 4, insertions: 100, deletions: 20, files: 6, merges: 1, authors: 1, active_days: 2 },
    { name: "beta", path: "/w/beta", commits: 2, insertions: 20, deletions: 10, files: 3, merges: 1, authors: 1, active_days: 2 },
  ];
  report.summary.themes = [
    { ...report.summary.themes[0], id: "alpha::issue:#1", repository: "alpha", title: "Issue #1" },
    { ...report.summary.themes[0], id: "beta::issue:#1", repository: "beta", title: "Issue #1" },
  ];
  const html = renderGitAnalyzeHtml(report, { environment: NO_TOOLS });
  assert.match(html, /<h3>alpha<\/h3>/);
  assert.match(html, /<h3>beta<\/h3>/);
});

test("defaultReportPath resolves outside any repository and honours XDG_CACHE_HOME", () => {
  const report = fixtureReport();
  const xdg = defaultReportPath(report, { XDG_CACHE_HOME: "/custom/cache" });
  assert.equal(xdg, path.join("/custom/cache", "agentify", "git-analyze", "fixture-last-90-days.html"));

  // A blank XDG value must not produce a path rooted at "".
  const blank = defaultReportPath(report, { XDG_CACHE_HOME: "   " });
  assert.ok(blank.startsWith(path.join(os.homedir(), ".cache")), blank);

  // A hostile repository name cannot escape the cache directory.
  const hostile = fixtureReport();
  hostile.summary.repositories[0].name = "../../etc/passwd";
  const safe = defaultReportPath(hostile, { XDG_CACHE_HOME: "/custom/cache" });
  assert.ok(safe.startsWith("/custom/cache/agentify/git-analyze/"), safe);
  assert.equal(safe.includes(".."), false, "no traversal survives slugification");
});

test("detectEnvironment reports what is actually present, without writing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-html-env-"));
  const present = new Set(["agentify", "codex"]);
  const probe = { hasBinary: async (name) => present.has(name) };

  const bare = await detectEnvironment(root, probe);
  assert.deepEqual(bare, { agentifyOnPath: true, hasConfig: false, providers: ["codex"] });

  await fs.writeFile(path.join(root, ".agentify.yaml"), "version: 1\n");
  const configured = await detectEnvironment(root, probe);
  assert.equal(configured.hasConfig, true);

  // The probe created nothing of its own.
  assert.deepEqual((await fs.readdir(root)).sort(), [".agentify.yaml"]);
  await fs.rm(root, { recursive: true, force: true });
});

// The epic's hardest constraint, asserted end to end: the command must leave the
// analysed repository byte-identical, including gitignored paths.
test("CLI: --format html writes outside the repo and leaves it untouched", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-html-cli-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Fix Ture"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  for (const n of [1, 2, 3]) {
    await fs.writeFile(path.join(root, "src", `f${n}.js`), `const v = ${n};\n`);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-q", "-m", `feat(core): change ${n} (#7)`]);
  }

  const listing = async () => (await fs.readdir(root, { recursive: true })).sort();
  const before = await listing();
  const statusBefore = (await git(root, ["status", "--porcelain"])).stdout;

  const outputPath = path.join(os.tmpdir(), `agentify-html-${process.pid}.html`);
  const result = await execFileAsync("node", [
    CLI, "git", "analyze", "--days", "3650", "--format", "html", "--no-open", "--output", outputPath,
  ], { cwd: root });

  assert.match(result.stderr + result.stdout, /Report written to/);
  const html = await fs.readFile(outputPath, "utf8");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /What changed in/);

  // Nothing created, modified, or deleted inside the analysed repository.
  assert.deepEqual(await listing(), before);
  assert.equal((await git(root, ["status", "--porcelain"])).stdout, statusBefore);

  await fs.rm(outputPath, { force: true });
  await fs.rm(root, { recursive: true, force: true });
});

test("CLI: the default html path lands outside the analysed repository", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-html-default-"));
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-html-cache-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Fix Ture"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(root, "a.js"), "a\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "feat: one"]);

  const before = (await fs.readdir(root, { recursive: true })).sort();
  const result = await execFileAsync("node", [
    CLI, "git", "analyze", "--days", "3650", "--format", "html", "--no-open",
  ], { cwd: root, env: { ...process.env, XDG_CACHE_HOME: cache } });

  const written = /Report written to (.+)$/m.exec(result.stderr + result.stdout);
  assert.ok(written, "the absolute path is printed");
  const reportPath = written[1].trim();
  assert.ok(reportPath.startsWith(cache), `default path must be in the cache dir, got ${reportPath}`);
  assert.equal(reportPath.startsWith(root), false, "default path must never be inside the repo");
  assert.deepEqual((await fs.readdir(root, { recursive: true })).sort(), before);

  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(cache, { recursive: true, force: true });
});
