import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveContextPolicy, selectWithinBudget } from "./ctx-budget.js";
import { ensureDir, exists, readText, relative } from "./fs.js";
import { resolveLocalAgentifyPaths } from "./project-store.js";
import { redactSensitiveText } from "./redact.js";
import { estimateContextTokens, recordValueEvent } from "./value-telemetry.js";

const MAX_EVENT_LOG_BYTES = 512 * 1024;
const COMPACTED_EVENT_LINES = 1000;
const MAX_FIELD_LENGTH = 200;
const DEFAULT_DIGEST_EVENTS = 400;
const TRACKED_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function resolveContextPaths(root) {
  const agentifyPaths = resolveLocalAgentifyPaths(root);
  const contextRoot = path.join(agentifyPaths.runtimeRoot, "context");
  return {
    contextRoot,
    eventsPath: path.join(contextRoot, "events.jsonl"),
    // Diagnostic side-log for the ACP proxy's `compare` capture mode (#337): it
    // records what the proxy would capture WITHOUT touching events.jsonl, so it
    // can run safely alongside the hooks and feed the fidelity comparison.
    acpCapturePath: path.join(contextRoot, "acp-capture.jsonl"),
    notesPath: path.join(contextRoot, "notes.jsonl"),
    handoffDir: path.join(contextRoot, "handoffs"),
    pausedPath: path.join(contextRoot, "paused"),
    archiveDir: path.join(contextRoot, "archive"),
    injectedPath: path.join(contextRoot, "injected.json"),
    summariesPath: path.join(contextRoot, "summaries.jsonl"),
    summaryUsagePath: path.join(contextRoot, "summary-usage.jsonl"),
    valueEventsPath: path.join(contextRoot, "value-events.jsonl"),
  };
}

export async function isContextPaused(root, env = process.env) {
  if (String(env.AGENTIFY_CTX || "").toLowerCase() === "off") {
    return true;
  }
  return exists(resolveContextPaths(root).pausedPath);
}

export async function pauseContext(root) {
  const paths = resolveContextPaths(root);
  await ensureDir(paths.contextRoot);
  await fs.writeFile(paths.pausedPath, new Date().toISOString(), "utf8");
  return { command: "ctx pause", paused: true, marker: paths.pausedPath };
}

export async function resumeContext(root) {
  const paths = resolveContextPaths(root);
  let wasPaused = false;
  try {
    await fs.unlink(paths.pausedPath);
    wasPaused = true;
  } catch {
    wasPaused = false;
  }
  return { command: "ctx resume", paused: false, was_paused: wasPaused };
}

export async function clearContext(root, options = {}) {
  const paths = resolveContextPaths(root);
  const archived = [];
  if (options.archive !== false) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const targetDir = path.join(paths.archiveDir, stamp);
    for (const [label, sourcePath] of [["events.jsonl", paths.eventsPath], ["acp-capture.jsonl", paths.acpCapturePath], ["notes.jsonl", paths.notesPath], ["summaries.jsonl", paths.summariesPath], ["summary-usage.jsonl", paths.summaryUsagePath], ["value-events.jsonl", paths.valueEventsPath]]) {
      if (await exists(sourcePath)) {
        await ensureDir(targetDir);
        await fs.rename(sourcePath, path.join(targetDir, label));
        archived.push(relative(root, path.join(targetDir, label)));
      }
    }
  } else {
    await fs.rm(paths.eventsPath, { force: true });
    await fs.rm(paths.acpCapturePath, { force: true });
    await fs.rm(paths.notesPath, { force: true });
    await fs.rm(paths.summariesPath, { force: true });
    await fs.rm(paths.summaryUsagePath, { force: true });
    await fs.rm(paths.valueEventsPath, { force: true });
  }
  await fs.rm(paths.injectedPath, { force: true });
  return {
    command: "ctx clear",
    archived,
    archive_dir: archived.length > 0 ? paths.archiveDir : null,
  };
}

function clip(value, max = MAX_FIELD_LENGTH) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function shortSessionId(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 8) : "unknown";
}

const COMMAND_SEGMENT_SPLIT = /\s*(?:\|\||&&|;|\|)\s*/;
const ENV_ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMMAND_WRAPPER_TOKENS = new Set(["sudo"]);

// A deterministic, whitespace/argument-insensitive fingerprint of a shell
// command: the binary basename + first subcommand + the sorted set of flag
// NAMES (values dropped). Only the first pipeline/boolean segment is used, so
// `foo bar | grep x` and `foo bar | grep y` share a signature. Env-var prefixes
// (FOO=bar) and `sudo` are stripped. Exported for tests.
export function normalizeCommandSignature(command) {
  const segments = String(command ?? "")
    .split(COMMAND_SEGMENT_SPLIT)
    .filter((segment) => segment.trim().length > 0);
  const first = (segments[0] || "").trim();
  if (!first) {
    return "";
  }
  // Signatures are computed over the REDACTED command (review: a signature
  // derived from the raw text stored `curl https://user:secret@host` secrets
  // verbatim in events.jsonl and ledger keys while `cmd` was redacted).
  // Precheck normalizes the incoming command through this same function, so
  // both sides redact identically and matching is unaffected.
  let tokens = redactSensitiveText(first).split(/\s+/).filter(Boolean);
  while (tokens.length > 0 && (ENV_ASSIGNMENT_TOKEN.test(tokens[0]) || COMMAND_WRAPPER_TOKENS.has(tokens[0]))) {
    tokens = tokens.slice(1);
  }
  if (tokens.length === 0) {
    return "";
  }
  const bin = tokens[0].split("/").pop();
  let subcommand = "";
  const flags = new Set();
  let ambiguousSubcommand = false;
  let previousWasBareFlag = false;
  for (const token of tokens.slice(1)) {
    if (token.startsWith("-")) {
      // Flag name only: `--budget=5` -> `--budget`; a bare `-` is ignored.
      const name = token.split("=")[0];
      if (name.length > 1) {
        flags.add(name);
      }
      previousWasBareFlag = !token.includes("=");
    } else if (!subcommand && !previousWasBareFlag) {
      // First non-flag token is the subcommand.
      subcommand = token;
      previousWasBareFlag = false;
    } else {
      if (!subcommand && previousWasBareFlag) {
        // This token follows a bare flag before any subcommand was found: it
        // could be the flag's VALUE or the subcommand itself (`npm --silent
        // test` vs `git -C /repo status` parse identically without per-tool
        // flag specs) — the whole signature is ambiguous.
        ambiguousSubcommand = true;
      }
      previousWasBareFlag = false;
    }
  }
  // Ambiguity is fail-safe (PR #373 review): a warning about an unrelated
  // command is worse than no warning, so an ambiguous command opts out of
  // the signature tier entirely (exact-match precheck still covers it).
  if (ambiguousSubcommand) {
    return "";
  }
  const parts = [bin];
  if (subcommand) {
    parts.push(subcommand);
  }
  return [...parts, ...[...flags].sort()].join(" ");
}

// Whether the raw command chains more than one pipeline/boolean segment; the
// signature only reflects the first, so we record this on the stored event.
function commandHasMultipleSegments(command) {
  return String(command ?? "")
    .split(COMMAND_SEGMENT_SPLIT)
    .filter((segment) => segment.trim().length > 0)
    .length > 1;
}

async function appendJsonLine(targetPath, record) {
  await ensureDir(path.dirname(targetPath));
  await fs.appendFile(targetPath, `${JSON.stringify(record)}\n`, "utf8");
}

