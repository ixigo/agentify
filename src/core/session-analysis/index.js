import path from "node:path";

import {
  SESSION_ANALYSIS_SCHEMA_VERSION,
  ANALYSIS_PARSER_VERSION,
  emptyUsage,
  mergeUsage,
  homeRelative,
} from "./normalize.js";
import {
  claudeSessionMatchesRepo,
  discoverClaudeSessions,
  parseClaudeSession,
} from "./providers/claude.js";
import {
  codexSessionMatchesRepo,
  discoverCodexSessions,
  parseCodexSession,
} from "./providers/codex.js";
import { buildOpportunities, buildRoast } from "./opportunities.js";
import { buildScorecard, classifyWorkType, fitVerdict, scoreSession } from "./scorecard.js";
import { createAnalysisCache } from "./cache.js";
import { buildCostSummary, estimateSessionCost } from "./pricing.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;

export const ANALYZE_PROVIDERS = ["claude", "codex"];

export function resolveAnalyzeProviders(raw) {
  const value = String(raw || "all").trim().toLowerCase();
  if (value === "all") return [...ANALYZE_PROVIDERS];
  if (ANALYZE_PROVIDERS.includes(value)) return [value];
  throw new Error(`analyze --provider must be one of: claude, codex, all (got "${raw}")`);
}

// --source-root claude=<path> / codex=<path>, repeatable. Explicit roots
// for fixtures and custom installations. All explicit roots for a
// provider (--source-root entries plus --claude-root/--codex-root) are
// scanned as a union; the provider default is used only when no explicit
// root was given for it.
export function parseSourceRoots(raw, { root }) {
  const entries = raw === undefined ? [] : [].concat(raw);
  const roots = { claude: [], codex: [] };
  for (const entry of entries) {
    const text = String(entry === true ? "" : entry).trim();
    const [provider, ...rest] = text.split("=");
    const target = rest.join("=").trim();
    if (!ANALYZE_PROVIDERS.includes(provider) || !target) {
      throw new Error(`analyze --source-root requires claude=<path> or codex=<path> (got "${text}")`);
    }
    roots[provider].push(path.resolve(root, target));
  }
  return roots;
}

// A provider's roots are the explicit --source-root entries plus the
// single-root override (or the provider default when neither is given),
// deduplicated so the same store is never scanned twice.
function providerRoots(explicitRoots, singleRoot) {
  const roots = [...(explicitRoots || [])];
  if (singleRoot) roots.push(singleRoot);
  if (roots.length === 0) roots.push(null); // provider default
  return [...new Set(roots.map((entry) => (entry === null ? null : path.resolve(entry))))];
}

function resolveOptions(root, options) {
  const days = Number.isFinite(options.days) && options.days > 0 ? Math.floor(options.days) : DEFAULT_WINDOW_DAYS;
  const now = options.now instanceof Date ? options.now : new Date();
  const scope = options.scope === "global" ? "global" : "current-repo";
  return {
    days,
    now,
    scope,
    cutoffMs: now.getTime() - days * DAY_MS,
    providers: options.providers || [...ANALYZE_PROVIDERS],
    claudeRoots: providerRoots(options.claudeRoots, options.claudeRoot),
    codexRoots: providerRoots(options.codexRoots, options.codexRoot),
    cacheRoot: options.cacheRoot || null,
    cache: options.cache !== false,
    onProgress: typeof options.onProgress === "function" ? options.onProgress : null,
  };
}

