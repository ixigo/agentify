import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { migrateContext, migrateAllContexts, planMigration } from "../src/core/migrate.js";
import { openMigratedSessions, validateDesktopOpen } from "../src/core/migration-desktop.js";

const execFileAsync = promisify(execFile);
const mainCli = path.resolve("src/cli.js");

async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const readRecords = async (file) => (await fs.readFile(file, "utf8")).trim().split("\n").map(JSON.parse);

async function fixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentify-migrate-")));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repo with 'quote'");
  await fs.mkdir(root);
  const options = { from: "codex", to: "claude", codexHome: path.join(temp, "codex"), claudeHome: path.join(temp, "claude") };
  const source = path.join(options.codexHome, "sessions/2026/09/22/rollout-fixture.jsonl");
  const records = [
    { type: "session_meta", payload: { id: "source-session", cwd: root } },
    { type: "event_msg", payload: { type: "user_message", message: "Fix checkout" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix checkout" }] } },
    { type: "response_item", payload: { type: "function_call", name: "exec", call_id: "call-1", arguments: '{"cmd":"npm test"}' } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "Tests passed" } },
    { type: "response_item", payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "Implemented checkout fix" }] } },
  ];
  await write(source, jsonl(records));
  return { root, temp, options, source, records };
}

test("dry-run scopes by recorded cwd, includes archives, and writes nothing", async (t) => {
  const { root, temp, options, records } = await fixture(t);
  await write(path.join(options.codexHome, "sessions/rollout-other.jsonl"), jsonl([{ type: "session_meta", payload: { id: "other", cwd: `${root}-other` } }]));
  await write(path.join(options.codexHome, "archived_sessions/rollout-old.jsonl"), jsonl([{ ...records[0], payload: { id: "archived", cwd: root } }]));
  await write(path.join(root, "AGENTS.md"), "Project instructions");
  const result = await migrateContext(root, { ...options, dryRun: true, output: path.join(temp, "preview") });
  assert.equal(result.sessions.length, 2);
  assert.equal(result.files.length, 1);
  await assert.rejects(fs.stat(result.output), { code: "ENOENT" });
  await assert.rejects(fs.stat(options.claudeHome), { code: "ENOENT" });
});

test("folder CLI imports descendants but excludes siblings, and repeat imports preserve threads", async (t) => {
  const { root, options } = await fixture(t);
  const nested = path.join(root, "app", "module");
  for (const [id, cwd] of [["nested", nested], ["sibling", `${root}-other`]]) {
    await write(path.join(options.codexHome, `sessions/rollout-${id}.jsonl`), jsonl([
      { type: "session_meta", payload: { id, cwd } },
      { type: "event_msg", payload: { type: "user_message", message: id } },
    ]));
  }
  const flags = ["--codex-home", options.codexHome, "--claude-home", options.claudeHome, "--json"];
  const run = async (...extra) => JSON.parse((await execFileAsync(process.execPath, [mainCli, "migrate", root, ...flags, ...extra])).stdout);
  const preview = await run("--dry-run", "--open");
  assert.deepEqual(preview.sessions.map((s) => s.id).sort(), ["nested", "source-session"]);
  assert.equal(preview.target_surface, "desktop");
  await assert.rejects(fs.stat(options.claudeHome), { code: "ENOENT" });
  const imported = await run();
  assert.deepEqual(imported.sessions.map((s) => s.cwd).sort(), [root, nested].sort());
  const original = await Promise.all(imported.sessions.map((s) => fs.readFile(s.native.path)));
  const repeated = await run();
  assert.ok(repeated.sessions.every((s) => s.native.already_imported));
  assert.deepEqual(await Promise.all(imported.sessions.map((s) => fs.readFile(s.native.path))), original);
  for (const extra of [["--all"], ["--root", root], ["another-folder"]]) {
    await assert.rejects(run(...extra), /either --all|folder argument or --root|accepts one folder/);
  }
});

test("desktop handoff uses argument-safe links, preserves failed imports, and never opens previews", async () => {
  const session = (id) => ({ native: { id, desktop: { status: "ready-for-desktop-resume" } } });
  const result = { sessions: [session("first"), session("second"), session("third")], warnings: [] };
  const calls = [];
  await openMigratedSessions(result, async (...args) => {
    calls.push(args);
    if (calls.length === 2) throw new Error("App unavailable");
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].slice(0, 2), ["/usr/bin/open", ["-a", "/Applications/Claude.app", "claude://resume?session=first"]]);
  assert.deepEqual(result.desktop_open, { requested: 2, failed: 1 });
  assert.match(result.warnings[0], /imported thread is saved/);
  assert.equal(result.sessions[1].native.desktop.status, "ready-for-desktop-resume");
  await openMigratedSessions({ ...result, dry_run: true }, () => assert.fail("preview opened app"));
  assert.throws(() => validateDesktopOpen({ targetSurface: "cli" }), /requires --to/);
  assert.throws(() => validateDesktopOpen({ targetSurface: "desktop" }, "linux"), /macOS/);
  assert.throws(() => validateDesktopOpen({ targetSurface: "desktop", claudeHome: "/tmp/custom" }, "darwin"), /default/);
});

