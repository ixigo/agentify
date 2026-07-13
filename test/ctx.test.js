import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  addNote,
  buildEventFromHookPayload,
  contextStatus,
  loadContextSnapshot,
  renderContextDigest,
  resolveContextPaths,
  trackEvent,
  writeHandoff,
} from "../src/core/ctx.js";

test("buildEventFromHookPayload maps Edit tool payloads to edit events", () => {
  const root = "/repo";
  const event = buildEventFromHookPayload(root, {
    session_id: "abcdef1234567890",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "/repo/src/pay/retry.ts" },
  });
  assert.equal(event.type, "edit");
  assert.equal(event.path, "src/pay/retry.ts");
  assert.equal(event.sid, "abcdef12");
});

test("buildEventFromHookPayload maps Bash tool payloads to cmd events and clips long commands", () => {
  const root = "/repo";
  const longCommand = `echo ${"x".repeat(400)}`;
  const event = buildEventFromHookPayload(root, {
    session_id: "sess",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: longCommand, description: "spam" },
  });
  assert.equal(event.type, "cmd");
  assert.equal(event.desc, "spam");
  assert.ok(event.cmd.length <= 200, `expected clipped command, got length ${event.cmd.length}`);
  assert.ok(event.cmd.endsWith("…"));
});

test("buildEventFromHookPayload redacts secrets from commands, descriptions, and error snippets", () => {
  const event = buildEventFromHookPayload("/repo", {
    session_id: "sess",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: {
      command: "curl -H 'Authorization: Bearer abcdef1234567890' https://api.example.com",
      description: "call api with API_KEY=supersecretvalue",
    },
    tool_response: {
      exitCode: 1,
      stderr: "request failed: OPENAI_TOKEN=sk-abcdefghijklmnop rejected",
    },
  });
  assert.equal(event.type, "cmd");
  assert.ok(!event.cmd.includes("abcdef1234567890"), `cmd leaked secret: ${event.cmd}`);
  assert.ok(event.cmd.includes("[REDACTED]"));
  assert.ok(!event.desc.includes("supersecretvalue"), `desc leaked secret: ${event.desc}`);
  assert.ok(!event.err.includes("sk-abcdefghijklmnop"), `err leaked secret: ${event.err}`);
});

test("buildEventFromHookPayload maps SessionEnd payloads", () => {
  const event = buildEventFromHookPayload("/repo", {
    session_id: "sess",
    hook_event_name: "SessionEnd",
    reason: "clear",
  });
  assert.equal(event.type, "session_end");
  assert.equal(event.reason, "clear");
});

test("buildEventFromHookPayload returns null for unknown tools and empty payloads", () => {
  assert.equal(buildEventFromHookPayload("/repo", null), null);
  assert.equal(buildEventFromHookPayload("/repo", {}), null);
  assert.equal(
    buildEventFromHookPayload("/repo", { hook_event_name: "PostToolUse", tool_name: "WebFetch", tool_input: {} }),
    null,
  );
  // Edit without a file path yields nothing.
  assert.equal(
    buildEventFromHookPayload("/repo", { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: {} }),
    null,
  );
  // Bash without a command yields nothing.
  assert.equal(
    buildEventFromHookPayload("/repo", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {} }),
    null,
  );
});

test("trackEvent appends JSONL and skips untrackable payloads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-track-"));
  const paths = resolveContextPaths(root);

  const first = await trackEvent(root, {
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src/index.ts") },
  });
  assert.equal(first.tracked, true);

  const skipped = await trackEvent(root, { hook_event_name: "PostToolUse", tool_name: "Grep", tool_input: {} });
  assert.equal(skipped.tracked, false);

  const raw = await fs.readFile(paths.eventsPath, "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).type, "edit");
});

test("addNote rejects empty text and appends non-empty notes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-note-"));
  const paths = resolveContextPaths(root);

  await assert.rejects(() => addNote(root, "   "), /non-empty text/);

  const result = await addNote(root, "retry logic lives in src/pay/retry.ts", { session: "s1" });
  assert.equal(result.record.note, "retry logic lives in src/pay/retry.ts");

  const notes = (await fs.readFile(paths.notesPath, "utf8")).trim().split("\n");
  assert.equal(notes.length, 1);
  assert.equal(JSON.parse(notes[0]).note, "retry logic lives in src/pay/retry.ts");
});

