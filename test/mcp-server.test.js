import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { addNote, trackEvent } from "../src/core/ctx.js";
import { buildMcpTools, handleMcpMessage, runMcpServer } from "../src/core/mcp-server.js";

async function withContextFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mcp-"));
  await fs.mkdir(path.join(root, "src/pay"), { recursive: true });
  await fs.writeFile(path.join(root, "src/pay/retry.ts"), "export const retry = true;\n", "utf8");
  await addNote(root, "payment retries idempotency key lives in src/pay/retry.ts");
  await trackEvent(root, {
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: path.join(root, "src/pay/retry.ts") },
  });
  return root;
}

test("initialize, tools/list, and ping follow the MCP handshake", async () => {
  const tools = buildMcpTools("/tmp/nowhere", {});

  const init = await handleMcpMessage(tools, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test" } },
  });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "agentify");
  assert.ok(init.result.capabilities.tools);

  const initialized = await handleMcpMessage(tools, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(initialized, null);

  const list = await handleMcpMessage(tools, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = list.result.tools.map((tool) => tool.name);
  for (const expected of ["ctx_load", "ctx_note", "ctx_match", "query", "risk", "test_select"]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.ok(list.result.tools.every((tool) => tool.inputSchema?.type === "object"));

  const ping = await handleMcpMessage(tools, { jsonrpc: "2.0", id: 3, method: "ping" });
  assert.deepEqual(ping.result, {});

  const unknown = await handleMcpMessage(tools, { jsonrpc: "2.0", id: 4, method: "bogus/method" });
  assert.equal(unknown.error.code, -32601);
});

test("tools/call runs ctx tools against the store", async () => {
  const root = await withContextFixture();
  try {
    const tools = buildMcpTools(root, {});

    const load = await handleMcpMessage(tools, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "ctx_load", arguments: {} },
    });
    assert.match(load.result.content[0].text, /payment retries/);

    const note = await handleMcpMessage(tools, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "ctx_note", arguments: { text: "gateway timeout is 30s" } },
    });
    assert.match(note.result.content[0].text, /gateway timeout/);

    const match = await handleMcpMessage(tools, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "ctx_match", arguments: { task: "fix the payment retries double charge" } },
    });
    assert.match(match.result.content[0].text, /payment retries/);

    const unknownTool = await handleMcpMessage(tools, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    assert.equal(unknownTool.error.code, -32602);

    // Handler errors surface as isError results, not protocol errors.
    const failed = await handleMcpMessage(tools, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "query", arguments: { kind: "search" } },
    });
    assert.equal(failed.result.isError, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runMcpServer speaks newline-delimited JSON-RPC over streams", async () => {
  const root = await withContextFixture();
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks = [];
    output.on("data", (chunk) => chunks.push(chunk.toString()));

    const serverDone = runMcpServer(root, {}, { input, output });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write("this is not json\n");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ctx_load", arguments: {} } })}\n`);
    input.end();
    await serverDone;

    const responses = chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(responses.length, 3);
    assert.equal(responses[0].id, 1);
    assert.equal(responses[1].error.code, -32700);
    assert.equal(responses[2].id, 2);
    assert.match(responses[2].result.content[0].text, /payment retries/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
