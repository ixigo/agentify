import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Transform, Writable } from "node:stream";

import { RequestError, agent, client, ndJsonStream } from "@agentclientprotocol/sdk";

import {
  ACP_PROTOCOL_VERSION,
  createAcpProxy,
  resolveDownstreamAdapter,
  runAcpProxyCommand,
} from "../src/core/acp/index.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, { timeout = 2000, interval = 5 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("waitUntil timed out");
    }
    await delay(interval);
  }
}

// Identity parser: register SDK handlers without ACP schema validation so tests
// exercise raw JSON-RPC forwarding rather than a specific schema revision.
const raw = (params) => params;

// Pass bytes through a Node stream unchanged while recording each complete
// newline-delimited JSON message, so tests can assert what crossed the wire.
function tap(source, onMessage) {
  const decoder = new TextDecoder();
  let buffer = "";
  const transform = new Transform({
    transform(chunk, _enc, callback) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            onMessage(JSON.parse(line));
          } catch {
            // Not our concern here; the connection layer validates.
          }
        }
      }
      callback(null, chunk);
    },
  });
  source.pipe(transform);
  return transform;
}

function channel() {
  return new PassThrough();
}

// Read from a Node Readable until a newline, returning the decoded line
// (including the trailing newline).
async function readLine(readable) {
  let buffer = "";
  for await (const chunk of readable) {
    buffer += chunk.toString();
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      return buffer.slice(0, newline + 1);
    }
  }
  return buffer;
}

// Wire an in-memory proxy with two byte pipes, tapping every wire message in
// all four directions so tests can assert byte-identity across the proxy. The
// proxy runs on Node streams; the SDK test peers are bridged to Web streams.
function wireProxy() {
  const captures = { clientToProxy: [], proxyToClient: [], proxyToDownstream: [], downstreamToProxy: [] };

  const c2p = channel(); // client -> proxy
  const p2c = channel(); // proxy -> client
  const d2p = channel(); // downstream -> proxy
  const p2d = channel(); // proxy -> downstream

  const proxy = createAcpProxy({
    client: { readable: tap(c2p, (m) => captures.clientToProxy.push(m)), writable: p2c },
    downstream: { readable: tap(d2p, (m) => captures.downstreamToProxy.push(m)), writable: p2d },
  });

  const testClientStream = ndJsonStream(Writable.toWeb(c2p), Readable.toWeb(tap(p2c, (m) => captures.proxyToClient.push(m))));
  const testDownstreamStream = ndJsonStream(Writable.toWeb(d2p), Readable.toWeb(tap(p2d, (m) => captures.proxyToDownstream.push(m))));

  return { proxy, captures, testClientStream, testDownstreamStream, channels: { c2p, p2c, d2p, p2d } };
}

const findRequest = (messages, method) => messages.find((m) => m.method === method && "id" in m);
const findResponse = (messages, id) => messages.find((m) => !("method" in m) && m.id === id);

