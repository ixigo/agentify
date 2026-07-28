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

// A call counts as Agentify only when the MCP server alias matches
// /agentify/i AND the tool is one of the six. None of the six tool names are
// globally reserved (another context/memory MCP server could expose
// `ctx_note`, `query`, etc.), so keying on the alias is what prevents
// misclassifying an unrelated server as Agentify. `claude mcp add <alias> --
// agentify serve` lets the operator pick any alias; the canonical docs use
// `agentify`. The cost of requiring the alias is a false negative when
// Agentify is registered under an unrelated alias — disclosed in
// detection_limitations rather than traded for false positives.
const MCP_PREFIX = "mcp__";

function isAgentifyServer(server) {
  return /agentify/i.test(String(server || ""));
}

// Decides whether (server, tool) is an Agentify call: the tool must be one of
// the six and the server alias must identify Agentify.
function resolveAgentifyTool(server, tool) {
  if (!AGENTIFY_MCP_TOOLS.includes(tool)) return null;
  return isAgentifyServer(server) ? tool : null;
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
  return resolveAgentifyTool(server, String(tool || ""));
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
// `calls` counts every Agentify call; `resolved` counts the calls whose
// outcome was actually observed (a tool_result for Claude, an
// mcp_tool_call_end result or a parseable output for Codex); `errors` counts
// the resolved calls that failed. Calls with no observed outcome (opaque
// Codex output, truncated Claude sessions) increment `calls` but not
// `resolved`, so an error rate can be reported honestly against what is known.
export function emptySessionAgentifyToolCalls() {
  return { calls: 0, resolved: 0, errors: 0, by_name: {} };
}

function ensureToolEntry(agg, tool) {
  if (!agg.by_name[tool]) agg.by_name[tool] = { calls: 0, resolved: 0, errors: 0 };
  return agg.by_name[tool];
}

export function recordAgentifyToolCall(agg, tool) {
  agg.calls += 1;
  ensureToolEntry(agg, tool).calls += 1;
}

// Records a definitively observed outcome for a call already counted by
// recordAgentifyToolCall. ok=false books an error; ok=true books a resolved
// success. Calls whose outcome is never observed simply never reach here.
export function recordAgentifyToolOutcome(agg, tool, ok) {
  agg.resolved += 1;
  const entry = ensureToolEntry(agg, tool);
  entry.resolved += 1;
  if (ok === false) {
    agg.errors += 1;
    entry.errors += 1;
  }
}

// Merge a subagent transcript's telemetry into its parent session, mirroring
// how index.js folds the other per-session counters.
export function mergeAgentifyToolCalls(target, source) {
  if (!source) return target;
  target.calls += source.calls || 0;
  target.resolved += source.resolved || 0;
  target.errors += source.errors || 0;
  for (const [tool, entry] of Object.entries(source.by_name || {})) {
    const merged = ensureToolEntry(target, tool);
    merged.calls += entry.calls || 0;
    merged.resolved += entry.resolved || 0;
    merged.errors += entry.errors || 0;
  }
  return target;
}

const DETECTION_RULE = "An MCP call whose server alias matches /agentify/i AND whose tool is one of "
  + `${AGENTIFY_MCP_TOOLS.join(", ")} (the server registered via \`claude mcp add <alias> -- agentify serve\`; `
  + "the canonical alias is `agentify`). None of the six tool names are globally reserved, so the alias — not "
  + "the tool name alone — is what identifies Agentify and prevents counting an unrelated context/memory server. "
  + "Matched from two transcript shapes: a flat mcp__<server>__<tool> name (Claude tool_use and Codex "
  + "function_call/custom_tool_call), and Codex mcp_tool_call_end events carrying invocation.server/tool. Codex "
  + "calls are de-duplicated by call_id so a call present in both shapes is counted once.";

const DETECTION_LIMITATIONS = [
  "Detection requires the MCP server alias to match /agentify/i. If Agentify is registered under an unrelated "
    + "alias (e.g. `claude mcp add repo-tools -- agentify serve`), its calls are not counted and the baseline is "
    + "a lower bound. Requiring the alias is deliberate: the six tool names are not globally reserved, so matching "
    + "on the tool alone would false-positive on other context/memory MCP servers — a worse error than this "
    + "disclosed under-count.",
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

const ERROR_RATE_NOTE = "errors / resolved_calls — over calls whose outcome was actually observed. Calls with "
  + "no observed outcome (opaque Codex tool output, truncated Claude sessions with no tool_result) are excluded "
  + "from the denominator rather than assumed successful. error_rate_lower_bound divides the same errors by ALL "
  + "calls and is therefore a floor when some outcomes are unknown.";

function ratio(numerator, denominator) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

// Aggregate the per-session Agentify telemetry over the in-window, in-scope
// sessions (after subagent transcripts have been merged into their parents).
export function aggregateAgentifyToolCalls(sessions) {
  const byTool = Object.fromEntries(AGENTIFY_MCP_TOOLS.map((tool) => [tool, { calls: 0, resolved: 0, errors: 0 }]));
  const byProvider = {};
  let totalCalls = 0;
  let totalResolved = 0;
  let totalErrors = 0;
  let sessionsWithCalls = 0;

  for (const session of sessions) {
    const agg = session.agentify_tool_calls || emptySessionAgentifyToolCalls();
    const provider = session.provider || "unknown";
    if (!byProvider[provider]) {
      byProvider[provider] = { sessions_total: 0, sessions_with_calls: 0, calls: 0, resolved: 0, errors: 0 };
    }
    byProvider[provider].sessions_total += 1;
    byProvider[provider].calls += agg.calls || 0;
    byProvider[provider].resolved += agg.resolved || 0;
    byProvider[provider].errors += agg.errors || 0;
    totalCalls += agg.calls || 0;
    totalResolved += agg.resolved || 0;
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
      byTool[tool].resolved += entry.resolved || 0;
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
    total_resolved_calls: totalResolved,
    total_unknown_outcome_calls: totalCalls - totalResolved,
    total_errors: totalErrors,
    error_rate: ratio(totalErrors, totalResolved),
    error_rate_lower_bound: ratio(totalErrors, totalCalls),
    error_rate_note: ERROR_RATE_NOTE,
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
