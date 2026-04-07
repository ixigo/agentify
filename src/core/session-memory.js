import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, exists, relative, writeText } from "./fs.js";

function bytes(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function clipToBytes(value, maxBytes) {
  const text = String(value || "");
  if (maxBytes <= 0 || text.length === 0) {
    return "";
  }
  if (bytes(text) <= maxBytes) {
    return text;
  }

  let end = text.length;
  while (end > 0) {
    const candidate = `${text.slice(0, end).trimEnd()}...`;
    if (bytes(candidate) <= maxBytes) {
      return candidate;
    }
    end -= 1;
  }

  return "";
}

function getSessionMemoryLimit(config, key, fallback) {
  const value = Number(config?.session?.[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function shellEscape(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"");
}

function normalizeCommand(command) {
  if (!Array.isArray(command) || command.length === 0) {
    return "";
  }
  return command.map((part) => {
    const text = String(part);
    return /\s/.test(text) ? `"${shellEscape(text)}"` : text;
  }).join(" ");
}

function parseTranscriptTurns(text) {
  const turns = [];
  let current = [];

  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.startsWith("> ")) {
      if (current.length > 0) {
        turns.push(current.join("\n").trim());
      }
      current = [line];
      continue;
    }
    if (current.length > 0) {
      current.push(line);
    }
  }

  if (current.length > 0) {
    turns.push(current.join("\n").trim());
  }

  return turns.filter(Boolean);
}

function selectRecentTurns(turns, maxTurns, maxBytes) {
  const chosen = [];
  let totalBytes = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) {
      continue;
    }
    const turnBytes = bytes(turn);
    if (chosen.length === 0 && turnBytes > maxBytes) {
      chosen.unshift(clipToBytes(turn, maxBytes));
      break;
    }
    if (chosen.length >= maxTurns || totalBytes + turnBytes > maxBytes) {
      break;
    }
    chosen.unshift(turn);
    totalBytes += turnBytes;
  }

  return chosen.join("\n\n").trim();
}

function buildNoMemoryMarkdown() {
  return [
    "## Automatic Session Memory",
    "- No prior session transcript was available for this run.",
    "- Agentify still writes MemPalace-compatible transcript artifacts automatically for future reuse.",
    "",
    "No recalled transcript excerpt was injected before this run.",
  ].join("\n");
}

export function getSessionArtifactPaths(root, sessionId) {
  const sessionDir = path.join(root, ".agents", "session", sessionId);
  return {
    sessionDir,
    transcriptPath: path.join(sessionDir, "transcript.md"),
    memoryContextPath: path.join(sessionDir, "memory-context.md"),
    launchesPath: path.join(sessionDir, "launches.jsonl"),
  };
}

export async function loadAutomaticSessionMemory(root, manifest, config) {
  const maxBytes = getSessionMemoryLimit(config, "memoryPromptMaxKb", 4) * 1024;
  const maxTurns = getSessionMemoryLimit(config, "memoryTurns", 6);
  const candidates = [manifest?.session_id, manifest?.parent_id].filter(Boolean);

  for (const sessionId of candidates) {
    const { transcriptPath } = getSessionArtifactPaths(root, sessionId);
    if (!(await exists(transcriptPath))) {
      continue;
    }

    const transcript = await fs.readFile(transcriptPath, "utf8");
    const excerpt = selectRecentTurns(parseTranscriptTurns(transcript), maxTurns, maxBytes);
    if (!excerpt) {
      continue;
    }

    return {
      sourceSessionId: sessionId,
      transcriptPath,
      transcriptRelativePath: relative(root, transcriptPath),
      excerpt,
      markdown: [
        "## Automatic Session Memory",
        `- Source session: ${sessionId}`,
        `- Source transcript: \`${relative(root, transcriptPath)}\``,
        "- Loaded automatically from prior Agentify session history. Verify against the current repo state if stale.",
        "",
        excerpt,
      ].join("\n"),
    };
  }

  return {
    sourceSessionId: null,
    transcriptPath: null,
    transcriptRelativePath: null,
    excerpt: "",
    markdown: buildNoMemoryMarkdown(),
  };
}

