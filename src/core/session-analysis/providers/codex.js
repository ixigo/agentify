import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { streamJsonlRecords } from "../stream-jsonl.js";
import {
  classifyShellCommand,
  createSessionSkeleton,
  createTimeTracker,
} from "../normalize.js";
import { codexPromptText, createContentClassifier } from "../content-classify.js";

export function defaultCodexRoot() {
  return path.join(os.homedir(), ".codex", "sessions");
}

// Codex rollouts are date-partitioned: sessions/YYYY/MM/DD/rollout-*.jsonl.
export async function discoverCodexSessions({ codexRoot, cutoffMs }) {
  const sourceRoot = codexRoot || defaultCodexRoot();
  const files = [];
  let found = false;
  async function visit(current, depth) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    found = true;
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) await visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (Number.isFinite(cutoffMs) && stat.mtimeMs < cutoffMs) continue;
      files.push({ provider: "codex", path: fullPath, size: stat.size, mtime_ms: stat.mtimeMs });
    }
  }
  await visit(sourceRoot, 0);
  return { root: sourceRoot, files, missing: !found };
}

export async function parseCodexSession(file, { contentMode = "metadata-only" } = {}) {
  const session = createSessionSkeleton("codex", file.path);
  const time = createTimeTracker();
  const models = new Set();
  let lastTokenUsage = null;
  let turnContexts = 0;
  let userMessages = 0;
  const classifier = contentMode === "local-extractive" ? createContentClassifier() : null;
  let sawEventPrompts = false;
  const fallbackPrompts = [];

  const { lines, malformed } = await streamJsonlRecords(file.path, (record) => {
    const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
    time.observe(record.timestamp || payload.timestamp);
    if (classifier) {
      // Prompt text is inspected in memory only. event_msg records are the
      // human turns; response_item user messages duplicate them and add
      // injected context, so they are buffered as a fallback used only
      // when a rollout carries no user_message events at all.
      const prompt = codexPromptText(record, payload);
      if (prompt) {
        if (prompt.source === "event") {
          sawEventPrompts = true;
          classifier.observe(prompt.text);
        } else if (!sawEventPrompts && fallbackPrompts.length < 50) {
          fallbackPrompts.push(prompt.text.slice(0, 4000));
        }
      }
    }

    if (record.type === "session_meta" || payload.type === "session_meta") {
      if (payload.cwd && !session.cwd) session.cwd = String(payload.cwd);
      if (payload.cli_version && !session.cli_version) session.cli_version = String(payload.cli_version);
      if (payload.git?.branch && !session.branch) session.branch = String(payload.git.branch);
      return;
    }

    if (record.type === "turn_context") {
      turnContexts += 1;
      if (payload.model) models.add(String(payload.model));
      if (payload.cwd && !session.cwd) session.cwd = String(payload.cwd);
      return;
    }

    if (record.type === "event_msg" && payload.type === "user_message") {
      userMessages += 1;
      return;
    }

    if (record.type === "event_msg" && payload.type === "token_count") {
      // Codex emits cumulative counters; the last valid snapshot is the
      // session total. Summing snapshots would massively double count.
      const total = payload.info?.total_token_usage;
      if (total && typeof total === "object") {
        lastTokenUsage = total;
        session.coverage.usage_records += 1;
      }
      if (payload.info?.model) models.add(String(payload.info.model));
      return;
    }

    if (record.type === "response_item" && payload.type === "function_call") {
      const name = String(payload.name || "unknown");
      session.tools.calls += 1;
      session.tools.by_name[name] = (session.tools.by_name[name] || 0) + 1;
      // Codex wraps file work in exec/script envelopes, so no structured
      // path is trusted here: commands are classified in memory for pattern
      // counts only and never persisted or evaluated.
      session.shell_patterns.opaque_shell_calls += 1;
      let commandText = "";
      if (typeof payload.arguments === "string") {
        try {
          const parsed = JSON.parse(payload.arguments);
          commandText = typeof parsed?.cmd === "string"
            ? parsed.cmd
            : Array.isArray(parsed?.command) ? parsed.command.join(" ") : "";
        } catch {
          commandText = "";
        }
      }
      const { kinds } = classifyShellCommand(commandText);
      for (const kind of kinds) {
        session.shell_patterns[kind] += 1;
      }
    }
  });

  if (lastTokenUsage) {
    const input = finiteOrNull(lastTokenUsage.input_tokens);
    const cached = finiteOrNull(lastTokenUsage.cached_input_tokens);
    // Codex input_tokens includes the cached portion; fresh input is the
    // remainder so the dimensions stay comparable with Claude's.
    session.usage.fresh_input_tokens = input !== null ? Math.max(0, input - (cached ?? 0)) : null;
    session.usage.cache_read_tokens = cached;
    session.usage.output_tokens = finiteOrNull(lastTokenUsage.output_tokens);
    session.usage.reasoning_output_tokens = finiteOrNull(lastTokenUsage.reasoning_output_tokens);
  }
  session.models = [...models].sort();
  // A turn_context record opens each turn; older rollouts without it still
  // carry user_message events, so the larger observed count wins.
  session.turns.user = Math.max(turnContexts, userMessages);
  session.turns.assistant_requests = session.coverage.usage_records;
  if (classifier) {
    if (!sawEventPrompts) {
      for (const text of fallbackPrompts) classifier.observe(text);
    }
    const { category_hint, hint_confidence, prompts_seen, signal_counts, classifier: rulesVersion } = classifier.result();
    session.task = { content_mode: "local-extractive", content_rules: rulesVersion, category_hint, hint_confidence, prompts_seen, signal_counts };
  }
  session.project_key = session.cwd ? `codex:${session.cwd}` : `codex:${file.path}`;
  time.finish(session);
  session.coverage.lines = lines;
  session.coverage.malformed_lines = malformed;
  return session;
}

function finiteOrNull(value) {
  return Number.isFinite(Number(value)) && value !== null && value !== undefined ? Number(value) : null;
}

export function codexSessionMatchesRepo(session, root) {
  if (!session.cwd) return false;
  const normalized = path.resolve(String(session.cwd));
  return normalized === root || normalized.startsWith(`${root}${path.sep}`);
}
