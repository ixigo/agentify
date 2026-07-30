// Filter engine for `agentify git analyze` (#351).
//
// Nine filters that compose predictably. Two rules govern composition:
//   - AND across kinds, OR within a kind. `--type feat,fix --scope acp` keeps a
//     commit that is (feat OR fix) AND scope acp. `--grep a --grep b` keeps a
//     commit whose message matches a OR b.
//   - Every filter reports its own effect. Each active filter records how many
//     records it INDIVIDUALLY matched (its selectivity), so a surprising final
//     number is always traceable to the filter that caused it, and a filter that
//     matched nothing produces a warning naming that filter — never an empty
//     report with no explanation.
//
// Division of labour with collect.js:
//   - Branch reachability and the date window are pushed DOWN to git (collect.js
//     `options.refs` + the window args): reachability across several refs must be
//     git-native so a commit reachable from two matching branches appears once,
//     and it cannot be reconstructed from a default-HEAD log post-hoc.
//   - Every CONTENT filter (--me/--author/--grep/--path/--type/--scope/--issue)
//     is a JS predicate applied HERE, over the records collect.js returns. This
//     is what lets each filter report its independent match count from a single
//     collection, keeps `--grep` a literal fixed-string match with no regex-error
//     surface, and guarantees no user-supplied pattern is ever handed to git at
//     all (the strongest reading of "no shell interpolation, ever").
//
// Nothing here writes, and the only git it does is read-only (`git config`,
// `git for-each-ref` via collect.js's getBranchTable) — the zero-install
// contract from the epic holds.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

import { getBranchTable } from "./collect.js";

const execFileAsync = promisify(execFile);

