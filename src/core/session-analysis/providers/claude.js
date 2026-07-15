import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { streamJsonlRecords } from "../stream-jsonl.js";
import {
  classifyShellCommand,
  commandFingerprint,
  createSessionSkeleton,
  createTimeTracker,
  normalizeFilePath,
  recordFileAccess,
} from "../normalize.js";
import { claudePromptText, createContentClassifier } from "../content-classify.js";

export function defaultClaudeRoot() {
  return path.join(os.homedir(), ".claude", "projects");
}

// Claude Code encodes the project cwd into the directory name by replacing
// path separators and dots with dashes. Used only as a cheap pre-filter; the
// per-record cwd field remains the source of truth for scoping.
export function encodeClaudeProjectDir(root) {
  return root.replace(/[/.\\_]/g, "-");
}

export async function discoverClaudeSessions({ claudeRoot, cutoffMs }) {
  const sourceRoot = claudeRoot || defaultClaudeRoot();
  const files = [];
  let projectDirs = [];
  try {
    projectDirs = await fs.readdir(sourceRoot, { withFileTypes: true });
  } catch {
    return { root: sourceRoot, files, missing: true };
  }
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const projectPath = path.join(sourceRoot, dir.name);
    let entries = [];
    try {
      entries = await fs.readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(projectPath, entry.name);
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue;
      }
      // A file whose last write predates the window cannot contain events
      // inside it; skipping here keeps large global stores cheap to scan.
      if (Number.isFinite(cutoffMs) && stat.mtimeMs < cutoffMs) continue;
      files.push({ provider: "claude", path: filePath, project_dir: dir.name, size: stat.size, mtime_ms: stat.mtimeMs });
    }
  }
  return { root: sourceRoot, files, missing: false };
}

const PATH_TOOL_OPERATIONS = {
  Read: "read",
  Edit: "write",
  Write: "write",
  MultiEdit: "write",
  NotebookEdit: "write",
};

function toolInputPath(input) {
  return input?.file_path || input?.notebook_path || input?.path || null;
}

