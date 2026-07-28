// ACP session-event capture (#337).
//
// Layered on top of the #335 byte-relay proxy WITHOUT weakening its
// byte-identity guarantee, exactly like #336's injector. Capture is
// OBSERVATION-ONLY: every tap Transform forwards each chunk as its original raw
// bytes and rewrites NOTHING, in either direction. The proxy's golden
// transcripts and byte-identity tests therefore hold unchanged whether capture
// is on or off — capture cannot alter a single byte on the wire.
//
// What it extracts, from a *copy* of the parsed stream:
//   - file edits and executed commands, from the agent's `session/update`
//     tool-call notifications (downstream -> client);
//   - session outcomes, from `session/prompt` results (downstream -> client).
// These are written through the SAME context store the hooks path uses
// (ctx.js `recordCapturedEvent` -> the shared events.jsonl schema), so there is
// no second storage format. Redaction and pause are applied by that writer
// before anything is persisted.

import { Transform } from "node:stream";

import { getProviderDefinition } from "../provider-registry.js";
import { extractTopLevelRawId } from "./inject.js";

export const ACP_CAPTURE_MODES = ["off", "auto", "all", "compare"];

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);
// Mirror inject.js: stop buffering/parsing a single line past this size (a
// prompt may legitimately carry a large base64 blob) and fall back to pure
// pass-through for the rest of the connection. Capture is best-effort, so
// forwarding an oversized message unchanged (and un-inspected) is the safe
// degradation.
const MAX_SCAN_BYTES = 512 * 1024;

const PROMPT_METHOD = "session/prompt";
const UPDATE_METHOD = "session/update";
const SESSION_ESTABLISHING_METHODS = new Set(["session/new", "session/load", "session/resume", "session/fork"]);
// A tool call's effect is only confirmed once it reaches a terminal status; a
// still-pending call is not a recorded effect (recording one would inflate the
// capture count with work that may never have happened).
const TERMINAL_STATUSES = new Set(["completed", "failed"]);
const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "/bin/bash", "/bin/sh", "/bin/zsh"]);
// Hard caps so a long-lived editor connection (many sessions/turns) cannot grow
// the per-connection tracking maps without bound. Oldest entries are evicted;
// an evicted-then-revived tool call would at worst be re-observed, never crash.
const MAX_TRACKED_CALLS = 2048;
const MAX_TRACKED_PROMPTS = 2048;

export function normalizeAcpCaptureMode(value, { fallback = "off" } = {}) {
  const mode = String(value ?? fallback).trim().toLowerCase();
  return ACP_CAPTURE_MODES.includes(mode) ? mode : fallback;
}

// Resolve WHETHER/HOW the proxy captures, as a static startup decision.
// Precedence mirrors resolveAcpInjectionMode: the AGENTIFY_CTX=off recursion
// guard (a delegate child must never capture) forces off > AGENTIFY_ACP_CAPTURE
// env override > context.acpCapture config > off. The transient `ctx pause`
// marker is deliberately NOT folded in here — it is re-checked per write by the
// store writer so pause/resume takes effect on a running proxy.
export function resolveAcpCaptureMode(config = {}, env = process.env) {
  if (String(env?.AGENTIFY_CTX || "").toLowerCase() === "off") {
    return "off";
  }
  const override = String(env?.AGENTIFY_ACP_CAPTURE || "").trim();
  if (override) {
    return normalizeAcpCaptureMode(override);
  }
  return normalizeAcpCaptureMode(config?.context?.acpCapture);
}

// One-writer ownership rule. Hooks and the proxy both recording the same session
// would double-count edits and commands. A provider whose CLI runs Agentify's
// own PostToolUse/SessionEnd hooks (Claude Code) already writes those events, so
// under `auto` the proxy does not write the MAIN store for that provider and
// captures the store directly only for providers with NO native hook tracking
// (e.g. Codex over ACP, which is the asymmetry #337 exists to close). `all`
// overrides this (operator asserts hooks are disabled); `compare` never touches
// the main store at all.
export function providerHasHookTracking(provider) {
  return getProviderDefinition(provider)?.hooksTrackContext === true;
}