function gitEnv() {
  return { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
}

// Branch names that a `--branch` wildcard should not sweep in by default: agent
// worktree scratch branches and bot branches are noise in a "what did we ship"
// read. An EXPLICIT glob (one that is not a bare catch-all `*`/`**`) overrides
// the ignore, so `--branch 'worktree-agent-*'` still selects them on purpose.
const DEFAULT_BRANCH_IGNORE = ["worktree-agent-*", "dependabot/*"];

// ---------------------------------------------------------------------------
// One small glob matcher, used for --branch, --path, and (for #350) --repo.
// `*` and `?` stay within a path segment; `**` crosses separators. User input is
// escaped before it reaches the RegExp, so a pattern like `feat(acp)/*` cannot
// inject regex metacharacters — it matches literally except for the wildcards.
// ---------------------------------------------------------------------------

function escapeRegExp(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

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

/**
 * Compile a glob into a full-string matcher `(value) => boolean`.
 * @param {string} glob
 * @returns {(value: string) => boolean}
 */
export function compileGlob(glob) {
  const regex = new RegExp(`^${globToRegExpSource(String(glob))}$`);
  return (value) => regex.test(String(value ?? ""));
}

// A glob that is purely a catch-all (`*` / `**`, optionally repeated). Used to
// decide whether a `--branch` glob is explicit enough to override the default
// branch ignore list.
function isCatchAllGlob(glob) {
  return /^\*+$/.test(String(glob).trim());
}

// ---------------------------------------------------------------------------
// Flag resolution: parsed args -> a normalized filter set (pure, no I/O).
// ---------------------------------------------------------------------------

// Normalize a repeatable flag's value(s) into a clean string array. A valueless
// occurrence parses to `true` (see cli-args.js); drop those and empties so a
// malformed `--grep` with no argument does not become a filter that matches
// everything or throws.
function toStringList(value) {
  if (value === undefined || value === null) {
    return [];
  }
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .filter((entry) => entry !== true && entry !== undefined && entry !== null)
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
}

// A comma-separated list flag (`--type feat,fix`). Split on commas, trim, drop
// empties, and (for the case-insensitive kinds) lowercase.
function toCommaList(value, { lowerCase = false } = {}) {
  return toStringList(value)
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (lowerCase ? entry.toLowerCase() : entry));
}

// Normalize an --issue value to the canonical key shape used in `issueKeys`:
// a bare number or `#123` becomes `#123`; a Jira-style `proj-123` is uppercased
// to `PROJ-123`. Anything else is kept trimmed (and simply will not match).
function normalizeIssueKey(raw) {
  const value = String(raw).trim();
  if (/^#?\d+$/.test(value)) {
    return `#${value.replace(/^#/, "")}`;
  }
  if (/^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/.test(value)) {
    return value.toUpperCase();
  }
  return value;
}

/**
 * Resolve parsed CLI flags into a normalized filter set. Pure: no git, no I/O.
 *
 * @param {object} [flags] - the subset of parsed args relevant to filtering:
 *   { me, author, branch, grep, path, type, scope, issue, includeMerges }
 * @returns {{
 *   me: boolean, includeMerges: boolean,
 *   authorPatterns: string[], grepPatterns: string[], pathGlobs: string[],
 *   branchGlobs: string[], types: string[], scopes: string[], issues: string[],
 * }}
 */
export function resolveFilters(flags = {}) {
  return {
    me: flags.me === true,
    includeMerges: flags.includeMerges === true,
    authorPatterns: toStringList(flags.author),
    grepPatterns: toStringList(flags.grep),
    pathGlobs: toStringList(flags.path),
    branchGlobs: toStringList(flags.branch),
    types: toCommaList(flags.type, { lowerCase: true }),
    scopes: toCommaList(flags.scope, { lowerCase: true }),
    issues: toStringList(flags.issue).map(normalizeIssueKey),
  };
}

/**
 * Whether any filter in the set would change the collected result. `--me` and
 * `--include-merges` count: `--me` narrows to the caller's identities, and
 * `--include-merges` folds merges into the counted set. A set with none of these
 * active means the run is an ordinary unfiltered analysis.
 * @param {ReturnType<typeof resolveFilters>} filterSet
 * @returns {boolean}
 */
export function isFilterActive(filterSet) {
  return (
    filterSet.me ||
    filterSet.includeMerges ||
    filterSet.authorPatterns.length > 0 ||
    filterSet.grepPatterns.length > 0 ||
    filterSet.pathGlobs.length > 0 ||
    filterSet.branchGlobs.length > 0 ||
    filterSet.types.length > 0 ||
    filterSet.scopes.length > 0 ||
    filterSet.issues.length > 0
  );
}

/**
 * Describe the requested filter set WITHOUT reading history, for paths that
 * resolve the window but read no commits (a `--dry-run`, or `--global` before
 * #350 discovery). Match counts are `null` because nothing was collected.
 * @param {ReturnType<typeof resolveFilters>} filterSet
 * @returns {object} the same shape as applyFilters' `filters`, with null counts.
 */
export function describeRequestedFilters(filterSet) {
  const applied = [];
  const add = (kind, flag, values, unit) => applied.push({ kind, flag, values, matched: null, unit });
  if (filterSet.me) add("me", "--me", [], "commits");
  for (const pattern of filterSet.authorPatterns) add("author", "--author", [pattern], "commits");
  for (const pattern of filterSet.grepPatterns) add("grep", "--grep", [pattern], "commits");
  for (const glob of filterSet.pathGlobs) add("path", "--path", [glob], "commits");
  if (filterSet.types.length > 0) add("type", "--type", filterSet.types, "commits");
  if (filterSet.scopes.length > 0) add("scope", "--scope", filterSet.scopes, "commits");
  for (const key of filterSet.issues) add("issue", "--issue", [key], "commits");
  if (filterSet.branchGlobs.length > 0) add("branch", "--branch", filterSet.branchGlobs, "refs");
  if (filterSet.includeMerges) add("include-merges", "--include-merges", [], "merges");
  return {
    applied: isFilterActive(filterSet),
    include_merges: filterSet.includeMerges,
    identities: null,
    applied_filters: applied,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Identity resolution (--me): git config identity, expanded through .mailmap.
// ---------------------------------------------------------------------------

async function readGitConfigIdentity(root) {
  const read = async (key) => {
    try {
      const { stdout } = await execFileAsync("git", ["config", "--get", key], { cwd: root, env: gitEnv() });
      return stdout.trim();
    } catch {
      return "";
    }
  };
  const [email, name] = await Promise.all([read("user.email"), read("user.name")]);
  return { email, name };
}

// Parse a .mailmap into groups of identities that all refer to one person. Every
// email that appears on a single line (proper AND commit forms) is unioned, so a
// group can be built for whichever identity the config email lands in. Supported
// forms (git's own): `Proper Name <proper@x>`, `<proper@x> <commit@y>`,
// `Proper Name <proper@x> <commit@y>`, `Proper Name <proper@x> Commit <commit@y>`.
function parseMailmapGroups(content) {
  const groups = [];
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      continue;
    }
    const emails = [];
    const names = [];
    // Emails are the `<...>` tokens; names are the free text before each one.
    const emailRegex = /<([^>]*)>/g;
    let cursor = 0;
    let match;
    while ((match = emailRegex.exec(line)) !== null) {
      const namePart = line.slice(cursor, match.index).trim();
      if (namePart) {
        names.push(namePart);
      }
      const email = match[1].trim();
      if (email) {
        emails.push(email.toLowerCase());
      }
      cursor = emailRegex.lastIndex;
    }
    if (emails.length > 0) {
      groups.push({ emails, names });
    }
  }
  return groups;
}

/**
 * Resolve the caller's identity set for `--me`: the git config identity, unioned
 * with every alias grouped to it by the repo's `.mailmap` (if present). Because
 * collect.js reads with `--use-mailmap`, records already carry mailmap-canonical
 * names/emails; resolving the config identity through the SAME map means `--me`
 * matches whichever canonical form the records use, and also matches when a repo
 * has two un-mapped emails for one person only if the .mailmap links them.
 *
 * A missing `.mailmap` is not an error: `--me` falls back to the config identity
 * alone and the caller states that as a limitation.
 *
 * @param {string} root
 * @param {object} [deps] - test seams: { readMailmap, readConfig }
 * @returns {Promise<{
 *   emails: string[], names: string[], names_lower: string[],
 *   configEmail: string, configName: string, usedMailmap: boolean,
 * }>}
 */
export async function resolveIdentities(root, deps = {}) {
  const readConfig = deps.readConfig || readGitConfigIdentity;
  const readMailmap = deps.readMailmap || (async () => {
    try {
      return await fs.readFile(path.join(root, ".mailmap"), "utf8");
    } catch {
      return null;
    }
  });

  const config = await readConfig(root);
  const configEmail = (config.email || "").trim();
  const configName = (config.name || "").trim();

  const emails = new Set();
  const names = new Set();
  if (configEmail) {
    emails.add(configEmail.toLowerCase());
  }
  if (configName) {
    names.add(configName);
  }

  const mailmapContent = await readMailmap(root);
  const usedMailmap = typeof mailmapContent === "string" && mailmapContent.trim().length > 0;
  if (usedMailmap) {
    const groups = parseMailmapGroups(mailmapContent);
    // Repeatedly absorb any group that shares an email already in the identity
    // set, so a chain of aliases (a -> b, b -> c) all collapse onto the caller.
    let changed = true;
    while (changed) {
      changed = false;
      for (const group of groups) {
        if (group.consumed) {
          continue;
        }
        const overlaps = group.emails.some((email) => emails.has(email));
        if (overlaps) {
          group.consumed = true;
          changed = true;
          for (const email of group.emails) {
            emails.add(email);
          }
          for (const name of group.names) {
            names.add(name);
          }
        }
      }
    }
  }

  return {
    emails: [...emails],
    names: [...names],
    names_lower: [...names].map((name) => name.toLowerCase()),
    configEmail,
    configName,
    usedMailmap,
  };
}

// ---------------------------------------------------------------------------
// Branch reachability (--branch): resolve globs to refs for git-side pushdown.
// ---------------------------------------------------------------------------

/**
 * Resolve `--branch` globs against the repo's branch table into a set of
 * fully-qualified refs (`refs/heads/<name>`) for collect.js to push down. A ref
 * matching the default ignore list (agent/bot branches) is dropped unless an
 * EXPLICIT (non-catch-all) user glob selects it. Each glob reports how many refs
 * it matched, so a glob matching zero branches becomes a named warning rather
 * than a silent empty result.
 *
 * @param {string} root
 * @param {string[]} branchGlobs
 * @param {object} [deps] - test seam: { getBranchTable }
 * @returns {Promise<{
 *   refs: string[], matchedNames: string[], ok: boolean,
 *   perGlob: Array<{ glob: string, matched: number }>, zeroGlobs: string[],
 * }>}
 */
export async function resolveBranchRefs(root, branchGlobs, deps = {}) {
  const branchTableFn = deps.getBranchTable || getBranchTable;
  const { branches, ok } = await branchTableFn(root);

  const ignoreMatchers = DEFAULT_BRANCH_IGNORE.map(compileGlob);
  const isIgnored = (name) => ignoreMatchers.some((match) => match(name));

  const compiled = branchGlobs.map((glob) => ({
    glob,
    match: compileGlob(glob),
    explicit: !isCatchAllGlob(glob),
  }));

  const matchedNames = new Set();
  const perGlob = compiled.map(({ glob }) => ({ glob, matched: 0 }));

  for (const branch of branches) {
    const name = branch.name;
    if (!name) {
      continue;
    }
    for (let i = 0; i < compiled.length; i += 1) {
      const { match, explicit } = compiled[i];
      if (!match(name)) {
        continue;
      }
      // A default-ignored branch only counts when an explicit glob asked for it.
      if (isIgnored(name) && !explicit) {
        continue;
      }
      perGlob[i].matched += 1;
      matchedNames.add(name);
    }
  }

  const refs = [...matchedNames].map((name) => `refs/heads/${name}`);
  const zeroGlobs = perGlob.filter((entry) => entry.matched === 0).map((entry) => entry.glob);
  return { refs, matchedNames: [...matchedNames], ok, perGlob, zeroGlobs };
}

// ---------------------------------------------------------------------------
// Per-record content predicates.
// ---------------------------------------------------------------------------

// --me / --author: substring OR safe-regex match against the author name/email.
// Substring is the honest literal reading (so an injection payload like
// `; rm -rf .` is inert text that simply matches nothing); a regex attempt is a
// convenience layered on top, compiled defensively so an invalid pattern falls
// back to substring-only rather than throwing. All matching is case-insensitive.
function makeAuthorPredicate(pattern) {
  const needle = String(pattern).toLowerCase();
  let regex = null;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    regex = null;
  }
  return (record) => {
    const name = String(record.authorName || "");
    const email = String(record.authorEmail || "");
    if (name.toLowerCase().includes(needle) || email.toLowerCase().includes(needle)) {
      return true;
    }
    return regex ? (regex.test(name) || regex.test(email)) : false;
  };
}

