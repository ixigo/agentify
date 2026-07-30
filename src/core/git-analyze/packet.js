// The sanitized packet for optional provider narration (#354).
//
// A packet is built EXCLUSIVELY from the deterministic `git-analyze-v1`
// summary (cluster.js) plus the commit subjects on the records that summary
// already derived. It is the ONLY thing that ever leaves the machine when
// `--ai` is on, so its contents are a contract:
//
//   Included at every depth: the resolved window, the user's own identities
//   (emails only), per-repository names + headline figures, totals, the
//   leading type/scope distributions, and per theme — issue keys, title,
//   branches, scope, type histogram, counts, dates, file PATHS, commit
//   subjects, merge subjects, and the iteration signal.
//
//   Excluded by design at `--depth metadata` (the default): diff bodies, file
//   contents, absolute paths, remotes, and anything outside the resolved
//   window. `--depth diff` — and only `--depth diff` — adds bounded, redacted
//   diff hunks; it is separately consented because it is the one path that
//   ships source off the machine.
//
// `redactSensitiveText()` already ran over every subject/body at collection
// (#349). This module re-applies it defensively over the free-text strings it
// copies into the packet — a leaked token must not reach a provider even if a
// future collector regression let one through. Tests assert the packet is
// clean; they do not rely on this pass being the only guard.

import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import { redactSensitiveText } from "../redact.js";

const execFileAsync = promisify(execFile);

// Versioned machine contract for the packet shape. Bump on any breaking change.
export const NARRATION_PACKET_SCHEMA = "git-analyze-packet-v1";

// A theme's deterministic id embeds the repository's ABSOLUTE path
// ("/Users/…/repo::directory:src"), so it can never travel in the packet.
// Each theme is given an opaque, per-run id (t1, t2, …); the reverse map lives
// under this SYMBOL key on the packet — symbol-keyed properties are skipped by
// both `JSON.stringify` and `Object.keys`, so the map rides alongside the
// packet locally but is never serialized onto the wire. narrate.js reads it to
// translate the model's cited ids back to real ids before validation/output.
export const THEME_ID_MAP = Symbol("git-analyze-narration-theme-id-map");

export const NARRATION_DEPTHS = ["metadata", "diff"];

// Bounds on the free text copied per theme, so one pathological theme cannot
// grow the packet without limit (the summary already caps top_files and
// merge_subjects; subjects are capped here).
const SUBJECTS_PER_THEME = 12;
const FILE_PATHS_PER_THEME = 8;

// Token ceiling for the whole packet. Over this, the lowest-value themes
// (smallest, then oldest) are dropped and named in `dropped_themes`, so a
// very large window degrades to a bounded packet rather than an unbounded
// send. ~4 chars/token, matching the estimator used elsewhere.
export const DEFAULT_TOKEN_CEILING = 12000;

export function resolveNarrationDepth(raw) {
  const value = String(raw || "metadata").trim().toLowerCase();
  if (NARRATION_DEPTHS.includes(value)) return value;
  throw new Error(`git analyze --depth must be one of: ${NARRATION_DEPTHS.join(", ")} (got "${raw}")`);
}

// The day portion of an ISO instant (the packet never ships full timestamps —
// a coarse day is enough for a model to phrase a span).
function day(iso) {
  return iso ? String(iso).slice(0, 10) : null;
}

// Defensive path scrub: even though the packet copies no absolute-path field
// by design, a stray home-directory prefix in a free-text note or subject
// would leak the user's layout. Collapse it to "~" before the string travels.
const HOME_DIR = os.homedir();

function scrubHome(value) {
  if (!HOME_DIR || HOME_DIR === "/") return value;
  return value.split(HOME_DIR).join("~");
}

