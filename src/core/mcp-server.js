import path from "node:path";

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import { runScan } from "./commands.js";
import { addNote, listDecisions, loadContextSnapshot, matchContext, renderContextDigest, renderDecisions, renderMatchDigest, writeHandoff } from "./ctx.js";
import { walkFiles } from "./fs.js";
import { isGitRepository, isPathIgnoredByGit } from "./git.js";
import { getIndexFreshness } from "./index-freshness.js";
import { recordInvocation } from "./invocations.js";
import { resolveAgentifyPaths } from "./project-store.js";
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

const QUERY_KINDS = ["search", "def", "refs", "callers", "impacts", "owner", "deps", "changed"];

const MCP_CACHE_HINT = { ttlMs: 300000, cacheScope: "private" };

const MCP_TOOL_INPUTS = {
  ctx_load: z.strictObject({}),
  ctx_note: z.strictObject({
    text: z.string().describe("The note to record"),
    type: z.enum(["note", "decision"]).optional().describe("Kind of note (default: note)"),
  }),
  ctx_match: z.strictObject({
    task: z.string().describe("Description of the task you are about to work on"),
  }),
  query: z.strictObject({
    kind: z.enum(QUERY_KINDS).describe("Query kind"),
    term: z.string().optional().describe("Search term (kind: search)"),
    symbol: z.string().optional().describe("Symbol name (kinds: def, refs, callers)"),
    file: z.string().optional().describe("File path (kinds: impacts, owner)"),
    module: z.string().optional().describe("Module id (kind: deps)"),
    since: z.string().optional().describe("Commit or ref (kind: changed)"),
    depth: z.number().optional().describe("Traversal depth (kind: impacts)"),
  }),
  risk: z.strictObject({
    since: z.string().optional().describe("Commit or ref to diff against (defaults to working tree changes)"),
  }),
  test_select: z.strictObject({
    since: z.string().optional().describe("Commit or ref to diff against (defaults to working tree changes)"),
  }),
  ctx_decisions: z.strictObject({
    topic: z.string().optional().describe("Topic to look up (e.g. \"retry backoff\", \"state management\"); omit to review recorded decisions"),
  }),
  ctx_handoff: z.strictObject({
    task: z.string().optional().describe("Short description of the task being handed off"),
  }),
};