export async function parseClaudeSession(file, { root, contentMode = "metadata-only" }) {
  const session = createSessionSkeleton("claude", file.path);
  session.project_key = `claude:${file.project_dir}`;
  const time = createTimeTracker();
  const usageByRequest = new Map();
  const models = new Set();
  const fileAccessSeen = new Map();
  const shellCallsById = new Map();
  const classifier = contentMode === "local-extractive" ? createContentClassifier() : null;

  const { lines, malformed } = await streamJsonlRecords(file.path, (record) => {
    if (classifier) {
      // Prompt text is inspected here, in memory, and goes no further.
      const promptText = claudePromptText(record);
      if (promptText !== null) classifier.observe(promptText);
    }
    if (record.timestamp) time.observe(record.timestamp);
    if (record.cwd && !session.cwd) session.cwd = String(record.cwd);
    if (record.gitBranch && !session.branch) session.branch = String(record.gitBranch);
    if (record.version && !session.cli_version) session.cli_version = String(record.version);
    if (record.isSidechain === true) session.sidechain_events += 1;

    const message = record.message;
    if (record.type === "assistant" && message && typeof message === "object") {
      if (message.model && message.model !== "<synthetic>") models.add(String(message.model));
      if (message.usage && typeof message.usage === "object") {
        // Streamed chunks repeat the full usage object for one request, so
        // the last record per requestId wins instead of being summed.
        const requestKey = record.requestId || message.id || record.uuid;
        if (requestKey) {
          usageByRequest.set(requestKey, message.usage);
          session.coverage.usage_records += 1;
        }
      }
      const content = Array.isArray(message.content) ? message.content : [];
      for (const item of content) {
        if (item?.type !== "tool_use") continue;
        const name = String(item.name || "unknown");
        session.tools.calls += 1;
        session.tools.by_name[name] = (session.tools.by_name[name] || 0) + 1;
        const input = item.input && typeof item.input === "object" ? item.input : {};

        if (PATH_TOOL_OPERATIONS[name]) {
          const normalized = normalizeFilePath(toolInputPath(input), root);
          if (normalized) {
            recordFileAccess(session, fileAccessSeen, {
              path: normalized.path,
              in_repo: normalized.in_repo,
              operation: PATH_TOOL_OPERATIONS[name],
              source: "structured-tool",
              confidence: "high",
            });
          }
        } else if (name === "Grep" || name === "Glob") {
          const normalized = normalizeFilePath(toolInputPath(input), root);
          if (normalized) {
            recordFileAccess(session, fileAccessSeen, {
              path: normalized.path,
              in_repo: normalized.in_repo,
              operation: "search",
              source: "structured-tool",
              confidence: "high",
            });
          }
        } else if (name === "Bash") {
          // Command text is classified in memory and only pattern counts and
          // an irreversible fingerprint survive; the command itself does not.
          session.shell_patterns.opaque_shell_calls += 1;
          const { kinds } = classifyShellCommand(input.command);
          for (const kind of kinds) {
            session.shell_patterns[kind] += 1;
          }
          if (item.id) {
            shellCallsById.set(item.id, commandFingerprint(input.command));
          }
        }
      }
    }

    if (record.type === "user" && message && typeof message === "object") {
      // A user turn is a message the human typed: string content, or an
      // array with a text item. Pure tool_result records are protocol
      // plumbing, not turns.
      const isTurn = (typeof message.content === "string" && message.content.trim())
        || (Array.isArray(message.content) && message.content.some((item) => item?.type === "text"));
      if (isTurn && record.isSidechain !== true) {
        session.turns.user += 1;
      }
      const content = Array.isArray(message.content) ? message.content : [];
      for (const item of content) {
        if (item?.type !== "tool_result" || item.is_error !== true) continue;
        session.failed_tool_calls += 1;
        const fingerprint = item.tool_use_id ? shellCallsById.get(item.tool_use_id) : null;
        if (fingerprint) {
          session.failed_command_fingerprints[fingerprint] = (session.failed_command_fingerprints[fingerprint] || 0) + 1;
        }
      }
    }
  });

  for (const usage of usageByRequest.values()) {
    session.usage.fresh_input_tokens = add(session.usage.fresh_input_tokens, usage.input_tokens);
    session.usage.cache_read_tokens = add(session.usage.cache_read_tokens, usage.cache_read_input_tokens);
    session.usage.cache_write_tokens = add(session.usage.cache_write_tokens, usage.cache_creation_input_tokens);
    session.usage.output_tokens = add(session.usage.output_tokens, usage.output_tokens);
    // TTL split (5-minute vs 1-hour writes) matters for pricing: 1h writes
    // cost 2x input vs 1.25x for the 5m default.
    if (usage.cache_creation && typeof usage.cache_creation === "object") {
      session.usage.cache_write_5m_tokens = add(session.usage.cache_write_5m_tokens, usage.cache_creation.ephemeral_5m_input_tokens);
      session.usage.cache_write_1h_tokens = add(session.usage.cache_write_1h_tokens, usage.cache_creation.ephemeral_1h_input_tokens);
    }
  }
  session.models = [...models].sort();
  session.turns.assistant_requests = usageByRequest.size;
  if (classifier) {
    const { category_hint, hint_confidence, prompts_seen, signal_counts, classifier: rulesVersion } = classifier.result();
    session.task = { content_mode: "local-extractive", content_rules: rulesVersion, category_hint, hint_confidence, prompts_seen, signal_counts };
  }
  time.finish(session);
  session.coverage.lines = lines;
  session.coverage.malformed_lines = malformed;
  return session;
}

function add(current, value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return current;
  return (current ?? 0) + Number(value);
}

export function claudeSessionMatchesRepo(session, file, root) {
  if (session.cwd) {
    const normalized = path.resolve(String(session.cwd));
    return normalized === root || normalized.startsWith(`${root}${path.sep}`);
  }
  return file.project_dir === encodeClaudeProjectDir(root);
}