test("Codex migration preserves raw bytes, context, titles, and resumable Claude chains", async (t) => {
  const { root, options, source } = await fixture(t);
  await fs.appendFile(source, "{truncated");
  const original = await fs.readFile(source);
  await write(path.join(options.codexHome, "session_index.jsonl"), jsonl([{ id: "source-session", thread_name: "Checkout thread" }]));
  await write(path.join(root, ".agentify/context/notes.jsonl"), '{"text":"Keep checkout decision"}\n');
  await write(path.join(root, ".agentify/context/handoffs/old.md"), "Prior handoff");
  await write(path.join(root, "AGENTS.md"), "Keep project rules");
  await write(path.join(options.codexHome, "memories/MEMORY.md"), "Global memory");
  await write(path.join(options.codexHome, "auth.json"), "SECRET");
  const result = await migrateContext(root, { ...options, includeGlobal: true });
  const session = result.sessions[0];
  assert.deepEqual(await fs.readFile(path.join(result.output, session.raw)), original);
  assert.deepEqual(await fs.readFile(source), original);
  assert.equal(session.coverage.malformed, 1);
  assert.match(result.warnings.join("\n"), /malformed/);
  assert.equal(await fs.readFile(path.join(result.output, "global/memories/MEMORY.md"), "utf8"), "Global memory");
  assert.equal(await fs.readFile(path.join(result.output, "context-0/handoffs/old.md"), "utf8"), "Prior handoff");
  assert.ok(!result.files.some((f) => f.source.endsWith("auth.json")));
  const imported = await readRecords(session.native.path);
  const messages = imported.filter((r) => r.message);
  assert.equal(messages[0].parentUuid, null);
  for (let i = 1; i < messages.length; i++) assert.equal(messages[i].parentUuid, messages[i - 1].uuid);
  assert.ok(messages.every((r) => r.sessionId === session.native.id));
  const text = messages.map((r) => r.message.content[0].text).join("\n");
  assert.equal(text.match(/Fix checkout/g).length, 1, "event mirror is not duplicated");
  assert.match(text, /Tests passed/);
  assert.match(text, /codex channel: final/);
  assert.match(text, /HANDOFF.md/);
  assert.equal(imported.at(-1).customTitle, "[codex] Checkout thread");
  assert.ok(!messages.some((r) => r.message.content.some((block) => block.type === "tool_use")));
  assert.match(session.native.resume_command, /claude --resume/);
  assert.equal((await fs.stat(session.native.path)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(result.output)).mode & 0o777, 0o700);
});

test("repeat migration leaves a continued destination thread untouched", async (t) => {
  const { root, options } = await fixture(t);
  const first = await migrateContext(root, options);
  const native = first.sessions[0].native;
  await fs.appendFile(native.path, '{"type":"summary","summary":"Continued in Claude"}\n');
  const before = await fs.readFile(native.path);
  const second = await migrateContext(root, options);
  assert.equal(second.sessions[0].native.id, native.id);
  assert.equal(second.sessions[0].native.already_imported, true);
  assert.deepEqual(await fs.readFile(native.path), before);
});

test("global memory is opt-in and symlinks cannot pull in unrelated files", async (t) => {
  const { root, temp, options } = await fixture(t);
  await write(path.join(options.codexHome, "memories/MEMORY.md"), "Private global memory");
  const secret = path.join(temp, "secret");
  await write(secret, "SECRET");
  await fs.symlink(secret, path.join(root, "AGENTS.md"));
  const plan = await planMigration(root, options);
  assert.ok(!plan.files.some((f) => f.destination.startsWith("global")));
  assert.ok(!plan.files.some((f) => f.source.endsWith("AGENTS.md")));
  assert.match(plan.warnings.join("\n"), /symbolic link/);
});

test("all mode migrates nested projects once each and skips sessions without cwd", async (t) => {
  const { root, options } = await fixture(t);
  const nested = path.join(root, "nested");
  await fs.mkdir(nested);
  await write(path.join(options.codexHome, "sessions/rollout-nested.jsonl"), jsonl([{ type: "session_meta", payload: { id: "nested", cwd: nested } }]));
  await write(path.join(options.codexHome, "sessions/rollout-unknown.jsonl"), jsonl([{ type: "session_meta", payload: { id: "unknown" } }]));
  const result = await migrateAllContexts({ ...options, dryRun: true });
  assert.equal(result.projects.length, 2);
  assert.deepEqual(result.projects.map((p) => p.sessions.length), [1, 1]);
});

test("invalid providers, missing session, and existing output fail without native writes", async (t) => {
  const { root, options } = await fixture(t);
  await assert.rejects(migrateContext(root, { ...options, to: "codex" }), /different/);
  await assert.rejects(migrateContext(root, { ...options, session: "missing" }), /No codex session/);
  await assert.rejects(migrateContext(root, { ...options, output: root }), /already exists/);
  await assert.rejects(migrateContext(root, { ...options, output: true }), /requires a path/);
  await assert.rejects(fs.stat(options.claudeHome), { code: "ENOENT" });
});

