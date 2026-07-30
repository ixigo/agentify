import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  resolveTracker,
  collectIssueKeys,
  normalizeMode,
  trackerCacheDir,
  TRACKER_SCHEMA,
  REST_ENV_VARS,
} from "../src/core/git-analyze/tracker.js";
import { classifyIssueKey } from "../src/core/git-analyze/parse.js";
import { buildGitAnalyzeSummary, applyTrackerTitles } from "../src/core/git-analyze/cluster.js";
import { renderText, renderMarkdown, renderJson } from "../src/core/git-analyze/render.js";
import { renderGitAnalyzeHtml } from "../src/core/git-analyze/html.js";

// ---------------------------------------------------------------------------
// Fixtures and injected layers (no live network, ever).
// ---------------------------------------------------------------------------

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
    type: overrides.type ?? "feat",
    scope: overrides.scope ?? null,
    breaking: false,
    issueKeys: overrides.issueKeys || [],
    isMerge: false,
    isRevert: false,
    revertOf: null,
    insertions: overrides.insertions ?? 2,
    deletions: overrides.deletions ?? 1,
    files: overrides.files || ["src/a.js"],
    filesExcluded: 0,
  };
}

// A tiny local report whose summary has two issue-keyed themes (PROJ-1, #42).
function fixtureReport(keys = ["PROJ-1", "#42"]) {
  const commits = [];
  let n = 0;
  for (const key of keys) {
    for (let i = 0; i < 2; i += 1) {
      commits.push(rec({ sha: String(n).padStart(40, "0"), issueKeys: [key] }));
      n += 1;
    }
  }
  const report = {
    command: "git analyze",
    scope: "local",
    generated_at: "2026-07-29T00:00:00.000Z",
    window: { label: "w", since: "2026-06-01", until: "2026-06-30", timezone: "UTC", form: "days" },
    repository: { path: "/tmp/fixture-repo", is_git_repository: true },
    counts: { commits: commits.length, authors: 1, repositories: 1 },
    totals: { insertions: 10, deletions: 5, distinct_files: 1, file_changes: 4, binary_files: 0, files_excluded: 0, merges: 0, issue_refs: keys.length, branches: 0 },
    truncated: { commits: false, merges: false, files: false, fileEntries: false },
    commits,
    merges: [],
    branches: [],
    filters: null,
    notes: [],
  };
  report.summary = buildGitAnalyzeSummary(report, { minThemeCommits: 2 });
  return report;
}

// A mock HTTP layer that records every call and answers from a title map. It
// parses the JQL `key in (...)` out of the request body so batching is testable.
function mockHttp(handler) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    return handler(opts, calls.length);
  };
  return { calls, fn };
}

function jqlKeys(body) {
  const match = /key in \(([^)]*)\)/.exec(String(JSON.parse(body).jql || ""));
  return match ? match[1].split(",").map((k) => k.trim()).filter(Boolean) : [];
}

function restOk(titleMap) {
  return (opts) => {
    const keys = jqlKeys(opts.body);
    const issues = keys
      .filter((key) => titleMap[key])
      .map((key) => ({ key, fields: { summary: titleMap[key], status: { name: "Done" }, issuetype: { name: "Story" } } }));
    return { statusCode: 200, body: JSON.stringify({ issues }) };
  };
}

const REST_ENV = { JIRA_BASE_URL: "https://example.atlassian.net", JIRA_EMAIL: "me@example.com", JIRA_API_TOKEN: "s3cr3t-token-value" };

async function tmpCacheEnv(extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-tracker-cache-"));
  return { dir, env: { XDG_CACHE_HOME: dir, ...extra } };
}

// ---------------------------------------------------------------------------
// Key classification / collection.
// ---------------------------------------------------------------------------

test("classifyIssueKey splits GitHub and Jira and rejects the false-positive corpus", () => {
  assert.deepEqual(classifyIssueKey("#336"), { kind: "github", project: null, number: "336" });
  assert.deepEqual(classifyIssueKey("PROJ-1481"), { kind: "jira", project: "PROJ", number: "1481" });
  for (const token of ["UTF-8", "SHA-256", "HTTP-2", "ISO-8601", "RFC-2119", "AES-256"]) {
    assert.equal(classifyIssueKey(token), null, `${token} must not classify as an issue key`);
  }
});

