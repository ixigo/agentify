import { classifyPromptText, classifyTask, emptyUsage, addObserved, finalizeDuration, SESSION_ANALYSIS_SCHEMA_VERSION, SESSION_PARSER_VERSION, stableHash, timestampBounds } from "../normalize.js";
import { createToolFacts, mergeFileEvents, observeTool } from "../file-access.js";
import { streamJsonl } from "../stream-jsonl.js";

export async function parseClaudeSession(file, options = {}) {
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
  let mainRecords = 0;
  let sidechainRecords = 0;

  const coverage = await streamJsonl(file.path, (record) => {
    if (!record || typeof record !== "object") return;
    bounds = timestampBounds(bounds, record.timestamp);
    rawSessionId ||= record.sessionId || record.session_id || null;
    cwd ||= typeof record.cwd === "string" ? record.cwd : null;
    branch ||= typeof record.gitBranch === "string" ? record.gitBranch : null;
    cliVersion ||= typeof record.version === "string" ? record.version : null;
    if (record.isSidechain === true) {
      sidechainRecords += 1;
      return;
    }
    mainRecords += 1;

    if (options.contentMode === "local-extractive" && record.type === "user") {
      const content = record.message?.content;
      if (typeof content === "string") extractedCategory ||= classifyPromptText(content);
    }
    if (record.type !== "assistant" || !record.message || typeof record.message !== "object") return;
    if (record.message.model) models.add(String(record.message.model));
    const observed = record.message.usage;
    if (observed && typeof observed === "object") {
      addObserved(usage, "fresh_input_tokens", observed.input_tokens);
      addObserved(usage, "cache_read_tokens", observed.cache_read_input_tokens);
      addObserved(usage, "cache_write_tokens", observed.cache_creation_input_tokens);
      addObserved(usage, "output_tokens", observed.output_tokens);
    }
    for (const part of Array.isArray(record.message.content) ? record.message.content : []) {
      if (part?.type !== "tool_use") continue;
      fileEvents.push(...observeTool(tools, part.name, part.input, {
        projectRoot: options.projectRoot || cwd,
        cwd,
      }));
    }
  }, options);

  if (mainRecords === 0) return { session: null, coverage: { ...coverage, sidechain_records_deduplicated: sidechainRecords } };
  const projectKey = stableHash(cwd || file.path);
  return {
    session: {
      schema_version: SESSION_ANALYSIS_SCHEMA_VERSION,
      provider: "claude",
      session_id: stableHash(`claude:${rawSessionId || file.path}`),
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
      outcome: { status: "unknown", evidence: [] },
      opportunities: [],
      parser: { name: "claude-jsonl", version: SESSION_PARSER_VERSION, cli_version: cliVersion },
    },
    coverage: { ...coverage, sidechain_records_deduplicated: sidechainRecords },
  };
}
