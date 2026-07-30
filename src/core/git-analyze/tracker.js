// Optional tracker enrichment for `agentify git analyze` (#355).
//
// A theme keyed on `PROJ-1481` or `#336` is grouped correctly but labelled
// poorly: the ticket's TITLE is what makes a summary readable. This module
// resolves already-parsed issue keys (#349) to titles/status/type, and it is
// the ONLY part of the whole command that ever reaches a network — so it is:
//
//   - OFF by default. `--jira` absent (or `off`) makes zero network requests
//     and the report still groups by key exactly as before.
//   - TIERED, degrading cleanly:
//       tier 0 (offline, always applied when enrichment is on): the parsed key
//         plus a `browse` link when a Jira base URL is configured. No network.
//       acli:  `acli jira workitem view <KEY> --json` when the Atlassian CLI is
//         present and already authenticated.
//       rest:  batched JQL `key in (...)` against JIRA_BASE_URL + JIRA_EMAIL +
//         JIRA_API_TOKEN read from the environment at call time.
//       gh:    GitHub `#NNN` titles via `gh issue view <n> --json ...` when `gh`
//         is present and authenticated.
//   - CACHED outside every analysed repository, with a TTL, so re-running a
//     quarter costs zero requests.
//   - BOUNDED: a request budget and a wall-clock cap; on exhaustion it
//     continues with tier 0 and says so.
//   - CREDENTIAL-SAFE: JIRA_API_TOKEN is read from the environment at call time
//     and used only in an Authorization header. It is NEVER written to a report,
//     a cache file, a log line, or an error message. The cache filename is a
//     hash so no key or URL leaks through a directory listing either.
//
// The HTTP and process layers are injected (`deps.httpRequest`, `deps.exec`,
// `deps.hasBinary`), so the test suite exercises every path — success, 404, 401,
// 429, timeout, partial batch, warm cache — with no live network.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { classifyIssueKey } from "./parse.js";
import { writePrivateJson } from "../fs.js";

// Versioned machine contract for the `report.tracker` block. Bump on any
// breaking change to that shape.
export const TRACKER_SCHEMA = "git-analyze-tracker-v1";

export const TRACKER_MODES = ["off", "auto", "acli", "rest"];

// Bounds on the network. A batch is one HTTP request per <=50 keys (REST); acli
// and gh are one process per key. The request budget caps BOTH so a pathological
// key count can never fan out without limit, and the deadline stops a slow tier
// mid-run. On either bound the remaining keys stay tier 0 with a stated note.
export const REST_BATCH_SIZE = 50;
export const DEFAULT_MAX_REQUESTS = 50;
export const DEFAULT_DEADLINE_MS = 10000;
// Per-request timeout for a single HTTP call or child process.
export const DEFAULT_REQUEST_TIMEOUT_MS = 8000;
// Cache freshness: a resolved title is stable enough that a day-old copy is
// worth far more than a repeat request.
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// The three environment variables the REST tier needs, named in one place so
// the "not configured" error can list exactly them.
export const REST_ENV_VARS = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"];

// ---------------------------------------------------------------------------
// Key collection (pure).
// ---------------------------------------------------------------------------

/**
 * Collect the distinct issue keys worth resolving from a deterministic summary.
 * A theme's primary key (when it is issue-keyed) matters most for labelling, but
 * every key any theme cites is collected so a non-issue theme's `issue_keys` tag
 * can be annotated too. Order is stable (first-seen across sorted themes) so a
 * batch is deterministic.
 *
 * @param {object} summary - the `git-analyze-v1` summary
 * @returns {string[]}
 */
export function collectIssueKeys(summary) {
  const keys = [];
  const seen = new Set();
  const add = (key) => {
    const value = String(key || "").trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      keys.push(value);
    }
  };
  for (const theme of summary?.themes || []) {
    if (theme.key_kind === "issue" && theme.key) add(theme.key);
    for (const key of theme.issue_keys || []) add(key);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Cache (outside every analysed repository).
// ---------------------------------------------------------------------------

/**
 * The tracker cache directory: `<cache>/agentify/git-analyze/tracker`. Honours
 * XDG_CACHE_HOME only when it is ABSOLUTE (a relative value would resolve
 * against the process cwd — i.e. inside the repository being analysed, which the
 * epic forbids), matching the convention in html.js.
 *
 * @param {object} [env]
 * @returns {string}
 */
export function trackerCacheDir(env = process.env) {
  const configured = typeof env.XDG_CACHE_HOME === "string" ? env.XDG_CACHE_HOME.trim() : "";
  const cacheHome = configured.length > 0 && path.isAbsolute(configured)
    ? configured
    : path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "agentify", "git-analyze", "tracker");
}

// A filesystem-safe, leak-free cache filename. The scope (base URL / remote /
// "github") plus the key is hashed, so neither the URL nor the key appears in a
// directory listing, and two Jira sites never collide on a shared key.
function cacheFileName(scope, key) {
  const hash = crypto.createHash("sha256").update(`${scope} ${key}`).digest("hex").slice(0, 32);
  return `${hash}.json`;
}