test("golden transcript: a full session forwards every message unchanged in both directions", async () => {
  const wired = wireProxy();
  const { proxy, captures, testClientStream, testDownstreamStream } = wired;

  const INITIALIZE = { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true } } };
  const NEW_SESSION = { cwd: "/repo", mcpServers: [] };
  const PROMPT = { sessionId: "sess-1", prompt: [{ type: "text", text: "add a test" }] };
  const PERMISSION_REQUEST = {
    sessionId: "sess-1",
    toolCall: { toolCallId: "tc-1", title: "Write file", kind: "edit" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  };
  const PERMISSION_RESULT = { outcome: { outcome: "selected", optionId: "allow" } };
  const UPDATE_TOOL = { sessionId: "sess-1", update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Write file", kind: "edit", status: "pending" } };
  const UPDATE_DONE = { sessionId: "sess-1", update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } };
  const AGENT_CAPS = { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: { promptCapabilities: { image: false } } };

  // Downstream agent.
  const downstreamSeen = { initialize: null, prompt: null, permissionResult: null };
  const downstreamApp = agent({ name: "test-downstream" });
  downstreamApp.onRequest("initialize", raw, (ctx) => {
    downstreamSeen.initialize = ctx.params;
    return AGENT_CAPS;
  });
  downstreamApp.onRequest("session/new", raw, () => ({ sessionId: "sess-1" }));
  downstreamApp.onRequest("session/prompt", raw, async (ctx) => {
    downstreamSeen.prompt = ctx.params;
    await ctx.client.notify("session/update", UPDATE_TOOL);
    downstreamSeen.permissionResult = await ctx.client.request("session/request_permission", PERMISSION_REQUEST);
    await ctx.client.notify("session/update", UPDATE_DONE);
    return { stopReason: "end_turn" };
  });
  const downstreamConn = downstreamApp.connect(testDownstreamStream);

  // Client (editor).
  const clientSeen = { updates: [], permission: null };
  const clientApp = client({ name: "test-client" });
  clientApp.onNotification("session/update", raw, (ctx) => {
    clientSeen.updates.push(ctx.params);
  });
  clientApp.onRequest("session/request_permission", raw, (ctx) => {
    clientSeen.permission = ctx.params;
    return PERMISSION_RESULT;
  });
  const clientConn = clientApp.connect(testClientStream);
  const agentCtx = clientConn.agent;

  try {
    const initializeResult = await agentCtx.request("initialize", INITIALIZE);
    const newSessionResult = await agentCtx.request("session/new", NEW_SESSION);
    const promptResult = await agentCtx.request("session/prompt", PROMPT);
    await waitUntil(() => clientSeen.updates.length === 2);

    // Requests forwarded client -> downstream, unchanged.
    assert.deepEqual(downstreamSeen.initialize, INITIALIZE);
    assert.deepEqual(downstreamSeen.prompt, PROMPT);

    // Responses forwarded downstream -> client, unchanged.
    assert.deepEqual(initializeResult, AGENT_CAPS);
    assert.deepEqual(newSessionResult, { sessionId: "sess-1" });
    assert.deepEqual(promptResult, { stopReason: "end_turn" });

    // Client -> agent request (permission) forwarded unchanged both ways.
    assert.deepEqual(clientSeen.permission, PERMISSION_REQUEST);
    assert.deepEqual(downstreamSeen.permissionResult, PERMISSION_RESULT);

    // Notifications forwarded downstream -> client, unchanged and in order.
    assert.deepEqual(clientSeen.updates, [UPDATE_TOOL, UPDATE_DONE]);

    // The proxy relayed the whole known method set without any bespoke logic.
    assert.ok(findRequest(captures.proxyToDownstream, "initialize"));
    assert.ok(findRequest(captures.proxyToDownstream, "session/prompt"));
    assert.ok(findRequest(captures.proxyToClient, "session/request_permission"));
  } finally {
    proxy.close();
    clientConn.close();
    downstreamConn.close();
  }
});