function makeIdentityPredicate(identity) {
  const emails = new Set(identity.emails.map((email) => email.toLowerCase()));
  const names = new Set(identity.names_lower);
  return (record) => {
    const email = String(record.authorEmail || "").toLowerCase();
    const name = String(record.authorName || "").toLowerCase();
    return emails.has(email) || (name.length > 0 && names.has(name));
  };
}

// Cap on identities named in the hint, so a repo with hundreds of contributors
// produces a readable line rather than a wall of addresses.
const IDENTITY_HINT_MAX = 5;

// Other author identities in the window that `--me` did NOT match. Identities
// sharing a name token with the resolved set (e.g. "Ranveer Kumar" vs "Ranveer
// Sequeira") are listed first and called out as likely the same person — that is
// the case worth acting on, and it is invisible without a .mailmap.
function suggestUnmatchedIdentities(identity, records) {
  if (!identity || identity.emails.length !== 1) return [];

  const matches = makeIdentityPredicate(identity);
  const others = new Map();
  for (const record of records) {
    if (matches(record)) continue;
    const email = String(record.authorEmail || "").toLowerCase();
    if (email.length === 0) continue;
    const existing = others.get(email);
    if (existing) existing.commits += 1;
    else others.set(email, { email, name: String(record.authorName || ""), commits: 1 });
  }
  if (others.size === 0) return [];

  const ownTokens = new Set(
    identity.names_lower.flatMap((name) => name.split(/\s+/).filter((token) => token.length > 2)),
  );
  const isLikelySamePerson = (candidate) =>
    candidate.name
      .toLowerCase()
      .split(/\s+/)
      .some((token) => token.length > 2 && ownTokens.has(token));

  const ranked = [...others.values()].sort((a, b) => {
    const bias = Number(isLikelySamePerson(b)) - Number(isLikelySamePerson(a));
    return bias !== 0 ? bias : b.commits - a.commits;
  });
  const shown = ranked.slice(0, IDENTITY_HINT_MAX);
  const describe = (candidate) => `${candidate.name} <${candidate.email}> (${candidate.commits})`;
  const overflow = ranked.length - shown.length;
  const suffix = overflow > 0 ? `, and ${overflow} more` : "";

  const kin = ranked.filter(isLikelySamePerson);
  const lines = [];
  if (kin.length > 0) {
    lines.push(
      `--me resolved 1 identity, but ${kin.map(describe).join(", ")} shares a name with it — ` +
        `if that is also you, add --author to include those commits.`,
    );
  } else {
    lines.push(
      `--me resolved 1 identity; ${ranked.length} other identit${ranked.length === 1 ? "y" : "ies"} ` +
        `in this window ${ranked.length === 1 ? "was" : "were"} excluded: ${shown.map(describe).join(", ")}${suffix}. ` +
        `Use --author to include any that are also you.`,
    );
  }
  if (!identity.usedMailmap) {
    lines.push("No .mailmap was found, so --me could not expand alternate addresses for one person.");
  }
  return lines;
}

