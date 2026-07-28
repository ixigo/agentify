import readline from "node:readline";

import { addNote, listDecisions, loadContextSnapshot, matchContext, renderContextDigest, renderDecisions, renderMatchDigest, writeHandoff } from "./ctx.js";
import {
  queryCallers,
  queryChanged,
  queryDef,
  queryDeps,
  queryImpacts,
  queryOwner,
  queryRefs,
  querySearch,
} from "./query.js";
import { buildRiskReport, renderRiskReport } from "./risk.js";
import { buildTestSelection, renderTestSelection } from "./test-select.js";
import { VERSION } from "./cli-fast-paths.js";

const PROTOCOL_VERSION = "2025-06-18";

const QUERY_KINDS = ["search", "def", "refs", "callers", "impacts", "owner", "deps", "changed"];

// Two ablatable description sets for the eight tools (#334). Set "a" is the
// current, shipped wording (part descriptive, part trigger). Set "b" is written
// strictly as trigger conditions ("When you are about to …, call this"). Tool
// names, schemas, and handlers are identical across sets — only the description
// string differs, so this is an isolated ablation of the description variable.
//
// The active set is chosen by AGENTIFY_MCP_DESCRIPTIONS (a|b), defaulting to
// "a". Set "b" is opt-in and NOT the default: it is the arm the paired eval in
// evals/mcp-descriptions/ measures against "a", and no description is adopted
// until that evaluation produces evidence. Keep set "a" byte-identical to the
// shipped wording — a snapshot test pins both sets so a later edit here cannot
// silently drift from the text the ablation compared.
export const MCP_TOOL_DESCRIPTIONS = {
  a: {
    ctx_load: "Digest of what previous agent sessions did in this repository: session summaries, notes left for future sessions, hot files, recent commands, and commands that failed and were never fixed. Call this at the start of a task to avoid rediscovering known context.",
    ctx_note: "Record a note for future agent sessions working in this repository: gotchas, open threads, or anything worth remembering. Use type \"decision\" for durable technical decisions with rationale (\"chose X over Y because Z\") — decisions are kept queryable so settled questions are not relitigated. Notes are surfaced to later sessions when relevant.",
    ctx_match: "Find context from previous sessions related to a specific task: notes, session summaries, previously-edited files, and past command failures that look relevant. Use before starting work on a described task.",
    query: "Structural queries over the repository index. Kinds: search (full-text over symbols/files), def (find a symbol definition), refs (references to a symbol), callers (callers of a symbol), impacts (files affected if a file changes), owner (module owning a file), deps (module dependencies), changed (indexed files changed since a ref). Requires `agentify scan` to have been run.",
    risk: "Score the blast radius of the current change (or since a git ref): risk level, impacted modules/files/symbols, and prioritized regression test commands. Use before finishing a change.",
    test_select: "Select only the test files affected by the current change (or since a git ref) using the structural index, with ready-to-run commands — instead of running the full suite.",
    ctx_decisions: "Before you propose, endorse, or start implementing a technical direction that may already be settled — an architecture, a library or dependency, a data or file format, a naming or workflow convention — call this first to check whether a prior session already decided it. Previous sessions record durable decisions with rationale (\"chose X over Y because Z\"); read them before suggesting a direction so you do not re-propose or relitigate something already decided and rejected. Pass the topic you are about to weigh in on; omit it to review the decisions already on record. Returns matching decisions with their rationale, or a clear message when none are on record.",
    ctx_handoff: "Call this when you are wrapping up a long or multi-step task, or ending a session with work still in flight, to persist a durable handoff summary before the context is lost. It captures recent activity, decisions on record, hot files, and commands that failed and were not fixed, and writes them to a Markdown file under the context store. Returns the saved path and a preview of the contents so you can point the next session (or a teammate) at the file.",
  },
  b: {
    ctx_load: "When you are starting a task in this repository and have not yet loaded prior context, call this first — before reading files or planning — to avoid rediscovering what earlier sessions already established. Returns a digest of prior session summaries, notes left for future sessions, hot files, recent commands, and commands that failed and were never fixed.",
    ctx_note: "When you hit a gotcha, leave an open thread, or make a durable technical decision that a future session would waste time rediscovering or relitigating, call this to record it before you move on. Use type \"decision\" for a settled choice with rationale (\"chose X over Y because Z\"); use the default note type for everything else. Recorded items are surfaced to later sessions when relevant.",
    ctx_match: "When you are about to start work described by a task or ticket, call this first with that description to pull only the prior-session context that matches it — related notes, session summaries, previously-edited files, and past command failures — before you begin exploring.",
    query: "When you need to locate or reason about code before editing it — where a symbol is defined, who references or calls it, which files a change impacts, which module owns a file, a module's dependencies, or what changed since a ref — call this instead of guessing or grepping by hand. Kinds: search, def, refs, callers, impacts, owner, deps, changed. Requires `agentify scan` to have been run.",
    risk: "When you believe a change is complete and are about to declare it done, call this first to score its blast radius before you stop: it returns the risk level, the impacted modules/files/symbols, and the prioritized regression tests to run. Pass a git ref to diff against, or omit it to score the working tree.",
    test_select: "When a change is ready to verify and you are about to run tests, call this first to get only the test files the change actually affects, with ready-to-run commands — so you do not run the whole suite. Pass a git ref to diff against, or omit it to use the working tree.",
    ctx_decisions: "When you are about to propose, endorse, or start implementing a technical direction that may already be settled — an architecture, a library or dependency, a data or file format, a naming or workflow convention — call this first, before you suggest it, to check whether a prior session already decided the question. Pass the topic you are weighing; omit it to review every decision on record. Returns matching decisions with their rationale, or a clear message when none are on record, so you do not re-propose something already decided and rejected.",
    ctx_handoff: "When you are wrapping up a long or multi-step task, or ending a session with work still in flight, call this before the context is lost to persist a durable handoff summary. It captures recent activity, decisions on record, hot files, and commands that failed and were not fixed, writes them to a Markdown file under the context store, and returns the saved path plus a preview so you can point the next session at it.",
  },
};