async function readJsonLines(targetPath) {
  if (!(await exists(targetPath))) {
    return [];
  }
  const raw = await readText(targetPath);
  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      // Valid JSON that is not an object (null, numbers, arrays) would blow
      // up downstream field access; skip it like a corrupt line.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed);
      }
    } catch {
      // Skip corrupt lines rather than failing hook execution.
    }
  }
  return records;
}

async function compactEventLogIfNeeded(eventsPath) {
  let stat;
  try {
    stat = await fs.stat(eventsPath);
  } catch {
    return false;
  }
  if (stat.size <= MAX_EVENT_LOG_BYTES) {
    return false;
  }
  const records = await readJsonLines(eventsPath);
  const kept = records.slice(-COMPACTED_EVENT_LINES);
  const payload = kept.map((record) => JSON.stringify(record)).join("\n");
  await fs.writeFile(eventsPath, payload ? `${payload}\n` : "", "utf8");
  return true;
}

export function detectCommandFailure(toolResponse) {
  const response = toolResponse && typeof toolResponse === "object" && !Array.isArray(toolResponse) ? toolResponse : null;
  if (!response) {
    return null;
  }
  const exitCode = [response.exit_code, response.exitCode, response.code].find((value) => typeof value === "number");
  const failed = response.success === false
    || response.is_error === true
    || response.isError === true
    || (typeof exitCode === "number" && exitCode !== 0);
  if (!failed) {
    return null;
  }
  const snippet = String(response.stderr || response.error || response.stdout || "").trim();
  return { exitCode: typeof exitCode === "number" ? exitCode : null, snippet };
}

export function buildEventFromHookPayload(root, payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const base = {
    ts: new Date().toISOString(),
    sid: shortSessionId(payload.session_id),
  };

  const hookEvent = String(payload.hook_event_name || "");
  if (hookEvent === "SessionEnd") {
    return { ...base, type: "session_end", reason: clip(payload.reason || "", 60) };
  }

  if (hookEvent !== "PostToolUse") {
    return null;
  }

  const toolName = String(payload.tool_name || "");
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};

  if (TRACKED_EDIT_TOOLS.has(toolName)) {
    const filePath = toolInput.file_path || toolInput.notebook_path;
    if (!filePath) {
      return null;
    }
    return { ...base, type: "edit", path: relative(root, path.resolve(root, String(filePath))) };
  }

  if (toolName === "Bash") {
    if (!toolInput.command) {
      return null;
    }
    const failure = detectCommandFailure(payload.tool_response);
    const signature = normalizeCommandSignature(toolInput.command);
    return {
      ...base,
      type: "cmd",
      cmd: clip(redactSensitiveText(toolInput.command)),
      ...(signature ? { sig: signature } : {}),
      ...(commandHasMultipleSegments(toolInput.command) ? { multi: true } : {}),
      ...(toolInput.description ? { desc: clip(redactSensitiveText(toolInput.description), 100) } : {}),
      ...(failure
        ? {
          fail: true,
          ...(failure.exitCode !== null ? { exit: failure.exitCode } : {}),
          ...(failure.snippet ? { err: clip(redactSensitiveText(failure.snippet)) } : {}),
        }
        : {}),
    };
  }

  return null;
}

export async function trackEvent(root, payload) {
  if (await isContextPaused(root)) {
    return { tracked: false, event: null, paused: true };
  }
  const event = buildEventFromHookPayload(root, payload);
  if (!event) {
    return { tracked: false, event: null };
  }
  const paths = resolveContextPaths(root);
  await appendJsonLine(paths.eventsPath, event);
  const compacted = await compactEventLogIfNeeded(paths.eventsPath);
  return { tracked: true, event, compacted };
}

// Record an event captured from the proxied ACP stream (#337) through the SAME
// events schema and write path the hooks use — buildEventFromHookPayload does
// the edit/cmd shaping, path-relativizing, command redaction, and failure
// detection, so redaction is applied before anything is written and there is no
// second storage format. Captured events are tagged `src: "acp"` (and, where the
// effect was only inferred from an opaque wrapper, `confidence: "inferred"`) so
// they are distinguishable from hook events for the fidelity comparison.
//
// Crucially this path checks the pause marker itself: `addNote` historically
// ignored pause, so routing capture through a pause-aware writer is what makes
// `agentify ctx pause` genuinely suppress proxy capture. `sink: "compare"`
// diverts the write to the diagnostic side-log instead of events.jsonl.
export async function recordCapturedEvent(root, payload, options = {}) {
  if (await isContextPaused(root, options.env || process.env)) {
    return null;
  }
  const event = buildEventFromHookPayload(root, payload);
  if (!event) {
    return null;
  }
  // Privacy backstop: never record a file outside the launch repo, however the
  // session was scoped (a session/new may add workspace roots beyond cwd). The
  // path here is already repo-relative; if its first segment is ".." (or it is
  // absolute) it points outside the repo, so drop it rather than write a
  // `../other-repo/...` edit. A leading segment like "..config" is a real
  // in-repo file and must NOT be rejected.
  if (event.type === "edit" && (event.path.split(/[/\\]/)[0] === ".." || path.isAbsolute(event.path))) {
    return null;
  }
  event.src = "acp";
  if (String(options.confidence || "observed") === "inferred") {
    event.confidence = "inferred";
  }
  const paths = resolveContextPaths(root);
  const targetPath = options.sink === "compare" ? paths.acpCapturePath : paths.eventsPath;
  await appendJsonLine(targetPath, event);
  await compactEventLogIfNeeded(targetPath);
  return event;
}

// Read the two event sources the fidelity comparison contrasts: events written
// by the hooks (events.jsonl entries NOT tagged src:"acp") and events captured
// by the proxy (the compare side-log, plus any src:"acp" events an `all`-mode
// run wrote into the main store).
export async function readCaptureComparison(root) {
  const paths = resolveContextPaths(root);
  const mainEvents = await readJsonLines(paths.eventsPath);
  const proxyFromLog = await readJsonLines(paths.acpCapturePath);
  return {
    hookEvents: mainEvents.filter((event) => event.src !== "acp"),
    proxyEvents: [...proxyFromLog, ...mainEvents.filter((event) => event.src === "acp")],
  };
}

export const NOTE_TYPES = ["note", "decision"];

export async function addNote(root, text, options = {}) {
  const note = String(text || "").trim();
  if (!note) {
    throw new Error("ctx note requires non-empty text");
  }
  const type = String(options.type || "note").trim().toLowerCase();
  if (!NOTE_TYPES.includes(type)) {
    throw new Error(`Unknown note type "${options.type}". Supported: ${NOTE_TYPES.join(", ")}`);
  }
  const record = {
    ts: new Date().toISOString(),
    sid: shortSessionId(options.session || process.env.CLAUDE_SESSION_ID || ""),
    ...(type !== "note" ? { type } : {}),
    note: note.length > 2000 ? `${note.slice(0, 1999)}…` : note,
  };
  const paths = resolveContextPaths(root);
  await appendJsonLine(paths.notesPath, record);
  return { path: paths.notesPath, record };
}

