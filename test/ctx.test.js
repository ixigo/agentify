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

test("summarizeSession writes once, respects thresholds, and lands in digest + match", async () => {
  const { summarizeSession, loadContextSnapshot, renderContextDigest, matchSnapshotToPrompt } = await import("../src/core/ctx.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-ctx-sum-"));
  try {
    const edit = (sid, file) => trackEvent(dir, { session_id: sid, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file } });

    // below threshold
    await edit("thin-sess", "a.js");
    const thin = await summarizeSession(dir, {}, "thin-sess", { runtime: { delegate: async () => ({ exit_code: 0, output: "x" }) } });
    assert.equal(thin.status, "too_few_events");

    for (let i = 0; i < 3; i += 1) {
      await edit("full-sess", "src/pay/retry.ts");
    }
    const prompts = [];
    const written = await summarizeSession(dir, {}, "full-sess", {
      runtime: { delegate: async (prompt) => { prompts.push(prompt); return { exit_code: 0, output: "Fixed the payment retry idempotency bug; tests green." }; } },
    });
    assert.equal(written.status, "written");
    assert.match(prompts[0], /src\/pay\/retry\.ts/);

    const again = await summarizeSession(dir, {}, "full-sess", { runtime: { delegate: async () => ({ exit_code: 0, output: "nope" }) } });
    assert.equal(again.status, "already_summarized");

    const snapshot = await loadContextSnapshot(dir);
    assert.equal(snapshot.sessionSummaries.length, 1);
    assert.match(renderContextDigest(snapshot), /What recent sessions did/);

    const matches = matchSnapshotToPrompt(snapshot, "why is payment retry double charging");
    assert.equal(matches.summaries.length, 1);

    const failed = await summarizeSession(dir, {}, "other", { runtime: { delegate: async () => ({ exit_code: 1, output: "" }) }, minEvents: 0 });
    assert.equal(failed.status, "delegate_failed");
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
