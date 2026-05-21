import fs from "node:fs/promises";
import path from "node:path";

import { appendPrivateText, ensureDir, exists } from "./fs.js";
import { resolveLocalAgentifyPaths } from "./project-store.js";
import { checkSchema, SCHEMA_VERSIONS } from "./schema.js";

const CONTEXT_RUNTIME_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

function assertRuntimeId(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 160 || !CONTEXT_RUNTIME_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function normalizeTextField(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Context event ${label} is required`);
  }
  return value;
}

function normalizeConfidence(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0 || numberValue > 1) {
    throw new Error("Context event confidence must be a number between 0 and 1");
  }
  return numberValue;
}

export function getContextEventLogPath(root, options = {}) {
  const agentifyPaths = resolveLocalAgentifyPaths(root);
  if (options.sessionId) {
    const sessionId = assertRuntimeId(options.sessionId, "session id");
    return path.join(agentifyPaths.sessionRoot, sessionId, "context-events.jsonl");
  }

  const runId = assertRuntimeId(options.runId, "run id");
  return path.join(agentifyPaths.workRoot, "context-events", `${runId}.jsonl`);
}

export function createContextEventRecord(event, options = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("Context event must be an object");
  }

  return {
    schema_version: SCHEMA_VERSIONS.CONTEXT_EVENT,
    run_id: assertRuntimeId(normalizeTextField(event.run_id ?? event.runId, "run id"), "run id"),
    path: normalizeTextField(event.path, "path"),
    event_type: normalizeTextField(event.event_type ?? event.eventType, "event type"),
    source: normalizeTextField(event.source, "source"),
    hash: normalizeTextField(event.hash, "hash"),
    summary: typeof event.summary === "string" ? event.summary : "",
    confidence: normalizeConfidence(event.confidence),
    created_at: options.now || event.created_at || event.createdAt || new Date().toISOString(),
  };
}

export function checkContextEventSchema(record) {
  return checkSchema(record, SCHEMA_VERSIONS.CONTEXT_EVENT);
}

export async function appendContextEvent(root, event, options = {}) {
  const record = createContextEventRecord(event, options);
  const targetPath = getContextEventLogPath(root, {
    sessionId: options.sessionId,
    runId: options.runId || record.run_id,
  });
  if (options.sessionId) {
    await appendPrivateText(targetPath, `${JSON.stringify(record)}\n`);
  } else {
    await ensureDir(path.dirname(targetPath));
    await fs.appendFile(targetPath, `${JSON.stringify(record)}\n`, "utf8");
  }
  return { path: targetPath, record };
}

export async function readContextEvents(root, options = {}) {
  const targetPath = getContextEventLogPath(root, options);
  if (!(await exists(targetPath))) {
    return [];
  }

  const raw = await fs.readFile(targetPath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