export async function prepareSessionMemoryRun(root, sessionRecord) {
  const startedAt = new Date().toISOString();
  const paths = getSessionArtifactPaths(root, sessionRecord.sessionId);
  await ensureDir(paths.sessionDir);

  const memoryMarkdown = sessionRecord.memoryContext?.markdown || buildNoMemoryMarkdown();
  await writeText(paths.memoryContextPath, `${memoryMarkdown.trim()}\n`);

  const transcriptLines = [];
  if (await exists(paths.transcriptPath)) {
    transcriptLines.push("", "---", "");
  }
  transcriptLines.push(
    "# Agentify Session Run",
    `Session: ${sessionRecord.sessionId}`,
    `Provider: ${sessionRecord.provider}`,
    `Started: ${startedAt}`,
    `Capture mode: ${sessionRecord.captureMode}`,
    `Command: ${normalizeCommand(sessionRecord.command) || "n/a"}`,
    `Bootstrap: .agents/session/${sessionRecord.sessionId}/bootstrap.md`,
    `Memory context: ${relative(root, paths.memoryContextPath)}`,
    "",
    "> Session bootstrap reference",
    `Bootstrap context is persisted in \`.agents/session/${sessionRecord.sessionId}/bootstrap.md\`.`,
    "",
    "> Automatic session memory",
    sessionRecord.memoryContext?.excerpt || "No prior session transcript was available for automatic recall before this run.",
    "",
    "> Current task",
    sessionRecord.task || "Continue this session from the latest repository state.",
    ""
  );

  await fs.appendFile(paths.transcriptPath, `${transcriptLines.join("\n")}\n`, "utf8");
  return { startedAt, paths };
}

export async function finalizeSessionMemoryRun(root, sessionRecord, prepared, outcome, config) {
  const captureMaxBytes = getSessionMemoryLimit(config, "captureMaxKb", 48) * 1024;
  const providerOutput = [outcome?.stdout, outcome?.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
  const assistantText = providerOutput
    ? clipToBytes(providerOutput, captureMaxBytes)
    : "Agentify launched the provider in inherited interactive mode, so the full assistant transcript was not captured for this run. The prompt, bootstrap, memory context, and launch record were still persisted automatically.";
  const validationSummary = outcome?.validation
    ? outcome.validation.passed ? "passed" : "failed"
    : outcome?.skippedRefresh ? "skipped" : "not-run";
  const phase = outcome?.phase || "complete";
  const endedAt = new Date().toISOString();

  const transcriptTail = [
    "> Provider response",
    assistantText,
    "",
    "> Run status",
    `Command phase: ${phase}`,
    `Exit code: ${outcome?.exitCode ?? 1}`,
    `Validation: ${validationSummary}`,
    `Ended: ${endedAt}`,
    ""
  ].join("\n");
  await fs.appendFile(prepared.paths.transcriptPath, transcriptTail, "utf8");

  const launchRecord = {
    schema_version: "1.0",
    session_id: sessionRecord.sessionId,
    provider: sessionRecord.provider,
    started_at: prepared.startedAt,
    ended_at: endedAt,
    capture_mode: sessionRecord.captureMode,
    command: Array.isArray(sessionRecord.command) ? sessionRecord.command : [],
    task: sessionRecord.task,
    prompt: sessionRecord.prompt,
    transcript_path: relative(root, prepared.paths.transcriptPath),
    memory_context_path: relative(root, prepared.paths.memoryContextPath),
    memory_source_session_id: sessionRecord.memoryContext?.sourceSessionId || null,
    memory_source_transcript: sessionRecord.memoryContext?.transcriptRelativePath || null,
    phase,
    exit_code: outcome?.exitCode ?? 1,
    validation: validationSummary,
    stdout: clipToBytes(outcome?.stdout || "", captureMaxBytes),
    stderr: clipToBytes(outcome?.stderr || "", captureMaxBytes),
  };
  await fs.appendFile(prepared.paths.launchesPath, `${JSON.stringify(launchRecord)}\n`, "utf8");
}
