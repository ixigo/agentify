// Renderers for `agentify git analyze` (#352): `text`, `md`, and `json`.
//
// These render ONLY what the deterministic summary already computed — no
// renderer produces a figure of its own. `text` is the terminal format (it
// extends the existing window/filter header with a compact theme table), `md`
// is the paste-into-a-review-form document, and `json` is the full report with
// the versioned `summary` object nested inside it (so existing top-level
// consumers keep working while #353/#354 read `report.summary`).

import { renderGitAnalyzeText } from "./index.js";

// ---------------------------------------------------------------------------
// Shared formatting (pure; no colour so output is byte-stable off a TTY).
// ---------------------------------------------------------------------------

function plural(count, singular, pluralForm) {
  return count === 1 ? singular : (pluralForm || `${singular}s`);
}

// A bounded short-SHA evidence trail for the human formats. The full, complete
// SHA list stays in the JSON contract (where a theme's figures are reconciled);
// the document formats show enough to trace and then a "+N more" tail so a
// 3-month window still fits on a screen.
const EVIDENCE_SHAS_SHOWN = 12;
function shortShas(shas) {
  const shown = shas.slice(0, EVIDENCE_SHAS_SHOWN).map((sha) => sha.slice(0, 7));
  const overflow = shas.length - shown.length;
  return `${shown.join(" ")}${overflow > 0 ? ` +${overflow} more` : ""}`;
}

// "12 of 275 commits" — always state the denominator so a partial distribution
// can never be mistaken for the whole.
function ofTotal(counted, denominator, unit = "commits") {
  return `${counted} of ${denominator} ${unit}`;
}

// A commit's short date (YYYY-MM-DD) for compact spans; the summary carries full
// ISO instants, but the day is enough for a human-facing span.
function day(iso) {
  return iso ? String(iso).slice(0, 10) : "—";
}

function span(first, last) {
  if (!first && !last) return "no dated commits";
  return `${day(first)} → ${day(last)}`;
}

// "feat×12, fix×5" from a type histogram, ordered count-desc then name-asc.
function histogram(hist) {
  const entries = Object.entries(hist || {});
  if (entries.length === 0) return "";
  return entries
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([type, count]) => `${type}×${count}`)
    .join(", ");
}

