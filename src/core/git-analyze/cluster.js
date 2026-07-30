// Theme clustering and the deterministic summary for `agentify git analyze`
// (#352). This is the layer that OWNS EVERY NUMBER: it consumes the filtered
// commit records the pipeline already produced (#349 record shape, #351 filter
// output) and turns them into units of work with headline totals,
// distributions, per-theme rollups, and a stated limitations block.
//
// Nothing here reads git, touches the network, or invokes a model. It is a pure
// transform over records + a caller-supplied branch-ownership map, so two runs
// over identical input produce byte-identical output (modulo `generated_at`,
// which the summary does not set). #353 (HTML) and #354 (narration) consume the
// object `buildGitAnalyzeSummary` returns rather than re-deriving anything — so
// the shape is a contract, versioned by SUMMARY_SCHEMA.

// Versioned machine contract. Bump on any breaking change to the summary shape.
export const SUMMARY_SCHEMA = "git-analyze-v1";

// A theme with fewer commits than this collapses into the per-repo "smaller
// changes" bucket: forty single-commit themes is not a summary.
export const DEFAULT_MIN_THEME_COMMITS = 2;

// A theme with at least this many commits on one key is flagged as an
// iteration signal (repeat commits on one unit of work — e.g. "review round N").
const ITERATION_MIN_COMMITS = 3;

// Bounds on retained per-theme evidence, so one pathological theme cannot grow
// the summary without limit.
const TOP_FILES_PER_THEME = 5;
const MERGE_SUBJECTS_PER_THEME = 10;

// ---------------------------------------------------------------------------
// Small deterministic date/path helpers (no timezone library, no clock).
// ---------------------------------------------------------------------------

// The author's local calendar date, taken verbatim from the strict-ISO author
// date (%aI carries the author's own offset). This is the honest "day they
// worked", and it is deterministic — no UTC re-projection that could move a
// late-evening commit to the next day.
function authorLocalDate(iso) {
  return String(iso || "").slice(0, 10);
}