async function readCacheEntry(dir, scope, key, { ttlMs, now }) {
  try {
    const file = path.join(dir, cacheFileName(scope, key));
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.fetched_at !== "number") return null;
    if (now - parsed.fetched_at > ttlMs) return null;
    if (!parsed.entry || parsed.entry.key !== key) return null;
    return parsed.entry;
  } catch {
    return null;
  }
}

async function writeCacheEntry(dir, scope, entry, { now }) {
  try {
    const file = path.join(dir, cacheFileName(scope, entry.key));
    // Cached issue titles can be private, so the cache dir/file are created
    // owner-only (0700/0600) via the shared private-fs helpers. Only the resolved
    // facts are persisted — never a credential, the Authorization header, or the
    // raw provider response.
    await writePrivateJson(file, { v: 1, fetched_at: now, entry });
  } catch {
    // A cache write is best-effort: a read-only or full cache dir must not fail
    // the run. The resolution still stands for this run; the next run re-fetches.
  }
}

// ---------------------------------------------------------------------------
// Default HTTP + process layers (injected in tests, never exercised there).
// ---------------------------------------------------------------------------

// A single HTTPS request. Returns `{ statusCode, body }` and never throws — a
// transport error is surfaced as statusCode 0 so the caller degrades per key
// rather than crashing the command. The Authorization header travels here and
// nowhere else.
function defaultHttpRequest({ method = "GET", url, headers = {}, body = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    import("node:https").then(({ request }) => {
      let settled = false;
      const done = (result) => { if (!settled) { settled = true; resolve(result); } };
      let target;
      try {
        target = new URL(url);
      } catch {
        done({ statusCode: 0, body: "" });
        return;
      }
      if (target.protocol !== "https:") {
        // The credential-bearing REST tier must never travel in cleartext.
        done({ statusCode: 0, body: "" });
        return;
      }
      // An ABSOLUTE deadline (not `setTimeout`, which only fires on inactivity):
      // a server trickling bytes must not keep the run alive past the wall-clock
      // cap. The response body is also capped so a giant payload cannot exhaust
      // memory — both are hard bounds the feature promises.
      const MAX_BODY_BYTES = 5 * 1024 * 1024;
      const deadline = setTimeout(() => { req.destroy(); done({ statusCode: 0, body: "" }); }, timeoutMs);
      const req = request(target, { method, headers }, (res) => {
        let data = "";
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) { req.destroy(); clearTimeout(deadline); done({ statusCode: 0, body: "" }); return; }
          data += chunk;
        });
        res.on("end", () => { clearTimeout(deadline); done({ statusCode: res.statusCode || 0, body: data }); });
      });
      req.on("error", () => { clearTimeout(deadline); done({ statusCode: 0, body: "" }); });
      if (body) req.write(body);
      req.end();
    }).catch(() => resolve({ statusCode: 0, body: "" }));
  });
}

// A single child process (acli / gh / auth probes). Returns `{ code, stdout,
// stderr }` and never throws. stdin is closed; the Jira REST configuration is
// STRIPPED from the child's environment — the token AND the base URL (which may
// itself embed `user:pass@host` userinfo) and the email. `which`, `acli`, and
// `gh` never need any of them (acli authenticates via its own config), so a
// PATH-hijacked helper cannot read a credential the REST tier holds.
function scrubbedEnv(env = process.env) {
  const copy = { ...env };
  for (const name of REST_ENV_VARS) delete copy[name];
  return copy;
}

function defaultExec(command, args, { cwd, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    import("node:child_process").then(({ spawn }) => {
      const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: scrubbedEnv() });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (result) => { if (!settled) { settled = true; resolve(result); } };
      const timer = setTimeout(() => { child.kill("SIGKILL"); done({ code: 124, stdout, stderr: `${stderr}\ntimed out` }); }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(timer); done({ code: 127, stdout, stderr: `${stderr}\n${error.message}`.trim() }); });
      child.on("close", (code) => { clearTimeout(timer); done({ code: code ?? 1, stdout, stderr }); });
    }).catch((error) => resolve({ code: 127, stdout: "", stderr: String(error?.message || error) }));
  });
}

async function defaultHasBinary(name, exec) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = await exec(probe, [name], {});
  return result.code === 0;
}

// ---------------------------------------------------------------------------
// Environment / tier detection.
// ---------------------------------------------------------------------------

