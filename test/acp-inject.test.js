import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { addNote, pauseContext } from "../src/core/ctx.js";
import { estimateContextTokens } from "../src/core/value-telemetry.js";
import {
  AGENTIFY_CONTEXT_CLOSE,
  AGENTIFY_CONTEXT_OPEN,
  buildInjectionDigest,
  createFirstTurnInjector,
  extractTopLevelRawId,
  injectIntoPromptMessage,
  markInjectedBlock,
  normalizeAcpInjectionMode,
  resolveAcpInjection,
  runAcpProxyCommand,
} from "../src/core/acp/index.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, { timeout = 3000, interval = 5 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("waitUntil timed out");
    }
    await delay(interval);
  }
}

// Drive a set of raw newline-delimited lines through an injector Transform and
// collect the exact bytes it emits.
async function runInjector(injector, lines) {
  const chunks = [];
  injector.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const ended = new Promise((resolve) => injector.once("end", resolve));
  for (const line of lines) {
    injector.write(Buffer.from(line, "utf8"));
  }
  injector.end();
  await ended;
  return Buffer.concat(chunks).toString("utf8");
}

const line = (obj) => `${JSON.stringify(obj)}\n`;

test("normalizeAcpInjectionMode clamps to the known modes and defaults to off", () => {
  assert.equal(normalizeAcpInjectionMode(undefined), "off");
  assert.equal(normalizeAcpInjectionMode("RELEVANT"), "relevant");
  assert.equal(normalizeAcpInjectionMode("digest"), "digest");
  assert.equal(normalizeAcpInjectionMode("nonsense"), "off");
});

test("extractTopLevelRawId returns the exact source bytes of the top-level id", () => {
  // A big integer id keeps every digit (JSON.parse would round it).
  assert.equal(
    extractTopLevelRawId('{"jsonrpc":"2.0","id":9007199254740993,"method":"session/prompt","params":{}}'),
    "9007199254740993",
  );
  // String ids keep their quotes.
  assert.equal(extractTopLevelRawId('{"id":"req-7","method":"x"}'), '"req-7"');
  // A nested "id" inside params must NOT be picked up.
  assert.equal(
    extractTopLevelRawId('{"method":"x","params":{"id":42,"nested":{"id":99}},"id":5}'),
    "5",
  );
  // No top-level id at all.
  assert.equal(extractTopLevelRawId('{"method":"x","params":{}}'), null);
});

test("injectIntoPromptMessage prepends a marked block and preserves a huge id verbatim", () => {
  const raw = '{"jsonrpc":"2.0","id":9007199254740993,"method":"session/prompt","params":{"sessionId":"s","prompt":[{"type":"text","text":"hello"}]}}';
  const message = JSON.parse(raw);
  const out = injectIntoPromptMessage(raw, message, markInjectedBlock("DIGEST-BODY"));

  // The id survived without rounding — a full parse+stringify would corrupt it.
  assert.ok(out.includes('"id":9007199254740993'), "big id must be preserved verbatim");
  assert.ok(!out.includes("9007199254740992"), "id must not be rounded down");

  // The rewritten line is still valid JSON with the injected block first and the
  // user's original block intact and untouched, in order.
  const parsed = JSON.parse(out);
  assert.equal(parsed.id, 9007199254740992); // JS can't represent the true value, but the raw text is correct
  assert.equal(parsed.method, "session/prompt");
  assert.equal(parsed.params.prompt.length, 2);
  assert.equal(parsed.params.prompt[0].type, "text");
  assert.ok(parsed.params.prompt[0].text.includes(AGENTIFY_CONTEXT_OPEN));
  assert.ok(parsed.params.prompt[0].text.includes("DIGEST-BODY"));
  assert.deepEqual(parsed.params.prompt[1], { type: "text", text: "hello" });
});

test("injectIntoPromptMessage refuses non-prompt shapes", () => {
  const notify = '{"jsonrpc":"2.0","method":"session/prompt","params":{"prompt":[]}}';
  assert.equal(injectIntoPromptMessage(notify, JSON.parse(notify), "x"), null); // no id
  const noPrompt = '{"id":1,"method":"session/prompt","params":{}}';
  assert.equal(injectIntoPromptMessage(noPrompt, JSON.parse(noPrompt), "x"), null);
});

