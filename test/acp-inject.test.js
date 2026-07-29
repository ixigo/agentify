import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { addNote, pauseContext } from "../src/core/ctx.js";
import { estimateContextTokens, resolveValueEventsPath } from "../src/core/value-telemetry.js";
import {
  AGENTIFY_CONTEXT_CLOSE,
  AGENTIFY_CONTEXT_OPEN,
  buildInjectionDigest,
  createFirstTurnInjector,
  establishesOutsideRoot,
  extractTopLevelRawId,
  injectIntoPromptMessage,
  markInjectedBlock,
  normalizeAcpInjectionMode,
  resolveAcpInjectionMode,
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

test("injectIntoPromptMessage preserves every other byte, including large numbers and _meta, verbatim", () => {
  // A parse+reserialize would round both big numbers and could reorder keys;
  // the surgical insert must leave everything except the new block untouched.
  const raw = '{"jsonrpc":"2.0","id":7,"method":"session/prompt","params":{"sessionId":"s","big":10000000000000001,"prompt":[{"type":"text","text":"hi"}],"_meta":{"trace":90071992547409931}}}';
  const out = injectIntoPromptMessage(raw, JSON.parse(raw), markInjectedBlock("D"));
  assert.ok(out.includes("10000000000000001"), "a large params number must survive unrounded");
  assert.ok(out.includes("90071992547409931"), "a large _meta number must survive unrounded");
  // Everything outside the prompt array is byte-for-byte identical: the output
  // equals the input with exactly the injected block spliced in after '['.
  const marker = '"prompt":[';
  const at = raw.indexOf(marker) + marker.length;
  const block = JSON.stringify({ type: "text", text: markInjectedBlock("D") });
  assert.equal(out, `${raw.slice(0, at)}${block},${raw.slice(at)}`);
});

test("injectIntoPromptMessage handles an empty prompt array without a stray comma", () => {
  const raw = '{"id":1,"method":"session/prompt","params":{"sessionId":"s","prompt":[]}}';
  const out = injectIntoPromptMessage(raw, JSON.parse(raw), "D");
  const parsed = JSON.parse(out);
  assert.equal(parsed.params.prompt.length, 1);
  assert.equal(parsed.params.prompt[0].text, "D");
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

test("the injector injects the first turn of EACH session on a shared connection", async () => {
  let calls = 0;
  const injector = createFirstTurnInjector({ buildDigest: async () => `DIGEST-${++calls}` });

  const sessA1 = line({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "A", prompt: [{ type: "text", text: "a1" }] } });
  const sessA2 = line({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "A", prompt: [{ type: "text", text: "a2" }] } });
  const sessB1 = line({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "B", prompt: [{ type: "text", text: "b1" }] } });

  const out = await runInjector(injector, [sessA1, sessA2, sessB1]);
  const outLines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));

  // Session A's first turn: injected.
  assert.equal(outLines[0].params.prompt.length, 2);
  assert.ok(outLines[0].params.prompt[0].text.includes(AGENTIFY_CONTEXT_OPEN));
  // Session A's second turn: untouched.
  assert.equal(outLines[1].params.prompt.length, 1);
  assert.deepEqual(outLines[1].params.prompt[0], { type: "text", text: "a2" });
  // Session B's first turn: injected (its own session start).
  assert.equal(outLines[2].params.prompt.length, 2);
  assert.ok(outLines[2].params.prompt[0].text.includes(AGENTIFY_CONTEXT_OPEN));
  assert.equal(calls, 2, "buildDigest runs once per session start, not per turn");
});

test("an oversized first prompt disables injection for the rest of the connection (no later-turn injection)", async () => {
  // A tiny cap plus an oversized first prompt: rather than buffer/parse it (risk
  // of quadratic copying / OOM on large base64 blobs), the injector forwards it
  // unchanged AND falls back to raw pass-through, so a later smaller turn of the
  // same session is NOT injected into — injection stays first-turn-only and is
  // not dependent on how the transport chunked the bytes.
  let called = 0;
  const injector = createFirstTurnInjector({ buildDigest: async () => { called += 1; return "D"; }, maxScanBytes: 64 });
  const bigPrompt = line({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "z".repeat(500) }] } });
  const laterPrompt = line({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "small" }] } });
  const out = await runInjector(injector, [bigPrompt, laterPrompt]);
  assert.equal(out, `${bigPrompt}${laterPrompt}`, "both lines must be forwarded byte-identically");
  assert.equal(called, 0, "no injection is attempted once the scan cap is exceeded");
});