// The base URL for tier-0 browse links and the REST tier. Any embedded userinfo
// (`https://user:pass@host`) is STRIPPED so a credential smuggled into
// JIRA_BASE_URL can never reach a report, a browse link, or the cache — the
// value is rebuilt from safe scheme/host/path components only. Returns "" when
// the value is not a usable http(s) URL. The REST tier still authenticates with
// JIRA_EMAIL/JIRA_API_TOKEN, so dropping URL userinfo costs nothing.
function jiraBaseUrl(env) {
  const raw = typeof env.JIRA_BASE_URL === "string" ? env.JIRA_BASE_URL.trim() : "";
  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

// A short, non-secret hash of the Jira account (email), for cache scoping so one
// account's cached titles are never served to another. The email is hashed (not
// stored) and never a credential; this is only a cache-partition key.
function accountHash(env) {
  const email = typeof env.JIRA_EMAIL === "string" ? env.JIRA_EMAIL.trim().toLowerCase() : "";
  return crypto.createHash("sha256").update(email).digest("hex").slice(0, 12);
}

// REST is "configured" only when all three vars are set AND the base URL is a
// usable https:// URL — the tier sends Basic credentials, so a cleartext http
// URL (or a malformed one) is not usable and must not masquerade as configured
// (which would make every key look transiently unavailable, and block acli
// fallback under auto).
function restEnvConfigured(env) {
  const allSet = REST_ENV_VARS.every((name) => typeof env[name] === "string" && env[name].trim().length > 0);
  return allSet && jiraBaseUrl(env).startsWith("https://");
}

function missingRestEnv(env) {
  return REST_ENV_VARS.filter((name) => !(typeof env[name] === "string" && env[name].trim().length > 0));
}

// ---------------------------------------------------------------------------
// Provider parsers (pure; hostile-input safe).
// ---------------------------------------------------------------------------

// Normalise an acli `jira workitem view --json` payload to the fields we keep.
// acli shapes vary; probe the common ones and never throw on an unexpected body.
function parseAcliIssue(json, key) {
  const fields = json?.fields || json || {};
  const title = json?.summary || fields.summary || json?.title || null;
  const status = fields?.status?.name || json?.status?.name || json?.status || null;
  const type = fields?.issuetype?.name || json?.issuetype?.name || json?.type || null;
  if (!title) return null;
  // acli authenticates to its OWN site, which may differ from JIRA_BASE_URL, so a
  // browse link is taken only from acli's payload (never synthesised from the
  // env base URL); a bare http(s) link is kept, anything else dropped.
  const rawUrl = json?.url || fields?.url || json?.self || null;
  const url = httpLink(rawUrl);
  return { key, title: String(title), status: status ? String(status) : null, type: type ? String(type) : null, url };
}

// Return a URL only when it is http(s); otherwise null. Keeps a synthesised or
// hostile link out of the resolved entry.
function httpLink(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") ? raw : null;
  } catch {
    return null;
  }
}

// Normalise a Jira REST v3 search issue object.
function parseRestIssue(issue) {
  const fields = issue?.fields || {};
  const title = fields.summary || null;
  if (!title) return null;
  return {
    key: issue.key,
    title: String(title),
    status: fields?.status?.name ? String(fields.status.name) : null,
    type: fields?.issuetype?.name ? String(fields.issuetype.name) : null,
  };
}

// ---------------------------------------------------------------------------
// Resolution result shape.
// ---------------------------------------------------------------------------

function resolvedEntry({ key, title, status, type, url, source }) {
  return { key, resolved: true, title, status: status || null, type: type || null, url: url || null, source };
}

function unresolvedEntry({ key, reason, url = null, source = "offline" }) {
  return { key, resolved: false, reason, url, source, title: null, status: null, type: null };
}

// ---------------------------------------------------------------------------
// The tiers.
// ---------------------------------------------------------------------------

// One acli lookup per key. A missing title (404-shaped) annotates the key; an
// auth failure disables the whole tier for the run.
async function resolveViaAcli(keys, ctx) {
  const { exec, budget } = ctx;
  for (const key of keys) {
    // Skip only keys ALREADY RESOLVED (by cache or a prior tier); an unresolved
    // placeholder from a prior tier is fair game to retry here.
    if (ctx.entries.get(key)?.resolved) continue;
    if (!budget.canSpend()) { ctx.exhausted = true; break; }
    // acli results are NOT cached: acli authenticates to its own site
    // independently of JIRA_BASE_URL, and that site is not something this process
    // can verify, so a cached `PROJ-1` could silently belong to a different
    // tenant after an `acli` re-login. acli is a fast local CLI, so re-invoking
    // it each run is a safe trade for never serving another tenant's title.
    budget.spend();
    ctx.requests += 1;
    const result = await exec("acli", ["jira", "workitem", "view", key, "--json"], { cwd: ctx.cwd, timeoutMs: ctx.requestTimeout() });
    if (result.code !== 0) {
      const kind = classifyCliFailure(result.code, result.stderr);
      if (kind === "auth") {
        ctx.disableTier("acli", "the Atlassian CLI is not authenticated (run `acli jira auth login`)");
        break;
      }
      if (kind === "transient") ctx.softErrors += 1;
      ctx.entries.set(key, unresolvedEntry({ key, reason: kind === "transient" ? "unavailable" : kind, source: "acli" }));
      continue;
    }
    let parsed = null;
    try { parsed = parseAcliIssue(JSON.parse(result.stdout), key); } catch { parsed = null; }
    const entry = parsed
      ? resolvedEntry({ key, title: parsed.title, status: parsed.status, type: parsed.type, url: parsed.url, source: "acli" })
      : unresolvedEntry({ key, reason: "unparseable", source: "acli" });
    ctx.entries.set(key, entry);
  }
}

