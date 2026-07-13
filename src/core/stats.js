import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, exists, readText } from "./fs.js";
import { resolveContextPaths } from "./ctx.js";

const STATS_SCHEMA_VERSION = "stats-v2";
const DELEGATION_SCHEMA_VERSION = "delegation-v2";
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
      const parsed = JSON.parse(trimmed);
      // Valid JSON that is not an object (null, numbers, arrays) would blow
      // up downstream field access; skip it like a corrupt line.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed);
      }
    } catch {
      // Skip corrupt lines.
    }
  }
  return records;
}

export async function readDelegationRecords(root) {
  return readJsonLines(resolveDelegationsPath(root));
}

function isV2Record(record) {
  return record.schema === DELEGATION_SCHEMA_VERSION;
}

function recordCost(record) {
  return typeof record.cost_usd === "number" && Number.isFinite(record.cost_usd) ? record.cost_usd : null;
}

function emptyBucket() {
  return {
    count: 0,
    failures: 0,
    fallbacks: 0,
    budget_stops: 0,
    input_tokens: 0,
    output_tokens: 0,
    fresh_input_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    estimated_records: 0,
    legacy_records: 0,
    cost_usd: 0,
    costed_records: 0,
    duration_ms: 0,
  };
}

function addToBucket(bucket, record) {
  bucket.count += 1;
  if (record.exit_code !== 0) bucket.failures += 1;
  if (record.used_fallback) bucket.fallbacks += 1;
  if (record.budget_stop_reason) bucket.budget_stops += 1;
  bucket.input_tokens += record.input_tokens || 0;
  bucket.output_tokens += record.output_tokens || 0;
  if (isV2Record(record)) {
    if (record.usage && typeof record.usage === "object") {
      bucket.fresh_input_tokens += record.usage.fresh_input_tokens || 0;
      bucket.cache_read_tokens += record.usage.cache_read_tokens || 0;
      bucket.cache_write_tokens += record.usage.cache_write_tokens || 0;
    }
  } else {
    // Legacy stats-v1 lines carry only aggregate input tokens; they stay in
    // the totals but are marked so cache ratios don't misread them as fresh.
    bucket.legacy_records += 1;
  }
  if (record.tokens_estimated) bucket.estimated_records += 1;
  const cost = recordCost(record);
  if (cost !== null) {
    bucket.cost_usd += cost;
    bucket.costed_records += 1;
  }
  bucket.duration_ms += record.duration_ms || 0;
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) {
    return null;
  }
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(fraction * sortedValues.length) - 1));
  return sortedValues[index];
}

export async function buildStatsReport(root, options = {}) {
  const days = Number.isFinite(options.days) && options.days > 0 ? options.days : DEFAULT_WINDOW_DAYS;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const delegations = (await readDelegationRecords(root))
    .filter((record) => String(record.ts || "") >= cutoff);

  const totals = emptyBucket();
  const byKind = new Map();
  const byTarget = new Map();
  const byDay = new Map();
  const fallbackReasons = new Map();
  const durations = [];
  for (const record of delegations) {
    addToBucket(totals, record);
    const kindKey = record.kind || "unknown";
    if (!byKind.has(kindKey)) byKind.set(kindKey, emptyBucket());
    addToBucket(byKind.get(kindKey), record);
    const targetKey = `${record.provider || "unknown"}${record.model ? `/${record.model}` : ""}`;
    if (!byTarget.has(targetKey)) byTarget.set(targetKey, emptyBucket());
    addToBucket(byTarget.get(targetKey), record);

    const day = String(record.ts || "").slice(0, 10);
    if (day) {
      const bucket = byDay.get(day) || { runs: 0, cost_usd: 0, costed_records: 0 };
      bucket.runs += 1;
      const cost = recordCost(record);
      if (cost !== null) {
        bucket.cost_usd += cost;
        bucket.costed_records += 1;
      }
      byDay.set(day, bucket);
    }
    if (record.used_fallback) {
      const reason = record.fallback_reason || "unknown";
      fallbackReasons.set(reason, (fallbackReasons.get(reason) || 0) + 1);
    }
    if (typeof record.duration_ms === "number" && record.duration_ms >= 0) {
      durations.push(record.duration_ms);
    }
  }
  durations.sort((a, b) => a - b);

  const cacheDenominator = totals.fresh_input_tokens + totals.cache_read_tokens + totals.cache_write_tokens;

  const paths = resolveContextPaths(root);
  const events = await readJsonLines(paths.eventsPath);
  const windowEvents = events.filter((event) => String(event.ts || "") >= cutoff);
  const sessions = new Set(windowEvents.map((event) => event.sid).filter(Boolean));
  const edits = windowEvents.filter((event) => event.type === "edit").length;
  const commands = windowEvents.filter((event) => event.type === "cmd");
  const failedCommands = commands.filter((event) => event.fail).length;
  const notes = (await readJsonLines(paths.notesPath)).filter((note) => String(note.ts || "") >= cutoff).length;

  const summaries = await buildSummaryMaintenance(paths, cutoff);

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
      latency: {
        p50_ms: percentile(durations, 0.5),
        p95_ms: percentile(durations, 0.95),
      },
      cache: {
        fresh_input_tokens: totals.fresh_input_tokens,
        cache_read_tokens: totals.cache_read_tokens,
        cache_write_tokens: totals.cache_write_tokens,
        read_ratio: cacheDenominator > 0 ? totals.cache_read_tokens / cacheDenominator : null,
      },
      cost_coverage: {
        reported_records: totals.costed_records,
        total_records: totals.count,
        ratio: totals.count > 0 ? totals.costed_records / totals.count : null,
      },
      fallback_reasons: Object.fromEntries([...fallbackReasons.entries()].sort()),
      daily: [...byDay.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, bucket]) => ({ date, ...bucket, cost_usd: Number(bucket.cost_usd.toFixed(6)) })),
      legacy_records: totals.legacy_records,
    },
    summaries,
  };
}

