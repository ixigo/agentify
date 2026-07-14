import { classifyPromptText, classifyTask, emptyUsage, finalizeDuration, SESSION_ANALYSIS_SCHEMA_VERSION, SESSION_PARSER_VERSION, stableHash, timestampBounds } from "../normalize.js";
import { createToolFacts, mergeFileEvents, observeTool } from "../file-access.js";
import { streamJsonl } from "../stream-jsonl.js";

function parseKnownInput(value) {
  if (!value || typeof value !== "string" || value.length > 1_000_000) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function parseCodexSession(file, options = {}) {
  const usage = emptyUsage();
  const tools = createToolFacts();
  const fileEvents = [];
  const models = new Set();
  let rawSessionId = null;
  let cwd = null;
  let branch = null;
  let cliVersion = null;
  let bounds = { startedAt: null, endedAt: null };
  let extractedCategory = null;
  let lastCumulative = null;
  let completed = false;

  const coverage = await streamJsonl(file.path, (record) => {
    if (!record || typeof record !== "object") return;
    bounds = timestampBounds(bounds, record.timestamp);
    const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
    if (record.type === "session_meta") {
      rawSessionId ||= payload.session_id || payload.id || null;
      cwd ||= typeof payload.cwd === "string" ? payload.cwd : null;
      branch ||= typeof payload.git?.branch === "string" ? payload.git.branch : null;
      cliVersion ||= typeof payload.cli_version === "string" ? payload.cli_version : null;
    }
    if (record.type === "turn_context") {
      cwd ||= typeof payload.cwd === "string" ? payload.cwd : null;
      if (payload.model) models.add(String(payload.model));
    }
    if (record.type === "event_msg" && payload.type === "token_count") {
      const total = payload.info?.total_token_usage;
      if (total && typeof total === "object") lastCumulative = total;
    }
    if (record.type === "event_msg" && ["task_complete", "task_completed"].includes(payload.type)) completed = true;
    if (options.contentMode === "local-extractive" && record.type === "event_msg" && payload.type === "user_message") {
      extractedCategory ||= classifyPromptText(payload.message);
    }
    if (record.type !== "response_item" || !["function_call", "custom_tool_call"].includes(payload.type)) return;
    const name = String(payload.name || (payload.type === "custom_tool_call" ? "custom_tool_call" : "unknown"));
    const rawInput = payload.arguments ?? payload.input;
    const input = parseKnownInput(rawInput) || (name === "apply_patch" ? { patch: rawInput } : null);
    fileEvents.push(...observeTool(tools, name, input, {
      projectRoot: options.projectRoot || cwd,
      cwd,
    }));
  }, options);

  if (lastCumulative) {
    const input = Number(lastCumulative.input_tokens);
    const cached = Number(lastCumulative.cached_input_tokens);
    usage.fresh_input_tokens = Number.isFinite(input)
      ? Math.max(0, input - (Number.isFinite(cached) ? cached : 0))
      : null;
    usage.cache_read_tokens = Number.isFinite(cached) && cached >= 0 ? cached : null;
    usage.output_tokens = Number.isFinite(Number(lastCumulative.output_tokens)) ? Number(lastCumulative.output_tokens) : null;
    usage.reasoning_output_tokens = Number.isFinite(Number(lastCumulative.reasoning_output_tokens)) ? Number(lastCumulative.reasoning_output_tokens) : null;
  }

  const projectKey = stableHash(cwd || file.path);
  return {
    session: {
      schema_version: SESSION_ANALYSIS_SCHEMA_VERSION,
      provider: "codex",
      session_id: stableHash(`codex:${rawSessionId || file.path}`),
      started_at: bounds.startedAt,
      ended_at: bounds.endedAt,
      duration_ms: finalizeDuration(bounds.startedAt, bounds.endedAt),
      project: { scope: options.scope || "current-repo", alias: null, branch, key: projectKey, display: cwd },
      models: [...models].sort(),
      usage,
      cost: { reported_usd: null, estimated_usd: null, basis: "unavailable", coverage: 0 },
      tools,
      file_access: mergeFileEvents(fileEvents),
      task: classifyTask(tools.patterns, extractedCategory),
      outcome: { status: completed ? "completed" : "unknown", evidence: completed ? ["provider task-complete event"] : [] },
      opportunities: [],
      parser: { name: "codex-jsonl", version: SESSION_PARSER_VERSION, cli_version: cliVersion },
    },
    coverage,
  };
}