function defineMcpTool(definition) {
  return {
    ...definition,
    inputSchema: z.toJSONSchema(definition.inputValidator),
  };
}

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
//
// The `query` entry in both sets describes the self-healing index contract from
// #333: the index is built automatically when missing, stale answers still come
// back with a freshness note, and only an unbuildable index asks for a manual
// `agentify scan`. Both arms were updated together so the ablation still varies
// only wording, never the behaviour each arm advertises.
export const MCP_TOOL_DESCRIPTIONS = {
  a: {
    ctx_load: "Digest of what previous agent sessions did in this repository: session summaries, notes left for future sessions, hot files, recent commands, and commands that failed and were never fixed. Call this at the start of a task to avoid rediscovering known context.",
    ctx_note: "Record a note for future agent sessions working in this repository: gotchas, open threads, or anything worth remembering. Use type \"decision\" for durable technical decisions with rationale (\"chose X over Y because Z\") — decisions are kept queryable so settled questions are not relitigated. Notes are surfaced to later sessions when relevant.",
    ctx_match: "Find context from previous sessions related to a specific task: notes, session summaries, previously-edited files, and past command failures that look relevant. Use before starting work on a described task.",
    query: "Structural queries over the repository index. Kinds: search (full-text over symbols/files), def (find a symbol definition), refs (references to a symbol), callers (callers of a symbol), impacts (files affected if a file changes), owner (module owning a file), deps (module dependencies), changed (indexed files changed since a ref). The index is built automatically when missing and answers still come back when it is stale (with an `_agentify_index` freshness note); only an unbuildable index returns an instruction to run `agentify scan`.",
    risk: "Score the blast radius of the current change (or since a git ref): risk level, impacted modules/files/symbols, and prioritized regression test commands. Use before finishing a change.",
    test_select: "Select only the test files affected by the current change (or since a git ref) using the structural index, with ready-to-run commands — instead of running the full suite.",
    ctx_decisions: "Before you propose, endorse, or start implementing a technical direction that may already be settled — an architecture, a library or dependency, a data or file format, a naming or workflow convention — call this first to check whether a prior session already decided it. Previous sessions record durable decisions with rationale (\"chose X over Y because Z\"); read them before suggesting a direction so you do not re-propose or relitigate something already decided and rejected. Pass the topic you are about to weigh in on; omit it to review the decisions already on record. Returns matching decisions with their rationale, or a clear message when none are on record.",
    ctx_handoff: "Call this when you are wrapping up a long or multi-step task, or ending a session with work still in flight, to persist a durable handoff summary before the context is lost. It captures recent activity, decisions on record, hot files, and commands that failed and were not fixed, and writes them to a Markdown file under the context store. Returns the saved path and a preview of the contents so you can point the next session (or a teammate) at the file.",
  },
  b: {
    ctx_load: "When you are starting a task in this repository and have not yet loaded prior context, call this first — before reading files or planning — to avoid rediscovering what earlier sessions already established. Returns a digest of prior session summaries, notes left for future sessions, hot files, recent commands, and commands that failed and were never fixed.",
    ctx_note: "When you hit a gotcha, leave an open thread, or make a durable technical decision that a future session would waste time rediscovering or relitigating, call this to record it before you move on. Use type \"decision\" for a settled choice with rationale (\"chose X over Y because Z\"); use the default note type for everything else. Recorded items are surfaced to later sessions when relevant.",
    ctx_match: "When you are about to start work described by a task or ticket, call this first with that description to pull only the prior-session context that matches it — related notes, session summaries, previously-edited files, and past command failures — before you begin exploring.",
    query: "When you need to locate or reason about code before editing it — where a symbol is defined, who references or calls it, which files a change impacts, which module owns a file, a module's dependencies, or what changed since a ref — call this instead of guessing or grepping by hand. Kinds: search, def, refs, callers, impacts, owner, deps, changed. The index is built automatically when missing and stale answers still come back with an `_agentify_index` freshness note, so call it without scanning first; only an unbuildable index asks you to run `agentify scan`.",
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

// Required argument for each query kind. Validated before any index recovery so
// a malformed call fails fast without triggering an auto-scan.
const QUERY_REQUIRED_ARG = {
  search: "term",
  def: "symbol",
  refs: "symbol",
  callers: "symbol",
  impacts: "file",
  owner: "file",
  deps: "module",
  changed: "since",
};

// Auto-scan cost scales with the number of files parsed. Above this bound the
// query handler returns an instruction to run `agentify scan` out of band
// rather than blocking an agent turn on a cold index build. See the recorded
// ctx decision for the rationale behind the threshold.
const AUTO_SCAN_FILE_LIMIT = 2000;

// Best-effort wall-clock ceiling for an in-tool-call auto-scan. Repo size is
// bounded up front by AUTO_SCAN_FILE_LIMIT; this timeout additionally caps the
// I/O-bound and multi-file cases (slow filesystem, many files) because the
// scan awaits a read per file, giving the timer a chance to fire between files.
// It cannot preempt synchronous work inside a single file (TypeScript parsing
// of one pathological multi-megabyte file blocks the event loop) — that is an
// inherent single-process limitation; the file-count bound is the primary guard
// and moving indexing to a worker is out of scope for this change. On timeout
// the build is left to finish in the background (behind the single-writer lock)
// and the caller is told to retry shortly.
const AUTO_SCAN_TIMEOUT_MS = 10000;

const AUTO_SCAN_TIMED_OUT = Symbol("auto-scan-timed-out");

// The freshness check runs git commands and hashes dirty files, which a slow
// filesystem or a very large dirty file could stall on. Bound it so the
// freshness probe never blocks a query: on timeout the query runs directly (the
// fast path preserved from before #333), and a genuinely missing/unreadable
// index is still recovered by the handler's catch-and-rebuild path.
const FRESHNESS_TIMEOUT_MS = 2000;

function timeoutAfter(ms, value) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

// A reporter that swallows all output. runScan writes progress to stdout via a
// live reporter, which would corrupt the MCP JSON-RPC stream when a scan is
// triggered from inside a tool call.
const SILENT_REPORTER = {
  log() {},
  percent() {},
  json() {},
  appendSection() {},
  setCommand() {},
  setScan() {},
  setDoc() {},
  setValidation() {},
  setTests() {},
  setExecution() {},
  async finalize() { return {}; },
  clear() {},
};

function isRecoverableIndexError(error) {
  if (!error) {
    return false;
  }
  if (error.code === "AGENTIFY_INDEX_DATABASE_INVALID") {
    return true;
  }
  // Covers a missing/invalid database, a schema mismatch, and a structurally
  // incomplete index (e.g. a dropped search/FTS table or column, or a malformed
  // file) — all of which a forced rebuild repairs.
  return /missing index database|invalid index database|schema version|not supported|not a database|schema_version metadata|no such table|no such column|malformed|file is encrypted/i
    .test(String(error.message || error));
}

async function countRepoFiles(root) {
  try {
    return (await walkFiles(root, { respectIgnore: true })).length;
  } catch {
    return null;
  }
}

// True when auto-building the index would create git pollution. A read-style
// query must never leave an untracked artifact or modify a tracked file to
// initialize the repo, so in that case we return an instruction instead. Every
// scan writes under the in-repo runtime dir (.agentify/: the legacy lock,
// runtime dirs, and — in local mode — the index and its metadata), so the whole
// directory's ignore status is the deciding factor regardless of where the
// index database itself lives. Fails closed: inside a git repo, anything but a
// definite "ignored" is treated as unsafe.
async function autoScanWouldDirtyGit(root, artifactPaths) {
  const runtimeRoot = artifactPaths?.runtimeRoot;
  if (!runtimeRoot) {
    return false;
  }
  const rel = path.relative(root, runtimeRoot);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    // Runtime dir lives outside the repository — nothing to dirty.
    return false;
  }
  if (!(await isGitRepository(root))) {
    // No git working tree — nothing to dirty.
    return false;
  }
  // Probe with a trailing slash so the directory-only ignore rule (`.agentify/`)
  // matches even before the directory exists.
  const dirProbe = `${rel.split(path.sep).join("/")}/`;
  return (await isPathIgnoredByGit(root, dirProbe)) !== true;
}

// Build the index in-place, respecting the single-writer lock and a repo-size
// bound. Never throws. Returns { ok: true } once a scan completes, or
// { ok: false, instruction } with a single actionable message otherwise.
// `state.scanStarted` is set once the scan is actually launched so the caller's
// timeout can report accurately whether a background build is in progress.
async function buildIndexNow(root, config, artifactPaths, state) {
  // Dry-run and ghost runs never write a queryable index at the paths this tool
  // reads from, so auto-scanning would not help — ask for an explicit scan.
  if (config.dryRun || config.ghost || config.ghostMode) {
    return {
      ok: false,
      instruction: "No usable repository index found. Run `agentify scan` to build it, then retry this query.",
    };
  }

  // Refuse to auto-build where doing so would dirty git (an uninitialized repo
  // whose .agentify/ is not yet ignored). Initializing is a write the user
  // should opt into via `agentify scan`, not a side effect of a read.
  if (await autoScanWouldDirtyGit(root, artifactPaths)) {
    return {
      ok: false,
      instruction: "No repository index found, and this repository is not initialized for Agentify (its index location is not gitignored), so building it here would modify tracked files. Run `agentify scan` once to initialize and index, then retry this query.",
    };
  }

  const fileCount = await countRepoFiles(root);
  // If the caller already timed out during this preflight, do not start a scan
  // it was told would not run.
  if (state.aborted) {
    return { ok: false, instruction: "Auto-index aborted after timeout." };
  }
  if (fileCount !== null && fileCount > AUTO_SCAN_FILE_LIMIT) {
    return {
      ok: false,
      instruction: `No repository index found. This repository is large (${fileCount} files, above the ${AUTO_SCAN_FILE_LIMIT}-file auto-index limit), so it was not indexed automatically to keep this tool responsive. Run \`agentify scan\` once, then retry this query.`,
    };
  }

  // runScan reports lock contention by setting process.exitCode; capture and
  // restore it so a blocked auto-scan never leaks a failure code into the
  // long-lived MCP server (or a test runner exercising the handler directly).
  const previousExitCode = process.exitCode;
  let result;
  try {
    if (state.aborted) {
      return { ok: false, instruction: "Auto-index aborted after timeout." };
    }
    state.scanStarted = true;
    result = await runScan(root, config, {
      reporter: SILENT_REPORTER,
      skipOutput: true,
      skipFinalize: true,
      indexOnly: true,
      // Force a full rebuild and reset the derived database: the auto-heal only
      // fires when the index is missing or unusable, so a warm-reuse shortcut
      // must not keep a broken index in place, and a from-scratch file is the
      // only way to repair a structurally incomplete one (e.g. a dropped table
      // or column that CREATE TABLE IF NOT EXISTS cannot restore).
      force: true,
      reset: true,
      commandName: "query-auto-scan",
    });
  } catch (error) {
    return {
      ok: false,
      instruction: `Repository index could not be built automatically: ${error?.message || String(error)}. Run \`agentify scan\` to build it, then retry this query.`,
    };
  }

  if (result?.status === "blocked") {
    process.exitCode = previousExitCode;
    return {
      ok: false,
      instruction: `Repository index is unavailable and another indexing run is in progress (${result.message || "index lock held"}), so it was not built automatically. Wait for it to finish or run \`agentify scan\`, then retry this query.`,
    };
  }

  return { ok: true };
}

// Wrap buildIndexNow with the wall-clock ceiling. If the scan itself outruns the
// budget it keeps running in the background (guarded by the index-refresh lock)
// while the caller is told to retry shortly; if the pre-scan work (e.g. counting
// files on a slow filesystem) outruns it, the caller is told to scan manually.
// Either way an agent turn is never blocked indefinitely.
async function tryBuildIndex(root, config, artifactPaths) {
  const state = { scanStarted: false, aborted: false };
  const build = buildIndexNow(root, config, artifactPaths, state);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(AUTO_SCAN_TIMED_OUT), AUTO_SCAN_TIMEOUT_MS);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });

  const outcome = await Promise.race([build, timeout]);
  clearTimeout(timer);
  if (outcome === AUTO_SCAN_TIMED_OUT) {
    // Signal the build to stop before it launches a scan (if it has not already
    // started one) and detach it, swallowing any late rejection so it cannot
    // become an unhandled rejection in the long-lived server.
    state.aborted = true;
    build.catch(() => {});
    if (state.scanStarted) {
      return {
        ok: false,
        instruction: `Repository index is being built but is taking longer than ${AUTO_SCAN_TIMEOUT_MS}ms, so it is continuing in the background — retry this query shortly, or run \`agentify scan\`.`,
      };
    }
    return {
      ok: false,
      instruction: `Preparing to index this repository is taking longer than ${AUTO_SCAN_TIMEOUT_MS}ms. Run \`agentify scan\` once to build the index, then retry this query.`,
    };
  }
  return outcome;
}