// Decide, for a resolved capture mode + downstream provider, whether the proxy
// writes to the MAIN store, to the COMPARE log only, or nowhere.
//   - "events"  -> the shared events.jsonl (the proxy owns capture)
//   - "compare" -> a diagnostic side-log only (safe alongside hooks)
//   - "none"    -> no capture at all
export function resolveCaptureSink(mode, { provider } = {}) {
  if (mode === "off") {
    return "none";
  }
  if (mode === "compare") {
    return "compare";
  }
  if (mode === "all") {
    return "events";
  }
  // auto: for a provider with native hook tracking, divert to the diagnostic
  // side-log rather than the main store. This never double-writes the store, yet
  // — unlike dropping the events — preserves them for the fidelity report and
  // makes them recoverable if that provider's hooks turn out NOT to be installed
  // (an operator who runs such a provider without Agentify hooks should use
  // `all`). Providers with no native hooks are captured straight to the store.
  //
  // Known trade-off: Claude Code's PostToolUse hooks do not currently fire for
  // SUBAGENT tool calls, while the ACP stream carries them. Under `auto` those
  // subagent edits/commands land only in the side-log, not the main store — so
  // an operator who wants the proxy to be the authoritative writer for Claude
  // (capturing subagent activity the hooks miss) should use `all`.
  return providerHasHookTracking(provider) ? "compare" : "events";
}

// ---------------------------------------------------------------------------
// Pure extraction: ACP message -> hook-shaped payloads for ctx.js.
//
// Each returned item is `{ payload, confidence }` where `payload` is exactly the
// shape ctx.js `buildEventFromHookPayload` already understands (so its edit/cmd
// shaping, path-relativizing, command redaction, and failure detection are
// reused verbatim, not reimplemented), and `confidence` is "observed" when the
// effect is explicit in the tool call or "inferred" when it was recovered
// heuristically from an opaque wrapper (Codex shell/`custom_tool_call`).
// ---------------------------------------------------------------------------

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

// Turn an ACP command field (a string, or an argv array as Codex emits) into a
// single command string. `["bash","-lc","<script>"]` unwraps to the script;
// anything else is joined so the raw invocation is still recorded.
function commandFromRawInput(rawInput) {
  if (!rawInput || typeof rawInput !== "object") {
    return null;
  }
  const command = rawInput.command ?? rawInput.cmd;
  if (typeof command === "string" && command.trim()) {
    return command;
  }
  if (Array.isArray(command) && command.length > 0) {
    const parts = command.filter((part) => typeof part === "string");
    if (parts.length >= 3 && SHELL_WRAPPERS.has(parts[0]) && (parts[1] === "-lc" || parts[1] === "-c")) {
      return parts.slice(2).join(" ");
    }
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }
  return null;
}

// Collect the distinct file paths a tool call touched. For an explicit
// `kind: "edit"` the adapter has already asserted this is a write, so all
// path sources (locations, rawInput.*, diff blocks) are trusted. For an opaque
// wrapper (`diffOnly`) a generic `path`/location is NOT evidence of a write —
// a custom `read_file({path})` looks identical — so only a diff-content block
// (unambiguous write evidence) yields an inferred edit; everything else is a
// deliberate gap rather than a false edit that would pollute hot-file context.
function editPathsFromUpdate(update, { diffOnly = false } = {}) {
  const paths = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.trim()) {
      paths.add(value);
    }
  };
  if (Array.isArray(update.content)) {
    for (const block of update.content) {
      if (block && typeof block === "object" && block.type === "diff") {
        add(block.path);
      }
    }
  }
  if (diffOnly) {
    return [...paths];
  }
  if (Array.isArray(update.locations)) {
    for (const location of update.locations) {
      if (location && typeof location === "object") {
        add(location.path);
      }
    }
  }
  const rawInput = update.rawInput && typeof update.rawInput === "object" ? update.rawInput : null;
  if (rawInput) {
    add(rawInput.file_path);
    add(rawInput.path);
    add(rawInput.abs_path);
    add(rawInput.notebook_path);
  }
  return [...paths];
}

