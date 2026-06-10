import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import {
  appendPrivateText,
  ensureDir,
  ensurePrivateDir,
  exists,
  PRIVATE_FILE_MODE,
  readJson,
  relative,
  writePrivateJson,
  writePrivateText,
  writeText,
} from "./fs.js";
import { resolveLocalAgentifyPaths } from "./project-store.js";

const execFileAsync = promisify(execFile);
const SESSION_LOCK_STALE_MS = 300000;
const SESSION_LOCK_RETRY_MS = 25;
const SESSION_LOCK_WAIT_MS = 5000;

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

function normalizeTimeoutMs(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getOutcomeTimeout(outcome) {
  const timedOut = Boolean(outcome?.timedOut ?? outcome?.timed_out);
  return {
    timedOut,
    timeoutMs: normalizeTimeoutMs(outcome?.timeoutMs ?? outcome?.timeout_ms),
    signal: outcome?.signal || null,
    reason: timedOut ? outcome?.reason || "timeout" : outcome?.reason || null,
  };
}

function buildTimeoutRecordFields(outcome) {
  const timeout = getOutcomeTimeout(outcome);
  return {
    timed_out: timeout.timedOut,
    timeout_ms: timeout.timeoutMs,
    signal: timeout.signal,
    ...(timeout.timedOut ? { reason: timeout.reason } : {}),
  };
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
      .replace(/[\u0000-\u0007\u000B-\u001F\u007F]/g, ""),
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
    .replaceAll('"', '\\"');
}

export function redactSensitiveText(value) {
  return String(value || "")
    .replace(
      /\b([A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASS|PRIVATE[_-]?KEY)[A-Z0-9_-]*\s*[:=]\s*)(["']?)([^\s"'`,;]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{4,}\b/g, "[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]");
}

function redactSensitiveValue(value) {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactSensitiveValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSensitiveValue(entry)]));
  }
  return value;
}

function normalizeCommand(command) {
  if (!Array.isArray(command) || command.length === 0) {
    return "";
  }
  return command
    .map((part) => {
      const text = redactSensitiveText(part);
      return /\s/.test(text) ? `"${shellEscape(text)}"` : text;
    })
    .join(" ");
}

function normalizeQuery(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeQuery(text) {
  return Array.from(
    new Set(
      normalizeQuery(text)
        .split(/\s+/)
        .filter((token) => token.length >= 3 && !MEMORY_STOP_WORDS.has(token)),
    ),
  );
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
    ]
      .filter(Boolean)
      .join("\n");

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
  };
}

function getRepoWing(root) {
  return (
    path
      .basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "agentify_repo"
  );
}

