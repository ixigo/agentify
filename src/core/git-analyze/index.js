import path from "node:path";

import { getRepoTopLevel, isGitRepository } from "../git.js";
import { resolveWindow } from "./window.js";
import { collectCommits, windowUpperExclusive } from "./collect.js";
import { countCommitsInWindow } from "./discover.js";

// Bump when the shape returned by runGitAnalyze changes in a way downstream
// slices (#349–#356) or report renderers must notice.
//   1 (#348) — window-only skeleton, no commit history read.
//   2 (#349) — a real run adds totals, truncated, commits, merges, branches;
//              consumers must distinguish it from the skeleton contract.
//   3 (#350) — adds the `--global` report variant (scope: "global"), a distinct
//              top-level shape (a `discovery` section and a `repositories` array
//              of per-repo sections, no top-level `repository`/`bounds`). The
//              local shape is unchanged; the version bump signals the new
//              variant so a consumer can distinguish the two contracts.
export const GIT_ANALYZE_SCHEMA_VERSION = 3;

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

  // Global scope reads a discovered LIST of repositories (#350), never the
  // single cwd repo. Discovery itself (the filesystem walk + cache) lives in
  // discover.js and is done by the caller, which passes the deduplicated list
  // and its bounds in; this keeps index.js focused on report assembly.
  if (scope === "global") {
    return runGlobalGitAnalyze({
      window,
      now,
      dryRun: options.dryRun === true,
      repositories: Array.isArray(options.repositories) ? options.repositories : [],
      discovery: options.discovery || null,
      includeMerges: options.includeMerges === true,
      maxCommits: options.maxCommits,
      maxMerges: options.maxMerges,
      collectCommits: options.collectCommits || collectCommits,
      countCommits: options.countCommits || countCommitsInWindow,
    });
  }

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

  // Real local run: stream the window's commits. The collector resolves and
  // VALIDATES the bounds (a mistyped --since/--until throws here).
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
  // The frozen commit records and their delivery evidence, for downstream
  // slices (#351 filtering, #352 clustering) to consume.
  report.commits = collection.commits;
  report.merges = collection.merges;
  report.branches = collection.branches;
  notes.push(...collection.notes);

  return report;
}

/**
 * Build one per-repository section of a global report from a collection. The
 * section mirrors the local report's counts/totals/records so downstream slices
 * consume one repo's data with the same shape whether the run was local or
 * global — but each section stays wholly separate: no field is ever a blend of
 * two repositories.
 */
function buildRepoSection(repo, collection) {
  // Stamp every record with the repository it came from so a downstream slice
  // that flattens the per-repo sections into one stream never loses provenance
  // and cannot blend two repositories. Records are plain (unfrozen) objects, so
  // this is an in-place tag rather than an array copy.
  for (const record of collection.commits) {
    record.repository = repo.name;
    record.repositoryPath = repo.path;
  }
  for (const record of collection.merges) {
    record.repository = repo.name;
    record.repositoryPath = repo.path;
  }
  return {
    path: repo.path,
    name: repo.name,
    is_git_repository: true,
    commits_read: true,
    counts: {
      commits: collection.stats.commits,
      authors: collection.stats.authors,
    },
    totals: {
      insertions: collection.stats.insertions,
      deletions: collection.stats.deletions,
      distinct_files: collection.stats.distinctFiles,
      file_changes: collection.stats.fileChanges,
      binary_files: collection.stats.binaryFiles,
      files_excluded: collection.stats.filesExcluded,
      merges: collection.stats.merges,
      issue_refs: collection.stats.issueRefs,
      branches: collection.stats.branches,
    },
    truncated: collection.truncated,
    commits: collection.commits,
    merges: collection.merges,
    branches: collection.branches,
    notes: collection.notes,
  };
}

/**
 * Orchestrate a `--global` run over a pre-discovered repository list. Every
 * repository is collected INDEPENDENTLY and kept in its own section; the only
 * cross-repository figures are an explicitly-labelled aggregate (a per-repo sum
 * plus distinct author/issue unions), never a silent merge of two repos.
 *
 * A dry run previews each repository's window commit count via a body-free
 * `git rev-list --count` and never invokes the collector.
 *
 * @param {object} params
 * @returns {Promise<object>} the global report
 */