test("approval traffic is forwarded byte-identically across the proxy", async () => {
  const wired = wireProxy();
  const { proxy, captures, testClientStream, testDownstreamStream } = wired;

  const PERMISSION_REQUEST = {
    sessionId: "sess-approval",
    toolCall: { toolCallId: "danger-1", title: "rm -rf /tmp/thing", kind: "execute" },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
    _meta: { vendor: { risk: "high" } },
  };
  const PERMISSION_RESULT = { outcome: { outcome: "selected", optionId: "reject" }, _meta: { audited: true } };

  const downstreamApp = agent({ name: "test-downstream" });
  let decisionSeenByDownstream = null;
  downstreamApp.onRequest("initialize", raw, () => ({ protocolVersion: ACP_PROTOCOL_VERSION }));
  downstreamApp.onRequest("session/new", raw, () => ({ sessionId: "sess-approval" }));
  downstreamApp.onRequest("session/prompt", raw, async (ctx) => {
    decisionSeenByDownstream = await ctx.client.request("session/request_permission", PERMISSION_REQUEST);
    return { stopReason: "end_turn" };
  });
  const downstreamConn = downstreamApp.connect(testDownstreamStream);

  const clientApp = client({ name: "test-client" });
  clientApp.onRequest("session/request_permission", raw, () => PERMISSION_RESULT);
  const clientConn = clientApp.connect(testClientStream);

  try {
    await clientConn.agent.request("initialize", {});
    await clientConn.agent.request("session/new", { cwd: "/repo" });
    await clientConn.agent.request("session/prompt", { sessionId: "sess-approval", prompt: [] });

    // The downstream received exactly the decision the client made.
    assert.deepEqual(decisionSeenByDownstream, PERMISSION_RESULT);

    // Wire-level: the permission request params are byte-identical on both hops
    // (downstream -> proxy and proxy -> client), and so is the decision result.
    const reqToClient = findRequest(captures.proxyToClient, "session/request_permission");
    const reqFromDownstream = findRequest(captures.downstreamToProxy, "session/request_permission");
    assert.ok(reqToClient && reqFromDownstream);
    assert.equal(JSON.stringify(reqToClient.params), JSON.stringify(reqFromDownstream.params));
    assert.equal(JSON.stringify(reqToClient.params), JSON.stringify(PERMISSION_REQUEST));

    const resultFromClient = findResponse(captures.clientToProxy, reqToClient.id);
    const resultToDownstream = findResponse(captures.proxyToDownstream, reqFromDownstream.id);
    assert.ok(resultFromClient && resultToDownstream);
    assert.equal(JSON.stringify(resultFromClient.result), JSON.stringify(resultToDownstream.result));
    assert.equal(JSON.stringify(resultToDownstream.result), JSON.stringify(PERMISSION_RESULT));
  } finally {
    proxy.close();
    clientConn.close();
    downstreamConn.close();
  }
});

test("unknown/vendor extension methods pass through untouched, including errors", async () => {
  const wired = wireProxy();
  const { proxy, captures, testClientStream, testDownstreamStream } = wired;

  // `_vendor/echo` is NOT in the ACP method tables. A method-aware proxy would
  // reject it with -32601; a transparent relay forwards it so the downstream
  // decides. This is the epic's "forward unknown methods untouched" constraint.
  const ECHO = { note: "extension", nested: { deep: [1, 2, 3] }, when: 42 };
  const downstreamApp = agent({ name: "test-downstream" });
  let echoSeen = null;
  downstreamApp.onRequest("_vendor/echo", raw, (ctx) => {
    echoSeen = ctx.params;
    return { echoed: ctx.params };
  });
  // A downstream that rejects with a structured JSON-RPC error.
  downstreamApp.onRequest("session/new", raw, () => {
    throw new RequestError(-32000, "auth required", { reason: "login" });
  });
  const downstreamConn = downstreamApp.connect(testDownstreamStream);

  const clientApp = client({ name: "test-client" });
  const clientConn = clientApp.connect(testClientStream);

  try {
    const echoResult = await clientConn.agent.request("_vendor/echo", ECHO);
    assert.deepEqual(echoSeen, ECHO);
    assert.deepEqual(echoResult, { echoed: ECHO });

    // The extension request and its response are byte-identical across the proxy.
    const reqToDownstream = findRequest(captures.proxyToDownstream, "_vendor/echo");
    const reqFromClient = findRequest(captures.clientToProxy, "_vendor/echo");
    assert.ok(reqToDownstream && reqFromClient);
    assert.equal(JSON.stringify(reqToDownstream.params), JSON.stringify(ECHO));
    // Ids are preserved verbatim (no remapping) by the relay.
    assert.equal(reqToDownstream.id, reqFromClient.id);

    // Error responses are relayed with code and data intact.
    await assert.rejects(
      clientConn.agent.request("session/new", { cwd: "/repo" }),
      (error) => {
        assert.equal(error.code, -32000);
        assert.deepEqual(error.data, { reason: "login" });
        return true;
      },
    );
  } finally {
    proxy.close();
    clientConn.close();
    downstreamConn.close();
  }
});

