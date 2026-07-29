// Streaming commit collector for `agentify git analyze`.
//
// This module reads git history for one repository and one resolved window and
// produces the frozen commit record shape (see the record built by
// `buildRecord`). It is read-only: `git log` and `git for-each-ref` only, no
// writes, no network, nothing created inside the analysed repository.
//
// Streaming, not buffering, is a correctness requirement: a single buffered
// `git log --numstat` over 200k commits is hundreds of megabytes. We spawn git,
// split its NUL/record-delimited output as chunks arrive, and build bounded
// records incrementally. A `\x01` record marker and `\x1f` field separator are
// used because they cannot appear in a commit message, so a body full of
// quotes, newlines, and stray control bytes cannot corrupt the following record.
//
// The window is half-open `[since, until)`. git's own `--since/--until` filters
// are INCLUSIVE and operate on commit date, so for computed (instant) windows we
// additionally enforce the exclusive author-date bound in JS — see
// `isAuthoredInWindow`.

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

import { redactSensitiveText } from "../redact.js";
import {
  parseConventionalSubject,
  detectBreakingChange,
  extractIssueKeys,
  detectRevert,
} from "./parse.js";

const execFileAsync = promisify(execFile);

// RECORD_SEP marks the start of each `git log` entry's header; FIELD_SEP
// separates the header fields. The authoritative record boundary, though, is the
// NUL byte git emits under `-z`: a commit message can contain any byte EXCEPT
// NUL, so records are framed on NUL-delimited tokens and a header token is
// recognised by its `RECORD_SEP + %H + FIELD_SEP` prefix. This means a body (or
// filename) that happens to contain those separator bytes cannot forge a record
// boundary, because it cannot contain the NUL that delimits the token.
const RECORD_SEP = "\x01";
const FIELD_SEP = "\x1f";

// %H sha, %aI author date (strict ISO), %an/%aE mailmapped author, %s subject,
// %b body. The leading %x01 is the header marker; %x1f the field separator.
const LOG_FORMAT = `%x01%H%x1f%aI%x1f%an%x1f%aE%x1f%s%x1f%b`;

// How much earlier a commit's committer date may be than its author date and
// still be caught by the git-side `--since` read bound. Committer date is
// normally >= author date; this margin absorbs clock skew so a skewed but
// author-in-window commit is not dropped before the JS author-date filter runs.
const SINCE_SKEW_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

// A 400-line commit body must not blow the packet budget in #354, so bodies are
// truncated on the way into the record with a flag.
const BODY_MAX_CHARS = 2000;

// Caps so a pathological repo (200k commits in-window) terminates instead of
// growing the kept arrays without bound. Overridable for tests.
const DEFAULT_MAX_COMMITS = 50_000;
const DEFAULT_MAX_MERGES = 50_000;

// Default generated/vendored paths dropped from each record's file list (their
// line counts still count toward churn — only the noisy file NAMES are hidden,
// and the drop is auditable via `filesExcluded`). Augmented by the repo's
// `.agentignore` if one happens to exist; never required.
const DEFAULT_IGNORE_PATTERNS = [
  // Lockfiles (matched by basename).
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json",
  "Cargo.lock", "Gemfile.lock", "poetry.lock", "composer.lock", "Pipfile.lock",
  "go.sum",
  // Directories.
  "dist/", "build/", "vendor/", "__snapshots__/",
  // Globs.
  "*.min.*", "*.generated.*", "*.lock",
];

// ---------------------------------------------------------------------------
// Ignore matching (a small gitignore-lite; full semantics are out of scope).
// ---------------------------------------------------------------------------

function escapeRegExp(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

// Convert a glob (`*`, `**`, `?`) to a regex fragment. `**` crosses path
// separators, `*`/`?` stay within a segment.
function globToRegExpSource(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExp(ch);
    }
  }
  return out;
}

