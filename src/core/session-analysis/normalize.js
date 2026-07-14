import crypto from "node:crypto";

export const SESSION_ANALYSIS_SCHEMA_VERSION = "session-analysis-v1";
export const SESSION_PARSER_VERSION = 2;

export const USAGE_FIELDS = [
  "fresh_input_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "output_tokens",
  "reasoning_output_tokens",
];

export function stableHash(value, length = 16) {
  return crypto.createHash("sha256").update(String(value || "unknown")).digest("hex").slice(0, length);
}

export function emptyUsage() {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, null]));
}

export function addObserved(target, field, value) {
  if (value === null || value === undefined || value === "") {
    return;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return;
  }
  target[field] = (target[field] ?? 0) + number;
}

export function aggregateUsage(sessions) {
  const usage = emptyUsage();
  for (const session of sessions) {
    for (const field of USAGE_FIELDS) {
      addObserved(usage, field, session.usage?.[field]);
    }
  }
  return usage;
}

export function timestampBounds(current, value) {
  if (!value || !Number.isFinite(Date.parse(value))) {
    return current;
  }
  const iso = new Date(value).toISOString();
  return {
    startedAt: !current.startedAt || iso < current.startedAt ? iso : current.startedAt,
    endedAt: !current.endedAt || iso > current.endedAt ? iso : current.endedAt,
  };
}

export function finalizeDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) {
    return null;
  }
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function classifyTask(toolPatterns, extractedCategory = null) {
  if (extractedCategory) {
    return { category: extractedCategory, confidence: 0.75, content_mode: "local-extractive" };
  }
  if ((toolPatterns.write_calls || 0) > 0 && (toolPatterns.test_calls || 0) > 0) {
    return { category: "debugging", confidence: 0.65, content_mode: "metadata-only" };
  }
  if ((toolPatterns.write_calls || 0) > 0) {
    return { category: "implementation", confidence: 0.6, content_mode: "metadata-only" };
  }
  if ((toolPatterns.read_calls || 0) + (toolPatterns.search_calls || 0) > 0) {
    return { category: "research", confidence: 0.5, content_mode: "metadata-only" };
  }
  return { category: "unknown", confidence: 0, content_mode: "metadata-only" };
}

export function classifyPromptText(value) {
  const text = String(value || "").toLowerCase();
  if (/\b(fix|bug|error|failing|failure|debug)\b/.test(text)) return "debugging";
  if (/\b(implement|build|add|create|change|refactor)\b/.test(text)) return "implementation";
  if (/\b(review|audit|inspect)\b/.test(text)) return "review";
  if (/\b(research|explain|investigate|find|why)\b/.test(text)) return "research";
  return null;
}
