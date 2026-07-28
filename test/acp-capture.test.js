import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { pauseContext, recordCapturedEvent, readCaptureComparison, resolveContextPaths, trackEvent } from "../src/core/ctx.js";
import {
  compareCaptureSources,
  createCaptureEngine,
  createCaptureTap,
  normalizeAcpCaptureMode,
  payloadsFromToolCall,
  providerHasHookTracking,
  resolveAcpCaptureMode,
  resolveCaptureSink,
  runAcpProxyCommand,
} from "../src/core/acp/index.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, { timeout = 5000, interval = 5 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("waitUntil timed out");
    }
    await delay(interval);
  }
}

async function withTempRoot(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-acp-capture-"));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function readEvents(root) {
  try {
    return (await fs.readFile(resolveContextPaths(root).eventsPath, "utf8"))
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function readCaptureLog(root) {
  try {
    return (await fs.readFile(resolveContextPaths(root).acpCapturePath, "utf8"))
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// Feed a set of downstream->client notifications/results into an engine writing
// through the SAME store path the proxy uses, then settle.
function engineFor(root, { sink = "events", isSameWorkspace } = {}) {
  const events = [];
  const engine = createCaptureEngine({
    isSameWorkspace,
    record: (payload, opts) => recordCapturedEvent(root, payload, { confidence: opts?.confidence, sink }),
    onEvent: (event) => events.push(event),
  });
  return { engine, events };
}

const update = (u) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sessABCDEF", update: u } });

// --------------------------------------------------------------------------
// Mode + ownership
// --------------------------------------------------------------------------

test("normalizeAcpCaptureMode clamps to known modes and defaults to off", () => {
  assert.equal(normalizeAcpCaptureMode(undefined), "off");
  assert.equal(normalizeAcpCaptureMode("AUTO"), "auto");
  assert.equal(normalizeAcpCaptureMode("compare"), "compare");
  assert.equal(normalizeAcpCaptureMode("nonsense"), "off");
});

test("resolveAcpCaptureMode: default off, config, env override, recursion guard", () => {
  assert.equal(resolveAcpCaptureMode({}, {}), "off");
  assert.equal(resolveAcpCaptureMode({ context: { acpCapture: "auto" } }, {}), "auto");
  // env override wins over config
  assert.equal(resolveAcpCaptureMode({ context: { acpCapture: "auto" } }, { AGENTIFY_ACP_CAPTURE: "compare" }), "compare");
  // AGENTIFY_CTX=off (delegate-child guard) forces off
  assert.equal(resolveAcpCaptureMode({ context: { acpCapture: "all" } }, { AGENTIFY_CTX: "off" }), "off");
});

test("one-writer ownership: auto keeps a hook-tracked provider out of the store", () => {
  assert.equal(providerHasHookTracking("claude"), true);
  assert.equal(providerHasHookTracking("codex"), false);
  // auto: Claude has its own hooks -> proxy stays out of the main store,
  // diverting to the side-log (no double count, nothing silently lost).
  assert.equal(resolveCaptureSink("auto", { provider: "claude" }), "compare");
  // auto: Codex has no native hooks -> the proxy is the store writer (symmetry).
  assert.equal(resolveCaptureSink("auto", { provider: "codex" }), "events");
  // all: proxy always owns the store; compare: only the side-log; off: nothing.
  assert.equal(resolveCaptureSink("all", { provider: "claude" }), "events");
  assert.equal(resolveCaptureSink("compare", { provider: "claude" }), "compare");
  assert.equal(resolveCaptureSink("off", { provider: "codex" }), "none");
});

// --------------------------------------------------------------------------
// Pure extraction (per-provider shapes)
// --------------------------------------------------------------------------

test("extraction: an explicit edit tool call is captured as an observed edit", () => {
  const items = payloadsFromToolCall({ kind: "edit", status: "completed", locations: [{ path: "/repo/src/app.js" }], rawInput: { file_path: "/repo/src/app.js" } });
  assert.equal(items.length, 1);
  assert.equal(items[0].payload.tool_name, "Write");
  assert.equal(items[0].payload.tool_input.file_path, "/repo/src/app.js");
  assert.equal(items[0].confidence, "observed");
});

test("extraction: an execute tool call is captured as an observed command with failure", () => {
  const items = payloadsFromToolCall({ kind: "execute", status: "failed", rawInput: { command: "npm test" }, rawOutput: { exit_code: 1, stderr: "boom" } });
  assert.equal(items.length, 1);
  assert.equal(items[0].payload.tool_name, "Bash");
  assert.equal(items[0].payload.tool_input.command, "npm test");
  assert.equal(items[0].payload.tool_response.exit_code, 1);
  assert.equal(items[0].confidence, "observed");
});

test("extraction: a Codex shell-wrapper argv is unwrapped and flagged inferred", () => {
  // Codex wraps file access in an opaque shell tool (kind "other"); the real
  // effect can only be inferred, so it is recorded with lower confidence.
  const items = payloadsFromToolCall({ kind: "other", status: "completed", title: "Run shell", rawInput: { command: ["bash", "-lc", "sed -i s/a/b/ src/app.js"] } });
  assert.equal(items.length, 1);
  assert.equal(items[0].payload.tool_input.command, "sed -i s/a/b/ src/app.js");
  assert.equal(items[0].confidence, "inferred");
});

test("extraction: an opaque read (kind other with a bare path) is NOT inferred as an edit", () => {
  // A custom read_file({path}) mapped to kind "other" must not become an edit —
  // a bare path is not write evidence.
  const readItems = payloadsFromToolCall({ kind: "other", status: "completed", title: "read_file", rawInput: { path: "/repo/src/a.js" } });
  assert.equal(readItems.length, 0);
  // But a diff-content block IS strong write evidence -> inferred edit.
  const writeItems = payloadsFromToolCall({ kind: "other", status: "completed", content: [{ type: "diff", path: "/repo/src/a.js" }] });
  assert.equal(writeItems.length, 1);
  assert.equal(writeItems[0].payload.tool_name, "Write");
  assert.equal(writeItems[0].confidence, "inferred");
});

test("extraction: an execute call with only a title (no command) is NOT fabricated", () => {
  // An MCP/dynamic tool the adapter maps to `execute` without a command field
  // must not become a fake Bash command from its display title.
  const items = payloadsFromToolCall({ kind: "execute", status: "completed", title: "mcp.github.get_issue" });
  assert.equal(items.length, 0);
});

test("extraction: read-only tool kinds with locations are NOT recorded as edits", () => {
  for (const kind of ["read", "search", "fetch", "think", "switch_mode", "delete", "move"]) {
    const items = payloadsFromToolCall({ kind, status: "completed", locations: [{ path: "/repo/a.js" }] });
    assert.equal(items.length, 0, `${kind} must not become an edit`);
  }
});

test("extraction: a failed edit is not recorded (no confirmed filesystem change)", () => {
  const items = payloadsFromToolCall({ kind: "edit", status: "failed", locations: [{ path: "/repo/a.js" }] });
  assert.equal(items.length, 0, "a failed write may never have touched the file");
});

test("extraction: a failed command WITH execution evidence is recorded (parity with hooks)", () => {
  const items = payloadsFromToolCall({ kind: "execute", status: "failed", rawInput: { command: "npm test" }, rawOutput: { exit_code: 1 } });
  assert.equal(items.length, 1);
  assert.equal(items[0].payload.tool_input.command, "npm test");
  assert.equal(items[0].payload.tool_response.exit_code, 1);
});

test("extraction: a DENIED command (failed, no execution evidence) is not recorded", () => {
  // ACP adapters also mark permission denials as `failed`; with no rawOutput the
  // command never ran, so it must not enter command history (hooks never see it).
  const items = payloadsFromToolCall({ kind: "execute", status: "failed", rawInput: { command: "rm -rf /" } });
  assert.equal(items.length, 0);
});

test("extraction: a failed command with string/array rawOutput counts as executed", () => {
  // The Claude adapter forwards tool content directly (string or array), not an
  // {exit_code} object; such output still proves the command ran.
  const strItems = payloadsFromToolCall({ kind: "execute", status: "failed", rawInput: { command: "make" }, rawOutput: "error: build failed" });
  assert.equal(strItems.length, 1);
  assert.ok(strItems[0].payload.tool_response.stderr.includes("build failed"));
  const arrItems = payloadsFromToolCall({ kind: "execute", status: "failed", rawInput: { command: "make" }, rawOutput: [{ type: "text", text: "boom" }] });
  assert.equal(arrItems.length, 1);
});

test("extraction: a declined Codex command ({formatted_output:'',exit_code:null}) is not recorded", () => {
  // The Codex adapter emits this shape for a DENIED command — a null exit code
  // and empty output are NOT execution evidence.
  const items = payloadsFromToolCall({ kind: "execute", status: "failed", rawInput: { command: "rm -rf /" }, rawOutput: { formatted_output: "", exit_code: null } });
  assert.equal(items.length, 0);
});

test("extraction: a nonExecutionKind-flagged call with output is NOT recorded as executed", () => {
  // The Claude adapter forwards rejection/interrupt content as rawOutput but flags
  // nonExecutionKind; such a call never ran, so no command/edit is recorded.
  const rejectedCmd = payloadsFromToolCall({ kind: "execute", status: "completed", nonExecution: true, rawInput: { command: "rm -rf /" }, rawOutput: "user rejected" });
  assert.equal(rejectedCmd.length, 0);
  const rejectedEdit = payloadsFromToolCall({ kind: "edit", status: "completed", nonExecution: true, locations: [{ path: "/repo/a.js" }] });
  assert.equal(rejectedEdit.length, 0);
});

test("extraction: a read/search call that DOES carry a shell command is recorded", () => {
  // When an adapter classifies a shell `cat`/`rg` as read/search but still
  // includes the command, parity with hooks requires recording it as a command
  // (never as an edit).
  for (const kind of ["read", "search"]) {
    const items = payloadsFromToolCall({ kind, status: "completed", rawInput: { command: `cat src/a.js` } });
    assert.equal(items.length, 1, `${kind} with a shell command must be recorded`);
    assert.equal(items[0].payload.tool_name, "Bash");
    assert.equal(items[0].confidence, "inferred");
    assert.ok(items.every((i) => i.payload.tool_name !== "Write"));
  }
});

test("extraction: a read/search WITHOUT a command field is an honest gap (records nothing)", () => {
  // The Codex adapter omits the command for recognized read/search/listFiles, so
  // the shell command cannot be recovered — the title is not fabricated into one.
  const readByTitle = payloadsFromToolCall({ kind: "read", status: "completed", title: "cat src/a.js", locations: [{ path: "/repo/src/a.js" }] });
  assert.equal(readByTitle.length, 0);
});

test("extraction: null-clearing update semantics drop a stale edit path", () => {
  // Simulated through the engine merge below; here assert payload-level: an
  // entry whose locations were cleared yields no edit.
  const items = payloadsFromToolCall({ kind: "edit", status: "completed", locations: undefined });
  assert.equal(items.length, 0);
});

// --------------------------------------------------------------------------
// Engine: dedup, per-provider streams, outcomes
// --------------------------------------------------------------------------

test("engine: a pending+completed pair for one tool call is written exactly once", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root);
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "tc1", kind: "edit", status: "pending", locations: [{ path: path.join(root, "a.js") }] }));
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed" }));
    await engine.flush();
    const edits = (await readEvents(root)).filter((e) => e.type === "edit");
    assert.equal(edits.length, 1, "the edit must be recorded once, not once per notification");
    assert.equal(edits[0].path, "a.js");
  });
});

