import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, exists, readText, relative } from "./fs.js";
import { resolveLocalAgentifyPaths } from "./project-store.js";
import { redactSensitiveText } from "./redact.js";

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
    notesPath: path.join(contextRoot, "notes.jsonl"),
    handoffDir: path.join(contextRoot, "handoffs"),
    pausedPath: path.join(contextRoot, "paused"),
    archiveDir: path.join(contextRoot, "archive"),
    injectedPath: path.join(contextRoot, "injected.json"),
    summariesPath: path.join(contextRoot, "summaries.jsonl"),
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
    for (const [label, sourcePath] of [["events.jsonl", paths.eventsPath], ["notes.jsonl", paths.notesPath], ["summaries.jsonl", paths.summariesPath]]) {
      if (await exists(sourcePath)) {
        await ensureDir(targetDir);
        await fs.rename(sourcePath, path.join(targetDir, label));
        archived.push(relative(root, path.join(targetDir, label)));
      }
    }
  } else {
    await fs.rm(paths.eventsPath, { force: true });
    await fs.rm(paths.notesPath, { force: true });
    await fs.rm(paths.summariesPath, { force: true });
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
      records.push(JSON.parse(trimmed));
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
    return {
      ...base,
      type: "cmd",
      cmd: clip(redactSensitiveText(toolInput.command)),
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
  const docs = decisions.map((decision) => ({ decision, counts: termCounts(decision.note) }));
  const index = buildBm25Index(docs.map((doc) => doc.counts));
  const matched = [];
  for (const doc of docs) {
    const { score, matched: matchedTerms } = bm25Match(promptTokens, doc.counts, index);
    if (matchedTerms.length >= 1) {
      matched.push({ decision: doc.decision, score });
    }
  }
  matched.sort((left, right) => right.score - left.score);
  return { decisions: matched.map((item) => item.decision), query: trimmedQuery };
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

export function renderMatchDigest(matches) {
  const summaries = matches.summaries || [];
  const failures = matches.failures || [];
  if (matches.notes.length === 0 && matches.files.length === 0 && summaries.length === 0 && failures.length === 0) {
    return "";
  }
  const lines = ["## Agentify context (relevant to this task)"];
  if (failures.length > 0) {
    lines.push("", "### Related commands that previously failed (avoid repeating as-is)");
    for (const item of failures) {
      lines.push(`- [${String(item.failure.ts || "").slice(0, 10)}] ${renderFailureLine(item.failure)}`);
    }
  }
  if (summaries.length > 0) {
    lines.push("", "### Related past sessions");
    for (const item of summaries) {
      lines.push(`- [${String(item.item.ts || "").slice(0, 10)}] ${item.item.summary}`);
    }
  }
  if (matches.notes.length > 0) {
    lines.push("", "### Related notes from earlier sessions");
    for (const item of matches.notes) {
      lines.push(noteLine(item.note));
    }
  }
  if (matches.files.length > 0) {
    lines.push("", "### Files previously worked on that look related");
    for (const item of matches.files) {
      lines.push(`- ${item.file} (${item.edits} edit${item.edits === 1 ? "" : "s"})`);
    }
  }
  lines.push("", "Full history: `agentify ctx load`.");
  return lines.join("\n");
}

export async function matchContext(root, prompt, options = {}) {
  const sid = String(options.sessionId || "unknown").slice(0, 8);
  const snapshot = await loadContextSnapshot(root, { maxNotes: options.maxNotes || 100 });
  const matches = matchSnapshotToPrompt(snapshot, prompt);

  const ledger = await readInjectionLedger(root);
  const seen = new Set(Array.isArray(ledger[sid]) ? ledger[sid] : []);
  const freshNotes = matches.notes.filter((item) => !seen.has(item.key));
  const freshSummaries = (matches.summaries || []).filter((item) => !seen.has(item.key));
  const freshFiles = matches.files.filter((item) => !seen.has(item.key));
  const freshFailures = (matches.failures || []).filter((item) => !seen.has(item.key));

  if (options.recordInjection !== false && (freshNotes.length > 0 || freshSummaries.length > 0 || freshFiles.length > 0 || freshFailures.length > 0)) {
    ledger[sid] = [
      ...seen,
      ...freshNotes.map((item) => item.key),
      ...freshSummaries.map((item) => item.key),
      ...freshFiles.map((item) => item.key),
      ...freshFailures.map((item) => item.key),
    ];
    await writeInjectionLedger(root, ledger);
  }

  return {
    notes: freshNotes,
    summaries: freshSummaries,
    files: freshFiles,
    failures: freshFailures,
    suppressed_as_seen: (matches.notes.length - freshNotes.length)
      + ((matches.summaries || []).length - freshSummaries.length)
      + (matches.files.length - freshFiles.length)
      + ((matches.failures || []).length - freshFailures.length),
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
  const normalized = clip(toolInput.command);
  const sid = shortSessionId(payload.session_id);

  const paths = resolveContextPaths(root);
  const events = await readJsonLines(paths.eventsPath);
  let last = null;
  for (const event of events) {
    if (event?.type === "cmd" && event.cmd === normalized) {
      last = event;
    }
  }
  // Only warn when the most recent run of this exact command failed, and it
  // happened in a different session — the agent already saw same-session failures.
  if (!last?.fail || last.sid === sid) {
    return null;
  }

  const key = `precheck:${normalized}`;
  if (options.recordInjection !== false) {
    const ledger = await readInjectionLedger(root);
    const seen = new Set(Array.isArray(ledger[sid]) ? ledger[sid] : []);
    if (seen.has(key)) {
      return null;
    }
    ledger[sid] = [...seen, key];
    await writeInjectionLedger(root, ledger);
  }

  return { command: normalized, event: last };
}

export function renderPrecheckWarning(warning) {
  if (!warning?.event) {
    return "";
  }
  const when = String(warning.event.ts || "").slice(0, 10);
  const detail = warning.event.err ? `: ${warning.event.err}` : "";
  const exit = warning.event.exit !== undefined ? ` (exit ${warning.event.exit})` : "";
  return `Agentify: this exact command failed in a previous session (${when})${exit}${detail}. If the underlying cause was not fixed since, try a different approach instead of retrying it as-is.`;
}

const SUMMARY_MIN_EVENTS = 3;
const SUMMARY_MAX_LENGTH = 600;

export async function summarizeSession(root, config, sessionIdInput, options = {}) {
  const sid = String(sessionIdInput || "").trim().slice(0, 8);
  if (!sid) {
    throw new Error("ctx summarize requires --session <id>");
  }
  const paths = resolveContextPaths(root);

  const existing = await readJsonLines(paths.summariesPath);
  if (existing.some((record) => record.sid === sid)) {
    return { command: "ctx summarize", sid, status: "already_summarized" };
  }

  const events = (await readJsonLines(paths.eventsPath)).filter((event) => event.sid === sid);
  const meaningful = events.filter((event) => event.type === "edit" || event.type === "cmd");
  if (meaningful.length < (options.minEvents ?? SUMMARY_MIN_EVENTS)) {
    return { command: "ctx summarize", sid, status: "too_few_events", events: meaningful.length };
  }

  const notes = (await readJsonLines(paths.notesPath)).filter((note) => note.sid === sid);
  const editCounts = new Map();
  const commands = [];
  for (const event of meaningful) {
    if (event.type === "edit") {
      editCounts.set(event.path, (editCounts.get(event.path) || 0) + 1);
    } else if (event.cmd) {
      commands.push(event.desc ? `${event.desc}: ${event.cmd}` : event.cmd);
    }
  }

  const promptLines = [
    "Below is the complete activity log of a finished coding session. It is the only information available — do not ask for more and do not mention missing context. Write a handoff of at most 3 short plain-text lines describing what the log shows: what was worked on, the apparent outcome, and any open thread. No headers, no preamble.",
    "",
    "Files edited:",
    ...[...editCounts.entries()].map(([file, count]) => `- ${file} (${count} edit${count === 1 ? "" : "s"})`),
  ];
  if (commands.length > 0) {
    promptLines.push("", "Commands run:", ...commands.slice(-10).map((command) => `- ${command}`));
  }
  if (notes.length > 0) {
    promptLines.push("", "Notes recorded during the session:", ...notes.map((note) => `- ${note.note}`));
  }

  const delegate = options.runtime?.delegate
    || (async (prompt) => {
      const { runDelegate } = await import("./models.js");
      return runDelegate(root, config, "quick", prompt, { timeoutMs: options.timeoutMs || 90000 });
    });

  const result = await delegate(promptLines.join("\n"));
  const summary = clip(String(result?.output || ""), SUMMARY_MAX_LENGTH);
  if (result?.exit_code !== 0 || !summary) {
    return { command: "ctx summarize", sid, status: "delegate_failed", exit_code: result?.exit_code ?? null };
  }

  const record = { ts: new Date().toISOString(), sid, summary };
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
