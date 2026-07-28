import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

// An Agentify-initialized git repo: .agentify/ is already gitignored and
// committed, so auto-building the index writes nothing git tracks.
async function initAgentifyGitRepo(root) {
  await fs.writeFile(path.join(root, ".gitignore"), ".agentify/\n", "utf8");
  await initGitRepo(root);
}

import { runScan } from "../src/core/commands.js";
import { loadConfig } from "../src/core/config.js";
import { addNote, resolveContextPaths, trackEvent } from "../src/core/ctx.js";
import { buildMcpTools, handleMcpMessage, runMcpServer } from "../src/core/mcp-server.js";

async function withSourceRepo(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "station.ts"),
    "export function findMetroStation(query) { return query.trim(); }\n",
    "utf8",
  );
  return root;
}

async function callQuery(tools, args) {
  return handleMcpMessage(tools, {
    jsonrpc: "2.0",
    id: 42,
    method: "tools/call",
    params: { name: "query", arguments: args },
  });
}

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

test("query builds a missing index in-place and leaves the working tree clean", async () => {
  const root = await withSourceRepo("agentify-mcp-query-missing-");
  try {
    await initAgentifyGitRepo(root);
    const config = await loadConfig(root, { provider: "local", dryRun: false });
    const tools = buildMcpTools(root, config);

    const dbPath = path.join(root, ".agentify", "index.db");
    const beforeExists = await fs.access(dbPath).then(() => true).catch(() => false);
    assert.equal(beforeExists, false, "precondition: no index yet");

    const response = await callQuery(tools, { kind: "search", term: "findMetroStation" });
    assert.notEqual(response.result.isError, true, "missing index should self-heal, not error");

    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload._agentify_index.status, "rebuilt");
    assert.ok(Array.isArray(payload.files) || Array.isArray(payload.symbols));

    const afterExists = await fs.access(dbPath).then(() => true).catch(() => false);
    assert.equal(afterExists, true, "auto-scan should have written the index");

    // The auto-heal is a read-style operation: in an initialized repo it writes
    // only the (gitignored) index and touches no tracked file. git status must
    // be completely clean — no repo map, no policy files, no untracked .agentify.
    const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: root });
    assert.equal(status.stdout.trim(), "", `auto-heal dirtied the working tree:\n${status.stdout}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a normal scan regenerates the repo map after an index-only auto-heal", async () => {
  const root = await withSourceRepo("agentify-mcp-scan-repomap-");
  try {
    const config = await loadConfig(root, { provider: "local", dryRun: false });
    // Simulate the MCP auto-heal: an index-only build with no repo map.
    await runScan(root, config, { skipOutput: true, skipFinalize: true, indexOnly: true, force: true, reset: true });
    const repoMapPath = path.join(root, "docs", "repo-map.md");
    assert.equal(
      await fs.access(repoMapPath).then(() => true).catch(() => false),
      false,
      "index-only build must not write the repo map",
    );

    // A subsequent normal scan reuses the warm index but must still create the
    // missing map rather than leave it absent forever.
    await runScan(root, config, { skipOutput: true, skipFinalize: true });
    assert.equal(
      await fs.access(repoMapPath).then(() => true).catch(() => false),
      true,
      "normal scan must regenerate a missing repo map even on a warm index",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("query refuses to auto-build when it would dirty an uninitialized git repo", async () => {
  const root = await withSourceRepo("agentify-mcp-query-uninit-");
  try {
    // Git repo with no .gitignore for .agentify/: building here would create
    // untracked files or force a tracked .gitignore change.
    await initGitRepo(root);
    const config = await loadConfig(root, { provider: "local", dryRun: false });
    const tools = buildMcpTools(root, config);

    const response = await callQuery(tools, { kind: "search", term: "findMetroStation" });
    assert.notEqual(response.result.isError, true, "should degrade to an instruction, not throw");
    assert.match(response.result.content[0].text, /agentify scan/);

    const dbExists = await fs.access(path.join(root, ".agentify", "index.db")).then(() => true).catch(() => false);
    assert.equal(dbExists, false, "must not build an index that would dirty git");

    const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: root });
    assert.equal(status.stdout.trim(), "", "must not modify the working tree when refusing");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("query flags a git-detected stale index after a source edit", async () => {
  const root = await withSourceRepo("agentify-mcp-query-git-stale-");
  try {
    await initGitRepo(root);
    const config = await loadConfig(root, { provider: "local", dryRun: false });
    await runScan(root, config, { skipOutput: true, skipFinalize: true });

    // Modify tracked source so git-based freshness reports the index as stale.
    await fs.writeFile(
      path.join(root, "src", "station.ts"),
      "export function findMetroStation(query) { return query.trim().toLowerCase(); }\n",
      "utf8",
    );

    const tools = buildMcpTools(root, config);
    const response = await callQuery(tools, { kind: "search", term: "findMetroStation" });
    assert.notEqual(response.result.isError, true, "stale index should still answer");

    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload._agentify_index.status, "stale");
    assert.ok(payload._agentify_index.changed_files >= 1, "should report at least one changed file");
    assert.match(payload._agentify_index.note, /stale/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("query answers from a stale index and attaches an explicit staleness note", async () => {
  const root = await withSourceRepo("agentify-mcp-query-stale-");
  try {
    const config = await loadConfig(root, { provider: "local", dryRun: false });
    await runScan(root, config, { skipOutput: true, skipFinalize: true });

    // Drop the index metadata so freshness reports the index as stale while the
    // structural database itself is still queryable.
    await fs.rm(path.join(root, ".agentify", "index.meta.json"), { force: true });

    const tools = buildMcpTools(root, config);
    const response = await callQuery(tools, { kind: "search", term: "findMetroStation" });
    assert.notEqual(response.result.isError, true, "stale index should still answer");

    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload._agentify_index.status, "stale");
    assert.equal(payload._agentify_index.stale_reason, "missing_meta");
    assert.match(payload._agentify_index.note, /stale/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("query rebuilds and answers when the existing index is unreadable", async () => {
  const root = await withSourceRepo("agentify-mcp-query-unreadable-");
  try {
    const config = await loadConfig(root, { provider: "local", dryRun: false });
    await runScan(root, config, { skipOutput: true, skipFinalize: true });

    // Corrupt the database so opening it throws (mirrors a schema mismatch after
    // an Agentify upgrade). Freshness may still report it as warm.
    const dbPath = path.join(root, ".agentify", "index.db");
    await fs.writeFile(dbPath, "not a sqlite database\n", "utf8");

    const tools = buildMcpTools(root, config);
    const response = await callQuery(tools, { kind: "search", term: "findMetroStation" });
    assert.notEqual(response.result.isError, true, "an unreadable index should be rebuilt, not error");

    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload._agentify_index.status, "rebuilt");
    assert.ok(Array.isArray(payload.files) || Array.isArray(payload.symbols));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("query force-rebuilds a structurally incomplete index (missing search table)", async () => {
  const root = await withSourceRepo("agentify-mcp-query-incomplete-");
  try {
    const config = await loadConfig(root, { provider: "local", dryRun: false });
    await runScan(root, config, { skipOutput: true, skipFinalize: true });

    // Drop the search table directly so repo_meta stays intact (freshness reads
    // "warm") but `search` fails at query time — a logically incomplete index.
    const dbPath = path.join(root, ".agentify", "index.db");
    const Database = require("better-sqlite3");
    const raw = new Database(dbPath);
    raw.exec("DROP TABLE IF EXISTS query_search_fts");
    raw.close();

    const tools = buildMcpTools(root, config);
    const response = await callQuery(tools, { kind: "search", term: "findMetroStation" });
    assert.notEqual(response.result.isError, true, "an incomplete index should be rebuilt, not error");

    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload._agentify_index.status, "rebuilt");
    assert.ok(Array.isArray(payload.files) || Array.isArray(payload.symbols));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("query resets and rebuilds an index whose table is missing a column", async () => {
  const root = await withSourceRepo("agentify-mcp-query-dropcol-");
  try {
    const config = await loadConfig(root, { provider: "local", dryRun: false });
    await runScan(root, config, { skipOutput: true, skipFinalize: true });

    // Drop a column so the schema version still matches but queries selecting it
    // fail — CREATE TABLE IF NOT EXISTS cannot restore it, so recovery must wipe
    // and rebuild the derived database.
    const dbPath = path.join(root, ".agentify", "index.db");
    const Database = require("better-sqlite3");
    const raw = new Database(dbPath);
    raw.exec("ALTER TABLE symbols DROP COLUMN exported");
    raw.close();

    const tools = buildMcpTools(root, config);
    const response = await callQuery(tools, { kind: "def", symbol: "findMetroStation" });
    assert.notEqual(response.result.isError, true, "a missing column should be repaired by a reset rebuild");

    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload._agentify_index.status, "rebuilt");
    assert.equal(payload.symbol, "findMetroStation");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("query degrades gracefully when the index lock is held during recovery", async () => {
  const root = await withSourceRepo("agentify-mcp-query-locked-");
  const previousExitCode = process.exitCode;
  try {
    const config = await loadConfig(root, { provider: "local", dryRun: false });

    // Hold the single-writer index-refresh lock so the auto-scan cannot run.
    const locksRoot = path.join(root, ".agentify", "locks");
    await fs.mkdir(locksRoot, { recursive: true });
    await fs.writeFile(
      path.join(locksRoot, "index.lock"),
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        host: os.hostname(),
        operation: "index-refresh",
        created_at: new Date().toISOString(),
        acquired_at: Date.now(),
      }),
      "utf8",
    );

    const tools = buildMcpTools(root, config);
    const response = await callQuery(tools, { kind: "search", term: "findMetroStation" });

    assert.notEqual(response.result.isError, true, "lock contention must not surface as an error/throw");
    const text = response.result.content[0].text;
    assert.match(text, /in progress/i);
    assert.match(text, /agentify scan/);

    const dbExists = await fs.access(path.join(root, ".agentify", "index.db")).then(() => true).catch(() => false);
    assert.equal(dbExists, false, "a blocked auto-scan must not write the index");
    assert.equal(process.exitCode, previousExitCode, "blocked auto-scan must not leak a failure exit code");
  } finally {
    process.exitCode = previousExitCode;
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
