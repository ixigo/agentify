import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { addNote, resolveContextPaths, trackEvent } from "../src/core/ctx.js";
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
  for (const expected of ["ctx_load", "ctx_note", "ctx_match", "query", "risk", "test_select", "ctx_decisions", "ctx_handoff"]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.equal(list.result.tools.length, 8, "expected eight MCP tools");
  assert.ok(list.result.tools.every((tool) => tool.inputSchema?.type === "object"));
  assert.ok(
    list.result.tools.every((tool) => tool.inputSchema?.additionalProperties === false),
    "every tool must set additionalProperties: false",
  );

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

test("ctx_decisions returns matching decisions, a topic miss message, and an empty-store message", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mcp-dec-"));
  try {
    const tools = buildMcpTools(root, {});
    const call = (topic) => handleMcpMessage(tools, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "ctx_decisions", arguments: topic === undefined ? {} : { topic } },
    });

    // Empty store: useful message, never a throw.
    const empty = await call("retry");
    assert.ok(!empty.result.isError);
    assert.match(empty.result.content[0].text, /No decisions recorded for "retry"\./);

    await addNote(root, "chose exponential backoff over fixed delay for retries because it sheds load", { type: "decision" });
    await addNote(root, "chose Postgres over Mongo for the ledger because we need transactions", { type: "decision" });

    const hit = await call("retry backoff");
    assert.ok(!hit.result.isError);
    assert.match(hit.result.content[0].text, /Decisions matching "retry backoff":/);
    assert.match(hit.result.content[0].text, /exponential backoff/);
    assert.doesNotMatch(hit.result.content[0].text, /Postgres/);

    // A topic with no match still returns a useful string, not an error.
    const miss = await call("kubernetes networking");
    assert.ok(!miss.result.isError);
    assert.match(miss.result.content[0].text, /No decisions recorded for "kubernetes networking"\./);

    // No topic lists every recorded decision.
    const all = await call(undefined);
    assert.match(all.result.content[0].text, /Decisions on record:/);
    assert.match(all.result.content[0].text, /exponential backoff/);
    assert.match(all.result.content[0].text, /Postgres/);

    // Malformed (non-string) input is coerced, not thrown.
    const malformed = await handleMcpMessage(tools, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "ctx_decisions", arguments: { topic: 42 } },
    });
    assert.ok(!malformed.result.isError);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ctx_decisions caps both an untargeted listing and a broad topic query, and reports truncation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mcp-cap-"));
  try {
    // Seed the store directly so every decision has a distinct, increasing
    // timestamp and a stable append order the assertions can rely on.
    const notesPath = resolveContextPaths(root).notesPath;
    await fs.mkdir(path.dirname(notesPath), { recursive: true });
    const seeded = [];
    for (let i = 0; i < 60; i += 1) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      seeded.push(JSON.stringify({ ts, type: "decision", note: `chose approach number ${i} over the alternative because reason ${i}` }));
    }
    await fs.writeFile(notesPath, `${seeded.join("\n")}\n`, "utf8");
    const tools = buildMcpTools(root, {});

    // Untargeted listing is bounded and points the caller at the topic filter.
    const all = await handleMcpMessage(tools, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "ctx_decisions", arguments: {} },
    });
    const allText = all.result.content[0].text;
    assert.match(allText, /and 10 more not shown; pass a topic to narrow\./);
    // Kept the most recent entries (…59) and dropped the oldest (0).
    assert.match(allText, /approach number 59\b/);
    assert.doesNotMatch(allText, /approach number 0\b/);
    assert.equal(allText.split("\n").filter((line) => line.startsWith("- ")).length, 50);

    // A broad topic that matches every decision is capped too, keeping the
    // head of listDecisions' order and reporting how many more matched.
    const hit = await handleMcpMessage(tools, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "ctx_decisions", arguments: { topic: "approach alternative reason" } },
    });
    const hitText = hit.result.content[0].text;
    assert.match(hitText, /Decisions matching "approach alternative reason":/);
    assert.match(hitText, /and 10 more match; refine the topic to narrow\./);
    assert.equal(hitText.split("\n").filter((line) => line.startsWith("- ")).length, 50);
    // listDecisions ranks by relevance and keeps ties in append order (left
    // unchanged by #332); every decision ties here, so the renderer keeps the
    // head — the first 50 (0…49) — and drops the last 10 (50…59).
    assert.match(hitText, /approach number 0\b/);
    assert.match(hitText, /approach number 49\b/);
    assert.doesNotMatch(hitText, /approach number 59\b/);
    assert.doesNotMatch(hitText, /approach number 50\b/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ctx_handoff writes a handoff file and confirms what it wrote", async () => {
  const root = await withContextFixture();
  try {
    const tools = buildMcpTools(root, {});
    const handoff = await handleMcpMessage(tools, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "ctx_handoff", arguments: { task: "wrapping up the payment retry work" } },
    });
    assert.ok(!handoff.result.isError);
    const text = handoff.result.content[0].text;
    assert.match(text, /Handoff written to/);
    assert.match(text, /wrapping up the payment retry work/);

    // The confirmed path points at a file that actually exists on disk.
    const relativePath = text.split("\n")[0].replace(/^Handoff written to /, "").replace(/:$/, "");
    const written = await fs.readFile(path.join(root, relativePath), "utf8");
    assert.match(written, /Agentify handoff/);

    // Missing task argument must not throw.
    const noTask = await handleMcpMessage(tools, {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "ctx_handoff", arguments: {} },
    });
    assert.ok(!noTask.result.isError);
    assert.match(noTask.result.content[0].text, /Handoff written to/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ctx_handoff bounds its inline preview while persisting the full handoff to disk", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mcp-ho-"));
  try {
    // Seed enough large notes that the rendered digest far exceeds the preview.
    const notesPath = resolveContextPaths(root).notesPath;
    await fs.mkdir(path.dirname(notesPath), { recursive: true });
    const seeded = [];
    for (let i = 0; i < 60; i += 1) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      seeded.push(JSON.stringify({ ts, note: `note ${i} ${"x".repeat(2000)}` }));
    }
    await fs.writeFile(notesPath, `${seeded.join("\n")}\n`, "utf8");

    const tools = buildMcpTools(root, {});
    const handoff = await handleMcpMessage(tools, {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "ctx_handoff", arguments: { task: "long task" } },
    });
    const text = handoff.result.content[0].text;
    assert.ok(!handoff.result.isError);
    assert.match(text, /truncated; full handoff saved to/);
    assert.ok(text.length < 2400, `inline preview not bounded: ${text.length}`);

    // The file on disk holds the complete, un-truncated handoff.
    const relativePath = text.split("\n")[0].replace(/^Handoff written to /, "").replace(/:$/, "");
    const written = await fs.readFile(path.join(root, relativePath), "utf8");
    assert.ok(written.length > 10000, `persisted handoff unexpectedly small: ${written.length}`);
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