test("collectIssueKeys pulls distinct keys from a summary's themes", () => {
  const report = fixtureReport(["PROJ-1", "#42"]);
  const keys = collectIssueKeys(report.summary);
  assert.ok(keys.includes("PROJ-1"));
  assert.ok(keys.includes("#42"));
  assert.equal(new Set(keys).size, keys.length);
});

test("normalizeMode maps absence/bare-flag and rejects a typo", () => {
  assert.equal(normalizeMode(undefined), "off");
  assert.equal(normalizeMode(false), "off");
  assert.equal(normalizeMode(true), "auto");
  assert.equal(normalizeMode("REST"), "rest");
  assert.throws(() => normalizeMode("jra"), /must be one of/);
});

// ---------------------------------------------------------------------------
// Off / auto-with-nothing-configured (the default posture).
// ---------------------------------------------------------------------------

test("mode off returns null and makes zero requests", async () => {
  const http = mockHttp(() => ({ statusCode: 200, body: "{}" }));
  const result = await resolveTracker({ keys: ["PROJ-1"], mode: "off", deps: { httpRequest: http.fn, hasBinary: async () => true, exec: async () => ({ code: 0, stdout: "{}", stderr: "" }) } });
  assert.equal(result, null);
  assert.equal(http.calls.length, 0);
});

test("auto with nothing configured behaves like the default plus one limitation", async () => {
  const http = mockHttp(() => ({ statusCode: 200, body: "{}" }));
  const { env } = await tmpCacheEnv();
  const result = await resolveTracker({
    keys: ["PROJ-1", "#42"],
    mode: "auto",
    env: { ...env, JIRA_BASE_URL: "", JIRA_EMAIL: "", JIRA_API_TOKEN: "" },
    deps: { httpRequest: http.fn, hasBinary: async () => false },
  });
  assert.equal(http.calls.length, 0);
  assert.equal(result.tier, "offline");
  assert.equal(result.network_requests, 0);
  assert.equal(result.limitations.length, 1);
  assert.match(result.limitations[0], /no tracker configured/);
});

// ---------------------------------------------------------------------------
// REST tier — success, batching, and every failure mode.
// ---------------------------------------------------------------------------

test("REST resolves 50 keys in a single batched request, not 50", async () => {
  const keys = Array.from({ length: 50 }, (_, i) => `PROJ-${i + 1}`);
  const titles = Object.fromEntries(keys.map((k) => [k, `Title for ${k}`]));
  const http = mockHttp(restOk(titles));
  const { env } = await tmpCacheEnv();
  const result = await resolveTracker({ keys, mode: "rest", env: { ...env, ...REST_ENV }, cache: false, deps: { httpRequest: http.fn } });
  assert.ok(http.calls.length <= 2, `expected <=2 requests, got ${http.calls.length}`);
  assert.equal(http.calls.length, 1);
  assert.equal(result.resolved_keys, 50);
  assert.equal(result.entries["PROJ-1"].title, "Title for PROJ-1");
  assert.equal(result.entries["PROJ-1"].url, "https://example.atlassian.net/browse/PROJ-1");
});

test("REST 404 on one key does not fail the run; that key is reported unresolved", async () => {
  const http = mockHttp(restOk({ "PROJ-1": "Real title" })); // PROJ-2 absent
  const { env } = await tmpCacheEnv();
  const result = await resolveTracker({ keys: ["PROJ-1", "PROJ-2"], mode: "rest", env: { ...env, ...REST_ENV }, cache: false, deps: { httpRequest: http.fn } });
  assert.equal(result.entries["PROJ-1"].resolved, true);
  assert.equal(result.entries["PROJ-2"].resolved, false);
  assert.equal(result.entries["PROJ-2"].reason, "not_found");
});

test("REST 401 disables the tier for the run with one limitation", async () => {
  const http = mockHttp(() => ({ statusCode: 401, body: "unauthorized" }));
  const { env } = await tmpCacheEnv();
  const result = await resolveTracker({ keys: ["PROJ-1", "PROJ-2"], mode: "rest", env: { ...env, ...REST_ENV }, cache: false, deps: { httpRequest: http.fn } });
  assert.deepEqual(result.disabled_tiers, ["rest"]);
  assert.ok(result.limitations.some((l) => /disabled/.test(l)));
  assert.equal(result.resolved_keys, 0);
});