test("the injector refuses to inject once a session is established outside the launch workspace", async () => {
  // isSameWorkspace models the launch root being "/root". A session/new for a
  // different cwd must disable injection connection-wide so one repo's context
  // never leaks into another repo's session.
  let called = 0;
  const injector = createFirstTurnInjector({
    buildDigest: async () => { called += 1; return "D"; },
    isSameWorkspace: (cwd) => cwd === "/root",
  });
  const newOther = line({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/other-repo", mcpServers: [] } });
  const prompt = line({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] } });
  const out = await runInjector(injector, [newOther, prompt]);
  assert.equal(out, `${newOther}${prompt}`, "nothing may be injected after a foreign-workspace session");
  assert.equal(called, 0, "buildDigest must not run for a session outside the launch workspace");
});

test("the workspace guard covers every session-establishing method (resume, fork, load)", async () => {
  for (const method of ["session/resume", "session/fork", "session/load"]) {
    let called = 0;
    const injector = createFirstTurnInjector({
      buildDigest: async () => { called += 1; return "D"; },
      isSameWorkspace: (cwd) => cwd === "/root",
    });
    const establish = line({ jsonrpc: "2.0", id: 1, method, params: { sessionId: "s", cwd: "/other-repo" } });
    const prompt = line({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] } });
    const out = await runInjector(injector, [establish, prompt]);
    assert.equal(out, `${establish}${prompt}`, `${method} with a foreign cwd must disable injection`);
    assert.equal(called, 0);
  }
});

// `cwd` is not the only workspace root a session can declare. capture.js has
// always rejected a foreign additionalDirectories entry; the injector checked
// only cwd, so a session rooted in this repo but carrying an extra root in an
// unrelated repo still received this repo's notes and decisions.
test("the injector refuses to inject when a session declares a foreign additionalDirectories root", async () => {
  for (const key of ["additionalDirectories", "additional_directories"]) {
    for (const entry of ["/other-repo", { path: "/other-repo" }]) {
      let called = 0;
      const injector = createFirstTurnInjector({
        buildDigest: async () => { called += 1; return "D"; },
        isSameWorkspace: (dir) => dir === "/root",
      });
      const establish = line({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        // cwd itself is fine — only the extra root escapes.
        params: { cwd: "/root", [key]: [entry], mcpServers: [] },
      });
      const prompt = line({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] } });
      const out = await runInjector(injector, [establish, prompt]);
      const label = `${key} as ${typeof entry === "string" ? "string" : "object"}`;
      assert.equal(out, `${establish}${prompt}`, `a foreign ${label} must disable injection`);
      assert.equal(called, 0, `buildDigest must not run for a foreign ${label}`);
    }
  }
});

// An empty array is truthy, so coalescing the two spellings with `||` would
// check the empty one and wave the foreign roots through.
test("both additionalDirectories spellings are checked independently, even when one is empty", async () => {
  let called = 0;
  const injector = createFirstTurnInjector({
    buildDigest: async () => { called += 1; return "D"; },
    isSameWorkspace: (dir) => dir === "/root",
  });
  const establish = line({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: { cwd: "/root", additionalDirectories: [], additional_directories: ["/other-repo"], mcpServers: [] },
  });
  const prompt = line({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] } });
  const out = await runInjector(injector, [establish, prompt]);
  assert.equal(out, `${establish}${prompt}`, "an empty camelCase array must not mask foreign snake_case roots");
  assert.equal(called, 0);
});