// --grep: fixed-string, case-insensitive substring over subject + body. Fixed by
// design (the frozen surface exposes no --grep-regex), so `fix(acp)` matches
// literally and never raises an "unterminated group" regex error.
function makeGrepPredicate(pattern) {
  const needle = String(pattern).toLowerCase();
  return (record) => {
    const haystack = `${record.subject || ""}\n${record.body || ""}`.toLowerCase();
    return haystack.includes(needle);
  };
}

// --path: glob over the record's changed files (any file matches -> commit
// matches). Matches against the retained file list, so a commit that touched
// ONLY generated/vendored files excluded by collect.js is not matched by a path
// glob — a documented, minor limitation of matching the reported file set.
function makePathPredicate(glob) {
  const match = compileGlob(glob);
  return (record) => (record.files || []).some((file) => match(file));
}

// --issue: exact match of a normalized key against the parsed issueKeys. Jira
// keys compare case-insensitively; GitHub `#123` refs compare exactly.
function makeIssuePredicate(key) {
  const target = key.toUpperCase();
  return (record) => (record.issueKeys || []).some((candidate) => String(candidate).toUpperCase() === target);
}

// OR a list of predicates (within-kind OR). An empty list means the kind is
// inactive and does not constrain anything.
function anyOf(predicates) {
  if (predicates.length === 0) {
    return null;
  }
  return (record) => predicates.some((predicate) => predicate(record));
}

