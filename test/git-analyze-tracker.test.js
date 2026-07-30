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

test("auto with nothing configured makes no requests and states per-provider limitations", async () => {
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
  // Both providers are unconfigured, and each unresolved kind states its own note.
  assert.ok(result.limitations.some((l) => /no Jira tracker is configured/.test(l)));
  assert.ok(result.limitations.some((l) => /no authenticated GitHub CLI/.test(l)));
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
  assert.ok(result.limitations.some((l) => /no Atlassian CLI on PATH/.test(l)));
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

// ---------------------------------------------------------------------------
// Review fixes.
// ---------------------------------------------------------------------------

test("auto uses configured REST directly even when acli is present (batched, host-disclosed)", async () => {
  const { env } = await tmpCacheEnv();
  const http = mockHttp(restOk({ "PROJ-1": "Resolved via REST" }));
  let acliCalls = 0;
  const exec = async (command, args) => {
    if (command === "acli" && args[0] === "jira") { acliCalls += 1; return { code: 1, stdout: "", stderr: "401 Unauthorized" }; }
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await resolveTracker({
    keys: ["PROJ-1"],
    mode: "auto",
    env: { ...env, ...REST_ENV },
    cache: false,
    deps: { httpRequest: http.fn, exec, hasBinary: async (name) => name === "acli" },
  });
  // REST is preferred when configured, so a logged-out acli is never even called
  // — the key resolves via the single batched REST request.
  assert.equal(acliCalls, 0);
  assert.deepEqual(result.disabled_tiers, []);
  assert.equal(result.entries["PROJ-1"].source, "rest");
  assert.equal(result.entries["PROJ-1"].title, "Resolved via REST");
});

test("Jira cache entries do not collide across different base URLs", async () => {
  const { dir } = await tmpCacheEnv();
  const httpA = mockHttp(restOk({ "PROJ-1": "Site A title" }));
  const httpB = mockHttp(restOk({ "PROJ-1": "Site B title" }));
  const base = { JIRA_EMAIL: "me@example.com", JIRA_API_TOKEN: "t" };

  const a = await resolveTracker({ keys: ["PROJ-1"], mode: "rest", env: { XDG_CACHE_HOME: dir, JIRA_BASE_URL: "https://a.atlassian.net", ...base }, deps: { httpRequest: httpA.fn } });
  const b = await resolveTracker({ keys: ["PROJ-1"], mode: "rest", env: { XDG_CACHE_HOME: dir, JIRA_BASE_URL: "https://b.atlassian.net", ...base }, deps: { httpRequest: httpB.fn } });

  assert.equal(a.entries["PROJ-1"].title, "Site A title");
  assert.equal(b.entries["PROJ-1"].title, "Site B title", "site B must not reuse site A's cached title");
  assert.equal(httpB.calls.length, 1, "site B must make its own request, not read site A's cache");
  await fs.rm(dir, { recursive: true, force: true });
});

test("GitHub titles are disabled under --global with a stated limitation and no gh call", async () => {
  const { env } = await tmpCacheEnv();
  let ghCalls = 0;
  const exec = async (command) => { if (command === "gh") ghCalls += 1; return { code: 0, stdout: "", stderr: "" }; };
  const result = await resolveTracker({
    keys: ["#42"],
    mode: "auto",
    allowGithubTitles: false,
    env: { ...env, JIRA_BASE_URL: "", JIRA_EMAIL: "", JIRA_API_TOKEN: "" },
    cache: false,
    deps: { exec, hasBinary: async () => false },
  });
  assert.equal(ghCalls, 0);
  assert.equal(result.github, "offline");
  assert.ok(result.limitations.some((l) => /not resolved under --global/.test(l)));
});

test("gh installed-but-unauthenticated states a limitation and resolves nothing", async () => {
  const { env } = await tmpCacheEnv();
  const exec = async (command, args) => {
    if (command === "gh" && args[0] === "auth") return { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await resolveTracker({ keys: ["#42"], mode: "auto", env: { ...env, JIRA_BASE_URL: "" }, cache: false, deps: { exec, hasBinary: async (name) => name === "gh" } });
  assert.equal(result.github, "offline");
  assert.equal(result.entries["#42"].resolved, false);
  assert.ok(result.limitations.some((l) => /not authenticated/.test(l)));
});

test("allowlist-skipped keys still get a reported entry with a browse link", async () => {
  const http = mockHttp(restOk({ "WEB-1": "kept" }));
  const { env } = await tmpCacheEnv();
  const result = await resolveTracker({
    keys: ["WEB-1", "OPS-9"],
    mode: "rest",
    projects: ["WEB"],
    env: { ...env, ...REST_ENV },
    cache: false,
    deps: { httpRequest: http.fn },
  });
  assert.ok(result.entries["OPS-9"], "skipped key must still be reported");
  assert.equal(result.entries["OPS-9"].reason, "allowlist_skipped");
  assert.equal(result.entries["OPS-9"].url, "https://example.atlassian.net/browse/OPS-9");
});

test("renderText surfaces tracker limitations in the terminal view", () => {
  const report = fixtureReport(["PROJ-1"]);
  applyTrackerTitles(report.summary, { schema: TRACKER_SCHEMA, entries: {}, limitations: ["A tracker tier was disabled for this run."] });
  const text = renderText(report);
  assert.match(text, /limitations:/);
  assert.match(text, /A tracker tier was disabled for this run\./);
});

test("a malformed HTTP 200 is a transient failure, not a cached not_found", async () => {
  const { dir } = await tmpCacheEnv();
  let bodies = ['{"issues": "not-an-array"}', "this is not json"];
  let call = 0;
  const http = { calls: [], fn: async (opts) => { http.calls.push(opts); return { statusCode: 200, body: bodies[call++] || "{}" }; } };
  const env = { XDG_CACHE_HOME: dir, ...REST_ENV };

  // Non-array `issues` must not throw and must not cache.
  const r1 = await resolveTracker({ keys: ["PROJ-1"], mode: "rest", env, deps: { httpRequest: http.fn } });
  assert.equal(r1.entries["PROJ-1"].resolved, false);
  assert.equal(r1.entries["PROJ-1"].reason, "unavailable");

  // Invalid JSON likewise; and a follow-up run re-requests (nothing poisoned).
  const r2 = await resolveTracker({ keys: ["PROJ-1"], mode: "rest", env, deps: { httpRequest: http.fn } });
  assert.equal(r2.entries["PROJ-1"].reason, "unavailable");
  assert.equal(http.calls.length, 2, "a malformed 200 must not be cached; the second run re-requests");
  await fs.rm(dir, { recursive: true, force: true });
});

test("acli caches under its own scope and does not reuse a REST title for the same key", async () => {
  const { dir } = await tmpCacheEnv();
  const env = { XDG_CACHE_HOME: dir, JIRA_BASE_URL: "https://site.atlassian.net", JIRA_EMAIL: "m@e.co", JIRA_API_TOKEN: "t" };

  // Warm the REST cache for PROJ-1.
  const http = mockHttp(restOk({ "PROJ-1": "REST title" }));
  await resolveTracker({ keys: ["PROJ-1"], mode: "rest", env, deps: { httpRequest: http.fn } });

  // An acli run for the same key must NOT read the REST-scoped cache; it makes
  // its own acli call and uses acli's own link (none here → null), not the env
  // browse URL.
  let acliCalls = 0;
  const exec = async (command, args) => {
    if (command === "acli" && args[0] === "jira") { acliCalls += 1; return { code: 0, stdout: JSON.stringify({ fields: { summary: "ACLI title", status: { name: "Open" }, issuetype: { name: "Task" } } }), stderr: "" }; }
    return { code: 0, stdout: "", stderr: "" };
  };
  const r = await resolveTracker({ keys: ["PROJ-1"], mode: "acli", env, deps: { exec, hasBinary: async (n) => n === "acli" } });
  assert.equal(acliCalls, 1, "acli must not be short-circuited by the REST cache");
  assert.equal(r.entries["PROJ-1"].title, "ACLI title");
  assert.equal(r.entries["PROJ-1"].url, null, "acli link must not be synthesised from JIRA_BASE_URL");
  await fs.rm(dir, { recursive: true, force: true });
});

test("the gh auth probe respects the request budget", async () => {
  const { env } = await tmpCacheEnv();
  let ghCalls = 0;
  const exec = async (command) => { if (command === "gh") ghCalls += 1; return { code: 0, stdout: "", stderr: "" }; };
  const result = await resolveTracker({
    keys: ["#42"],
    mode: "auto",
    env: { ...env, JIRA_BASE_URL: "" },
    cache: false,
    maxRequests: 0,
    deps: { exec, hasBinary: async (n) => n === "gh" },
  });
  assert.equal(ghCalls, 0, "a zero budget must not perform the gh auth probe");
  assert.equal(result.network_requests, 0);
});

test("secondary cited tickets (tracker_refs) render in md, text, and html", () => {
  const report = fixtureReport(["PROJ-1"]);
  // Make PROJ-1's theme also cite PROJ-2.
  for (const theme of report.summary.themes) {
    if (theme.key === "PROJ-1") theme.issue_keys = ["PROJ-1", "PROJ-2"];
  }
  const tracker = {
    schema: TRACKER_SCHEMA,
    entries: {
      "PROJ-1": { key: "PROJ-1", resolved: true, title: "Primary", status: "Done", type: "Story", url: "https://x/browse/PROJ-1", source: "rest" },
      "PROJ-2": { key: "PROJ-2", resolved: true, title: "Secondary work", status: "Done", type: "Task", url: "https://x/browse/PROJ-2", source: "rest" },
    },
    limitations: [],
  };
  applyTrackerTitles(report.summary, tracker);
  const md = renderMarkdown(report);
  const text = renderText(report);
  const html = renderGitAnalyzeHtml(report, { environment: { agentifyOnPath: false, hasConfig: false, providers: [] } });
  for (const out of [md, text, html]) {
    assert.match(out, /PROJ-2/);
    assert.match(out, /Secondary work/);
  }
});

test("cache files and directory are created owner-only (0700/0600)", async () => {
  const http = mockHttp(restOk({ "PROJ-1": "t" }));
  const { dir, env } = await tmpCacheEnv();
  await resolveTracker({ keys: ["PROJ-1"], mode: "rest", env: { ...env, ...REST_ENV }, deps: { httpRequest: http.fn } });
  const cacheDir = trackerCacheDir(env);
  const dirStat = await fs.stat(cacheDir);
  assert.equal(dirStat.mode & 0o777, 0o700);
  const files = await fs.readdir(cacheDir);
  const fileStat = await fs.stat(path.join(cacheDir, files[0]));
  assert.equal(fileStat.mode & 0o777, 0o600);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a warm GitHub cache serves titles from cache with no issue-view request (auth still confirmed)", async () => {
  const { dir, env } = await tmpCacheEnv();
  const okExec = async (command, args) => {
    if (command === "gh" && args[0] === "auth") return { code: 0, stdout: "Logged in to github.com account octocat", stderr: "" };
    if (command === "gh" && args[0] === "issue") return { code: 0, stdout: JSON.stringify({ number: 7, title: "Cached GH", state: "OPEN", url: "https://github.com/o/r/issues/7" }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const opts = { keys: ["#7"], mode: "auto", env: { ...env, JIRA_BASE_URL: "" }, deps: { exec: okExec, hasBinary: async (n) => n === "gh" } };
  const cold = await resolveTracker(opts);
  assert.equal(cold.entries["#7"].title, "Cached GH");

  // Warm run: the title comes from cache, so NO `gh issue view` runs. The auth
  // probe DOES run — it is what confirms the current account still has access
  // before a cached private title is surfaced (a deliberate security trade).
  let issueCalls = 0;
  const countingExec = async (command, ...rest) => { if (command === "gh" && rest[0][0] === "issue") issueCalls += 1; return okExec(command, ...rest); };
  const warm = await resolveTracker({ ...opts, deps: { exec: countingExec, hasBinary: async (n) => n === "gh" } });
  assert.equal(warm.entries["#7"].title, "Cached GH");
  assert.equal(issueCalls, 0, "a warm gh cache must not issue a per-key gh request");
  assert.ok(warm.cache_hits >= 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("auto without REST env uses acli; tiers_attempted reports what ran", async () => {
  const { env } = await tmpCacheEnv();
  const exec = async (command, args) => {
    if (command === "acli" && args[0] === "jira") return { code: 0, stdout: JSON.stringify({ fields: { summary: "Done by acli", status: { name: "Open" }, issuetype: { name: "Task" } } }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  // No REST env → auto falls to acli (the only configured higher tier).
  const result = await resolveTracker({
    keys: ["PROJ-1"],
    mode: "auto",
    env: { ...env, JIRA_BASE_URL: "", JIRA_EMAIL: "", JIRA_API_TOKEN: "" },
    cache: false,
    deps: { exec, hasBinary: async (n) => n === "acli" },
  });
  assert.deepEqual(result.tiers_attempted, ["acli"]);
  assert.equal(result.entries["PROJ-1"].title, "Done by acli");
});

test("credentials embedded in JIRA_BASE_URL never reach the report, links, or cache", async () => {
  const { dir } = await tmpCacheEnv();
  const http = mockHttp(restOk({ "PROJ-1": "Title" }));
  const env = { XDG_CACHE_HOME: dir, JIRA_BASE_URL: "https://bob:hunter2@site.atlassian.net", JIRA_EMAIL: "bob@site.co", JIRA_API_TOKEN: "tok" };
  const result = await resolveTracker({ keys: ["PROJ-1"], mode: "rest", env, deps: { httpRequest: http.fn } });

  assert.equal(result.base_url, "https://site.atlassian.net");
  assert.equal(result.entries["PROJ-1"].url, "https://site.atlassian.net/browse/PROJ-1");
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("hunter2"), "URL password leaked into the tracker block");
  assert.ok(!serialized.includes("bob:hunter2"));
  for (const file of await fs.readdir(trackerCacheDir(env))) {
    const raw = await fs.readFile(path.join(trackerCacheDir(env), file), "utf8");
    assert.ok(!raw.includes("hunter2"), "URL password leaked into the cache");
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("REST cache is partitioned by account, not just host", async () => {
  const { dir } = await tmpCacheEnv();
  const base = { XDG_CACHE_HOME: dir, JIRA_BASE_URL: "https://site.atlassian.net", JIRA_API_TOKEN: "t" };
  const httpA = mockHttp(restOk({ "PROJ-1": "Alice's view" }));
  const httpB = mockHttp(restOk({ "PROJ-1": "Bob's view" }));

  const a = await resolveTracker({ keys: ["PROJ-1"], mode: "rest", env: { ...base, JIRA_EMAIL: "alice@site.co" }, deps: { httpRequest: httpA.fn } });
  const b = await resolveTracker({ keys: ["PROJ-1"], mode: "rest", env: { ...base, JIRA_EMAIL: "bob@site.co" }, deps: { httpRequest: httpB.fn } });

  assert.equal(a.entries["PROJ-1"].title, "Alice's view");
  assert.equal(b.entries["PROJ-1"].title, "Bob's view", "a different account must not reuse the first account's cached title");
  assert.equal(httpB.calls.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("under --global a warm GitHub cache is not applied (wrong-repo risk)", async () => {
  const { dir, env } = await tmpCacheEnv();
  // Warm the gh cache for #7 in a LOCAL run.
  const okExec = async (command, args) => {
    if (command === "gh" && args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
    if (command === "gh" && args[0] === "issue") return { code: 0, stdout: JSON.stringify({ number: 7, title: "Repo A issue", state: "OPEN", url: "https://github.com/a/r/issues/7" }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  await resolveTracker({ keys: ["#7"], mode: "auto", env: { ...env, JIRA_BASE_URL: "" }, ghScope: "/repos/a", deps: { exec: okExec, hasBinary: async (n) => n === "gh" } });

  // A --global run (allowGithubTitles:false) must NOT reuse that cached title.
  const global = await resolveTracker({ keys: ["#7"], mode: "auto", allowGithubTitles: false, env: { ...env, JIRA_BASE_URL: "" }, ghScope: "/repos/a", deps: { exec: okExec, hasBinary: async () => false } });
  assert.equal(global.entries["#7"].resolved, false, "global must not apply a cwd-scoped GitHub title");
  await fs.rm(dir, { recursive: true, force: true });
});

test("a resolved tracker title survives AI narration in HTML", () => {
  const report = fixtureReport(["PROJ-1"]);
  const tracker = { schema: TRACKER_SCHEMA, entries: { "PROJ-1": { key: "PROJ-1", resolved: true, title: "The real Jira summary", status: "Done", type: "Story", url: "https://x/browse/PROJ-1", source: "rest" } }, limitations: [] };
  applyTrackerTitles(report.summary, tracker);
  const themeId = report.summary.themes.find((t) => t.key === "PROJ-1").id;
  report.narration = {
    status: "ok", provider: "claude", entries: [{ title: "A narrated headline", what: "w", how_it_helped: "h", confidence: "high", theme_ids: [themeId] }],
    not_narrated: [], receipt: null,
  };
  const html = renderGitAnalyzeHtml(report, { environment: { agentifyOnPath: false, hasConfig: false, providers: [] } });
  assert.match(html, /The real Jira summary/, "the Jira title must remain visible even when narration replaces the heading");
});

test("a legitimate project sharing a standards-like prefix still classifies (PEP, IEC, JSR)", () => {
  for (const key of ["PEP-8", "IEC-61508", "JSR-330"]) {
    const info = classifyIssueKey(key);
    assert.ok(info && info.kind === "jira", `${key} should classify as a Jira key so --jira-project can opt it in`);
  }
});

test("a fixed cache clock (params.now) does not starve the live request budget", async () => {
  const http = mockHttp(restOk({ "PROJ-1": "t" }));
  const { env } = await tmpCacheEnv();
  const result = await resolveTracker({
    keys: ["PROJ-1"],
    mode: "rest",
    env: { ...env, ...REST_ENV },
    cache: false,
    now: 0,
    deps: { httpRequest: http.fn },
  });
  assert.equal(http.calls.length, 1, "a fixed now must not make every request instantly time-expired");
  assert.equal(result.entries["PROJ-1"].resolved, true);
  assert.ok(!result.limitations.some((l) => /time limit/.test(l)));
});

test("the Jira cache is scoped by base-URL path, not host alone", async () => {
  const { dir } = await tmpCacheEnv();
  const base = { XDG_CACHE_HOME: dir, JIRA_EMAIL: "m@e.co", JIRA_API_TOKEN: "t" };
  const httpA = mockHttp(restOk({ "PROJ-1": "Team A" }));
  const httpB = mockHttp(restOk({ "PROJ-1": "Team B" }));
  const a = await resolveTracker({ keys: ["PROJ-1"], mode: "rest", env: { ...base, JIRA_BASE_URL: "https://jira.example.com/team-a" }, deps: { httpRequest: httpA.fn } });
  const b = await resolveTracker({ keys: ["PROJ-1"], mode: "rest", env: { ...base, JIRA_BASE_URL: "https://jira.example.com/team-b" }, deps: { httpRequest: httpB.fn } });
  assert.equal(a.entries["PROJ-1"].title, "Team A");
  assert.equal(b.entries["PROJ-1"].title, "Team B", "different deployment paths on one host must not share cache");
  await fs.rm(dir, { recursive: true, force: true });
});

test("the GitHub disclosure names the host and key count", async () => {
  const { env } = await tmpCacheEnv();
  const disclosed = [];
  const exec = async (command, args) => {
    if (command === "gh" && args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
    if (command === "gh" && args[0] === "issue") return { code: 0, stdout: JSON.stringify({ number: 1, title: "x", state: "OPEN", url: "https://github.com/o/r/issues/1" }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  await resolveTracker({
    keys: ["#1", "#2"],
    mode: "auto",
    env: { ...env, JIRA_BASE_URL: "" },
    cache: false,
    deps: { exec, hasBinary: async (n) => n === "gh" },
    disclose: (lines) => disclosed.push(...lines),
  });
  const gh = disclosed.find((l) => /GitHub/.test(l));
  assert.ok(gh, "a GitHub disclosure line is required");
  assert.match(gh, /github\.com/);
  assert.match(gh, /\b2\b/);
});

test("Markdown escapes untrusted tracker titles (no raw HTML / link injection)", () => {
  const report = fixtureReport(["PROJ-1"]);
  for (const theme of report.summary.themes) {
    if (theme.key === "PROJ-1") theme.issue_keys = ["PROJ-1", "PROJ-2"];
  }
  const tracker = {
    schema: TRACKER_SCHEMA,
    entries: {
      "PROJ-1": { key: "PROJ-1", resolved: true, title: "<img src=x onerror=alert(1)>", status: "Done", type: "Story", url: "https://x/browse/PROJ-1", source: "rest" },
      "PROJ-2": { key: "PROJ-2", resolved: true, title: "[click](http://evil)", status: "Open", type: "Task", url: "https://x/browse/PROJ-2", source: "rest" },
    },
    limitations: [],
  };
  applyTrackerTitles(report.summary, tracker);
  const md = renderMarkdown(report);
  assert.ok(!md.includes("<img src=x onerror=alert(1)>"), "raw HTML survived into Markdown");
  assert.ok(!md.includes("[click](http://evil)"), "a raw Markdown link survived");
  assert.match(md, /PROJ-1/);
});

test("gh probe and disclosure are scoped to the repository's GitHub host", async () => {
  const { env } = await tmpCacheEnv();
  const authArgs = [];
  const disclosed = [];
  const exec = async (command, args) => {
    if (command === "gh" && args[0] === "auth") { authArgs.push(args); return { code: 0, stdout: "", stderr: "" }; }
    if (command === "gh" && args[0] === "issue") return { code: 0, stdout: JSON.stringify({ number: 1, title: "x", state: "OPEN", url: "https://ghe.example.com/o/r/issues/1" }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  await resolveTracker({
    keys: ["#1"],
    mode: "auto",
    githubHost: "ghe.example.com",
    env: { ...env, JIRA_BASE_URL: "" },
    cache: false,
    deps: { exec, hasBinary: async (n) => n === "gh" },
    disclose: (lines) => disclosed.push(...lines),
  });
  assert.deepEqual(authArgs[0], ["auth", "status", "--hostname", "ghe.example.com"]);
  assert.ok(disclosed.some((l) => /ghe\.example\.com/.test(l)), "disclosure must name the repo's GitHub host");
});

test("applyTrackerTitles stamps the summary with the tracker schema", () => {
  const report = fixtureReport(["PROJ-1"]);
  applyTrackerTitles(report.summary, { schema: TRACKER_SCHEMA, entries: {}, limitations: [] });
  assert.equal(report.summary.tracker_schema, TRACKER_SCHEMA);
});

test("terminal control sequences in a tracker title are stripped from text and md", () => {
  const ESC = String.fromCharCode(27);
  const report = fixtureReport(["PROJ-1"]);
  const tracker = { schema: TRACKER_SCHEMA, entries: { "PROJ-1": { key: "PROJ-1", resolved: true, title: `safe${ESC}[2Jforged`, status: "Done", type: "Story", url: "https://x/browse/PROJ-1", source: "rest" } }, limitations: [] };
  applyTrackerTitles(report.summary, tracker);
  const text = renderText(report);
  const md = renderMarkdown(report);
  assert.ok(!text.includes(ESC), "an ESC byte survived into the text render");
  assert.ok(!md.includes(ESC), "an ESC byte survived into the markdown render");
  assert.match(text, /safe.*forged/);
});

test("--jira rest with a non-https base URL fails with an https-specific message", async () => {
  await assert.rejects(
    () => resolveTracker({ keys: ["PROJ-1"], mode: "rest", env: { JIRA_BASE_URL: "http://jira.internal", JIRA_EMAIL: "a@b.co", JIRA_API_TOKEN: "t" }, deps: { httpRequest: mockHttp(() => ({})).fn } }),
    /https:\/\/ URL/,
  );
});

test("auto with a non-https base URL falls back to acli rather than a dead REST tier", async () => {
  const { env } = await tmpCacheEnv();
  const exec = async (command, args) => {
    if (command === "acli" && args[0] === "jira") return { code: 0, stdout: JSON.stringify({ fields: { summary: "Via acli", status: { name: "Open" }, issuetype: { name: "Task" } } }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await resolveTracker({
    keys: ["PROJ-1"],
    mode: "auto",
    env: { ...env, JIRA_BASE_URL: "http://jira.internal", JIRA_EMAIL: "a@b.co", JIRA_API_TOKEN: "t" },
    cache: false,
    deps: { exec, hasBinary: async (n) => n === "acli" },
  });
  assert.deepEqual(result.tiers_attempted, ["acli"]);
  assert.equal(result.entries["PROJ-1"].title, "Via acli");
});

test("a REST 429 stops the tier instead of firing the remaining batches", async () => {
  const keys = Array.from({ length: 60 }, (_, i) => `PROJ-${i + 1}`);
  const http = mockHttp(() => ({ statusCode: 429, body: "slow down" }));
  const { env } = await tmpCacheEnv();
  const result = await resolveTracker({ keys, mode: "rest", env: { ...env, ...REST_ENV }, cache: false, deps: { httpRequest: http.fn } });
  assert.equal(http.calls.length, 1, "a 429 must halt the tier, not trigger the second batch");
  assert.equal(result.entries["PROJ-1"].reason, "rate_limited");
  assert.equal(result.entries["PROJ-60"].reason, "rate_limited");
});

test("the GitHub cache is partitioned by authenticated account", async () => {
  const { dir, env } = await tmpCacheEnv();
  const makeExec = (account, title) => async (command, args) => {
    if (command === "gh" && args[0] === "auth") return { code: 0, stdout: `Logged in to github.com account ${account}`, stderr: "" };
    if (command === "gh" && args[0] === "issue") return { code: 0, stdout: JSON.stringify({ number: 7, title, state: "OPEN", url: "https://github.com/o/r/issues/7" }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const base = { keys: ["#7"], mode: "auto", env: { ...env, JIRA_BASE_URL: "" }, ghScope: "https://github.com/o/r" };
  const a = await resolveTracker({ ...base, deps: { exec: makeExec("alice", "Alice sees this"), hasBinary: async (n) => n === "gh" } });
  const b = await resolveTracker({ ...base, deps: { exec: makeExec("bob", "Bob sees this"), hasBinary: async (n) => n === "gh" } });
  assert.equal(a.entries["#7"].title, "Alice sees this");
  assert.equal(b.entries["#7"].title, "Bob sees this", "a different gh account must not reuse the first account's cached title");
  await fs.rm(dir, { recursive: true, force: true });
});

test("a transient acli failure is reported as unavailable, not not_found, and noted", async () => {
  const { env } = await tmpCacheEnv();
  const exec = async (command, args) => {
    if (command === "acli" && args[0] === "jira") return { code: 124, stdout: "", stderr: "timed out" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await resolveTracker({ keys: ["PROJ-1"], mode: "acli", env, cache: false, deps: { exec, hasBinary: async () => true } });
  assert.equal(result.entries["PROJ-1"].resolved, false);
  assert.equal(result.entries["PROJ-1"].reason, "unavailable");
  assert.ok(result.limitations.some((l) => /transiently/.test(l)));
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