// Both halves of the proxy share one implementation, so assert the rule itself.
test("establishesOutsideRoot judges cwd and both additionalDirectories spellings", () => {
  const inRoot = (dir) => dir === "/root" || dir.startsWith("/root/");
  assert.equal(establishesOutsideRoot({ cwd: "/root" }, inRoot), false);
  assert.equal(establishesOutsideRoot({ cwd: "/root/packages/app" }, inRoot), false);
  assert.equal(establishesOutsideRoot({ cwd: "/elsewhere" }, inRoot), true);
  // Either spelling, either entry shape, and one empty array never masks the other.
  assert.equal(establishesOutsideRoot({ cwd: "/root", additionalDirectories: ["/elsewhere"] }, inRoot), true);
  assert.equal(establishesOutsideRoot({ cwd: "/root", additional_directories: [{ path: "/elsewhere" }] }, inRoot), true);
  assert.equal(establishesOutsideRoot({ cwd: "/root", additionalDirectories: [], additional_directories: ["/elsewhere"] }, inRoot), true);
  assert.equal(establishesOutsideRoot({ cwd: "/root", additionalDirectories: ["/root/pkg"], additional_directories: [] }, inRoot), false);
  // Malformed input is not a mismatch (nothing was declared).
  assert.equal(establishesOutsideRoot(null, inRoot), false);
  assert.equal(establishesOutsideRoot({ additionalDirectories: "nope" }, inRoot), false);
});

test("additionalDirectories inside the launch root still allow injection", async () => {
  const injector = createFirstTurnInjector({
    buildDigest: async () => "D",
    isSameWorkspace: (dir) => dir === "/root" || dir.startsWith("/root/"),
  });
  const establish = line({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: { cwd: "/root", additionalDirectories: ["/root/packages/app"], mcpServers: [] },
  });
  const prompt = line({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] } });
  const out = await runInjector(injector, [establish, prompt]);
  const outLines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(outLines[1].params.prompt[0].text.includes(AGENTIFY_CONTEXT_OPEN), "extra roots inside the launch root are this workspace");
});

test("a read-only session/list with a cwd filter does NOT disable injection", async () => {
  const injector = createFirstTurnInjector({
    buildDigest: async () => "D",
    isSameWorkspace: (cwd) => cwd === "/root",
  });
  // session/list is not session-establishing; its cwd filter must not trip the
  // privacy guard.
  const list = line({ jsonrpc: "2.0", id: 1, method: "session/list", params: { cwd: "/other-repo" } });
  const prompt = line({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] } });
  const out = await runInjector(injector, [list, prompt]);
  const outLines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(outLines[1].params.prompt.length, 2, "the prompt must still be injected");
  assert.ok(outLines[1].params.prompt[0].text.includes(AGENTIFY_CONTEXT_OPEN));
});

test("the injector does not add a second context block when one is already present", async () => {
  let called = 0;
  const injector = createFirstTurnInjector({ buildDigest: async () => { called += 1; return "D"; } });
  const already = markInjectedBlock("upstream digest");
  const prompt = line({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: already }, { type: "text", text: "hi" }] } });
  const out = await runInjector(injector, [prompt]);
  assert.equal(out, prompt, "an already-marked prompt must be forwarded unchanged");
  assert.equal(called, 0, "buildDigest must not run when a marker is already present");
});

test("a stalled digest build times out and forwards the prompt unchanged", async () => {
  const injector = createFirstTurnInjector({
    buildDigest: () => new Promise(() => {}), // never resolves
    injectTimeoutMs: 30,
  });
  const prompt = line({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] } });
  const out = await runInjector(injector, [prompt]);
  assert.equal(out, prompt, "on timeout the prompt must be forwarded byte-identically");
});

test("a build that finishes after the timeout does not commit telemetry (no phantom injection)", async () => {
  // The build resolves AFTER the timeout with a commit callback. Because the
  // injector already forwarded the prompt raw, it must never invoke that commit.
  let committed = 0;
  const injector = createFirstTurnInjector({
    injectTimeoutMs: 20,
    buildDigest: () => new Promise((resolve) => setTimeout(
      () => resolve({ digest: "D", commit: async () => { committed += 1; } }),
      120,
    )),
  });
  const prompt = line({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] } });
  const out = await runInjector(injector, [prompt]);
  assert.equal(out, prompt, "the prompt was forwarded raw (build timed out)");
  await delay(200); // let the late build settle
  assert.equal(committed, 0, "a dropped injection must not be recorded as successful");
});