test("REST 429 is a soft error: the batch is unresolved and the run continues", async () => {
  const http = mockHttp(() => ({ statusCode: 429, body: "slow down" }));
  const { env } = await tmpCacheEnv();
  const result = await resolveTracker({ keys: ["PROJ-1"], mode: "rest", env: { ...env, ...REST_ENV }, cache: false, deps: { httpRequest: http.fn } });
  assert.equal(result.entries["PROJ-1"].resolved, false);
  assert.equal(result.entries["PROJ-1"].reason, "rate_limited");
  assert.ok(result.limitations.some((l) => /transiently/.test(l)));
});

test("REST transport failure/timeout (statusCode 0) leaves keys unresolved", async () => {
  const http = mockHttp(() => ({ statusCode: 0, body: "" }));
  const { env } = await tmpCacheEnv();
  const result = await resolveTracker({ keys: ["PROJ-1"], mode: "rest", env: { ...env, ...REST_ENV }, cache: false, deps: { httpRequest: http.fn } });
  assert.equal(result.entries["PROJ-1"].resolved, false);
  assert.equal(result.entries["PROJ-1"].reason, "unavailable");
});

test("REST partial batch: some keys resolve, others are reported unresolved", async () => {
  const http = mockHttp(restOk({ "PROJ-1": "One", "PROJ-3": "Three" }));
  const { env } = await tmpCacheEnv();
  const result = await resolveTracker({ keys: ["PROJ-1", "PROJ-2", "PROJ-3"], mode: "rest", env: { ...env, ...REST_ENV }, cache: false, deps: { httpRequest: http.fn } });
  assert.equal(result.entries["PROJ-1"].resolved, true);
  assert.equal(result.entries["PROJ-2"].resolved, false);
  assert.equal(result.entries["PROJ-3"].resolved, true);
});