test("engine: a still-pending tool call is not recorded (no confirmed effect)", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root);
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "tc1", kind: "execute", status: "pending", rawInput: { command: "rm -rf build" } }));
    await engine.flush();
    assert.equal((await readEvents(root)).length, 0, "a tool call that never completed must not be counted");
  });
});

test("engine (Claude-shaped stream): edits, commands and the session outcome are captured", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root);
    engine.observeClientToDownstream({ jsonrpc: "2.0", id: 9, method: "session/prompt", params: { sessionId: "sessABCDEF", prompt: [{ type: "text", text: "do work" }] } });
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", status: "completed", locations: [{ path: path.join(root, "src/app.js") }] }));
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", status: "completed", rawInput: { command: "npm run build" } }));
    engine.observeDownstreamToClient({ jsonrpc: "2.0", id: 9, result: { stopReason: "end_turn" } });
    await engine.flush();
    const events = await readEvents(root);
    assert.ok(events.some((e) => e.type === "edit" && e.path === "src/app.js"));
    assert.ok(events.some((e) => e.type === "cmd" && e.cmd === "npm run build"));
    const end = events.find((e) => e.type === "session_end");
    assert.equal(end.reason, "end_turn");
    // Outcome is correlated to the prompt's session id, not "unknown".
    assert.equal(end.sid, "sessABCD");
  });
});