test("the injector forwards non-prompt traffic byte-identically and injects only the first prompt", async () => {
  const injector = createFirstTurnInjector({ buildDigest: async () => "DIGEST-BODY" });

  const initialize = line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  const newSession = line({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/repo" } });
  const firstPrompt = line({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "add a test" }] } });
  const secondPrompt = line({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "and another" }] } });

  const out = await runInjector(injector, [initialize, newSession, firstPrompt, secondPrompt]);
  const outLines = out.split("\n").filter(Boolean).map((l) => `${l}\n`);

  // initialize and session/new are byte-for-byte identical.
  assert.equal(outLines[0], initialize);
  assert.equal(outLines[1], newSession);

  // The first prompt gained the marked block before the user's text.
  const injected = JSON.parse(outLines[2]);
  assert.equal(injected.id, 3);
  assert.equal(injected.params.prompt.length, 2);
  assert.ok(injected.params.prompt[0].text.includes(AGENTIFY_CONTEXT_OPEN));
  assert.deepEqual(injected.params.prompt[1], { type: "text", text: "add a test" });

  // The second prompt is untouched (byte-identical) — injection is first-turn only.
  assert.equal(outLines[3], secondPrompt);
});

test("the injector forwards the first prompt unchanged when there is nothing to inject", async () => {
  const injector = createFirstTurnInjector({ buildDigest: async () => "" });
  const firstPrompt = line({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] } });
  const out = await runInjector(injector, [firstPrompt]);
  assert.equal(out, firstPrompt);
});

test("the injector preserves a huge prompt id end-to-end", async () => {
  const injector = createFirstTurnInjector({ buildDigest: async () => "DIGEST-BODY" });
  const bigPrompt = '{"jsonrpc":"2.0","id":9007199254740993,"method":"session/prompt","params":{"sessionId":"s","prompt":[{"type":"text","text":"go"}]}}\n';
  const out = await runInjector(injector, [bigPrompt]);
  assert.ok(out.includes('"id":9007199254740993'), "the injected first prompt must keep its exact id");
});

