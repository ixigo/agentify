import path from "node:path";

import { appendPrivateText, exists, readText } from "./fs.js";
import { resolveLocalAgentifyPaths } from "./project-store.js";

export const VALUE_EVENT_SCHEMA_VERSION = "value-event-v1";
const CHARS_PER_TOKEN = 4;

export function resolveValueEventsPath(root) {
  return path.join(resolveLocalAgentifyPaths(root).runtimeRoot, "context", "value-events.jsonl");
}

export function estimateContextTokens(text) {
  const length = String(text || "").length;
  return length === 0 ? 0 : Math.max(1, Math.round(length / CHARS_PER_TOKEN));
}

export async function recordValueEvent(root, event) {
  if (!event?.type) {
    throw new Error("value telemetry requires an event type");
  }
  const record = {
    schema: VALUE_EVENT_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    ...event,
  };
  await appendPrivateText(resolveValueEventsPath(root), `${JSON.stringify(record)}\n`);
  return record;
}

export async function readValueEvents(root) {
  const targetPath = resolveValueEventsPath(root);
  if (!(await exists(targetPath))) {
    return [];
  }
  const records = [];
  for (const line of (await readText(targetPath)).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record && typeof record === "object" && !Array.isArray(record)) {
        records.push(record);
      }
    } catch {
      // Value reporting is best-effort; one corrupt event must not hide the rest.
    }
  }
  return records;
}