// Whether a tool call shows evidence it actually RAN (an exit code, or captured
// output). ACP adapters also mark a call `failed` when a permission was DENIED
// before execution — those carry no execution output. The hooks path only ever
// sees commands that ran (PostToolUse fires post-approval), so a `failed` call
// with no execution evidence is treated as never-run and not recorded, keeping
// parity and keeping denials out of command history.
function hasExecutionEvidence(entry) {
  const out = entry.rawOutput;
  if (out === null || out === undefined) {
    return false;
  }
  // Adapters shape rawOutput differently: the Claude adapter forwards the tool's
  // content directly, which may be a (non-empty) string or array; others use an
  // object with exit code / stream fields. Any non-empty output is evidence the
  // command actually ran (a permission denial carries none).
  if (typeof out === "string") {
    return out.trim().length > 0;
  }
  if (Array.isArray(out)) {
    return out.length > 0;
  }
  if (typeof out === "object") {
    // A real exit code proves it ran. NOTE: a NULL exit code is NOT evidence —
    // the Codex adapter emits `{ formatted_output: "", exit_code: null }` for a
    // DECLINED command, which must not be counted as executed.
    if ([out.exit_code, out.exitCode, out.code].some((value) => typeof value === "number")) {
      return true;
    }
    // Any non-empty captured output proves it ran.
    return [out.stdout, out.stderr, out.output, out.error, out.formatted_output]
      .some((value) => typeof value === "string" && value.trim());
  }
  return false;
}

function failureResponseFromUpdate(update) {
  if (update.status !== "failed") {
    return undefined;
  }
  const response = { success: false };
  const out = update.rawOutput;
  if (typeof out === "string") {
    if (out.trim()) response.stderr = out;
    return response;
  }
  const rawOutput = out && typeof out === "object" && !Array.isArray(out) ? out : {};
  const exitCode = [rawOutput.exit_code, rawOutput.exitCode, rawOutput.code].find((value) => typeof value === "number");
  if (typeof exitCode === "number") {
    response.exit_code = exitCode;
  }
  const snippet = firstString(rawOutput.stderr, rawOutput.error, rawOutput.output, rawOutput.stdout);
  if (snippet) {
    response.stderr = snippet;
  }
  return response;
}

// Kinds that never mutate the filesystem: a location on one of these describes
// a file being READ/searched/fetched, not written, so it must never become an
// edit event. `delete`/`move` do change the tree but are not content edits (and
// the hooks path does not track them), so they are left out too — capturing
// them as "edits" would misrepresent what happened.
const NON_EDIT_KINDS = new Set(["read", "search", "fetch", "think", "switch_mode", "delete", "move"]);