test("engine: a tool-call id reused by a second session is captured, not dropped", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root);
    // Session A completes tc1 (edit a.js).
    engine.observeDownstreamToClient({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sessAAAA1", update: { sessionUpdate: "tool_call", toolCallId: "tc1", kind: "edit", status: "completed", locations: [{ path: path.join(root, "a.js") }] } } });
    // Session B validly reuses tc1 (edit b.js) — ids are only unique per session.
    engine.observeDownstreamToClient({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sessBBBB2", update: { sessionUpdate: "tool_call", toolCallId: "tc1", kind: "edit", status: "completed", locations: [{ path: path.join(root, "b.js") }] } } });
    await engine.flush();
    const edits = (await readEvents(root)).filter((e) => e.type === "edit").map((e) => e.path).sort();
    assert.deepEqual(edits, ["a.js", "b.js"], "both sessions' edits are recorded despite the shared tool-call id");
  });
});

test("engine: a multi-turn session records ONE outcome (its final turn), like hooks", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root);
    engine.observeClientToDownstream({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "sessMULTI1", prompt: [] } });
    engine.observeDownstreamToClient({ jsonrpc: "2.0", id: 1, result: { stopReason: "max_turn_requests" } });
    engine.observeClientToDownstream({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "sessMULTI1", prompt: [] } });
    engine.observeDownstreamToClient({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } });
    await engine.flush();
    const ends = (await readEvents(root)).filter((e) => e.type === "session_end");
    assert.equal(ends.length, 1, "a 2-turn session must not record 2 session ends");
    assert.equal(ends[0].reason, "end_turn", "the final turn's outcome wins");
  });
});