// Compare two ISO instants; NaN-safe (unparseable dates sort last so a single
// malformed author date cannot hide a real first/last bound).
function instant(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// ISO-8601 week key ("2026-W30"). Computed in UTC from the date portion so it is
// stable regardless of the reader's timezone; the week a commit lands in is a
// coarse bucket, and using the author's calendar date keeps it consistent with
// active-days. Pure arithmetic, no dependency.
function isoWeekKey(iso) {
  const date = authorLocalDate(iso);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return "unknown";
  const [, y, m, d] = match;
  const utc = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(utc.getTime())) return "unknown";
  // ISO week: Thursday of the current week determines the week-year.
  const day = (utc.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  utc.setUTCDate(utc.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(utc.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((utc.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// The top-level directory of a repo-relative path, or null for a root file
// (which shares no source directory with anything and so cannot key tier 4).
function topLevelDir(filePath) {
  const p = String(filePath || "");
  const slash = p.indexOf("/");
  return slash === -1 ? null : p.slice(0, slash);
}

// The directory that best represents a commit for tier-4 clustering: the
// top-level directory holding the most of its touched files, ties broken
// lexicographically so the choice is deterministic. null when every file is a
// root file.
function dominantDirectory(files) {
  const counts = new Map();
  for (const file of files || []) {
    const dir = topLevelDir(file);
    if (dir === null) continue;
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  if (counts.size === 0) return null;
  let best = null;
  let bestCount = -1;
  for (const [dir, count] of counts) {
    if (count > bestCount || (count === bestCount && (best === null || dir < best))) {
      best = dir;
      bestCount = count;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Clustering: assign each commit a deterministic key, first match wins.
// ---------------------------------------------------------------------------

/**
 * Resolve one commit's cluster key by the fixed precedence (issue → branch →
 * scope → directory → unclustered). Branch attribution is supplied by the
 * caller (a git rev-list pass in index.js) because the frozen commit record
 * carries no per-commit reachability; when absent, tier 2 simply does not fire
 * and the commit falls through to scope/directory/unclustered — it is never
 * dropped.
 *
 * @param {object} record - a #349 commit record
 * @param {Map<string,string>} branchOwnership - sha -> owning branch name
 * @returns {{ kind: string, value: string }}
 */
function resolveClusterKey(record, branchOwnership) {
  if (Array.isArray(record.issueKeys) && record.issueKeys.length > 0) {
    return { kind: "issue", value: record.issueKeys[0] };
  }
  const owningBranch = branchOwnership.get(record.sha);
  if (owningBranch) {
    return { kind: "branch", value: owningBranch };
  }
  if (record.scope) {
    return { kind: "scope", value: String(record.scope).toLowerCase() };
  }
  const dir = dominantDirectory(record.files);
  if (dir) {
    return { kind: "directory", value: dir };
  }
  return { kind: "unclustered", value: "" };
}

// A short, deterministic human label for a theme — no model, no figures beyond
// the key itself. Renderers may add counts.
function themeTitle(kind, value) {
  switch (kind) {
    case "issue": return `Issue ${value}`;
    case "branch": return `Branch ${value}`;
    case "scope": return `Scope (${value})`;
    case "directory": return `Directory ${value}/`;
    default: return "Other changes";
  }
}

// Roll one group of commits up into a theme's evidence. Every number here is a
// sum/union over the group's own records, so a theme's figures always reconcile
// against its cited SHAs.
function rollupTheme({ id, repository, kind, value, commits, mergesByIssue }) {
  const typeHistogram = {};
  const issueKeys = new Set();
  const branches = new Set();
  const scopes = new Set();
  const fileCounts = new Map();
  const shas = [];
  let insertions = 0;
  let deletions = 0;
  let firstAt = null;
  let lastAt = null;

  for (const record of commits) {
    shas.push(record.sha);
    insertions += record.insertions || 0;
    deletions += record.deletions || 0;
    if (record.type) {
      typeHistogram[record.type] = (typeHistogram[record.type] || 0) + 1;
    }
    for (const key of record.issueKeys || []) issueKeys.add(key);
    if (record.scope) scopes.add(String(record.scope).toLowerCase());
    for (const file of record.files || []) {
      fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
    }
    const t = instant(record.authoredAt);
    if (t !== null) {
      if (firstAt === null || t < firstAt.t) firstAt = { t, iso: record.authoredAt };
      if (lastAt === null || t > lastAt.t) lastAt = { t, iso: record.authoredAt };
    }
  }
  if (kind === "branch") branches.add(value);

  const topFiles = [...fileCounts.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, TOP_FILES_PER_THEME)
    .map(([file, count]) => ({ path: file, commits: count }));

  // Delivery evidence: merges that cite an issue key this theme also cites.
  const mergeSubjects = [];
  const seenSubjects = new Set();
  for (const key of issueKeys) {
    for (const subject of mergesByIssue.get(key) || []) {
      if (!seenSubjects.has(subject)) {
        seenSubjects.add(subject);
        mergeSubjects.push(subject);
        if (mergeSubjects.length >= MERGE_SUBJECTS_PER_THEME) break;
      }
    }
    if (mergeSubjects.length >= MERGE_SUBJECTS_PER_THEME) break;
  }

  const iterationSignal = commits.length >= ITERATION_MIN_COMMITS && kind !== "unclustered" && kind !== "directory"
    ? { kind, key: value, commits: commits.length }
    : null;

  return {
    id,
    repository,
    key_kind: kind,
    key: value,
    title: themeTitle(kind, value),
    issue_keys: [...issueKeys],
    branches: [...branches],
    scopes: [...scopes],
    type_histogram: typeHistogram,
    commits: commits.length,
    first_commit: firstAt ? firstAt.iso : null,
    last_commit: lastAt ? lastAt.iso : null,
    insertions,
    deletions,
    files_changed: fileCounts.size,
    top_files: topFiles,
    merge_subjects: mergeSubjects,
    iteration_signal: iterationSignal,
    shas,
  };
}

// Aggregate the leftover single-commit (sub-threshold) groups of ONE repo into
// its single "smaller changes" bucket. Returns null when nothing was bucketed.
function buildBucket(repository, groups) {
  const commits = groups.reduce((total, group) => total + group.commits.length, 0);
  if (commits === 0) return null;

  const typeHistogram = {};
  const shas = [];
  let insertions = 0;
  let deletions = 0;
  const files = new Set();
  let firstAt = null;
  let lastAt = null;
  for (const group of groups) {
    for (const record of group.commits) {
      shas.push(record.sha);
      insertions += record.insertions || 0;
      deletions += record.deletions || 0;
      if (record.type) typeHistogram[record.type] = (typeHistogram[record.type] || 0) + 1;
      for (const file of record.files || []) files.add(file);
      const t = instant(record.authoredAt);
      if (t !== null) {
        if (firstAt === null || t < firstAt.t) firstAt = { t, iso: record.authoredAt };
        if (lastAt === null || t > lastAt.t) lastAt = { t, iso: record.authoredAt };
      }
    }
  }
  return {
    repository,
    commits,
    insertions,
    deletions,
    files_changed: files.size,
    type_histogram: typeHistogram,
    first_commit: firstAt ? firstAt.iso : null,
    last_commit: lastAt ? lastAt.iso : null,
    distinct_keys: groups.length,
    shas,
  };
}

/**
 * Cluster ONE repository's filtered commits into themes plus a smaller-changes
 * bucket. Kept per-repository by construction: the caller passes one repo's
 * records, so two repositories are never folded into one theme even on an
 * identical issue key.
 *
 * @param {object[]} commits - the repo's filtered #349 records
 * @param {object} [options]
 * @param {number} [options.minThemeCommits]
 * @param {object[]} [options.merges] - the repo's merge records (delivery evidence)
 * @param {Map<string,string>} [options.branchOwnership] - sha -> owning branch
 * @param {string} [options.repository] - repo DISPLAY name, carried on each theme
 * @param {string} [options.repositoryKey] - unique repo identity (e.g. its path)
 *   used to seed stable, collision-free theme ids; defaults to `repository`
 * @returns {{ themes: object[], smallerChanges: object|null }}
 */
export function clusterCommits(commits, options = {}) {
  const minThemeCommits = Number.isInteger(options.minThemeCommits) && options.minThemeCommits > 0
    ? options.minThemeCommits
    : DEFAULT_MIN_THEME_COMMITS;
  const branchOwnership = options.branchOwnership instanceof Map ? options.branchOwnership : new Map();
  const repository = options.repository || null;
  // Two repositories can share a basename (/work/app and /personal/app); the id
  // seed must be their unique identity (path), not the display name, so their
  // themes never collide.
  const repositoryKey = options.repositoryKey || repository || "";

  // Index merge subjects by the issue keys they cite, so a theme can surface the
  // merges that delivered it without an O(themes * merges) scan.
  const mergesByIssue = new Map();
  for (const merge of options.merges || []) {
    const subject = String(merge.subject || "").trim();
    if (!subject) continue;
    for (const key of merge.issueKeys || []) {
      if (!mergesByIssue.has(key)) mergesByIssue.set(key, []);
      mergesByIssue.get(key).push(subject);
    }
  }

  // Group commits by (kind, value). Insertion order does not matter: themes are
  // sorted deterministically below.
  const groups = new Map();
  for (const record of commits || []) {
    const { kind, value } = resolveClusterKey(record, branchOwnership);
    const id = `${repositoryKey}::${kind}:${value}`;
    let group = groups.get(id);
    if (!group) {
      group = { id, kind, value, commits: [] };
      groups.set(id, group);
    }
    group.commits.push(record);
  }

  const themes = [];
  const bucketed = [];
  for (const group of groups.values()) {
    if (group.commits.length < minThemeCommits) {
      bucketed.push(group);
      continue;
    }
    themes.push(rollupTheme({
      id: group.id,
      repository,
      kind: group.kind,
      value: group.value,
      commits: group.commits,
      mergesByIssue,
    }));
  }

  // Deterministic ordering: commits desc, then last-date desc, then id asc.
  themes.sort((a, b) => {
    if (b.commits !== a.commits) return b.commits - a.commits;
    const la = instant(a.last_commit) ?? -Infinity;
    const lb = instant(b.last_commit) ?? -Infinity;
    if (lb !== la) return lb - la;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { themes, smallerChanges: buildBucket(repository, bucketed) };
}

// ---------------------------------------------------------------------------
// Distributions.
// ---------------------------------------------------------------------------

// Build one distribution: a denominator (all commits in scope), a counted total
// (commits that carried the dimension), and items sorted commits-desc then
// key-asc. `keyOf` returns null for a commit that does not carry the dimension
// (e.g. no conventional type), which is excluded from `counted`.
function buildDistribution(commits, denominator, keyOf, extra) {
  const items = new Map();
  let counted = 0;
  for (const record of commits) {
    const key = keyOf(record);
    if (key === null || key === undefined) continue;
    counted += 1;
    let item = items.get(key);
    if (!item) {
      item = { key, commits: 0, insertions: 0, deletions: 0, ...(extra ? extra(record) : {}) };
      items.set(key, item);
    }
    item.commits += 1;
    item.insertions += record.insertions || 0;
    item.deletions += record.deletions || 0;
  }
  const sorted = [...items.values()].sort(
    (a, b) => (b.commits - a.commits) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return { denominator, counted, items: sorted };
}

// ---------------------------------------------------------------------------
// Summary assembly.
// ---------------------------------------------------------------------------

// Normalize the local/global report into a uniform list of repo sections, each
// carrying its own commits/merges and headline figures. This is the seam that
// keeps themes per-repository without special-casing scope downstream.
function repoSectionsOf(report) {
  if (report.scope === "global") {
    return (report.repositories || [])
      .filter((repo) => repo.commits_read)
      .map((repo) => ({
        name: repo.name,
        path: repo.path,
        commits: repo.commits || [],
        merges: repo.merges || [],
        counts: repo.counts || { commits: 0, authors: 0 },
        totals: repo.totals || {},
      }));
  }
  const name = report.repository && report.repository.path
    ? report.repository.path.split("/").filter(Boolean).pop() || report.repository.path
    : "(repository)";
  return [{
    name,
    path: report.repository ? report.repository.path : null,
    commits: report.commits || [],
    merges: report.merges || [],
    counts: report.counts || { commits: 0, authors: 0 },
    totals: report.totals || {},
  }];
}

// Distinct author-dates across a record set (the honest effort signal).
function activeDaysOf(records) {
  const days = new Set();
  for (const record of records) {
    const day = authorLocalDate(record.authoredAt);
    if (day) days.add(day);
  }
  return days.size;
}

function firstLastOf(records) {
  let firstAt = null;
  let lastAt = null;
  for (const record of records) {
    const t = instant(record.authoredAt);
    if (t === null) continue;
    if (firstAt === null || t < firstAt.t) firstAt = { t, iso: record.authoredAt };
    if (lastAt === null || t > lastAt.t) lastAt = { t, iso: record.authoredAt };
  }
  return { first: firstAt ? firstAt.iso : null, last: lastAt ? lastAt.iso : null };
}

// Fold caps, exclusions, and stated notes into one honest limitations list, and
// tally the excluded so a user can always reconcile a headline number. The notes
// the pipeline already produced (shallow clone, generated files, caps) are kept
// verbatim; a few structural limitations are added and the whole list deduped.
function buildLimitationsAndEvidence(report, sections) {
  const limitations = [];
  const seen = new Set();
  const add = (line) => {
    const text = String(line || "").trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      limitations.push(text);
    }
  };

  for (const note of report.notes || []) add(note);
  // Under --global the pipeline stores caps, shallow-clone warnings, generated-
  // file exclusions, and per-filter warnings on each repository section, not at
  // the top level — fold them in (labelled by repo) so a headline that is
  // incomplete for one repository is still explainable from the summary.
  for (const repo of report.repositories || []) {
    for (const note of repo.notes || []) add(`${repo.name}: ${note}`);
    if (repo.filters && Array.isArray(repo.filters.warnings)) {
      for (const warning of repo.filters.warnings) add(`${repo.name}: ${warning}`);
    }
  }

  let mergesExcluded = 0;
  let generatedExcluded = 0;
  let commitsCapped = false;
  for (const section of sections) {
    mergesExcluded += section.totals.merges || 0;
    generatedExcluded += section.totals.files_excluded || 0;
  }
  const truncated = report.truncated || null;
  if (truncated && truncated.commits) commitsCapped = true;
  for (const repo of report.repositories || []) {
    if (repo.truncated && repo.truncated.commits) commitsCapped = true;
  }
  const repositoriesUnreadable = (report.repositories || []).filter(
    (repo) => repo.is_git_repository && !repo.commits_read && !("window_commit_count" in repo),
  ).length;

  const includeMerges = Boolean(report.filters && report.filters.include_merges);
  if (mergesExcluded > 0) {
    // #351 keeps merges out of the commit/churn counts even under
    // --include-merges (they are reported separately as delivery evidence), so
    // only suggest the flag when it was not already given.
    const remediation = includeMerges ? "" : " (pass --include-merges to count them)";
    add(`${mergesExcluded} merge commit(s) are reported as delivery evidence but excluded from commit and churn counts${remediation}.`);
  }
  if (report.scope === "global") {
    add("Branch-based clustering is not computed under --global (to bound the cross-repository sweep); themes there cluster by issue key, conventional scope, and directory only.");
  }
  if (repositoriesUnreadable > 0) {
    add(`${repositoriesUnreadable} discovered repositor${repositoriesUnreadable === 1 ? "y was" : "ies were"} unreadable and contributed no commits.`);
  }

  const evidence = {
    merges_excluded: mergesExcluded,
    generated_files_excluded: generatedExcluded,
    commits_capped: commitsCapped,
    repositories_unreadable: repositoriesUnreadable,
  };
  return { limitations, evidence };
}

/**
 * Build the deterministic `git-analyze-v1` summary from a real (non-dry-run)
 * report. Self-contained: it repeats the resolved window, identities, and
 * applied filter set so #353/#354 consume this one object without re-deriving
 * anything. Every figure originates from the records git already produced.
 *
 * @param {object} report - the local or global report from runGitAnalyze
 * @param {object} [options]
 * @param {number} [options.minThemeCommits]
 * @param {Map<string,string>} [options.branchOwnership] - sha -> owning branch
 *   (local scope only; global skips branch clustering to stay bounded)
 * @returns {object} the versioned summary
 */
export function buildGitAnalyzeSummary(report, options = {}) {
  const sections = repoSectionsOf(report);
  const branchOwnership = options.branchOwnership instanceof Map ? options.branchOwnership : new Map();

  // Cluster each repository independently and keep every theme tagged with its
  // repository, so no cross-repository blend is possible.
  const themes = [];
  const smallerChanges = [];
  const repositories = [];
  const allCommits = [];
  const authorEmails = new Set();

  for (const section of sections) {
    const { themes: repoThemes, smallerChanges: bucket } = clusterCommits(section.commits, {
      minThemeCommits: options.minThemeCommits,
      merges: section.merges,
      // Ownership is a whole-run map keyed by sha; global passes an empty map.
      branchOwnership: report.scope === "global" ? new Map() : branchOwnership,
      repository: section.name,
      repositoryKey: section.path || section.name,
    });
    for (const theme of repoThemes) themes.push(theme);
    if (bucket) smallerChanges.push(bucket);

    const { first, last } = firstLastOf(section.commits);
    repositories.push({
      name: section.name,
      path: section.path,
      commits: section.counts.commits || 0,
      authors: section.counts.authors || 0,
      active_days: activeDaysOf(section.commits),
      first_commit: first,
      last_commit: last,
      insertions: section.totals.insertions || 0,
      deletions: section.totals.deletions || 0,
      files: section.totals.distinct_files || 0,
      merges: section.totals.merges || 0,
    });

    for (const record of section.commits) {
      allCommits.push(record);
      if (record.authorEmail) authorEmails.add(String(record.authorEmail).toLowerCase());
    }
  }

  // Global ordering: themes are already per-repo sorted; concatenation follows
  // repository order (discovery order). Re-sort the flat list by the same rule
  // so the whole `themes` array is deterministic and headline-first.
  themes.sort((a, b) => {
    if (b.commits !== a.commits) return b.commits - a.commits;
    const la = instant(a.last_commit) ?? -Infinity;
    const lb = instant(b.last_commit) ?? -Infinity;
    if (lb !== la) return lb - la;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Headline totals. Churn/files/merges come straight from the report's already
  // computed totals; commits/authors from counts; active-days/first-last are the
  // only figures computed here, and only from author dates on the records.
  const headlineCommits = repositories.reduce((total, repo) => total + repo.commits, 0);
  // Churn/files/merges are already summed by the pipeline (local totals, or the
  // labelled cross-repository sum under --global); the summary never re-derives
  // them. distinct_files under --global is a per-repo sum, as reported.
  const reportTotals = report.totals || {};
  const { first: firstCommit, last: lastCommit } = firstLastOf(allCommits);

  const totals = {
    commits: headlineCommits,
    insertions: reportTotals.insertions || 0,
    deletions: reportTotals.deletions || 0,
    files: reportTotals.distinct_files || 0,
    active_days: activeDaysOf(allCommits),
    first_commit: firstCommit,
    last_commit: lastCommit,
    repositories: repositories.length,
    merges: reportTotals.merges || 0,
    authors: (report.counts && report.counts.authors) || authorEmails.size,
  };

  const denominator = totals.commits;
  // by_repo is built from the per-repository sections (keyed by the unique repo
  // path, with the display name carried alongside), not from a per-commit key —
  // so two repositories sharing a basename are never collapsed into one item.
  const byRepoItems = repositories
    .map((repo) => ({
      key: repo.path || repo.name,
      name: repo.name,
      path: repo.path,
      commits: repo.commits,
      insertions: repo.insertions,
      deletions: repo.deletions,
    }))
    .sort((a, b) => (b.commits - a.commits) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const distributions = {
    by_type: buildDistribution(allCommits, denominator, (r) => r.type || null),
    by_scope: buildDistribution(allCommits, denominator, (r) => (r.scope ? String(r.scope).toLowerCase() : null)),
    by_author: buildDistribution(
      allCommits,
      denominator,
      (r) => (r.authorEmail ? String(r.authorEmail).toLowerCase() : (r.authorName || "unknown")),
      (r) => ({ name: r.authorName || "", email: r.authorEmail || "" }),
    ),
    by_repo: { denominator, counted: denominator, items: byRepoItems },
    by_week: buildDistribution(allCommits, denominator, (r) => isoWeekKey(r.authoredAt)),
  };

  const { limitations, evidence } = buildLimitationsAndEvidence(report, sections);

  return {
    schema: SUMMARY_SCHEMA,
    command: "git analyze",
    scope: report.scope,
    window: report.window,
    identities: (report.filters && report.filters.identities) || null,
    repositories,
    filters: report.filters || null,
    totals,
    distributions,
    themes,
    smaller_changes: smallerChanges,
    evidence,
    limitations,
  };
}