// Batched REST. One request per <=50 keys via JQL `key in (...)`. Keys present
// in the response resolve; keys absent from a successful batch are 404-shaped
// (reported unresolved). A 401/403 disables the tier; a 429/5xx/timeout on a
// batch leaves that batch's keys unresolved and continues.
async function resolveViaRest(keys, ctx) {
  const { httpRequest, budget, cacheDir, cache, env } = ctx;
  const auth = "Basic " + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64");

  const pending = [];
  for (const key of keys) {
    if (ctx.entries.get(key)?.resolved) continue;
    const cached = await maybeCached(ctx, ctx.jiraScope, key);
    if (cached) { ctx.entries.set(key, cached); continue; }
    pending.push(key);
  }

  for (let i = 0; i < pending.length; i += REST_BATCH_SIZE) {
    if (!budget.canSpend()) { ctx.exhausted = true; break; }
    const batch = pending.slice(i, i + REST_BATCH_SIZE);
    const jql = `key in (${batch.join(",")})`;
    const bodyObj = { jql, fields: ["summary", "status", "issuetype"], maxResults: REST_BATCH_SIZE };
    budget.spend();
    ctx.requests += 1;
    const result = await httpRequest({
      method: "POST",
      url: `${ctx.baseUrl}/rest/api/3/search/jql`,
      headers: {
        // The credential lives here, at call time, and nowhere else.
        Authorization: auth,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyObj),
      timeoutMs: ctx.requestTimeout(),
    });
    if (result.statusCode === 401 || result.statusCode === 403) {
      ctx.disableTier("rest", "the Jira credentials were rejected (check JIRA_EMAIL / JIRA_API_TOKEN)");
      break;
    }
    if (result.statusCode === 429) {
      // A rate limit STOPS the REST tier: firing the remaining batches
      // immediately would only deepen the throttling. This batch's keys and every
      // still-pending key are left unresolved (with a browse link); tier-0
      // backfill covers anything not yet in the map.
      for (const key of pending.slice(i)) {
        if (!ctx.entries.has(key)) {
          ctx.entries.set(key, unresolvedEntry({ key, reason: "rate_limited", source: "rest", url: `${ctx.baseUrl}/browse/${key}` }));
        }
      }
      ctx.softErrors += 1;
      break;
    }
    if (result.statusCode !== 200) {
      // 5xx / transport error (0) / timeout: leave this batch unresolved and keep
      // going — a single failed batch must not fail the run.
      for (const key of batch) {
        ctx.entries.set(key, unresolvedEntry({ key, reason: "unavailable", source: "rest", url: `${ctx.baseUrl}/browse/${key}` }));
      }
      ctx.softErrors += 1;
      continue;
    }
    // A 200 with an unparseable or structurally-wrong body is a TRANSIENT fault,
    // not a definitive "these keys do not exist": it must not poison the negative
    // cache, and a non-array `issues` must never throw (fail-soft contract).
    let payload = null;
    try { payload = JSON.parse(result.body); } catch { payload = null; }
    if (!payload || !Array.isArray(payload.issues)) {
      for (const key of batch) {
        ctx.entries.set(key, unresolvedEntry({ key, reason: "unavailable", source: "rest", url: `${ctx.baseUrl}/browse/${key}` }));
      }
      ctx.softErrors += 1;
      continue;
    }
    const byKey = new Map();
    for (const issue of payload.issues) {
      const parsed = parseRestIssue(issue);
      if (parsed) byKey.set(parsed.key, parsed);
    }
    for (const key of batch) {
      const parsed = byKey.get(key);
      const entry = parsed
        ? resolvedEntry({ ...parsed, url: `${ctx.baseUrl}/browse/${key}`, source: "rest" })
        : unresolvedEntry({ key, reason: "not_found", source: "rest", url: `${ctx.baseUrl}/browse/${key}` });
      ctx.entries.set(key, entry);
      // A resolved title and a DEFINITIVE 404 (absent from a 200 batch) are both
      // stable and cached, so re-running a quarter costs zero requests; transient
      // failures above are never cached (they never reach this branch).
      if (cache) await writeCacheEntry(cacheDir, ctx.jiraScope, entry, ctx);
    }
  }
}

