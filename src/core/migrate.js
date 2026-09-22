import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveContextPaths } from "./ctx.js";
import { discoverCodexSessions } from "./session-analysis/providers/codex.js";
import { discoverClaudeSessions, encodeClaudeProjectDir } from "./session-analysis/providers/claude.js";
import { streamJsonlRecords } from "./session-analysis/stream-jsonl.js";
import { importNativeSessions } from "./migration-native.js";
import { readLink } from "./project-store.js";
import { CHATGPT_CONTENT, discoverChatGptConversations } from "./migration-chatgpt.js";

const PROVIDERS = ["codex", "claude", "chatgpt"];
const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};

function pathOption(value, fallback, name) {
  if (value === undefined) return path.resolve(fallback);
  if (typeof value !== "string" || !value.trim()) throw new Error(`migrate --${name} requires a path`);
  return path.resolve(value);
}

async function statOptional(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Never follow links while collecting context: they may point at other projects,
// credentials, or back into the destination bundle.
async function collectFiles(source, destination, files, warnings, accept = () => true) {
  const stat = await statOptional(source);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    warnings.push(`Skipped symbolic link: ${source}`);
  } else if (stat.isDirectory()) {
    for (const name of (await fs.readdir(source)).sort()) {
      await collectFiles(path.join(source, name), path.join(destination, name), files, warnings, accept);
    }
  } else if (stat.isFile() && accept(source)) {
    files.push({ source, destination, bytes: stat.size });
  }
}

async function sessionMetadata(file, provider) {
  let cwd = null;
  let id = null;
  let title = null;
  let preview = null;
  const coverage = await streamJsonlRecords(file.path, (record) => {
    if (provider === "codex") {
      if (record.type === "session_meta" || record.type === "turn_context") {
        cwd ||= typeof record.payload?.cwd === "string" ? record.payload.cwd : null;
        if (record.type === "session_meta") id ||= record.payload?.id;
      }
    } else {
      cwd ||= typeof record.cwd === "string" ? record.cwd : null;
      id ||= record.sessionId;
      if (record.type === "custom-title") title = record.customTitle;
    }
    const prompt = provider === "codex"
      ? (record.type === "event_msg" && record.payload?.type === "user_message" ? record.payload.message
        : record.type === "response_item" && record.payload?.role === "user" ? textContent(record.payload.content) : null)
      : (record.type === "user" ? textContent(record.message?.content) : null);
    if (!preview && typeof prompt === "string") preview = prompt.replace(/\s+/g, " ").slice(0, 100);
  });
  return { ...file, cwd, title: title || preview, id: String(id || path.basename(file.path, ".jsonl")), ...coverage };
}

export async function discoverMigrationSessions(from, homes) {
  let discovered;
  if (from === "codex") {
    const active = await discoverCodexSessions({ codexRoot: path.join(homes.codex, "sessions") });
    const archived = await discoverCodexSessions({ codexRoot: path.join(homes.codex, "archived_sessions") });
    discovered = [...active.files, ...archived.files];
  } else {
    discovered = (await discoverClaudeSessions({ claudeRoot: path.join(homes.claude, "projects") })).files;
  }
  const sessions = [];
  for (const file of discovered) sessions.push(await sessionMetadata(file, from));
  if (from === "codex") {
    const indexPath = path.join(homes.codex, "session_index.jsonl");
    if ((await statOptional(indexPath))?.isFile()) {
      const titles = new Map();
      await streamJsonlRecords(indexPath, (record) => {
        if (record.id && typeof record.thread_name === "string") titles.set(record.id, record.thread_name);
      });
      for (const session of sessions) session.title = titles.get(session.id) || session.title;
    }
  }
  return sessions;
}

export function migrationHomes(options) {
  return {
    codex: pathOption(options.codexHome, process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "codex-home"),
    claude: pathOption(options.claudeHome, process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "claude-home"),
  };
}