export async function listDecisions(root, query, options = {}) {
  const paths = resolveContextPaths(root);
  const notes = await readJsonLines(paths.notesPath);
  const rawDecisions = notes.filter((note) => note.type === "decision");
  const decisions = options.verifyNotes === false ? rawDecisions : await annotateNoteStaleness(root, rawDecisions);

  const trimmedQuery = String(query || "").trim();
  if (!trimmedQuery) {
    return { decisions, query: null };
  }

  const promptTokens = tokenizeForMatch(trimmedQuery);
  const docs = decisions.map((decision, position) => ({ decision, position, counts: termCounts(decision.note) }));
  const index = buildBm25Index(docs.map((doc) => doc.counts));
  const matched = [];
  for (const doc of docs) {
    const { score, matched: matchedTerms } = bm25Match(promptTokens, doc.counts, index);
    if (matchedTerms.length >= 1) {
      matched.push({ decision: doc.decision, position: doc.position, score });
    }
  }
  // Relevance first, then NEWEST first. The tie-break is not cosmetic: a broad
  // query (a match on a single token is enough) scores many decisions equally,
  // and callers cap the list by taking the head — renderDecisions and the
  // ctx_decisions MCP tool both do. `decisions` arrives in append order, so a
  // stable score-only sort left ties oldest-first and the cap then dropped the
  // newest, potentially superseding, decision. That is the opposite of the
  // documented most-relevant-then-newest policy.
  matched.sort((left, right) => right.score - left.score || right.position - left.position);
  return { decisions: matched.map((item) => item.decision), query: trimmedQuery };
}

// Renders a listDecisions() result as plain text, reusing the same per-decision
// line format as the context digest so the surface reads identically whether a
// decision arrives via `ctx load`, `ctx decisions`, or the MCP tool. Empty
// results return a useful message instead of an empty string.
//
// Optional `limit` (item count) and `maxChars` (rendered size) bound the block
// so neither a common topic (listDecisions admits a match on a single token),
// an untargeted listing, nor a handful of very long notes can flood a caller's
// context — a note may be up to ~2000 chars, so a count cap alone is not a size
// cap. Entries are kept in priority order — most-relevant-then-newest for a
// topic query, newest for an untargeted listing — so truncation only ever drops
// the least useful decisions, and at least one is always shown. Any truncation
// is reported. Display order stays relevance-first for a query and chronological
// for a listing, matching `ctx load`.
export function renderDecisions(result, options = {}) {
  const decisions = result?.decisions || [];
  const query = result?.query ? String(result.query).trim() : "";
  // Clip the echoed topic so an oversized query string cannot itself blow the
  // response budget through the heading or the empty-result message.
  const shownQuery = clip(query, 120);
  if (decisions.length === 0) {
    return query
      ? `No decisions recorded for "${shownQuery}".`
      : "No decisions recorded yet.";
  }
  const maxItems = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : decisions.length;
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : Infinity;

  // A topic query already arrives relevance-ranked (ties newest-first); an
  // untargeted listing is chronological, so newest is most important.
  const byPriority = query ? decisions : [...decisions].reverse();
  const chosen = [];
  let usedChars = 0;
  for (const decision of byPriority) {
    if (chosen.length >= maxItems) {
      break;
    }
    const lineChars = noteLine(decision).length + 1;
    // Always keep the single most important decision, even if it alone exceeds
    // the size budget — an empty body would be worse than one oversized line.
    if (chosen.length > 0 && usedChars + lineChars > maxChars) {
      break;
    }
    chosen.push(decision);
    usedChars += lineChars;
  }

  const shown = query ? chosen : [...chosen].reverse();
  const heading = query ? `Decisions matching "${shownQuery}":` : "Decisions on record:";
  const lines = [heading, ...shown.map((decision) => noteLine(decision))];
  const hidden = decisions.length - shown.length;
  if (hidden > 0) {
    lines.push(query
      ? `… and ${hidden} more match; refine the topic to narrow.`
      : `… and ${hidden} more not shown; pass a topic to narrow.`);
  }
  return lines.join("\n");
}

function summarizeEvents(events) {
  const editCounts = new Map();
  const commands = [];
  const commandOutcomes = new Map();
  let lastEventAt = null;
  const sessions = new Set();

  for (const event of events) {
    if (event?.ts) {
      lastEventAt = event.ts;
    }
    if (event?.sid) {
      sessions.add(event.sid);
    }
    if (event?.type === "edit" && event.path) {
      editCounts.set(event.path, (editCounts.get(event.path) || 0) + 1);
    } else if (event?.type === "cmd" && event.cmd) {
      commands.push(event);
      const entry = commandOutcomes.get(event.cmd) || { failCount: 0 };
      entry.last = event;
      if (event.fail) {
        entry.failCount += 1;
      }
      commandOutcomes.set(event.cmd, entry);
    }
  }

  const hotFiles = [...editCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([file, count]) => ({ file, edits: count }));

  // A failure is "unresolved" when the most recent run of that exact command failed.
  const unresolvedFailures = [...commandOutcomes.values()]
    .filter((entry) => entry.last.fail)
    .sort((left, right) => String(right.last.ts || "").localeCompare(String(left.last.ts || "")))
    .slice(0, 5)
    .map((entry) => ({
      cmd: entry.last.cmd,
      ts: entry.last.ts,
      sid: entry.last.sid,
      failCount: entry.failCount,
      ...(entry.last.exit !== undefined ? { exit: entry.last.exit } : {}),
      ...(entry.last.err ? { err: entry.last.err } : {}),
    }));

  return {
    hotFiles,
    recentCommands: commands.slice(-5),
    unresolvedFailures,
    lastEventAt,
    sessionCount: sessions.size,
    eventCount: events.length,
  };
}

function renderFailureLine(item) {
  const parts = [`\`${item.cmd}\``];
  if (item.exit !== undefined) {
    parts.push(`(exit ${item.exit})`);
  }
  if (item.failCount > 1) {
    parts.push(`failed ${item.failCount}x`);
  }
  const head = parts.join(" ");
  return item.err ? `${head} — ${item.err}` : head;
}