test("commit runs only after a real injection is forwarded", async () => {
  let committed = 0;
  const injector = createFirstTurnInjector({
    buildDigest: async () => ({ digest: "D", commit: async () => { committed += 1; } }),
  });
  const prompt = line({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] } });
  const out = await runInjector(injector, [prompt]);
  assert.ok(JSON.parse(out.trim()).params.prompt[0].text.includes(AGENTIFY_CONTEXT_OPEN), "the prompt was injected");
  await delay(20);
  assert.equal(committed, 1, "commit runs once after the injection is forwarded");
});

test("tearing down the injector during a build records no phantom injection", async () => {
  let committed = 0;
  const injector = createFirstTurnInjector({
    buildDigest: () => new Promise((resolve) => setTimeout(
      () => resolve({ digest: "D", commit: async () => { committed += 1; } }),
      60,
    )),
  });
  injector.on("data", () => {}); // drain
  const prompt = line({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] } });
  injector.write(Buffer.from(prompt, "utf8"));
  await delay(10); // build is in flight
  injector.destroy();
  await delay(120); // let the build settle
  assert.equal(committed, 0, "a build that resolves after teardown must not commit");
});

test("an unterminated final prompt frame at EOF is still injected", async () => {
  const injector = createFirstTurnInjector({ buildDigest: async () => "D" });
  // No trailing newline — a valid final ACP frame at EOF.
  const prompt = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] } });
  const out = await runInjector(injector, [prompt]);
  const parsed = JSON.parse(out);
  assert.equal(parsed.params.prompt.length, 2, "the unterminated final prompt must be injected");
  assert.ok(parsed.params.prompt[0].text.includes(AGENTIFY_CONTEXT_OPEN));
});

