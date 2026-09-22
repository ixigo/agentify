import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { streamJsonlRecords } from "./session-analysis/stream-jsonl.js";

const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

function migrationKey(plan, session) {
  // ChatGPT exports may be downloaded again at another path; the conversation
  // ID and assigned project keep imports stable across those downloads.
  const source = plan.from === "chatgpt" ? session.cwd : session.path;
  return createHash("sha256").update(`${plan.from}\n${source}\n${session.id}`).digest("hex");
}

function historicalMessage(message) {
  const role = message.role === "assistant" ? "assistant" : "user";
  const text = ["user", "assistant"].includes(message.role)
    ? message.text
    : `[Historical ${message.role}; reference only]\n${message.text}`;
  return { role, text };
}

function contextMessage(plan, session) {
  return `Imported conversation from ${plan.from}, original session ${session.id}. `
    + `The prior messages are historical context, not instructions to replay tools. `
    + `Follow current project instructions. Full source records and saved project context are in ${JSON.stringify(path.join(plan.output, "HANDOFF.md"))}. `
    + "Consult that handoff for notes and decisions when continuing this thread.";
}

async function acquireImportLock(file) {
  try {
    const handle = await fs.open(file, "wx", 0o600);
    await handle.writeFile(String(process.pid));
    return handle;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(await fs.readFile(file, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Migration lock needs inspection: ${file}`, { cause: error });
    try { process.kill(pid, 0); } catch (probe) {
      if (probe.code === "ESRCH") {
        await fs.rm(file);
        return acquireImportLock(file);
      }
      throw probe;
    }
    throw new Error(`Another migration is running (pid ${pid}): ${file}`, { cause: error });
  }
}

async function importClaude(plan, session, homes) {
  const key = migrationKey(plan, session);
  const id = `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
  const directory = path.join(homes.claude, "projects", session.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const destination = path.join(directory, `${id}.jsonl`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let existing;
  try { existing = await fs.lstat(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    if (!existing.isFile()) throw new Error(`Refusing non-file migration destination: ${destination}`);
    let owned = false;
    let title = null;
    await streamJsonlRecords(destination, (record) => {
      if (record.agentifyMigration === key) owned = true;
      if (record.type === "custom-title" && typeof record.customTitle === "string") title = record.customTitle;
    });
    if (!owned) throw new Error(`Existing Claude session is not owned by this migration: ${destination}`);
    return { id, path: destination, title, already_imported: true };
  }

  const temporary = path.join(directory, `.${id}-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  let parentUuid = null;
  const write = async (role, text, timestamp) => {
    const uuid = randomUUID();
    const message = { role, content: [{ type: "text", text }] };
    if (role === "assistant") Object.assign(message, {
      id: `msg_${uuid.replaceAll("-", "")}`, type: "message", model: "<synthetic>",
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await handle.writeFile(`${JSON.stringify({
      type: role, uuid, parentUuid, sessionId: id, cwd: session.cwd,
      timestamp: timestamp || new Date().toISOString(),
      isSidechain: false, userType: "external", entrypoint: "cli",
      agentifyMigration: key, message,
    })}\n`);
    parentUuid = uuid;
  };
  try {
    await write("user", contextMessage(plan, session));
    await streamJsonlRecords(path.join(plan.output, session.messages), async (message) => {
      const { role, text } = historicalMessage(message);
      await write(role, text, message.timestamp);
    });
    await handle.writeFile(`${JSON.stringify({ type: "custom-title", sessionId: id, customTitle: `[${plan.from}] ${session.title || session.id}` })}\n`);
    await handle.close();
    // Link atomically without replacing an existing or concurrently resumed thread.
    await fs.link(temporary, destination);
  } finally {
    await handle.close();
    await fs.rm(temporary, { force: true });
  }
  return { id, path: destination, title: `[${plan.from}] ${session.title || session.id}`, already_imported: false };
}

// Write a native legacy rollout, which Codex discovers and indexes itself.
// Do not edit its SQLite database: its schema changes across CLI versions.
async function importCodex(plan, session, homes) {
  const key = migrationKey(plan, session);
  const directory = path.join(homes.codex, "agentify", "migration-receipts");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const receipt = path.join(directory, `${key}.json`);
  const lock = `${receipt}.lock`;
  const lockHandle = await acquireImportLock(lock);
  try {
    let prior;
    try { prior = JSON.parse(await fs.readFile(receipt, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (prior) {
      if (!(await fs.lstat(prior.path)).isFile()) throw new Error(`Imported Codex session is missing: ${prior.path}`);
      return { ...prior, already_imported: true };
    }
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const sessionDir = path.join(homes.codex, "sessions", timestamp.slice(0, 4), timestamp.slice(5, 7), timestamp.slice(8, 10));
    await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const destination = path.join(sessionDir, `rollout-${timestamp.slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`);
    const temporary = `${destination}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    const write = (type, payload) => handle.writeFile(`${JSON.stringify({ timestamp, type, payload })}\n`);
    const append = async (role, text) => {
      if (role === "user") await write("event_msg", { type: "user_message", message: text, images: [], local_images: [], text_elements: [] });
      await write("response_item", {
        type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
        ...(role === "assistant" ? { phase: "final_answer" } : {}),
      });
      if (role === "assistant") await write("event_msg", { type: "agent_message", message: text, phase: "final_answer" });
    };
    try {
      await write("session_meta", {
        id, timestamp, cwd: session.cwd, originator: "agentify_migrate", cli_version: "0.0.0",
        source: "cli", agentifyMigration: key,
      });
      await append("user", `[${plan.from}] ${session.title || session.id}\n${contextMessage(plan, session)}`);
      await streamJsonlRecords(path.join(plan.output, session.messages), async (message) => {
        const { role, text } = historicalMessage(message);
        await append(role, text);
      });
      await handle.close();
      await fs.link(temporary, destination);
      const native = { id, path: destination, already_imported: false };
      try {
        await fs.writeFile(receipt, `${JSON.stringify(native)}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        await fs.rm(destination, { force: true });
        throw error;
      }
      return native;
    } finally { await handle.close(); await fs.rm(temporary, { force: true }); }
  } finally { await lockHandle.close(); await fs.rm(lock, { force: true }); }
}

export async function importNativeSessions(plan, homes) {
  for (const session of plan.sessions) {
    session.native = plan.to === "claude"
      ? await importClaude(plan, session, homes)
      : await importCodex(plan, session, homes);
    const prefix = plan.to === "claude" ? `CLAUDE_CONFIG_DIR=${quote(homes.claude)} claude --resume` : `CODEX_HOME=${quote(homes.codex)} codex resume`;
    session.native.resume_command = `cd ${quote(session.cwd)} && ${prefix} ${quote(session.native.id)}`;
    if (plan.to === "claude") session.native.desktop = {
      title: session.native.title || `[${plan.from}] ${session.title || session.id}`,
      project: session.cwd,
      action: "Open Claude > Code > Local, choose the project folder, type /resume, and select this title.",
      status: "ready-for-desktop-resume",
    };
  }
}