async function listSessionTranscripts(root) {
  const sessionsDir = resolveLocalAgentifyPaths(root).sessionRoot;
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

async function listStructuredSessionTurns(root) {
  const sessionsDir = resolveLocalAgentifyPaths(root).sessionRoot;
  if (!(await exists(sessionsDir))) {
    return [];
  }

  const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const turnsPath = path.join(sessionsDir, entry.name, "turns.jsonl");
    if (!(await exists(turnsPath))) {
      continue;
    }
    const stat = await fs.stat(turnsPath);
    results.push({
      sessionId: entry.name,
      turnsPath,
      turnsRelativePath: relative(root, turnsPath),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }

  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function getMemPalacePaths(root) {
  const baseDir = resolveLocalAgentifyPaths(root).mempalaceRoot;
  return {
    baseDir,
    palacePath: path.join(baseDir, "palace"),
    exportDir: path.join(baseDir, "session-exports"),
    syncStatePath: path.join(baseDir, "session-sync.json"),
  };
}

function createMemPalaceTranscriptFingerprint(transcripts) {
  return createHash("sha1")
    .update(
      JSON.stringify(
        transcripts.map((item) => ({
          sessionId: item.sessionId,
          path: item.transcriptRelativePath,
          mtimeMs: item.mtimeMs,
          size: item.size,
        })),
      ),
    )
    .digest("hex");
}

async function writeMemPalaceSessionExports(exportDir, transcripts) {
  await ensureDir(exportDir);

  for (const item of transcripts) {
    const transcript = await fs.readFile(item.transcriptPath, "utf8");
    const exportPath = path.join(exportDir, `${item.sessionId}.md`);
    await writeText(
      exportPath,
      [
        "# Agentify Transcript Export",
        `Source session: ${item.sessionId}`,
        `Source transcript: ${item.transcriptRelativePath}`,
        "",
        transcript.trim(),
        "",
      ].join("\n"),
    );
  }
}

async function syncMemPalaceSessionExports(root, transcripts) {
  const { baseDir, palacePath, exportDir, syncStatePath } = getMemPalacePaths(root);
  const fingerprint = createMemPalaceTranscriptFingerprint(transcripts);

  let cachedState = null;
  if (await exists(syncStatePath)) {
    try {
      cachedState = JSON.parse(await fs.readFile(syncStatePath, "utf8"));
    } catch {
      cachedState = null;
    }
  }

  if (cachedState?.fingerprint === fingerprint && (await exists(palacePath))) {
    return { synced: true, fingerprint, palacePath, exportDir, cached: true };
  }

  await ensureDir(baseDir);
  const refreshDir = await fs.mkdtemp(path.join(baseDir, "refresh-"));
  const stagedPalacePath = path.join(refreshDir, "palace");
  const stagedExportDir = path.join(refreshDir, "session-exports");
  await writeMemPalaceSessionExports(stagedExportDir, transcripts);

  return {
    synced: false,
    fingerprint,
    palacePath: stagedPalacePath,
    exportDir: stagedExportDir,
    livePalacePath: palacePath,
    liveExportDir: exportDir,
    refreshDir,
    syncStatePath,
    cached: false,
    transcriptCount: transcripts.length,
  };
}

async function movePathIfExists(from, to) {
  if (!(await exists(from))) {
    return false;
  }
  await ensureDir(path.dirname(to));
  await fs.rename(from, to);
  return true;
}

async function replacePathIfExists(from, to, backupDir, backupName) {
  const backupPath = path.join(backupDir, backupName);
  const hadOriginal = await movePathIfExists(to, backupPath);
  try {
    const movedReplacement = await movePathIfExists(from, to);
    if (!movedReplacement) {
      if (hadOriginal) {
        await movePathIfExists(backupPath, to);
      }
      throw new Error(`MemPalace refresh did not create replacement path: ${from}`);
    }
    return { hadOriginal, backupPath, targetPath: to, movedReplacement };
  } catch (error) {
    if (hadOriginal) {
      await movePathIfExists(backupPath, to);
    }
    throw error;
  }
}

async function promoteMemPalaceRefresh(sync) {
  const backupDir = await fs.mkdtemp(path.join(path.dirname(sync.livePalacePath), "previous-"));
  const promoted = [];

  try {
    promoted.push(await replacePathIfExists(sync.palacePath, sync.livePalacePath, backupDir, "palace"));
    promoted.push(await replacePathIfExists(sync.exportDir, sync.liveExportDir, backupDir, "session-exports"));
    await writeText(
      sync.syncStatePath,
      `${JSON.stringify(
        {
          schema_version: "1.0",
          fingerprint: sync.fingerprint,
          transcript_count: sync.transcriptCount,
          updated_at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    for (const entry of promoted.reverse()) {
      if (!entry) {
        continue;
      }
      if (entry.movedReplacement) {
        await fs.rm(entry.targetPath, { recursive: true, force: true });
      }
      if (entry.hadOriginal) {
        await movePathIfExists(entry.backupPath, entry.targetPath);
      }
    }
    throw error;
  } finally {
    await fs.rm(backupDir, { recursive: true, force: true });
    if (sync.refreshDir) {
      await fs.rm(sync.refreshDir, { recursive: true, force: true });
    }
  }
}

async function runMemPalace(root, args, palacePath, command = process.env.AGENTIFY_MEMPALACE_CMD || "mempalace") {
  const env = {
    ...process.env,
    MEMPALACE_PALACE_PATH: palacePath,
  };
  return execFileAsync(command, args, {
    cwd: root,
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function resolveCommandBinary(cmd) {
  if (cmd.includes("/") || cmd.includes("\\") || path.isAbsolute(cmd)) {
    try {
      await fs.access(cmd, fsConstants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  const pathEnv = process.env.PATH || "";
  if (!pathEnv) {
    return null;
  }
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // try next candidate
      }
    }
  }
  return null;
}

async function resolveMemPalaceBinary() {
  const configured = process.env.AGENTIFY_MEMPALACE_CMD
    ? await resolveCommandBinary(process.env.AGENTIFY_MEMPALACE_CMD)
    : null;
  return configured || (await resolveCommandBinary("mempalace"));
}

function inspectMemPalaceSearchOutput(stdout, config) {
  const excerpt = clipToBytes(
    String(stdout || "").trim(),
    getSessionMemoryLimit(config, "memoryPromptMaxKb", 4) * 1024,
  );
  const hasResultRow = /^\s*\[\d+\]\s/m.test(excerpt);
  const hasErrorStdout = /No palace found|Run: mempalace init/.test(excerpt);
  return {
    excerpt,
    hasResultRow,
    hasErrorStdout,
    usable: Boolean(excerpt && hasResultRow && !hasErrorStdout),
  };
}

function emitMemPalaceDegradedWarning(reason, error = null) {
  const detail = error?.message ? `: ${error.message}` : "";
  process.emitWarning(`MemPalace session memory degraded: ${reason}${detail}`, {
    code: "AGENTIFY_MEMPALACE_DEGRADED",
  });
}

async function searchMemPalaceIndex(root, query, config, wing, palacePath, command) {
  const resultCount = String(getSessionMemoryLimit(config, "memoryResults", 3));
  const { stdout } = await runMemPalace(
    root,
    ["search", query, "--wing", wing, "--results", resultCount],
    palacePath,
    command,
  );
  return inspectMemPalaceSearchOutput(stdout, config);
}

async function createMemPalaceBackend(root, query, config, sharedInventory = {}) {
  const transcripts = sharedInventory.transcripts ?? (await listSessionTranscripts(root));
  const command = sharedInventory.mempalaceBinary || (await resolveMemPalaceBinary());
  const tokens = tokenizeQuery(query);

  return {
    name: "mempalace",
    async recall() {
      if (transcripts.length === 0 || tokens.length === 0) {
        return null;
      }

      const wing = getRepoWing(root);
      const { palacePath, exportDir } = getMemPalacePaths(root);
      const recallFromIndex = async (targetPalacePath, targetExportDir, extraBullets = []) => {
        const search = await searchMemPalaceIndex(root, query, config, wing, targetPalacePath, command);
        if (search.hasErrorStdout) {
          emitMemPalaceDegradedWarning("search reported a missing palace");
          return null;
        }
        if (!search.usable) {
          return null;
        }
        return buildMemoryResult(
          "mempalace",
          [
            {
              sessionId: null,
              transcriptPath: targetExportDir,
              transcriptRelativePath: relative(root, targetExportDir),
              score: Number.NaN,
              excerpt: search.excerpt,
            },
          ],
          [
            `- Query: ${query}`,
            `- Wing: ${wing}`,
            "- Source: repo-local MemPalace session export index.",
            ...extraBullets,
          ],
          getSessionMemoryLimit(config, "memoryPromptMaxKb", 4) * 1024,
        );
      };

      try {
        const sync = await syncMemPalaceSessionExports(root, transcripts);
        if (sync.cached) {
          return await recallFromIndex(sync.palacePath, sync.exportDir);
        }

        let refreshReady = false;
        try {
          await runMemPalace(
            root,
            ["mine", sync.exportDir, "--mode", "convos", "--wing", wing, "--agent", "agentify"],
            sync.palacePath,
            command,
          );
          const stagedSearch = await searchMemPalaceIndex(root, query, config, wing, sync.palacePath, command);
          if (stagedSearch.hasErrorStdout) {
            emitMemPalaceDegradedWarning("refreshed index search reported a missing palace");
          } else {
            await promoteMemPalaceRefresh(sync);
            refreshReady = true;
            if (stagedSearch.usable) {
              return buildMemoryResult(
                "mempalace",
                [
                  {
                    sessionId: null,
                    transcriptPath: sync.liveExportDir,
                    transcriptRelativePath: relative(root, sync.liveExportDir),
                    score: Number.NaN,
                    excerpt: stagedSearch.excerpt,
                  },
                ],
                [`- Query: ${query}`, `- Wing: ${wing}`, "- Source: repo-local MemPalace session export index."],
                getSessionMemoryLimit(config, "memoryPromptMaxKb", 4) * 1024,
              );
            }
          }
        } catch (error) {
          emitMemPalaceDegradedWarning("refresh failed; keeping the previous index", error);
        } finally {
          if (!refreshReady) {
            await fs.rm(sync.refreshDir, { recursive: true, force: true });
          }
        }

        if (await exists(palacePath)) {
          return await recallFromIndex(palacePath, exportDir, [
            "- Note: using the previous MemPalace index because refresh did not produce a usable replacement.",
          ]);
        }
        return null;
      } catch (error) {
        if (error?.code === "ENOENT") {
          return null;
        }
        emitMemPalaceDegradedWarning("runtime failure", error);
        return null;
      }
    },
  };
}

async function createTranscriptSearchBackend(root, query, config, sharedInventory = {}) {
  const transcripts = sharedInventory.transcripts ?? (await listSessionTranscripts(root));
  const structuredAll = sharedInventory.structuredTurns ?? (await listStructuredSessionTurns(root));
  const structuredOnly = structuredAll.filter((item) => !transcripts.some((t) => t.sessionId === item.sessionId));
  const tokens = tokenizeQuery(query);
  const maxBytes = getSessionMemoryLimit(config, "memoryPromptMaxKb", 4) * 1024;
  const maxResults = getSessionMemoryLimit(config, "memoryResults", 3);

  return {
    name: "local-session-search",
    async recall() {
      if ((transcripts.length === 0 && structuredOnly.length === 0) || tokens.length === 0) {
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

      for (const item of structuredOnly) {
        const turns = await readStructuredTurnsAsText(item.turnsPath);
        const passages = buildPassages(turns);
        for (const passage of passages) {
          const score = scorePassage(query, tokens, passage);
          if (score < 4) {
            continue;
          }
          matches.push({
            sessionId: item.sessionId,
            transcriptPath: item.turnsPath,
            transcriptRelativePath: item.turnsRelativePath,
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

      return buildMemoryResult(
        "local-session-search",
        hits,
        [`- Query: ${query}`, `- Search scope: \`${relative(root, resolveLocalAgentifyPaths(root).sessionRoot)}/\``],
        maxBytes,
      );
    },
  };
}

async function createStructuredLineageBackend(root, manifest, config) {
  const maxBytes = getSessionMemoryLimit(config, "memoryPromptMaxKb", 4) * 1024;
  const candidates = [manifest?.session_id, manifest?.parent_id].filter(Boolean);

  return {
    name: "structured-lineage",
    async recall() {
      for (const sessionId of candidates) {
        const paths = getSessionArtifactPaths(root, sessionId);
        if (!(await exists(paths.contextPath))) {
          continue;
        }
        let ctx;
        try {
          ctx = await readJson(paths.contextPath);
        } catch {
          continue;
        }
        const runs = Array.isArray(ctx?.run_history) ? ctx.run_history : [];
        const rolling = String(ctx?.rolling_summary || "").trim();
        if (runs.length === 0 && !rolling) {
          continue;
        }
        const lines = [];
        if (rolling) {
          lines.push("Rolling summary:", rolling);
        }
        if (runs.length > 0) {
          lines.push("", "Recent runs:");
          for (const run of runs.slice(-5)) {
            const when = run?.ended_at || run?.started_at || "";
            const timeout = run?.timed_out ? ` timeout=${run.timeout_ms ?? "unknown"}ms` : "";
            lines.push(
              `- ${when} task="${(run?.task || "").trim()}" exit=${run?.exit_code ?? "?"} validation=${run?.validation || "not-run"}${timeout}`,
            );
            if (run?.assistant_summary) {
              lines.push(`  summary: ${run.assistant_summary}`);
            }
          }
        }
        const excerpt = clipToBytes(lines.join("\n").trim(), maxBytes);
        if (!excerpt) {
          continue;
        }
        return buildMemoryResult(
          "structured-lineage",
          [
            {
              sessionId,
              transcriptPath: paths.contextPath,
              transcriptRelativePath: relative(root, paths.contextPath),
              score: Number.NaN,
              excerpt,
            },
          ],
          ["- Source: structured session state (context.json run_history + rolling_summary)."],
          maxBytes,
        );
      }
      return null;
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
        const { transcriptPath, turnsPath } = getSessionArtifactPaths(root, sessionId);
        let turns = [];
        let sourcePath = null;
        if (await exists(transcriptPath)) {
          const transcript = await fs.readFile(transcriptPath, "utf8");
          turns = parseTranscriptTurns(transcript);
          sourcePath = transcriptPath;
        } else if (await exists(turnsPath)) {
          turns = await readStructuredTurnsAsText(turnsPath);
          sourcePath = turnsPath;
        } else {
          continue;
        }
        const excerpt = selectRecentTurns(turns, maxTurns, maxBytes);
        if (!excerpt) {
          continue;
        }

        return buildMemoryResult(
          "lineage-replay",
          [
            {
              sessionId,
              transcriptPath: sourcePath,
              transcriptRelativePath: relative(root, sourcePath),
              score: Number.NaN,
              excerpt,
            },
          ],
          ["- Source: direct session lineage replay."],
          maxBytes,
        );
      }

      return null;
    },
  };
}

