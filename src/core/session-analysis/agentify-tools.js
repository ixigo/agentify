// Baseline telemetry for Agentify's OWN MCP tool calls (issue #331).
//
// This is agent tool-call telemetry — how often agents actually reach for
// Agentify's MCP tools — and is deliberately distinct from
// tool-inventory.js, which detects installed dev binaries (rg etc.). It
// reuses the tool calls the provider parsers already extract during their
// single streaming pass; it adds aggregation, not a new parse.
//
// Detection rule. Agentify exposes its tools over an MCP server whose
// serverInfo.name is "agentify" and which the docs register with
// `claude mcp add agentify -- agentify serve`. In transcripts an Agentify
// call is one whose MCP server matches /agentify/i and whose tool is one of
// the six known names. That identity surfaces in more than one shape, so both
// are matched (verified against the real local Codex store):
//   1. A flat `mcp__<server>__<tool>` name — Claude tool_use, and Codex
//      function_call / custom_tool_call whose `name` carries the full form.
//   2. Codex `event_msg` records of type `mcp_tool_call_end`, where identity
//      lives in `invocation.server` / `invocation.tool` and the paired
//      function_call may carry only a bare/namespaced name. Modern Codex CLI
//      versions emit MCP calls this way, so keying only on shape (1) would
//      miss them and inflate the zero-call fraction.
// Requiring the server name (rather than a bare tool suffix) avoids false
// positives from other MCP servers that expose generically named tools such
// as `query` or `risk`. Server and tool names can both contain underscores,
// so the flat suffix is matched from the end rather than by splitting on `__`.

export const AGENTIFY_TOOL_TELEMETRY_VERSION = "agentify-tool-telemetry-v1";

// The tools buildMcpTools() in mcp-server.js exposes. Kept as a literal list
// (not imported) so telemetry never depends on constructing the live server.
export const AGENTIFY_MCP_TOOLS = ["ctx_load", "ctx_note", "ctx_match", "query", "risk", "test_select"];

// `claude mcp add <name> -- agentify serve` lets the operator choose any
// server alias, so the alias in a transcript is not guaranteed to contain
// "agentify". Four of the tool names are distinctive enough to Agentify that
// a match on the tool alone is safe regardless of alias; `query` and `risk`
// are generic English words other MCP servers plausibly expose, so those two
// still require the alias to look like Agentify. The residual limitation
// (query/risk under a non-"agentify" alias) is surfaced in the telemetry
// block rather than silently biasing the baseline.
const DISTINCTIVE_AGENTIFY_TOOLS = new Set(["ctx_load", "ctx_note", "ctx_match", "test_select"]);
const GENERIC_AGENTIFY_TOOLS = new Set(["query", "risk"]);

const MCP_PREFIX = "mcp__";

function isAgentifyServer(server) {
  return /agentify/i.test(String(server || ""));
}

// Decides whether (server, tool) is an Agentify call: distinctive tools match
// under any alias; generic tools require an Agentify-looking server alias.
function resolveAgentifyTool(server, tool) {
  if (DISTINCTIVE_AGENTIFY_TOOLS.has(tool)) return tool;
  if (GENERIC_AGENTIFY_TOOLS.has(tool) && isAgentifyServer(server)) return tool;
  return null;
}