async function runGlobalGitAnalyze(params) {
  const {
    window, now, dryRun, repositories, discovery,
    includeMerges, maxCommits, maxMerges, collectCommits: collect, countCommits,
  } = params;

  const notes = [];
  const discoveryLimitations = discovery && Array.isArray(discovery.limitations)
    ? discovery.limitations
    : [];

  const report = {
    command: "git analyze",
    schema_version: GIT_ANALYZE_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    scope: "global",
    dry_run: dryRun,
    discovery: {
      roots: discovery && Array.isArray(discovery.roots) ? discovery.roots : [],
      repositories_found: discovery && Number.isInteger(discovery.repositoriesFound)
        ? discovery.repositoriesFound
        : repositories.length,
      from_cache: Boolean(discovery && discovery.fromCache),
      bounds: discovery && discovery.bounds ? discovery.bounds : null,
      stats: discovery && discovery.stats ? discovery.stats : null,
      limitations: discoveryLimitations,
    },
    window,
    counts: {
      repositories: repositories.length,
      commits: 0,
      authors: 0,
    },
    repositories: [],
    notes,
  };

  // Discovery limitations (bounds hit, permission skips) are top-level notes so
  // a surprising repository count is always explainable from the header.
  notes.push(...discoveryLimitations);

  if (dryRun) {
    let previewTotal = 0;
    let anyUnknown = false;
    for (const repo of repositories) {
      const count = await countCommits(repo.path, window, { includeMerges });
      if (count === null) {
        anyUnknown = true;
      } else {
        previewTotal += count;
      }
      report.repositories.push({
        path: repo.path,
        name: repo.name,
        is_git_repository: true,
        commits_read: false,
        window_commit_count: count,
      });
    }
    report.counts.commits = previewTotal;
    notes.push("Dry run: repositories were discovered and their window commit counts previewed, but no commit history was read.");
    if (anyUnknown) {
      notes.push("One or more window commit counts could not be previewed (the count is reported as null) and will be resolved on the real run.");
    }
    return report;
  }

  // Real run: collect each repository independently. A per-repository failure is
  // captured as that repository's note rather than aborting the whole sweep.
  const authorEmails = new Set();
  const issueRefs = new Set();
  const aggregate = {
    insertions: 0, deletions: 0, distinct_files: 0, file_changes: 0,
    binary_files: 0, files_excluded: 0, merges: 0, branches: 0,
  };

  for (const repo of repositories) {
    let collection;
    try {
      collection = await collect(repo.path, {
        window,
        maxCommits,
        maxMerges,
      });
    } catch (error) {
      report.repositories.push({
        path: repo.path,
        name: repo.name,
        is_git_repository: true,
        commits_read: false,
        error: error?.message || String(error),
        notes: [`This repository could not be read: ${error?.message || String(error)}`],
      });
      continue;
    }
    const section = buildRepoSection(repo, collection);
    report.repositories.push(section);

    report.counts.commits += section.counts.commits;
    aggregate.insertions += collection.stats.insertions;
    aggregate.deletions += collection.stats.deletions;
    aggregate.distinct_files += collection.stats.distinctFiles;
    aggregate.file_changes += collection.stats.fileChanges;
    aggregate.binary_files += collection.stats.binaryFiles;
    aggregate.files_excluded += collection.stats.filesExcluded;
    aggregate.merges += collection.stats.merges;
    aggregate.branches += collection.stats.branches;
    for (const record of collection.commits) {
      if (record.authorEmail) authorEmails.add(record.authorEmail);
      for (const key of record.issueKeys) issueRefs.add(key);
    }
    for (const record of collection.merges) {
      for (const key of record.issueKeys) issueRefs.add(key);
    }
  }

  report.counts.authors = authorEmails.size;
  // A labelled cross-repository aggregate: distinct authors and issue refs are
  // unions across repositories; the churn/merge/branch figures are a per-repo
  // sum. distinct_files is a per-repo sum (the same path in two repositories is
  // two files), so it is not globally deduplicated — stated by its name.
  report.totals = {
    ...aggregate,
    issue_refs: issueRefs.size,
    across_repositories: report.repositories.filter((r) => r.commits_read).length,
  };
  return report;
}

// Human-readable rendering of the report for `--format text`. A dry run shows
// only the resolved window; a real run adds the deterministic counts.
export function renderGitAnalyzeText(report) {
  if (report.scope === "global") {
    return renderGlobalGitAnalyzeText(report);
  }
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
  for (const note of report.notes) {
    lines.push(`  note:       ${note}`);
  }
  return lines.join("\n");
}

// Human-readable rendering of a `--global` report. Repositories are listed one
// per line with their own figures; the aggregate is explicitly labelled as a
// cross-repository sum so it can never be mistaken for a single repository's
// count.
function renderGlobalGitAnalyzeText(report) {
  const lines = [];
  lines.push(`Agentify git analyze — ${report.window.label} (global)`);
  lines.push(`  roots:      ${report.discovery.roots.join(", ") || "(none)"}`);
  lines.push(`  repos:      ${report.counts.repositories} discovered${report.discovery.from_cache ? " (from cache)" : ""}`);
  lines.push(`  since:      ${report.window.since}`);
  lines.push(`  until:      ${report.window.until}`);
  lines.push(`  timezone:   ${report.window.timezone}`);

  if (report.dry_run) {
    lines.push("  repositories (window commit counts previewed; no history read):");
    for (const repo of report.repositories) {
      const count = repo.window_commit_count === null ? "?" : repo.window_commit_count;
      lines.push(`    ${count === "?" ? "?".padStart(6) : String(count).padStart(6)}  ${repo.name}  ${repo.path}`);
    }
  } else {
    lines.push(`  commits:    ${report.counts.commits} across ${report.counts.repositories} repositor${report.counts.repositories === 1 ? "y" : "ies"} (${report.counts.authors} distinct author${report.counts.authors === 1 ? "" : "s"})`);
    lines.push("  repositories:");
    for (const repo of report.repositories) {
      if (repo.commits_read) {
        lines.push(`    ${String(repo.counts.commits).padStart(6)}  ${repo.name}  (+${repo.totals.insertions}/-${repo.totals.deletions}, ${repo.totals.merges} merge${repo.totals.merges === 1 ? "" : "s"})  ${repo.path}`);
      } else {
        lines.push(`    ${"—".padStart(6)}  ${repo.name}  (unreadable)  ${repo.path}`);
      }
    }
    if (report.totals) {
      lines.push(`  aggregate:  +${report.totals.insertions} / -${report.totals.deletions} across ${report.totals.distinct_files} file-path(s), ${report.totals.merges} merge(s), ${report.totals.issue_refs} distinct issue ref(s) (cross-repository sum)`);
    }
  }

  for (const note of report.notes) {
    lines.push(`  note:       ${note}`);
  }
  return lines.join("\n");
}