test("the injector injects when the session is established in the launch workspace", async () => {
  const injector = createFirstTurnInjector({
    buildDigest: async () => "D",
    isSameWorkspace: (cwd) => cwd === "/root",
  });
  const newHere = line({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/root", mcpServers: [] } });
  const prompt = line({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] } });
  const out = await runInjector(injector, [newHere, prompt]);
  const outLines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(outLines[0].method, "session/new"); // forwarded unchanged
  assert.equal(outLines[1].params.prompt.length, 2); // injected
  assert.ok(outLines[1].params.prompt[0].text.includes(AGENTIFY_CONTEXT_OPEN));
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

test("resolveAcpInjectionMode defaults off, honors config, env override, and the recursion guard", () => {
  // Default config → off (no eval evidence justifies default-on).
  assert.equal(resolveAcpInjectionMode({}, {}), "off");
  // Per-repo switch enables it.
  assert.equal(resolveAcpInjectionMode({ context: { acpInjection: "relevant" } }, {}), "relevant");
  // Env override wins over config.
  assert.equal(resolveAcpInjectionMode({ context: { acpInjection: "off" } }, { AGENTIFY_ACP_INJECTION: "digest" }), "digest");
  // AGENTIFY_CTX=off (delegate-child recursion guard) forces off even if enabled.
  assert.equal(resolveAcpInjectionMode({ context: { acpInjection: "relevant" } }, { AGENTIFY_CTX: "off" }), "off");
  // AGENTIFY_CTX_INJECTION=off (set by a parent proxy that already injects)
  // forces off too, so a chained agentify-acp proxy never double-injects.
  assert.equal(resolveAcpInjectionMode({ context: { acpInjection: "relevant" } }, { AGENTIFY_CTX_INJECTION: "off" }), "off");
  // The shared AGENTIFY_CTX_INJECTION lever (what the eval runner sets per
  // ablation arm) drives ACP mode too, so the feature is ablatable.
  assert.equal(resolveAcpInjectionMode({}, { AGENTIFY_CTX_INJECTION: "relevant" }), "relevant");
  assert.equal(resolveAcpInjectionMode({}, { AGENTIFY_CTX_INJECTION: "digest" }), "digest");
  // An explicit ACP override wins over the shared lever (non-off).
  assert.equal(resolveAcpInjectionMode({}, { AGENTIFY_CTX_INJECTION: "relevant", AGENTIFY_ACP_INJECTION: "digest" }), "digest");
});

test("buildInjectionDigest re-checks the transient pause marker per session start", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-acp-inject-pause-"));
  try {
    await addNote(root, "payment retries must reuse an idempotency key so a retry never double-charges");
    // Not paused → a digest is produced.
    assert.ok((await buildInjectionDigest(root, { mode: "relevant", promptText: "fix the payment retries", config: {} })).digest);
    // Paused → nothing is injected, even though the mode was resolved earlier.
    await pauseContext(root);
    assert.equal((await buildInjectionDigest(root, { mode: "relevant", promptText: "fix the payment retries", config: {} })).digest, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildInjectionDigest (relevant) returns a marked-within-budget digest built from repo context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-acp-inject-relevant-"));
  try {
    await addNote(root, "payment retries must reuse an idempotency key so a retry never double-charges");
    const config = {};
    const { digest } = await buildInjectionDigest(root, { mode: "relevant", promptText: "fix the payment retries", config });
    assert.ok(digest, "expected a non-empty digest");
    assert.ok(/idempotency key/.test(digest), "the matched note should be present");

    // Reusing ctx-budget: the FULL injected block (wrapper + digest) is within
    // the resolved policy budget (default 1200), not just the bare digest.
    const marked = markInjectedBlock(digest);
    assert.ok(estimateContextTokens(marked) <= 1200);

    // And it renders inside a clearly-marked block.
    assert.ok(marked.includes(AGENTIFY_CONTEXT_OPEN) && marked.includes(AGENTIFY_CONTEXT_CLOSE));
    assert.ok(/NOT written by the user/i.test(marked));
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
    const config = { context: { maxInjectedTokens: 300 } };
    const { digest } = await buildInjectionDigest(root, { mode: "relevant", promptText: "payment retry idempotency", config });
    assert.ok(digest, "the oversized decision must not be silently dropped");
    assert.ok(/truncated from \d+ chars/.test(digest), "it must be truncated with provenance by the policy");
    // The full injected block (wrapper + truncated digest) respects the cap.
    assert.ok(estimateContextTokens(markInjectedBlock(digest)) <= 300, "the injected block must respect the budget");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("digest mode is bounded by the policy budget, not injected in full", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-acp-inject-digest-"));
  try {
    // A history far larger than a small cap: digest mode (the full `ctx load`
    // digest) must be truncated to the budget, not injected wholesale.
    for (let i = 0; i < 12; i += 1) {
      await addNote(root, `note ${i}: ${"context ".repeat(60)}`);
    }
    const config = { context: { maxInjectedTokens: 200 } };
    const { digest, commit } = await buildInjectionDigest(root, { mode: "digest", promptText: "", config });
    assert.ok(digest, "digest mode should still inject something");
    assert.ok(/truncated to fit the Agentify context budget/.test(digest), "an oversized digest must be truncated");
    assert.ok(estimateContextTokens(markInjectedBlock(digest)) <= 200, "the injected block must respect the budget");

    // commit() persists telemetry only when the injection is actually applied.
    await commit();

    // Telemetry must count only what actually survived truncation, not the full
    // snapshot — the counts gate whether this feature is worth enabling.
    const events = (await fs.readFile(resolveValueEventsPath(root), "utf8"))
      .split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.type === "context_injection");
    assert.equal(events.length, 1);
    const bulletsInDigest = (digest.match(/^- /gm) || []).length;
    assert.equal(events[0].injected_items, bulletsInDigest, "injected_items must match the bullets in the truncated digest");
    assert.ok(events[0].injected_items < 12, "a truncated digest must not claim all 12 notes");
    assert.equal(events[0].truncated, true);
    // The eval collector reads budget.truncated_items and budget.max_tokens.
    assert.equal(events[0].budget.truncated_items, 1);
    assert.ok(Number.isFinite(events[0].budget.max_tokens));
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
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn", received: message.params.prompt, envCtx: process.env.AGENTIFY_CTX ?? null, envInjection: process.env.AGENTIFY_CTX_INJECTION ?? null } });
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

    // Double-injection guard: the child was spawned with the NARROW switch
    // (AGENTIFY_CTX_INJECTION=off) so its own injection is suppressed, while its
    // context TRACKING stays enabled (AGENTIFY_CTX is NOT forced off).
    assert.equal(promptResult.envInjection, "off");
    assert.notEqual(promptResult.envCtx, "off");

    input.end();
    await commandPromise;
  });
});

// Enabling injection suppresses the downstream agent's own Agentify hook
// injection (AGENTIFY_CTX_INJECTION=off). The proxy therefore has to accept
// every session that really is this workspace, or the session ends up with no
// context from either path. An exact cwd == root test rejected a monorepo
// session rooted at `<root>/packages/app`; capture already used a
// root-or-descendant test, and injection now uses the same one.
test("runAcpProxyCommand injects for a session rooted in a subdirectory of the launch root", async () => {
  await withEchoAgent(async (dir, scriptPath) => {
    await addNote(dir, "payment retries must reuse an idempotency key so a retry never double-charges");
    const subdir = path.join(dir, "packages", "app");
    await fs.mkdir(subdir, { recursive: true });
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
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: subdir } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "sess", prompt: [{ type: "text", text: "fix the payment retries" }] } })}\n`);

    await waitUntil(() => outLines.some((m) => m.id === 3), { timeout: 5000 });
    const promptResult = outLines.find((m) => m.id === 3).result;
    assert.equal(promptResult.received.length, 2, "a subdirectory session is still this workspace");
    assert.ok(promptResult.received[0].text.includes(AGENTIFY_CONTEXT_OPEN));
    assert.ok(/idempotency key/.test(promptResult.received[0].text));

    input.end();
    await commandPromise;
  });
});

test("runAcpProxyCommand does NOT inject for a session rooted outside the launch root", async () => {
  await withEchoAgent(async (dir, scriptPath) => {
    await addNote(dir, "payment retries must reuse an idempotency key so a retry never double-charges");
    // A sibling directory, not a descendant: the privacy guard must still hold
    // after the switch from exact equality to containment.
    const foreign = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-acp-foreign-"));
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
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: foreign } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "sess", prompt: [{ type: "text", text: "fix the payment retries" }] } })}\n`);

    await waitUntil(() => outLines.some((m) => m.id === 3), { timeout: 5000 });
    const promptResult = outLines.find((m) => m.id === 3).result;
    assert.equal(promptResult.received.length, 1, "a foreign-root session must receive the prompt unchanged");
    assert.equal(promptResult.received[0].text, "fix the payment retries");

    input.end();
    await commandPromise;
    await fs.rm(foreign, { recursive: true, force: true });
  });
});