// Returns the canonical Agentify tool name for a flat `mcp__<server>__<tool>`
// name, or null. Works for Claude tool_use and Codex function_call/
// custom_tool_call names. Server and tool names can both contain underscores,
// so the tool suffix is matched from the end rather than by splitting on `__`.
export function matchAgentifyMcpTool(rawName) {
  const name = String(rawName || "");
  if (!name.startsWith(MCP_PREFIX)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  for (const tool of AGENTIFY_MCP_TOOLS) {
    const suffix = `__${tool}`;
    if (rest.length > suffix.length && rest.endsWith(suffix)) {
      const server = rest.slice(0, rest.length - suffix.length);
      const resolved = resolveAgentifyTool(server, tool);
      if (resolved) return resolved;
    }
  }
  return null;
}

// Returns the canonical Agentify tool name for a Codex mcp_tool_call_end
// invocation (explicit server + tool fields), or null.
export function matchAgentifyServerTool(server, tool) {
  const toolName = String(tool || "");
  if (!AGENTIFY_MCP_TOOLS.includes(toolName)) return null;
  return resolveAgentifyTool(server, toolName);
}

// Detects a failed Agentify call from a Codex mcp_tool_call_end `result`.
// Codex serializes the Rust Result enum: { Ok: { content, isError } } for a
// completed MCP call (which may still be a tool-level error via isError) and
// { Err: ... } for a protocol-level failure. Both count as errors.
export function mcpToolCallEndErrored(result) {
  if (!result || typeof result !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(result, "Err")) return true;
  const ok = result.Ok;
  if (ok && typeof ok === "object" && (ok.isError === true || ok.is_error === true)) return true;
  return false;
}

// Best-effort detection of a failed Agentify MCP call from a Codex tool
// output string. Used only as a fallback for older rollouts that carry no
// mcp_tool_call_end result; an MCP error surfaces as an isError / is_error /
// success:false marker (or an error field). Anything unrecognizable stays a
// non-error — the outcome is unknowable and must not be invented, consistent
// with how codex.js treats opaque shell output.
export function codexMcpOutputErrored(rawOutput) {
  if (typeof rawOutput !== "string" || rawOutput.length === 0) return false;
  let parsed;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.isError === true || parsed.is_error === true) return true;
  if (parsed.success === false) return true;
  if (typeof parsed.error === "string" && parsed.error.length > 0) return true;
  return false;
}

// Per-session accumulator carried on the session object by the parsers.
export function emptySessionAgentifyToolCalls() {
  return { calls: 0, errors: 0, by_name: {} };
}

function ensureToolEntry(agg, tool) {
  if (!agg.by_name[tool]) agg.by_name[tool] = { calls: 0, errors: 0 };
  return agg.by_name[tool];
}

export function recordAgentifyToolCall(agg, tool) {
  agg.calls += 1;
  ensureToolEntry(agg, tool).calls += 1;
}

export function recordAgentifyToolError(agg, tool) {
  agg.errors += 1;
  ensureToolEntry(agg, tool).errors += 1;
}

// Merge a subagent transcript's telemetry into its parent session, mirroring
// how index.js folds the other per-session counters.
export function mergeAgentifyToolCalls(target, source) {
  if (!source) return target;
  target.calls += source.calls || 0;
  target.errors += source.errors || 0;
  for (const [tool, entry] of Object.entries(source.by_name || {})) {
    const merged = ensureToolEntry(target, tool);
    merged.calls += entry.calls || 0;
    merged.errors += entry.errors || 0;
  }
  return target;
}

const DETECTION_RULE = "An MCP call to an Agentify tool (one of "
  + `${AGENTIFY_MCP_TOOLS.join(", ")}), the server registered via \`claude mcp add <alias> -- agentify serve\`. `
  + "The distinctive tools (ctx_load, ctx_note, ctx_match, test_select) are matched under any server alias; "
  + "the generic-word tools (query, risk) additionally require the server alias to match /agentify/i. Matched "
  + "from two transcript shapes: a flat mcp__<server>__<tool> name (Claude tool_use and Codex function_call/"
  + "custom_tool_call), and Codex mcp_tool_call_end events carrying invocation.server/tool. Codex calls are "
  + "de-duplicated by call_id so a call present in both shapes is counted once.";

const DETECTION_LIMITATIONS = [
  "query and risk are generic words, so a call to them counts only when the MCP server alias matches "
    + "/agentify/i; if Agentify is registered under an unrelated alias (e.g. `claude mcp add repo-tools`), "
    + "query/risk calls under that alias are not counted and the baseline is a lower bound for those two tools.",
  "Transcripts do not record MCP server registration, so a session with no Agentify call cannot be proven to "
    + "have had Agentify available (see availability.note).",
];