test("cancellation threads through the proxy to the downstream", async () => {
  const wired = wireProxy();
  const { proxy, testClientStream, testDownstreamStream } = wired;

  const downstreamApp = agent({ name: "test-downstream" });
  const downstreamState = { promptStarted: false, sawAbort: false };
  downstreamApp.onRequest("session/prompt", raw, (ctx) => {
    downstreamState.promptStarted = true;
    return new Promise((resolve) => {
      ctx.signal.addEventListener("abort", () => {
        downstreamState.sawAbort = true;
        resolve({ stopReason: "cancelled" });
      });
    });
  });
  const downstreamConn = downstreamApp.connect(testDownstreamStream);

  const clientApp = client({ name: "test-client" });
  const clientConn = clientApp.connect(testClientStream);

  try {
    const controller = new AbortController();
    const promptPromise = clientConn.agent.request(
      "session/prompt",
      { sessionId: "s", prompt: [] },
      { cancellationSignal: controller.signal },
    );
    await waitUntil(() => downstreamState.promptStarted);
    controller.abort();
    const result = await promptPromise;

    assert.equal(downstreamState.sawAbort, true);
    assert.deepEqual(result, { stopReason: "cancelled" });
  } finally {
    proxy.close();
    clientConn.close();
    downstreamConn.close();
  }
});

test("client disconnect tears the proxy down", async () => {
  const wired = wireProxy();
  const { proxy, testClientStream, testDownstreamStream, channels } = wired;

  const downstreamApp = agent({ name: "test-downstream" });
  downstreamApp.onRequest("initialize", raw, () => ({ protocolVersion: ACP_PROTOCOL_VERSION }));
  const downstreamConn = downstreamApp.connect(testDownstreamStream);

  const clientApp = client({ name: "test-client" });
  const clientConn = clientApp.connect(testClientStream);

  await clientConn.agent.request("initialize", {});
  // Simulate the client closing its output stream (stdin EOF for a real proxy).
  channels.c2p.end();

  // The proxy must observe the disconnect and shut down without hanging, and
  // attribute the end to the client (a clean disconnect, not a failure).
  const { endedBy } = await proxy.closed;
  assert.equal(endedBy, "client");

  downstreamConn.close();
});

test("a downstream crash surfaces a clear error to an in-flight request instead of hanging", async () => {
  const wired = wireProxy();
  const { proxy, testClientStream, testDownstreamStream, channels } = wired;

  const downstreamApp = agent({ name: "test-downstream" });
  const downstreamState = { promptStarted: false };
  // Never responds — the request is in flight when the downstream dies.
  downstreamApp.onRequest("session/prompt", raw, () => {
    downstreamState.promptStarted = true;
    return new Promise(() => {});
  });
  const downstreamConn = downstreamApp.connect(testDownstreamStream);

  const clientApp = client({ name: "test-client" });
  const clientConn = clientApp.connect(testClientStream);

  try {
    const promptPromise = clientConn.agent.request("session/prompt", { sessionId: "s", prompt: [] });
    // Swallow late rejection races if the assertion path settles first.
    promptPromise.catch(() => {});
    await waitUntil(() => downstreamState.promptStarted);

    // Simulate the downstream process crashing: its output stream ends.
    channels.d2p.end();

    await assert.rejects(promptPromise, (error) => {
      assert.ok(error instanceof Error);
      return true;
    });
    const { endedBy } = await proxy.closed;
    assert.equal(endedBy, "downstream");
  } finally {
    proxy.close();
    clientConn.close();
    downstreamConn.close();
  }
});