test("resolveAcpInjection defaults off, honors config, env override, and the recursion/pause guard", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-acp-inject-resolve-"));
  try {
    // Default config → off (no eval evidence justifies default-on).
    assert.deepEqual((await resolveAcpInjection(root, {}, {})).mode, "off");
    // Per-repo switch enables it.
    assert.equal((await resolveAcpInjection(root, { context: { acpInjection: "relevant" } }, {})).mode, "relevant");
    // Env override wins over config.
    assert.equal((await resolveAcpInjection(root, { context: { acpInjection: "off" } }, { AGENTIFY_ACP_INJECTION: "digest" })).mode, "digest");
    // AGENTIFY_CTX=off (delegate-child recursion guard) forces off even if enabled.
    assert.equal((await resolveAcpInjection(root, { context: { acpInjection: "relevant" } }, { AGENTIFY_CTX: "off" })).mode, "off");
    // A paused repo forces off.
    await pauseContext(root);
    assert.equal((await resolveAcpInjection(root, { context: { acpInjection: "relevant" } }, {})).mode, "off");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildInjectionDigest (relevant) returns a marked-within-budget digest built from repo context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-acp-inject-relevant-"));
  try {
    await addNote(root, "payment retries must reuse an idempotency key so a retry never double-charges");
    const config = {};
    const digest = await buildInjectionDigest(root, { mode: "relevant", promptText: "fix the payment retries", config });
    assert.ok(digest, "expected a non-empty digest");
    assert.ok(/idempotency key/.test(digest), "the matched note should be present");

    // Reusing ctx-budget: the digest is within the resolved policy budget (default 1200).
    assert.ok(estimateContextTokens(digest) <= 1200);

    // And it renders inside a clearly-marked block once wrapped.
    const marked = markInjectedBlock(digest);
    assert.ok(marked.includes(AGENTIFY_CONTEXT_OPEN) && marked.includes(AGENTIFY_CONTEXT_CLOSE));
    assert.ok(/not been? written by the user|NOT written by the user/i.test(marked));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("budget boundary: an oversized item is truncated by the policy, not silently dropped", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-acp-inject-budget-"));
  try {
    // A decision (a reserve/safety class) far larger than a tiny budget: the
    // policy must truncate it with provenance rather than omit it entirely.
    const huge = `payment retry idempotency: ${"x".repeat(1200)}`;
    await addNote(root, huge, { type: "decision" });
    const config = { context: { maxInjectedTokens: 120 } };
    const digest = await buildInjectionDigest(root, { mode: "relevant", promptText: "payment retry idempotency", config });
    assert.ok(digest, "the oversized decision must not be silently dropped");
    assert.ok(/truncated from \d+ chars/.test(digest), "it must be truncated with provenance by the policy");
    assert.ok(estimateContextTokens(digest) <= 120, "the truncated digest must respect the budget");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// A fake ACP agent that echoes back, per session/prompt, the prompt blocks it
// received and the AGENTIFY_CTX env it was spawned with — so the test can
// assert what actually reached the downstream.
const ECHO_AGENT_SCRIPT = `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (raw) => {
  const trimmed = raw.trim();
  if (!trimmed) return;
  let message;
  try { message = JSON.parse(trimmed); } catch { return; }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "sess" } });
  } else if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn", received: message.params.prompt, envCtx: process.env.AGENTIFY_CTX ?? null } });
  } else if (message.id !== undefined && message.id !== null) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
});
rl.on("close", () => process.exit(0));
`;

async function withEchoAgent(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-acp-inject-cmd-"));
  const scriptPath = path.join(dir, "echo-agent.mjs");
  await fs.writeFile(scriptPath, ECHO_AGENT_SCRIPT, "utf8");
  await fs.chmod(scriptPath, 0o755);
  try {
    await fn(dir, scriptPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function collectLines(output, sink) {
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const l = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (l) sink.push(JSON.parse(l));
    }
  });
}

test("runAcpProxyCommand injects into the first turn and suppresses downstream hooks when enabled", async () => {
  await withEchoAgent(async (dir, scriptPath) => {
    await addNote(dir, "payment retries must reuse an idempotency key so a retry never double-charges");
    const input = new PassThrough();
    const output = new PassThrough();
    const outLines = [];
    collectLines(output, outLines);

    const commandPromise = runAcpProxyCommand(
      dir,
      { context: { acpInjection: "relevant" } },
      { command: scriptPath, provider: null },
      { input, output, log: () => {}, handleSignals: false, setExitCode: false, env: { PATH: process.env.PATH } },
    );

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: dir } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "sess", prompt: [{ type: "text", text: "fix the payment retries" }] } })}\n`);

    await waitUntil(() => outLines.some((m) => m.id === 3), { timeout: 5000 });
    const promptResult = outLines.find((m) => m.id === 3).result;

    // The downstream received an injected, marked block ahead of the user's text.
    assert.equal(promptResult.received.length, 2);
    assert.ok(promptResult.received[0].text.includes(AGENTIFY_CONTEXT_OPEN));
    assert.ok(/idempotency key/.test(promptResult.received[0].text));
    assert.deepEqual(promptResult.received[1], { type: "text", text: "fix the payment retries" });

    // Double-injection guard: the child was spawned with AGENTIFY_CTX=off.
    assert.equal(promptResult.envCtx, "off");

    input.end();
    await commandPromise;
  });
});

test("runAcpProxyCommand is a verbatim pass-through when injection is off (the #335 default)", async () => {
  await withEchoAgent(async (dir, scriptPath) => {
    await addNote(dir, "payment retries idempotency lives in src/pay/retry.ts");
    const input = new PassThrough();
    const output = new PassThrough();
    const outLines = [];
    collectLines(output, outLines);

    // Default config → acpInjection off.
    const commandPromise = runAcpProxyCommand(
      dir,
      {},
      { command: scriptPath, provider: null },
      { input, output, log: () => {}, handleSignals: false, setExitCode: false, env: { PATH: process.env.PATH } },
    );

    const userPrompt = [{ type: "text", text: "fix the payment retries" }];
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "sess", prompt: userPrompt } })}\n`);

    await waitUntil(() => outLines.some((m) => m.id === 1), { timeout: 5000 });
    const promptResult = outLines.find((m) => m.id === 1).result;

    // Nothing injected: the downstream saw exactly the user's prompt.
    assert.deepEqual(promptResult.received, userPrompt);
    // And the child's environment was not forced to off (hooks behave normally).
    assert.notEqual(promptResult.envCtx, "off");

    input.end();
    await commandPromise;
  });
});
