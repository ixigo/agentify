import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir, exists, readJson, writePrivateJson, writePrivateText } from "./fs.js";
import { getHeadCommit } from "./git.js";
import { closeIndexDatabase, openIndexDatabase } from "./db/connection.js";
import { loadModules } from "./db/structural-store.js";
import { resolveAgentifyPaths, resolveLocalAgentifyPaths } from "./project-store.js";
import { getSessionArtifactPaths } from "./session-memory.js";

function generateSessionId() {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rand = crypto.randomBytes(3).toString("hex");
  return `sess_${ts}_${rand}`;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SESSION_ID_MAX_LENGTH = 128;

export function validateSessionId(sessionId, label = "session id") {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(`Invalid ${label}: must be a non-empty string`);
  }
  if (sessionId.length > SESSION_ID_MAX_LENGTH) {
    throw new Error(`Invalid ${label}: exceeds maximum length of ${SESSION_ID_MAX_LENGTH} characters`);
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid ${label}: must contain only letters, digits, "_" or "-" and start with a letter or digit`);
  }
  return sessionId;
}

function resolveSessionDirSafely(root, sessionId, label = "session id") {
  validateSessionId(sessionId, label);
  const sessionsRoot = resolveLocalAgentifyPaths(root).sessionRoot;
  const sessionDir = path.resolve(sessionsRoot, sessionId);
  const expectedPrefix = sessionsRoot + path.sep;
  if (!sessionDir.startsWith(expectedPrefix) || path.dirname(sessionDir) !== sessionsRoot) {
    throw new Error(`Invalid ${label}: resolved path escapes \`.agentify/session/\``);
  }
  return sessionDir;
}

