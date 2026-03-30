import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, exists, readJson, writeJson, writeText } from "./fs.js";
import { getHeadCommit } from "./git.js";

function generateSessionId() {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rand = crypto.randomBytes(3).toString("hex");
  return `sess_${ts}_${rand}`;
}

function buildContext(manifest, index, checklist, options) {
  const staleModules = [];
  return {
    schema_version: "1.0",
    session_id: manifest.session_id,
    index_snapshot: {
      head_commit: manifest.head_commit_at_creation,
      module_ids: index?.modules?.map((m) => m.id) || [],
      stale_modules: staleModules,
    },
    checklist,
    cache_refs: {},
    parent_summary: options.parentSummary || "",
  };
}

function buildBootstrap(manifest, index, checklist, options) {
  const checklistMd =
    checklist.length > 0
      ? checklist.map((item) => `- [${item.done ? "x" : " "}] ${item.text}`).join("\n")
      : "- No checklist items.";

  const modules =
    index?.modules?.map((m) => m.id).join(", ") || "none";

  return `# Session Context

## Session
- ID: ${manifest.session_id}
- Parent: ${manifest.parent_id || "none"}
- Provider: ${manifest.provider || manifest.tool || "local"}
- Created: ${manifest.created_at}

## Repository State
- HEAD: ${manifest.head_commit_at_creation}
- Modules: ${modules}

## Checklist Status
${checklistMd}

## Start Here
${options.startHere || "- Inspect .agents/index.json for module routing."}
`;
}

export async function forkSession(root, config, options = {}) {
  const sessionId = generateSessionId();
  const sessionDir = path.join(root, ".agents", "session", sessionId);
  await ensureDir(sessionDir);

  const headCommit = await getHeadCommit(root);
  const indexPath = path.join(root, ".agents", "index.json");
  const index = (await exists(indexPath)) ? await readJson(indexPath) : null;

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
    index_snapshot: ".agents/index.json",
    cache_refs: [],
    metadata: {
      modules_indexed: index?.modules?.length || 0,
      total_tokens_used: 0,
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

  const context = buildContext(manifest, index, parentChecklist, options);
  const bootstrap = buildBootstrap(manifest, index, parentChecklist, options);

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
