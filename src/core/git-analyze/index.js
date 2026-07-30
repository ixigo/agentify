import path from "node:path";

import { getRepoTopLevel, isGitRepository } from "../git.js";
import { resolveWindow } from "./window.js";
import { collectCommits, windowUpperExclusive } from "./collect.js";
import {
  resolveFilters,
  isFilterActive,
  describeRequestedFilters,
  resolveIdentities,
  resolveBranchRefs,
  applyFilters,
} from "./filters.js";

// Bump when the shape returned by runGitAnalyze changes in a way downstream
// slices (#349–#356) or report renderers must notice.
//   1 (#348) — window-only skeleton, no commit history read.
//   2 (#349) — a real run adds totals, truncated, commits, merges, branches;
//              consumers must distinguish it from the skeleton contract.
export const GIT_ANALYZE_SCHEMA_VERSION = 2;

export { resolveWindow };

/**
 * Orchestration entry for `agentify git analyze`.
 *
 * For this slice it resolves the window, confirms the cwd is a git repository
 * (for `--local`), and returns a report with counts of nothing — no commit is
 * ever read here. It writes nothing anywhere: the only git calls are read-only
 * `rev-parse` probes.
 *
 * The `scope` param is honoured ("local" default, "global" for #350) so the
 * report shape is frozen for downstream slices, but the CLI only ever invokes
 * the local path; global discovery lands in #350.
 *
 * On a real (non-dry-run) local run this streams the window's commits via
 * `collectCommits` and populates counts, churn totals, the frozen commit
 * records, merges, and the branch table. `--dry-run` still resolves the window
 * without reading a single commit.
 *
 * @param {string} root - resolved repository root (the command cwd)
 * @param {object} [options]
 * @param {object} [options.window] - window flags { days, months, quarter, year, since, until }
 * @param {string} [options.scope] - "local" (default) or "global"
 * @param {boolean} [options.dryRun] - whether this is a --dry-run invocation
 * @param {Date}    [options.now] - "now" instant (injectable for tests)
 * @param {number}  [options.maxCommits] - cap for the collector (tests)
 * @param {number}  [options.maxMerges] - cap for the collector (tests)
 * @param {function} [options.isGitRepository] - override for tests
 * @param {function} [options.getRepoTopLevel] - override for tests
 * @param {function} [options.collectCommits] - override for tests
 * @returns {Promise<object>} the report object
 */
export async function runGitAnalyze(root, options = {}) {
  const scope = options.scope === "global" ? "global" : "local";
  const now = options.now instanceof Date ? options.now : new Date();
  const window = resolveWindow(options.window || {}, { now });
  // Resolve the filter flags into a normalized set (pure; no git yet). #351.
  const filterSet = resolveFilters(options.filters || {});

  const resolvedRoot = path.resolve(root);
  const detectRepo = options.isGitRepository || isGitRepository;
  const topLevelOf = options.getRepoTopLevel || getRepoTopLevel;
  const collect = options.collectCommits || collectCommits;
  const isRepo = await detectRepo(resolvedRoot);

  if (scope === "local" && !isRepo) {
    // Only suggest what actually works today: --global discovery lands in #350,
    // so recommending it here would point at a flag the #348 CLI rejects.
    throw new Error(`git analyze needs a git repository; ${resolvedRoot} is not one. Run it from inside a repository.`);
  }

  // Identify the repository by its work-tree top-level, not the cwd, so running
  // from a subdirectory does not misreport the repository path.
  const repositoryPath = isRepo ? ((await topLevelOf(resolvedRoot)) || resolvedRoot) : resolvedRoot;

  const dryRun = options.dryRun === true;
  const notes = [];
  if (scope === "global") {
    notes.push("Repository discovery for --global lands in #350; no repositories were scanned yet.");
  }

  // Label the upper bound (exclusive vs git-native ref range) with a
  // non-throwing probe, so a dry run and a real run agree. A dry run does NOT
  // validate expression bounds: per #348 it passes `--since/--until` through
  // unresolved (a value may be a ref only the real run will resolve); a mistyped
  // bound is rejected on the real run, where the collector actually resolves it.
  const untilExclusive = (scope === "local" && isRepo)
    ? await windowUpperExclusive(repositoryPath, window)
    : true;

  const report = {
    command: "git analyze",
    schema_version: GIT_ANALYZE_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    scope,
    dry_run: dryRun,
    repository: {
      path: repositoryPath,
      is_git_repository: isRepo,
    },
    window,
    commits_read: false,
    counts: {
      commits: 0,
      authors: 0,
      repositories: scope === "global" ? 0 : (isRepo ? 1 : 0),
    },
    // Whether the upper bound is the strict half-open (exclusive) author-date
    // bound. True for computed windows and date/relative bounds; false only for a
    // revision ref, which takes git's native semantics. Same probe for dry-run
    // and real runs, so the boundary is labeled identically.
    bounds: {
      until_exclusive: untilExclusive,
    },
    // The resolved filter set (#351). On a dry run / non-reading path this echoes
    // the requested filters with null match counts; a real run below replaces it
    // with per-filter match counts.
    filters: describeRequestedFilters(filterSet),
    notes,
  };

  // Dry run (or a global scope, which has no repo to read here) resolves the
  // window and stops before reading any commit history.
  if (dryRun || scope !== "local" || !isRepo) {
    if (dryRun) {
      notes.push("Dry run: the window is resolved but no commit history has been read.");
    }
    return report;
  }

  // #351 branch reachability is pushed DOWN to git: resolve the `--branch` globs
  // to refs BEFORE collecting, so the read is restricted to commits reachable
  // from matching branches (a commit on two matched branches still appears once).
  let branchResolution = null;
  let refsPushdown;
  if (filterSet.branchGlobs.length > 0) {
    branchResolution = await resolveBranchRefs(repositoryPath, filterSet.branchGlobs);
    refsPushdown = branchResolution.refs;
  }
  // `--me` identities are resolved from the repo's git config + .mailmap.
  const identity = filterSet.me ? await resolveIdentities(repositoryPath) : null;

  // Real local run: stream the window's commits. The collector resolves and
  // VALIDATES the bounds (a mistyped --since/--until throws here).
  const collection = await collect(repositoryPath, {
    window,
    maxCommits: options.maxCommits,
    maxMerges: options.maxMerges,
    refs: refsPushdown,
  });

  // Content filters (#351) run as JS post-filters over the collected records.
  // When no filter is active the report is byte-identical to the unfiltered
  // #349 shape (same totals); an active filter recomputes totals over the
  // filtered set and records each filter's independent match count.
  const active = isFilterActive(filterSet);
  const applied = active ? applyFilters(collection, filterSet, { identity, branchResolution }) : null;
  const stats = active ? applied.stats : collection.stats;

  report.commits_read = true;
  report.counts = {
    commits: stats.commits,
    authors: stats.authors,
    repositories: 1,
  };
  report.totals = {
    insertions: stats.insertions,
    deletions: stats.deletions,
    distinct_files: stats.distinctFiles,
    file_changes: stats.fileChanges,
    binary_files: stats.binaryFiles,
    files_excluded: stats.filesExcluded,
    merges: stats.merges,
    issue_refs: stats.issueRefs,
    branches: stats.branches,
  };
  report.truncated = collection.truncated;
  // The (possibly filtered) commit records and their delivery evidence, for
  // downstream slices (#352 clustering, #353 report) to consume.
  report.commits = active ? applied.commits : collection.commits;
  report.merges = active ? applied.merges : collection.merges;
  report.branches = collection.branches;
  notes.push(...collection.notes);

  if (active) {
    report.filters = applied.filters;
    notes.push(...applied.warnings);
    // A single-identity `--me` with no .mailmap silently drops a person's other
    // emails; state the limitation and point at `--author` (per #351).
    if (filterSet.me && identity && !identity.usedMailmap) {
      notes.push("--me used the git config identity only (no .mailmap found); if you commit under more than one email, add the others with --author.");
    }
  }

  return report;
}