// Build hook-shaped payload items from a merged tool-call view. `kind`, the
// available fields, and the terminal `status` decide edit vs command and
// observed vs inferred. An edit is only recorded on a `completed` status — a
// `failed` write may never have touched the filesystem, so it is not a
// confirmed edit; a `failed` command, by contrast, still ran and is recorded
// with its failure (parity with the hooks path, which tracks failed Bash runs).
export function payloadsFromToolCall(entry, { sessionId } = {}) {
  const items = [];
  const kind = typeof entry.kind === "string" ? entry.kind : "";
  const completed = entry.status === "completed";
  const base = { hook_event_name: "PostToolUse", session_id: sessionId || entry.sessionId || "" };

  // A call flagged non-execution (rejected/interrupted) never ran, whatever
  // output it forwarded. Otherwise a command ran when it completed, or when a
  // failed call carries execution evidence (a denied/never-run call has neither).
  const ran = !entry.nonExecution && (completed || hasExecutionEvidence(entry));
  const command = commandFromRawInput(entry.rawInput);
  const pushEdit = (file, confidence) => {
    if (completed && !entry.nonExecution) {
      items.push({ payload: { ...base, tool_name: "Write", tool_input: { file_path: file } }, confidence });
    }
  };
  const pushCommand = (cmd, confidence) => {
    if (!ran) {
      return;
    }
    const failure = failureResponseFromUpdate(entry);
    items.push({
      payload: { ...base, tool_name: "Bash", tool_input: { command: cmd }, ...(failure ? { tool_response: failure } : {}) },
      confidence,
    });
  };

  // Commands: a call carrying a REAL shell command (from rawInput.command) is
  // recorded whatever ACP kind the adapter assigned it — `execute`, or a
  // `read`/`search` an adapter recognized as a shell `cat`/`rg`/`ls` yet still
  // carries the command for. This matches the hooks path, which records every
  // Bash invocation. A title-only call with no command field is NEVER fabricated
  // into a command (an MCP tool "mcp.github.get_issue" must not become one).
  //
  // Known fidelity gap: the current Codex adapter maps recognized read/search/
  // listFiles executions to those kinds WITHOUT a `command` field, so those
  // shell reads (`cat`, `rg`, `ls`) cannot be recovered here and go uncaptured —
  // unlike the hooks path, which sees the raw Bash. Reconstructing a command from
  // the display title would be fabrication, so this is left as an honest gap
  // (surfaced in the fidelity report), not a guessed command.
  if (command) {
    pushCommand(command, kind === "execute" ? "observed" : "inferred");
  }

  // Edits.
  if (kind === "edit") {
    // The adapter asserted a write, so all path sources are trusted.
    // Known limitation: an adapter that reports deletes/moves as kind "edit"
    // (Codex encodes the distinction inside diff metadata whose shape is not
    // standardized) will have those paths recorded as edits, a minor
    // over-capture versus the hooks path — noted rather than guessed at.
    for (const file of editPathsFromUpdate(entry)) {
      pushEdit(file, "observed");
    }
  } else if (!NON_EDIT_KINDS.has(kind)) {
    // Opaque wrapper / custom_tool_call (kind "other" or unknown): only a diff
    // block is strong enough write evidence to infer an edit; a bare path could
    // be a read, so it is a deliberate gap rather than a false edit. Read-only
    // kinds (read/search/fetch/…) never infer an edit at all.
    for (const file of editPathsFromUpdate(entry, { diffOnly: true })) {
      pushEdit(file, "inferred");
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Stateful capture engine. Merges a tool call across its `tool_call` /
// `tool_call_update` notifications (keyed by toolCallId) and emits its effect
// exactly ONCE, when it reaches a terminal status — so the pending+completed
// pair a single edit produces is never double-counted. It also correlates
// `session/prompt` request ids (client -> downstream) to their result's
// stopReason (downstream -> client) to record a session outcome.
// ---------------------------------------------------------------------------

export function createCaptureEngine({ record, onEvent, isSameWorkspace } = {}) {
  const sink = typeof record === "function" ? record : async () => {};
  const verifyWorkspace = typeof isSameWorkspace === "function" ? isSameWorkspace : () => true;
  // A tool-call id is unique only WITHIN a session, so state is keyed by
  // sessionId + toolCallId; two sessions on one connection may reuse "tc1".
  const toolCalls = new Map();
  // promptId -> sessionId, to correlate a prompt result (which carries no
  // sessionId) back to its session for the outcome. sessionId -> last stopReason,
  // so a multi-turn session records ONE outcome (its final turn), not one per
  // turn — matching the hooks' single lifecycle end.
  const promptSessions = new Map();
  const sessionOutcomes = new Map();
  // Pending session/close request id -> sessionId, so an outcome is committed
  // only after the close SUCCEEDS (a close that errors leaves the session live).
  const closeRequests = new Map();
  let anonCounter = 0;
  let workspaceMismatch = false;
  // Serialize writes off the stream so concurrent tool calls never interleave
  // the store's read-modify-write, and the stream is never blocked on a write.
  let chain = Promise.resolve();

  const enqueue = (items) => {
    if (!items || items.length === 0) {
      return;
    }
    chain = chain.then(async () => {
      for (const item of items) {
        try {
          const written = await sink(item.payload, { confidence: item.confidence });
          if (written && typeof onEvent === "function") {
            try { onEvent(written); } catch { /* observers must not break capture */ }
          }
        } catch {
          // Capture must never break the stream or the proxy.
        }
      }
    });
  };

  // Bound a Map to its cap by evicting oldest-inserted entries (Map preserves
  // insertion order), so per-connection state can never grow without limit.
  const capMap = (map, max) => {
    while (map.size > max) {
      map.delete(map.keys().next().value);
    }
  };

  const mergeUpdate = (update, sessionId) => {
    const id = firstString(update.toolCallId, update.tool_call_id);
    if (!id && !("kind" in update)) {
      return;
    }
    const key = id ? `${sessionId || ""}::${id}` : `anon:${anonCounter += 1}`;
    const entry = toolCalls.get(key) || { emitted: false };
    // A tombstone (emitted with heavy fields dropped) must not resurrect: a late
    // duplicate update for an already-recorded call is ignored.
    if (entry.emitted) {
      return;
    }
    if (sessionId) entry.sessionId = sessionId;
    // ACP update semantics: an update carries the fields being CHANGED — a field
    // present with a value sets/replaces it, a field present as null clears it,
    // an absent field is left untouched. So `locations: null` drops a stale path
    // and a re-sent `rawInput` REPLACES (not deep-merges) the previous one.
    // A rejected/interrupted call still forwards its tool-result content as
    // rawOutput, but it never executed. Adapters flag this with a
    // `nonExecutionKind` (top-level or under _meta); once seen it sticks, so
    // such a call is never recorded as an executed command/edit.
    if (update.nonExecutionKind != null || update._meta?.nonExecutionKind != null) {
      entry.nonExecution = true;
    }
    if ("kind" in update) entry.kind = typeof update.kind === "string" ? update.kind : undefined;
    if ("title" in update) entry.title = typeof update.title === "string" ? update.title : undefined;
    if ("status" in update && typeof update.status === "string") entry.status = update.status;
    if ("locations" in update) entry.locations = Array.isArray(update.locations) ? update.locations : undefined;
    if ("rawInput" in update) {
      entry.rawInput = update.rawInput && typeof update.rawInput === "object" ? update.rawInput : undefined;
    }
    if ("rawOutput" in update) {
      entry.rawOutput = update.rawOutput === null || update.rawOutput === undefined ? undefined : update.rawOutput;
    }
    if ("content" in update) entry.content = Array.isArray(update.content) ? update.content : undefined;
    toolCalls.set(key, entry);
    if (TERMINAL_STATUSES.has(entry.status)) {
      enqueue(payloadsFromToolCall(entry, { sessionId: entry.sessionId }));
      // Retain only a lightweight tombstone: drop the diff/output/input payloads
      // so a completed call cannot pin large buffers for the connection's life.
      toolCalls.set(key, { emitted: true });
    }
    capMap(toolCalls, MAX_TRACKED_CALLS);
  };

  // Emit (and clear) the recorded outcome for one session — its final observed
  // stopReason — so a session that closes mid-connection is persisted promptly
  // and a later resume of the same id starts a fresh outcome instead of
  // overwriting the old one.
  const emitOutcome = (sessionKey) => {
    if (!sessionOutcomes.has(sessionKey)) {
      return;
    }
    const reason = sessionOutcomes.get(sessionKey);
    sessionOutcomes.delete(sessionKey);
    enqueue([{
      payload: { hook_event_name: "SessionEnd", reason, session_id: sessionKey },
      confidence: "observed",
    }]);
  };

  // A session established (new/load/resume/fork) whose cwd — or any of its
  // additional workspace roots — is outside the launch root disables capture
  // connection-wide (privacy: never record another repo's activity here).
  //
  // Known limitation: verifyWorkspace (and the ctx.js path-escape backstop) are
  // LEXICAL — a symlink inside the repo that points outside is not resolved, so
  // a session rooted at `<repo>/linked-dir` could still record external paths.
  // Resolving realpath on every path in the byte-hot path was judged not worth
  // the async cost for this threat (the #336 injector shares the same lexical
  // posture); the primary cross-repo case — a long-lived proxy reused across
  // real, separate repositories — is covered.
  const establishesOutsideRoot = (params) => {
    if (!params || typeof params !== "object") {
      return false;
    }
    if (typeof params.cwd === "string" && !verifyWorkspace(params.cwd)) {
      return true;
    }
    const extra = params.additionalDirectories || params.additional_directories;
    if (Array.isArray(extra)) {
      for (const entry of extra) {
        const dir = typeof entry === "string" ? entry : (entry && typeof entry === "object" ? entry.path : null);
        if (typeof dir === "string" && !verifyWorkspace(dir)) {
          return true;
        }
      }
    }
    return false;
  };

    // Correlate a request to its response by the EXACT raw id text (the tap
    // supplies it), so a JSON-RPC id beyond 2^53 — which JSON.parse would round,
    // collapsing two distinct concurrent ids into one — never misattributes an
    // outcome. Falls back to the parsed id only when no raw id was supplied
    // (direct unit calls with small, exactly-representable ids).
    //
    // Known limitation: if the DOWNSTREAM adapter itself parses and reserializes
    // an id (a JS adapter will round a >2^53 integer in its response), the
    // request and response raw texts no longer match and the outcome degrades to
    // an "unknown" session id. This is outside the proxy's control (the adapter
    // corrupts its own correlation) and never affects the wire or edit/command
    // capture — only which session a `session_end` is attributed to. Real ACP
    // ids from editors are small integers or strings, where this does not arise.
    const idKeyOf = (message, rawId) => {
      if (typeof rawId === "string" && rawId.length > 0) {
        return rawId;
      }
      return message.id !== undefined && message.id !== null ? JSON.stringify(message.id) : "";
    };

  return {
    // client -> downstream: watch session establishment (workspace privacy guard,
    // mirroring the injector) and remember prompt ids for outcome correlation.
    // Never extracts edits/commands (prompt CONTENT is deliberately not stored).
    observeClientToDownstream(message, rawId) {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return;
      }
      if (SESSION_ESTABLISHING_METHODS.has(message.method) && establishesOutsideRoot(message.params)) {
        workspaceMismatch = true;
      }
      if (message.method === PROMPT_METHOD && message.id !== undefined && message.id !== null) {
        const sessionId = firstString(message.params?.sessionId);
        promptSessions.set(idKeyOf(message, rawId), sessionId || "");
        capMap(promptSessions, MAX_TRACKED_PROMPTS);
      }
      // A client-initiated session close ends that session's lifecycle. Commit
      // its outcome only once the close SUCCEEDS: if the request carries an id,
      // defer to its response; a close notification (no id) has no response to
      // wait for, so persist immediately.
      if (message.method === "session/close") {
        const sessionId = firstString(message.params?.sessionId) || "";
        if (message.id !== undefined && message.id !== null) {
          closeRequests.set(idKeyOf(message, rawId), sessionId);
          capMap(closeRequests, MAX_TRACKED_PROMPTS);
        } else {
          emitOutcome(sessionId);
        }
      }
    },
    // downstream -> client: tool-call notifications carry the effects; prompt
    // results carry the session outcome.
    observeDownstreamToClient(message, rawId) {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return;
      }
      // A session that escaped the launch root disables capture connection-wide
      // (privacy: never write another repo's activity into this repo's store).
      if (workspaceMismatch) {
        return;
      }
      if (message.method === UPDATE_METHOD) {
        const update = message.params?.update;
        if (!update || typeof update !== "object") {
          return;
        }
        const kind = firstString(update.sessionUpdate, update.session_update);
        if (kind === "tool_call" || kind === "tool_call_update") {
          mergeUpdate(update, firstString(message.params?.sessionId));
        }
        return;
      }
      // The response to a pending session/close: commit the deferred outcome
      // only on success; drop it (no outcome) if the close errored.
      if (message.method === undefined && message.id !== undefined && message.id !== null) {
        const idKey = idKeyOf(message, rawId);
        if (closeRequests.has(idKey)) {
          const sessionId = closeRequests.get(idKey);
          closeRequests.delete(idKey);
          if ("result" in message) {
            emitOutcome(sessionId);
          }
          return;
        }
      }
      // A JSON-RPC response (no method) whose result carries a stopReason is a
      // session/prompt turn outcome. Record it ONLY when its id correlates to a
      // prompt we actually saw: an uncorrelated response (its prompt was oversized
      // and skipped, or its entry was evicted) must not be attributed to an empty
      // "unknown" session, where it could merge with unrelated sessions' outcomes.
      // Record the LAST outcome per session (see flush) so a multi-turn session
      // yields one outcome, like the hooks path.
      if (message.method === undefined && message.result && typeof message.result === "object"
        && message.id !== undefined && message.id !== null) {
        const stopReason = firstString(message.result.stopReason, message.result.stop_reason);
        const promptKey = idKeyOf(message, rawId);
        if (stopReason && promptSessions.has(promptKey)) {
          const sessionId = promptSessions.get(promptKey);
          promptSessions.delete(promptKey); // correlated — free it
          sessionOutcomes.set(sessionId, stopReason);
          capMap(sessionOutcomes, MAX_TRACKED_PROMPTS);
        }
      }
    },
    // Best-effort settle: emit one outcome per still-open session (its final
    // observed stopReason) and resolve once all queued writes have flushed.
    async flush() {
      for (const sessionKey of [...sessionOutcomes.keys()]) {
        emitOutcome(sessionKey);
      }
      await chain;
    },
  };
}

// A newline-delimited JSON observer Transform: it inspects a *copy* of every
// complete line via `observe(message)` and always re-emits the ORIGINAL bytes,
// so it is byte-identical to a passthrough. Parsing/observation errors are
// swallowed — capture must never disturb the wire. An oversized frame (e.g. a
// large base64 image prompt) is SKIPPED without buffering — but only that
// frame: parsing resumes at the next newline, so one big message never
// permanently blinds capture to every later event on the connection.
export function createCaptureTap(observe, { maxScanBytes = MAX_SCAN_BYTES } = {}) {
  const inspect = typeof observe === "function" ? observe : () => {};
  let buffer = EMPTY;
  // While true, drop bytes (without buffering) until the current oversized
  // frame's terminating newline, then resume normal line parsing.
  let skippingOversized = false;

  const handleLine = (lineBuf) => {
    if (lineBuf.length > maxScanBytes) {
      return; // too large to inspect; bytes are still forwarded by the caller
    }
    const text = lineBuf.toString("utf8");
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    // Extract the EXACT raw id text before JSON.parse could have rounded it, so
    // request/response correlation is precise even for ids beyond 2^53.
    let rawId = null;
    try {
      rawId = extractTopLevelRawId(text);
    } catch {
      rawId = null;
    }
    try {
      inspect(message, rawId);
    } catch {
      // Observation must never break the stream.
    }
  };

  return new Transform({
    transform(chunk, _enc, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // Forward the original bytes FIRST and unconditionally: observation can
      // never delay or alter the wire.
      this.push(bytes);
      try {
        let working = bytes;
        // Finish discarding an in-progress oversized frame: drop up to and
        // including its next newline, then resume normal parsing on the rest.
        if (skippingOversized) {
          const nl = working.indexOf(NEWLINE);
          if (nl === -1) {
            return callback(); // still inside the oversized frame
          }
          skippingOversized = false;
          working = working.subarray(nl + 1);
        }
        buffer = buffer.length ? Buffer.concat([buffer, working]) : working;
        let start = 0;
        let nl;
        while ((nl = buffer.indexOf(NEWLINE, start)) !== -1) {
          handleLine(buffer.subarray(start, nl + 1));
          start = nl + 1;
        }
        let leftover = buffer.subarray(start);
        // The current (unterminated) line has outgrown the cap: drop it and skip
        // to its newline in subsequent chunks — but keep parsing everything after.
        if (leftover.length > maxScanBytes) {
          skippingOversized = true;
          leftover = EMPTY;
        }
        buffer = leftover.length ? Buffer.from(leftover) : EMPTY;
        callback();
      } catch {
        // Never surface a capture error onto the stream.
        callback();
      }
    },
    flush(callback) {
      try {
        if (!skippingOversized && buffer.length) {
          handleLine(buffer);
        }
      } catch {
        // ignore
      }
      buffer = EMPTY;
      callback();
    },
  });
}

// ---------------------------------------------------------------------------
// Fidelity comparison: contrast proxy-captured events against hook-captured
// events for the same session(s). Pure over two arrays of canonical store
// events; the CLI feeds it events.jsonl (hooks) and acp-capture.jsonl (proxy).
// ---------------------------------------------------------------------------

const KEY_SEP = "\u0000";

function indexEvents(events) {
  // Keyed by sessionId + value so a path/command only counts as "caught by
  // both" when the SAME session caught it — a coincidental match across two
  // unrelated sessions must not read as parity. `events` counts are raw (every
  // occurrence) so a count asymmetry is visible even when the distinct sets match.
  //
  // Known limitation: the store records session ids truncated to 8 chars (both
  // the hooks and proxy paths), so this diagnostic report is only as precise as
  // that 8-char sid — two sessions sharing an 8-char prefix would be grouped as
  // one. ACP session ids are effectively unique in that prefix in practice.
  const edits = new Map();
  const commands = new Map();
  const sessions = new Set();
  let sessionEnds = 0;
  let editEvents = 0;
  let commandEvents = 0;
  let inferred = 0;
  for (const event of events || []) {
    if (!event || typeof event !== "object") continue;
    const sid = event.sid || "unknown";
    sessions.add(sid);
    if (event.confidence === "inferred") inferred += 1;
    if (event.type === "edit" && event.path) {
      edits.set(`${sid}${KEY_SEP}${event.path}`, { sid, value: event.path });
      editEvents += 1;
    } else if (event.type === "cmd" && event.cmd) {
      commands.set(`${sid}${KEY_SEP}${event.cmd}`, { sid, value: event.cmd });
      commandEvents += 1;
    } else if (event.type === "session_end") {
      sessionEnds += 1;
    }
  }
  return { edits, commands, sessions, sessionEnds, editEvents, commandEvents, inferred };
}

function diffKeys(left, right) {
  const both = [];
  const leftOnly = [];
  const rightOnly = [];
  for (const [key, entry] of left) {
    (right.has(key) ? both : leftOnly).push(entry);
  }
  for (const [key, entry] of right) {
    if (!left.has(key)) rightOnly.push(entry);
  }
  const order = (a, b) => (a.sid === b.sid ? a.value.localeCompare(b.value) : a.sid.localeCompare(b.sid));
  return { both: both.sort(order), leftOnly: leftOnly.sort(order), rightOnly: rightOnly.sort(order) };
}

export function compareCaptureSources({ hookEvents = [], proxyEvents = [] } = {}) {
  const hooks = indexEvents(hookEvents);
  const proxy = indexEvents(proxyEvents);
  const editDiff = diffKeys(hooks.edits, proxy.edits);
  const commandDiff = diffKeys(hooks.commands, proxy.commands);
  return {
    command: "acp capture-report",
    sessions: {
      hooks: [...hooks.sessions].sort(),
      proxy: [...proxy.sessions].sort(),
      shared: [...hooks.sessions].filter((sid) => proxy.sessions.has(sid)).sort(),
    },
    edits: {
      hooks_distinct: hooks.edits.size,
      proxy_distinct: proxy.edits.size,
      hooks_events: hooks.editEvents,
      proxy_events: proxy.editEvents,
      caught_by_both: editDiff.both,
      hooks_only: editDiff.leftOnly,
      proxy_only: editDiff.rightOnly,
    },
    commands: {
      hooks_distinct: hooks.commands.size,
      proxy_distinct: proxy.commands.size,
      hooks_events: hooks.commandEvents,
      proxy_events: proxy.commandEvents,
      caught_by_both: commandDiff.both,
      hooks_only: commandDiff.leftOnly,
      proxy_only: commandDiff.rightOnly,
    },
    session_outcomes: { hooks: hooks.sessionEnds, proxy: proxy.sessionEnds },
    proxy_inferred_events: proxy.inferred,
  };
}