test("the byte relay forwards exact bytes, including JSON-RPC ids beyond 2^53", async () => {
  const c2p = channel();
  const p2c = channel();
  const d2p = channel();
  const p2d = channel();
  const proxy = createAcpProxy({
    client: { readable: c2p, writable: p2c },
    downstream: { readable: d2p, writable: p2d },
  });

  try {
    // A parse+reserialize relay would round 9007199254740993 -> ...992 and
    // reformat the oversized params number; the byte relay must not touch them.
    const clientLine = '{"jsonrpc":"2.0","id":9007199254740993,"method":"session/prompt","params":{"big":10000000000000001}}\n';
    c2p.write(clientLine);
    assert.equal(await readLine(p2d), clientLine);

    // And the reverse direction (downstream -> client), e.g. an approval result.
    const downstreamLine = '{"jsonrpc":"2.0","id":9007199254740993,"result":{"outcome":{"outcome":"selected","optionId":"allow"}}}\n';
    d2p.write(downstreamLine);
    assert.equal(await readLine(p2c), downstreamLine);
  } finally {
    proxy.close();
    await proxy.closed;
  }
});

test("a destination stream error tears the proxy down instead of crashing the process", async () => {
  const c2p = channel();
  const d2p = channel();
  const p2d = channel();
  // A client output that fails every write (e.g. a broken pipe to the editor).
  const badClientWritable = new Writable({
    write(_chunk, _enc, callback) {
      callback(new Error("EPIPE-ish write failure"));
    },
  });
  const proxy = createAcpProxy({
    client: { readable: c2p, writable: badClientWritable },
    downstream: { readable: d2p, writable: p2d },
  });

  // Downstream sends something the proxy must forward to the failing client
  // writable; the error must resolve `closed`, not throw an unhandled 'error'.
  d2p.write('{"jsonrpc":"2.0","method":"session/update","params":{}}\n');
  const { endedBy } = await proxy.closed;
  assert.equal(endedBy, "client");
  proxy.close();
});

test("a destination writable closing without error still tears the proxy down", async () => {
  const c2p = channel();
  const p2c = channel();
  const d2p = channel();
  // The downstream's stdin closes on its own while its readable stays open —
  // the proxy must still notice and shut down rather than hang.
  const downstreamWritable = new PassThrough();
  const proxy = createAcpProxy({
    client: { readable: c2p, writable: p2c },
    downstream: { readable: d2p, writable: downstreamWritable },
  });

  downstreamWritable.destroy();
  const { endedBy } = await proxy.closed;
  assert.equal(endedBy, "downstream");
  proxy.close();
});

test("resolveDownstreamAdapter reads argv from the provider registry and honors overrides", () => {
  const claude = resolveDownstreamAdapter("claude");
  assert.equal(claude.command, "claude-agent-acp");
  assert.deepEqual(claude.args, []);
  assert.equal(claude.source, "registry");

  const codex = resolveDownstreamAdapter("codex");
  assert.equal(codex.command, "codex-acp");
  assert.deepEqual(codex.args, []);
  assert.equal(codex.source, "registry");

  const override = resolveDownstreamAdapter("claude", { command: "/opt/my-acp", extraArgs: ["--flag"] });
  assert.equal(override.command, "/opt/my-acp");
  assert.deepEqual(override.args, ["--flag"]);
  assert.equal(override.source, "override");

  assert.throws(() => resolveDownstreamAdapter("local"), /no ACP adapter/);
  assert.throws(() => resolveDownstreamAdapter(null), /downstream provider/);
});

test("runAcpProxyCommand rejects a malformed --command instead of silently ignoring it", async () => {
  // Bare flag (true), empty string, and parser-coerced falsy values must all be
  // rejected rather than silently falling back to the configured provider.
  for (const bad of [true, "", "   ", false, 0]) {
    await assert.rejects(
      runAcpProxyCommand(process.cwd(), { provider: "codex" }, { command: bad, provider: "codex" }, {
        input: new PassThrough(),
        output: new PassThrough(),
        log: () => {},
        handleSignals: false,
        setExitCode: false,
      }),
      /--command requires a non-empty value/,
    );
  }
});