// ---------------------------------------------------------------------------
// Application.
// ---------------------------------------------------------------------------

// Recompute aggregate totals over a filtered record set. Uses only the frozen
// record fields, so it runs without re-reading git. Two figures cannot be
// reconstructed from the frozen record and are reported as such:
//   - distinct_files counts only the RETAINED (non-excluded) file names, since
//     excluded names are not kept per record (only their count is).
//   - binary_files is null: the per-commit binary-file tally is not on the
//     record, so it cannot be summed post-filter.
function summarizeRecords(commits, merges, branchCount, includeMerges = false) {
  // `--include-merges` folds merges INTO the counted set (the epic's "opt merges
  // back into counts"); without it they stay evidence-only. Either way they are
  // present and reported, so `merges` is never a misleading zero.
  const counted = includeMerges ? [...commits, ...merges] : commits;
  const authorEmails = new Set();
  const distinctFiles = new Set();
  const issueRefs = new Set();
  let insertions = 0;
  let deletions = 0;
  let fileChanges = 0;
  let filesExcluded = 0;

  for (const record of counted) {
    authorEmails.add(record.authorEmail);
    insertions += record.insertions || 0;
    deletions += record.deletions || 0;
    filesExcluded += record.filesExcluded || 0;
    for (const file of record.files || []) {
      distinctFiles.add(file);
      fileChanges += 1;
    }
    fileChanges += record.filesExcluded || 0;
    for (const key of record.issueKeys || []) {
      issueRefs.add(key);
    }
  }
  // Merge issue refs count toward the distinct total (delivery evidence), the
  // same way collect.js counts them.
  for (const record of merges) {
    for (const key of record.issueKeys || []) {
      issueRefs.add(key);
    }
  }

  return {
    commits: counted.length,
    merges: merges.length,
    authors: authorEmails.size,
    insertions,
    deletions,
    fileChanges,
    distinctFiles: distinctFiles.size,
    binaryFiles: null,
    filesExcluded,
    issueRefs: issueRefs.size,
    branches: branchCount,
  };
}