// Compile one ignore pattern to a predicate over a repo-root-relative path.
// Returns null for blank/comment/negation lines (negation is not supported).
function compilePattern(rawPattern) {
  const pattern = rawPattern.trim();
  if (!pattern || pattern.startsWith("#") || pattern.startsWith("!")) {
    return null;
  }

  // Directory pattern: `dist/` matches any directory named dist and everything
  // under it, anchored at any path segment boundary.
  if (pattern.endsWith("/")) {
    const dir = pattern.slice(0, -1).replace(/^\/+/, "");
    const regex = new RegExp(`(^|/)${globToRegExpSource(dir)}/`);
    return (filePath) => regex.test(filePath);
  }

  const hasWildcard = /[*?]/.test(pattern);
  const hasSlash = pattern.includes("/");

  if (!hasWildcard && !hasSlash) {
    // Bare name: match the basename anywhere.
    return (filePath) => filePath.split("/").pop() === pattern;
  }

  if (hasSlash) {
    // Anchored to the repo root (leading slash is optional in gitignore).
    const anchored = pattern.replace(/^\/+/, "");
    const regex = new RegExp(`^${globToRegExpSource(anchored)}(/|$)`);
    return (filePath) => regex.test(filePath);
  }

  // Wildcard without a slash: match against the basename.
  const regex = new RegExp(`^${globToRegExpSource(pattern)}$`);
  return (filePath) => regex.test(filePath.split("/").pop());
}

/**
 * Build a predicate `(path) => boolean` from a list of ignore patterns.
 * @param {string[]} patterns
 * @returns {(filePath: string) => boolean}
 */
export function createIgnoreMatcher(patterns) {
  const matchers = (patterns || []).map(compilePattern).filter(Boolean);
  return (filePath) => {
    const normalized = String(filePath || "").replace(/^\/+/, "");
    if (!normalized) return false;
    return matchers.some((match) => match(normalized));
  };
}