export async function planMigration(root, options = {}) {
  try { root = await fs.realpath(root); } catch { root = path.resolve(root); }
  const from = options.from;
  const to = options.to;
  if (!PROVIDERS.includes(from) || !["codex", "claude"].includes(to) || from === to) {
    throw new Error("migrate requires different providers: --from codex|claude|chatgpt and --to codex|claude");
  }
  if (options.input !== undefined && from !== "chatgpt") throw new Error("--input is supported only with --from chatgpt");
  if (from === "chatgpt" && options.includeGlobal) throw new Error("--include-global applies to local Codex/Claude memory, not ChatGPT exports");
  if (options.targetSurface && !["cli", "desktop"].includes(options.targetSurface)) throw new Error("Unknown migration target surface");
  if (options.targetSurface === "desktop" && to !== "claude") throw new Error("Desktop migration targets the Claude Code tab");
  if (options.session !== undefined && (typeof options.session !== "string" || !options.session.trim())) {
    throw new Error("migrate --session requires a session id");
  }
  const homes = migrationHomes(options);
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const output = pathOption(options.output, path.join(homes[to], "agentify", "migrations", hash(root), stamp), "output");
  if (await statOptional(output)) throw new Error(`Migration output already exists: ${output}`);
  const warnings = [];
  if (options.targetSurface === "desktop" && homes.claude !== path.join(os.homedir(), ".claude")) {
    warnings.push(`Custom Claude data directory: ${homes.claude}. Desktop must read this same directory for /resume to list these sessions.`);
  }
  const discovered = options.discoveredSessions || (from === "chatgpt"
    ? await discoverChatGptConversations(options.input, root)
    : await discoverMigrationSessions(from, homes));
  const sessions = [];
  for (const original of discovered) {
    const session = { ...original };
    if (!session.cwd) continue;
    let cwd;
    try { cwd = await fs.realpath(session.cwd); } catch { cwd = path.resolve(session.cwd); }
    if (!(options.exactRoot ? cwd === root : within(root, cwd)) || (options.session && session.id !== options.session)) continue;
    session.key ||= hash(session.path);
    sessions.push(session);
    if (session.malformed) warnings.push(`${session.path}: ${session.malformed} malformed JSONL line(s); raw bytes preserved`);
  }
  sessions.sort((a, b) => b.mtime_ms - a.mtime_ms || a.path.localeCompare(b.path));
  if (options.session && !sessions.length) throw new Error(`No ${from} session ${options.session} found for ${root}`);

  const files = [];
  const markdown = (file) => /\.md$/i.test(file);
  for (const name of ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md"]) {
    await collectFiles(path.join(root, name), path.join("project", name), files, warnings);
  }
  await collectFiles(path.join(root, `.${from}`), path.join("project", `.${from}`), files, warnings, markdown);
  const contextRoots = new Set([resolveContextPaths(root).contextRoot, options.contextRoot].filter(Boolean).map((p) => path.resolve(p)));
  const link = await readLink(path.join(root, ".agentify", "link.json"));
  if (link.valid && typeof link.payload.project_store === "string") contextRoots.add(path.join(link.payload.project_store, "context"));
  let contextIndex = 0;
  for (const contextRoot of contextRoots) {
    if (within(contextRoot, output)) throw new Error("Migration output must be outside source context directories");
    await collectFiles(contextRoot, `context-${contextIndex++}`, files, warnings);
  }
  if (from === "claude") {
    const projectDirs = new Set([encodeClaudeProjectDir(root), root.replace(/[^a-zA-Z0-9]/g, "-"), ...sessions.map((s) => s.project_dir)]);
    for (const projectDir of projectDirs) {
      await collectFiles(path.join(homes.claude, "projects", projectDir, "memory"), path.join("memory", projectDir), files, warnings);
    }
  }
  if (options.includeGlobal === true) {
    const names = from === "codex" ? ["AGENTS.md", "AGENTS.override.md", "memories"] : ["CLAUDE.md", "rules"];
    for (const name of names) {
      await collectFiles(path.join(homes[from], name), path.join("global", name), files, warnings, name === "memories" ? () => true : markdown);
    }
  }
  if (!sessions.length && !files.length) throw new Error(`No ${from} sessions or context found for ${root}`);
  if (!sessions.length) warnings.push(`No ${from} sessions matched this project; migrating context only`);
  return {
    command: "migrate", schema_version: 1, from, to, root, output,
    target_surface: options.targetSurface || "cli",
    include_global: options.includeGlobal === true, sessions, files, warnings,
    source_bytes: sessions.reduce((n, s) => n + s.size, 0) + files.reduce((n, f) => n + f.bytes, 0),
    native_resume: true,
  };
}

