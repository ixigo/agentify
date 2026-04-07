import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, exists, readJson, writeJson, writeText } from "./fs.js";
import { getHeadCommit } from "./git.js";
import { closeIndexDatabase, loadModules, openIndexDatabase } from "./db.js";
import { getSessionArtifactPaths } from "./session-memory.js";

function generateSessionId() {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rand = crypto.randomBytes(3).toString("hex");
  return `sess_${ts}_${rand}`;
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
      text: clipToBytes(item?.text || "Untitled checklist item", maxTextBytes)
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
    return `${moduleIds.length} indexed modules (see .agents/index.db)`;
  }

  return remaining > 0
    ? `${visible.join(", ")}, +${remaining} more (host shell index: .agents/index.db)`
    : visible.join(", ");
}

function renderChecklistMarkdown(sessionId, checklist, totalItems) {
  if (checklist.length === 0) {
    return totalItems > 0
      ? `- ${totalItems} checklist item(s) omitted. See \`.agents/session/${sessionId}/checklist.json\`.`
      : "- No checklist items.";
  }

  const lines = checklist.map((item) => `- [${item.done ? "x" : " "}] ${item.text}`);
  const remaining = totalItems - checklist.length;
  if (remaining > 0) {
    lines.push(`- ... ${remaining} more item(s) in \`.agents/session/${sessionId}/checklist.json\`.`);
  }
  return lines.join("\n");
}

function fitContext(manifest, index, checklist, options, config) {
  const moduleIds = index?.modules?.map((m) => m.id) || [];
  const staleModules = [];
  const maxBytes = getSessionLimitKb(config, "contextMaxKb", 16) * 1024;
  const memoryArtifacts = getSessionArtifactPaths(options.root || "", manifest.session_id);
  const transcriptRef = options.root ? `.agents/session/${manifest.session_id}/transcript.md` : memoryArtifacts.transcriptPath;
  const memoryContextRef = options.root ? `.agents/session/${manifest.session_id}/memory-context.md` : memoryArtifacts.memoryContextPath;
  const launchesRef = options.root ? `.agents/session/${manifest.session_id}/launches.jsonl` : memoryArtifacts.launchesPath;
  const attempts = [
    { moduleLimit: moduleIds.length, checklistLimit: checklist.length, checklistTextBytes: 240, parentSummaryBytes: 2048 },
    { moduleLimit: 64, checklistLimit: 20, checklistTextBytes: 180, parentSummaryBytes: 1024 },
    { moduleLimit: 24, checklistLimit: 10, checklistTextBytes: 140, parentSummaryBytes: 512 },
    { moduleLimit: 8, checklistLimit: 5, checklistTextBytes: 100, parentSummaryBytes: 256 },
    { moduleLimit: 0, checklistLimit: 0, checklistTextBytes: 0, parentSummaryBytes: 120 },
  ];

  let selected = null;
  for (const attempt of attempts) {
    const previewChecklist = normalizeChecklist(checklist, attempt.checklistLimit, attempt.checklistTextBytes);
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
      cache_refs: {
        repo_index: ".agents/index.db",
        repo_docs: "docs/modules/",
        checklist: `.agents/session/${manifest.session_id}/checklist.json`,
        transcript: transcriptRef,
        memory_context: memoryContextRef,
        launches: launchesRef,
      },
      parent_summary: clipToBytes(options.parentSummary || "", attempt.parentSummaryBytes),
    };

    selected = candidate;
    if (bytes(JSON.stringify(candidate, null, 2)) <= maxBytes) {
      return { value: candidate, truncated: attempt !== attempts[0] };
    }
  }

  return { value: selected, truncated: true };
}

function fitBootstrap(manifest, index, checklist, options, config) {
  const moduleIds = index?.modules?.map((m) => m.id) || [];
  const maxBytes = getSessionLimitKb(config, "bootstrapMaxKb", 4) * 1024;
  const baseStartHere = options.startHere || [
    "- Read `AGENTIFY.md` for the current repo snapshot and module guidance.",
    "- Use `docs/repo-map.md` and `docs/modules/` for deterministic structure before reaching for provider tools.",
    "- Treat `.agents/index.db` as a host-shell artifact. Inside provider sessions, prefer the generated markdown docs before reaching for nested Agentify or SQLite commands.",
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
- Full routing: host shell -> .agents/index.db

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
  const sessionDir = path.join(root, ".agents", "session", sessionId);
  await ensureDir(sessionDir);

  const headCommit = await getHeadCommit(root);
  let index = null;
  if (await exists(path.join(root, ".agents", "index.db"))) {
    const db = openIndexDatabase(root, { readOnly: true });
    try {
      index = {
        modules: loadModules(db).map((moduleInfo) => ({ id: moduleInfo.id })),
      };
    } finally {
      closeIndexDatabase(db);
    }
  }

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
    index_snapshot: ".agents/index.db",
    cache_refs: [
      `.agents/session/${sessionId}/bootstrap.md`,
      `.agents/session/${sessionId}/context.json`,
      `.agents/session/${sessionId}/checklist.json`,
      `.agents/session/${sessionId}/transcript.md`,
      `.agents/session/${sessionId}/memory-context.md`,
      `.agents/session/${sessionId}/launches.jsonl`,
    ],
    metadata: {
      modules_indexed: index?.modules?.length || 0,
      total_tokens_used: 0,
      memory_adapter: "mempalace-compatible-session-v1",
    },
  };

  let parentChecklist = [];
  if (options.from) {
    const parentDir = path.join(root, ".agents", "session", options.from);
    const checklistPath = path.join(parentDir, "checklist.json");
    if (await exists(checklistPath)) {
      parentChecklist = await readJson(checklistPath);
    }
  }

  const contextResult = fitContext(manifest, index, parentChecklist, { ...options, root }, config);
  const bootstrapResult = fitBootstrap(manifest, index, parentChecklist, options, config);
  const context = contextResult.value;
  const bootstrap = bootstrapResult.value;

  manifest.metadata.session_context_bytes = bytes(JSON.stringify(context, null, 2));
  manifest.metadata.session_bootstrap_bytes = bytes(bootstrap);
  manifest.metadata.context_truncated = contextResult.truncated;
  manifest.metadata.bootstrap_truncated = bootstrapResult.truncated;

  await writeJson(path.join(sessionDir, "session-manifest.json"), manifest);
  await writeJson(path.join(sessionDir, "checklist.json"), parentChecklist);
  await writeJson(path.join(sessionDir, "context.json"), context);
  await writeText(path.join(sessionDir, "bootstrap.md"), bootstrap);

  return { sessionId, sessionDir, manifest, context, bootstrap };
}

export async function listSessions(root) {
  const sessionsDir = path.join(root, ".agents", "session");
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
  const sessionDir = path.join(root, ".agents", "session", sessionId);
  const manifestPath = path.join(sessionDir, "session-manifest.json");

  if (!(await exists(manifestPath))) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const manifest = await readJson(manifestPath);
  const context = await readJson(path.join(sessionDir, "context.json"));
  const bootstrap = await fs.readFile(path.join(sessionDir, "bootstrap.md"), "utf8");

  return { manifest, context, bootstrap };
}

export function resolveSessionProvider(manifest, fallback = "local") {
  return manifest?.provider || manifest?.tool || fallback;
}