function describeStaleIndex(freshness) {
  const changedCount = Array.isArray(freshness.changed_files) ? freshness.changed_files.length : 0;
  const reason = freshness.stale_reason || "unknown";
  const detail = changedCount > 0
    ? `${changedCount} file(s) changed since it was last built`
    : "its metadata no longer matches the working tree";
  return {
    status: "stale",
    stale_reason: reason,
    changed_files: changedCount,
    note: `Index is stale (${reason}): ${detail}. Results may be out of date — run \`agentify scan\` to refresh.`,
  };
}

export function buildMcpTools(root, config = {}) {
  const queryOptions = { config, artifactPaths: config._agentifyPaths };
  const descriptions = MCP_TOOL_DESCRIPTIONS[resolveDescriptionSet(config)];
  // Guards against piling up freshness probes: getIndexFreshness cannot be
  // cancelled, so if one outlives its timeout we skip the probe on subsequent
  // queries (falling back to the direct fast path) until it settles, rather
  // than launching another concurrent whole-dirty-tree scan.
  let freshnessProbeInFlight = false;
  async function probeFreshness(artifactPaths) {
    if (freshnessProbeInFlight) {
      return null;
    }
    freshnessProbeInFlight = true;
    const probe = getIndexFreshness(root, artifactPaths)
      .catch(() => null)
      .finally(() => { freshnessProbeInFlight = false; });
    return Promise.race([probe, timeoutAfter(FRESHNESS_TIMEOUT_MS, null)]);
  }

  return [
    defineMcpTool({
      name: "ctx_load",
      description: descriptions.ctx_load,
      inputValidator: MCP_TOOL_INPUTS.ctx_load,
      async handler() {
        const snapshot = await loadContextSnapshot(root);
        return renderContextDigest(snapshot) || "No tracked context yet.";
      },
    }),
    defineMcpTool({
      name: "ctx_note",
      description: descriptions.ctx_note,
      inputValidator: MCP_TOOL_INPUTS.ctx_note,
      async handler(args) {
        const result = await addNote(root, args.text, { type: args.type });
        return `${result.record.type === "decision" ? "Decision recorded" : "Noted"}: ${result.record.note}`;
      },
    }),
    defineMcpTool({
      name: "ctx_match",
      description: descriptions.ctx_match,
      inputValidator: MCP_TOOL_INPUTS.ctx_match,
      async handler(args) {
        const matches = await matchContext(root, args.task, { recordInjection: false, config });
        return renderMatchDigest(matches) || "No related context found.";
      },
    }),
    defineMcpTool({
      name: "query",
      description: descriptions.query,
      inputValidator: MCP_TOOL_INPUTS.query,
      async handler(args) {
        // Validate the request before any recovery work so a malformed call
        // fails fast and never triggers an auto-scan.
        if (!QUERY_KINDS.includes(args.kind)) {
          throw new Error(`Unknown query kind "${args.kind}". Supported: ${QUERY_KINDS.join(", ")}`);
        }
        const requiredArg = QUERY_REQUIRED_ARG[args.kind];
        if (requiredArg && !args[requiredArg]) {
          throw new Error(`query ${args.kind} requires ${requiredArg}`);
        }

        const artifactPaths = queryOptions.artifactPaths || await resolveAgentifyPaths(root, config);
        const opts = { ...queryOptions, artifactPaths };

        function dispatch() {
          switch (args.kind) {
            case "search":
              return querySearch(root, args.term, opts);
            case "def":
              return queryDef(root, args.symbol, opts);
            case "refs":
              return queryRefs(root, args.symbol, opts);
            case "callers":
              return queryCallers(root, args.symbol, opts);
            case "impacts":
              return queryImpacts(root, args.file, { ...opts, depth: args.depth });
            case "owner":
              return queryOwner(root, args.file, opts);
            case "deps":
              return queryDeps(root, args.module, opts);
            case "changed":
              return queryChanged(root, args.since, opts);
            default:
              throw new Error(`Unknown query kind "${args.kind}". Supported: ${QUERY_KINDS.join(", ")}`);
          }
        }

        const rebuiltNote = { status: "rebuilt", note: "Index was rebuilt automatically for this query." };

        // Consult index freshness so the tool self-heals instead of erroring
        // out on a missing or stale index (#333). A failure — or a slow probe —
        // is non-fatal: fall through and let the query (and its catch) handle it.
        let indexNote = null;
        const freshness = await probeFreshness(artifactPaths);
        if (freshness?.index_status === "missing") {
          const built = await tryBuildIndex(root, config, artifactPaths);
          if (!built.ok) {
            return built.instruction;
          }
          indexNote = rebuiltNote;
        } else if (freshness?.index_status === "stale") {
          indexNote = describeStaleIndex(freshness);
        }

        let result;
        try {
          result = await dispatch();
        } catch (error) {
          // The index is present-but-unreadable (e.g. a schema mismatch after an
          // Agentify upgrade, or a corrupt database). Rebuild once and retry so
          // the agent still gets an answer instead of a raw exception.
          if (!isRecoverableIndexError(error)) {
            throw error;
          }
          const built = await tryBuildIndex(root, config, artifactPaths);
          if (!built.ok) {
            return built.instruction;
          }
          try {
            result = await dispatch();
          } catch (retryError) {
            return `Repository index could not be made queryable: ${retryError?.message || String(retryError)}. Run \`agentify scan\` to rebuild it, then retry this query.`;
          }
          indexNote = rebuiltNote;
        }

        if (indexNote && result && typeof result === "object") {
          result._agentify_index = indexNote;
        }
        return JSON.stringify(result, null, 2);
      },
    }),
    defineMcpTool({
      name: "risk",
      description: descriptions.risk,
      inputValidator: MCP_TOOL_INPUTS.risk,
      async handler(args) {
        const report = await buildRiskReport(root, { since: args.since || null, config, artifactPaths: config._agentifyPaths });
        return renderRiskReport(report);
      },
    }),
    defineMcpTool({
      name: "test_select",
      description: descriptions.test_select,
      inputValidator: MCP_TOOL_INPUTS.test_select,
      async handler(args) {
        const selection = await buildTestSelection(root, { since: args.since || null, config, artifactPaths: config._agentifyPaths });
        return renderTestSelection(selection);
      },
    }),
    defineMcpTool({
      name: "ctx_decisions",
      description: descriptions.ctx_decisions,
      inputValidator: MCP_TOOL_INPUTS.ctx_decisions,
      async handler(args) {
        const result = await listDecisions(root, args.topic);
        return renderDecisions(result, { limit: MAX_RENDERED_DECISIONS, maxChars: MAX_RENDERED_DECISION_CHARS });
      },
    }),
    defineMcpTool({
      name: "ctx_handoff",
      description: descriptions.ctx_handoff,
      inputValidator: MCP_TOOL_INPUTS.ctx_handoff,
      async handler(args) {
        const result = await writeHandoff(root, { task: args.task });
        const preview = result.markdown.length > HANDOFF_PREVIEW_CHARS
          ? `${result.markdown.slice(0, HANDOFF_PREVIEW_CHARS)}\n… (truncated; full handoff saved to ${result.relative_path})`
          : result.markdown;
        return `Handoff written to ${result.relative_path}:\n\n${preview}`;
      },
    }),
  ];
}

