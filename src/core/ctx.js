import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, exists, readText, relative } from "./fs.js";
import { resolveLocalAgentifyPaths } from "./project-store.js";

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
    for (const [label, sourcePath] of [["events.jsonl", paths.eventsPath], ["notes.jsonl", paths.notesPath]]) {
      if (await exists(sourcePath)) {
        await ensureDir(targetDir);
        await fs.rename(sourcePath, path.join(targetDir, label));
        archived.push(relative(root, path.join(targetDir, label)));
      }
    }
  } else {
    await fs.rm(paths.eventsPath, { force: true });
    await fs.rm(paths.notesPath, { force: true });
  }
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
    return {
      ...base,
      type: "cmd",
      cmd: clip(toolInput.command),
      ...(toolInput.description ? { desc: clip(toolInput.description, 100) } : {}),
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

export async function addNote(root, text, options = {}) {
  const note = String(text || "").trim();
  if (!note) {
    throw new Error("ctx note requires non-empty text");
  }
  const record = {
    ts: new Date().toISOString(),
    sid: shortSessionId(options.session || process.env.CLAUDE_SESSION_ID || ""),
    note: note.length > 2000 ? `${note.slice(0, 1999)}…` : note,
  };
  const paths = resolveContextPaths(root);
  await appendJsonLine(paths.notesPath, record);
  return { path: paths.notesPath, record };
}

function summarizeEvents(events) {
  const editCounts = new Map();
  const commands = [];
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
    }
  }

  const hotFiles = [...editCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([file, count]) => ({ file, edits: count }));

  return {
    hotFiles,
    recentCommands: commands.slice(-5),
    lastEventAt,
    sessionCount: sessions.size,
    eventCount: events.length,
  };
}

export async function loadContextSnapshot(root, options = {}) {
  const paths = resolveContextPaths(root);
  const events = (await readJsonLines(paths.eventsPath)).slice(-(options.maxEvents || DEFAULT_DIGEST_EVENTS));
  const notes = (await readJsonLines(paths.notesPath)).slice(-(options.maxNotes || 10));
  return { events, notes, summary: summarizeEvents(events) };
}

export function renderContextDigest(snapshot) {
  const { summary, notes } = snapshot;
  if (summary.eventCount === 0 && notes.length === 0) {
    return "";
  }

  const lines = ["## Agentify context (from previous sessions)"];
  if (summary.lastEventAt) {
    lines.push(`Last tracked activity: ${summary.lastEventAt} across ${summary.sessionCount} session(s), ${summary.eventCount} recent event(s).`);
  }

  if (notes.length > 0) {
    lines.push("", "### Notes left for this session");
    for (const note of notes) {
      lines.push(`- [${String(note.ts || "").slice(0, 10)}] ${note.note}`);
    }
  }

  if (summary.hotFiles.length > 0) {
    lines.push("", "### Recently edited files");
    for (const item of summary.hotFiles) {
      lines.push(`- ${item.file} (${item.edits} edit${item.edits === 1 ? "" : "s"})`);
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
    session_count: snapshot.summary.sessionCount,
    last_event_at: snapshot.summary.lastEventAt,
    event_log_bytes: eventLogBytes,
    hot_files: snapshot.summary.hotFiles,
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

export function tokenizeForMatch(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !MATCH_STOP_WORDS.has(token))
  );
}

function overlap(promptTokens, tokens) {
  let count = 0;
  const matched = [];
  for (const token of tokens) {
    if (promptTokens.has(token)) {
      count += 1;
      matched.push(token);
    }
  }
  return { count, matched };
}

export function matchSnapshotToPrompt(snapshot, prompt) {
  const promptTokens = tokenizeForMatch(prompt);
  if (promptTokens.size === 0) {
    return { notes: [], files: [] };
  }

  const notes = [];
  for (const note of snapshot.notes) {
    const { count, matched } = overlap(promptTokens, tokenizeForMatch(note.note));
    // Two overlapping tokens, or one distinctive (long) token, marks relevance.
    if (count >= 2 || matched.some((token) => token.length >= 8)) {
      notes.push({ key: `note:${note.ts}`, note, score: count });
    }
  }
  notes.sort((left, right) => right.score - left.score);

  const files = [];
  for (const item of snapshot.summary.hotFiles) {
    const { count } = overlap(promptTokens, tokenizeForMatch(item.file));
    if (count >= 1) {
      files.push({ key: `file:${item.file}`, file: item.file, edits: item.edits, score: count });
    }
  }
  files.sort((left, right) => right.score - left.score);

  return { notes: notes.slice(0, 5), files: files.slice(0, 8) };
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
  if (matches.notes.length === 0 && matches.files.length === 0) {
    return "";
  }
  const lines = ["## Agentify context (relevant to this task)"];
  if (matches.notes.length > 0) {
    lines.push("", "### Related notes from earlier sessions");
    for (const item of matches.notes) {
      lines.push(`- [${String(item.note.ts || "").slice(0, 10)}] ${item.note.note}`);
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
  const freshFiles = matches.files.filter((item) => !seen.has(item.key));

  if (options.recordInjection !== false && (freshNotes.length > 0 || freshFiles.length > 0)) {
    ledger[sid] = [...seen, ...freshNotes.map((item) => item.key), ...freshFiles.map((item) => item.key)];
    await writeInjectionLedger(root, ledger);
  }

  return {
    notes: freshNotes,
    files: freshFiles,
    suppressed_as_seen: (matches.notes.length - freshNotes.length) + (matches.files.length - freshFiles.length),
  };
}