// Matches repo-relative path references like src/pay/retry.ts inside note text.
const NOTE_PATH_REF_PATTERN = /(?:^|[\s`("'[])((?:[\w.-]+\/)+[\w.-]+\.\w{1,8})/g;
const MAX_NOTE_PATH_REFS = 8;

export function extractNotePathRefs(text) {
  const refs = new Set();
  for (const match of String(text || "").matchAll(NOTE_PATH_REF_PATTERN)) {
    const ref = match[1].replace(/[.,;:!?)\]]+$/, "");
    if (ref.includes("/") && !ref.startsWith("http")) {
      refs.add(ref);
    }
    if (refs.size >= MAX_NOTE_PATH_REFS) {
      break;
    }
  }
  return [...refs];
}

// Persistent memory's biggest failure mode is a confidently-wrong stale note.
// Any note that references files that no longer exist gets flagged so the
// agent re-verifies instead of trusting it.
async function annotateNoteStaleness(root, notes) {
  const cache = new Map();
  const annotated = [];
  for (const note of notes) {
    const refs = extractNotePathRefs(note.note);
    const missing = [];
    for (const ref of refs) {
      if (!cache.has(ref)) {
        cache.set(ref, await exists(path.join(root, ref)));
      }
      if (!cache.get(ref)) {
        missing.push(ref);
      }
    }
    annotated.push(missing.length > 0 ? { ...note, stale_refs: missing } : note);
  }
  return annotated;
}

function noteLine(note) {
  const typePrefix = note.type === "decision" ? "[decision] " : "";
  const staleSuffix = Array.isArray(note.stale_refs) && note.stale_refs.length > 0
    ? ` — STALE? references missing path(s): ${note.stale_refs.join(", ")}; verify before trusting`
    : "";
  return `- [${String(note.ts || "").slice(0, 10)}] ${typePrefix}${note.note}${staleSuffix}`;
}

export async function loadContextSnapshot(root, options = {}) {
  const paths = resolveContextPaths(root);
  const events = (await readJsonLines(paths.eventsPath)).slice(-(options.maxEvents || DEFAULT_DIGEST_EVENTS));
  const rawNotes = (await readJsonLines(paths.notesPath)).slice(-(options.maxNotes || 10));
  const notes = options.verifyNotes === false ? rawNotes : await annotateNoteStaleness(root, rawNotes);
  const sessionSummaries = (await readJsonLines(paths.summariesPath)).slice(-(options.maxSummaries || 5));
  return { events, notes, sessionSummaries, summary: summarizeEvents(events) };
}

export function renderContextDigest(snapshot) {
  const { summary, notes } = snapshot;
  const sessionSummaries = snapshot.sessionSummaries || [];
  if (summary.eventCount === 0 && notes.length === 0 && sessionSummaries.length === 0) {
    return "";
  }

  const lines = ["## Agentify context (from previous sessions)"];
  if (summary.lastEventAt) {
    lines.push(`Last tracked activity: ${summary.lastEventAt} across ${summary.sessionCount} session(s), ${summary.eventCount} recent event(s).`);
  }

  if (sessionSummaries.length > 0) {
    lines.push("", "### What recent sessions did");
    for (const item of sessionSummaries.slice(-3)) {
      lines.push(`- [${String(item.ts || "").slice(0, 10)}] ${item.summary}`);
    }
  }

  const decisions = notes.filter((note) => note.type === "decision");
  const plainNotes = notes.filter((note) => note.type !== "decision");

  if (decisions.length > 0) {
    lines.push("", "### Decisions on record (query with `agentify ctx decisions \"<topic>\"`)");
    for (const note of decisions.slice(-5)) {
      lines.push(noteLine(note));
    }
  }

  if (plainNotes.length > 0) {
    lines.push("", "### Notes left for this session");
    for (const note of plainNotes) {
      lines.push(noteLine(note));
    }
  }

  if (summary.hotFiles.length > 0) {
    lines.push("", "### Recently edited files");
    for (const item of summary.hotFiles) {
      lines.push(`- ${item.file} (${item.edits} edit${item.edits === 1 ? "" : "s"})`);
    }
  }

  if (summary.unresolvedFailures.length > 0) {
    lines.push("", "### Commands that failed and were not retried successfully");
    for (const item of summary.unresolvedFailures) {
      lines.push(`- [${String(item.ts || "").slice(0, 10)}] ${renderFailureLine(item)}`);
    }
  }

  if (summary.recentCommands.length > 0) {
    lines.push("", "### Recent commands");
    for (const command of summary.recentCommands) {
      lines.push(`- ${command.desc ? `${command.desc}: ` : ""}\`${command.cmd}\``);
    }
  }

  return lines.join("\n");
}

export async function recordContextDigestInjection(root, snapshot, digest, options = {}) {
  if (!digest) {
    return null;
  }
  const notes = snapshot.notes || [];
  // Keep telemetry aligned with renderContextDigest's visible slice limits.
  const renderedNotes = [
    ...notes.filter((note) => note.type === "decision").slice(-5),
    ...notes.filter((note) => note.type !== "decision"),
  ];
  const freshNotes = renderedNotes.filter((note) => !Array.isArray(note.stale_refs) || note.stale_refs.length === 0);
  const staleNotes = renderedNotes.filter((note) => Array.isArray(note.stale_refs) && note.stale_refs.length > 0);
  const decisions = freshNotes.filter((note) => note.type === "decision");
  const summaries = (snapshot.sessionSummaries || []).slice(-3);
  const hotFiles = snapshot.summary?.hotFiles || [];
  const failures = snapshot.summary?.unresolvedFailures || [];
  try {
    return await recordValueEvent(root, {
      type: "context_injection",
      mode: "digest",
      sid: shortSessionId(options.sessionId),
      estimated_tokens: estimateContextTokens(digest),
      injected_items: renderedNotes.length + summaries.length + hotFiles.length + failures.length,
      decisions_reused: decisions.length,
      stale_context_rejected: 0,
      reasons: {
        previous_decision: decisions.length,
        previous_note: freshNotes.length - decisions.length,
        session_summary: summaries.length,
        hot_file: hotFiles.length,
        previous_failure: failures.length,
        stale_warning: staleNotes.length,
      },
    });
  } catch {
    // Context output must never depend on value telemetry.
    return null;
  }
}

export async function contextStatus(root) {
  const paths = resolveContextPaths(root);
  const snapshot = await loadContextSnapshot(root, { maxEvents: DEFAULT_DIGEST_EVENTS, maxNotes: 1000 });

  let eventLogBytes = 0;
  try {
    eventLogBytes = (await fs.stat(paths.eventsPath)).size;
  } catch {
    eventLogBytes = 0;
  }

  return {
    command: "ctx status",
    paused: await isContextPaused(root),
    events_path: paths.eventsPath,
    notes_path: paths.notesPath,
    event_count: snapshot.summary.eventCount,
    note_count: snapshot.notes.length,
    stale_note_count: snapshot.notes.filter((note) => Array.isArray(note.stale_refs) && note.stale_refs.length > 0).length,
    session_count: snapshot.summary.sessionCount,
    last_event_at: snapshot.summary.lastEventAt,
    event_log_bytes: eventLogBytes,
    hot_files: snapshot.summary.hotFiles,
    unresolved_failures: snapshot.summary.unresolvedFailures,
  };
}

export async function writeHandoff(root, options = {}) {
  const paths = resolveContextPaths(root);
  const snapshot = await loadContextSnapshot(root, { maxNotes: 50 });
  const now = new Date().toISOString();
  const task = String(options.task || "").trim();

  const lines = [
    `# Agentify handoff — ${now}`,
    "",
    task ? `Task: ${task}` : "Task: (not specified)",
    "",
  ];
  const digest = renderContextDigest(snapshot);
  lines.push(digest || "No tracked context yet.");

  const markdown = `${lines.join("\n")}\n`;
  const fileName = `handoff-${now.replace(/[:.]/g, "-")}.md`;
  const targetPath = path.join(paths.handoffDir, fileName);
  await ensureDir(paths.handoffDir);
  await fs.writeFile(targetPath, markdown, "utf8");

  return {
    command: "ctx handoff",
    path: targetPath,
    relative_path: relative(root, targetPath),
    markdown,
  };
}

export async function readHookPayload(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString("utf8").trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const INJECTION_MODES = ["relevant", "digest", "off"];
const MATCH_STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "what",
  "where", "how", "why", "can", "could", "should", "would", "please", "make",
  "add", "fix", "use", "using", "you", "your", "our", "are", "not", "but",
  "then", "than", "them", "there", "here", "also", "just", "need", "want",
  "let", "lets", "get", "got", "has", "have", "had", "was", "were", "will",
  "does", "did", "doing", "done", "about", "some", "any", "all", "one",
  "file", "files", "code", "issue", "change", "changes", "update",
]);
const MAX_INJECTION_SESSIONS = 30;

