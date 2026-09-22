import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { chatGptMessages } from "../src/core/migration-chatgpt.js";
import { migrateContext } from "../src/core/migrate.js";

const execFileAsync = promisify(execFile);
const mainCli = path.resolve("src/cli.js");
function conversation(id = "chatgpt-thread") {
  const node = (parent, role, parts, extra = {}) => ({ parent, message: { author: { role }, content: { content_type: "text", parts }, create_time: 1790060000, ...extra } });
  return {
    id, title: "Checkout discussion", current_node: "answer", update_time: 1790060001,
    mapping: {
      root: { parent: null, message: null },
      hidden: node("root", "system", ["Hidden bookkeeping"], { metadata: { is_visually_hidden_from_conversation: true } }),
      question: node("hidden", "user", ["Why is checkout failing?"]),
      discarded: node("question", "assistant", ["Discarded answer"]),
      answer: node("question", "assistant", ["Use the selected payment method"], { channel: "final" }),
    },
  };
}
async function fixture(t, data = [conversation()]) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentify-chatgpt-")));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "project");
  await fs.mkdir(root);
  const input = path.join(temp, "conversations.json");
  await fs.writeFile(input, JSON.stringify(data));
  return { temp, root, options: { from: "chatgpt", to: "claude", targetSurface: "desktop", input, claudeHome: path.join(temp, "claude"), codexHome: path.join(temp, "codex") } };
}

test("ChatGPT parser follows the active branch and skips hidden nodes", () => {
  assert.deepEqual(chatGptMessages(conversation()).map((m) => [m.role, m.text]), [
    ["user", "Why is checkout failing?"],
    ["assistant", "[chatgpt channel: final]\nUse the selected payment method"],
  ]);
});

test("ChatGPT parser handles attachments explicitly and rejects corrupt branch graphs", () => {
  const image = conversation();
  image.mapping.question.message.content.parts.push({ content_type: "image_asset_pointer", asset_pointer: "file-service://asset" });
  assert.match(chatGptMessages(image)[0].text, /image_asset_pointer; see original export/);
  const cycle = conversation(); cycle.mapping.question.parent = "answer";
  assert.throws(() => chatGptMessages(cycle), /parent cycle/);
  const missing = conversation(); missing.current_node = "absent";
  assert.throws(() => chatGptMessages(missing), /missing message/);
  const ambiguous = conversation(); delete ambiguous.current_node;
  assert.throws(() => chatGptMessages(ambiguous), /ambiguous branches/);
});

test("ChatGPT -> Desktop archives all branches but imports only the active conversation", async (t) => {
  const { root, options } = await fixture(t);
  const before = await fs.readFile(options.input);
  const result = await migrateContext(root, options);
  assert.equal(result.target_surface, "desktop");
  assert.equal(result.sessions.length, 1);
  const session = result.sessions[0];
  const records = (await fs.readFile(session.native.path, "utf8")).trim().split("\n").map(JSON.parse);
  const text = records.filter((r) => r.message).map((r) => r.message.content[0].text).join("\n");
  assert.match(text, /Why is checkout failing/);
  assert.match(text, /Use the selected payment method/);
  assert.doesNotMatch(text, /Discarded answer|Hidden bookkeeping/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.output, session.raw), "utf8")), conversation());
  assert.deepEqual(await fs.readFile(options.input), before);
  assert.equal(session.native.desktop.status, "ready-for-desktop-resume");
  assert.equal(session.native.desktop.title, "[chatgpt] Checkout discussion");
  assert.match(await fs.readFile(path.join(result.output, "OPEN-IN-CLAUDE.md"), "utf8"), /Type \/resume/);
  assert.doesNotMatch(JSON.stringify(result), /Discarded answer|Hidden bookkeeping|Use the selected payment method/);
});

test("ChatGPT dry-run does not write or expose conversation bodies in JSON", async (t) => {
  const { root, options } = await fixture(t);
  const result = await migrateContext(root, { ...options, dryRun: true });
  assert.equal(result.sessions.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /Why is checkout failing/);
  await assert.rejects(fs.stat(options.claudeHome), { code: "ENOENT" });
});

test("repeat ChatGPT exports at new paths preserve the imported and continued thread", async (t) => {
  const { temp, root, options } = await fixture(t);
  const first = await migrateContext(root, options);
  const native = first.sessions[0].native;
  await fs.appendFile(native.path, '{"type":"custom-title","customTitle":"Renamed in Claude"}\n');
  const before = await fs.readFile(native.path);
  const next = path.join(temp, "another-export.json");
  await fs.copyFile(options.input, next);
  const second = await migrateContext(root, { ...options, input: next });
  assert.equal(second.sessions[0].native.id, native.id);
  assert.equal(second.sessions[0].native.already_imported, true);
  assert.equal(second.sessions[0].native.desktop.title, "Renamed in Claude");
  assert.deepEqual(await fs.readFile(native.path), before);
});

test("invalid exports and unsupported options fail before destination writes", async (t) => {
  const { root, options } = await fixture(t);
  await assert.rejects(migrateContext(root, { ...options, input: undefined }), /requires --input/);
  await assert.rejects(migrateContext(root, { ...options, includeGlobal: true }), /not ChatGPT exports/);
  await fs.writeFile(options.input, "[");
  await assert.rejects(migrateContext(root, options), /not valid JSON/);
  await fs.writeFile(options.input, JSON.stringify([conversation(), conversation()]));
  await assert.rejects(migrateContext(root, options), /Duplicate/);
  await fs.writeFile(options.input, "[]");
  await assert.rejects(migrateContext(root, options), /no conversations/);
  await assert.rejects(fs.stat(options.claudeHome), { code: "ENOENT" });
});

test("CLI supports ChatGPT export directories, project assignment, filtering, and Desktop instructions", async (t) => {
  const { temp, root, options } = await fixture(t, [conversation("one"), conversation("two")]);
  const { stdout } = await execFileAsync(process.execPath, [mainCli, "migrate", "--from", "chatgpt", "--to", "claude-desktop", "--input", temp, "--root", root, "--session", "two", "--claude-home", options.claudeHome, "--json"], { env: { ...process.env, HOME: temp } });
  const result = JSON.parse(stdout);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, "two");
  assert.equal(result.target_surface, "desktop");
  assert.match(result.sessions[0].native.desktop.action, /\/resume/);
});