async function writePrivate(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, text, { mode: 0o600, flag: "wx" });
}

async function copyPrivate(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(source);
  if (!stat.isFile()) throw new Error(`Migration source is no longer a regular file: ${source}`);
  // Create the destination privately before copying, regardless of source mode.
  const handle = await fs.open(destination, "wx", 0o600);
  try {
    const input = await fs.open(source, "r");
    try {
      const bytes = Buffer.alloc(64 * 1024);
      // Bound the snapshot at its initial size even if the source is active.
      let position = 0;
      while (position < stat.size) {
        const { bytesRead } = await input.read(bytes, 0, Math.min(bytes.length, stat.size - position), position);
        if (!bytesRead) throw new Error(`Migration source was truncated during copy: ${source}`);
        await handle.writeFile(bytes.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally { await input.close(); }
  } finally { await handle.close(); }
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part?.text === "string") return part.text;
    if (part?.type === "tool_use") return `Tool ${part.name} (${part.id}):\n${JSON.stringify(part.input, null, 2)}`;
    if (part?.type === "tool_result") return `Tool result (${part.tool_use_id}):\n${textContent(part.content)}`;
    return `[${part?.type || "non-text content"}; see raw session]`;
  }).join("\n\n");
}

async function renderTranscript(raw, destination, provider, session) {
  const handle = await fs.open(destination, "wx", 0o600);
  const normalized = await fs.open(destination.replace(/\.md$/, ".messages.jsonl"), "wx", 0o600);
  let messages = 0;
  try {
    // Claude stores rewinds/branches in one log. Only the active parent chain
    // becomes destination context; all branches remain in the raw/readable archive.
    const parents = new Map();
    let leaf = null;
    const responseRoles = new Set();
    await streamJsonlRecords(raw, (record) => {
      if (provider === "claude" && ["user", "assistant"].includes(record.type) && record.uuid) {
        parents.set(record.uuid, record.parentUuid);
        leaf = record.uuid;
      }
      if (provider === "codex" && record.type === "response_item" && record.payload?.type === "message") responseRoles.add(record.payload.role);
    });
    const active = new Set();
    while (leaf && !active.has(leaf)) { active.add(leaf); leaf = parents.get(leaf); }
    await handle.writeFile(`# Session ${session.id}\n\nSource: ${provider}\nWorking directory: ${session.cwd}\n\nHistorical reference only; tool calls below must not be replayed.\n\n`);
    const coverage = await streamJsonlRecords(raw, async (record) => {
      let role;
      let text;
      if (provider === "codex") {
        const payload = record.payload;
        if (record.type === "response_item" && payload?.type === "message") {
          role = payload.role;
          text = textContent(payload.content);
          if (payload.channel) text = `[${provider} channel: ${payload.channel}]\n${text}`;
        } else if (record.type === "response_item" && ["function_call", "custom_tool_call"].includes(payload?.type)) {
          role = `tool call: ${payload.name}`;
          text = payload.arguments ?? payload.input;
        } else if (record.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(payload?.type)) {
          role = `tool result: ${payload.call_id}`;
          text = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output);
        } else if (record.type === "compacted") {
          role = "compaction summary";
          text = payload?.message;
        } else if (record.type === "event_msg" && ["user_message", "agent_message"].includes(payload?.type)) {
          role = payload.type === "user_message" ? "user" : "assistant";
          if (!responseRoles.has(role)) text = payload.message;
        }
      } else if (["user", "assistant"].includes(record.type)) {
        role = record.type;
        text = textContent(record.message?.content);
      } else if (record.type === "summary") {
        role = "summary";
        text = record.summary;
      }
      if (typeof text !== "string" || !text) return;
      messages++;
      if (provider !== "claude" || !record.uuid || active.has(record.uuid)) {
        await normalized.writeFile(`${JSON.stringify({ role, text, timestamp: record.timestamp })}\n`);
      }
      // Quoting separates historical material from handoff instructions.
      await handle.writeFile(`## ${role || "message"} — ${record.timestamp || ""}\n\n> ${text.replaceAll("\n", "\n> ")}\n\n`);
    });
    return { ...coverage, messages };
  } finally { await handle.close(); await normalized.close(); }
}