function bytes(value) {
  return Buffer.byteLength(value, "utf8");
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

function getSessionLimitKb(config, key, fallbackKb) {
  const value = Number(config?.session?.[key]);
  return Number.isFinite(value) && value > 0 ? value : fallbackKb;
}

function normalizeChecklist(checklist, maxItems, maxTextBytes) {
  return checklist
    .slice(0, maxItems)
    .map((item) => ({
      done: Boolean(item?.done),
      text: clipToBytes(item?.text || "Untitled checklist item", maxTextBytes),
    }))
    .filter((item) => item.text);
}

function summarizeModules(moduleIds, maxItems) {
  if (moduleIds.length === 0) {
    return "none";
  }

  const visible = moduleIds.slice(0, maxItems);
  const remaining = moduleIds.length - visible.length;
  if (visible.length === 0) {
    return `${moduleIds.length} indexed modules (see .agentify/index.db)`;
  }

  return remaining > 0
    ? `${visible.join(", ")}, +${remaining} more (host shell index: .agentify/index.db)`
    : visible.join(", ");
}

function renderChecklistMarkdown(sessionId, checklist, totalItems) {
  if (checklist.length === 0) {
    return totalItems > 0
      ? `- ${totalItems} checklist item(s) omitted. See \`.agentify/session/${sessionId}/checklist.json\`.`
      : "- No checklist items.";
  }

  const lines = checklist.map((item) => `- [${item.done ? "x" : " "}] ${item.text}`);
  const remaining = totalItems - checklist.length;
  if (remaining > 0) {
    lines.push(`- ... ${remaining} more item(s) in \`.agentify/session/${sessionId}/checklist.json\`.`);
  }
  return lines.join("\n");
}

function clampRunHistory(history, limit, perEntryBytes) {
  if (!Array.isArray(history) || history.length === 0 || limit <= 0) {
    return [];
  }
  const trimmed = history.slice(-limit);
  return trimmed.map((entry) => ({
    ...entry,
    assistant_summary: clipToBytes(entry?.assistant_summary || "", perEntryBytes),
    task: clipToBytes(entry?.task || "", Math.max(80, Math.floor(perEntryBytes / 2))),
  }));
}

function fitContext(manifest, index, checklist, options, config) {
  const moduleIds = index?.modules?.map((m) => m.id) || [];
  const staleModules = [];
  const maxBytes = getSessionLimitKb(config, "contextMaxKb", 16) * 1024;
  const memoryArtifacts = getSessionArtifactPaths(options.root || "", manifest.session_id);
  const transcriptRef = options.root
    ? `.agentify/session/${manifest.session_id}/transcript.md`
    : memoryArtifacts.transcriptPath;
  const memoryContextRef = options.root
    ? `.agentify/session/${manifest.session_id}/memory-context.md`
    : memoryArtifacts.memoryContextPath;
  const handoffJsonRef = options.root
    ? `.agentify/session/${manifest.session_id}/handoff.json`
    : memoryArtifacts.handoffJsonPath;
  const handoffMarkdownRef = options.root
    ? `.agentify/session/${manifest.session_id}/handoff.md`
    : memoryArtifacts.handoffMarkdownPath;
  const launchesRef = options.root
    ? `.agentify/session/${manifest.session_id}/launches.jsonl`
    : memoryArtifacts.launchesPath;
  const turnsRef = options.root ? `.agentify/session/${manifest.session_id}/turns.jsonl` : memoryArtifacts.turnsPath;
  const fetchOutputsRef = options.root
    ? `.agentify/session/${manifest.session_id}/context-fetches.jsonl`
    : memoryArtifacts.fetchOutputsPath;
  const contextFactsRef = options.root
    ? `.agentify/session/${manifest.session_id}/context-facts.json`
    : memoryArtifacts.contextFactsPath;
  const contextFactsMarkdownRef = options.root
    ? `.agentify/session/${manifest.session_id}/context-facts.md`
    : memoryArtifacts.contextFactsMarkdownPath;
  const attempts = [
    {
      moduleLimit: moduleIds.length,
      checklistLimit: checklist.length,
      checklistTextBytes: 240,
      parentSummaryBytes: 2048,
      runHistoryLimit: 10,
      runSummaryBytes: 256,
      rollingSummaryBytes: 1024,
    },
    {
      moduleLimit: 64,
      checklistLimit: 20,
      checklistTextBytes: 180,
      parentSummaryBytes: 1024,
      runHistoryLimit: 6,
      runSummaryBytes: 180,
      rollingSummaryBytes: 512,
    },
    {
      moduleLimit: 24,
      checklistLimit: 10,
      checklistTextBytes: 140,
      parentSummaryBytes: 512,
      runHistoryLimit: 4,
      runSummaryBytes: 140,
      rollingSummaryBytes: 256,
    },
    {
      moduleLimit: 8,
      checklistLimit: 5,
      checklistTextBytes: 100,
      parentSummaryBytes: 256,
      runHistoryLimit: 2,
      runSummaryBytes: 96,
      rollingSummaryBytes: 128,
    },
    {
      moduleLimit: 0,
      checklistLimit: 0,
      checklistTextBytes: 0,
      parentSummaryBytes: 64,
      runHistoryLimit: 0,
      runSummaryBytes: 0,
      rollingSummaryBytes: 0,
      minimalRefs: true,
    },
  ];

  let selected = null;
  for (const attempt of attempts) {
    const previewChecklist = normalizeChecklist(checklist, attempt.checklistLimit, attempt.checklistTextBytes);
    const runHistory = clampRunHistory(options.runHistory || [], attempt.runHistoryLimit, attempt.runSummaryBytes);
    const includeHandoffRefs = attempt !== attempts[attempts.length - 1];
    const cacheRefs = attempt.minimalRefs
      ? {
          repo_index: ".agentify/index.db",
          repo_docs: "AGENTIFY.md and module-root AGENTIFY.md files",
          checklist: `.agentify/session/${manifest.session_id}/checklist.json`,
        }
      : {
          repo_index: ".agentify/index.db",
          repo_docs: "AGENTIFY.md and module-root AGENTIFY.md files",
          checklist: `.agentify/session/${manifest.session_id}/checklist.json`,
          transcript: transcriptRef,
          memory_context: memoryContextRef,
          ...(includeHandoffRefs
            ? {
                handoff_json: handoffJsonRef,
                handoff_markdown: handoffMarkdownRef,
              }
            : {}),
          launches: launchesRef,
          turns: turnsRef,
          context_fetches: fetchOutputsRef,
          context_fetches: fetchOutputsRef,
          context_facts: contextFactsRef,
          context_facts_markdown: contextFactsMarkdownRef,
        };
    const candidate = {
      schema_version: "1.0",
      session_id: manifest.session_id,
      index_snapshot: {
        head_commit: manifest.head_commit_at_creation,
        module_ids: moduleIds.slice(0, attempt.moduleLimit),
        module_count: moduleIds.length,
        truncated_module_ids: Math.max(0, moduleIds.length - Math.min(moduleIds.length, attempt.moduleLimit)),
        stale_modules: staleModules,
      },
      checklist: previewChecklist,
      checklist_summary: {
        total_items: checklist.length,
        displayed_items: previewChecklist.length,
        remaining_items: Math.max(0, checklist.length - previewChecklist.length),
      },
      cache_refs: cacheRefs,
      parent_summary: clipToBytes(options.parentSummary || "", attempt.parentSummaryBytes),
      run_history: runHistory,
      rolling_summary: clipToBytes(options.rollingSummary || "", attempt.rollingSummaryBytes),
    };

    selected = candidate;
    if (bytes(JSON.stringify(candidate, null, 2)) <= maxBytes) {
      return { value: candidate, truncated: attempt !== attempts[0] };
    }
  }

  return { value: selected, truncated: true };
}

export function synthesizeBootstrapFromContext(manifest, context) {
  const moduleIds = context?.index_snapshot?.module_ids || [];
  const moduleCount = Number(context?.index_snapshot?.module_count || moduleIds.length);
  const checklist = Array.isArray(context?.checklist) ? context.checklist : [];
  const checklistSummary = context?.checklist_summary || {
    total_items: checklist.length,
    displayed_items: checklist.length,
    remaining_items: 0,
  };
  const runs = Array.isArray(context?.run_history) ? context.run_history : [];
  const rolling = String(context?.rolling_summary || "").trim();

  const runsBlock =
    runs.length === 0
      ? "- No prior runs recorded."
      : runs
          .slice(-3)
          .map((run) => {
            const task = run?.task ? `task: ${run.task}` : "task: (unrecorded)";
            const validation = run?.validation ? ` validation: ${run.validation}` : "";
            const exit = Number.isFinite(run?.exit_code) ? ` exit: ${run.exit_code}` : "";
            return `- ${run?.ended_at || run?.started_at || "run"} — ${task}${exit}${validation}`;
          })
          .join("\n");

  return `# Session Context

## Session
- ID: ${manifest.session_id}
- Parent: ${manifest.parent_id || "none"}
- Provider: ${manifest.provider || manifest.tool || "local"}
- Created: ${manifest.created_at}

## Repository State
- HEAD: ${manifest.head_commit_at_creation}
- Module count: ${moduleCount}
- Module preview: ${summarizeModules(moduleIds, Math.min(moduleIds.length, 12))}
- Full routing: host shell -> .agentify/index.db

## Checklist Status
${renderChecklistMarkdown(manifest.session_id, checklist, checklistSummary.total_items ?? checklist.length)}

## Recent Runs
${runsBlock}

## Rolling Summary
${rolling || "- No rolling summary recorded yet."}
`;
}

function fitBootstrap(manifest, index, checklist, options, config) {
  const moduleIds = index?.modules?.map((m) => m.id) || [];
  const maxBytes = getSessionLimitKb(config, "bootstrapMaxKb", 4) * 1024;
  const baseStartHere =
    options.startHere ||
    [
      "- Read root `AGENTIFY.md` for the current repo snapshot and module guidance.",
      "- Use `docs/repo-map.md` and module-root `AGENTIFY.md` files for deterministic structure before reaching for provider tools.",
      "- Treat `.agentify/index.db` as a host-shell artifact. Inside provider sessions, prefer the generated markdown docs before reaching for nested Agentify or SQLite commands.",
    ].join("\n");
  const attempts = [
    { moduleLimit: moduleIds.length, checklistLimit: checklist.length, checklistTextBytes: 240, startHereBytes: 1200 },
    { moduleLimit: 32, checklistLimit: 16, checklistTextBytes: 180, startHereBytes: 720 },
    { moduleLimit: 12, checklistLimit: 8, checklistTextBytes: 120, startHereBytes: 360 },
    { moduleLimit: 4, checklistLimit: 3, checklistTextBytes: 90, startHereBytes: 180 },
    { moduleLimit: 0, checklistLimit: 0, checklistTextBytes: 0, startHereBytes: 96 },
  ];

  let selected = "";
  for (const attempt of attempts) {
    const previewChecklist = normalizeChecklist(checklist, attempt.checklistLimit, attempt.checklistTextBytes);
    const candidate = `# Session Context

## Session
- ID: ${manifest.session_id}
- Parent: ${manifest.parent_id || "none"}
- Provider: ${manifest.provider || manifest.tool || "local"}
- Created: ${manifest.created_at}

## Repository State
- HEAD: ${manifest.head_commit_at_creation}
- Module count: ${moduleIds.length}
- Module preview: ${summarizeModules(moduleIds, attempt.moduleLimit)}
- Full routing: host shell -> .agentify/index.db

## Checklist Status
${renderChecklistMarkdown(manifest.session_id, previewChecklist, checklist.length)}

## Start Here
${clipToBytes(baseStartHere, attempt.startHereBytes) || "- Inspect the session checklist and generated markdown docs for full context."}
`;

    selected = candidate;
    if (bytes(candidate) <= maxBytes) {
      return { value: candidate, truncated: attempt !== attempts[0] };
    }
  }

  return { value: clipToBytes(selected, maxBytes), truncated: true };
}

export async function forkSession(root, config, options = {}) {
  const sessionId = generateSessionId();
  const sessionDir = path.join(resolveLocalAgentifyPaths(root).sessionRoot, sessionId);
  await ensurePrivateDir(sessionDir);

  const headCommit = await getHeadCommit(root);
  let index = null;
  const agentifyPaths = config._agentifyPaths || (await resolveAgentifyPaths(root, config));
  if (await exists(agentifyPaths.indexDb)) {
    const db = openIndexDatabase(agentifyPaths, { readOnly: true });
    try {
      index = {
        modules: loadModules(db).map((moduleInfo) => ({ id: moduleInfo.id })),
      };
    } finally {
      closeIndexDatabase(db);
    }
  }

  const emitMarkdown = config?.session?.emitMarkdownArtifacts !== false;

  const manifest = {
    schema_version: "1.0",
    session_id: sessionId,
    parent_id: options.from || null,
    forked_from: options.from || null,
    created_at: new Date().toISOString(),
    provider: options.provider || config.provider || "local",
    name: options.name || null,
    status: "active",
    head_commit_at_creation: headCommit,
    index_snapshot: ".agentify/index.db",
    cache_refs: [
      `.agentify/session/${sessionId}/context.json`,
      `.agentify/session/${sessionId}/checklist.json`,
      `.agentify/session/${sessionId}/launches.jsonl`,
      `.agentify/session/${sessionId}/turns.jsonl`,
      `.agentify/session/${sessionId}/context-events.jsonl`,
      `.agentify/session/${sessionId}/handoff.json`,
      `.agentify/session/${sessionId}/handoff.md`,
      `.agentify/session/${sessionId}/bootstrap.md`,
      `.agentify/session/${sessionId}/transcript.md`,
      `.agentify/session/${sessionId}/memory-context.md`,
      `.agentify/session/${sessionId}/context-facts.json`,
      `.agentify/session/${sessionId}/context-facts.md`,
      `.agentify/session/${sessionId}/context-fetches.jsonl`,
    ],
    metadata: {
      modules_indexed: index?.modules?.length || 0,
      total_tokens_used: 0,
      memory_adapter: "mempalace-compatible-session-v1",
      emit_markdown_artifacts: emitMarkdown,
      runtime_artifacts: [
        "session-manifest.json",
        "context.json",
        "checklist.json",
        "launches.jsonl",
        "turns.jsonl",
        "context-events.jsonl",
        "handoff.json",
        "context-facts.json",
      ],
      optional_markdown_artifacts: [
        "bootstrap.md",
        "transcript.md",
        "memory-context.md",
        "handoff.md",
        "context-facts.md",
      ],
    },
  };

  let parentChecklist = [];
  let parentRunHistory = [];
  let parentRollingSummary = "";
  if (options.from) {
    const parentDir = resolveSessionDirSafely(root, options.from, "parent session id");
    const parentManifestPath = path.join(parentDir, "session-manifest.json");
    if (!(await exists(parentManifestPath))) {
      throw new Error(`Parent session ${options.from} not found`);
    }
    const parentManifest = await readJson(parentManifestPath);
    if (parentManifest?.session_id !== options.from) {
      throw new Error(
        `Parent session manifest session_id "${parentManifest?.session_id}" does not match requested id "${options.from}"`,
      );
    }
    const checklistPath = path.join(parentDir, "checklist.json");
    if (await exists(checklistPath)) {
      parentChecklist = await readJson(checklistPath);
    }
    const parentContextPath = path.join(parentDir, "context.json");
    if (await exists(parentContextPath)) {
      try {
        const parentContext = await readJson(parentContextPath);
        parentRunHistory = Array.isArray(parentContext?.run_history) ? parentContext.run_history : [];
        parentRollingSummary = String(parentContext?.rolling_summary || "");
      } catch {
        parentRunHistory = [];
        parentRollingSummary = "";
      }
    }
  }

  const contextResult = fitContext(
    manifest,
    index,
    parentChecklist,
    {
      ...options,
      root,
      runHistory: options.runHistory || parentRunHistory,
      rollingSummary: options.rollingSummary || parentRollingSummary,
    },
    config,
  );
  const bootstrapResult = fitBootstrap(manifest, index, parentChecklist, options, config);
  const context = contextResult.value;
  const bootstrap = bootstrapResult.value;

  manifest.metadata.session_context_bytes = bytes(JSON.stringify(context, null, 2));
  manifest.metadata.session_bootstrap_bytes = bytes(bootstrap);
  manifest.metadata.context_truncated = contextResult.truncated;
  manifest.metadata.bootstrap_truncated = bootstrapResult.truncated;

  await writePrivateJson(path.join(sessionDir, "session-manifest.json"), manifest);
  await writePrivateJson(path.join(sessionDir, "checklist.json"), parentChecklist);
  await writePrivateJson(path.join(sessionDir, "context.json"), context);
  if (emitMarkdown) {
    await writePrivateText(path.join(sessionDir, "bootstrap.md"), bootstrap);
  }

  return { sessionId, sessionDir, manifest, context, bootstrap };
}

export async function listSessions(root) {
  const sessionsDir = resolveLocalAgentifyPaths(root).sessionRoot;
  if (!(await exists(sessionsDir))) return [];

  const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  const sessions = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(sessionsDir, entry.name, "session-manifest.json");
    if (await exists(manifestPath)) {
      sessions.push(await readJson(manifestPath));
    }
  }

  return sessions.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function resumeSession(root, sessionId) {
  const sessionDir = resolveSessionDirSafely(root, sessionId);
  const manifestPath = path.join(sessionDir, "session-manifest.json");

  if (!(await exists(manifestPath))) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const manifest = await readJson(manifestPath);
  if (manifest?.session_id !== sessionId) {
    throw new Error(`Session manifest session_id "${manifest?.session_id}" does not match requested id "${sessionId}"`);
  }
  const context = await readJson(path.join(sessionDir, "context.json"));
  const bootstrapPath = path.join(sessionDir, "bootstrap.md");
  const bootstrap = (await exists(bootstrapPath))
    ? await fs.readFile(bootstrapPath, "utf8")
    : synthesizeBootstrapFromContext(manifest, context);

  return { manifest, context, bootstrap };
}

export function resolveSessionProvider(manifest, fallback = "local") {
  return manifest?.provider || manifest?.tool || fallback;
}

export async function maybePrepareChildSession(root, config, parentSessionId, options = {}) {
  const thresholdKb = Number(config?.session?.prepareChildAboveKb ?? config?.session?.childContextThresholdKb ?? 0);
  if (!Number.isFinite(thresholdKb) || thresholdKb <= 0) {
    return null;
  }

  const parentDir = resolveSessionDirSafely(root, parentSessionId, "parent session id");
  const contextPath = path.join(parentDir, "context.json");
  if (!(await exists(contextPath))) {
    return null;
  }

  const contextText = await fs.readFile(contextPath, "utf8");
  const contextBytes = bytes(contextText);
  if (contextBytes <= thresholdKb * 1024) {
    return null;
  }

  const child = await forkSession(root, config, {
    from: parentSessionId,
    provider: options.provider || null,
    name: options.name ? `${options.name} child` : `child of ${parentSessionId}`,
  });
  const parentManifestPath = path.join(parentDir, "session-manifest.json");
  const parentManifest = await readJson(parentManifestPath);
  parentManifest.prepared_child_session = {
    session_id: child.sessionId,
    reason: "context-threshold",
    context_bytes: contextBytes,
    threshold_bytes: thresholdKb * 1024,
    resume_command: `agentify sess resume --session ${child.sessionId}`,
  };
  await writePrivateJson(parentManifestPath, parentManifest);

  return {
    parent_session_id: parentSessionId,
    child_session_id: child.sessionId,
    child_session_dir: child.sessionDir,
    context_bytes: contextBytes,
    threshold_bytes: thresholdKb * 1024,
    resume_command: `agentify sess resume --session ${child.sessionId}`,
  };
}
