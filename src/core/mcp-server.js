import path from "node:path";
import readline from "node:readline";

import { runScan } from "./commands.js";
import { addNote, loadContextSnapshot, matchContext, renderContextDigest, renderMatchDigest } from "./ctx.js";
import { walkFiles } from "./fs.js";
import { isGitRepository, isPathIgnoredByGit } from "./git.js";
import { getIndexFreshness } from "./index-freshness.js";
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

const PROTOCOL_VERSION = "2025-06-18";

const QUERY_KINDS = ["search", "def", "refs", "callers", "impacts", "owner", "deps", "changed"];

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
    {
      name: "ctx_load",
      description: "Digest of what previous agent sessions did in this repository: session summaries, notes left for future sessions, hot files, recent commands, and commands that failed and were never fixed. Call this at the start of a task to avoid rediscovering known context.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async handler() {
        const snapshot = await loadContextSnapshot(root);
        return renderContextDigest(snapshot) || "No tracked context yet.";
      },
    },
    {
      name: "ctx_note",
      description: "Record a note for future agent sessions working in this repository: gotchas, open threads, or anything worth remembering. Use type \"decision\" for durable technical decisions with rationale (\"chose X over Y because Z\") — decisions are kept queryable so settled questions are not relitigated. Notes are surfaced to later sessions when relevant.",
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
      description: "Find context from previous sessions related to a specific task: notes, session summaries, previously-edited files, and past command failures that look relevant. Use before starting work on a described task.",
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
      description: "Structural queries over the repository index. Kinds: search (full-text over symbols/files), def (find a symbol definition), refs (references to a symbol), callers (callers of a symbol), impacts (files affected if a file changes), owner (module owning a file), deps (module dependencies), changed (indexed files changed since a ref). The index is built automatically when missing and answers still come back when it is stale (with an `_agentify_index` freshness note); only an unbuildable index returns an instruction to run `agentify scan`.",
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
    },
    {
      name: "risk",
      description: "Score the blast radius of the current change (or since a git ref): risk level, impacted modules/files/symbols, and prioritized regression test commands. Use before finishing a change.",
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
      description: "Select only the test files affected by the current change (or since a git ref) using the structural index, with ready-to-run commands — instead of running the full suite.",
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