async function discover(resolved) {
  const sources = [];
  if (resolved.providers.includes("claude")) {
    for (const claudeRoot of resolved.claudeRoots) {
      const discovered = await discoverClaudeSessions({ claudeRoot, cutoffMs: resolved.cutoffMs });
      sources.push({ provider: "claude", ...discovered });
    }
  }
  if (resolved.providers.includes("codex")) {
    for (const codexRoot of resolved.codexRoots) {
      const discovered = await discoverCodexSessions({ codexRoot, cutoffMs: resolved.cutoffMs });
      sources.push({ provider: "codex", ...discovered });
    }
  }
  // Overlapping roots (e.g. a store and one of its subdirectories) find
  // the same file more than once; only the first occurrence survives so
  // nothing is double counted. Distinct string paths to one inode (via
  // symlinks) are not resolved here.
  const seen = new Set();
  for (const source of sources) {
    source.files = source.files.filter((file) => {
      const key = `${source.provider}:${path.resolve(file.path)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return sources;
}

// Dry-run contract: disclose roots, file counts, and bytes without parsing
// any record bodies.
export async function buildAnalysisManifest(root, options = {}) {
  const resolved = resolveOptions(root, options);
  const sources = await discover(resolved);
  return {
    schema_version: SESSION_ANALYSIS_SCHEMA_VERSION,
    command: "analyze",
    dry_run: true,
    scope: resolved.scope,
    window_days: resolved.days,
    providers: resolved.providers,
    sources: sources.map((source) => ({
      provider: source.provider,
      root: homeRelative(source.root),
      missing: source.missing,
      files: source.files.length,
      bytes: source.files.reduce((sum, file) => sum + (file.size || 0), 0),
    })),
    note: "No session record bodies were parsed in this dry run.",
  };
}

function sessionInWindow(session, file, cutoffMs) {
  const ended = Date.parse(String(session.ended_at || ""));
  if (Number.isFinite(ended)) return ended >= cutoffMs;
  return file.mtime_ms >= cutoffMs;
}

function classifySessionShape(session) {
  const calls = session.tools.calls;
  const writes = session.file_access.filter((entry) => entry.operation === "write").length;
  const reads = (session.tools.by_name.Read || 0)
    + (session.tools.by_name.Grep || 0)
    + (session.tools.by_name.Glob || 0)
    + (session.tools.by_name.WebFetch || 0)
    + (session.tools.by_name.WebSearch || 0);
  const researchHeavy = calls >= 5 && writes === 0 && reads / calls > 0.7;
  const mechanical = writes >= 1 && writes <= 5 && calls <= 15
    && session.active_ms !== null && session.active_ms <= 30 * 60 * 1000;
  return { researchHeavy, mechanical, writes };
}

export async function buildSessionAnalysis(root, options = {}) {
  const resolved = resolveOptions(root, options);
  const sources = await discover(resolved);
  const sessions = [];
  const sourceStats = new Map();
  const cache = createAnalysisCache({ cacheRoot: resolved.cacheRoot, enabled: resolved.cache });

  for (const source of sources) {
    const stats = {
      provider: source.provider,
      root: homeRelative(source.root),
      missing: source.missing,
      files_discovered: source.files.length,
      files_parsed: 0,
      files_from_cache: 0,
      files_out_of_scope: 0,
      files_out_of_window: 0,
      bytes_parsed: 0,
      malformed_lines: 0,
      sessions: 0,
    };
    sourceStats.set(`${source.provider}:${source.root}`, stats);
    let filesDone = 0;
    let bytesDone = 0;
    const report = () => resolved.onProgress?.({
      provider: source.provider,
      filesDone,
      filesTotal: source.files.length,
      bytesDone,
      sessions: stats.sessions,
    });
    const processFile = async (file) => {
      let session = await cache.get(file, root);
      if (session) {
        // Coverage must stay auditable: a warm entry means the JSONL bytes
        // were NOT re-read this run, so it counts separately from parses.
        stats.files_from_cache += 1;
      } else {
        try {
          session = source.provider === "claude"
            ? await parseClaudeSession(file, { root })
            : await parseCodexSession(file, { root });
        } catch {
          stats.files_out_of_scope += 1;
          return;
        }
        await cache.put(file, root, session);
        stats.files_parsed += 1;
        stats.bytes_parsed += file.size || 0;
      }
      stats.malformed_lines += session.coverage.malformed_lines;
      if (resolved.scope === "current-repo") {
        const matches = source.provider === "claude"
          ? claudeSessionMatchesRepo(session, file, root)
          : codexSessionMatchesRepo(session, root);
        if (!matches) {
          stats.files_out_of_scope += 1;
          return;
        }
      }
      if (!sessionInWindow(session, file, resolved.cutoffMs)) {
        stats.files_out_of_window += 1;
        return;
      }
      stats.sessions += 1;
      sessions.push(session);
    };
    for (const file of source.files) {
      await processFile(file);
      filesDone += 1;
      bytesDone += file.size || 0;
      report();
    }
  }
  await cache.sweep(
    sources.flatMap((source) => source.files),
    resolved.providers,
    sources.map((source) => source.root),
  );

  // Global scope pseudonymizes projects by first-seen order; the mapping
  // never leaves this function, so real paths stay out of the report.
  const projectLabels = new Map();
  const projectLabel = (session) => {
    if (resolved.scope === "current-repo") return path.basename(root);
    const key = session.project_key || "unknown";
    if (!projectLabels.has(key)) projectLabels.set(key, `Project ${projectLabels.size + 1}`);
    return projectLabels.get(key);
  };

  const costEstimates = sessions.map((session) => estimateSessionCost(session));
  const totals = {
    sessions: sessions.length,
    duration_ms: null,
    active_ms: null,
    tool_calls: 0,
    failed_tool_calls: 0,
    usage: emptyUsage(),
    cost: buildCostSummary(sessions, costEstimates),
  };
  const modelRollup = new Map();
  const toolRollup = new Map();
  const fileSessions = new Map();
  const failedFingerprints = new Map();
  const patterns = {
    sessions: sessions.length,
    grep_like: 0,
    find_like: 0,
    cat_search_like: 0,
    full_test_runs: 0,
    focused_test_runs: 0,
    opaque_shell_calls: 0,
    failed_tool_calls: 0,
    files_written: 0,
    research_heavy_sessions: 0,
    mechanical_candidate_sessions: 0,
    longest_session_ms: 0,
    sidechain_events: 0,
  };
  const sessionRows = [];
  const scoredSessions = [];
  let malformedTotal = 0;
  let usageSessions = 0;

  for (const [sessionIndex, session] of sessions.entries()) {
    totals.duration_ms = add(totals.duration_ms, session.duration_ms);
    totals.active_ms = add(totals.active_ms, session.active_ms);
    totals.tool_calls += session.tools.calls;
    totals.failed_tool_calls += session.failed_tool_calls;
    mergeUsage(totals.usage, session.usage);
    if (session.coverage.usage_records > 0) usageSessions += 1;
    malformedTotal += session.coverage.malformed_lines;

    for (const model of session.models) {
      const entry = modelRollup.get(model) || { model, provider: session.provider, sessions: 0, output_tokens: null };
      entry.sessions += 1;
      entry.output_tokens = add(entry.output_tokens, session.usage.output_tokens);
      modelRollup.set(model, entry);
    }
    for (const [name, count] of Object.entries(session.tools.by_name)) {
      toolRollup.set(name, (toolRollup.get(name) || 0) + count);
    }
    for (const access of session.file_access) {
      if (!access.in_repo || access.operation !== "read") continue;
      const entry = fileSessions.get(access.path) || new Set();
      entry.add(session.session_id);
      fileSessions.set(access.path, entry);
    }
    for (const [fingerprint, count] of Object.entries(session.failed_command_fingerprints)) {
      failedFingerprints.set(fingerprint, (failedFingerprints.get(fingerprint) || 0) + count);
    }
    for (const key of ["grep_like", "find_like", "cat_search_like", "full_test_run", "focused_test_run", "opaque_shell_calls"]) {
      const target = key === "full_test_run" ? "full_test_runs" : key === "focused_test_run" ? "focused_test_runs" : key;
      patterns[target] += session.shell_patterns[key];
    }
    patterns.failed_tool_calls += session.failed_tool_calls;
    patterns.sidechain_events += session.sidechain_events;
    if ((session.duration_ms ?? 0) > patterns.longest_session_ms) {
      patterns.longest_session_ms = session.duration_ms;
    }
    const shape = classifySessionShape(session);
    patterns.files_written += shape.writes;
    if (shape.researchHeavy) patterns.research_heavy_sessions += 1;
    if (shape.mechanical) patterns.mechanical_candidate_sessions += 1;

    const workType = classifyWorkType(session);
    const fit = fitVerdict(workType, session.models);
    const { score, components } = scoreSession(session, workType, fit);
    scoredSessions.push({ work_type: workType, fit, score, components });

    sessionRows.push({
      session_id: session.session_id,
      provider: session.provider,
      project: projectLabel(session),
      date: session.started_at ? String(session.started_at).slice(0, 10) : null,
      duration_ms: session.duration_ms,
      active_ms: session.active_ms,
      models: session.models,
      output_tokens: session.usage.output_tokens,
      cache_read_tokens: session.usage.cache_read_tokens,
      tool_calls: session.tools.calls,
      failed_tool_calls: session.failed_tool_calls,
      files_touched: session.file_access.filter((entry) => entry.in_repo).length,
      sidechain_events: session.sidechain_events,
      branch: resolved.scope === "current-repo" ? session.branch : null,
      user_turns: session.turns?.user ?? null,
      work_type: workType,
      fit,
      score,
      cost_estimate_usd: costEstimates[sessionIndex].estimated_usd,
      cost_basis: costEstimates[sessionIndex].basis,
    });
  }
  const scorecard = buildScorecard(sessions, scoredSessions);
  sessionRows.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

  const rereadEntries = [...fileSessions.entries()]
    .map(([filePath, ids]) => ({ path: filePath, sessions: ids.size }))
    .filter((entry) => entry.sessions >= 3)
    .sort((a, b) => b.sessions - a.sessions);
  patterns.files_reread_across_sessions = {
    count: rereadEntries.length,
    top: rereadEntries.slice(0, 5),
  };
  const repeatCounts = [...failedFingerprints.values()].filter((count) => count >= 2);
  patterns.repeated_failed_commands = {
    fingerprints: repeatCounts.length,
    max_repeats: repeatCounts.length > 0 ? Math.max(...repeatCounts) : 0,
  };

  const { opportunities, suppressed } = buildOpportunities(patterns, { windowDays: resolved.days });
  const roast = buildRoast(patterns, totals, { windowDays: resolved.days });

  const fileActivity = [...fileSessions.entries()]
    .map(([filePath, ids]) => ({ path: filePath, sessions: ids.size }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 20);

  const sourceList = [...sourceStats.values()];
  return {
    schema_version: SESSION_ANALYSIS_SCHEMA_VERSION,
    parser_version: ANALYSIS_PARSER_VERSION,
    command: "analyze",
    generated_at: resolved.now.toISOString(),
    window_days: resolved.days,
    scope: resolved.scope,
    providers: resolved.providers,
    sources: sourceList,
    totals,
    models: [...modelRollup.values()].sort((a, b) => b.sessions - a.sessions),
    tools: Object.fromEntries([...toolRollup.entries()].sort((a, b) => b[1] - a[1])),
    sessions: sessionRows,
    file_activity: {
      observed_repo_files: fileActivity,
      note: "Observed = structured tool inputs only. Opaque shell calls are counted, never mined for paths.",
      opaque_shell_calls: patterns.opaque_shell_calls,
    },
    patterns,
    scorecard,
    opportunities,
    suppressed_rules: suppressed,
    roast,
    coverage: {
      sessions_analyzed: sessions.length,
      sessions_with_usage: usageSessions,
      malformed_lines: malformedTotal,
      cache: cache.stats(),
      sources: sourceList.map((entry) => ({
        provider: entry.provider,
        files_discovered: entry.files_discovered,
        files_parsed: entry.files_parsed,
        files_out_of_scope: entry.files_out_of_scope,
        files_out_of_window: entry.files_out_of_window,
      })),
    },
    privacy: {
      content_mode: "metadata-only",
      roots_read: sourceList.map((entry) => entry.root),
      transcript_bodies_analyzed: false,
      content_persisted: false,
      network_calls: 0,
      ai_spend_usd: 0,
      notes: [
        "JSONL bytes were read to parse record envelopes; prompt, response, thinking, and command bodies were not analyzed, retained, or uploaded.",
        "Shell commands were classified in memory into pattern counts; only counts and irreversible fingerprints appear in output.",
        resolved.cache && resolved.cacheRoot
          ? `Normalized session metadata (workspace path, branch, models, counters — never transcript, prompt, or command content) is cached privately (mode 0600) under ${homeRelative(resolved.cacheRoot)} so unchanged files are not re-parsed; entries are swept when their source file disappears, and --no-cache disables the cache.`
          : "Incremental caching was disabled for this run; every file was re-parsed.",
        resolved.scope === "global"
          ? "Project names and paths are pseudonymized in global scope."
          : "Only sessions whose working directory matches this repository were included.",
      ],
    },
  };
}

function add(current, value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return current;
  return (current ?? 0) + Number(value);
}

export function defaultAnalysisReportPath(root) {
  return path.join(root, "agentify-session-analysis.html");
}
