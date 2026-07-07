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