// One `gh issue view` per GitHub key. gh operates in the repository's own
// context; the cache is scoped to the repository remote AND the authenticated
// gh account (ctx.ghScope, set after the auth probe), so switching accounts —
// or losing access — never surfaces another account's cached private title. The
// cache is READ here (after the auth probe), not prefilled before it.
async function resolveViaGh(keys, ctx) {
  const { exec, budget, cacheDir, cache } = ctx;
  for (const key of keys) {
    if (ctx.entries.get(key)?.resolved) continue;
    const number = key.replace(/^#/, "");
    const cached = await maybeCached(ctx, ctx.ghScope, key);
    if (cached) { ctx.entries.set(key, cached); continue; }
    if (!budget.canSpend()) { ctx.exhausted = true; break; }
    budget.spend();
    ctx.requests += 1;
    const result = await exec("gh", ["issue", "view", number, "--json", "number,title,state,url"], { cwd: ctx.cwd, timeoutMs: ctx.requestTimeout() });
    if (result.code !== 0) {
      const kind = classifyCliFailure(result.code, result.stderr);
      if (kind === "auth") {
        ctx.disableTier("gh", "the GitHub CLI is not authenticated (run `gh auth login`)");
        break;
      }
      if (kind === "transient") ctx.softErrors += 1;
      ctx.entries.set(key, unresolvedEntry({ key, reason: kind === "transient" ? "unavailable" : kind, source: "gh" }));
      continue;
    }
    let parsed = null;
    try {
      const json = JSON.parse(result.stdout);
      if (json && json.title) {
        parsed = { title: String(json.title), status: json.state ? String(json.state) : null, url: json.url ? String(json.url) : null };
      }
    } catch { parsed = null; }
    const entry = parsed
      ? resolvedEntry({ key, title: parsed.title, status: parsed.status, type: "issue", url: parsed.url, source: "gh" })
      : unresolvedEntry({ key, reason: "unparseable", source: "gh" });
    ctx.entries.set(key, entry);
    // Only cache a resolved title. A `gh` non-zero exit can be a transient
    // network error as easily as a real 404, so it is never persisted.
    if (cache && entry.resolved) await writeCacheEntry(cacheDir, ctx.ghScope, entry, ctx);
  }
}

async function maybeCached(ctx, scope, key) {
  if (!ctx.cache) return null;
  const entry = await readCacheEntry(ctx.cacheDir, scope, key, ctx);
  if (entry) ctx.cacheHits += 1;
  return entry;
}

// The authenticated GitHub login from `gh auth status` output (which gh writes
// to stdout or stderr depending on version). Handles both "account <login>" and
// the older "as <login>" phrasings; returns "unknown" when unparseable, which
// still partitions the cache away from a differently-parseable account.
function parseGhAccount(stdout, stderr) {
  const text = `${stdout || ""}\n${stderr || ""}`;
  const m = /\baccount\s+([A-Za-z0-9-]+)/i.exec(text) || /\bas\s+([A-Za-z0-9-]+)/i.exec(text);
  return m ? m[1].toLowerCase() : "unknown";
}

// Classify a CLI (acli/gh) failure from its exit code and stderr:
//   "auth"      — a credential problem; disables the whole tier for the run.
//   "not_found" — the issue genuinely does not exist / is inaccessible; per-key,
//                 cacheable, definitive.
//   "transient" — a timeout, spawn error, DNS/network failure, or server error;
//                 per-key, NOT cacheable, and surfaced as a transient limitation.
// A timeout (code 124) or a spawn failure (127) is never a "not found"; and a
// DNS error ("no such host") is transient, not an auth problem.
function classifyCliFailure(code, stderr) {
  const text = String(stderr || "").toLowerCase();
  if (/\b(401|403)\b/.test(text) || /not logged|authenticat|unauthor|login required|gh auth login|acli .*auth/.test(text)) {
    return "auth";
  }
  if (code === 124 || code === 127 || /timed out|no such host|could not resolve host|econn|etimedout|network|dial tcp|\b5\d\d\b/.test(text)) {
    return "transient";
  }
  if (/\b404\b|not found|could not resolve to|does not exist|no (such )?issue/.test(text)) {
    return "not_found";
  }
  // An unclassifiable non-zero exit is treated as transient (safer than caching a
  // wrong "not found"): it is reported without a title and not persisted.
  return "transient";
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

/**
 * Resolve a set of issue keys to titles per the requested tier. Off/absent does
 * nothing and touches no network. Everything is bounded, cached, and fail-soft.
 *
 * @param {object} params
 * @param {string[]} params.keys - candidate keys (from collectIssueKeys)
 * @param {string} [params.mode] - "off" | "auto" | "acli" | "rest"
 * @param {string[]} [params.projects] - project allowlist (--jira-project); when
 *   non-empty, only Jira keys with a listed project are looked up. GitHub keys
 *   are unaffected.
 * @param {string} [params.cwd] - repository dir for acli/gh process context
 * @param {string} [params.ghScope] - cache scope for GitHub keys (repo remote/path)
 * @param {object} [params.env] - environment (defaults to process.env)
 * @param {boolean} [params.cache] - use the on-disk cache (default true)
 * @param {object} [params.deps] - injected { httpRequest, exec, hasBinary }
 * @param {number} [params.maxRequests] / [params.deadlineMs] / [params.ttlMs] / [params.now]
 * @returns {Promise<object|null>} the `report.tracker` block, or null when off
 */
export async function resolveTracker(params = {}) {
  const mode = normalizeMode(params.mode);
  const env = params.env || process.env;
  const now = Number.isFinite(params.now) ? params.now : Date.now();

  if (mode === "off") return null;

  const exec = params.deps?.exec || defaultExec;
  const httpRequest = params.deps?.httpRequest || defaultHttpRequest;
  const hasBinary = params.deps?.hasBinary || ((name) => defaultHasBinary(name, exec));

  const projects = (params.projects || []).map((value) => String(value).trim().toUpperCase()).filter(Boolean);
  const baseUrl = jiraBaseUrl(env);

  // Split candidate keys into GitHub `#NNN` and Jira `PROJ-123`. A project
  // allowlist filters Jira keys to look UP (unlisted keys stay tier 0, reported
  // but never queried) — it never drops a key from clustering, which already
  // happened upstream.
  const githubKeys = [];
  const jiraKeys = [];
  const skippedByAllowlist = [];
  for (const key of params.keys || []) {
    const info = classifyIssueKey(key);
    if (!info) continue;
    if (info.kind === "github") {
      githubKeys.push(key);
    } else if (info.kind === "jira") {
      if (projects.length > 0 && !projects.includes(info.project)) {
        skippedByAllowlist.push(key);
        continue;
      }
      jiraKeys.push(key);
    }
  }

  const limitations = [];
  const disclosures = [];
  const disabledTiers = [];

  // The budget's wall clock is the REAL Date.now(), independent of `params.now`
  // (which anchors only cache TTL, and may be a fixed value in tests) — otherwise
  // a fixed `now` would make every request instantly past the deadline.
  const budget = makeBudget(Number.isFinite(params.maxRequests) ? params.maxRequests : DEFAULT_MAX_REQUESTS, Date.now(), Number.isFinite(params.deadlineMs) ? params.deadlineMs : DEFAULT_DEADLINE_MS);

  const ctx = {
    entries: new Map(),
    requests: 0,
    cacheHits: 0,
    softErrors: 0,
    exhausted: false,
    budget,
    baseUrl,
    env,
    cwd: params.cwd || process.cwd(),
    // GitHub `#NNN` is repository-relative, so its cache scope is the repo. Jira
    // keys are global to a SITE, so their scope is the base-URL host — never the
    // bare tier name, or `PROJ-1` on site B would reuse site A's cached title.
    ghScope: params.ghScope ? `github:${params.ghScope}` : "github",
    // REST is scoped to its full base URL (host AND path — one host can serve
    // `/team-a` and `/team-b` as separate Jira deployments) plus a non-secret
    // hash of the account (JIRA_EMAIL): two accounts on one tenant can have
    // different issue visibility, so a title (or a `not_found`) cached under one
    // account must not be served to another. acli is not cached at all (its site
    // is not verifiable here), so it needs no scope.
    jiraScope: `jira:${baseUrl || "local"}:${accountHash(env)}`,
    cache: params.cache !== false,
    cacheDir: trackerCacheDir(env),
    requestTimeoutMs: Number.isFinite(params.requestTimeoutMs) ? params.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS,
    ttlMs: Number.isFinite(params.ttlMs) ? params.ttlMs : DEFAULT_TTL_MS,
    now,
    exec,
    httpRequest,
    // Clamp a single request's timeout to the time left before the wall-clock
    // deadline, so the whole run cannot overrun the deadline by a full timeout.
    requestTimeout() { return Math.min(this.requestTimeoutMs, Math.max(1, budget.remainingMs())); },
    disableTier(tier, why) {
      if (!disabledTiers.includes(tier)) disabledTiers.push(tier);
      limitations.push(`Tracker tier "${tier}" was disabled for this run: ${why}. Affected keys are reported without titles.`);
    },
  };

  // Under --global a `#NNN` is repository-relative, so gh (which reads a single
  // cwd) cannot resolve it correctly across repositories — the caller sets
  // allowGithubTitles=false there. Jira keys are site-global, so they resolve
  // under --global unaffected.
  const allowGithub = params.allowGithubTitles !== false;

  // Decide the ordered Jira tier(s) to attempt.
  const jiraTier = await decideJiraTier({ mode, env, hasBinary });
  if (mode === "rest" && !jiraTier.order.includes("rest")) {
    // The one hard failure in the whole feature: an explicit --jira rest that is
    // not usable is a misconfiguration the user must fix, not something to
    // silently downgrade. Distinguish a missing variable from a non-https base
    // URL so the message is actionable either way.
    const missing = missingRestEnv(env);
    if (missing.length > 0) {
      throw new Error(`git analyze --jira rest needs ${REST_ENV_VARS.join(", ")} in the environment; missing: ${missing.join(", ")}.`);
    }
    // Show a userinfo-STRIPPED form of the URL — the raw value may embed
    // `user:pass@host`, and an error message must never echo a credential.
    const shown = jiraBaseUrl(env) || "(not a valid URL)";
    throw new Error(`git analyze --jira rest needs JIRA_BASE_URL to be an https:// URL (credentials must not travel in cleartext); got "${shown}".`);
  }
  if (mode === "acli" && !jiraTier.order.includes("acli")) {
    limitations.push("git analyze --jira acli found no Atlassian CLI on PATH; Jira titles are unavailable and keys are reported without them.");
  }

  // Warm-cache PREFILL for JIRA only (no network): the REST cache is host+account
  // scoped and written only by REST, so it is trusted only when REST is a
  // configured tier (acli's site may differ from JIRA_BASE_URL, so an acli-only
  // run must not read the REST cache). GitHub is NOT prefilled here: its cache is
  // scoped by the authenticated gh account, which is known only after the auth
  // probe, so a cached private title is never surfaced without confirming the
  // current account still holds access.
  if (ctx.cache && jiraTier.order.includes("rest")) {
    for (const key of jiraKeys) {
      const cached = await readCacheEntry(ctx.cacheDir, ctx.jiraScope, key, ctx);
      if (cached) { ctx.entries.set(key, cached); ctx.cacheHits += 1; }
    }
  }
  const jiraNeedsWork = jiraKeys.some((key) => !ctx.entries.has(key));
  const githubNeedsWork = githubKeys.length > 0;

  // gh PRESENCE is a local `which` (no network) — safe to check before the
  // disclosure. The auth probe (which may contact a host) is deferred until
  // after the disclosure below.
  const ghPresent = allowGithub && githubNeedsWork ? await hasBinary("gh") : false;
  if (!allowGithub && githubKeys.length > 0) {
    limitations.push("GitHub issue titles are not resolved under --global (a #NNN is repository-relative and cannot be resolved from one working directory); Jira keys are still resolved.");
  }

  // Disclosure BEFORE any network, naming host and key count (the #354
  // discipline). Only tiers that will actually make a request are announced — a
  // fully-warm run announces nothing because it reaches no network.
  const jiraHost = hostOf(baseUrl);
  if (jiraNeedsWork) {
    for (const tier of jiraTier.order) {
      if (tier === "rest") {
        disclosures.push(`git analyze --jira: resolving up to ${jiraKeys.length} Jira key(s) via the REST API against ${jiraHost}.`);
      } else if (tier === "acli") {
        // acli authenticates to its OWN selected site, which may not be
        // JIRA_BASE_URL's host — so the disclosure must not claim that host as
        // acli's destination.
        disclosures.push(`git analyze --jira: resolving up to ${jiraKeys.length} Jira key(s) via the local acli CLI (its own configured Jira site).`);
      }
    }
  }
  const githubHost = typeof params.githubHost === "string" && params.githubHost.trim() ? params.githubHost.trim() : "github.com";
  if (ghPresent) {
    const ghCount = githubKeys.filter((key) => !ctx.entries.has(key)).length;
    disclosures.push(`git analyze --jira: resolving ${ghCount} GitHub issue title(s) via the local gh CLI against ${githubHost}.`);
  }
  if (disclosures.length > 0 && typeof params.disclose === "function") {
    params.disclose(disclosures);
  }

  // The gh auth probe runs AFTER disclosure (per its manual it can contact a
  // configured host to test auth state), counts as a network request, and is
  // gated by the SAME budget as every other request.
  let ghAvailable = false;
  if (ghPresent) {
    if (!budget.canSpend()) {
      ctx.exhausted = true;
    } else {
      budget.spend();
      ctx.requests += 1;
      // Scope the auth probe to the repository's own host: an unqualified
      // `gh auth status` checks EVERY configured GitHub host (and can fail
      // because an unrelated GHE host has stale credentials, or contact an
      // undisclosed host).
      const status = await exec("gh", ["auth", "status", "--hostname", githubHost], { cwd: ctx.cwd, timeoutMs: ctx.requestTimeout() });
      ghAvailable = status.code === 0;
      if (ghAvailable) {
        // Qualify the GitHub cache scope with the AUTHENTICATED account (parsed
        // from the probe output), so a warm cache written under one account is
        // never surfaced to another — the parallel of the Jira account scoping.
        const account = parseGhAccount(status.stdout, status.stderr);
        ctx.ghScope = `${ctx.ghScope}:acct:${account}`;
      } else {
        limitations.push("git analyze --jira: the GitHub CLI (gh) is installed but not authenticated (run `gh auth login`); GitHub issue titles are unavailable.");
      }
    }
  }

  // Run the Jira tiers IN ORDER, each over the keys still unresolved — so `auto`
  // falls back from a logged-out acli to configured REST. Each tier is bounded
  // and fail-soft; a disabled tier is skipped rather than retried. `attempted`
  // records the tiers that ACTUALLY ran (not merely the configured order), so
  // the network audit is honest.
  const tiersAttempted = [];
  for (const tier of jiraTier.order) {
    if (!jiraKeys.some((key) => !ctx.entries.get(key)?.resolved)) break;
    if (disabledTiers.includes(tier)) continue;
    tiersAttempted.push(tier);
    if (tier === "acli") await resolveViaAcli(jiraKeys, ctx);
    else if (tier === "rest") await resolveViaRest(jiraKeys, ctx);
  }
  if (ghAvailable && githubKeys.length > 0) {
    await resolveViaGh(githubKeys, ctx);
  }

  // Tier 0 backfill: any key a higher tier did not resolve (offline run, budget
  // stop, disabled tier, 404) and any key skipped by the allowlist still gets a
  // stable entry — with a browse link for Jira when a base URL is configured — so
  // a key is reported, never dropped.
  finalizeTierZero(ctx, jiraKeys, githubKeys, skippedByAllowlist);

  if (ctx.exhausted) {
    limitations.push(`The tracker request budget or ${Math.round((Number.isFinite(params.deadlineMs) ? params.deadlineMs : DEFAULT_DEADLINE_MS) / 1000)}s time limit was reached; remaining keys are reported without titles.`);
  }
  if (ctx.softErrors > 0) {
    limitations.push(`${ctx.softErrors} tracker request(s) failed transiently (rate limit or server error); the affected keys are reported without titles.`);
  }
  // PER-PROVIDER limitations: emit one whenever that provider left keys
  // untitled because it was not configured/authenticated — so a partial setup
  // (e.g. gh works but Jira is unconfigured, or vice versa) is never silent.
  // Explicit acli/rest modes already stated their own limitation above; only add
  // the generic Jira note for `auto` with no Jira tier configured.
  const jiraUntitled = jiraKeys.some((key) => !ctx.entries.get(key)?.resolved);
  const githubUntitled = allowGithub && githubKeys.some((key) => !ctx.entries.get(key)?.resolved);
  if (mode === "auto" && jiraTier.order.length === 0 && jiraKeys.length > 0) {
    limitations.push("git analyze --jira: no Jira tracker is configured (no acli on PATH and no Jira REST env vars); Jira keys are grouped and linked but not titled.");
  }
  if (githubUntitled && !ghAvailable && !disabledTiers.includes("gh")) {
    // gh not present at all (a disabled/unauthenticated gh already stated its own
    // limitation above). Only note when there is genuinely no gh to use.
    limitations.push("git analyze --jira: no authenticated GitHub CLI (gh) is available; GitHub issue titles are not resolved.");
  }
  // A safety net: if, after everything, some keys remain untitled and NOTHING
  // above explained it, say so once rather than leaving an unexplained gap.
  if ((jiraUntitled || githubUntitled) && limitations.length === 0) {
    limitations.push("Some issue keys could not be titled; they are grouped and linked but shown without a tracker title.");
  }

  const entries = {};
  for (const [key, entry] of ctx.entries) entries[key] = entry;

  const resolvedCount = [...ctx.entries.values()].filter((entry) => entry.resolved).length;

  return {
    schema: TRACKER_SCHEMA,
    mode,
    // The primary Jira tier (first attempted), plus whether gh ran. "offline"
    // means tier 0 only (no network for Jira).
    tier: jiraTier.primary,
    tiers_attempted: tiersAttempted,
    github: ghAvailable ? "gh" : (githubKeys.length > 0 ? "offline" : null),
    host: hostOf(baseUrl),
    base_url: baseUrl || null,
    projects,
    requested_keys: (jiraKeys.length + githubKeys.length),
    resolved_keys: resolvedCount,
    network_requests: ctx.requests,
    cache_hits: ctx.cacheHits,
    disabled_tiers: disabledTiers,
    skipped_by_allowlist: skippedByAllowlist,
    entries,
    disclosures,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

export function normalizeMode(raw) {
  if (raw === undefined || raw === null || raw === false) return "off";
  // A bare `--jira` (parsed as boolean true) means "auto" — the friendly
  // default tier that uses whatever is already configured.
  if (raw === true) return "auto";
  const value = String(raw).trim().toLowerCase();
  if (!TRACKER_MODES.includes(value)) {
    throw new Error(`git analyze --jira must be one of: ${TRACKER_MODES.join(", ")} (got "${raw}")`);
  }
  return value;
}

function hostOf(baseUrl) {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

// A request/time budget. `canSpend` gates each request on both the count and the
// wall clock; `spend` decrements the count; `remainingMs` is the time left before
// the deadline, so an individual request's timeout can be clamped to it (a
// request started just before the deadline must not extend the run past it).
function makeBudget(maxRequests, startedAt, deadlineMs) {
  let remaining = Math.max(0, Math.floor(maxRequests));
  const deadline = startedAt + deadlineMs;
  return {
    canSpend() {
      return remaining > 0 && Date.now() < deadline;
    },
    spend() { remaining -= 1; },
    remainingMs() { return Math.max(0, deadline - Date.now()); },
  };
}

// Backfill tier 0 for every key a higher tier did not already set: a browse link
// for Jira when a base URL is configured, and a bare (link-less) placeholder
// otherwise. Runs AFTER the higher tiers so it never clobbers a resolved title.
// Allowlist-skipped keys are Jira keys too, so they get a browse link and are
// reported (with a distinct reason), never silently dropped.
function finalizeTierZero(ctx, jiraKeys, githubKeys, skippedByAllowlist = []) {
  for (const key of jiraKeys) {
    if (!ctx.entries.has(key)) {
      ctx.entries.set(key, unresolvedEntry({ key, reason: "offline", url: ctx.baseUrl ? `${ctx.baseUrl}/browse/${key}` : null }));
    }
  }
  for (const key of skippedByAllowlist) {
    if (!ctx.entries.has(key)) {
      ctx.entries.set(key, unresolvedEntry({ key, reason: "allowlist_skipped", url: ctx.baseUrl ? `${ctx.baseUrl}/browse/${key}` : null }));
    }
  }
  for (const key of githubKeys) {
    if (!ctx.entries.has(key)) {
      ctx.entries.set(key, unresolvedEntry({ key, reason: "offline", url: null }));
    }
  }
}

// The ORDERED list of Jira tiers to attempt. Explicit modes force a single tier.
// `auto` tries acli first (when the binary is present) and falls back to REST
// (when the env is configured) — so an acli that is installed but logged out no
// longer strands keys that valid REST credentials could resolve. `primary` is
// the first tier, reported as `tier` in the result; "offline" when none apply.
async function decideJiraTier({ mode, env, hasBinary }) {
  if (mode === "rest") {
    const order = restEnvConfigured(env) ? ["rest"] : [];
    return { order, primary: order[0] || "offline" };
  }
  if (mode === "acli") {
    const order = (await hasBinary("acli")) ? ["acli"] : [];
    return { order, primary: order[0] || "offline" };
  }
  // auto: pick ONE higher tier. REST is preferred when configured — it is
  // batched (one request per 50 keys, so 50 keys cannot exhaust the budget), its
  // destination host is known and disclosed, and it avoids mixing two sites in
  // one run (acli authenticates to its own, possibly different, site). acli is
  // used only when REST is not configured. This still covers the
  // "acli-present-but-logged-out + REST-configured" case: REST simply resolves.
  if (restEnvConfigured(env)) return { order: ["rest"], primary: "rest" };
  if (await hasBinary("acli")) return { order: ["acli"], primary: "acli" };
  return { order: [], primary: "offline" };
}