// Maintenance view for session summaries: what they cost to generate and
// whether they are ever actually injected into a later session.
async function buildSummaryMaintenance(paths, cutoff) {
  const records = (await readJsonLines(paths.summariesPath)).filter((record) => String(record.ts || "") >= cutoff);
  // Usage rows are matched back to the summaries in this window, so an old
  // summary injected today can never push the rate past 100%.
  const summaryKeys = new Set(records.map((record) => `sum:${record.ts}`));
  const usage = (await readJsonLines(paths.summaryUsagePath || ""))
    .filter((record) => String(record.ts || "") >= cutoff && summaryKeys.has(record.key));

  const byMode = {};
  let llmCost = 0;
  for (const record of records) {
    // Records written before summary modes existed count as legacy.
    const mode = record.mode || "legacy";
    byMode[mode] = (byMode[mode] || 0) + 1;
    if (mode === "llm" && typeof record.cost_usd === "number") {
      llmCost += record.cost_usd;
    }
  }

  const injectedKeys = new Set(usage.map((record) => record.key).filter(Boolean));
  const ages = usage
    .filter((record) => record.summary_ts && record.ts)
    .map((record) => (Date.parse(record.ts) - Date.parse(record.summary_ts)) / (24 * 60 * 60 * 1000))
    .filter((age) => Number.isFinite(age) && age >= 0);

  return {
    count: records.length,
    by_mode: byMode,
    llm_cost_usd: Number(llmCost.toFixed(6)),
    injections: usage.length,
    injected_unique: injectedKeys.size,
    injection_rate: records.length > 0 ? injectedKeys.size / records.length : null,
    avg_age_days_at_use: ages.length > 0 ? Number((ages.reduce((sum, age) => sum + age, 0) / ages.length).toFixed(2)) : null,
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
  if (bucket.budget_stops > 0) parts.push(`${bucket.budget_stops} budget-stopped`);
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

    const latency = report.delegations.latency;
    if (latency.p50_ms !== null) {
      lines.push(`- latency: P50 ${(latency.p50_ms / 1000).toFixed(1)}s, P95 ${(latency.p95_ms / 1000).toFixed(1)}s`);
    }
    const cache = report.delegations.cache;
    if (cache.read_ratio !== null) {
      lines.push(`- cache: ${formatTokens(cache.fresh_input_tokens)} fresh / ${formatTokens(cache.cache_read_tokens)} read / ${formatTokens(cache.cache_write_tokens)} write (${Math.round(cache.read_ratio * 100)}% cache reads)`);
    }
    const coverage = report.delegations.cost_coverage;
    if (coverage.ratio !== null && coverage.reported_records < coverage.total_records) {
      lines.push(`- cost coverage: provider reported cost for ${coverage.reported_records}/${coverage.total_records} run(s); the rest have no dollar figure`);
    }

    lines.push("", "By kind:");
    for (const [kind, bucket] of Object.entries(report.delegations.by_kind)) {
      lines.push(bucketLine(kind, bucket));
    }
    lines.push("", "By model:");
    for (const [target, bucket] of Object.entries(report.delegations.by_target)) {
      lines.push(bucketLine(target, bucket));
    }

    const daily = report.delegations.daily;
    if (daily.length > 1) {
      lines.push("", "Daily cost:");
      for (const day of daily.slice(-7)) {
        lines.push(`- ${day.date}: ${day.runs} run(s), $${day.cost_usd.toFixed(4)}${day.costed_records < day.runs ? ` (${day.costed_records}/${day.runs} reported)` : ""}`);
      }
    }

    if (totals.estimated_records > 0) {
      lines.push("", `Note: token counts for ${totals.estimated_records} run(s) are estimates (~${CHARS_PER_TOKEN} chars/token); the provider CLI reported no usage.`);
    }
    if (totals.legacy_records > 0) {
      lines.push(`Note: ${totals.legacy_records} run(s) predate cache-aware telemetry (legacy aggregate records); cache ratios exclude them.`);
    }
  }

  const summaries = report.summaries;
  if (summaries && summaries.count > 0) {
    const modeParts = Object.entries(summaries.by_mode).map(([mode, count]) => `${count} ${mode}`).join(", ");
    const parts = [
      `${summaries.count} summary(ies) (${modeParts})`,
      `LLM spend $${summaries.llm_cost_usd.toFixed(4)}`,
      summaries.injection_rate !== null ? `${Math.round(summaries.injection_rate * 100)}% later injected` : "no injection data",
    ];
    if (summaries.avg_age_days_at_use !== null) {
      parts.push(`avg ${summaries.avg_age_days_at_use} day(s) old at use`);
    }
    lines.push("", "Session summaries:", `- ${parts.join(", ")}`);
  }

  return lines.join("\n");
}
