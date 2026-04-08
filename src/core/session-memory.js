import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ensureDir, exists, relative, writeText } from "./fs.js";

const execFileAsync = promisify(execFile);

const MEMORY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "before",
  "continue",
  "current",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "latest",
  "new",
  "of",
  "on",
  "or",
  "repo",
  "repository",
  "run",
  "session",
  "state",
  "task",
  "that",
  "the",
  "this",
  "to",
  "use",
  "using",
  "we",
  "with",
  "work",
]);

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

function stripAnsiSequences(text) {
  return String(text || "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function stripBackspaces(text) {
  let value = String(text || "");
  let previous = "";
  while (value !== previous) {
    previous = value;
    value = value.replace(/[^\n]\u0008/g, "");
  }
  return value.replace(/\u0008+/g, "");
}

export function normalizeInteractiveCapture(text) {
  const cleaned = stripBackspaces(
    stripAnsiSequences(String(text || ""))
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[\u0000-\u0007\u000B-\u001F\u007F]/g, "")
  );

  const lines = cleaned
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      return !trimmed.startsWith("Script started on ") && !trimmed.startsWith("Script done on ");
    });

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function normalizeQuery(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeQuery(text) {
  return Array.from(new Set(
    normalizeQuery(text)
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !MEMORY_STOP_WORDS.has(token))
  ));
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
    "- Backend: none",
    "- No relevant prior Agentify memory matched this run.",
    "- Agentify still writes MemPalace-compatible transcript artifacts automatically for future reuse.",
    "",
    "No recalled memory excerpt was injected before this run.",
  ].join("\n");
}

function buildPassages(turns) {
  const passages = [];

  for (let index = 0; index < turns.length; index += 1) {
    const single = turns[index];
    if (single) {
      passages.push(single);
    }

    const pair = [turns[index], turns[index + 1]].filter(Boolean).join("\n\n").trim();
    if (pair) {
      passages.push(pair);
    }
  }

  return Array.from(new Set(passages.filter(Boolean)));
}

function scorePassage(query, tokens, passage) {
  if (!passage) {
    return 0;
  }

  const normalizedPassage = normalizeQuery(passage);
  if (!normalizedPassage) {
    return 0;
  }

  let score = 0;
  const normalizedQuery = normalizeQuery(query);
  if (normalizedQuery && normalizedPassage.includes(normalizedQuery)) {
    score += 12;
  }

  for (const token of tokens) {
    if (normalizedPassage.includes(token)) {
      score += token.length >= 6 ? 3 : 2;
    }
  }

  if (passage.includes("> Provider response")) {
    score += 1;
  }
  if (passage.includes("> Current task")) {
    score += 1;
  }

  return score;
}

function buildMemoryMarkdown(backend, hits, extraBullets, maxBytes) {
  const header = [
    "## Automatic Session Memory",
    `- Backend: ${backend}`,
    ...extraBullets.filter(Boolean),
    "- Loaded automatically from prior Agentify history. Verify against the current repo state if stale.",
    "",
  ].join("\n");

  let markdown = header;
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index];
    const block = [
      `### Hit ${index + 1}`,
      hit.sessionId ? `- Source session: ${hit.sessionId}` : null,
      hit.transcriptRelativePath ? `- Source transcript: \`${hit.transcriptRelativePath}\`` : null,
      Number.isFinite(hit.score) ? `- Match score: ${hit.score}` : null,
      "",
      hit.excerpt,
      "",
    ].filter(Boolean).join("\n");

    if (bytes(markdown) + bytes(block) <= maxBytes) {
      markdown += block;
      continue;
    }

    const remaining = maxBytes - bytes(markdown);
    if (remaining > 0) {
      markdown += clipToBytes(block, remaining);
    }
    break;
  }

  return markdown.trim();
}

function buildMemoryResult(backend, hits, extraBullets, maxBytes) {
  const source = hits[0] || {};
  const excerpt = clipToBytes(hits.map((hit) => hit.excerpt).join("\n\n"), maxBytes);
  return {
    backend,
    sourceSessionId: source.sessionId || null,
    transcriptPath: source.transcriptPath || null,
    transcriptRelativePath: source.transcriptRelativePath || null,
    excerpt,
    hits,
    markdown: buildMemoryMarkdown(backend, hits, extraBullets, maxBytes),
    sessionDir,
    transcriptPath: path.join(sessionDir, "transcript.md"),
    memoryContextPath: path.join(sessionDir, "memory-context.md"),
    launchesPath: path.join(sessionDir, "launches.jsonl"),
    rawInteractiveLogPath: path.join(sessionDir, "interactive.log"),
  };
}

