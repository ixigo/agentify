import path from "node:path";

import { isGitRepository } from "../git.js";
import { resolveWindow } from "./window.js";

// Bump when the shape returned by runGitAnalyze changes in a way downstream
// slices (#349–#356) or report renderers must notice.
export const GIT_ANALYZE_SCHEMA_VERSION = 1;

export { resolveWindow };

// Scope of the analysis. Repo discovery for `--global` lands in #350; this
// skeleton only distinguishes the two so the resolved value is echoed in the
// report header from day one.
export function resolveScope(args = {}) {
  return args.global === true ? "global" : "local";
}

/**
 * Orchestration entry for `agentify git analyze`.
 *
 * For this slice it resolves the window, confirms the cwd is a git repository
 * (for `--local`), and returns a report with counts of nothing — no commit is
 * ever read here. It writes nothing anywhere: the only git call is a read-only
 * `rev-parse --is-inside-work-tree`.
 *
 * @param {string} root - resolved repository root (the command cwd)
 * @param {object} [options]
 * @param {object} [options.window] - window flags { days, months, quarter, year, since, until }
 * @param {string} [options.scope] - "local" (default) or "global"
 * @param {boolean} [options.dryRun] - whether this is a --dry-run invocation
 * @param {Date}    [options.now] - "now" instant (injectable for tests)
 * @param {string}  [options.timeZone] - IANA zone override (injectable for tests)
 * @param {function} [options.isGitRepository] - override for tests
 * @returns {Promise<object>} the report object
 */
export async function runGitAnalyze(root, options = {}) {
  const scope = options.scope || "local";
  const now = options.now instanceof Date ? options.now : new Date();
  const window = resolveWindow(options.window || {}, { now, timeZone: options.timeZone });

  const resolvedRoot = path.resolve(root);
  const detectRepo = options.isGitRepository || isGitRepository;
  const isRepo = await detectRepo(resolvedRoot);

  if (scope === "local" && !isRepo) {
    throw new Error(
      `git analyze --local needs a git repository; ${resolvedRoot} is not one. `
        + "Run it from inside a repository, or use --global to scan discovered repos.",
    );
  }

  const notes = [];
  if (scope === "global") {
    notes.push("Repository discovery for --global lands in #350; no repositories were scanned yet.");
  }
  if (options.dryRun) {
    notes.push("Dry run: the window is resolved but no commit history has been read.");
  }

  return {
    command: "git analyze",
    schema_version: GIT_ANALYZE_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    scope,
    dry_run: options.dryRun === true,
    repository: {
      path: resolvedRoot,
      is_git_repository: isRepo,
    },
    window,
    // No commits are read in this slice; downstream slices populate these.
    commits_read: false,
    counts: {
      commits: 0,
      authors: 0,
      repositories: scope === "global" ? 0 : (isRepo ? 1 : 0),
    },
    notes,
  };
}

// Human-readable rendering of the dry-run / skeleton report for `--format text`.
export function renderGitAnalyzeText(report) {
  const lines = [];
  lines.push(`Agentify git analyze — ${report.window.label}`);
  lines.push(`  scope:      ${report.scope}`);
  lines.push(`  repository: ${report.repository.path}${report.repository.is_git_repository ? "" : " (not a git repository)"}`);
  lines.push(`  since:      ${report.window.since}`);
  lines.push(`  until:      ${report.window.until} (exclusive)`);
  lines.push(`  timezone:   ${report.window.timezone}`);
  for (const note of report.notes) {
    lines.push(`  note:       ${note}`);
  }
  return lines.join("\n");
}