// Resolve the active description set. Config wins (so callers can pin it
// explicitly); otherwise the AGENTIFY_MCP_DESCRIPTIONS env var, defaulting to
// the shipped set "a". Any unrecognized value falls back to "a" rather than
// throwing — a bad env must never take the server down.
export function resolveDescriptionSet(config = {}) {
  const raw = String(
    config.mcpDescriptionSet ?? process.env.AGENTIFY_MCP_DESCRIPTIONS ?? "a",
  ).trim().toLowerCase();
  return raw === "b" ? "b" : "a";
}

// Bounds the ctx_decisions response so a lookup on a mature repo cannot flood
// the caller's context: at most 50 decisions and ~12k characters (~3k tokens),
// whichever binds first — a note can be up to ~2000 chars, so the count cap
// alone is not a size cap. renderDecisions keeps the most relevant/newest
// entries and reports how many more were truncated.
const MAX_RENDERED_DECISIONS = 50;
const MAX_RENDERED_DECISION_CHARS = 12000;

// A handoff renders the full context digest (up to 50 notes, each up to ~2000
// chars), so the file can be large. The tool returns a bounded preview plus the
// path; the complete handoff always lives on disk.
const HANDOFF_PREVIEW_CHARS = 2000;

export function buildMcpTools(root, config = {}) {
  const queryOptions = { config, artifactPaths: config._agentifyPaths };
  const descriptions = MCP_TOOL_DESCRIPTIONS[resolveDescriptionSet(config)];

  return [
    {
      name: "ctx_load",
      description: descriptions.ctx_load,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async handler() {
        const snapshot = await loadContextSnapshot(root);
        return renderContextDigest(snapshot) || "No tracked context yet.";
      },
    },
    {
      name: "ctx_note",
      description: descriptions.ctx_note,
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The note to record" },
          type: { type: "string", enum: ["note", "decision"], description: "Kind of note (default: note)" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      async handler(args) {
        const result = await addNote(root, args.text, { type: args.type });
        return `${result.record.type === "decision" ? "Decision recorded" : "Noted"}: ${result.record.note}`;
      },
    },
    {
      name: "ctx_match",
      description: descriptions.ctx_match,
      inputSchema: {
        type: "object",
        properties: { task: { type: "string", description: "Description of the task you are about to work on" } },
        required: ["task"],
        additionalProperties: false,
      },
      async handler(args) {
        const matches = await matchContext(root, args.task, { recordInjection: false, config });
        return renderMatchDigest(matches) || "No related context found.";
      },
    },
    {
      name: "query",
      description: descriptions.query,
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: QUERY_KINDS, description: "Query kind" },
          term: { type: "string", description: "Search term (kind: search)" },
          symbol: { type: "string", description: "Symbol name (kinds: def, refs, callers)" },
          file: { type: "string", description: "File path (kinds: impacts, owner)" },
          module: { type: "string", description: "Module id (kind: deps)" },
          since: { type: "string", description: "Commit or ref (kind: changed)" },
          depth: { type: "number", description: "Traversal depth (kind: impacts)" },
        },
        required: ["kind"],
        additionalProperties: false,
      },
      async handler(args) {
        let result;
        switch (args.kind) {
          case "search":
            if (!args.term) throw new Error("query search requires term");
            result = await querySearch(root, args.term, queryOptions);
            break;
          case "def":
            if (!args.symbol) throw new Error("query def requires symbol");
            result = await queryDef(root, args.symbol, queryOptions);
            break;
          case "refs":
            if (!args.symbol) throw new Error("query refs requires symbol");
            result = await queryRefs(root, args.symbol, queryOptions);
            break;
          case "callers":
            if (!args.symbol) throw new Error("query callers requires symbol");
            result = await queryCallers(root, args.symbol, queryOptions);
            break;
          case "impacts":
            if (!args.file) throw new Error("query impacts requires file");
            result = await queryImpacts(root, args.file, { ...queryOptions, depth: args.depth });
            break;
          case "owner":
            if (!args.file) throw new Error("query owner requires file");
            result = await queryOwner(root, args.file, queryOptions);
            break;
          case "deps":
            if (!args.module) throw new Error("query deps requires module");
            result = await queryDeps(root, args.module, queryOptions);
            break;
          case "changed":
            if (!args.since) throw new Error("query changed requires since");
            result = await queryChanged(root, args.since, queryOptions);
            break;
          default:
            throw new Error(`Unknown query kind "${args.kind}". Supported: ${QUERY_KINDS.join(", ")}`);
        }
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: "risk",
      description: descriptions.risk,
      inputSchema: {
        type: "object",
        properties: { since: { type: "string", description: "Commit or ref to diff against (defaults to working tree changes)" } },
        additionalProperties: false,
      },
      async handler(args) {
        const report = await buildRiskReport(root, { since: args.since || null, config, artifactPaths: config._agentifyPaths });
        return renderRiskReport(report);
      },
    },
    {
      name: "test_select",
      description: descriptions.test_select,
      inputSchema: {
        type: "object",
        properties: { since: { type: "string", description: "Commit or ref to diff against (defaults to working tree changes)" } },
        additionalProperties: false,
      },
      async handler(args) {
        const selection = await buildTestSelection(root, { since: args.since || null, config, artifactPaths: config._agentifyPaths });
        return renderTestSelection(selection);
      },
    },
    {
      name: "ctx_decisions",
      description: descriptions.ctx_decisions,
      inputSchema: {
        type: "object",
        properties: { topic: { type: "string", description: "Topic to look up (e.g. \"retry backoff\", \"state management\"); omit to review recorded decisions" } },
        additionalProperties: false,
      },
      async handler(args) {
        const result = await listDecisions(root, args.topic);
        return renderDecisions(result, { limit: MAX_RENDERED_DECISIONS, maxChars: MAX_RENDERED_DECISION_CHARS });
      },
    },
    {
      name: "ctx_handoff",
      description: descriptions.ctx_handoff,
      inputSchema: {
        type: "object",
        properties: { task: { type: "string", description: "Short description of the task being handed off" } },
        additionalProperties: false,
      },
      async handler(args) {
        const result = await writeHandoff(root, { task: args.task });
        const preview = result.markdown.length > HANDOFF_PREVIEW_CHARS
          ? `${result.markdown.slice(0, HANDOFF_PREVIEW_CHARS)}\n… (truncated; full handoff saved to ${result.relative_path})`
          : result.markdown;
        return `Handoff written to ${result.relative_path}:\n\n${preview}`;
      },
    },
  ];
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function handleMcpMessage(tools, message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return jsonRpcError(null, -32600, "Invalid request");
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "agentify", version: VERSION },
    });
  }

  if (typeof method === "string" && method.startsWith("notifications/")) {
    return null;
  }

  if (method === "ping") {
    return jsonRpcResult(id, {});
  }

  if (method === "tools/list") {
    return jsonRpcResult(id, {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
  }

  if (method === "tools/call") {
    const tool = tools.find((candidate) => candidate.name === params?.name);
    if (!tool) {
      return jsonRpcError(id, -32602, `Unknown tool "${params?.name}"`);
    }
    try {
      const text = await tool.handler(params?.arguments && typeof params.arguments === "object" ? params.arguments : {});
      return jsonRpcResult(id, { content: [{ type: "text", text: String(text ?? "") }] });
    } catch (error) {
      return jsonRpcResult(id, {
        content: [{ type: "text", text: error?.message || String(error) }],
        isError: true,
      });
    }
  }

  if (isNotification) {
    return null;
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

export async function runMcpServer(root, config = {}, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const tools = options.tools || buildMcpTools(root, config);

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      output.write(`${JSON.stringify(jsonRpcError(null, -32700, "Parse error"))}\n`);
      continue;
    }
    const response = await handleMcpMessage(tools, message);
    if (response) {
      output.write(`${JSON.stringify(response)}\n`);
    }
  }
}