function getRepoWing(root) {
  return path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "agentify_repo";
}

async function listSessionTranscripts(root) {
  const sessionsDir = path.join(root, ".agents", "session");
  if (!(await exists(sessionsDir))) {
    return [];
  }

  const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  const transcripts = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const transcriptPath = path.join(sessionsDir, entry.name, "transcript.md");
    if (!(await exists(transcriptPath))) {
      continue;
    }
    const stat = await fs.stat(transcriptPath);
    transcripts.push({
      sessionId: entry.name,
      transcriptPath,
      transcriptRelativePath: relative(root, transcriptPath),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }

  return transcripts.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function getMemPalacePaths(root) {
  const baseDir = path.join(root, ".agents", "mempalace");
  return {
    baseDir,
    palacePath: path.join(baseDir, "palace"),
    exportDir: path.join(baseDir, "session-exports"),
    syncStatePath: path.join(baseDir, "session-sync.json"),
  };
}

async function syncMemPalaceSessionExports(root, transcripts) {
  const { palacePath, exportDir, syncStatePath } = getMemPalacePaths(root);
  const fingerprint = createHash("sha1")
    .update(JSON.stringify(transcripts.map((item) => ({
      sessionId: item.sessionId,
      path: item.transcriptRelativePath,
      mtimeMs: item.mtimeMs,
      size: item.size,
    }))))
    .digest("hex");

  let cachedState = null;
  if (await exists(syncStatePath)) {
    try {
      cachedState = JSON.parse(await fs.readFile(syncStatePath, "utf8"));
    } catch {
      cachedState = null;
    }
  }

  if (cachedState?.fingerprint === fingerprint && await exists(palacePath)) {
    return { synced: true, fingerprint, palacePath, exportDir, cached: true };
  }

  await fs.rm(palacePath, { recursive: true, force: true });
  await fs.rm(exportDir, { recursive: true, force: true });
  await ensureDir(exportDir);

  for (const item of transcripts) {
    const transcript = await fs.readFile(item.transcriptPath, "utf8");
    const exportPath = path.join(exportDir, `${item.sessionId}.md`);
    await writeText(exportPath, [
      "# Agentify Transcript Export",
      `Source session: ${item.sessionId}`,
      `Source transcript: ${item.transcriptRelativePath}`,
      "",
      transcript.trim(),
      "",
    ].join("\n"));
  }

  return { synced: false, fingerprint, palacePath, exportDir, syncStatePath, cached: false, transcriptCount: transcripts.length };
}

async function runMemPalace(root, args, palacePath) {
  const env = {
    ...process.env,
    MEMPALACE_PALACE_PATH: palacePath,
  };
  return execFileAsync(process.env.AGENTIFY_MEMPALACE_CMD || "mempalace", args, {
    cwd: root,
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function createMemPalaceBackend(root, query, config) {
  const transcripts = await listSessionTranscripts(root);
  const tokens = tokenizeQuery(query);

  return {
    name: "mempalace",
    async recall() {
      if (transcripts.length === 0 || tokens.length === 0) {
        return null;
      }

      const wing = getRepoWing(root);
      const { palacePath, exportDir } = getMemPalacePaths(root);
      try {
        const sync = await syncMemPalaceSessionExports(root, transcripts);
        if (!sync.cached) {
          await runMemPalace(root, ["mine", exportDir, "--mode", "convos", "--wing", wing, "--agent", "agentify"], palacePath);
          await writeText(sync.syncStatePath, `${JSON.stringify({
            schema_version: "1.0",
            fingerprint: sync.fingerprint,
            transcript_count: sync.transcriptCount,
            updated_at: new Date().toISOString(),
          }, null, 2)}\n`);
        }
        const resultCount = String(getSessionMemoryLimit(config, "memoryResults", 3));
        const { stdout } = await runMemPalace(root, ["search", query, "--wing", wing, "--results", resultCount], palacePath);
        const excerpt = clipToBytes(stdout.trim(), getSessionMemoryLimit(config, "memoryPromptMaxKb", 4) * 1024);
        if (!excerpt || excerpt.includes("No results found")) {
          return null;
        }

        return buildMemoryResult("mempalace", [{
          sessionId: null,
          transcriptPath: exportDir,
          transcriptRelativePath: relative(root, exportDir),
          score: Number.NaN,
          excerpt,
        }], [
          `- Query: ${query}`,
          `- Wing: ${wing}`,
          "- Source: repo-local MemPalace session export index.",
        ], getSessionMemoryLimit(config, "memoryPromptMaxKb", 4) * 1024);
      } catch (error) {
        if (error?.code === "ENOENT") {
          return null;
        }
        return null;
      }
    },
  };
}

async function createTranscriptSearchBackend(root, query, config) {
  const transcripts = await listSessionTranscripts(root);
  const tokens = tokenizeQuery(query);
  const maxBytes = getSessionMemoryLimit(config, "memoryPromptMaxKb", 4) * 1024;
  const maxResults = getSessionMemoryLimit(config, "memoryResults", 3);

  return {
    name: "local-session-search",
    async recall() {
      if (transcripts.length === 0 || tokens.length === 0) {
        return null;
      }

      const matches = [];

      for (const item of transcripts) {
        const transcript = await fs.readFile(item.transcriptPath, "utf8");
        const passages = buildPassages(parseTranscriptTurns(transcript));
        for (const passage of passages) {
          const score = scorePassage(query, tokens, passage);
          if (score < 4) {
            continue;
          }
          matches.push({
            sessionId: item.sessionId,
            transcriptPath: item.transcriptPath,
            transcriptRelativePath: item.transcriptRelativePath,
            score,
            excerpt: passage,
            mtimeMs: item.mtimeMs,
          });
        }
      }

      matches.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);
      const hits = matches.slice(0, maxResults).map((hit) => ({
        ...hit,
        excerpt: clipToBytes(hit.excerpt, Math.max(256, Math.floor(maxBytes / Math.max(1, maxResults)))),
      }));
      if (hits.length === 0) {
        return null;
      }

      return buildMemoryResult("local-session-search", hits, [
        `- Query: ${query}`,
        `- Search scope: \`${relative(root, path.join(root, ".agents", "session"))}/\``,
      ], maxBytes);
    },
  };
}

async function createLineageBackend(root, manifest, config) {
  const maxBytes = getSessionMemoryLimit(config, "memoryPromptMaxKb", 4) * 1024;
  const maxTurns = getSessionMemoryLimit(config, "memoryTurns", 6);
  const candidates = [manifest?.session_id, manifest?.parent_id].filter(Boolean);

  return {
    name: "lineage-replay",
    async recall() {
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

        return buildMemoryResult("lineage-replay", [{
          sessionId,
          transcriptPath,
          transcriptRelativePath: relative(root, transcriptPath),
          score: Number.NaN,
          excerpt,
        }], [
          "- Source: direct session lineage replay.",
        ], maxBytes);
      }

      return null;
    },
  };
}

async function createMemoryBackends(root, options, config) {
  return [
    await createMemPalaceBackend(root, options.query || "", config),
    await createTranscriptSearchBackend(root, options.query || "", config),
    await createLineageBackend(root, options.manifest || null, config),
  ];
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

export async function loadAutomaticMemory(root, options, config) {
  const backends = await createMemoryBackends(root, options, config);
  for (const backend of backends) {
    const result = await backend.recall();
    if (result?.excerpt) {
      return result;
    }
  }

  return {
    backend: "none",
    sourceSessionId: null,
    transcriptPath: null,
    transcriptRelativePath: null,
    excerpt: "",
    hits: [],
    markdown: buildNoMemoryMarkdown(),
  };
}

export async function loadAutomaticRunMemory(root, query, config) {
  return loadAutomaticMemory(root, { query }, config);
}

export async function loadAutomaticSessionMemory(root, manifest, config, query = "") {
  return loadAutomaticMemory(root, { manifest, query }, config);
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

  await fs.appendFile(paths.transcriptPath, `${transcriptLines.filter(Boolean).join("\n")}\n`, "utf8");
  return { startedAt, paths };
}

export async function finalizeSessionMemoryRun(root, sessionRecord, prepared, outcome, config) {
  const captureMaxBytes = getSessionMemoryLimit(config, "captureMaxKb", 48) * 1024;
  const providerOutput = outcome?.interactiveTranscript
    ? String(outcome.interactiveTranscript).trim()
    : [outcome?.stdout, outcome?.stderr]
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
    `Capture mode used: ${sessionRecord.captureMode}`,
    outcome?.rawInteractiveLogPath ? `Raw interactive log: ${relative(root, outcome.rawInteractiveLogPath)}` : null,
    `Ended: ${endedAt}`,
    ""
  ].filter(Boolean).join("\n");
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
    memory_backend: sessionRecord.memoryContext?.backend || "none",
    raw_interactive_log_path: outcome?.rawInteractiveLogPath
      ? relative(root, outcome.rawInteractiveLogPath)
      : null,
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