test("loadContextSnapshot and renderContextDigest surface notes and hot files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-digest-"));

  for (let i = 0; i < 3; i += 1) {
    await trackEvent(root, {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path.join(root, "src/hot.ts") },
    });
  }
  await trackEvent(root, {
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test", description: "run tests" },
  });
  await addNote(root, "remember to update the changelog", { session: "s1" });

  const snapshot = await loadContextSnapshot(root);
  assert.equal(snapshot.summary.eventCount, 4);
  assert.equal(snapshot.notes.length, 1);
  assert.equal(snapshot.summary.hotFiles[0].file, "src/hot.ts");
  assert.equal(snapshot.summary.hotFiles[0].edits, 3);

  const digest = renderContextDigest(snapshot);
  assert.ok(digest.includes("remember to update the changelog"));
  assert.ok(digest.includes("src/hot.ts"));
  assert.ok(digest.includes("npm test"));
});

test("renderContextDigest returns empty string for an empty snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-empty-"));
  const snapshot = await loadContextSnapshot(root);
  assert.equal(renderContextDigest(snapshot), "");
});

test("contextStatus counts events and notes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-status-"));
  await trackEvent(root, {
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: path.join(root, "a.ts") },
  });
  await trackEvent(root, {
    session_id: "s2",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: path.join(root, "b.ts") },
  });
  await addNote(root, "one note");

  const status = await contextStatus(root);
  assert.equal(status.command, "ctx status");
  assert.equal(status.event_count, 2);
  assert.equal(status.note_count, 1);
  assert.equal(status.session_count, 2);
  assert.ok(status.event_log_bytes > 0);
});

test("writeHandoff writes a markdown file containing the task text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-handoff-"));
  await addNote(root, "gotcha: config lives in .agentify.yaml");

  const result = await writeHandoff(root, { task: "wrapping up the checkout refactor" });
  assert.equal(result.command, "ctx handoff");

  const handoffDir = resolveContextPaths(root).handoffDir;
  assert.ok(result.path.startsWith(handoffDir));
  const written = await fs.readFile(result.path, "utf8");
  assert.ok(written.includes("wrapping up the checkout refactor"));
  assert.ok(written.includes("gotcha: config lives in .agentify.yaml"));
});

