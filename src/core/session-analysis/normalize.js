import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const SESSION_ANALYSIS_SCHEMA_VERSION = "session-analysis-v1";
export const RECOMMENDATION_SCHEMA_VERSION = "recommendation-v1";
export const USAGE_SCORECARD_SCHEMA_VERSION = "usage-scorecard-v1";
export const ANALYSIS_PARSER_VERSION = "analyze-parser-v8";

// null means "the provider never reported this dimension"; zero means an
// observed zero. Adding a value to null promotes it to a number.
export function addNullable(current, value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return current;
  }
  return (current ?? 0) + Number(value);
}

export function emptyUsage() {
  return {
    fresh_input_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    // TTL split of cache_write_tokens where the provider reports it
    // (Claude's usage.cache_creation); null when the split is unknown.
    cache_write_5m_tokens: null,
    cache_write_1h_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
  };
}

export function mergeUsage(target, usage) {
  for (const key of Object.keys(target)) {
    target[key] = addNullable(target[key], usage?.[key]);
  }
  return target;
}

export function stableSessionId(provider, filePath) {
  return createHash("sha256").update(`${provider}:${filePath}`).digest("hex").slice(0, 12);
}

export function commandFingerprint(command) {
  const normalized = String(command || "").trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

// Classifies a shell command IN MEMORY ONLY so patterns can be counted.
// The command text itself must never be persisted or rendered.
export function classifyShellCommand(command) {
  const text = String(command || "").trim();
  if (!text) return { kinds: [] };
  const kinds = [];
  // Anchored to a command position so quoted mentions ("printf 'git
  // commit'") are not classified as commits.
  if (/(^|[|;&]\s*)git\s+commit\b/.test(text)) kinds.push("git_commit");
  if (/(^|[|;&]\s*)grep\b/.test(text) && !/\brg\b/.test(text)) kinds.push("grep_like");
  if (/(^|[|;&]\s*)find\s+\S/.test(text)) kinds.push("find_like");
  if (/(^|[|;&]\s*)cat\s+\S/.test(text) && /(grep|head|tail|less|sed|awk)/.test(text)) kinds.push("cat_search_like");
  const testRunner = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bvitest\b|\bjest\b/.test(text);
  if (testRunner) {
    // A runner invocation with an explicit file/pattern argument counts as
    // focused; a bare invocation counts as a full-suite run.
    const focused = /\.(test|spec)\.[a-z]+/.test(text) || /\s--\s+\S|\s-k\s+\S|--run\s+\S|--filter[= ]\S/.test(text);
    kinds.push(focused ? "focused_test_run" : "full_test_run");
  }
  return { kinds };
}

// Repo-relative rendering only: absolute paths outside the repo collapse to
// an opaque marker so reports never leak arbitrary local paths.
export function normalizeFilePath(rawPath, root) {
  const value = String(rawPath || "").trim();
  if (!value) return null;
  if (!path.isAbsolute(value)) {
    return { path: value.split(path.sep).join("/"), in_repo: true };
  }
  const rel = path.relative(root, value);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    return { path: rel.split(path.sep).join("/"), in_repo: true };
  }
  return { path: "(outside repository)", in_repo: false };
}