// Human-readable rendering of the report for `--format text`. A dry run shows
// only the resolved window; a real run adds the deterministic counts.
export function renderGitAnalyzeText(report) {
  const lines = [];
  lines.push(`Agentify git analyze — ${report.window.label}`);
  lines.push(`  scope:      ${report.scope}`);
  lines.push(`  repository: ${report.repository.path}${report.repository.is_git_repository ? "" : " (not a git repository)"}`);
  lines.push(`  since:      ${report.window.since}`);
  // The upper bound is half-open (exclusive) unless the user gave an explicit
  // expression `--until`, which git applies with its own (possibly inclusive)
  // semantics — as a date filter or a revision range.
  const upperExclusive = !report.bounds || report.bounds.until_exclusive !== false;
  lines.push(`  until:      ${report.window.until} ${upperExclusive ? "(exclusive)" : "(git-native bound; may include the boundary)"}`);
  lines.push(`  timezone:   ${report.window.timezone}`);
  if (report.commits_read && report.totals) {
    const t = report.totals;
    lines.push(`  commits:    ${report.counts.commits} (${report.counts.authors} author${report.counts.authors === 1 ? "" : "s"})`);
    lines.push(`  churn:      +${t.insertions} / -${t.deletions} across ${t.distinct_files} file${t.distinct_files === 1 ? "" : "s"} (${t.file_changes} change${t.file_changes === 1 ? "" : "s"})`);
    lines.push(`  merges:     ${t.merges} (excluded from counts)`);
    lines.push(`  issue refs: ${t.issue_refs}`);
    lines.push(`  branches:   ${t.branches}`);
  }
  // The applied filter set with per-filter match counts, so a surprising number
  // is always traceable to the filter that caused it (#351).
  const filters = report.filters;
  if (filters && Array.isArray(filters.applied_filters) && filters.applied_filters.length > 0) {
    lines.push("  filters:");
    for (const entry of filters.applied_filters) {
      const count = entry.matched === null ? "(not evaluated)" : `matched ${entry.matched} ${entry.unit}`;
      if (entry.kind === "me") {
        const id = entry.identities || { emails: [], used_mailmap: false };
        const emails = id.emails.length > 0 ? id.emails.join(", ") : "(none resolved)";
        lines.push(`    --me [${emails}${id.used_mailmap ? " via .mailmap" : ""}]: ${count}`);
        continue;
      }
      const value = entry.values && entry.values.length > 0 ? ` ${entry.values.join(",")}` : "";
      lines.push(`    ${entry.flag}${value}: ${count}`);
    }
    if (Array.isArray(filters.warnings)) {
      for (const warning of filters.warnings) {
        lines.push(`    warning:  ${warning}`);
      }
    }
  }
  for (const note of report.notes) {
    lines.push(`  note:       ${note}`);
  }
  return lines.join("\n");
}
