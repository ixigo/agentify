import path from "node:path";

import { getRepoTopLevel, isGitRepository } from "../git.js";
import { resolveWindow } from "./window.js";
import { collectCommits } from "./collect.js";

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

  // Real local run: stream the window's commits.
  const collection = await collect(repositoryPath, {
    window,
    maxCommits: options.maxCommits,
    maxMerges: options.maxMerges,
  });

  report.commits_read = true;
  report.counts = {
    commits: collection.stats.commits,
    authors: collection.stats.authors,
    repositories: 1,
  };
  report.totals = {
    insertions: collection.stats.insertions,
    deletions: collection.stats.deletions,
    distinct_files: collection.stats.distinctFiles,
    file_changes: collection.stats.fileChanges,
    binary_files: collection.stats.binaryFiles,
    files_excluded: collection.stats.filesExcluded,
    merges: collection.stats.merges,
    issue_refs: collection.stats.issueRefs,
    branches: collection.stats.branches,
  };
  report.truncated = collection.truncated;
  // Whether the upper bound was enforced as the strict half-open author-date
  // bound (true) or fell back to git's inclusive committer-date filter for an
  // unresolvable relative expression (false). Keeps the rendered label honest.
  report.bounds = collection.bounds;
  // The frozen commit records and their delivery evidence, for downstream
  // slices (#351 filtering, #352 clustering) to consume.
  report.commits = collection.commits;
  report.merges = collection.merges;
  report.branches = collection.branches;
  notes.push(...collection.notes);

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
  // The upper bound is half-open (exclusive) unless a real run fell back to
  // git's inclusive committer-date filter for an unresolvable relative bound.
  const upperExclusive = !report.bounds || report.bounds.until_exclusive !== false;
  lines.push(`  until:      ${report.window.until} ${upperExclusive ? "(exclusive)" : "(git committer-date filter, inclusive)"}`);
  lines.push(`  timezone:   ${report.window.timezone}`);
  if (report.commits_read && report.totals) {
    const t = report.totals;
    lines.push(`  commits:    ${report.counts.commits} (${report.counts.authors} author${report.counts.authors === 1 ? "" : "s"})`);
    lines.push(`  churn:      +${t.insertions} / -${t.deletions} across ${t.distinct_files} file${t.distinct_files === 1 ? "" : "s"} (${t.file_changes} change${t.file_changes === 1 ? "" : "s"})`);
    lines.push(`  merges:     ${t.merges} (excluded from counts)`);
    lines.push(`  issue refs: ${t.issue_refs}`);
    lines.push(`  branches:   ${t.branches}`);
  }
  for (const note of report.notes) {
    lines.push(`  note:       ${note}`);
  }
  return lines.join("\n");
}