export function normalizeInjectionMode(value, { fallback = "relevant" } = {}) {
  const mode = String(value ?? fallback).trim().toLowerCase();
  return INJECTION_MODES.includes(mode) ? mode : fallback;
}

// Light stemmer so "retries" matches "retry" and "configs" matches "config"
// without dragging in a real stemming library.
function lightStem(token) {
  if (token.length > 4 && token.endsWith("ies")) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us") && !token.endsWith("is")) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenListForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !MATCH_STOP_WORDS.has(token))
    .map(lightStem);
}

export function tokenizeForMatch(text) {
  return new Set(tokenListForMatch(text));
}

function termCounts(text) {
  const counts = new Map();
  for (const token of tokenListForMatch(text)) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

// BM25 over the whole context corpus (notes, summaries, files, failures), so
// rare terms weigh more than common ones and long notes don't win by volume.
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function buildBm25Index(docCountMaps) {
  const documentFrequency = new Map();
  let totalLength = 0;
  for (const counts of docCountMaps) {
    let length = 0;
    for (const [term, count] of counts) {
      length += count;
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
    totalLength += length;
  }
  const documentCount = Math.max(1, docCountMaps.length);
  const averageLength = Math.max(1, totalLength / documentCount);
  return {
    averageLength,
    idf(term) {
      const df = documentFrequency.get(term) || 0;
      return Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
    },
  };
}

function bm25Match(promptTokens, docCounts, index) {
  let docLength = 0;
  for (const count of docCounts.values()) {
    docLength += count;
  }
  let score = 0;
  const matched = [];
  for (const term of promptTokens) {
    const termFrequency = docCounts.get(term) || 0;
    if (termFrequency === 0) {
      continue;
    }
    matched.push(term);
    const normalized = (termFrequency * (BM25_K1 + 1))
      / (termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / index.averageLength)));
    score += index.idf(term) * normalized;
  }
  return { score, matched };
}

// Two overlapping stems, or one distinctive (long) token, marks relevance.
function passesRelevanceBar(matched) {
  return matched.length >= 2 || matched.some((token) => token.length >= 8);
}

export function matchSnapshotToPrompt(snapshot, prompt) {
  const promptTokens = tokenizeForMatch(prompt);
  if (promptTokens.size === 0) {
    return { notes: [], summaries: [], files: [], failures: [] };
  }

  const noteDocs = snapshot.notes.map((note) => ({ note, counts: termCounts(note.note) }));
  const summaryDocs = (snapshot.sessionSummaries || []).map((item) => ({ item, counts: termCounts(item.summary) }));
  const fileDocs = (snapshot.summary.hotFiles || []).map((item) => ({ item, counts: termCounts(item.file) }));
  const failureDocs = (snapshot.summary.unresolvedFailures || []).map((item) => ({
    item,
    counts: termCounts(`${item.cmd} ${item.err || ""}`),
  }));

  const index = buildBm25Index([
    ...noteDocs.map((doc) => doc.counts),
    ...summaryDocs.map((doc) => doc.counts),
    ...fileDocs.map((doc) => doc.counts),
    ...failureDocs.map((doc) => doc.counts),
  ]);

  const notes = [];
  for (const doc of noteDocs) {
    const { score, matched } = bm25Match(promptTokens, doc.counts, index);
    if (passesRelevanceBar(matched)) {
      notes.push({ key: `note:${doc.note.ts}`, note: doc.note, score });
    }
  }
  notes.sort((left, right) => right.score - left.score);

  const sessionSummaries = [];
  for (const doc of summaryDocs) {
    const { score, matched } = bm25Match(promptTokens, doc.counts, index);
    if (passesRelevanceBar(matched)) {
      sessionSummaries.push({ key: `sum:${doc.item.ts}`, item: doc.item, score });
    }
  }
  sessionSummaries.sort((left, right) => right.score - left.score);

  const files = [];
  for (const doc of fileDocs) {
    const { score, matched } = bm25Match(promptTokens, doc.counts, index);
    if (matched.length >= 1) {
      files.push({ key: `file:${doc.item.file}`, file: doc.item.file, edits: doc.item.edits, score });
    }
  }
  files.sort((left, right) => right.score - left.score);

  const failures = [];
  for (const doc of failureDocs) {
    const { score, matched } = bm25Match(promptTokens, doc.counts, index);
    if (passesRelevanceBar(matched)) {
      failures.push({ key: `fail:${doc.item.cmd}`, failure: doc.item, score });
    }
  }
  failures.sort((left, right) => right.score - left.score);

  return {
    notes: notes.slice(0, 5),
    summaries: sessionSummaries.slice(0, 3),
    files: files.slice(0, 8),
    failures: failures.slice(0, 3),
  };
}