// Collapse URLs and scp-style git remotes to a placeholder. The packet excludes
// remotes by design, and a narration summary never needs a live link — so a URL
// that slipped into a commit subject or a note does not travel. Query strings
// and credentials embedded in a URL go with it.
function scrubUrls(value) {
  return String(value)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, "[url]")
    .replace(/\b[\w.-]+@[\w.-]+:[^\s"'<>)]+/g, "[url]");
}

function redactString(value) {
  return scrubUrls(scrubHome(redactSensitiveText(String(value || ""))));
}

// Every commit record in the report, local or global, in one flat list. Used
// to map a theme's SHAs back to their (already-redacted) subjects.
function collectRecords(report) {
  if (report.scope === "global") {
    const records = [];
    for (const repo of report.repositories || []) {
      for (const record of repo.commits || []) records.push(record);
    }
    return records;
  }
  return report.commits || [];
}

// A theme's commit subjects, in the theme's own SHA order, capped and
// re-redacted. Subjects are the one free-text field the model most needs to
// group by outcome; paths and counts come from the summary directly.
function subjectsForTheme(theme, subjectBySha) {
  const subjects = [];
  for (const sha of theme.shas || []) {
    const subject = subjectBySha.get(sha);
    if (!subject) continue;
    subjects.push(redactString(subject));
    if (subjects.length >= SUBJECTS_PER_THEME) break;
  }
  return subjects;
}

// One packet theme, at `--depth metadata`: identifiers, counts, dates, file
// paths, subjects, and the iteration signal — never a diff body. `opaqueId` is
// the per-run id the model sees and cites; the real (path-bearing) id never
// enters the packet.
function packetTheme(theme, subjectBySha, opaqueId) {
  // EVERY string copied from the summary is re-redacted (and home-scrubbed) on
  // its way into the packet — not only the obvious free text. A branch name,
  // scope, issue key, or file path can carry a secret-shaped token too, and the
  // packet is the privacy boundary, so nothing crosses it unfiltered.
  return {
    id: opaqueId,
    repository: redactString(theme.repository),
    title: redactString(theme.title),
    key_kind: theme.key_kind,
    issue_keys: (theme.issue_keys || []).map(redactString),
    branches: (theme.branches || []).map(redactString),
    scopes: (theme.scopes || []).map(redactString),
    type_histogram: theme.type_histogram,
    commits: theme.commits,
    insertions: theme.insertions,
    deletions: theme.deletions,
    files_changed: theme.files_changed,
    first_commit: day(theme.first_commit),
    last_commit: day(theme.last_commit),
    // File PATHS only (repo-relative; generated/vendored paths were already
    // excluded from the records these come from). No file contents.
    file_paths: (theme.top_files || []).slice(0, FILE_PATHS_PER_THEME).map((entry) => redactString(entry.path)),
    subjects: subjectsForTheme(theme, subjectBySha),
    merge_subjects: (theme.merge_subjects || []).map(redactString),
    iteration_signal: theme.iteration_signal
      ? { key: redactString(theme.iteration_signal.key), commits: theme.iteration_signal.commits }
      : null,
  };
}

// Trim a distribution to a compact { key, commits } list for the packet — the
// model uses it to group by outcome, not to state a number. Keys (scopes can
// be arbitrary text) are redacted like every other copied string.
function packetDistribution(distribution, limit = 10) {
  return (distribution?.items || []).slice(0, limit).map((item) => ({ key: redactString(item.key), commits: item.commits }));
}

// Rough token estimate for a JSON payload (chars / 4), matching the estimator
// used across the codebase when a provider reports no usage.
function estimateTokens(value) {
  return Math.round(Buffer.byteLength(JSON.stringify(value), "utf8") / 4);
}

/**
 * Build the sanitized narration packet from a real (non-dry-run) report.
 *
 * @param {object} report - a report carrying a `git-analyze-v1` summary
 * @param {object} [options]
 * @param {string} [options.depth] - "metadata" (default) or "diff"
 * @param {object} [options.diffHunksByTheme] - theme id -> bounded diff hunks
 *   (only consulted at depth "diff"; produced by collectThemeDiffs)
 * @param {number} [options.tokenCeiling]
 * @returns {object} the packet (with `dropped_themes` when the ceiling trimmed)
 */
export function buildNarrationPacket(report, options = {}) {
  const summary = report.summary;
  if (!summary) {
    throw new Error("buildNarrationPacket requires a report with a deterministic summary");
  }
  const depth = resolveNarrationDepth(options.depth);
  const tokenCeiling = Number.isFinite(options.tokenCeiling) && options.tokenCeiling > 0
    ? options.tokenCeiling
    : DEFAULT_TOKEN_CEILING;
  const diffHunksByTheme = options.diffHunksByTheme || null;

  const subjectBySha = new Map();
  for (const record of collectRecords(report)) {
    if (record && record.sha) subjectBySha.set(record.sha, record.subject);
  }

  const identities = summary.identities && Array.isArray(summary.identities.emails)
    ? { emails: summary.identities.emails.map(redactString) }
    : null;

  const repositories = (summary.repositories || []).map((repo) => ({
    name: redactString(repo.name),
    commits: repo.commits,
    insertions: repo.insertions,
    deletions: repo.deletions,
    active_days: repo.active_days,
    first_commit: day(repo.first_commit),
    last_commit: day(repo.last_commit),
  }));

  // Assign each theme an opaque, per-run id (t1, t2, …) and keep the reverse
  // map so the model's citations translate back to real ids. Diff hunks are
  // keyed by the REAL id (collectThemeDiffs never saw the opaque one), so they
  // are looked up here while both ids are in hand.
  const idMap = new Map();
  const themes = (summary.themes || []).map((theme, index) => {
    const opaqueId = `t${index + 1}`;
    idMap.set(opaqueId, theme.id);
    const packetized = packetTheme(theme, subjectBySha, opaqueId);
    if (depth === "diff" && diffHunksByTheme) {
      const hunks = diffHunksByTheme[theme.id];
      if (Array.isArray(hunks) && hunks.length > 0) {
        packetized.diff_hunks = hunks.map(redactString);
      }
    }
    return packetized;
  });

  const packet = {
    schema: NARRATION_PACKET_SCHEMA,
    depth,
    command: "git analyze",
    scope: summary.scope,
    window: summary.window
      ? {
        label: redactString(summary.window.label),
        since: redactString(summary.window.since),
        until: redactString(summary.window.until),
        timezone: redactString(summary.window.timezone),
      }
      : null,
    identities,
    repositories,
    totals: {
      commits: summary.totals.commits,
      insertions: summary.totals.insertions,
      deletions: summary.totals.deletions,
      files: summary.totals.files,
      active_days: summary.totals.active_days,
      merges: summary.totals.merges,
      authors: summary.totals.authors,
      repositories: summary.totals.repositories,
      first_commit: day(summary.totals.first_commit),
      last_commit: day(summary.totals.last_commit),
    },
    distributions: {
      by_type: packetDistribution(summary.distributions?.by_type),
      by_scope: packetDistribution(summary.distributions?.by_scope),
    },
    themes,
    smaller_changes: (summary.smaller_changes || []).map((bucket) => ({
      repository: redactString(bucket.repository),
      commits: bucket.commits,
      insertions: bucket.insertions,
      deletions: bucket.deletions,
      distinct_keys: bucket.distinct_keys,
    })),
    limitations: (summary.limitations || []).map(redactString),
    dropped_themes: [],
  };

  const bounded = enforceTokenCeiling(packet, tokenCeiling);
  // Carry the opaque→real id map under the symbol key (never serialized).
  Object.defineProperty(bounded, THEME_ID_MAP, { value: idMap, enumerable: false });
  return bounded;
}

// Drop the lowest-value themes (fewest commits, then oldest last-commit) until
// the packet fits the token ceiling, recording each dropped theme so the
// report can say which themes never reached the model. A packet whose themes
// are all dropped still ships its headline — the ceiling never empties totals.
function enforceTokenCeiling(packet, tokenCeiling) {
  if (estimateTokens(packet) <= tokenCeiling) {
    return packet;
  }
  // Least valuable last: fewest commits, then oldest last_commit, then id.
  const ranked = [...packet.themes].sort((a, b) => {
    if (a.commits !== b.commits) return a.commits - b.commits;
    const la = a.last_commit || "";
    const lb = b.last_commit || "";
    if (la !== lb) return la < lb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const dropped = [];
  const droppedIds = new Set();
  for (const theme of ranked) {
    if (estimateTokens(packet) <= tokenCeiling) break;
    droppedIds.add(theme.id);
    dropped.push({ id: theme.id, title: theme.title, commits: theme.commits });
    packet.themes = packet.themes.filter((entry) => !droppedIds.has(entry.id));
  }
  // Report drops in the summary's headline-first order (most commits first).
  packet.dropped_themes = dropped.sort((a, b) => (b.commits - a.commits) || (a.id < b.id ? -1 : 1));

  // Themes are the bulk of the packet, but they are not the only unbounded
  // field: a pathological limitations list or smaller-changes tail could keep
  // the packet over the ceiling on its own. Trim those next so the ceiling is a
  // real bound, not a themes-only one. The headline totals always survive.
  while (estimateTokens(packet) > tokenCeiling && packet.smaller_changes.length > 0) {
    packet.smaller_changes.pop();
  }
  while (estimateTokens(packet) > tokenCeiling && packet.limitations.length > 0) {
    packet.limitations.pop();
  }
  // Under --global a huge repository list or distribution tail could still keep
  // the packet over the ceiling on its own; trim those too, keeping at least
  // the leading repository so the packet is never emptied of provenance.
  while (estimateTokens(packet) > tokenCeiling && packet.repositories.length > 1) {
    packet.repositories.pop();
  }
  for (const dimension of ["by_type", "by_scope"]) {
    while (estimateTokens(packet) > tokenCeiling && packet.distributions[dimension].length > 0) {
      packet.distributions[dimension].pop();
    }
  }
  return packet;
}

// Bounds on the `--depth diff` read: the one path that ships source. These
// keep a 40k-line lockfile change or a 500-commit theme from ever loading an
// unbounded diff into memory or onto the wire.
const DIFF_MAX_THEMES = 12;
const DIFF_MAX_COMMITS_PER_THEME = 4;
const DIFF_MAX_FILES_PER_COMMIT = 6;
const DIFF_MAX_BYTES_PER_HUNK = 4000;
const DIFF_MAX_TOTAL_BYTES = 60000;

// Truncate a string to at most `maxBytes` UTF-8 bytes on a codepoint boundary,
// so a byte budget is never overrun by a multibyte character.
function byteSlice(text, maxBytes) {
  const buffer = Buffer.from(String(text), "utf8");
  if (buffer.length <= maxBytes) return String(text);
  // Back up off a partial trailing multibyte sequence (0b10xxxxxx bytes).
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.toString("utf8", 0, end);
}

// A read-only `git show` for one commit, restricted to the (already
// generated-stripped) paths on its record. `--format=` drops the commit
// message (subjects travel separately and redacted); `-U1` keeps hunks small.
async function showCommitDiff(root, sha, files, exec) {
  // --literal-pathspecs disables pathspec magic, so a file literally named
  // "*.env" or ":(glob)…" cannot widen the diff beyond the record's own paths
  // (which already exclude generated/vendored files).
  const args = ["--literal-pathspecs", "show", "--format=", "--unified=1", "--no-color", sha, "--", ...files];
  const { stdout } = await exec("git", args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  return String(stdout || "");
}

/**
 * Collect bounded, redacted diff hunks per theme for `--depth diff`. Read-only:
 * the only git call is `git show`. Every failure is swallowed to a skipped
 * theme rather than an aborted run — a diff we cannot read is a footnote, never
 * an error. Files come from the records (generated/vendored paths already
 * excluded), so generated files are stripped by construction.
 *
 * @param {string} root - the LOCAL repository root (diff depth is local-only)
 * @param {object} report - a report carrying a `git-analyze-v1` summary
 * @param {object} [options]
 * @param {function} [options.exec] - injected git runner (tests)
 * @returns {Promise<{ hunksByTheme: object, bytes: number, themesWithDiff: number }>}
 */
export async function collectThemeDiffs(root, report, options = {}) {
  const exec = options.exec || execFileAsync;
  const summary = report.summary;
  const hunksByTheme = {};
  let bytes = 0;
  let themesWithDiff = 0;
  if (!summary || report.scope === "global") {
    // Diff depth is local-only; a global sweep never ships source.
    return { hunksByTheme, bytes, themesWithDiff };
  }

  const filesBySha = new Map();
  for (const record of collectRecords(report)) {
    if (record && record.sha) filesBySha.set(record.sha, record.files || []);
  }

  for (const theme of (summary.themes || []).slice(0, DIFF_MAX_THEMES)) {
    if (bytes >= DIFF_MAX_TOTAL_BYTES) break;
    const hunks = [];
    for (const sha of (theme.shas || []).slice(0, DIFF_MAX_COMMITS_PER_THEME)) {
      if (bytes >= DIFF_MAX_TOTAL_BYTES) break;
      const files = (filesBySha.get(sha) || []).slice(0, DIFF_MAX_FILES_PER_COMMIT);
      if (files.length === 0) continue;
      let raw;
      try {
        raw = await showCommitDiff(root, sha, files, exec);
      } catch {
        continue; // an unreadable diff is skipped, never fabricated
      }
      // Bound by BYTES, not characters: a UTF-8 multibyte hunk sliced by char
      // count would overrun both the per-hunk and total byte caps.
      const clipped = byteSlice(redactString(raw), DIFF_MAX_BYTES_PER_HUNK);
      if (!clipped.trim()) continue;
      const remaining = DIFF_MAX_TOTAL_BYTES - bytes;
      const bounded = byteSlice(clipped, Math.max(0, remaining));
      if (!bounded) break;
      hunks.push(`# ${sha.slice(0, 7)}\n${bounded}`);
      bytes += Buffer.byteLength(bounded, "utf8");
    }
    if (hunks.length > 0) {
      hunksByTheme[theme.id] = hunks;
      themesWithDiff += 1;
    }
  }

  return { hunksByTheme, bytes, themesWithDiff };
}

/**
 * A compact preview of the packet for the consent disclosure and the dry-run
 * plan: which top-level fields it carries, its wire size, and a token
 * estimate. Never mutates the packet.
 * @param {object} packet
 * @returns {{ fields: string[], bytes: number, token_estimate: number }}
 */
export function packetPreview(packet) {
  const bytes = Buffer.byteLength(JSON.stringify(packet), "utf8");
  return {
    fields: Object.keys(packet),
    bytes,
    token_estimate: Math.round(bytes / 4),
  };
}