test("pause blocks tracking and digest state; resume and clear restore/reset", async () => {
  const { pauseContext, resumeContext, clearContext, isContextPaused } = await import("../src/core/ctx.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-pause-"));
  try {
    const payload = { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "a.js" } };
    await trackEvent(dir, payload);

    await pauseContext(dir);
    assert.equal(await isContextPaused(dir), true);
    const paused = await trackEvent(dir, payload);
    assert.equal(paused.tracked, false);
    assert.equal(paused.paused, true);

    const resumed = await resumeContext(dir);
    assert.equal(resumed.was_paused, true);
    assert.equal(await isContextPaused(dir), false);

    // env override pauses without a marker
    assert.equal(await isContextPaused(dir, { AGENTIFY_CTX: "off" }), true);

    const cleared = await clearContext(dir);
    assert.equal(cleared.archived.length, 1);
    const status = await contextStatus(dir);
    assert.equal(status.event_count, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("matchSnapshotToPrompt scores notes and files by token overlap", async () => {
  const { matchSnapshotToPrompt, tokenizeForMatch } = await import("../src/core/ctx.js");
  assert.ok(tokenizeForMatch("Fix the payment retries now").has("payment"));
  assert.ok(!tokenizeForMatch("fix the and for").has("the"));

  const snapshot = {
    notes: [
      { ts: "2026-07-07T00:00:00Z", note: "payment retries: idempotency key in src/pay/retry.ts" },
      { ts: "2026-07-07T00:00:01Z", note: "css grid layout fallback for safari" },
    ],
    summary: {
      hotFiles: [
        { file: "src/pay/retry.ts", edits: 4 },
        { file: "src/ui/dash.css", edits: 2 },
      ],
    },
  };
  const matches = matchSnapshotToPrompt(snapshot, "the payment retry flow is double charging");
  assert.equal(matches.notes.length, 1);
  assert.match(matches.notes[0].note.note, /payment retries/);
  assert.deepEqual(matches.files.map((item) => item.file), ["src/pay/retry.ts"]);

  const none = matchSnapshotToPrompt(snapshot, "write a readme badge");
  assert.equal(none.notes.length, 0);
  assert.equal(none.files.length, 0);
});

test("matchContext dedupes injections per session via the ledger", async () => {
  const { matchContext } = await import("../src/core/ctx.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-match-"));
  try {
    await addNote(dir, "payment retries idempotency lives in retry.ts");
    const first = await matchContext(dir, "fix the payment retries", { sessionId: "sess-a" });
    assert.equal(first.notes.length, 1);
    const second = await matchContext(dir, "fix the payment retries", { sessionId: "sess-a" });
    assert.equal(second.notes.length, 0);
    assert.equal(second.suppressed_as_seen >= 1, true);
    // a different session sees it again
    const other = await matchContext(dir, "fix the payment retries", { sessionId: "sess-b" });
    assert.equal(other.notes.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("normalizeInjectionMode falls back on unknown values", async () => {
  const { normalizeInjectionMode } = await import("../src/core/ctx.js");
  assert.equal(normalizeInjectionMode("digest"), "digest");
  assert.equal(normalizeInjectionMode("OFF"), "off");
  assert.equal(normalizeInjectionMode("bogus"), "relevant");
  assert.equal(normalizeInjectionMode(undefined), "relevant");
});

test("summarizeSession default is extractive: zero provider calls, writes once, lands in digest + match", async () => {
  const { summarizeSession, loadContextSnapshot, renderContextDigest, matchSnapshotToPrompt } = await import("../src/core/ctx.js");
  const { addNote } = await import("../src/core/ctx.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-sum-"));
  try {
    const edit = (sid, file) => trackEvent(dir, { session_id: sid, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file } });
    const delegateCalls = [];
    const spyRuntime = { delegate: async (prompt) => { delegateCalls.push(prompt); return { exit_code: 0, output: "model text" }; } };

    // below threshold (covers no-op and read-only sessions too: they have no
    // meaningful events at all)
    await edit("thin-sess", "a.js");
    const thin = await summarizeSession(dir, {}, "thin-sess", { runtime: spyRuntime });
    assert.equal(thin.status, "too_few_events");

    for (let i = 0; i < 3; i += 1) {
      await edit("full-sess", "src/pay/retry.ts");
    }
    await addNote(dir, "idempotency key was regenerated on retry", { session: "full-sess" });
    const written = await summarizeSession(dir, {}, "full-sess", { runtime: spyRuntime });
    assert.equal(written.status, "written");
    assert.equal(written.record.mode, "extractive");
    assert.match(written.record.summary, /src\/pay\/retry\.ts \(3x\)/);
    assert.match(written.record.summary, /idempotency key was regenerated/);
    // The default mode must start zero provider processes.
    assert.equal(delegateCalls.length, 0);

    const again = await summarizeSession(dir, {}, "full-sess", { runtime: spyRuntime });
    assert.equal(again.status, "already_summarized");

    const snapshot = await loadContextSnapshot(dir);
    assert.equal(snapshot.sessionSummaries.length, 1);
    assert.match(renderContextDigest(snapshot), /What recent sessions did/);

    const matches = matchSnapshotToPrompt(snapshot, "payment retry idempotency bug");
    assert.equal(matches.summaries.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resolveSummaryMode maps legacy booleans and unknown values onto the mode set", async () => {
  const { resolveSummaryMode, summarizeSession } = await import("../src/core/ctx.js");
  assert.equal(resolveSummaryMode({}), "extractive");
  assert.equal(resolveSummaryMode({ context: { sessionSummaries: true } }), "extractive");
  assert.equal(resolveSummaryMode({ context: { sessionSummaries: false } }), "off");
  assert.equal(resolveSummaryMode({ context: { sessionSummaries: "llm" } }), "llm");
  assert.equal(resolveSummaryMode({ context: { sessionSummaries: "OFF" } }), "off");
  assert.equal(resolveSummaryMode({ context: { sessionSummaries: "bogus" } }), "extractive");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-sum-off-"));
  try {
    const disabled = await summarizeSession(dir, { context: { sessionSummaries: false } }, "any-sess", {});
    assert.equal(disabled.status, "disabled");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("summarizeSession skips sessions whose meaningful activity duplicates an existing summary", async () => {
  const { summarizeSession } = await import("../src/core/ctx.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-sum-dup-"));
  try {
    const edit = (sid, file) => trackEvent(dir, { session_id: sid, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file } });
    for (const sid of ["sess-one", "sess-two"]) {
      for (let i = 0; i < 3; i += 1) {
        await edit(sid, "src/same.js");
      }
    }
    const first = await summarizeSession(dir, {}, "sess-one", {});
    assert.equal(first.status, "written");
    const second = await summarizeSession(dir, {}, "sess-two", {});
    assert.equal(second.status, "duplicate_session");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("extractive summaries cover commands-only sessions and surface open failures", async () => {
  const { summarizeSession } = await import("../src/core/ctx.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-sum-cmd-"));
  try {
    const cmd = (command, response, description) => trackEvent(dir, {
      session_id: "cmd-sess",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command, ...(description ? { description } : {}) },
      tool_response: response,
    });
    await cmd("pnpm lint", { exit_code: 0 }, "Lint the project");
    await cmd("pnpm build", { exit_code: 0 });
    await cmd("pnpm test", { exit_code: 1, stderr: "2 failing" }, "Run the test suite");

    const written = await summarizeSession(dir, {}, "cmd-sess", {});
    assert.equal(written.status, "written");
    assert.match(written.record.summary, /Ran 3 command\(s\), 1 failed/);
    assert.match(written.record.summary, /Open: `pnpm test` still failing — 2 failing/);

    // The most recent failure wins even when an earlier command fails again
    // later (Map updates must not keep stale insertion order).
    const cmd2 = (command, response) => trackEvent(dir, {
      session_id: "order-sess",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_response: response,
    });
    await cmd2("cmd-a", { exit_code: 1, stderr: "first" });
    await cmd2("cmd-b", { exit_code: 1, stderr: "middle" });
    await cmd2("cmd-a", { exit_code: 1, stderr: "latest" });
    const ordered = await summarizeSession(dir, {}, "order-sess", {});
    assert.match(ordered.record.summary, /Open: `cmd-a` still failing — latest/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("llm summary mode is budgeted, receives only the extractive summary, and fails open", async () => {
  const { summarizeSession } = await import("../src/core/ctx.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-sum-llm-"));
  const llmConfig = { context: { sessionSummaries: "llm", summary: { llmMinEvents: 3, maxBudgetUsd: 0.02 } } };
  try {
    const edit = (sid, file) => trackEvent(dir, { session_id: sid, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file } });
    for (const sid of ["llm-sess", "llm-fail", "llm-thin"]) {
      for (let i = 0; i < 3; i += 1) {
        await edit(sid, `src/${sid}.js`);
      }
    }

    const prompts = [];
    const ok = await summarizeSession(dir, llmConfig, "llm-sess", {
      runtime: { delegate: async (prompt) => { prompts.push(prompt); return { exit_code: 0, output: "Refined handoff.", cost_usd: 0.001 }; } },
    });
    assert.equal(ok.status, "written");
    assert.equal(ok.record.mode, "llm");
    assert.equal(ok.record.summary, "Refined handoff.");
    assert.equal(ok.record.cost_usd, 0.001);
    // The model sees the extractive summary, never the raw activity log.
    assert.match(prompts[0], /Edited 1 file\(s\): src\/llm-sess\.js \(3x\)/);
    assert.ok(!prompts[0].includes("Files edited:"));

    // Any delegate failure (including a budget stop) falls open to extractive.
    const fallback = await summarizeSession(dir, llmConfig, "llm-fail", {
      runtime: { delegate: async () => ({ exit_code: 2, output: "" }) },
    });
    assert.equal(fallback.status, "written");
    assert.equal(fallback.record.mode, "extractive");
    assert.equal(fallback.record.llm_fallback, true);

    // Below llmMinEvents the model is not consulted at all.
    const thinCalls = [];
    const thin = await summarizeSession(dir, { context: { sessionSummaries: "llm", summary: { llmMinEvents: 10 } } }, "llm-thin", {
      runtime: { delegate: async (prompt) => { thinCalls.push(prompt); return { exit_code: 0, output: "x" }; } },
    });
    assert.equal(thin.status, "written");
    assert.equal(thin.record.mode, "extractive");
    assert.equal(thinCalls.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("summary injection usage is recorded for the stats maintenance view", async () => {
  const { summarizeSession, matchContext, resolveContextPaths } = await import("../src/core/ctx.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-sum-usage-"));
  try {
    for (let i = 0; i < 3; i += 1) {
      await trackEvent(dir, { session_id: "use-sess", hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "src/checkout/idempotency.ts" } });
    }
    const written = await summarizeSession(dir, {}, "use-sess", {});
    assert.equal(written.status, "written");

    const matches = await matchContext(dir, "checkout idempotency handling", { sessionId: "later-session" });
    assert.equal(matches.summaries.length, 1);

    const usageRaw = await fs.readFile(resolveContextPaths(dir).summaryUsagePath, "utf8");
    const usage = JSON.parse(usageRaw.trim());
    assert.match(usage.key, /^sum:/);
    assert.equal(usage.summary_ts, written.record.ts);

    const { buildStatsReport } = await import("../src/core/stats.js");
    const report = await buildStatsReport(dir, { days: 7 });
    assert.equal(report.summaries.count, 1);
    assert.equal(report.summaries.by_mode.extractive, 1);
    assert.equal(report.summaries.injected_unique, 1);
    assert.equal(report.summaries.injection_rate, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("shared-notes gitignore mode toggles and survives baseline rewrites", async () => {
  const { ensureAgentifyGitignore, hasSharedNotesGitignore } = await import("../src/core/gitignore.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-share-"));
  try {
    const local = await ensureAgentifyGitignore(dir);
    assert.equal(local.shared, false);

    const shared = await ensureAgentifyGitignore(dir, { shared: true });
    assert.equal(shared.shared, true);
    const text = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    assert.ok(hasSharedNotesGitignore(text));
    assert.ok(text.includes(".agentify/context/*"));
    assert.ok(!text.includes("\n.agentify/\n"));

    // baseline rewrite without an explicit mode must preserve shared
    const preserved = await ensureAgentifyGitignore(dir);
    assert.equal(preserved.shared, true);

    const off = await ensureAgentifyGitignore(dir, { shared: false });
    assert.equal(off.shared, false);
    const after = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    assert.ok(!hasSharedNotesGitignore(after));
    assert.ok(after.includes(".agentify/"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildEventFromHookPayload marks failed Bash commands with fail, exit, and err", () => {
  const failed = buildEventFromHookPayload("/repo", {
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "pnpm test" },
    tool_response: { exit_code: 1, stderr: "2 tests failed: retry.test.ts" },
  });
  assert.equal(failed.fail, true);
  assert.equal(failed.exit, 1);
  assert.match(failed.err, /retry\.test\.ts/);

  const viaSuccessFlag = buildEventFromHookPayload("/repo", {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "make build" },
    tool_response: { success: false, error: "missing target" },
  });
  assert.equal(viaSuccessFlag.fail, true);
  assert.match(viaSuccessFlag.err, /missing target/);

  const succeeded = buildEventFromHookPayload("/repo", {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "pnpm test" },
    tool_response: { exit_code: 0, stdout: "ok" },
  });
  assert.equal(succeeded.fail, undefined);

  // No response at all (older hook payloads) — still tracked, just no failure info.
  const noResponse = buildEventFromHookPayload("/repo", {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });
  assert.equal(noResponse.fail, undefined);
});

test("digest surfaces unresolved failures; a later success clears them", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-fail-"));
  try {
    const bash = (command, toolResponse, session = "s1") => trackEvent(dir, {
      session_id: session,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_response: toolResponse,
    });

    await bash("pnpm test", { exit_code: 1, stderr: "FAIL retry.test.ts" });
    await bash("make deploy", { exit_code: 2, stderr: "no credentials" });

    let snapshot = await loadContextSnapshot(dir);
    assert.equal(snapshot.summary.unresolvedFailures.length, 2);
    let digest = renderContextDigest(snapshot);
    assert.match(digest, /failed and were not retried successfully/);
    assert.match(digest, /pnpm test/);

    // Retry succeeds -> failure is resolved and drops out.
    await bash("pnpm test", { exit_code: 0, stdout: "all green" });
    snapshot = await loadContextSnapshot(dir);
    assert.deepEqual(snapshot.summary.unresolvedFailures.map((item) => item.cmd), ["make deploy"]);

    const status = await contextStatus(dir);
    assert.equal(status.unresolved_failures.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("matchContext surfaces related past failures", async () => {
  const { matchContext } = await import("../src/core/ctx.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-failmatch-"));
  try {
    await trackEvent(dir, {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "docker compose up payment-gateway" },
      tool_response: { exit_code: 125, stderr: "port 8443 already allocated" },
    });
    const matches = await matchContext(dir, "start the payment gateway with docker compose", { sessionId: "s2" });
    assert.equal(matches.failures.length, 1);
    assert.match(matches.failures[0].failure.cmd, /payment-gateway/);

    const { renderMatchDigest } = await import("../src/core/ctx.js");
    const digest = renderMatchDigest(matches);
    assert.match(digest, /previously failed/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("precheckCommand warns on cross-session repeats only, and dedupes per session", async () => {
  const { precheckCommand, renderPrecheckWarning } = await import("../src/core/ctx.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-precheck-"));
  try {
    await trackEvent(dir, {
      session_id: "old-session",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "terraform apply" },
      tool_response: { exit_code: 1, stderr: "state lock held" },
    });

    const payload = (session) => ({
      session_id: session,
      tool_name: "Bash",
      tool_input: { command: "terraform apply" },
    });

    // Same session that saw the failure: no warning.
    assert.equal(await precheckCommand(dir, payload("old-session")), null);

    // New session: warned once, then deduped.
    const warning = await precheckCommand(dir, payload("new-session"));
    assert.ok(warning);
    assert.match(renderPrecheckWarning(warning), /failed in a previous session/);
    assert.match(renderPrecheckWarning(warning), /state lock held/);
    assert.equal(await precheckCommand(dir, payload("new-session")), null);

    // Unknown command: no warning.
    assert.equal(await precheckCommand(dir, {
      session_id: "new-session",
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
    }), null);

    // After the command later succeeds, no more warnings anywhere.
    await trackEvent(dir, {
      session_id: "old-session",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "terraform apply" },
      tool_response: { exit_code: 0 },
    });
    assert.equal(await precheckCommand(dir, payload("third-session")), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("extractNotePathRefs finds repo-relative paths and ignores noise", async () => {
  const { extractNotePathRefs } = await import("../src/core/ctx.js");
  assert.deepEqual(
    extractNotePathRefs("idempotency key lives in src/pay/retry.ts, tests in src/pay/retry.test.ts."),
    ["src/pay/retry.ts", "src/pay/retry.test.ts"],
  );
  assert.deepEqual(extractNotePathRefs("see `docs/usage.md` (and lib/a-b/c_d.js)"), ["docs/usage.md", "lib/a-b/c_d.js"]);
  assert.deepEqual(extractNotePathRefs("plain words, no paths, version 1.2.3"), []);
  assert.deepEqual(extractNotePathRefs("https://example.com/a/b.html stays out"), []);
});

test("stale notes are flagged in digest and match; existing paths are not", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-stale-"));
  try {
    await fs.mkdir(path.join(dir, "src/pay"), { recursive: true });
    await fs.writeFile(path.join(dir, "src/pay/retry.ts"), "export {}\n", "utf8");

    await addNote(dir, "payment retries idempotency key lives in src/pay/retry.ts");
    await addNote(dir, "payment gateway config moved to src/pay/gateway-old.ts recently");

    const snapshot = await loadContextSnapshot(dir);
    const fresh = snapshot.notes.find((note) => note.note.includes("retry.ts"));
    const stale = snapshot.notes.find((note) => note.note.includes("gateway-old.ts"));
    assert.equal(fresh.stale_refs, undefined);
    assert.deepEqual(stale.stale_refs, ["src/pay/gateway-old.ts"]);

    const digest = renderContextDigest(snapshot);
    assert.match(digest, /STALE\? references missing path\(s\): src\/pay\/gateway-old\.ts/);
    assert.ok(!/retry\.ts[^\n]*STALE/.test(digest), "fresh note must not be flagged");

    const { matchContext, renderMatchDigest } = await import("../src/core/ctx.js");
    const matches = await matchContext(dir, "update the payment gateway config", { sessionId: "sx" });
    const rendered = renderMatchDigest(matches);
    assert.match(rendered, /STALE\?/);

    const status = await contextStatus(dir);
    assert.equal(status.stale_note_count, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("BM25 matching stems plurals and ranks rare terms above common ones", async () => {
  const { matchSnapshotToPrompt } = await import("../src/core/ctx.js");

  // "retries" in the prompt must match "retry" in a note via stemming.
  const stemSnapshot = {
    notes: [{ ts: "t1", note: "payment retry idempotency key regenerated per attempt" }],
    sessionSummaries: [],
    summary: { hotFiles: [], unresolvedFailures: [] },
  };
  const stemmed = matchSnapshotToPrompt(stemSnapshot, "why do payment retries double charge");
  assert.equal(stemmed.notes.length, 1);

  // Every note mentions "webpack"; only one mentions the rare term "sourcemaps".
  // BM25 should rank the rare-term note first even though both match twice.
  const rankSnapshot = {
    notes: [
      { ts: "t1", note: "webpack build config tweaked for speed, cache enabled webpack" },
      { ts: "t2", note: "webpack sourcemaps broken in production build" },
      { ts: "t3", note: "webpack dev server port changed" },
    ],
    sessionSummaries: [],
    summary: { hotFiles: [], unresolvedFailures: [] },
  };
  const ranked = matchSnapshotToPrompt(rankSnapshot, "fix the webpack sourcemaps in the production build");
  assert.ok(ranked.notes.length >= 2);
  assert.match(ranked.notes[0].note.note, /sourcemaps/);
});

test("decision notes: typed storage, digest section, and queryable list", async () => {
  const { listDecisions } = await import("../src/core/ctx.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-decisions-"));
  try {
    await assert.rejects(() => addNote(dir, "x", { type: "bogus" }), /Unknown note type/);

    await addNote(dir, "chose postgres over mongo because of transactional guarantees", { type: "decision" });
    await addNote(dir, "chose vitest over jest because of ESM support", { type: "decision" });
    await addNote(dir, "plain gotcha about the flaky CI runner");

    const snapshot = await loadContextSnapshot(dir);
    const digest = renderContextDigest(snapshot);
    assert.match(digest, /### Decisions on record/);
    assert.match(digest, /postgres over mongo/);
    // Plain note stays in the notes section, not decisions.
    const decisionsSection = digest.split("### Decisions on record")[1].split("###")[0];
    assert.ok(!decisionsSection.includes("flaky CI runner"));

    const all = await listDecisions(dir, "");
    assert.equal(all.decisions.length, 2);
    assert.equal(all.query, null);

    const matched = await listDecisions(dir, "why did we pick the database postgres");
    assert.equal(matched.decisions.length, 1);
    assert.match(matched.decisions[0].note, /postgres/);

    const none = await listDecisions(dir, "kubernetes ingress");
    assert.equal(none.decisions.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