// A theme's key identifiers, in a stable order, for a one-line evidence tag.
function themeKeyLine(theme) {
  const parts = [];
  if (theme.issue_keys.length > 0) parts.push(theme.issue_keys.join(", "));
  if (theme.branches.length > 0) parts.push(theme.branches.map((b) => `branch:${b}`).join(", "));
  if (theme.scopes.length > 0 && theme.key_kind !== "scope") {
    parts.push(theme.scopes.map((s) => `(${s})`).join(", "));
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

/**
 * Terminal rendering: the existing window/filter/notes header, extended with a
 * compact theme table and the leading distributions. A dry run (or any report
 * with no summary) renders the header alone, unchanged.
 * @param {object} report
 * @returns {string}
 */
export function renderText(report) {
  const header = renderGitAnalyzeText(report);
  const summary = report.summary;
  if (!summary) {
    return header;
  }

  const lines = [header];
  const t = summary.totals;
  lines.push("");
  lines.push(
    `  headline:   ${t.commits} ${plural(t.commits, "commit")} · ` +
      `+${t.insertions}/-${t.deletions} across ${t.files} ${plural(t.files, "file")} · ` +
      `${t.active_days} active ${plural(t.active_days, "day")} · ${t.merges} ${plural(t.merges, "merge")} landed`,
  );
  lines.push(`  span:       ${span(t.first_commit, t.last_commit)}`);

  const showRepo = summary.scope === "global";
  if (summary.themes.length > 0) {
    lines.push(`  themes (${summary.themes.length}):`);
    for (const theme of summary.themes) {
      const churn = `+${theme.insertions}/-${theme.deletions}`;
      const tag = themeKeyLine(theme);
      const repoTag = showRepo ? `[${theme.repository}] ` : "";
      const iter = theme.iteration_signal ? ` [${theme.iteration_signal.commits}× on ${theme.iteration_signal.key}]` : "";
      lines.push(
        `    ${String(theme.commits).padStart(4)}  ${repoTag}${theme.title}${tag ? `  ${tag}` : ""}  ` +
          `${churn}  ${span(theme.first_commit, theme.last_commit)}${iter}`,
      );
    }
  } else if (summary.totals.commits === 0) {
    lines.push("  themes:     none (no commits matched)");
  } else {
    lines.push("  themes:     none reached the grouping threshold (see smaller changes)");
  }

  for (const bucket of summary.smaller_changes) {
    const repoTag = showRepo ? `[${bucket.repository}] ` : "";
    lines.push(
      `    ${String(bucket.commits).padStart(4)}  ${repoTag}smaller changes  ` +
        `${bucket.distinct_keys} ${plural(bucket.distinct_keys, "small theme")}  ` +
        `+${bucket.insertions}/-${bucket.deletions}`,
    );
  }

  const byType = summary.distributions.by_type;
  if (byType.items.length > 0) {
    const top = byType.items.slice(0, 6).map((item) => `${item.key} ${item.commits}`).join(", ");
    lines.push(`  by type:    ${top}  (${ofTotal(byType.counted, byType.denominator)} classified)`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------

function mdThemeSection(theme, showRepo) {
  const lines = [];
  const churn = `+${theme.insertions}/-${theme.deletions}`;
  const repoTag = showRepo ? `[${theme.repository}] ` : "";
  lines.push(`### ${repoTag}${theme.title} — ${theme.commits} ${plural(theme.commits, "commit")} (${churn})`);
  lines.push("");
  const tag = themeKeyLine(theme);
  if (tag) lines.push(`- Key: ${tag}`);
  const types = histogram(theme.type_histogram);
  if (types) lines.push(`- Types: ${types}`);
  lines.push(`- Span: ${span(theme.first_commit, theme.last_commit)} · ${theme.files_changed} ${plural(theme.files_changed, "file")} touched`);
  if (theme.top_files.length > 0) {
    lines.push(`- Top files: ${theme.top_files.map((f) => `\`${f.path}\` (${f.commits})`).join(", ")}`);
  }
  if (theme.merge_subjects.length > 0) {
    lines.push(`- Delivered: ${theme.merge_subjects.map((s) => `_${s}_`).join("; ")}`);
  }
  if (theme.iteration_signal) {
    lines.push(`- Iteration: ${theme.iteration_signal.commits} commits on ${theme.iteration_signal.key} (repeated work, not noise)`);
  }
  // Evidence: the SHAs that back every figure above, so the theme reconciles.
  lines.push(`- Evidence: ${shortShas(theme.shas)}`);
  lines.push("");
  return lines.join("\n");
}

function mdDistribution(title, dist, options = {}) {
  const unit = options.unit || "commits";
  const label = options.label || ((item) => item.key);
  if (dist.items.length === 0) return null;
  const parts = dist.items.slice(0, 8).map((item) => `${label(item)} ${item.commits}`);
  const overflow = dist.items.length - Math.min(dist.items.length, 8);
  const tail = overflow > 0 ? `, +${overflow} more` : "";
  return `- **${title}** (${ofTotal(dist.counted, dist.denominator, unit)}): ${parts.join(", ")}${tail}`;
}

/**
 * Markdown rendering: a headline, themes as sections each with an evidence line,
 * the distributions, and the limitations. Meant to paste into a review form —
 * kept terse so a 30-day window fits on a screen. A report with no summary (a
 * dry run) renders a short "no history read" note instead.
 * @param {object} report
 * @returns {string}
 */
export function renderMarkdown(report) {
  const summary = report.summary;
  const windowLabel = report.window ? report.window.label : "";
  if (!summary) {
    return `# git analyze — ${windowLabel}\n\n_No commit history was read (dry run); re-run without --dry-run for a summary._\n`;
  }

  const t = summary.totals;
  const lines = [];
  lines.push(`# git analyze — ${windowLabel}`);
  lines.push("");

  // Repository line: one repo named, or the count under --global.
  if (summary.scope === "global") {
    lines.push(`Scope: **global** · ${t.repositories} ${plural(t.repositories, "repository", "repositories")}`);
  } else {
    const repo = summary.repositories[0];
    lines.push(`Repository: **${repo ? repo.name : "(repository)"}**`);
  }
  lines.push("");
  lines.push(
    `**${t.commits} ${plural(t.commits, "commit")}** by ${t.authors} ${plural(t.authors, "author")} · ` +
      `+${t.insertions} / -${t.deletions} across ${t.files} ${plural(t.files, "file")} · ` +
      `${t.active_days} active ${plural(t.active_days, "day")} · ${t.merges} ${plural(t.merges, "merge")} landed`,
  );
  lines.push("");
  lines.push(`Window: ${day(t.first_commit)} → ${day(t.last_commit)} (resolved ${report.window ? report.window.since : "?"} → ${report.window ? report.window.until : "?"})`);
  lines.push("");

  // The applied filter set, so a surprising number is explainable from the doc.
  const filters = summary.filters;
  if (filters && Array.isArray(filters.applied_filters) && filters.applied_filters.length > 0) {
    const applied = filters.applied_filters.map((entry) => {
      const value = entry.values && entry.values.length > 0 ? ` ${entry.values.join(",")}` : "";
      const matched = entry.matched === null ? "" : ` (${entry.matched} ${entry.unit})`;
      return `\`${entry.flag}${value}\`${matched}`;
    });
    lines.push(`Filters: ${applied.join(", ")}`);
    lines.push("");
  }

  const showRepo = summary.scope === "global";
  // Under --global a filter's selectivity differs per repository, and the
  // resolved receipt lives per repo — surface it so the global doc is as
  // explainable as the local one.
  if (showRepo && summary.repositories.length > 0) {
    lines.push("## Repositories");
    lines.push("");
    for (const repo of summary.repositories) {
      let line = `- **${repo.name}** — ${repo.commits} ${plural(repo.commits, "commit")} (+${repo.insertions}/-${repo.deletions})`;
      const applied = repo.filters && Array.isArray(repo.filters.applied_filters) ? repo.filters.applied_filters : [];
      if (applied.length > 0) {
        const matched = applied
          .filter((entry) => entry.matched !== null)
          .map((entry) => `${entry.flag} ${entry.matched}`)
          .join(", ");
        if (matched) line += ` · matched: ${matched}`;
      }
      lines.push(line);
    }
    lines.push("");
  }

  lines.push("## Themes");
  lines.push("");
  if (summary.themes.length === 0) {
    // Distinguish "nothing matched" from "everything was small": a one-commit
    // report has an empty themes array but a populated smaller-changes bucket.
    lines.push(summary.totals.commits === 0
      ? "_No themes: no commits matched the filters._"
      : "_No theme reached the grouping threshold; all changes are in the smaller changes below._");
    lines.push("");
  } else {
    for (const theme of summary.themes) {
      lines.push(mdThemeSection(theme, showRepo));
    }
  }

  for (const bucket of summary.smaller_changes) {
    const repoTag = showRepo ? `[${bucket.repository}] ` : "";
    lines.push(
      `### ${repoTag}Smaller changes — ${bucket.commits} ${plural(bucket.commits, "commit")} ` +
        `across ${bucket.distinct_keys} ${plural(bucket.distinct_keys, "small theme")} (+${bucket.insertions}/-${bucket.deletions})`,
    );
    lines.push("");
    lines.push(`- Evidence: ${shortShas(bucket.shas)}`);
    lines.push("");
  }

  lines.push("## Distribution");
  lines.push("");
  const dists = [
    mdDistribution("By type", summary.distributions.by_type),
    mdDistribution("By scope", summary.distributions.by_scope),
    mdDistribution("By author", summary.distributions.by_author),
    mdDistribution("By repository", summary.distributions.by_repo, { label: (item) => item.name || item.key }),
    mdDistribution("By week", summary.distributions.by_week),
  ].filter(Boolean);
  for (const line of dists) lines.push(line);
  lines.push("");

  lines.push("## Limitations");
  lines.push("");
  if (summary.limitations.length === 0) {
    lines.push("- None recorded.");
  } else {
    for (const limitation of summary.limitations) lines.push(`- ${limitation}`);
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// json
// ---------------------------------------------------------------------------

/**
 * The machine contract: the full report, with the versioned `summary` object
 * (schema `git-analyze-v1`) nested inside it. Emitting the whole report keeps
 * the existing top-level fields (`window`, `bounds`, `counts`, `filters`, …)
 * that other consumers already read, while `report.summary` is the self-
 * contained object #353/#354 consume.
 * @param {object} report
 * @returns {string}
 */
export function renderJson(report) {
  return JSON.stringify(report, null, 2);
}

/**
 * Dispatch by format. `text` and `md`/`markdown` return strings for the caller
 * to route to the right stream; `json` returns the serialized report.
 * @param {object} report
 * @param {string} format
 * @returns {string}
 */
export function renderGitAnalyze(report, format) {
  switch (format) {
    case "md":
    case "markdown":
      return renderMarkdown(report);
    case "json":
      return renderJson(report);
    case "text":
    default:
      return renderText(report);
  }
}