test("engine: a successful session/close persists that session's outcome mid-connection", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root);
    engine.observeClientToDownstream({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "sessCLOSE1", prompt: [] } });
    engine.observeDownstreamToClient({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
    // The client closes the session (and it succeeds) while the connection runs.
    engine.observeClientToDownstream({ jsonrpc: "2.0", id: 2, method: "session/close", params: { sessionId: "sessCLOSE1" } });
    engine.observeDownstreamToClient({ jsonrpc: "2.0", id: 2, result: null });
    await new Promise((r) => setTimeout(r, 10));
    const ends = (await readEvents(root)).filter((e) => e.type === "session_end");
    assert.equal(ends.length, 1, "the outcome is written at close, not only at connection teardown");
    assert.equal(ends[0].reason, "end_turn");
    // flush() must not double-write the already-emitted outcome.
    await engine.flush();
    assert.equal((await readEvents(root)).filter((e) => e.type === "session_end").length, 1);
  });
});

test("engine: a session/close that ERRORS does not record a false session end", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root);
    engine.observeClientToDownstream({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "sessERR1", prompt: [] } });
    engine.observeDownstreamToClient({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
    engine.observeClientToDownstream({ jsonrpc: "2.0", id: 2, method: "session/close", params: { sessionId: "sessERR1" } });
    // The close fails: the session is still alive, so no outcome may be written.
    engine.observeDownstreamToClient({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "cannot close" } });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((await readEvents(root)).filter((e) => e.type === "session_end").length, 0, "a failed close must not persist an outcome");
    // A subsequent successful close commits it exactly once.
    engine.observeClientToDownstream({ jsonrpc: "2.0", id: 3, method: "session/close", params: { sessionId: "sessERR1" } });
    engine.observeDownstreamToClient({ jsonrpc: "2.0", id: 3, result: null });
    await engine.flush();
    assert.equal((await readEvents(root)).filter((e) => e.type === "session_end").length, 1);
  });
});

test("engine: a tool_call_update with locations:null clears a stale edit path", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root);
    // First a pending edit naming stale.js, then a completing update that CLEARS
    // locations (ACP null-clearing). The stale path must not be recorded.
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", status: "pending", locations: [{ path: path.join(root, "stale.js") }] }));
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed", locations: null }));
    await engine.flush();
    assert.equal((await readEvents(root)).filter((e) => e.type === "edit").length, 0, "a cleared location must not be recorded as an edit");
  });
});

test("engine: a rejected tool call flagged via _meta.nonExecutionKind is not recorded", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root);
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", status: "completed", rawInput: { command: "rm -rf build" }, rawOutput: "user rejected the command", _meta: { nonExecutionKind: "rejected" } }));
    await engine.flush();
    assert.equal((await readEvents(root)).length, 0, "a rejected call must not be recorded even though it forwarded output");
  });
});

test("withinRoot containment: a '..config' file in the repo root does not disable capture", async () => {
  await withTempRoot(async (root) => {
    const withinRoot = (dir) => {
      if (typeof dir !== "string") return false;
      const rel = path.relative(root, path.resolve(dir));
      return rel === "" || (rel.split(/[/\\]/)[0] !== ".." && !path.isAbsolute(rel));
    };
    assert.equal(withinRoot(path.join(root, "..config")), true, "'..config' is inside the repo");
    assert.equal(withinRoot(path.join(root, "packages", "app")), true, "a subdir is inside");
    assert.equal(withinRoot(path.dirname(root)), false, "the parent dir is outside");
  });
});

test("engine: a session in a subdirectory of the launch root is still captured", async () => {
  await withTempRoot(async (root) => {
    const sub = path.join(root, "packages", "app");
    await fs.mkdir(sub, { recursive: true });
    // Mirror index.js's containment check.
    const withinRoot = (dir) => {
      if (typeof dir !== "string") return false;
      const rel = path.relative(root, path.resolve(dir));
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    const { engine } = engineFor(root, { isSameWorkspace: withinRoot });
    engine.observeClientToDownstream({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: sub } });
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", status: "completed", locations: [{ path: path.join(sub, "index.js") }] }));
    await engine.flush();
    assert.ok((await readEvents(root)).some((e) => e.type === "edit" && e.path === "packages/app/index.js"), "a monorepo subdir session must still be captured");
  });
});

