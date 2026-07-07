import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, exists, readText } from "./fs.js";
import { resolveContextPaths } from "./ctx.js";

const STATS_SCHEMA_VERSION = "stats-v1";
const DEFAULT_WINDOW_DAYS = 30;
// Rough chars-per-token used when the provider CLI reports no usage.
const CHARS_PER_TOKEN = 4;

export function resolveDelegationsPath(root) {
  return path.join(resolveContextPaths(root).contextRoot, "delegations.jsonl");
}

export function estimateTokens(text) {
  const length = String(text || "").length;
  return length === 0 ? 0 : Math.max(1, Math.round(length / CHARS_PER_TOKEN));
}

export async function recordDelegation(root, record) {
  const targetPath = resolveDelegationsPath(root);
  await ensureDir(path.dirname(targetPath));
  await fs.appendFile(targetPath, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, "utf8");
  return targetPath;
}

async function readJsonLines(targetPath) {
  if (!(await exists(targetPath))) {
    return [];
  }
  const records = [];
  for (const line of (await readText(targetPath)).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Skip corrupt lines.
    }
  }
  return records;
}

function emptyBucket() {
  return {
    count: 0,
    failures: 0,
    fallbacks: 0,
    input_tokens: 0,
    output_tokens: 0,
    estimated_records: 0,
    cost_usd: 0,
    costed_records: 0,
    duration_ms: 0,
  };
}

function addToBucket(bucket, record) {
  bucket.count += 1;
  if (record.exit_code !== 0) bucket.failures += 1;
  if (record.used_fallback) bucket.fallbacks += 1;
  bucket.input_tokens += record.input_tokens || 0;
  bucket.output_tokens += record.output_tokens || 0;
  if (record.tokens_estimated) bucket.estimated_records += 1;
  if (typeof record.cost_usd === "number") {
    bucket.cost_usd += record.cost_usd;
    bucket.costed_records += 1;
  }
  bucket.duration_ms += record.duration_ms || 0;
}

export async function buildStatsReport(root, options = {}) {
  const days = Number.isFinite(options.days) && options.days > 0 ? options.days : DEFAULT_WINDOW_DAYS;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const delegations = (await readJsonLines(resolveDelegationsPath(root)))
    .filter((record) => String(record.ts || "") >= cutoff);

  const totals = emptyBucket();
  const byKind = new Map();
  const byTarget = new Map();
  for (const record of delegations) {
    addToBucket(totals, record);
    const kindKey = record.kind || "unknown";
    if (!byKind.has(kindKey)) byKind.set(kindKey, emptyBucket());
    addToBucket(byKind.get(kindKey), record);
    const targetKey = `${record.provider || "unknown"}${record.model ? `/${record.model}` : ""}`;
    if (!byTarget.has(targetKey)) byTarget.set(targetKey, emptyBucket());
    addToBucket(byTarget.get(targetKey), record);
  }

  const paths = resolveContextPaths(root);
  const events = await readJsonLines(paths.eventsPath);
  const windowEvents = events.filter((event) => String(event.ts || "") >= cutoff);
  const sessions = new Set(windowEvents.map((event) => event.sid).filter(Boolean));
  const edits = windowEvents.filter((event) => event.type === "edit").length;
  const commands = windowEvents.filter((event) => event.type === "cmd");
  const failedCommands = commands.filter((event) => event.fail).length;
  const notes = (await readJsonLines(paths.notesPath)).filter((note) => String(note.ts || "") >= cutoff).length;

  return {
    schema_version: STATS_SCHEMA_VERSION,
    command: "stats",
    window_days: days,
    sessions: {
      count: sessions.size,
      edits,
      commands: commands.length,
      failed_commands: failedCommands,
      notes,
    },
    delegations: {
      totals,
      by_kind: Object.fromEntries([...byKind.entries()].sort()),
      by_target: Object.fromEntries([...byTarget.entries()].sort()),
    },
  };
}

function formatTokens(count) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function formatCost(bucket) {
  if (bucket.costed_records === 0) {
    return "n/a";
  }
  const suffix = bucket.costed_records < bucket.count ? ` (${bucket.costed_records}/${bucket.count} reported)` : "";
  return `$${bucket.cost_usd.toFixed(4)}${suffix}`;
}

function bucketLine(label, bucket) {
  const parts = [
    `${bucket.count} run(s)`,
    `${formatTokens(bucket.input_tokens)} in / ${formatTokens(bucket.output_tokens)} out`,
    `cost ${formatCost(bucket)}`,
  ];
  if (bucket.fallbacks > 0) parts.push(`${bucket.fallbacks} fallback(s)`);
  if (bucket.failures > 0) parts.push(`${bucket.failures} failed`);
  return `- ${label}: ${parts.join(", ")}`;
}

export function renderStatsReport(report) {
  const lines = [`Agentify stats — last ${report.window_days} day(s)`];

  lines.push(
    "",
    "Sessions:",
    `- ${report.sessions.count} session(s), ${report.sessions.edits} edit(s), ${report.sessions.commands} command(s) (${report.sessions.failed_commands} failed), ${report.sessions.notes} note(s)`,
  );

  const totals = report.delegations.totals;
  lines.push("", "Delegations:");
  if (totals.count === 0) {
    lines.push("- none recorded (delegate with `agentify delegate <kind> \"<task>\"`)");
  } else {
    lines.push(bucketLine("total", totals));
    lines.push("", "By kind:");
    for (const [kind, bucket] of Object.entries(report.delegations.by_kind)) {
      lines.push(bucketLine(kind, bucket));
    }
    lines.push("", "By model:");
    for (const [target, bucket] of Object.entries(report.delegations.by_target)) {
      lines.push(bucketLine(target, bucket));
    }
    if (totals.estimated_records > 0) {
      lines.push("", `Note: token counts for ${totals.estimated_records} run(s) are estimates (~${CHARS_PER_TOKEN} chars/token); the provider CLI reported no usage.`);
    }
  }
  return lines.join("\n");
}