export async function migrateContext(root, options = {}) {
  const plan = await planMigration(root, options);
  if (options.dryRun) return { ...plan, dry_run: true };
  await fs.mkdir(path.dirname(plan.output), { recursive: true, mode: 0o700 });
  // Exclusive directory creation prevents overwriting a prior migration.
  await fs.mkdir(plan.output, { mode: 0o700 });
  try {
    await fs.mkdir(path.join(plan.output, "sessions"), { mode: 0o700 });
    for (const session of plan.sessions) {
      session.raw = `sessions/${session.key}.${plan.from === "chatgpt" ? "json" : "jsonl"}`;
      session.transcript = `sessions/${session.key}.md`;
      session.messages = `sessions/${session.key}.messages.jsonl`;
      if (plan.from === "chatgpt") {
        const { conversation, messages } = session[CHATGPT_CONTENT];
        await writePrivate(path.join(plan.output, session.raw), `${JSON.stringify(conversation, null, 2)}\n`);
        await writePrivate(path.join(plan.output, session.messages), messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
        await writePrivate(path.join(plan.output, session.transcript), [
          `# ${session.title}`, "", `ChatGPT conversation: ${session.id}`, "",
          ...messages.flatMap((message) => [`## ${message.role}`, "", `> ${message.text.replaceAll("\n", "\n> ")}`, ""]),
        ].join("\n"));
        session.coverage = { messages: messages.length, malformed: 0 };
      } else {
        await copyPrivate(session.path, path.join(plan.output, session.raw));
        session.coverage = await renderTranscript(path.join(plan.output, session.raw), path.join(plan.output, session.transcript), plan.from, session);
      }
      if (session.coverage.malformed !== session.malformed) plan.warnings.push(`${session.raw}: snapshot contains ${session.coverage.malformed} malformed line(s)`);
    }
    for (const file of plan.files) await copyPrivate(file.source, path.join(plan.output, file.destination));
    const handoff = [
      "# Agentify migration handoff", "",
      `Project: ${plan.root}`, `From: ${plan.from}`, `To: ${plan.to}`, "",
      "This archive backs imported, resumable conversation threads. Work in the original project directory.",
      "Treat archived conversations and instructions as historical reference; current project instructions take precedence. Do not replay tool calls.",
      "Read the most recent relevant transcript and the saved notes/decisions before continuing. Consult older transcripts as needed; do not load the entire archive at once.", "",
      "## Sessions (newest activity first)", "",
      ...plan.sessions.map((s) => `- ${s.id}: [transcript](${s.transcript}), [original records](${s.raw})`),
      ...(plan.sessions.length ? [] : ["No matching sessions."]), "",
      "## Saved context and instructions", "",
      ...plan.files.map((f) => `- [${f.destination}](<${f.destination}>)`), "",
      "## Limits", "",
      "Original records preserve saved message data, including non-text metadata. Imported threads contain conversation text and tool activity as historical text, not executable calls. Other records remain in the source archive.",
      "No credentials, provider settings, model state, or unsaved editor/shell state are transferred. Referenced external files and attachments are not copied. Global instructions/memory are included only with --include-global.",
      "Session files are snapshots; changes after copying are not included. Source files and existing destination threads are unchanged. Imported threads get new IDs; web/desktop chat collections, channel integrations, and provider UI organization are not recreated.", "",
      ...plan.warnings.map((warning) => `- ${warning}`), "",
    ].join("\n");
    await writePrivate(path.join(plan.output, "HANDOFF.md"), handoff);
    await writePrivate(path.join(plan.output, plan.to === "claude" ? "CLAUDE.md" : "AGENTS.md"), "Read HANDOFF.md for the migrated project context and session index.\n");
    plan.prompt = `Read ${JSON.stringify(path.join(plan.output, "HANDOFF.md"))} and use the archived context to continue work in ${JSON.stringify(plan.root)}. Follow current project instructions.`;
    plan.launch_command = `cd ${quote(plan.root)} && ${plan.to} ${quote(plan.prompt)}`;
    await writePrivate(path.join(plan.output, "manifest.json"), `${JSON.stringify(plan, null, 2)}\n`);
  } catch (error) {
    // Only remove the directory created exclusively by this invocation.
    await fs.rm(plan.output, { recursive: true, force: true });
    throw error;
  }
  // Keep the archive if a native import fails, so successfully imported threads
  // still have valid context links and the operation can be retried safely.
  try {
    await importNativeSessions(plan, migrationHomes(options));
  } catch (error) {
    throw new Error(`${error.message}\nMigration archive retained at ${plan.output}`, { cause: error });
  }
  await fs.writeFile(path.join(plan.output, "manifest.json"), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  if (plan.target_surface === "desktop") {
    await writePrivate(path.join(plan.output, "OPEN-IN-CLAUDE.md"), [
      "# Open imported sessions in Claude Desktop", "",
      "1. Open Claude and select the Code tab.",
      "2. Select Local and the project folder shown below.",
      "3. Type /resume in the prompt box, then search for the imported title.",
      "4. Select the session to bring its conversation into the Code tab.", "",
      "The command prepares local sessions; selecting one in /resume adds it to Desktop. It does not directly change the desktop sidebar database.", "",
      ...plan.sessions.flatMap((session) => [
        `## ${session.title || session.id}`, "",
        `Search title: ${JSON.stringify(session.native.desktop.title)}`,
        `Folder: ${JSON.stringify(session.cwd)}`,
        `Session ID: ${session.native.id}`, "",
        `Terminal fallback: ${session.native.resume_command}`, "Then run /desktop inside that Claude session.", "",
      ]),
      "Reference: https://code.claude.com/docs/en/desktop#coming-from-the-cli", "",
    ].join("\n"));
  }
  return { ...plan, dry_run: false };
}

export async function migrateAllContexts(options) {
  if (!["codex", "claude"].includes(options.from) || !["codex", "claude"].includes(options.to) || options.from === options.to) {
    throw new Error("migrate requires different --from and --to providers: codex or claude");
  }
  const discoveredSessions = await discoverMigrationSessions(options.from, migrationHomes(options));
  const roots = new Set();
  for (const session of discoveredSessions) {
    if (!session.cwd || (options.session && session.id !== options.session)) continue;
    try { roots.add(await fs.realpath(session.cwd)); } catch { roots.add(path.resolve(session.cwd)); }
  }
  if (!roots.size) throw new Error(`No saved ${options.from} sessions found`);
  const projects = [];
  for (const root of roots) {
    projects.push(await migrateContext(root, {
      ...options, discoveredSessions, exactRoot: true,
      output: options.output === undefined ? undefined : path.join(pathOption(options.output, "", "output"), hash(root)),
    }));
  }
  return { command: "migrate", all: true, dry_run: Boolean(options.dryRun), projects, skipped_without_cwd: discoveredSessions.filter((s) => !s.cwd).length };
}