export function homeRelative(targetPath) {
  const home = os.homedir();
  const value = String(targetPath || "");
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

export function createSessionSkeleton(provider, filePath) {
  return {
    schema_version: SESSION_ANALYSIS_SCHEMA_VERSION,
    provider,
    session_id: stableSessionId(provider, filePath),
    started_at: null,
    ended_at: null,
    duration_ms: null,
    active_ms: null,
    cwd: null,
    branch: null,
    cli_version: null,
    models: [],
    turns: { user: 0, assistant_requests: 0 },
    usage: emptyUsage(),
    cost: { reported_usd: null, estimated_usd: null, basis: "unavailable", coverage: 0 },
    tools: { calls: 0, by_name: {} },
    file_access: [],
    sidechain_events: 0,
    provider_session_id: null,
    is_sidechain_transcript: false,
    // Filled by the opt-in local-extractive classifier; carries only rule
    // match counts and a label, never prompt text.
    task: { content_mode: "metadata-only", category_hint: null, hint_confidence: 0 },
    outcome: { status: "unknown", evidence: [] },
    failed_tool_calls: 0,
    failed_command_fingerprints: {},
    shell_patterns: { grep_like: 0, find_like: 0, cat_search_like: 0, full_test_run: 0, focused_test_run: 0, opaque_shell_calls: 0 },
    coverage: { lines: 0, malformed_lines: 0, usage_records: 0 },
  };
}

const ACTIVE_GAP_CAP_MS = 5 * 60 * 1000;

// Wall-clock duration plus an "active time" heuristic: inter-event gaps are
// capped at five minutes so an overnight idle session is not counted as work.
export function createTimeTracker() {
  let first = null;
  let last = null;
  let active = 0;
  return {
    observe(timestamp) {
      const ms = Date.parse(String(timestamp || ""));
      if (!Number.isFinite(ms)) return;
      if (first === null || ms < first) first = ms;
      if (last !== null && ms > last) {
        active += Math.min(ms - last, ACTIVE_GAP_CAP_MS);
      }
      if (last === null || ms > last) last = ms;
    },
    finish(session) {
      session.started_at = first !== null ? new Date(first).toISOString() : null;
      session.ended_at = last !== null ? new Date(last).toISOString() : null;
      session.duration_ms = first !== null && last !== null ? last - first : null;
      session.active_ms = first !== null ? active : null;
    },
  };
}

// A shell envelope's exit status only proves what its LAST simple command
// did: pipes and semicolons swallow inner exit codes (`npm test | tail`
// succeeds when tests fail; `git commit || true` always succeeds). Only
// pipe/semicolon-free commands are reliable outcome evidence.
export function outcomeEvidenceReliable(command) {
  return !/[|;]/.test(String(command || ""));
}

// Outcome is inferred only from signals metadata can actually prove: a
// git commit that did not error, how the last test run ended, and an
// uninterrupted run of trailing tool failures. Anything weaker stays
// "unknown" — never a success claim. Order matters: a commit followed by
// a failing test is NOT completed.
export function createOutcomeTracker() {
  let commitsOk = 0;
  let commitsFailed = 0;
  let lastTestOk = null;
  let trailingErrors = 0;
  let seq = 0;
  let lastCommitOkSeq = null;
  let lastTestFailSeq = null;
  return {
    // kinds: classifyShellCommand kinds; ok: whether the provider reported
    // the call as succeeding (null when unknowable); evidenceReliable:
    // whether the envelope's status can be attributed to the matched
    // command (see outcomeEvidenceReliable).
    record(kinds, ok, { evidenceReliable = true } = {}) {
      if (ok === null || ok === undefined) return;
      seq += 1;
      trailingErrors = ok ? 0 : trailingErrors + 1;
      if (!evidenceReliable) return;
      if (kinds.includes("git_commit")) {
        if (ok) {
          commitsOk += 1;
          lastCommitOkSeq = seq;
        } else {
          commitsFailed += 1;
        }
      }
      if (kinds.includes("full_test_run") || kinds.includes("focused_test_run")) {
        lastTestOk = ok;
        if (!ok) lastTestFailSeq = seq;
      }
    },
    finish(session, { writes = 0 } = {}) {
      const evidence = [];
      if (commitsOk > 0) evidence.push({ signal: "git-commit-succeeded", count: commitsOk });
      if (commitsFailed > 0) evidence.push({ signal: "git-commit-failed", count: commitsFailed });
      if (lastTestOk !== null) evidence.push({ signal: lastTestOk ? "last-test-run-passed" : "last-test-run-failed", count: 1 });
      if (trailingErrors >= 3) evidence.push({ signal: "session-ended-in-consecutive-failures", count: trailingErrors });

      const commitStands = lastCommitOkSeq !== null
        && (lastTestFailSeq === null || lastTestFailSeq < lastCommitOkSeq);
      let status = "unknown";
      if (commitStands || (lastTestOk === true && writes > 0)) {
        status = "completed";
      } else if (lastTestOk === false || trailingErrors >= 3) {
        status = "likely-incomplete";
      }
      session.outcome = { status, evidence };
    },
  };
}

export function recordFileAccess(session, seen, entry) {
  const key = `${entry.path} ${entry.operation}`;
  const existing = seen.get(key);
  if (existing) {
    existing.events += 1;
    return;
  }
  const access = { ...entry, events: 1 };
  seen.set(key, access);
  session.file_access.push(access);
}