async function createMemoryBackends(root, options, config) {
  const query = options.query || "";
  const manifest = options.manifest || null;
  const tokens = tokenizeQuery(query);
  const needsTranscriptInventory = tokens.length > 0;
  const sharedInventory = {};
  if (needsTranscriptInventory) {
    const [transcripts, structuredTurns] = await Promise.all([
      listSessionTranscripts(root),
      listStructuredSessionTurns(root),
    ]);
    sharedInventory.transcripts = transcripts;
    sharedInventory.structuredTurns = structuredTurns;
  }

  const backends = [await createStructuredLineageBackend(root, manifest, config)];

  if (needsTranscriptInventory) {
    const mempalaceBinary = await resolveMemPalaceBinary();
    if (mempalaceBinary) {
      sharedInventory.mempalaceBinary = mempalaceBinary;
      backends.push(await createMemPalaceBackend(root, query, config, sharedInventory));
    }
    backends.push(await createTranscriptSearchBackend(root, query, config, sharedInventory));
  }

  backends.push(await createLineageBackend(root, manifest, config));
  return backends;
}

export function getSessionArtifactPaths(root, sessionId) {
  const sessionDir = path.join(resolveLocalAgentifyPaths(root).sessionRoot, sessionId);
  return {
    sessionDir,
    transcriptPath: path.join(sessionDir, "transcript.md"),
    memoryContextPath: path.join(sessionDir, "memory-context.md"),
    handoffJsonPath: path.join(sessionDir, "handoff.json"),
    handoffMarkdownPath: path.join(sessionDir, "handoff.md"),
    launchesPath: path.join(sessionDir, "launches.jsonl"),
    turnsPath: path.join(sessionDir, "turns.jsonl"),
    contextEventsPath: path.join(sessionDir, "context-events.jsonl"),
    contextFactsPath: path.join(sessionDir, "context-facts.json"),
    contextFactsMarkdownPath: path.join(sessionDir, "context-facts.md"),
    rawInteractiveLogPath: path.join(sessionDir, "interactive.log"),
    fetchOutputsPath: path.join(sessionDir, "context-fetches.jsonl"),
    contextPath: path.join(sessionDir, "context.json"),
    lockPath: path.join(sessionDir, ".session.lock"),
  };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function canReclaimSessionLock(existing) {
  if (!existing || typeof existing.acquired_at !== "number") {
    return false;
  }

  if (Date.now() - existing.acquired_at <= SESSION_LOCK_STALE_MS) {
    return false;
  }

  return !(existing.host === os.hostname() && isProcessAlive(existing.pid));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSessionArtifactLock(paths, operation, options = {}) {
  await ensurePrivateDir(paths.sessionDir);
  const waitMs = Math.max(0, Number(options.waitMs) || 0);
  const deadline = Date.now() + waitMs;

  for (;;) {
    const lockData = {
      pid: process.pid,
      operation,
      acquired_at: Date.now(),
      host: os.hostname(),
    };

    try {
      const handle = await fs.open(paths.lockPath, "wx", PRIVATE_FILE_MODE);
      try {
        await handle.writeFile(JSON.stringify(lockData));
      } finally {
        await handle.close();
      }
      return { release: () => fs.unlink(paths.lockPath).catch(() => {}) };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }

    let existing = null;
    try {
      existing = JSON.parse(await fs.readFile(paths.lockPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Session artifact lock exists but is unreadable: ${paths.lockPath}`);
      }
      await sleep(Math.min(SESSION_LOCK_RETRY_MS, Math.max(1, deadline - Date.now())));
      continue;
    }

    if (canReclaimSessionLock(existing)) {
      await fs.unlink(paths.lockPath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Session ${path.basename(paths.sessionDir)} is already being updated by PID ${existing.pid} for '${existing.operation}' since ${new Date(existing.acquired_at).toISOString()}`,
      );
    }
    await sleep(Math.min(SESSION_LOCK_RETRY_MS, Math.max(1, deadline - Date.now())));
  }
}

async function withSessionArtifactLock(root, sessionId, operation, callback) {
  const paths = getSessionArtifactPaths(root, sessionId);
  const lock = await acquireSessionArtifactLock(paths, operation, { waitMs: SESSION_LOCK_WAIT_MS });
  try {
    return await callback(paths);
  } finally {
    await lock.release();
  }
}

async function safeFileBytes(filePath) {
  if (!filePath || !(await exists(filePath))) {
    return 0;
  }
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function getContextThresholdBytes(config) {
  const value = Number(config?.context?.autoPrepareChildAboveKb);
  const thresholdKb = Number.isFinite(value) && value > 0 ? value : 96;
  return Math.round(thresholdKb * 1024);
}

async function buildEstimatedManagedContext(root, sessionRecord, paths, config) {
  const promptBytes = bytes(sessionRecord?.prompt || "");
  const transcriptBytes = await safeFileBytes(paths.transcriptPath);
  const fetchOutputBytes = await safeFileBytes(paths.fetchOutputsPath);
  const memoryArtifactBytes =
    (await safeFileBytes(paths.memoryContextPath)) +
    (await safeFileBytes(paths.contextPath)) +
    (await safeFileBytes(paths.turnsPath));
  const estimatedManagedContextBytes = promptBytes + transcriptBytes + fetchOutputBytes + memoryArtifactBytes;
  const rolloverThresholdBytes = getContextThresholdBytes(config);

  return {
    schema_version: "1.0",
    estimate: true,
    basis: "managed_context_bytes",
    estimated_managed_context_bytes: estimatedManagedContextBytes,
    rollover_threshold_bytes: rolloverThresholdBytes,
    above_rollover_threshold: estimatedManagedContextBytes >= rolloverThresholdBytes,
    bytes: {
      prompt: promptBytes,
      transcript: transcriptBytes,
      fetch_outputs: fetchOutputBytes,
      memory_artifacts: memoryArtifactBytes,
    },
    note: "Estimated from Agentify-managed prompt, transcript, fetch output, and memory artifact bytes; provider live context usage is not directly observable.",
  };
}

async function readJsonlTurns(targetPath) {
  if (!(await exists(targetPath))) {
    return [];
  }
  const raw = await fs.readFile(targetPath, "utf8");
  const turns = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      turns.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return turns;
}

function turnToTranscriptText(turn) {
  if (!turn || typeof turn !== "object") {
    return "";
  }
  const label =
    turn.role === "assistant" ? "> Provider response" : turn.role === "system" ? "> System" : "> Current task";
  return `${label}\n${String(turn.content || "").trim()}`.trim();
}

async function readStructuredTurnsAsText(turnsPath) {
  const turns = await readJsonlTurns(turnsPath);
  return turns.map(turnToTranscriptText).filter(Boolean);
}

async function appendTurnsRecord(turnsPath, record) {
  await appendPrivateText(turnsPath, `${JSON.stringify(redactSensitiveValue(record))}\n`);
}

function clampRunHistoryEntry(entry, summaryMaxBytes) {
  const result = {
    started_at: entry.started_at,
    ended_at: entry.ended_at,
    task: clipToBytes(redactSensitiveText(entry.task || ""), Math.max(80, Math.floor(summaryMaxBytes / 2))),
    assistant_summary: clipToBytes(redactSensitiveText(entry.assistant_summary || ""), summaryMaxBytes),
    exit_code: Number.isFinite(entry.exit_code) ? entry.exit_code : null,
    ...buildTimeoutRecordFields(entry),
    validation: entry.validation || "not-run",
    phase: entry.phase || "complete",
    memory_backend: entry.memory_backend || "none",
  };
  if (entry.managed_context) {
    result.managed_context = entry.managed_context;
  }
  return result;
}

function buildRollingSummary(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return "";
  }
  const latest = history[history.length - 1] || {};
  const task = latest.task ? `Last task: ${latest.task}` : null;
  const summary = latest.assistant_summary ? `Last outcome: ${latest.assistant_summary}` : null;
  const timeout = latest.timed_out ? `, timeout after ${latest.timeout_ms ?? "unknown"}ms` : "";
  const status =
    latest.exit_code !== null && latest.exit_code !== undefined
      ? `Last exit: ${latest.exit_code}, validation ${latest.validation || "not-run"}${timeout}`
      : null;
  return [task, status, summary].filter(Boolean).join("\n");
}

async function readJsonLines(filePath) {
  if (!(await exists(filePath))) {
    return [];
  }
  const raw = await fs.readFile(filePath, "utf8");
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

function renderContextFactsMarkdown(facts) {
  const tasks = facts.recent_tasks.length ? facts.recent_tasks.map((task) => `- ${task}`).join("\n") : "- none";
  return `# Context Facts

Session: ${facts.session_id}
Turns: ${facts.event_counts.turns}
Launches: ${facts.event_counts.launches}
Latest phase: ${facts.latest_phase || "none"}
Latest exit code: ${facts.latest_exit_code ?? "none"}
Latest validation: ${facts.latest_validation || "none"}

## Recent Tasks
${tasks}
`;
}

async function compactSessionContextUnlocked(
  root,
  sessionId,
  config = {},
  paths = getSessionArtifactPaths(root, sessionId),
) {
  if (!(await exists(paths.contextPath))) {
    throw new Error(`Session ${sessionId} does not have context.json`);
  }

  const [context, turns, launches] = await Promise.all([
    readJson(paths.contextPath),
    readJsonLines(paths.turnsPath),
    readJsonLines(paths.launchesPath),
  ]);
  const latestLaunch = launches.at(-1) || null;
  const summaryBytes = getSessionMemoryLimit(config, "runSummaryMaxBytes", 256);
  const recentTasks = turns
    .filter((turn) => turn.turn_type === "task" && turn.content)
    .slice(-5)
    .map((turn) => clipToBytes(turn.content, summaryBytes));
  const facts = {
    schema_version: "1.0",
    session_id: sessionId,
    event_counts: {
      turns: turns.length,
      launches: launches.length,
    },
    latest_task: recentTasks.at(-1) || "",
    latest_phase: latestLaunch?.phase || null,
    latest_exit_code: latestLaunch?.exit_code ?? null,
    latest_timed_out: Boolean(latestLaunch?.timed_out),
    latest_timeout_ms: latestLaunch?.timeout_ms ?? null,
    latest_signal: latestLaunch?.signal || null,
    latest_validation: latestLaunch?.validation || null,
    recent_tasks: recentTasks,
    source_paths: {
      turns: relative(root, paths.turnsPath),
      launches: relative(root, paths.launchesPath),
      context: relative(root, paths.contextPath),
    },
  };

  context.context_facts = facts;
  await writePrivateJson(paths.contextPath, context);
  await writePrivateJson(paths.contextFactsPath, facts);
  if (config?.session?.emitMarkdownArtifacts !== false) {
    await writePrivateText(paths.contextFactsMarkdownPath, renderContextFactsMarkdown(facts));
  }
  return {
    session_id: sessionId,
    facts_path: relative(root, paths.contextFactsPath),
    markdown_path:
      config?.session?.emitMarkdownArtifacts === false ? null : relative(root, paths.contextFactsMarkdownPath),
    facts,
  };
}

export async function compactSessionContext(root, sessionId, config = {}) {
  return withSessionArtifactLock(root, sessionId, "compact-session-context", (paths) =>
    compactSessionContextUnlocked(root, sessionId, config, paths),
  );
}

async function appendRunSummaryUnlocked(
  root,
  sessionId,
  entry,
  config,
  paths = getSessionArtifactPaths(root, sessionId),
) {
  if (!(await exists(paths.contextPath))) {
    return null;
  }
  let context;
  try {
    context = await readJson(paths.contextPath);
  } catch {
    return null;
  }
  const historyLimit = getSessionMemoryLimit(config, "runHistoryMax", 10);
  const summaryBytes = getSessionMemoryLimit(config, "runSummaryMaxBytes", 256);
  const previous = Array.isArray(context.run_history) ? context.run_history : [];
  const next = [...previous, clampRunHistoryEntry(entry, summaryBytes)].slice(-historyLimit);
  context.run_history = next;
  context.rolling_summary = clipToBytes(buildRollingSummary(next), Math.max(summaryBytes * 2, 512));
  await writePrivateJson(paths.contextPath, context);
  return { run_history: next, rolling_summary: context.rolling_summary };
}

export async function appendRunSummary(root, sessionId, entry, config) {
  return withSessionArtifactLock(root, sessionId, "append-run-summary", (paths) =>
    appendRunSummaryUnlocked(root, sessionId, entry, config, paths),
  );
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

export async function prepareSessionMemoryRun(root, sessionRecord, config) {
  const startedAt = new Date().toISOString();
  const paths = getSessionArtifactPaths(root, sessionRecord.sessionId);
  const lock = await acquireSessionArtifactLock(paths, "session-run");
  await ensurePrivateDir(paths.sessionDir);
  const emitMarkdown = config?.session?.emitMarkdownArtifacts !== false;

  try {
    await appendTurnsRecord(paths.turnsPath, {
      schema_version: "1.0",
      turn_type: "run_start",
      role: "system",
      session_id: sessionRecord.sessionId,
      provider: sessionRecord.provider,
      started_at: startedAt,
      capture_mode: sessionRecord.captureMode,
      command: redactSensitiveValue(Array.isArray(sessionRecord.command) ? sessionRecord.command : []),
      memory_backend: sessionRecord.memoryContext?.backend || "none",
      memory_source_session_id: sessionRecord.memoryContext?.sourceSessionId || null,
    });
    await appendTurnsRecord(paths.turnsPath, {
      schema_version: "1.0",
      turn_type: "task",
      role: "user",
      session_id: sessionRecord.sessionId,
      timestamp: startedAt,
      content: sessionRecord.task || "No task was provided; the provider was instructed to ask the user for one.",
    });

    if (emitMarkdown) {
      const memoryMarkdown = redactSensitiveText(sessionRecord.memoryContext?.markdown || buildNoMemoryMarkdown());
      await writePrivateText(paths.memoryContextPath, `${memoryMarkdown.trim()}\n`);

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
        `Bootstrap: .agentify/session/${sessionRecord.sessionId}/bootstrap.md`,
        `Memory context: ${relative(root, paths.memoryContextPath)}`,
        "",
        "> Session bootstrap reference",
        `Bootstrap context is persisted in \`.agentify/session/${sessionRecord.sessionId}/bootstrap.md\`.`,
        "",
        "> Automatic session memory",
        redactSensitiveText(
          sessionRecord.memoryContext?.excerpt ||
            "No prior session transcript was available for automatic recall before this run.",
        ),
        "",
        "> Current task",
        redactSensitiveText(
          sessionRecord.task || "No task was provided; the provider was instructed to ask the user for one.",
        ),
        "",
      );

      await appendPrivateText(paths.transcriptPath, `${transcriptLines.filter(Boolean).join("\n")}\n`);
    }
    return { startedAt, paths, emitMarkdown, sessionArtifactLock: lock };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

export async function finalizeSessionMemoryRun(root, sessionRecord, prepared, outcome, config) {
  try {
    const captureMaxBytes = getSessionMemoryLimit(config, "captureMaxKb", 48) * 1024;
    const summaryMaxBytes = getSessionMemoryLimit(config, "runSummaryMaxBytes", 256);
    const emitMarkdown =
      prepared?.emitMarkdown !== undefined ? prepared.emitMarkdown : config?.session?.emitMarkdownArtifacts !== false;
    const providerOutput = outcome?.interactiveTranscript
      ? String(outcome.interactiveTranscript).trim()
      : [outcome?.stdout, outcome?.stderr].filter(Boolean).join("\n").trim();
    const assistantText = providerOutput
      ? clipToBytes(redactSensitiveText(providerOutput), captureMaxBytes)
      : "Agentify launched the provider in inherited interactive mode, so the full assistant transcript was not captured for this run. The prompt, bootstrap, memory context, and launch record were still persisted automatically.";
    const validationSummary = outcome?.validation
      ? outcome.validation.passed
        ? "passed"
        : "failed"
      : outcome?.skippedRefresh
        ? "skipped"
        : "not-run";
    const phase = outcome?.phase || "complete";
    const endedAt = new Date().toISOString();
    const timeout = getOutcomeTimeout(outcome);
    const timeoutFields = buildTimeoutRecordFields(outcome);
    const timeoutStatus = timeout.timedOut
      ? `yes after ${timeout.timeoutMs ?? "unknown"}ms${timeout.signal ? ` (signal: ${timeout.signal})` : ""}`
      : "no";

    await appendTurnsRecord(prepared.paths.turnsPath, {
      schema_version: "1.0",
      turn_type: "assistant_response",
      role: "assistant",
      session_id: sessionRecord.sessionId,
      timestamp: endedAt,
      content: assistantText,
    });
    await appendTurnsRecord(prepared.paths.turnsPath, {
      schema_version: "1.0",
      turn_type: "run_end",
      role: "system",
      session_id: sessionRecord.sessionId,
      ended_at: endedAt,
      phase,
      exit_code: outcome?.exitCode ?? 1,
      ...timeoutFields,
      validation: validationSummary,
      capture_mode: sessionRecord.captureMode,
    });

    if (emitMarkdown) {
      const transcriptTail = [
        "> Provider response",
        assistantText,
        "",
        "> Run status",
        `Command phase: ${phase}`,
        `Exit code: ${outcome?.exitCode ?? 1}`,
        `Timeout: ${timeoutStatus}`,
        `Validation: ${validationSummary}`,
        `Capture mode used: ${sessionRecord.captureMode}`,
        outcome?.rawInteractiveLogPath ? `Raw interactive log: ${relative(root, outcome.rawInteractiveLogPath)}` : null,
        outcome?.interactiveCaptureError ? `Interactive capture warning: ${outcome.interactiveCaptureError}` : null,
        `Ended: ${endedAt}`,
        "",
      ]
        .filter(Boolean)
        .join("\n");
      await appendPrivateText(prepared.paths.transcriptPath, transcriptTail);
    }

    const managedContext = await buildEstimatedManagedContext(root, sessionRecord, prepared.paths, config);

    const launchRecord = {
      schema_version: "1.0",
      session_id: sessionRecord.sessionId,
      provider: sessionRecord.provider,
      started_at: prepared.startedAt,
      ended_at: endedAt,
      capture_mode: sessionRecord.captureMode,
      command: redactSensitiveValue(Array.isArray(sessionRecord.command) ? sessionRecord.command : []),
      task: redactSensitiveText(sessionRecord.task),
      prompt: redactSensitiveText(sessionRecord.prompt),
      transcript_path: relative(root, prepared.paths.transcriptPath),
      memory_context_path: relative(root, prepared.paths.memoryContextPath),
      turns_path: relative(root, prepared.paths.turnsPath),
      memory_backend: sessionRecord.memoryContext?.backend || "none",
      raw_interactive_log_path: outcome?.rawInteractiveLogPath ? relative(root, outcome.rawInteractiveLogPath) : null,
      memory_source_session_id: sessionRecord.memoryContext?.sourceSessionId || null,
      memory_source_transcript: sessionRecord.memoryContext?.transcriptRelativePath || null,
      phase,
      exit_code: outcome?.exitCode ?? 1,
      ...timeoutFields,
      validation: validationSummary,
      stdout: clipToBytes(redactSensitiveText(outcome?.stdout || ""), captureMaxBytes),
      stderr: clipToBytes(redactSensitiveText(outcome?.stderr || ""), captureMaxBytes),
      interactive_capture_error: outcome?.interactiveCaptureError || null,
      managed_context: managedContext,
    };
    await appendPrivateText(prepared.paths.launchesPath, `${JSON.stringify(launchRecord)}\n`);

    await appendRunSummaryUnlocked(
      root,
      sessionRecord.sessionId,
      {
        started_at: prepared.startedAt,
        ended_at: endedAt,
        task: sessionRecord.task || "",
        assistant_summary: clipToBytes(assistantText, summaryMaxBytes),
        exit_code: outcome?.exitCode ?? null,
        ...timeoutFields,
        validation: validationSummary,
        phase,
        memory_backend: sessionRecord.memoryContext?.backend || "none",
        managed_context: managedContext,
      },
      config,
      prepared.paths,
    );
    await compactSessionContextUnlocked(root, sessionRecord.sessionId, config, prepared.paths);
  } finally {
    await prepared?.sessionArtifactLock?.release?.();
  }
}