/**
 * Apply the resolved filter set to a collected record set (the output of
 * collectCommits, already narrowed by branch reachability + window). Content
 * filters run here as JS predicates.
 *
 * Merge handling: type/scope/path structurally cannot apply to a merge record
 * (merges carry no conventional type/scope and collect.js reads no numstat for
 * them), so those filters never DROP a merge that `--include-merges` opted in —
 * only author/identity, grep, and issue constrain merges. This keeps merges from
 * being silently removed by a `--type` filter.
 *
 * @param {{commits: object[], merges: object[], branches: object[], stats: object,
 *          truncated: object, notes: string[], bounds?: object}} collection
 * @param {ReturnType<typeof resolveFilters>} filterSet
 * @param {object} [context] - { identity, branchResolution }
 * @returns {{ commits: object[], merges: object[], stats: object,
 *             filters: object, warnings: string[] }}
 */
export function applyFilters(collection, filterSet, context = {}) {
  const identity = context.identity || null;
  const branchResolution = context.branchResolution || null;

  const baseCommits = collection.commits || [];
  // Merges are ALWAYS retained (narrowed by the filters that are meaningful for
  // them) as delivery evidence, matching the unfiltered collection. Dropping
  // them unless --include-merges made a filtered report claim "0 merges landed"
  // for someone who had in fact landed dozens — the unfiltered report right
  // beside it counted them. --include-merges decides whether merges COUNT (see
  // summarizeRecords), not whether they exist.
  const baseMerges = collection.merges || [];

  // Build the active predicates per kind. `--me` and `--author` are one kind
  // (identity/author), OR-ed together.
  const identityAuthorPredicates = [];
  if (identity) {
    identityAuthorPredicates.push(makeIdentityPredicate(identity));
  }
  for (const pattern of filterSet.authorPatterns) {
    identityAuthorPredicates.push(makeAuthorPredicate(pattern));
  }
  const authorPredicate = anyOf(identityAuthorPredicates);
  const grepPredicate = anyOf(filterSet.grepPatterns.map(makeGrepPredicate));
  const pathPredicate = anyOf(filterSet.pathGlobs.map(makePathPredicate));
  const issuePredicate = anyOf(filterSet.issues.map(makeIssuePredicate));
  const typePredicate = filterSet.types.length > 0
    ? (record) => record.type !== null && filterSet.types.includes(String(record.type).toLowerCase())
    : null;
  const scopePredicate = filterSet.scopes.length > 0
    ? (record) => record.scope !== null && filterSet.scopes.includes(String(record.scope).toLowerCase())
    : null;

  // Predicates that apply to BOTH commits and merges vs. commits only. Merges
  // are exempt from type/scope/path (see the doc comment).
  const commitPredicates = [authorPredicate, grepPredicate, pathPredicate, typePredicate, scopePredicate, issuePredicate].filter(Boolean);
  const mergePredicates = [authorPredicate, grepPredicate, issuePredicate].filter(Boolean);

  const passesAll = (record, predicates) => predicates.every((predicate) => predicate(record));
  const commits = baseCommits.filter((record) => passesAll(record, commitPredicates));
  const merges = baseMerges.filter((record) => passesAll(record, mergePredicates));

  // Per-filter INDEPENDENT selectivity, over the applicable base set, so each
  // filter's effect is visible regardless of the others. Commit-oriented counts
  // include opted-in merges where the filter is meaningful.
  const appliedFilters = [];
  const warnings = [];

  const countOver = (predicate, records) => records.reduce((total, record) => total + (predicate(record) ? 1 : 0), 0);

  if (identity) {
    const matched = countOver(makeIdentityPredicate(identity), [...baseCommits, ...baseMerges]);
    appliedFilters.push({
      kind: "me",
      flag: "--me",
      values: identity.emails,
      matched,
      unit: "commits",
      identities: { emails: identity.emails, names: identity.names, used_mailmap: identity.usedMailmap },
    });
    if (matched === 0) {
      warnings.push("--me matched no commits by the resolved identity set.");
    }
    // The quiet failure mode this whole filter exists to prevent: one human with
    // two git identities (a work address and a personal one) gets a report that
    // silently omits everything they committed under the other. Without a
    // .mailmap there is nothing to expand, so the only honest move is to name
    // the identities we are NOT counting and point at the flag that includes
    // them. Only fires when a single identity resolved and others were dropped.
    for (const line of suggestUnmatchedIdentities(identity, [...baseCommits, ...baseMerges])) {
      warnings.push(line);
    }
  }

  for (const pattern of filterSet.authorPatterns) {
    const matched = countOver(makeAuthorPredicate(pattern), [...baseCommits, ...baseMerges]);
    appliedFilters.push({ kind: "author", flag: "--author", values: [pattern], matched, unit: "commits" });
    if (matched === 0) {
      warnings.push(`--author "${pattern}" matched no commits.`);
    }
  }

  for (const pattern of filterSet.grepPatterns) {
    const matched = countOver(makeGrepPredicate(pattern), [...baseCommits, ...baseMerges]);
    appliedFilters.push({ kind: "grep", flag: "--grep", values: [pattern], matched, unit: "commits" });
    if (matched === 0) {
      warnings.push(`--grep "${pattern}" matched no commit messages.`);
    }
  }

  for (const glob of filterSet.pathGlobs) {
    const matched = countOver(makePathPredicate(glob), baseCommits);
    appliedFilters.push({ kind: "path", flag: "--path", values: [glob], matched, unit: "commits" });
    if (matched === 0) {
      warnings.push(`--path "${glob}" matched no changed files.`);
    }
  }

  if (filterSet.types.length > 0) {
    const matched = countOver(typePredicate, baseCommits);
    appliedFilters.push({ kind: "type", flag: "--type", values: filterSet.types, matched, unit: "commits" });
    if (matched === 0) {
      warnings.push(`--type ${filterSet.types.join(",")} matched no commits.`);
    }
  }

  if (filterSet.scopes.length > 0) {
    const matched = countOver(scopePredicate, baseCommits);
    appliedFilters.push({ kind: "scope", flag: "--scope", values: filterSet.scopes, matched, unit: "commits" });
    if (matched === 0) {
      warnings.push(`--scope ${filterSet.scopes.join(",")} matched no commits.`);
    }
  }

  for (const key of filterSet.issues) {
    const matched = countOver(makeIssuePredicate(key), [...baseCommits, ...baseMerges]);
    appliedFilters.push({ kind: "issue", flag: "--issue", values: [key], matched, unit: "commits" });
    if (matched === 0) {
      warnings.push(`--issue ${key} matched no commits.`);
    }
  }

  // Branch is reported in REFS (its natural unit): it was already pushed down to
  // git, so the base record set is what it selected. Each glob reports how many
  // refs it matched, and a glob matching no branch is a named warning.
  if (filterSet.branchGlobs.length > 0) {
    const perGlob = branchResolution ? branchResolution.perGlob : filterSet.branchGlobs.map((glob) => ({ glob, matched: 0 }));
    const totalRefs = branchResolution ? branchResolution.matchedNames.length : 0;
    appliedFilters.push({
      kind: "branch",
      flag: "--branch",
      values: filterSet.branchGlobs,
      matched: totalRefs,
      unit: "refs",
      refs: branchResolution ? branchResolution.matchedNames : [],
    });
    if (branchResolution && branchResolution.ok === false) {
      warnings.push("--branch could not be resolved: branch enumeration failed (git for-each-ref).");
    }
    for (const entry of perGlob) {
      if (entry.matched === 0) {
        warnings.push(`--branch "${entry.glob}" matched no branches.`);
      }
    }
  }

  if (filterSet.includeMerges) {
    appliedFilters.push({ kind: "include-merges", flag: "--include-merges", values: [], matched: merges.length, unit: "merges" });
  }

  const stats = summarizeRecords(commits, merges, (collection.branches || []).length, filterSet.includeMerges);

  const filters = {
    applied: appliedFilters.length > 0,
    include_merges: filterSet.includeMerges,
    identities: identity
      ? { emails: identity.emails, names: identity.names, used_mailmap: identity.usedMailmap, resolved: identity.emails.length }
      : null,
    applied_filters: appliedFilters,
    warnings,
  };

  return { commits, merges, stats, filters, warnings };
}