export function buildMcpServer(root, config = {}, options = {}) {
  const tools = options.tools || buildMcpTools(root, config);
  const server = new McpServer(
    { name: "agentify", version: VERSION },
    {
      cacheHints: {
        "server/discover": MCP_CACHE_HINT,
        "tools/list": MCP_CACHE_HINT,
      },
    },
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputValidator,
      },
      (args) => invokeMcpTool(tool, args, {
        recordInvocation: options.recordInvocation,
        invocationOptions: options.invocationOptions,
      }),
    );
  }

  return server;
}

export async function invokeMcpTool(tool, args = {}, options = {}) {
  const recorder = options.recordInvocation || recordInvocation;
  try {
    await recorder(
      { command: tool.name, source: "mcp" },
      options.invocationOptions,
    );
  } catch {
    // Usage telemetry is fail-open and must never affect the tool result.
  }

  try {
    const text = await tool.handler(args);
    return { content: [{ type: "text", text: String(text ?? "") }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: error?.message || String(error) }],
      isError: true,
    };
  }
}

export function runMcpServer(root, config = {}, options = {}) {
  const transport = options.transport || (
    options.input || options.output
      ? new StdioServerTransport(options.input || process.stdin, options.output || process.stdout)
      : undefined
  );
  return serveStdio(
    () => buildMcpServer(root, config, {
      tools: options.tools,
      recordInvocation: options.recordInvocation,
      invocationOptions: options.invocationOptions,
    }),
    {
      ...(transport ? { transport } : {}),
      onerror: options.onerror,
    },
  );
}