// The containment check is a privacy boundary, so it must resolve symlinks: a
// lexically-inside path like `<root>/external -> /other-repo` would otherwise
// pass and receive this root's notes while operating in a different repo.
test("runAcpProxyCommand does NOT inject for a session rooted at a symlink that escapes the root", async () => {
  await withEchoAgent(async (dir, scriptPath) => {
    await addNote(dir, "payment retries must reuse an idempotency key so a retry never double-charges");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-acp-outside-"));
    const link = path.join(dir, "external");
    await fs.symlink(outside, link, "dir");
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
    // Lexically inside the root, actually outside it.
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: link } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "sess", prompt: [{ type: "text", text: "fix the payment retries" }] } })}\n`);

    await waitUntil(() => outLines.some((m) => m.id === 3), { timeout: 5000 });
    const promptResult = outLines.find((m) => m.id === 3).result;
    assert.equal(promptResult.received.length, 1, "a symlink escaping the root must not receive context");
    assert.equal(promptResult.received[0].text, "fix the payment retries");

    input.end();
    await commandPromise;
    await fs.rm(outside, { recursive: true, force: true });
  });
});

test("runAcpProxyCommand tears down cleanly when the client aborts before ending", async () => {
  await withEchoAgent(async (dir, scriptPath) => {
    await addNote(dir, "payment retries must reuse an idempotency key so a retry never double-charges");
    const input = new PassThrough();
    const output = new PassThrough();
    let child = null;
    const commandPromise = runAcpProxyCommand(
      dir,
      { context: { acpInjection: "relevant" } },
      { command: scriptPath, provider: null },
      { input, output, log: () => {}, handleSignals: false, setExitCode: false, env: { PATH: process.env.PATH }, onSpawn: (spawned) => { child = spawned; } },
    );
    await waitUntil(() => child !== null, { timeout: 5000 });
    // Abrupt disconnect: destroy the client stream without a clean EOF. With the
    // injector interposed, the proxy must still observe the teardown, resolve,
    // and terminate the child (not hang).
    input.destroy();
    const result = await commandPromise;
    assert.ok(result);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "child must be terminated on an abrupt client close");
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