test("createCaptureTap correlates a prompt outcome by its exact raw id beyond 2^53", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root);
    // Two concurrent prompts whose ids differ ONLY beyond 2^53. JSON.parse rounds
    // both to the same Number; the raw-id path must keep them distinct so each
    // outcome lands on the right session.
    const tapC2D = createCaptureTap((m, rawId) => engine.observeClientToDownstream(m, rawId));
    const tapD2C = createCaptureTap((m, rawId) => engine.observeDownstreamToClient(m, rawId));
    const feed = (tap, lines) => new Promise((resolve) => {
      tap.on("data", () => {});
      tap.on("end", resolve);
      for (const l of lines) tap.write(Buffer.from(l, "utf8"));
      tap.end();
    });
    await feed(tapC2D, [
      '{"jsonrpc":"2.0","id":9007199254740993,"method":"session/prompt","params":{"sessionId":"sessONE1","prompt":[]}}\n',
      '{"jsonrpc":"2.0","id":9007199254740992,"method":"session/prompt","params":{"sessionId":"sessTWO2","prompt":[]}}\n',
    ]);
    await feed(tapD2C, [
      '{"jsonrpc":"2.0","id":9007199254740993,"result":{"stopReason":"end_turn"}}\n',
      '{"jsonrpc":"2.0","id":9007199254740992,"result":{"stopReason":"cancelled"}}\n',
    ]);
    await engine.flush();
    const ends = (await readEvents(root)).filter((e) => e.type === "session_end");
    const bySid = Object.fromEntries(ends.map((e) => [e.sid, e.reason]));
    assert.equal(bySid.sessONE1, "end_turn", "the big-id prompt's outcome maps to its own session");
    assert.equal(bySid.sessTWO2, "cancelled", "the near-id prompt's outcome maps to the other session");
  });
});

test("engine: an uncorrelated prompt result (unknown id) records no session outcome", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root);
    // A result whose id was never seen as a prompt (e.g. the prompt was oversized
    // and skipped by the tap) must not be attributed to an empty/unknown session.
    engine.observeDownstreamToClient({ jsonrpc: "2.0", id: 999, result: { stopReason: "end_turn" } });
    await engine.flush();
    assert.equal((await readEvents(root)).filter((e) => e.type === "session_end").length, 0, "an uncorrelated outcome must not be recorded");
  });
});

test("engine: a late duplicate update for an already-recorded tool call is ignored", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root);
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", status: "completed", locations: [{ path: path.join(root, "a.js") }] }));
    // A stray second "completed" for the same call must not add a second edit.
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed" }));
    await engine.flush();
    assert.equal((await readEvents(root)).filter((e) => e.type === "edit").length, 1);
  });
});

test("engine: an additional workspace root outside the launch repo disables capture", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root, { isSameWorkspace: (cwd) => cwd === root });
    engine.observeClientToDownstream({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: root, additionalDirectories: ["/some/other/repo"] } });
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", status: "completed", locations: [{ path: path.join(root, "a.js") }] }));
    await engine.flush();
    assert.equal((await readEvents(root)).length, 0, "an added foreign root disables capture connection-wide");
  });
});

test("recordCapturedEvent drops an edit whose path escapes the launch repo", async () => {
  await withTempRoot(async (root) => {
    const written = await recordCapturedEvent(
      root,
      { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/some/other/repo/leak.js" }, session_id: "s" },
      {},
    );
    assert.equal(written, null, "an out-of-repo edit must never be recorded");
    assert.equal((await readEvents(root)).length, 0);
  });
});

test("engine (Codex-shaped stream): a custom_tool_call wrapper yields an inferred command", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root);
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "call_1", kind: "other", status: "completed", title: "shell", rawInput: { command: ["bash", "-lc", "pytest -q"] } }));
    await engine.flush();
    const cmd = (await readEvents(root)).find((e) => e.type === "cmd");
    assert.equal(cmd.cmd, "pytest -q");
    assert.equal(cmd.confidence, "inferred");
  });
});

// --------------------------------------------------------------------------
// Double-write guard (hooks simulated active)
// --------------------------------------------------------------------------

test("double-write guard: with hooks active (Claude) auto never writes the main store", async () => {
  await withTempRoot(async (root) => {
    // Simulate the Claude Code hooks having already recorded this session.
    await trackEvent(root, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(root, "src/app.js") }, session_id: "sessABCDEF" });
    assert.equal((await readEvents(root)).length, 1);

    // For Claude+auto the ownership rule diverts capture to the side-log, so the
    // proxy observes the SAME edit but the main store is never double-written.
    const sink = resolveCaptureSink("auto", { provider: "claude" });
    assert.equal(sink, "compare");
    const { engine } = engineFor(root, { sink });
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", status: "completed", locations: [{ path: path.join(root, "src/app.js") }] }));
    await engine.flush();

    assert.equal((await readEvents(root)).length, 1, "no duplicate edit — hooks remain the sole store writer for Claude");
    assert.ok((await readCaptureLog(root)).some((e) => e.type === "edit" && e.path === "src/app.js"), "the proxy's view is preserved in the side-log, not lost");
  });
});