test("Claude -> Codex writes discoverable native events without launching a provider", async (t) => {
  const { root, options } = await fixture(t);
  await write(path.join(options.claudeHome, "projects/project/source.jsonl"), jsonl([
    { type: "user", sessionId: "claude-source", cwd: root, message: { role: "user", content: "Continue checkout" } },
    { type: "assistant", sessionId: "claude-source", cwd: root, message: { content: [{ type: "text", text: "Checkout done" }] } },
  ]));
  const reverse = { ...options, from: "claude", to: "codex" };
  const result = await migrateContext(root, reverse);
  const native = result.sessions[0].native;
  const records = await readRecords(native.path);
  assert.equal(records[0].payload.id, native.id);
  assert.equal(records[0].payload.cwd, root);
  assert.equal(records[0].payload.source, "cli");
  assert.ok(records.some((r) => r.type === "event_msg" && r.payload.type === "user_message"));
  assert.ok(records.some((r) => r.type === "event_msg" && r.payload.type === "agent_message"));
  const messages = records.filter((r) => r.type === "response_item");
  assert.match(JSON.stringify(messages), /Continue checkout/);
  assert.match(JSON.stringify(messages), /Checkout done/);
  assert.equal(messages.at(-1).payload.phase, "final_answer");
  await fs.appendFile(native.path, '{"type":"event_msg","payload":{"type":"agent_message","message":"Continued"}}\n');
  const before = await fs.readFile(native.path);
  const second = await migrateContext(root, reverse);
  assert.equal(second.sessions[0].native.already_imported, true);
  assert.equal(second.sessions[0].native.id, native.id);
  assert.deepEqual(await fs.readFile(native.path), before);
});

test("migrate command needs no repo initialization and has dedicated help", async (t) => {
  const { root, temp, options } = await fixture(t);
  const { stdout } = await execFileAsync(process.execPath, [mainCli, "migrate", "--root", root, "--codex-home", options.codexHome, "--claude-home", options.claudeHome, "--json", "--dry-run"], { env: { ...process.env, HOME: temp } });
  assert.equal(JSON.parse(stdout).sessions.length, 1);
  await assert.rejects(fs.stat(path.join(root, ".agentify")), { code: "ENOENT" });
  const help = await execFileAsync(process.execPath, [mainCli, "migrate", "--help"], { env: { ...process.env, HOME: temp } });
  assert.match(help.stdout, /Usage: agentify migrate/);
  assert.match(help.stdout, /--include-global/);
});

test("Codex app session metadata can be prepared for the Claude Desktop picker", async (t) => {
  const { temp, root, options, source, records } = await fixture(t);
  records[0].payload.originator = "Codex Desktop";
  records[0].payload.source = "vscode";
  await write(source, jsonl(records));
  const { stdout } = await execFileAsync(process.execPath, [mainCli, "migrate", "--from", "codex", "--to", "claude-desktop", "--all", "--codex-home", options.codexHome, "--claude-home", options.claudeHome, "--json"], { env: { ...process.env, HOME: temp } });
  const result = JSON.parse(stdout);
  assert.equal(result.projects.length, 1);
  const project = result.projects[0];
  assert.equal(project.root, root);
  assert.equal(project.target_surface, "desktop");
  assert.equal(project.sessions[0].native.desktop.status, "ready-for-desktop-resume");
  assert.match(await fs.readFile(path.join(project.output, "OPEN-IN-CLAUDE.md"), "utf8"), /select the Code tab/);
});

test("event-only Codex sessions keep human and assistant turns", async (t) => {
  const { root, options, source } = await fixture(t);
  await write(source, jsonl([
    { type: "session_meta", payload: { id: "events", cwd: root } },
    { type: "event_msg", payload: { type: "user_message", message: "Event question" } },
    { type: "event_msg", payload: { type: "agent_message", message: "Event answer" } },
  ]));
  const result = await migrateContext(root, options);
  const native = await fs.readFile(result.sessions[0].native.path, "utf8");
  assert.match(native, /Event question/);
  assert.match(native, /Event answer/);
});

test("Claude rewinds keep the active chain as context and archive discarded branches", async (t) => {
  const { root, options } = await fixture(t);
  const message = (uuid, parentUuid, text) => ({ type: "user", uuid, parentUuid, cwd: root, sessionId: "rewind", message: { content: text } });
  await write(path.join(options.claudeHome, "projects/project/rewind.jsonl"), jsonl([
    message("a", null, "First prompt"),
    message("b", "a", "Discarded branch"),
    message("c", "a", "Active branch"),
  ]));
  const result = await migrateContext(root, { ...options, from: "claude", to: "codex" });
  const session = result.sessions[0];
  const native = await fs.readFile(session.native.path, "utf8");
  assert.match(native, /First prompt/);
  assert.match(native, /Active branch/);
  assert.doesNotMatch(native, /Discarded branch/);
  assert.match(await fs.readFile(path.join(result.output, session.raw), "utf8"), /Discarded branch/);
});