test("REST without the env vars throws an actionable error naming all three", async () => {
  await assert.rejects(
    () => resolveTracker({ keys: ["PROJ-1"], mode: "rest", env: {}, deps: { httpRequest: mockHttp(() => ({})).fn } }),
    (error) => {
      for (const name of REST_ENV_VARS) assert.match(error.message, new RegExp(name));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// False-positive corpus never produces a lookup.
// ---------------------------------------------------------------------------

test("standards tokens in the key set never produce a tracker request", async () => {
  const http = mockHttp(restOk({ "PROJ-1": "Real" }));
  const { env } = await tmpCacheEnv();
  const result = await resolveTracker({
    keys: ["UTF-8", "SHA-256", "HTTP-2", "ISO-8601", "RFC-2119", "AES-256", "PROJ-1"],
    mode: "rest",
    env: { ...env, ...REST_ENV },
    cache: false,
    deps: { httpRequest: http.fn },
  });
  assert.equal(http.calls.length, 1);
  const looked = jqlKeys(http.calls[0].body);
  assert.deepEqual(looked, ["PROJ-1"]);
  assert.equal(result.requested_keys, 1);
});

// ---------------------------------------------------------------------------
// Project allowlist.
// ---------------------------------------------------------------------------

test("a project allowlist looks up only listed projects, reporting the rest skipped", async () => {
  const http = mockHttp(restOk({ "WEB-1": "kept" }));
  const { env } = await tmpCacheEnv();
  const result = await resolveTracker({
    keys: ["WEB-1", "OPS-9"],
    mode: "rest",
    projects: ["web"],
    env: { ...env, ...REST_ENV },
    cache: false,
    deps: { httpRequest: http.fn },
  });
  assert.deepEqual(jqlKeys(http.calls[0].body), ["WEB-1"]);
  assert.deepEqual(result.skipped_by_allowlist, ["OPS-9"]);
});

// ---------------------------------------------------------------------------
// Cache: cold then warm, and outside the repo.
// ---------------------------------------------------------------------------

test("a warm cache makes zero requests on the second identical run", async () => {
  const http = mockHttp(restOk({ "PROJ-1": "Cached title" }));
  const { dir, env } = await tmpCacheEnv();
  const opts = { keys: ["PROJ-1"], mode: "rest", env: { ...env, ...REST_ENV }, deps: { httpRequest: http.fn } };

  const cold = await resolveTracker(opts);
  assert.equal(http.calls.length, 1);
  assert.equal(cold.entries["PROJ-1"].title, "Cached title");

  const warm = await resolveTracker(opts);
  assert.equal(http.calls.length, 1, "second run must hit the cache, not the network");
  assert.equal(warm.entries["PROJ-1"].title, "Cached title");
  assert.ok(warm.cache_hits >= 1);

  // The cache lives under the XDG cache home, never inside the analysed repo.
  const cacheDir = trackerCacheDir(env);
  assert.ok(cacheDir.startsWith(dir));
  assert.ok(!cacheDir.startsWith("/tmp/fixture-repo"));
  const files = await fs.readdir(cacheDir);
  assert.ok(files.length >= 1);

  await fs.rm(dir, { recursive: true, force: true });
});

test("--no-cache (cache:false) bypasses the cache on every run", async () => {
  const http = mockHttp(restOk({ "PROJ-1": "t" }));
  const { env } = await tmpCacheEnv();
  const opts = { keys: ["PROJ-1"], mode: "rest", env: { ...env, ...REST_ENV }, cache: false, deps: { httpRequest: http.fn } };
  await resolveTracker(opts);
  await resolveTracker(opts);
  assert.equal(http.calls.length, 2);
});

// ---------------------------------------------------------------------------
// Bounds.
// ---------------------------------------------------------------------------

test("a request budget bound stops the run and states a limitation", async () => {
  // acli is one request per key; a budget of 1 must stop after the first.
  const exec = async (command, args) => {
    if (args[0] === "jira") return { code: 0, stdout: JSON.stringify({ fields: { summary: "T", status: { name: "Open" }, issuetype: { name: "Bug" } } }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const { env } = await tmpCacheEnv();
  const result = await resolveTracker({
    keys: ["PROJ-1", "PROJ-2", "PROJ-3"],
    mode: "acli",
    env,
    cache: false,
    maxRequests: 1,
    deps: { exec, hasBinary: async () => true },
  });
  assert.equal(result.network_requests, 1);
  assert.ok(result.limitations.some((l) => /budget|time limit/.test(l)));
});

// ---------------------------------------------------------------------------
// acli tier.
// ---------------------------------------------------------------------------

test("acli resolves a key and an acli auth failure disables the tier", async () => {
  const { env } = await tmpCacheEnv();
  const okExec = async (command, args) => {
    if (args[0] === "jira") return { code: 0, stdout: JSON.stringify({ fields: { summary: "Fix login", status: { name: "In Progress" }, issuetype: { name: "Bug" } } }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const ok = await resolveTracker({ keys: ["PROJ-1"], mode: "acli", env, cache: false, deps: { exec: okExec, hasBinary: async () => true } });
  assert.equal(ok.entries["PROJ-1"].title, "Fix login");
  assert.equal(ok.entries["PROJ-1"].source, "acli");

  const authExec = async (command, args) => {
    if (args[0] === "jira") return { code: 1, stdout: "", stderr: "401 Unauthorized: please authenticate" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const bad = await resolveTracker({ keys: ["PROJ-1"], mode: "acli", env, cache: false, deps: { exec: authExec, hasBinary: async () => true } });
  assert.deepEqual(bad.disabled_tiers, ["acli"]);
});

test("--jira acli with no acli on PATH falls soft to tier 0 with a limitation", async () => {
  const { env } = await tmpCacheEnv();
  const result = await resolveTracker({ keys: ["PROJ-1"], mode: "acli", env, cache: false, deps: { exec: async () => ({ code: 0, stdout: "", stderr: "" }), hasBinary: async () => false } });
  assert.equal(result.tier, "offline");
  assert.ok(result.limitations.some((l) => /no authenticated Atlassian CLI/.test(l)));
});

// ---------------------------------------------------------------------------
// GitHub via gh — present and absent.
// ---------------------------------------------------------------------------

test("gh present and authenticated resolves GitHub issue titles", async () => {
  const { env } = await tmpCacheEnv();
  const exec = async (command, args) => {
    if (args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "issue") return { code: 0, stdout: JSON.stringify({ number: 42, title: "Inject context at session start", state: "OPEN", url: "https://github.com/o/r/issues/42" }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await resolveTracker({ keys: ["#42"], mode: "auto", env, cache: false, deps: { exec, hasBinary: async (name) => name === "gh" } });
  assert.equal(result.github, "gh");
  assert.equal(result.entries["#42"].title, "Inject context at session start");
  assert.equal(result.entries["#42"].url, "https://github.com/o/r/issues/42");
});

test("gh absent leaves GitHub keys offline with no request", async () => {
  const { env } = await tmpCacheEnv();
  let calls = 0;
  const exec = async () => { calls += 1; return { code: 0, stdout: "", stderr: "" }; };
  const result = await resolveTracker({ keys: ["#42"], mode: "auto", env: { ...env, JIRA_BASE_URL: "", JIRA_EMAIL: "", JIRA_API_TOKEN: "" }, cache: false, deps: { exec, hasBinary: async () => false } });
  assert.equal(result.github, "offline");
  assert.equal(result.entries["#42"].resolved, false);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// Credential safety — the acceptance criterion that matters most.
// ---------------------------------------------------------------------------

test("no credential appears in any artifact or cache file, across every format", async () => {
  const TOKEN = "SUPER-SECRET-JIRA-TOKEN-1234567890";
  const { dir, env } = await tmpCacheEnv({ ...REST_ENV, JIRA_API_TOKEN: TOKEN });
  const http = mockHttp((opts) => {
    // The credential MUST reach the Authorization header (that is the only place
    // it is allowed to be) — assert it does, so the leak test is meaningful.
    assert.match(String(opts.headers.Authorization || ""), /^Basic /);
    return restOk({ "PROJ-1": "A readable title" })(opts);
  });

  const report = fixtureReport(["PROJ-1", "#42"]);
  const tracker = await resolveTracker({ keys: collectIssueKeys(report.summary), mode: "rest", env, deps: { httpRequest: http.fn } });
  report.tracker = tracker;
  applyTrackerTitles(report.summary, tracker);

  const artifacts = [
    renderJson(report),
    renderMarkdown(report),
    renderText(report),
    renderGitAnalyzeHtml(report, { environment: { agentifyOnPath: false, hasConfig: false, providers: [] } }),
    JSON.stringify(tracker),
  ];
  for (const artifact of artifacts) {
    assert.ok(!artifact.includes(TOKEN), "a rendered artifact leaked the token");
  }
  // Every cache file on disk, too.
  const cacheDir = trackerCacheDir(env);
  for (const file of await fs.readdir(cacheDir)) {
    const raw = await fs.readFile(path.join(cacheDir, file), "utf8");
    assert.ok(!raw.includes(TOKEN), `cache file ${file} leaked the token`);
  }
  // The resolved title made it into the rendered document.
  assert.ok(renderMarkdown(report).includes("A readable title"));

  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// applyTrackerTitles folds titles and limitations into the summary.
// ---------------------------------------------------------------------------

test("applyTrackerTitles retitles issue themes and merges limitations", () => {
  const report = fixtureReport(["PROJ-1"]);
  const tracker = {
    schema: TRACKER_SCHEMA,
    entries: { "PROJ-1": { key: "PROJ-1", resolved: true, title: "Ship the thing", status: "Done", type: "Story", url: "https://x/browse/PROJ-1", source: "rest" } },
    limitations: ["A tracker limitation."],
  };
  applyTrackerTitles(report.summary, tracker);
  const theme = report.summary.themes.find((t) => t.key === "PROJ-1");
  assert.equal(theme.title, "PROJ-1 — Ship the thing");
  assert.equal(theme.tracker.status, "Done");
  assert.ok(report.summary.limitations.includes("A tracker limitation."));
});

test("HTML escapes untrusted tracker titles and drops a non-http link", () => {
  const report = fixtureReport(["PROJ-1"]);
  const tracker = {
    schema: TRACKER_SCHEMA,
    entries: { "PROJ-1": { key: "PROJ-1", resolved: true, title: "<script>alert(1)</script>", status: "<b>x</b>", type: "Story", url: "javascript:alert(1)", source: "rest" } },
    limitations: [],
  };
  applyTrackerTitles(report.summary, tracker);
  const html = renderGitAnalyzeHtml(report, { environment: { agentifyOnPath: false, hasConfig: false, providers: [] } });
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw script tag leaked into HTML");
  assert.ok(html.includes("&lt;script&gt;"), "title was not escaped");
  assert.ok(!html.includes("javascript:alert(1)"), "unsafe link was emitted");
});