test("Codex (no native hooks) auto captures into the store, closing the asymmetry", async () => {
  await withTempRoot(async (root) => {
    const sink = resolveCaptureSink("auto", { provider: "codex" });
    assert.equal(sink, "events");
    const { engine } = engineFor(root, { sink });
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", status: "completed", locations: [{ path: path.join(root, "src/app.js") }] }));
    await engine.flush();
    assert.ok((await readEvents(root)).some((e) => e.type === "edit" && e.path === "src/app.js"));
  });
});

// --------------------------------------------------------------------------
// Pause
// --------------------------------------------------------------------------

test("pause suppresses proxy capture (nothing is written)", async () => {
  await withTempRoot(async (root) => {
    await pauseContext(root);
    const { engine, events } = engineFor(root);
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", status: "completed", locations: [{ path: path.join(root, "a.js") }] }));
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", status: "completed", rawInput: { command: "npm test" } }));
    await engine.flush();
    assert.equal((await readEvents(root)).length, 0, "capture must write nothing while paused");
    assert.equal(events.length, 0);
  });
});

test("recordCapturedEvent honors AGENTIFY_CTX=off as a pause signal", async () => {
  await withTempRoot(async (root) => {
    const written = await recordCapturedEvent(
      root,
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo hi" }, session_id: "s" },
      { env: { AGENTIFY_CTX: "off" } },
    );
    assert.equal(written, null);
    assert.equal((await readEvents(root)).length, 0);
  });
});

// --------------------------------------------------------------------------
// Redaction
// --------------------------------------------------------------------------

test("redaction is applied before a captured command is written", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root);
    const secret = "sk-ABCDEF0123456789ghij";
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", status: "completed", rawInput: { command: `deploy --token=${secret}` } }));
    await engine.flush();
    const cmd = (await readEvents(root)).find((e) => e.type === "cmd");
    assert.ok(cmd, "the command was captured");
    assert.ok(cmd.cmd.includes("[REDACTED]"), "the secret must be redacted");
    assert.ok(!cmd.cmd.includes(secret), "the raw secret must never be stored");
  });
});

// --------------------------------------------------------------------------
// Privacy: cross-workspace guard
// --------------------------------------------------------------------------

test("capture is disabled connection-wide once a session escapes the launch workspace", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root, { isSameWorkspace: (cwd) => cwd === root });
    engine.observeClientToDownstream({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/some/other/repo" } });
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", status: "completed", locations: [{ path: "/some/other/repo/a.js" }] }));
    await engine.flush();
    assert.equal((await readEvents(root)).length, 0, "another repo's activity must never enter this store");
  });
});

// --------------------------------------------------------------------------
// Byte-identity (observation only)
// --------------------------------------------------------------------------

test("engine: a re-sent rawInput REPLACES the previous one (no stale command)", async () => {
  await withTempRoot(async (root) => {
    const { engine } = engineFor(root);
    // Initial pending call carries command A; the completing update re-sends
    // rawInput with command B. Only B must be recorded (replace, not merge).
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", status: "pending", rawInput: { command: "echo A" } }));
    engine.observeDownstreamToClient(update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawInput: { command: "echo B" } }));
    await engine.flush();
    const cmds = (await readEvents(root)).filter((e) => e.type === "cmd").map((e) => e.cmd);
    assert.deepEqual(cmds, ["echo B"]);
  });
});

test("createCaptureTap skips only an oversized frame and resumes on the next", async () => {
  const seen = [];
  const tap = createCaptureTap((m) => seen.push(m), { maxScanBytes: 64 });
  const chunks = [];
  tap.on("data", (c) => chunks.push(Buffer.from(c)));
  const ended = new Promise((r) => tap.once("end", r));
  const small1 = `${JSON.stringify({ a: 1 })}\n`;
  const huge = `${JSON.stringify({ big: "z".repeat(500) })}\n`;
  const small2 = `${JSON.stringify({ b: 2 })}\n`;
  // Feed the huge frame split across chunk boundaries.
  tap.write(Buffer.from(small1));
  tap.write(Buffer.from(huge.slice(0, 100)));
  tap.write(Buffer.from(huge.slice(100)));
  tap.write(Buffer.from(small2));
  tap.end();
  await ended;
  assert.equal(Buffer.concat(chunks).toString(), `${small1}${huge}${small2}`, "every byte still forwarded");
  // The oversized frame was skipped, but parsing resumed for the frame after it.
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
});

test("createCaptureTap is byte-identical and swallows observer errors", async () => {
  const seen = [];
  const tap = createCaptureTap((message) => {
    seen.push(message);
    throw new Error("observer failures must never reach the wire");
  });
  const input = Buffer.from('{"a":1}\n{"method":"session/update","params":{}}\n{partial');
  const chunks = [];
  tap.on("data", (c) => chunks.push(Buffer.from(c)));
  const ended = new Promise((r) => tap.once("end", r));
  // Split across an arbitrary boundary to exercise line reassembly.
  tap.write(input.subarray(0, 10));
  tap.write(input.subarray(10));
  tap.end();
  await ended;
  assert.equal(Buffer.concat(chunks).toString(), input.toString(), "every byte forwarded unchanged");
  assert.equal(seen.length, 2, "both complete JSON lines were observed; the partial tail was not");
});