const AVAILABILITY_NOTE = "Neither Claude nor Codex transcripts record which MCP servers were registered "
  + "for a session, so Agentify availability is only positively provable when a call is present. Sessions "
  + "with zero Agentify calls cannot be distinguished between \"server not registered\" and \"registered but "
  + "not called\"; they are labelled availability-undetermined and are never counted as confirmed under-calling.";

const ZERO_CALL_NOTE = "Fraction of ALL in-scope sessions with no Agentify MCP call. Availability is "
  + "undetermined for these sessions (see availability.note), so this is an upper bound on under-calling, "
  + "not a confirmed zero-call rate. confirmed_registered_zero_call is 0 by construction because registration "
  + "can only be proven by a call.";

function ratio(numerator, denominator) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

// Aggregate the per-session Agentify telemetry over the in-window, in-scope
// sessions (after subagent transcripts have been merged into their parents).
export function aggregateAgentifyToolCalls(sessions) {
  const byTool = Object.fromEntries(AGENTIFY_MCP_TOOLS.map((tool) => [tool, { calls: 0, errors: 0 }]));
  const byProvider = {};
  let totalCalls = 0;
  let totalErrors = 0;
  let sessionsWithCalls = 0;

  for (const session of sessions) {
    const agg = session.agentify_tool_calls || emptySessionAgentifyToolCalls();
    const provider = session.provider || "unknown";
    if (!byProvider[provider]) {
      byProvider[provider] = { sessions_total: 0, sessions_with_calls: 0, calls: 0, errors: 0 };
    }
    byProvider[provider].sessions_total += 1;
    byProvider[provider].calls += agg.calls || 0;
    byProvider[provider].errors += agg.errors || 0;
    totalCalls += agg.calls || 0;
    totalErrors += agg.errors || 0;
    if ((agg.calls || 0) > 0) {
      sessionsWithCalls += 1;
      byProvider[provider].sessions_with_calls += 1;
    }
    for (const [tool, entry] of Object.entries(agg.by_name || {})) {
      // Only the six known tools are tracked; matchAgentifyMcpTool already
      // guarantees this, but guard so an unexpected key cannot appear.
      if (!byTool[tool]) continue;
      byTool[tool].calls += entry.calls || 0;
      byTool[tool].errors += entry.errors || 0;
    }
  }

  const sessionsTotal = sessions.length;
  const sessionsWithoutCalls = sessionsTotal - sessionsWithCalls;

  return {
    schema_version: AGENTIFY_TOOL_TELEMETRY_VERSION,
    detection_rule: DETECTION_RULE,
    detection_limitations: [...DETECTION_LIMITATIONS],
    known_tools: [...AGENTIFY_MCP_TOOLS],
    availability: {
      determinable_from_transcript: false,
      confirmed_registered_sessions: sessionsWithCalls,
      note: AVAILABILITY_NOTE,
    },
    sessions_total: sessionsTotal,
    sessions_with_calls: sessionsWithCalls,
    sessions_without_calls: sessionsWithoutCalls,
    total_calls: totalCalls,
    total_errors: totalErrors,
    error_rate: ratio(totalErrors, totalCalls),
    calls_per_session_all: ratio(totalCalls, sessionsTotal),
    calls_per_session_when_registered: ratio(totalCalls, sessionsWithCalls),
    zero_call_sessions: {
      count: sessionsWithoutCalls,
      fraction_of_all: sessionsTotal ? ratio(sessionsWithoutCalls, sessionsTotal) : null,
      availability_undetermined: true,
      confirmed_registered_zero_call: 0,
      note: ZERO_CALL_NOTE,
    },
    by_tool: byTool,
    by_provider: byProvider,
  };
}