test("runAcpProxyCommand proxies a full session to a real child adapter and cleans it up", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-acp-"));
  const scriptPath = path.join(dir, "fake-acp-agent.mjs");
  await fs.writeFile(scriptPath, FAKE_AGENT_SCRIPT, "utf8");
  await fs.chmod(scriptPath, 0o755);
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputLines = [];
    let outputBuffer = "";
    output.on("data", (chunk) => {
      outputBuffer += chunk.toString();
      let newline;
      while ((newline = outputBuffer.indexOf("\n")) >= 0) {
        const line = outputBuffer.slice(0, newline).trim();
        outputBuffer = outputBuffer.slice(newline + 1);
        if (line) {
          outputLines.push(JSON.parse(line));
        }
      }
    });

    let child = null;
    const commandPromise = runAcpProxyCommand(
      dir,
      { provider: "local" },
      { command: scriptPath, provider: null },
      {
        input,
        output,
        log: () => {},
        handleSignals: false,
        setExitCode: false,
        onSpawn: (spawned) => { child = spawned; },
      },
    );

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: ACP_PROTOCOL_VERSION } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: dir } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "child-sess", prompt: [] } })}\n`);

    await waitUntil(() => outputLines.length >= 3, { timeout: 5000 });

    const byId = Object.fromEntries(outputLines.map((m) => [m.id, m]));
    assert.equal(byId[1].result.protocolVersion, ACP_PROTOCOL_VERSION);
    assert.equal(byId[2].result.sessionId, "child-sess");
    assert.equal(byId[3].result.stopReason, "end_turn");

    // Client disconnects: the proxy must terminate the child and resolve.
    input.end();
    const result = await commandPromise;
    assert.equal(result.protocol_version, ACP_PROTOCOL_VERSION);
    assert.ok(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "child process was cleaned up");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runAcpProxyCommand reports failure when the downstream closes its transport but stays alive", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-acp-"));
  const scriptPath = path.join(dir, "stdout-closer.mjs");
  await fs.writeFile(scriptPath, STDOUT_CLOSER_SCRIPT, "utf8");
  await fs.chmod(scriptPath, 0o755);
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    let child = null;
    const result = await runAcpProxyCommand(
      dir,
      { provider: "local" },
      { command: scriptPath, provider: null },
      {
        input,
        output,
        log: () => {},
        handleSignals: false,
        setExitCode: false,
        onSpawn: (spawned) => { child = spawned; },
      },
    );
    // The adapter's stdout EOF is a mid-session transport failure even though it
    // exited 0 (or was terminated); it must not be reported as success.
    assert.equal(result.ended_by, "downstream");
    assert.equal(result.failed, true);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "lingering child was terminated");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runAcpProxyCommand fails loudly when the downstream adapter cannot be launched", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const logs = [];
  const result = await runAcpProxyCommand(
    process.cwd(),
    { provider: "local" },
    { command: "agentify-nonexistent-acp-adapter-xyz", provider: null },
    {
      input,
      output,
      log: (message) => logs.push(message),
      handleSignals: false,
      setExitCode: false,
    },
  );
  assert.equal(result.failed, true);
  assert.ok(logs.some((line) => /could not run/.test(line)), "should log a clear launch failure");
});

// A dependency-free ACP-ish agent: reads newline-delimited JSON-RPC on stdin,
// answers initialize/session/new/session/prompt, and exits on stdin EOF.
const FAKE_AGENT_SCRIPT = `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try { message = JSON.parse(trimmed); } catch { return; }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: ${ACP_PROTOCOL_VERSION}, agentCapabilities: {} } });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "child-sess" } });
  } else if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  } else if (message.id !== undefined && message.id !== null) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
});
rl.on("close", () => process.exit(0));
`;

// An adapter that closes its stdout (transport dies) but keeps its process
// alive — the P1 mid-session transport failure the proxy must not treat as a
// success. Stays alive via a timer until the proxy terminates it.
const STDOUT_CLOSER_SCRIPT = `#!/usr/bin/env node
process.stdout.end();
setInterval(() => {}, 1000);
`;