// --------------------------------------------------------------------------
// Comparison report
// --------------------------------------------------------------------------

test("compareCaptureSources contrasts what each source caught and missed", () => {
  const report = compareCaptureSources({
    hookEvents: [
      { type: "edit", path: "a.js", sid: "s1" },
      { type: "edit", path: "b.js", sid: "s1" },
      { type: "cmd", cmd: "npm test", sid: "s1" },
      { type: "session_end", reason: "end", sid: "s1" },
    ],
    proxyEvents: [
      { type: "edit", path: "a.js", sid: "s1", src: "acp" },
      { type: "cmd", cmd: "npm test", sid: "s1", src: "acp" },
      { type: "cmd", cmd: "grep foo", sid: "s1", src: "acp", confidence: "inferred" },
    ],
  });
  assert.deepEqual(report.edits.caught_by_both, [{ sid: "s1", value: "a.js" }]);
  assert.deepEqual(report.edits.hooks_only, [{ sid: "s1", value: "b.js" }]);
  assert.deepEqual(report.edits.proxy_only, []);
  assert.deepEqual(report.commands.caught_by_both, [{ sid: "s1", value: "npm test" }]);
  assert.deepEqual(report.commands.proxy_only, [{ sid: "s1", value: "grep foo" }]);
  assert.equal(report.proxy_inferred_events, 1);
});

test("compareCaptureSources does not read a coincidental match across sessions as parity", () => {
  // The same path edited in two DIFFERENT sessions must not appear as
  // caught_by_both — that would overstate the proxy's fidelity.
  const report = compareCaptureSources({
    hookEvents: [{ type: "edit", path: "a.js", sid: "s1" }],
    proxyEvents: [{ type: "edit", path: "a.js", sid: "s2", src: "acp" }],
  });
  assert.deepEqual(report.edits.caught_by_both, []);
  assert.deepEqual(report.edits.hooks_only, [{ sid: "s1", value: "a.js" }]);
  assert.deepEqual(report.edits.proxy_only, [{ sid: "s2", value: "a.js" }]);
  assert.deepEqual(report.sessions.shared, []);
});

test("readCaptureComparison splits hook events from proxy-tagged and side-log events", async () => {
  await withTempRoot(async (root) => {
    await trackEvent(root, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(root, "hooked.js") }, session_id: "s1" });
    // A compare-mode capture writes to the side-log, never events.jsonl.
    await recordCapturedEvent(root, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(root, "proxied.js") }, session_id: "s1" }, { sink: "compare" });
    const { hookEvents, proxyEvents } = await readCaptureComparison(root);
    assert.ok(hookEvents.some((e) => e.path === "hooked.js") && !hookEvents.some((e) => e.path === "proxied.js"));
    assert.ok(proxyEvents.some((e) => e.path === "proxied.js"));
    assert.equal((await readEvents(root)).length, 1, "compare mode must not pollute events.jsonl");
  });
});

// --------------------------------------------------------------------------
// End-to-end through a real spawned child adapter (the #335 pattern)
// --------------------------------------------------------------------------

// A dependency-free ACP-ish agent that, on session/prompt, emits an edit and a
// command tool call (as session/update notifications) and then a result.
const CAPTURE_AGENT_SCRIPT = `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const dir = process.env.AGENT_WORK_DIR;
rl.on("line", (raw) => {
  const t = raw.trim();
  if (!t) return;
  let m; try { m = JSON.parse(t); } catch { return; }
  if (m.method === "initialize") { send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } }); }
  else if (m.method === "session/new") { send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "childsession" } }); }
  else if (m.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "childsession", update: { sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", status: "completed", locations: [{ path: dir + "/src/handler.js" }] } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "childsession", update: { sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", status: "completed", rawInput: { command: "npm run lint" } } } });
    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  } else if (m.id !== undefined && m.id !== null) { send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } }); }
});
rl.on("close", () => process.exit(0));
`;