// Read the repo's `.agentignore` if present. Never required: any read failure
// (absent file, unreadable) yields no extra patterns.
async function loadAgentignorePatterns(root) {
  try {
    const content = await fs.readFile(path.join(root, ".agentignore"), "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Numstat parsing.
// ---------------------------------------------------------------------------

/**
 * Parse the `--numstat -z` entries that follow a commit's header. Each entry is
 * one NUL-delimited token (git prefixes the first with a newline):
 *   - normal:  `<ins>\t<del>\t<path>`
 *   - binary:  `-\t-\t<path>`            (counts the file, contributes 0 lines)
 *   - rename:  `<ins>\t<del>\t` followed by two tokens `<old>` `<new>`
 *              (counted once, against the new path)
 *
 * @param {string[]} rawTokens - NUL-delimited tokens after the header
 * @param {(path: string) => boolean} [ignoreMatcher]
 * @returns {{ insertions: number, deletions: number, files: string[],
 *             excludedFiles: string[], binaryFiles: number }}
 */
export function parseNumstat(rawTokens, ignoreMatcher) {
  const result = { insertions: 0, deletions: 0, files: [], excludedFiles: [], binaryFiles: 0 };
  if (!rawTokens || rawTokens.length === 0) {
    return result;
  }

  // git prefixes the stat block with a newline on the first entry; strip it.
  const tokens = rawTokens
    .map((token, index) => (index === 0 && token.startsWith("\n") ? token.slice(1) : token))
    .filter((token) => token !== "");

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const tab1 = token.indexOf("\t");
    const tab2 = tab1 === -1 ? -1 : token.indexOf("\t", tab1 + 1);
    // A numstat line needs two tabs; anything else is a stray token (e.g. the
    // trailing path halves of a rename already consumed below) — skip it.
    if (tab1 === -1 || tab2 === -1) {
      i += 1;
      continue;
    }

    const insStr = token.slice(0, tab1);
    const delStr = token.slice(tab1 + 1, tab2);
    let filePath = token.slice(tab2 + 1);
    let advance = 1;

    if (filePath === "") {
      // Rename/copy under -z: the next two tokens are old and new paths.
      const newPath = tokens[i + 2];
      const oldPath = tokens[i + 1];
      filePath = newPath !== undefined ? newPath : oldPath || "";
      advance = 3;
    }
    i += advance;

    if (!filePath) {
      continue;
    }

    if (insStr === "-" || delStr === "-") {
      // Binary: count the file, contribute no lines, track separately.
      result.binaryFiles += 1;
    } else {
      // Raw line counts, before any generated-path exclusion, so churn totals
      // reflect the real diff (the reference measurement is raw).
      result.insertions += Number(insStr) || 0;
      result.deletions += Number(delStr) || 0;
    }

    if (ignoreMatcher && ignoreMatcher(filePath)) {
      result.excludedFiles.push(filePath);
    } else {
      result.files.push(filePath);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Record building.
// ---------------------------------------------------------------------------

function truncateBody(body) {
  if (body.length <= BODY_MAX_CHARS) {
    return { body, bodyTruncated: false };
  }
  return { body: body.slice(0, BODY_MAX_CHARS), bodyTruncated: true };
}

/**
 * Build a frozen commit record from decoded fields and a parsed numstat.
 * Redaction runs on the way in, so nothing downstream has to remember to redact.
 * The returned object is the frozen shape (#349) plus `bodyTruncated`.
 */
function buildRecord({ sha, authoredAt, authorName, authorEmail, subject, body, numstat, isMerge }) {
  const redactedSubject = redactSensitiveText(subject);
  const redactedBody = redactSensitiveText(body);
  const { body: truncatedBody, bodyTruncated } = truncateBody(redactedBody);

  const conventional = parseConventionalSubject(redactedSubject);
  const breaking = conventional.breaking || detectBreakingChange(redactedBody);
  const revert = detectRevert(redactedSubject, redactedBody);
  // Issue keys come from the full (untruncated) redacted subject + body so a
  // trailer reference near the end of a long body is not lost to truncation.
  const issueKeys = extractIssueKeys(`${redactedSubject}\n${redactedBody}`);

  return {
    sha,
    short: sha.slice(0, 7),
    authoredAt,
    authorName,
    authorEmail,
    subject: redactedSubject,
    body: truncatedBody,
    type: conventional.type,
    scope: conventional.scope,
    breaking,
    issueKeys,
    isMerge: isMerge === true,
    isRevert: revert.isRevert,
    revertOf: revert.revertOf,
    insertions: numstat.insertions,
    deletions: numstat.deletions,
    files: numstat.files,
    filesExcluded: numstat.excludedFiles.length,
    bodyTruncated,
  };
}

/**
 * Parse one framed record (a header token plus its numstat tokens) into both
 * the frozen record and the numstat detail the aggregate rollup needs.
 * @param {{ headerToken: string, numstatTokens: string[] }} record
 * @returns {{ record: object, numstat: object }}
 */
function parseRecord({ headerToken, numstatTokens }, { isMerge = false, ignoreMatcher = null } = {}) {
  // Drop the leading header marker, then split the fields. A commit message
  // cannot contain NUL, so the header token holds exactly one commit's fields.
  const header = headerToken.startsWith(RECORD_SEP) ? headerToken.slice(1) : headerToken;
  const parts = header.split(FIELD_SEP);
  const sha = parts[0] || "";
  const authoredAt = parts[1] || "";
  const authorName = parts[2] || "";
  const authorEmail = parts[3] || "";
  const subject = parts[4] || "";
  // The body is the final field; rejoin any FIELD_SEP past the fifth so a body
  // containing the separator byte is reconstructed rather than truncated.
  const body = parts.slice(5).join(FIELD_SEP);

  const numstat = parseNumstat(numstatTokens, ignoreMatcher);
  const record = buildRecord({ sha, authoredAt, authorName, authorEmail, subject, body, numstat, isMerge });
  return { record, numstat };
}

// ---------------------------------------------------------------------------
// Streaming.
// ---------------------------------------------------------------------------

// A header token is one that begins with the header marker, a %H hash (40 hex
// for sha1, 64 for sha256), and the field separator. Because tokens are split on
// NUL — a byte that cannot occur in a commit message — a body cannot masquerade
// as a header token, so this classification is not forgeable by message bytes.
const HEADER_TOKEN = new RegExp(`^${RECORD_SEP}(?:[0-9a-f]{40}|[0-9a-f]{64})${FIELD_SEP}`);

/**
 * Spawn `git log` with the given args and yield each framed record as the output
 * arrives. Records are framed on NUL-delimited tokens: a header token starts a
 * record, and the numstat tokens that follow (until the next header token)
 * belong to it. Yields incrementally (backpressure via `for await`), so a large
 * history is never buffered whole.
 *
 * @param {string} root
 * @param {string[]} gitArgs - args after `git`
 * @returns {AsyncGenerator<{ headerToken: string, numstatTokens: string[] }>}
 */
async function* streamRawRecords(root, gitArgs) {
  const child = spawn("git", gitArgs, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

  const stderrChunks = [];
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  let closeCode = null;
  let closeSignal = null;
  let spawnError = null;
  const closed = new Promise((resolve) => {
    child.on("error", (error) => {
      spawnError = error;
      resolve();
    });
    child.on("close", (code, signal) => {
      closeCode = code;
      closeSignal = signal;
      resolve();
    });
  });

  let buffer = "";
  let current = null; // { headerToken, numstatTokens } being assembled
  child.stdout.setEncoding("utf8");

  // Route one complete NUL-delimited token: a header token starts a new record
  // (emitting the previous one), any other token is numstat for the current one.
  const consume = function* (token) {
    if (HEADER_TOKEN.test(token)) {
      if (current) {
        yield current;
      }
      current = { headerToken: token, numstatTokens: [] };
    } else if (current) {
      current.numstatTokens.push(token);
    }
    // A token before the first header (there is none in practice) is ignored.
  };

  try {
    for await (const chunk of child.stdout) {
      buffer += chunk;
      let nul = buffer.indexOf("\0");
      while (nul !== -1) {
        const token = buffer.slice(0, nul);
        buffer = buffer.slice(nul + 1);
        yield* consume(token);
        nul = buffer.indexOf("\0");
      }
    }
    // Any trailing bytes without a final NUL form a last token.
    if (buffer.length > 0) {
      yield* consume(buffer);
    }
    // Emit the final assembled record.
    if (current) {
      yield current;
    }

    await closed;
    if (spawnError) {
      throw spawnError;
    }
    // Reaching here means the stream ended on its own (a cap breaks out of the
    // consumer, which runs the finally below instead of this code). So a signal
    // here is an EXTERNAL termination (kill / resource pressure): the output is
    // incomplete and must fail rather than pass partial data off as whole.
    if (closeSignal !== null) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const error = new Error(stderr || `git log terminated by signal ${closeSignal}`);
      error.gitSignal = closeSignal;
      error.gitStderr = stderr;
      throw error;
    }
    if (closeCode !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const error = new Error(stderr || `git log exited with code ${closeCode}`);
      error.gitExitCode = closeCode;
      error.gitStderr = stderr;
      throw error;
    }
  } finally {
    // On early break (cap) or throw, make sure the child does not linger.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
}

/**
 * Public streaming API: yield fully-built commit records incrementally.
 * Used by downstream slices (and the streaming test) that want records without
 * the aggregate rollup.
 *
 * @param {string} root
 * @param {object} [options]
 * @param {boolean} [options.merges] - stream merge commits instead of non-merges
 * @param {string[]} [options.gitArgs] - pre-built window/date args
 * @param {(path:string)=>boolean} [options.ignoreMatcher]
 * @returns {AsyncGenerator<object>} frozen commit records
 */
export async function* streamCommitRecords(root, options = {}) {
  const isMerge = options.merges === true;
  const gitArgs = buildLogArgs({ merges: isMerge, dateArgs: options.gitArgs || [] });
  for await (const raw of streamRawRecords(root, gitArgs)) {
    yield parseRecord(raw, { isMerge, ignoreMatcher: options.ignoreMatcher }).record;
  }
}

// Assemble the `git log` argument array. Non-merge collection carries numstat;
// merge collection does not (merge numstat is first-parent noise and merges are
// excluded from churn counts).
function buildLogArgs({ merges, dateArgs = [] }) {
  const args = [
    "log",
    merges ? "--merges" : "--no-merges",
    "--date=iso-strict",
    "--use-mailmap",
    "-z",
    `--format=${LOG_FORMAT}`,
  ];
  if (!merges) {
    args.push("--numstat");
  }
  args.push(...dateArgs);
  return args;
}

// ---------------------------------------------------------------------------
// Branch table.
// ---------------------------------------------------------------------------

/**
 * Read the local branch table via `git for-each-ref` (read-only).
 * @param {string} root
 * @returns {Promise<Array<{name,tip,tipShort,committerDate,hasUpstream}>>}
 */
export async function getBranchTable(root) {
  try {
    const format = `%(refname:short)${FIELD_SEP}%(objectname)${FIELD_SEP}%(committerdate:iso-strict)${FIELD_SEP}%(upstream)`;
    const { stdout } = await execFileAsync(
      "git",
      ["for-each-ref", `--format=${format}`, "refs/heads"],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, tip, committerDate, upstream] = line.split(FIELD_SEP);
        return {
          name: name || "",
          tip: tip || "",
          tipShort: (tip || "").slice(0, 7),
          committerDate: committerDate || "",
          hasUpstream: Boolean(upstream && upstream.length > 0),
        };
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Window -> git args resolution.
// ---------------------------------------------------------------------------

// Resolve a window bound to an absolute instant (ms since epoch) for author-date
// filtering, or null when it cannot be resolved. Instant bounds parse directly;
// an expression is tried as a date first, then as a ref (whose author date is
// used, keeping the window a date range even for ref bounds); an unresolvable
// relative expression ("2 weeks ago") returns null.
async function resolveBoundInstant(root, value, kind) {
  if (!value) {
    return null;
  }
  if (kind === "instant") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    return asDate;
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-1", "--format=%aI", `${value}^{commit}`],
      { cwd: root },
    );
    const t = Date.parse(stdout.trim());
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

// Whether this git supports `--since-as-filter` (git >= 2.37), which filters by
// date WITHOUT stopping history traversal at the first old commit the way plain
// `--since` does. Probed once per process and cached.
let sinceAsFilterSupport = null;
async function supportsSinceAsFilter() {
  if (sinceAsFilterSupport !== null) {
    return sinceAsFilterSupport;
  }
  try {
    const { stdout } = await execFileAsync("git", ["--version"]);
    const match = stdout.match(/(\d+)\.(\d+)/);
    const major = match ? Number(match[1]) : 0;
    const minor = match ? Number(match[2]) : 0;
    sinceAsFilterSupport = major > 2 || (major === 2 && minor >= 37);
  } catch {
    sinceAsFilterSupport = false;
  }
  return sinceAsFilterSupport;
}

// Translate the resolved window into git date args plus the author-date instants
// the JS filter enforces, and whether the bounds are enforced exactly.
//
// Only a lower bound is handed to git, never `--until`: git's date filters act
// on COMMIT date, and a commit authored inside the window but committed after it
// (a rebased/late-merged commit) would be dropped by `--until` before the
// author-date filter could keep it. The lower bound is a read optimization, set
// a skew margin BEFORE `since` (committer date is normally >= author date; the
// margin absorbs clock skew) and applied with `--since-as-filter` when available
// so traversal is not cut short. The exact half-open bounds are enforced in JS.
async function resolveWindowBounds(root, window) {
  const dateArgs = [];
  const sinceInstant = await resolveBoundInstant(root, window.since, window.since_kind);
  const untilInstant = await resolveBoundInstant(root, window.until, window.until_kind);

  const sinceFlag = (await supportsSinceAsFilter()) ? "--since-as-filter" : "--since";
  if (sinceInstant !== null) {
    const bounded = new Date(sinceInstant - SINCE_SKEW_MARGIN_MS).toISOString();
    dateArgs.push(`${sinceFlag}=${bounded}`);
  } else if (window.since) {
    // Unresolvable relative expression: hand the raw value to git so the read is
    // still bounded (git parses "2 weeks ago" etc.). The JS filter cannot refine
    // a lower bound it could not resolve to an instant.
    dateArgs.push(`${sinceFlag}=${window.since}`);
  }

  // When the upper bound is an unresolvable relative expression there is no
  // instant to filter against; fall back to git's own (inclusive, committer
  // date) `--until` so the window is still bounded above. This is the ONLY path
  // where the upper bound is not strictly half-open author-date, and only a
  // user-supplied relative expression can reach it — reported via `untilExact`.
  const untilExact = untilInstant !== null || !window.until;
  if (!untilExact) {
    dateArgs.push(`--until=${window.until}`);
  }

  return { dateArgs, sinceInstant, untilInstant, untilExact };
}

// Enforce the half-open author-date window `[since, until)` using the resolved
// instants. A bound that could not be resolved to an instant is left to git's
// own filtering (see resolveWindowBounds).
function isAuthoredInWindow(authoredAt, bounds) {
  const t = Date.parse(authoredAt);
  if (Number.isNaN(t)) {
    // Unparseable author date: keep it rather than silently drop a real commit.
    return true;
  }
  if (bounds.sinceInstant !== null && t < bounds.sinceInstant) {
    return false;
  }
  if (bounds.untilInstant !== null && t >= bounds.untilInstant) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Collection.
// ---------------------------------------------------------------------------

// git errors that mean "nothing to read", degraded to an empty result + note
// rather than a thrown failure (a fresh repo with no commits is not an error).
const EMPTY_HISTORY_PATTERNS = [
  /does not have any commits yet/i,
  /bad default revision/i,
  /unknown revision or path/i,
  /bad revision/i,
];

function isEmptyHistoryError(error) {
  const text = `${error?.gitStderr || ""} ${error?.message || ""}`;
  return EMPTY_HISTORY_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Collect commit records for one repository and one resolved window.
 *
 * @param {string} root - repository work-tree path
 * @param {object} [options]
 * @param {object} [options.window] - resolved window { since, until, since_kind, until_kind }
 * @param {number} [options.maxCommits]
 * @param {number} [options.maxMerges]
 * @param {string[]} [options.ignorePatterns] - override default ignore patterns (tests)
 * @returns {Promise<{
 *   commits: object[], merges: object[], branches: object[],
 *   stats: object, truncated: {commits:boolean, merges:boolean}, notes: string[]
 * }>}
 */
export async function collectCommits(root, options = {}) {
  const window = options.window || {};
  const maxCommits = Number.isInteger(options.maxCommits) ? options.maxCommits : DEFAULT_MAX_COMMITS;
  const maxMerges = Number.isInteger(options.maxMerges) ? options.maxMerges : DEFAULT_MAX_MERGES;

  const patterns = Array.isArray(options.ignorePatterns)
    ? options.ignorePatterns
    : [...DEFAULT_IGNORE_PATTERNS, ...(await loadAgentignorePatterns(root))];
  const ignoreMatcher = createIgnoreMatcher(patterns);

  const bounds = await resolveWindowBounds(root, window);
  const { dateArgs } = bounds;

  const notes = [];
  const commits = [];
  const merges = [];
  const truncated = { commits: false, merges: false };

  // Aggregate rollups. Line/file totals are RAW (before generated-path
  // exclusion) so they match the reference measurement; `filesExcluded` records
  // what was dropped from the per-record file lists.
  const authorEmails = new Set();
  const rawDistinctFiles = new Set();
  const distinctIssueRefs = new Set();
  let insertions = 0;
  let deletions = 0;
  let fileChanges = 0;
  let binaryFiles = 0;
  let filesExcluded = 0;

  const addIssueRefs = (record) => {
    for (const key of record.issueKeys) {
      distinctIssueRefs.add(key);
    }
  };

  // --- non-merge commits (the counted set, with numstat) ---
  try {
    const gitArgs = buildLogArgs({ merges: false, dateArgs });
    for await (const raw of streamRawRecords(root, gitArgs)) {
      const { record, numstat } = parseRecord(raw, { isMerge: false, ignoreMatcher });
      if (!isAuthoredInWindow(record.authoredAt, bounds)) {
        continue;
      }
      // Check the cap BEFORE retaining, so a window that lands exactly on the
      // cap is not falsely reported as truncated: truncation is set only when a
      // further in-window commit actually exists beyond the cap.
      if (commits.length >= maxCommits) {
        truncated.commits = true;
        break;
      }
      commits.push(record);
      authorEmails.add(record.authorEmail);
      addIssueRefs(record);
      insertions += numstat.insertions;
      deletions += numstat.deletions;
      binaryFiles += numstat.binaryFiles;
      filesExcluded += numstat.excludedFiles.length;
      for (const file of numstat.files) {
        rawDistinctFiles.add(file);
        fileChanges += 1;
      }
      for (const file of numstat.excludedFiles) {
        rawDistinctFiles.add(file);
        fileChanges += 1;
      }
    }
  } catch (error) {
    if (isEmptyHistoryError(error)) {
      notes.push("No commit history was found in the window.");
    } else {
      throw error;
    }
  }

  // --- merge commits (delivery evidence; excluded from churn counts) ---
  try {
    const gitArgs = buildLogArgs({ merges: true, dateArgs });
    for await (const raw of streamRawRecords(root, gitArgs)) {
      const { record } = parseRecord(raw, { isMerge: true, ignoreMatcher });
      if (!isAuthoredInWindow(record.authoredAt, bounds)) {
        continue;
      }
      if (merges.length >= maxMerges) {
        truncated.merges = true;
        break;
      }
      merges.push(record);
      // Merge issue refs count toward the distinct total (a merge subject like
      // "Merge pull request #340" is real delivery evidence).
      addIssueRefs(record);
    }
  } catch (error) {
    if (!isEmptyHistoryError(error)) {
      throw error;
    }
  }

  const branches = await getBranchTable(root);

  if (truncated.commits) {
    notes.push(`Commit reading was capped at ${maxCommits}; counts reflect the cap, not the full window.`);
  }
  if (truncated.merges) {
    notes.push(`Merge reading was capped at ${maxMerges}.`);
  }
  if (filesExcluded > 0) {
    notes.push(`${filesExcluded} generated/vendored file change(s) were excluded from file lists (line counts unaffected).`);
  }
  if (!bounds.untilExact) {
    notes.push("The upper bound is a relative expression git filters by committer date (inclusive); it is not the strict half-open author-date bound.");
  }

  return {
    commits,
    merges,
    branches,
    bounds: { until_exclusive: bounds.untilExact },
    stats: {
      commits: commits.length,
      merges: merges.length,
      authors: authorEmails.size,
      insertions,
      deletions,
      fileChanges,
      distinctFiles: rawDistinctFiles.size,
      binaryFiles,
      filesExcluded,
      issueRefs: distinctIssueRefs.size,
      branches: branches.length,
    },
    truncated,
    notes,
  };
}