async function readInjectionLedger(root) {
  const paths = resolveContextPaths(root);
  if (!(await exists(paths.injectedPath))) {
    return {};
  }
  try {
    const parsed = JSON.parse(await readText(paths.injectedPath));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeInjectionLedger(root, ledger) {
  const paths = resolveContextPaths(root);
  const sids = Object.keys(ledger);
  if (sids.length > MAX_INJECTION_SESSIONS) {
    for (const sid of sids.slice(0, sids.length - MAX_INJECTION_SESSIONS)) {
      delete ledger[sid];
    }
  }
  await ensureDir(paths.contextRoot);
  await fs.writeFile(paths.injectedPath, `${JSON.stringify(ledger)}\n`, "utf8");
}

const MATCH_DIGEST_HEADER = "## Agentify context (relevant to this task)";
const MATCH_DIGEST_FOOTER = "Full history: `agentify ctx load`.";
const MATCH_SECTION_HEADERS = {
  failures: "### Related commands that previously failed (avoid repeating as-is)",
  summaries: "### Related past sessions",
  notes: "### Related notes from earlier sessions",
  files: "### Files previously worked on that look related",
};

// Scaffolding charged against the injection budget so the FULL rendered block
// honors the cap, not just the item lines. Per-line newline separators round
// away at ~4 chars/token; the render backstop in computeMatchSelection covers
// any residual estimation drift.
const MATCH_RENDER_OVERHEAD = {
  base: estimateContextTokens(`${MATCH_DIGEST_HEADER}\n\n${MATCH_DIGEST_FOOTER}`),
  sections: Object.fromEntries(Object.entries(MATCH_SECTION_HEADERS)
    .map(([section, header]) => [section, estimateContextTokens(`\n${header}\n`)])),
};

function summaryLine(item) {
  return `- [${String(item.ts || "").slice(0, 10)}] ${item.summary}`;
}

function fileLine(item) {
  return `- ${item.file} (${item.edits} edit${item.edits === 1 ? "" : "s"})`;
}

function failureDigestLine(failure) {
  return `- [${String(failure.ts || "").slice(0, 10)}] ${renderFailureLine(failure)}`;
}

export function renderMatchDigest(matches) {
  const summaries = matches.summaries || [];
  const failures = matches.failures || [];
  if (matches.notes.length === 0 && matches.files.length === 0 && summaries.length === 0 && failures.length === 0) {
    return "";
  }
  // Deterministic section order and per-item `line` reuse keep the rendered
  // block byte-stable for a given selection — prompt caching is
  // prefix-sensitive, so identical state must render identically.
  const lines = [MATCH_DIGEST_HEADER];
  if (failures.length > 0) {
    lines.push("", MATCH_SECTION_HEADERS.failures);
    for (const item of failures) {
      lines.push(item.line || failureDigestLine(item.failure));
    }
  }
  if (summaries.length > 0) {
    lines.push("", MATCH_SECTION_HEADERS.summaries);
    for (const item of summaries) {
      lines.push(item.line || summaryLine(item.item));
    }
  }
  if (matches.notes.length > 0) {
    lines.push("", MATCH_SECTION_HEADERS.notes);
    for (const item of matches.notes) {
      lines.push(item.line || noteLine(item.note));
    }
  }
  if (matches.files.length > 0) {
    lines.push("", MATCH_SECTION_HEADERS.files);
    for (const item of matches.files) {
      lines.push(item.line || fileLine(item));
    }
  }
  lines.push("", MATCH_DIGEST_FOOTER);
  return lines.join("\n");
}

// Shared match → candidates → budgeted selection → rendered digest pipeline
// behind both matchContext (records) and explainContext (never records).
async function computeMatchSelection(root, prompt, options = {}) {
  const startedAt = Date.now();
  const sid = String(options.sessionId || "unknown").slice(0, 8);
  // Candidate window: BM25 must see the WHOLE practical store, not just the
  // newest notes — a months-old decision buried under newer notes is exactly
  // what per-task retrieval exists to resurface (the store-size ladder
  // exposed the old 100-note cutoff: at 300 notes the needle usually could
  // not even become a candidate). 1000 matches the digest path's bound;
  // scoring a thousand short notes is microseconds.
  const snapshot = await loadContextSnapshot(root, { maxNotes: options.maxNotes || 1000 });
  const matches = matchSnapshotToPrompt(snapshot, prompt);
  const ledger = await readInjectionLedger(root);
  const seen = new Set(Array.isArray(ledger[sid]) ? ledger[sid] : []);

  // Candidate order here is the render order (sections, score-ranked within
  // each): the selector preserves it for the selected set.
  const candidates = [];
  for (const item of matches.failures || []) {
    candidates.push({ key: item.key, type: "failure", score: item.score, ts: item.failure.ts, stale: false, seen: seen.has(item.key), line: failureDigestLine(item.failure), item });
  }
  for (const item of matches.summaries || []) {
    candidates.push({ key: item.key, type: "summary", score: item.score, ts: item.item?.ts, stale: false, seen: seen.has(item.key), line: summaryLine(item.item), item });
  }
  for (const item of matches.notes) {
    // Stale notes remain visible in the manual full digest, but task-scoped
    // injection rejects them so a missing file reference cannot steer new work.
    const stale = Array.isArray(item.note?.stale_refs) && item.note.stale_refs.length > 0;
    candidates.push({ key: item.key, type: item.note?.type === "decision" ? "decision" : "note", score: item.score, ts: item.note?.ts, stale, seen: seen.has(item.key), line: noteLine(item.note), item });
  }
  for (const item of matches.files) {
    candidates.push({ key: item.key, type: "file", score: item.score, ts: null, stale: false, seen: seen.has(item.key), line: fileLine(item), item });
  }

  // Zero-match fast path: no candidates means no dynamic context block, no
  // ledger write, no telemetry — and no policy/evidence lookup either.
  if (candidates.length === 0 && options.explain !== true) {
    return {
      sid,
      policy: null,
      selection: { selected: [], candidates: [], used_tokens: 0, max_tokens: null },
      injected: { notes: [], summaries: [], files: [], failures: [] },
      digest: "",
      rendered_tokens: 0,
      match_ms: Date.now() - startedAt,
    };
  }

  const policy = options.policy || await resolveContextPolicy(root, options.config || {}, { env: options.env, profile: options.profile });
  const selection = selectWithinBudget({
    candidates,
    maxTokens: policy.max_injected_tokens,
    minScore: policy.min_score,
    maxAgeDays: policy.max_age_days,
    reserves: policy.reserves,
    overhead: MATCH_RENDER_OVERHEAD,
  });

  const toInjected = () => {
    const injected = { notes: [], summaries: [], files: [], failures: [] };
    for (const candidate of selection.selected) {
      if (candidate.type === "failure") {
        injected.failures.push({ key: candidate.key, failure: candidate.item.failure, score: candidate.score, line: candidate.line });
      } else if (candidate.type === "summary") {
        injected.summaries.push({ key: candidate.key, item: candidate.item.item, score: candidate.score, line: candidate.line });
      } else if (candidate.type === "file") {
        injected.files.push({ key: candidate.key, file: candidate.item.file, edits: candidate.item.edits, score: candidate.score, line: candidate.line });
      } else {
        injected.notes.push({ key: candidate.key, note: candidate.item.note, score: candidate.score, line: candidate.line });
      }
    }
    return injected;
  };

  let injected = toInjected();
  let digest = renderMatchDigest(injected);
  // Render backstop: the selector charges scaffolding overhead, but the token
  // estimate is chars-based, so enforce the cap on the actual rendered block.
  // Drops the lowest value-per-token item first, deterministically.
  const density = (candidate) => (candidate.tokens > 0 ? candidate.score / candidate.tokens : candidate.score);
  while (policy.max_injected_tokens > 0 && selection.selected.length > 0 && estimateContextTokens(digest) > policy.max_injected_tokens) {
    const drop = [...selection.selected].sort((left, right) => density(left) - density(right)
      || String(right.key).localeCompare(String(left.key)))[0];
    drop.selected = false;
    drop.truncated = false;
    drop.reason = "over_budget";
    selection.selected = selection.selected.filter((candidate) => candidate !== drop);
    injected = toInjected();
    digest = renderMatchDigest(injected);
  }

  return {
    sid,
    policy,
    selection,
    injected,
    digest,
    rendered_tokens: estimateContextTokens(digest),
    match_ms: Date.now() - startedAt,
  };
}

function skipReasonCounts(candidates) {
  const reasons = {};
  for (const candidate of candidates) {
    if (!candidate.selected && candidate.reason) {
      reasons[candidate.reason] = (reasons[candidate.reason] || 0) + 1;
    }
  }
  return reasons;
}

// Public candidate view: everything ctx explain / telemetry needs to justify
// each include/skip, nothing else (no raw item payloads).
function describeCandidate(candidate) {
  return {
    key: candidate.key,
    type: candidate.type,
    score: Number(candidate.score?.toFixed?.(4) ?? candidate.score),
    age_days: candidate.age_days,
    stale: candidate.stale === true,
    chars: candidate.chars,
    tokens: candidate.tokens,
    selected: candidate.selected === true,
    truncated: candidate.truncated === true,
    reason: candidate.reason,
  };
}

export async function matchContext(root, prompt, options = {}) {
  const computed = await computeMatchSelection(root, prompt, options);
  const { sid, policy, selection, injected, digest } = computed;
  const candidates = selection.candidates;

  const freshStale = candidates.filter((candidate) => candidate.reason === "stale_refs" && !candidate.seen);
  const suppressedAsSeen = candidates.filter((candidate) => candidate.reason === "seen_this_session").length;
  const selected = selection.selected;

  if (options.recordInjection !== false && (selected.length > 0 || freshStale.length > 0)) {
    const ledger = await readInjectionLedger(root);
    const seen = new Set(Array.isArray(ledger[sid]) ? ledger[sid] : []);
    // Only what was actually injected (plus stale rejections, so each is
    // counted once) becomes "seen": an item skipped for budget today must
    // stay eligible for the next prompt.
    ledger[sid] = [
      ...seen,
      ...selected.map((candidate) => candidate.key),
      ...freshStale.map((candidate) => candidate.key),
    ];
    await writeInjectionLedger(root, ledger);
    // Usage telemetry: lets `agentify stats` show whether generated session
    // summaries are ever actually injected, and how old they were at use.
    try {
      const paths = resolveContextPaths(root);
      for (const item of injected.summaries) {
        await appendJsonLine(paths.summaryUsagePath, {
          ts: new Date().toISOString(),
          key: item.key,
          summary_ts: item.item?.ts || null,
        });
      }
    } catch {
      // Best-effort: usage telemetry must never break injection.
    }

    try {
      const decisionCount = injected.notes.filter((item) => item.note?.type === "decision").length;
      await recordValueEvent(root, {
        type: "context_injection",
        mode: "relevant",
        sid,
        estimated_tokens: computed.rendered_tokens,
        injected_items: selected.length,
        decisions_reused: decisionCount,
        stale_context_rejected: freshStale.length,
        reasons: {
          previous_decision: decisionCount,
          previous_note: injected.notes.length - decisionCount,
          session_summary: injected.summaries.length,
          hot_file: injected.files.length,
          previous_failure: injected.failures.length,
        },
        match_ms: computed.match_ms,
        policy_version: policy?.policy_version ?? null,
        requested_profile: policy?.requested_profile ?? null,
        resolved_profile: policy?.resolved_profile ?? null,
        profile_source: policy?.profile_source ?? null,
        budget: policy ? {
          max_tokens: policy.max_injected_tokens,
          source: policy.budget_source,
          reason: policy.budget_reason,
          rendered_tokens: computed.rendered_tokens,
          truncated_items: selected.filter((candidate) => candidate.truncated).length,
          skipped: skipReasonCounts(candidates),
        } : null,
      });
    } catch {
      // Value telemetry must never break prompt injection.
    }
  }

  return {
    ...injected,
    digest,
    stale_rejected: freshStale.length,
    suppressed_as_seen: suppressedAsSeen,
    match_ms: computed.match_ms,
    policy,
    budget: policy ? {
      max_tokens: policy.max_injected_tokens,
      rendered_tokens: computed.rendered_tokens,
      source: policy.budget_source,
    } : null,
    candidates: candidates.map(describeCandidate),
  };
}

// Dry-run view of exactly what matchContext would inject for a prompt and
// why: pure local computation (no provider call) that never touches the
// injection ledger, the summary-usage log, or value telemetry.
export async function explainContext(root, config, prompt, options = {}) {
  const computed = await computeMatchSelection(root, prompt, { ...options, config, explain: true });
  const { policy, selection } = computed;
  return {
    command: "ctx explain",
    prompt: clip(prompt, 200),
    policy,
    budget: {
      max_tokens: policy?.max_injected_tokens ?? null,
      source: policy?.budget_source ?? null,
      reason: policy?.budget_reason ?? null,
      reserves: policy?.reserves ?? null,
      used_tokens: selection.used_tokens,
      rendered_tokens: computed.rendered_tokens,
    },
    candidates: selection.candidates.map(describeCandidate),
    selected_items: selection.selected.length,
    skipped: skipReasonCounts(selection.candidates),
    suppressed_as_seen: selection.candidates.filter((candidate) => candidate.reason === "seen_this_session").length,
    match_ms: computed.match_ms,
    digest: computed.digest,
  };
}

export async function precheckCommand(root, payload, options = {}) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (String(payload.tool_name || "") !== "Bash") {
    return null;
  }
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (!toolInput.command) {
    return null;
  }
  const rawCommand = String(toolInput.command);
  const normalized = clip(rawCommand);
  const signature = normalizeCommandSignature(rawCommand);
  const sid = shortSessionId(payload.session_id);

  const paths = resolveContextPaths(root);
  const events = await readJsonLines(paths.eventsPath);
  let lastExact = null;
  let lastSignature = null;
  for (const event of events) {
    if (event?.type !== "cmd") {
      continue;
    }
    if (event.cmd === normalized) {
      lastExact = event;
    }
    if (signature) {
      // Older events predate the stored `sig`; recompute from the redacted cmd.
      const eventSignature = event.sig || normalizeCommandSignature(event.cmd);
      if (eventSignature && eventSignature === signature) {
        lastSignature = event;
      }
    }
  }

  // Once-per-session dedup: mark this precheck key as seen and record telemetry.
  // Returns false if it was already warned this session (caller should bail).
  const claimOnce = async (key, failedEvent) => {
    if (options.recordInjection === false) {
      return true;
    }
    const ledger = await readInjectionLedger(root);
    const seen = new Set(Array.isArray(ledger[sid]) ? ledger[sid] : []);
    if (seen.has(key)) {
      return false;
    }
    ledger[sid] = [...seen, key];
    await writeInjectionLedger(root, ledger);
    try {
      await recordValueEvent(root, {
        type: "failed_command_repeat_intercepted",
        sid,
        previous_failure_ts: failedEvent.ts || null,
      });
    } catch {
      // Pre-run safety warnings must not depend on value telemetry.
    }
    return true;
  };

  // Tier 1 — exact match: strongest wording. Only warn when the most recent run
  // of this exact command failed in a different session (unchanged behavior).
  if (lastExact?.fail && lastExact.sid !== sid) {
    if (!(await claimOnce(`precheck:${normalized}`, lastExact))) {
      return null;
    }
    return { command: normalized, event: lastExact };
  }

  // Tier 2 — signature match: a *similar* command (same binary + subcommand,
  // differing only in argument/flag values) most recently failed in another
  // session. Softer wording. Same cross-session + unresolved guarantees.
  if (signature && lastSignature?.fail && lastSignature.sid !== sid && lastSignature.cmd !== normalized) {
    if (!(await claimOnce(`precheck-sig:${signature}`, lastSignature))) {
      return null;
    }
    return { command: normalized, event: lastSignature, match: "signature" };
  }

  return null;
}

export function renderPrecheckWarning(warning) {
  if (!warning?.event) {
    return "";
  }
  const when = String(warning.event.ts || "").slice(0, 10);
  const detail = warning.event.err ? `: ${warning.event.err}` : "";
  const exit = warning.event.exit !== undefined ? ` (exit ${warning.event.exit})` : "";
  if (warning.match === "signature") {
    const failed = warning.event.cmd ? ` (\`${warning.event.cmd}\`)` : "";
    return `Agentify: a similar command failed in a previous session (${when})${exit}${failed}${detail}. This differs only in arguments/flags; if the underlying cause was not fixed, try a different approach instead of retrying a variant.`;
  }
  return `Agentify: this exact command failed in a previous session (${when})${exit}${detail}. If the underlying cause was not fixed since, try a different approach instead of retrying it as-is.`;
}

const SUMMARY_MIN_EVENTS = 3;
const SUMMARY_MAX_LENGTH = 600;
const SUMMARY_LLM_MIN_EVENTS = 20;
const SUMMARY_LLM_MAX_BUDGET_USD = 0.03;

export const SUMMARY_MODES = ["extractive", "llm", "off"];

// Session summaries default to a zero-cost deterministic extraction; invoking
// a model is an explicitly configured, budgeted refinement. Legacy boolean
// configs map onto the modes: `true` (the old default, which used a model)
// maps to the free extractive mode, `false` stays off.
export function resolveSummaryMode(config = {}) {
  const raw = config.context?.sessionSummaries;
  if (raw === false || raw === "off" || raw === "false") {
    return "off";
  }
  if (raw === true || raw === null || raw === undefined) {
    return "extractive";
  }
  const mode = String(raw).trim().toLowerCase();
  return SUMMARY_MODES.includes(mode) ? mode : "extractive";
}

function resolveSummarySettings(config = {}) {
  const raw = config.context?.summary && typeof config.context.summary === "object" ? config.context.summary : {};
  const positive = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  return {
    maxChars: positive(raw.maxChars, SUMMARY_MAX_LENGTH),
    llmMinEvents: positive(raw.llmMinEvents, SUMMARY_LLM_MIN_EVENTS),
    maxBudgetUsd: positive(raw.maxBudgetUsd, SUMMARY_LLM_MAX_BUDGET_USD),
  };
}

// Two sessions with identical meaningful activity would produce identical
// summaries; the fingerprint lets the second one be skipped.
function summaryFingerprint(meaningful, notes) {
  const descriptors = meaningful.map((event) => (event.type === "edit"
    ? ["e", event.path]
    : ["c", event.cmd, event.fail ? 1 : 0, event.exit ?? null, event.err || "", event.desc || ""]));
  const noteDescriptors = notes.map((note) => [note.type || "note", note.note]);
  return createHash("sha256").update(JSON.stringify([descriptors, noteDescriptors])).digest("hex").slice(0, 16);
}

// Deterministic summary straight from the tracked evidence: edited files,
// command outcomes, notes/decisions, and unresolved failures. Zero model cost.
export function buildExtractiveSummary({ editCounts, commands, notes, maxChars = SUMMARY_MAX_LENGTH }) {
  const segments = [];

  const editEntries = [...editCounts.entries()].sort((left, right) => right[1] - left[1]);
  if (editEntries.length > 0) {
    const top = editEntries.slice(0, 4)
      .map(([file, count]) => (count > 1 ? `${file} (${count}x)` : file))
      .join(", ");
    const more = editEntries.length > 4 ? ` and ${editEntries.length - 4} more` : "";
    segments.push(`Edited ${editEntries.length} file(s): ${top}${more}.`);
  }

  if (commands.length > 0) {
    const failed = commands.filter((event) => event.fail);
    const lastDescribed = [...commands].reverse().find((event) => event.desc);
    const label = lastDescribed ? `; last: ${lastDescribed.desc}` : "";
    segments.push(`Ran ${commands.length} command(s)${failed.length > 0 ? `, ${failed.length} failed` : ""}${label}.`);

    // The most recent still-failing command is the open thread a future
    // session most needs to know about.
    const outcomes = new Map();
    for (const event of commands) {
      // Delete-then-set keeps Map insertion order aligned with recency, so
      // the final .pop() really is the most recent unresolved failure.
      outcomes.delete(event.cmd);
      outcomes.set(event.cmd, event);
    }
    const unresolved = [...outcomes.values()].filter((event) => event.fail).pop();
    if (unresolved) {
      segments.push(`Open: \`${unresolved.cmd}\` still failing${unresolved.err ? ` — ${unresolved.err}` : ""}.`);
    }
  }

  const decisions = notes.filter((note) => note.type === "decision");
  const plainNotes = notes.filter((note) => note.type !== "decision");
  for (const decision of decisions.slice(-2)) {
    segments.push(`Decision: ${decision.note}`);
  }
  for (const note of plainNotes.slice(-2)) {
    segments.push(`Note: ${note.note}`);
  }

  return clip(segments.join(" "), maxChars);
}

export async function summarizeSession(root, config, sessionIdInput, options = {}) {
  const sid = String(sessionIdInput || "").trim().slice(0, 8);
  if (!sid) {
    throw new Error("ctx summarize requires --session <id>");
  }
  const mode = options.mode || resolveSummaryMode(config);
  if (mode === "off") {
    return { command: "ctx summarize", sid, status: "disabled" };
  }
  const settings = resolveSummarySettings(config);
  const paths = resolveContextPaths(root);

  const existing = await readJsonLines(paths.summariesPath);
  if (existing.some((record) => record.sid === sid)) {
    return { command: "ctx summarize", sid, status: "already_summarized" };
  }

  const events = (await readJsonLines(paths.eventsPath)).filter((event) => event.sid === sid);
  const meaningful = events.filter((event) => event.type === "edit" || event.type === "cmd");
  // No-op and read-only sessions produce no meaningful events and are skipped.
  if (meaningful.length < (options.minEvents ?? SUMMARY_MIN_EVENTS)) {
    return { command: "ctx summarize", sid, status: "too_few_events", events: meaningful.length };
  }

  const notes = (await readJsonLines(paths.notesPath)).filter((note) => note.sid === sid);
  const fingerprint = summaryFingerprint(meaningful, notes);
  if (existing.some((record) => record.fp === fingerprint)) {
    return { command: "ctx summarize", sid, status: "duplicate_session", fp: fingerprint };
  }

  const editCounts = new Map();
  const commands = [];
  for (const event of meaningful) {
    if (event.type === "edit") {
      editCounts.set(event.path, (editCounts.get(event.path) || 0) + 1);
    } else if (event.cmd) {
      commands.push(event);
    }
  }

  const startedAt = Date.now();
  const extractive = buildExtractiveSummary({ editCounts, commands, notes, maxChars: settings.maxChars });
  if (!extractive) {
    return { command: "ctx summarize", sid, status: "too_few_events", events: meaningful.length };
  }

  let summary = extractive;
  let usedMode = "extractive";
  let costUsd = null;
  let llmFellBack = false;

  // LLM refinement is opt-in, budgeted via the quick route, receives only the
  // extractive summary (never the full activity log), and fails open to the
  // extractive text.
  if (mode === "llm" && meaningful.length >= settings.llmMinEvents) {
    const prompt = [
      "Rewrite the following session handoff to be clearer and more useful for the next coding session. Keep every fact; add nothing. At most 3 short plain-text lines, no headers, no preamble.",
      "",
      extractive,
    ].join("\n");
    const delegate = options.runtime?.delegate
      || (async (input) => {
        const { runDelegate } = await import("./models.js");
        return runDelegate(root, config, "quick", input, {
          timeoutMs: options.timeoutMs || 90000,
          maxBudgetUsd: settings.maxBudgetUsd,
        });
      });
    try {
      const result = await delegate(prompt);
      const refined = clip(String(result?.output || ""), settings.maxChars);
      if (result?.exit_code === 0 && refined) {
        summary = refined;
        usedMode = "llm";
        costUsd = typeof result.cost_usd === "number" ? result.cost_usd : null;
      } else {
        llmFellBack = true;
      }
    } catch {
      llmFellBack = true;
    }
  }

  const record = {
    ts: new Date().toISOString(),
    sid,
    summary,
    mode: usedMode,
    events: meaningful.length,
    gen_ms: Date.now() - startedAt,
    fp: fingerprint,
    ...(costUsd !== null ? { cost_usd: costUsd } : {}),
    ...(llmFellBack ? { llm_fallback: true } : {}),
  };
  await appendJsonLine(paths.summariesPath, record);
  return { command: "ctx summarize", sid, status: "written", record };
}

export async function latestSessionId(root) {
  const paths = resolveContextPaths(root);
  const events = await readJsonLines(paths.eventsPath);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.sid && events[index].sid !== "unknown") {
      return events[index].sid;
    }
  }
  return null;
}