test("runAcpProxyCommand captures edits/commands/outcome from a real child stream (compare mode)", async () => {
  await withTempRoot(async (root) => {
    const scriptPath = path.join(root, "capture-agent.mjs");
    await fs.writeFile(scriptPath, CAPTURE_AGENT_SCRIPT, "utf8");
    await fs.chmod(scriptPath, 0o755);

    const input = new PassThrough();
    const output = new PassThrough();
    const outLines = [];
    let buffer = "";
    output.on("data", (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const l = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (l) outLines.push(JSON.parse(l));
      }
    });

    const commandPromise = runAcpProxyCommand(
      root,
      { context: { acpCapture: "compare" } },
      { command: scriptPath, provider: null },
      { input, output, log: () => {}, handleSignals: false, setExitCode: false, env: { PATH: process.env.PATH, AGENT_WORK_DIR: root } },
    );

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: root } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "childsession", prompt: [{ type: "text", text: "go" }] } })}\n`);

    // The client saw the agent's real result unchanged (byte path intact).
    await waitUntil(() => outLines.some((m) => m.id === 3 && m.result));
    assert.equal(outLines.find((m) => m.id === 3).result.stopReason, "end_turn");

    input.end();
    const result = await commandPromise;
    assert.equal(result.capture.mode, "compare");
    assert.equal(result.capture.sink, "compare");

    // Compare mode writes to the side-log, not events.jsonl.
    const captured = await readCaptureLog(root);
    assert.ok(captured.some((e) => e.type === "edit" && e.path === "src/handler.js"), "edit captured from the stream");
    assert.ok(captured.some((e) => e.type === "cmd" && e.cmd === "npm run lint"), "command captured from the stream");
    assert.ok(captured.some((e) => e.type === "session_end" && e.reason === "end_turn"), "outcome captured from the stream");
    assert.equal((await readEvents(root)).length, 0, "compare mode never touches events.jsonl");
  });
});

test("runAcpProxyCommand: a bare --command (no explicit provider) does not inherit the config provider for ownership", async () => {
  await withTempRoot(async (root) => {
    const scriptPath = path.join(root, "capture-agent.mjs");
    await fs.writeFile(scriptPath, CAPTURE_AGENT_SCRIPT, "utf8");
    await fs.chmod(scriptPath, 0o755);
    const input = new PassThrough();
    const output = new PassThrough();
    const outLines = [];
    let buf = "";
    output.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (l) outLines.push(JSON.parse(l));
      }
    });
    // Repo configured for Claude, but a bare --command points at an unknown
    // adapter: ownership must treat it as hookless and capture to the store.
    const commandPromise = runAcpProxyCommand(
      root,
      { provider: "claude", context: { acpCapture: "auto" } },
      { command: scriptPath, provider: null },
      { input, output, log: () => {}, handleSignals: false, setExitCode: false, env: { PATH: process.env.PATH, AGENT_WORK_DIR: root } },
    );
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "childsession", prompt: [{ type: "text", text: "go" }] } })}\n`);
    await waitUntil(() => outLines.some((m) => m.id === 3 && m.result));
    input.end();
    const result = await commandPromise;
    assert.equal(result.capture.sink, "events", "a bare --command is hookless -> captures to the store");
    assert.ok((await readEvents(root)).some((e) => e.type === "edit"));
  });
});

test("runAcpProxyCommand: an EXPLICIT --provider claude keeps a --command out of the main store", async () => {
  await withTempRoot(async (root) => {
    const scriptPath = path.join(root, "capture-agent.mjs");
    await fs.writeFile(scriptPath, CAPTURE_AGENT_SCRIPT, "utf8");
    await fs.chmod(scriptPath, 0o755);
    const input = new PassThrough();
    const output = new PassThrough();
    const outLines = [];
    let buf = "";
    output.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (l) outLines.push(JSON.parse(l));
      }
    });
    const commandPromise = runAcpProxyCommand(
      root,
      { provider: "codex", context: { acpCapture: "auto" } },
      { command: scriptPath, provider: "claude" },
      { input, output, log: () => {}, handleSignals: false, setExitCode: false, env: { PATH: process.env.PATH, AGENT_WORK_DIR: root } },
    );
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "childsession", prompt: [{ type: "text", text: "go" }] } })}\n`);
    await waitUntil(() => outLines.some((m) => m.id === 3 && m.result));
    input.end();
    const result = await commandPromise;
    assert.equal(result.capture.sink, "compare", "explicit --provider claude -> hooks own the store, proxy uses the side-log");
    assert.equal((await readEvents(root)).length, 0);
    assert.ok((await readCaptureLog(root)).some((e) => e.type === "edit"));
  });
});

test("runAcpProxyCommand does not capture when the mode is off (default)", async () => {
  await withTempRoot(async (root) => {
    const scriptPath = path.join(root, "capture-agent.mjs");
    await fs.writeFile(scriptPath, CAPTURE_AGENT_SCRIPT, "utf8");
    await fs.chmod(scriptPath, 0o755);

    const input = new PassThrough();
    const output = new PassThrough();
    output.on("data", () => {});

    const commandPromise = runAcpProxyCommand(
      root,
      {},
      { command: scriptPath, provider: null },
      { input, output, log: () => {}, handleSignals: false, setExitCode: false, env: { PATH: process.env.PATH, AGENT_WORK_DIR: root } },
    );
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "childsession", prompt: [{ type: "text", text: "go" }] } })}\n`);
    await delay(400);
    input.end();
    const result = await commandPromise;
    assert.equal(result.capture.sink, "none");
    assert.equal((await readEvents(root)).length, 0);
    assert.equal((await readCaptureLog(root)).length, 0);
  });
});
