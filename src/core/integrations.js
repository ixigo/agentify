import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { ensureDir, exists, readText } from "./fs.js";

export const MANAGED_BLOCK_BEGIN = "<!-- agentify:begin -->";
export const MANAGED_BLOCK_END = "<!-- agentify:end -->";
export const MANAGED_HOOK_PREFIX = "agentify ctx ";
export const INTEGRATION_PROVIDERS = ["claude", "codex"];
export const PLAN_RENDERER_SCRIPT_NAME = "plan-to-html.mjs";
export const PLAN_RENDERER_MANAGED_ARG = "--agentify-managed";
export const PLAN_RENDERER_MARKER = "Managed by Agentify: plan-to-html hook";

const TRACKED_TOOL_MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Bash";
const PLAN_RENDERER_MATCHER = "ExitPlanMode";
const PLAN_RENDERER_SOURCE_PATH = fileURLToPath(new URL("../hooks/plan-to-html.mjs", import.meta.url));

const SHARED_BLOCK_LINES = [
  "- `agentify ctx note \"<text>\"` — record a gotcha or open thread worth remembering in later sessions. Prefer this over ad-hoc scratch files.",
  "- `agentify ctx decision \"chose X over Y because Z\"` — record a durable technical decision with its rationale. Query later with `agentify ctx decisions \"<topic>\"` before revisiting settled questions.",
  "- `agentify ctx handoff` — write a handoff summary before ending a long task.",
  "- If the user says to ignore previous context or start from scratch, disregard the injected digest; run `agentify ctx pause` when they want tracking off, `agentify ctx resume` to turn it back on, or `agentify ctx clear` to archive and reset the store.",
  "- `agentify query search|def|refs|callers|impacts` — structural queries over the repo index (`agentify scan` rebuilds it if stale).",
  "- `agentify risk --since <ref>` — blast radius and suggested regression tests before finishing a change.",
  "- `agentify test --since <ref> --run` — select and run only the tests affected by the change instead of the full suite.",
  "",
  "Model routing is configured (see `agentify models`). Shell out work to the model best suited for it instead of doing everything inline:",
  "",
  "- `agentify delegate quick \"<task>\"` — small, low-impact edits and quick questions go to a fast, cheap model. Add `--write` to let it apply edits.",
  "- `agentify delegate review --diff <ref>` — after completing a change, get an independent review from a different model vendor before finishing.",
  "- `agentify delegate heavy \"<task>\"` — architecture questions and gnarly debugging go to the strongest model.",
  "- `agentify delegate research \"<question>\"` — fast lookups and summaries.",
  "- `agentify delegate auto \"<task>\"` — let Agentify classify the task and pick the route; `agentify route explain \"<task>\"` shows the decision without running it.",
  "- Routing profiles: pass `--profile cost|balanced|performance` ONLY when the user explicitly asks to optimize for cost (\"go all in on cost\", \"minimize spend\") or performance (\"go all in on performance\", \"maximize correctness\"). Never infer a profile from urgency or task wording; the configured default applies otherwise.",
  "",
  "For issue-board work (triage, pick up an item, implement in an isolated worktree, raise a draft PR), prebuilt platform workflows exist: `agentify workflow install` detects GitHub, GitLab, or Azure DevOps from the git remote and installs the skill bundle. `agentify workflow list` shows what each bundle does.",
];

export function normalizeIntegrationProvider(value, { fallback = "claude" } = {}) {
  const provider = String(value ?? fallback).trim().toLowerCase();
  if (provider === "all") {
    return "all";
  }
  if (!INTEGRATION_PROVIDERS.includes(provider)) {
    throw new Error(`Unsupported integration provider "${value}". Supported: ${INTEGRATION_PROVIDERS.join(", ")}, all`);
  }
  return provider;
}

export function resolveIntegrationProviders(value, { fallback = "claude" } = {}) {
  const provider = normalizeIntegrationProvider(value, { fallback });
  return provider === "all" ? [...INTEGRATION_PROVIDERS] : [provider];
}

export function buildManagedBlock(provider = "claude") {
  if (provider === "codex") {
    return [
      MANAGED_BLOCK_BEGIN,
      "## Agentify",
      "",
      "Agentify provides lightweight context tracking and repo intelligence for this workspace.",
      "Codex has no automatic lifecycle hooks, so maintain context explicitly:",
      "",
      "- Run `agentify ctx load` at the start of every session to pick up notes, hot files, and recent activity from earlier sessions.",
      ...SHARED_BLOCK_LINES,
      "",
      "All commands support `--json` for machine-readable output.",
      MANAGED_BLOCK_END,
    ].join("\n");
  }

  return [
    MANAGED_BLOCK_BEGIN,
    "## Agentify",
    "",
    "Agentify provides lightweight context tracking and repo intelligence for this workspace.",
    "File edits and commands are tracked automatically through hooks — do not log them manually.",
    "Use these commands where they help:",
    "",
    "- `agentify ctx load` — recent activity, notes, and hot files from earlier sessions. Run it when starting work if the session did not already inject it.",
    ...SHARED_BLOCK_LINES,
    "",
    "All commands support `--json` for machine-readable output.",
    MANAGED_BLOCK_END,
  ].join("\n");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function buildManagedHooks({ planRendererPath = path.join(".claude", "hooks", PLAN_RENDERER_SCRIPT_NAME) } = {}) {
  return {
    SessionStart: [
      {
        matcher: "",
        hooks: [
          { type: "command", command: "agentify ctx load --hook", timeout: 15 },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        matcher: "",
        hooks: [
          { type: "command", command: "agentify ctx match --hook", timeout: 10 },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: "agentify ctx precheck --hook", timeout: 10 },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: TRACKED_TOOL_MATCHER,
        hooks: [
          { type: "command", command: "agentify ctx track --hook", timeout: 10 },
        ],
      },
      {
        matcher: PLAN_RENDERER_MATCHER,
        hooks: [
          {
            type: "command",
            command: `node ${shellQuote(planRendererPath)} ${PLAN_RENDERER_MANAGED_ARG}`,
            timeout: 30,
            statusMessage: "Rendering plan to HTML...",
          },
        ],
      },
    ],
    SessionEnd: [
      {
        matcher: "",
        hooks: [
          { type: "command", command: "agentify ctx track --hook", timeout: 10 },
        ],
      },
    ],
  };
}

export function applyManagedBlock(existingText, block = buildManagedBlock()) {
  const text = typeof existingText === "string" ? existingText : "";
  const pattern = new RegExp(`${escapeRegExp(MANAGED_BLOCK_BEGIN)}[\\s\\S]*?${escapeRegExp(MANAGED_BLOCK_END)}`);

  if (pattern.test(text)) {
    const next = text.replace(pattern, block);
    return { text: next, changed: next !== text, action: next === text ? "unchanged" : "updated" };
  }

  const separator = text.length === 0 ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return { text: `${text}${separator}${block}\n`, changed: true, action: "added" };
}

export function removeManagedBlock(existingText) {
  const text = typeof existingText === "string" ? existingText : "";
  const pattern = new RegExp(`\\n?\\n?${escapeRegExp(MANAGED_BLOCK_BEGIN)}[\\s\\S]*?${escapeRegExp(MANAGED_BLOCK_END)}\\n?`);
  if (!pattern.test(text)) {
    return { text, changed: false };
  }
  return { text: text.replace(pattern, "\n"), changed: true };
}

function isManagedHookEntry(entry) {
  return Array.isArray(entry?.hooks)
    && entry.hooks.some((hook) => {
      if (typeof hook?.command !== "string") {
        return false;
      }
      return hook.command.startsWith(MANAGED_HOOK_PREFIX)
        || hook.command.includes(PLAN_RENDERER_MANAGED_ARG)
        || (entry.matcher === PLAN_RENDERER_MATCHER && hook.command.includes(PLAN_RENDERER_SCRIPT_NAME));
    });
}

export function mergeManagedHooks(settings, managedHooks = buildManagedHooks()) {
  const base = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const hooks = base.hooks && typeof base.hooks === "object" && !Array.isArray(base.hooks) ? base.hooks : {};
  const nextHooks = { ...hooks };
  let changed = false;

  for (const [event, entries] of Object.entries(managedHooks)) {
    const existing = Array.isArray(nextHooks[event]) ? nextHooks[event] : [];
    const kept = existing.filter((entry) => !isManagedHookEntry(entry));
    const next = [...kept, ...entries];
    if (JSON.stringify(next) !== JSON.stringify(existing)) {
      changed = true;
    }
    nextHooks[event] = next;
  }

  return { settings: { ...base, hooks: nextHooks }, changed };
}

export function stripManagedHooks(settings) {
  const base = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  if (!base.hooks || typeof base.hooks !== "object" || Array.isArray(base.hooks)) {
    return { settings: base, changed: false };
  }

  const nextHooks = {};
  let changed = false;
  for (const [event, entries] of Object.entries(base.hooks)) {
    if (!Array.isArray(entries)) {
      nextHooks[event] = entries;
      continue;
    }
    const kept = entries.filter((entry) => !isManagedHookEntry(entry));
    if (kept.length !== entries.length) {
      changed = true;
    }
    if (kept.length > 0) {
      nextHooks[event] = kept;
    } else if (entries.length === 0) {
      nextHooks[event] = entries;
    } else {
      changed = true;
    }
  }

  const next = { ...base, hooks: nextHooks };
  if (Object.keys(nextHooks).length === 0) {
    delete next.hooks;
  }
  return { settings: next, changed };
}

export function resolveIntegrationTargets(root, { global: isGlobal = false, provider = "claude", homeDir = os.homedir() } = {}) {
  if (provider === "codex") {
    if (isGlobal) {
      return {
        provider,
        scope: "global",
        memoryPath: path.join(homeDir, ".codex", "AGENTS.md"),
        settingsPath: null,
      };
    }
    return {
      provider,
      scope: "project",
      memoryPath: path.join(root, "AGENTS.md"),
      settingsPath: null,
    };
  }

  if (isGlobal) {
    const claudeDir = path.join(homeDir, ".claude");
    return {
      provider: "claude",
      scope: "global",
      memoryPath: path.join(claudeDir, "CLAUDE.md"),
      settingsPath: path.join(claudeDir, "settings.json"),
      planRendererPath: path.join(claudeDir, "hooks", PLAN_RENDERER_SCRIPT_NAME),
    };
  }
  return {
    provider: "claude",
    scope: "project",
    memoryPath: path.join(root, "CLAUDE.md"),
    settingsPath: path.join(root, ".claude", "settings.json"),
    planRendererPath: path.join(root, ".claude", "hooks", PLAN_RENDERER_SCRIPT_NAME),
  };
}

async function readSettings(settingsPath) {
  if (!(await exists(settingsPath))) {
    return {};
  }
  const raw = await readText(settingsPath);
  if (!raw.trim()) {
    return {};
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Unexpected settings shape in ${settingsPath}`);
  }
  return parsed;
}

async function buildPlanRendererResult(planRendererPath, { dryRun = false } = {}) {
  if (!planRendererPath) {
    return null;
  }
  const source = await fs.readFile(PLAN_RENDERER_SOURCE_PATH, "utf8");
  const current = (await exists(planRendererPath)) ? await readText(planRendererPath) : "";
  const changed = current !== source;
  if (changed && !dryRun) {
    await ensureDir(path.dirname(planRendererPath));
    await fs.writeFile(planRendererPath, source, { encoding: "utf8", mode: 0o755 });
    await fs.chmod(planRendererPath, 0o755);
  }
  return { path: planRendererPath, changed };
}

async function removePlanRenderer(planRendererPath, { dryRun = false } = {}) {
  if (!planRendererPath || !(await exists(planRendererPath))) {
    return planRendererPath ? { path: planRendererPath, changed: false } : null;
  }
  const current = await readText(planRendererPath);
  const isManaged = current.includes(PLAN_RENDERER_MARKER);
  if (!isManaged) {
    return { path: planRendererPath, changed: false, skipped: true };
  }
  if (!dryRun) {
    await fs.rm(planRendererPath, { force: true });
  }
  return { path: planRendererPath, changed: true };
}

async function isPlanRendererCurrent(planRendererPath) {
  if (!planRendererPath || !(await exists(planRendererPath))) {
    return false;
  }
  const source = await fs.readFile(PLAN_RENDERER_SOURCE_PATH, "utf8");
  return (await readText(planRendererPath)) === source;
}

export async function installIntegration(root, options = {}) {
  const provider = normalizeIntegrationProvider(options.provider);
  const targets = resolveIntegrationTargets(root, { ...options, provider });
  const dryRun = options.dryRun === true;

  const memoryBefore = (await exists(targets.memoryPath)) ? await readText(targets.memoryPath) : "";
  const memoryResult = applyManagedBlock(memoryBefore, buildManagedBlock(provider));

  let settingsResult = null;
  let planRendererResult = null;
  if (targets.settingsPath) {
    const settingsBefore = await readSettings(targets.settingsPath);
    settingsResult = mergeManagedHooks(settingsBefore, buildManagedHooks(targets));
    planRendererResult = await buildPlanRendererResult(targets.planRendererPath, { dryRun });
  }

  if (!dryRun) {
    if (memoryResult.changed) {
      await ensureDir(path.dirname(targets.memoryPath));
      await fs.writeFile(targets.memoryPath, memoryResult.text, "utf8");
    }
    if (settingsResult?.changed) {
      await ensureDir(path.dirname(targets.settingsPath));
      await fs.writeFile(targets.settingsPath, `${JSON.stringify(settingsResult.settings, null, 2)}\n`, "utf8");
    }
  }

  return {
    provider,
    scope: targets.scope,
    dry_run: dryRun,
    memory: {
      path: targets.memoryPath,
      action: memoryResult.action,
      changed: memoryResult.changed,
    },
    settings: targets.settingsPath
      ? {
        path: targets.settingsPath,
        changed: settingsResult.changed || planRendererResult.changed,
        events: Object.keys(buildManagedHooks(targets)),
        renderer: planRendererResult,
      }
      : {
        path: null,
        changed: false,
        supported: false,
        note: "codex has no lifecycle hooks; the AGENTS.md guidance drives context tracking",
      },
  };
}

export async function uninstallIntegration(root, options = {}) {
  const provider = normalizeIntegrationProvider(options.provider);
  const targets = resolveIntegrationTargets(root, { ...options, provider });
  const dryRun = options.dryRun === true;

  let memoryChanged = false;
  if (await exists(targets.memoryPath)) {
    const before = await readText(targets.memoryPath);
    const result = removeManagedBlock(before);
    memoryChanged = result.changed;
    if (result.changed && !dryRun) {
      await fs.writeFile(targets.memoryPath, result.text, "utf8");
    }
  }

  let settingsChanged = false;
  let planRendererResult = null;
  if (targets.settingsPath && (await exists(targets.settingsPath))) {
    const before = await readSettings(targets.settingsPath);
    const result = stripManagedHooks(before);
    settingsChanged = result.changed;
    if (result.changed && !dryRun) {
      await fs.writeFile(targets.settingsPath, `${JSON.stringify(result.settings, null, 2)}\n`, "utf8");
    }
  }
  if (targets.planRendererPath) {
    planRendererResult = await removePlanRenderer(targets.planRendererPath, { dryRun });
    settingsChanged = settingsChanged || Boolean(planRendererResult?.changed);
  }

  return {
    provider,
    scope: targets.scope,
    dry_run: dryRun,
    memory: { path: targets.memoryPath, changed: memoryChanged },
    settings: { path: targets.settingsPath, changed: settingsChanged, renderer: planRendererResult },
  };
}

export async function integrationStatus(root, options = {}) {
  const provider = normalizeIntegrationProvider(options.provider);
  const targets = resolveIntegrationTargets(root, { ...options, provider });

  const memoryText = (await exists(targets.memoryPath)) ? await readText(targets.memoryPath) : "";
  const memoryInstalled = memoryText.includes(MANAGED_BLOCK_BEGIN) && memoryText.includes(MANAGED_BLOCK_END);
  const memoryCurrent = memoryInstalled && !applyManagedBlock(memoryText, buildManagedBlock(provider)).changed;

  let hooksInstalled = false;
  let rendererInstalled = false;
  if (targets.settingsPath && (await exists(targets.settingsPath))) {
    try {
      const settings = await readSettings(targets.settingsPath);
      rendererInstalled = await isPlanRendererCurrent(targets.planRendererPath);
      hooksInstalled = !mergeManagedHooks(settings, buildManagedHooks(targets)).changed && rendererInstalled;
    } catch {
      hooksInstalled = false;
    }
  }

  return {
    provider,
    scope: targets.scope,
    memory: { path: targets.memoryPath, installed: memoryInstalled, current: memoryCurrent },
    settings: targets.settingsPath
      ? {
        path: targets.settingsPath,
        installed: hooksInstalled,
        renderer: { path: targets.planRendererPath, installed: rendererInstalled },
      }
      : { path: null, installed: null, supported: false },
    installed: targets.settingsPath ? memoryInstalled && hooksInstalled : memoryInstalled,
  };
}

// Back-compat aliases for the original Claude-specific names.
export const installClaudeIntegration = installIntegration;
export const uninstallClaudeIntegration = uninstallIntegration;
export const claudeIntegrationStatus = integrationStatus;

// ---------------------------------------------------------------------------
// MCP server registration (#338)
//
// The Agentify MCP server is registered per provider by editing that
// provider's own config file directly — never by shelling out to
// `claude mcp add` / `codex mcp add`. Editing the file ourselves is what lets
// registration be idempotent, back up before writing, and preserve every
// unrelated key. The canonical alias is `agentify`, matching the detection
// rule in #331 (`claude mcp add agentify -- agentify serve`) so telemetry can
// actually observe the calls once the server is reachable.
// ---------------------------------------------------------------------------

export const MCP_SERVER_ALIAS = "agentify";
export const MCP_SERVER_COMMAND = "agentify";
export const MCP_SERVER_ARGS = ["serve"];
export const MCP_REGISTRABLE_PROVIDERS = ["claude", "codex"];

export function buildClaudeMcpEntry() {
  return { type: "stdio", command: MCP_SERVER_COMMAND, args: [...MCP_SERVER_ARGS] };
}

// User-scope config files, matching where each CLI's own `mcp add` writes a
// user-scoped server: Claude in ~/.claude.json (top-level mcpServers), Codex
// in ~/.codex/config.toml (a [mcp_servers.<alias>] table). homeDir is
// overridable so tests and manual verification never touch a real config.
export function resolveMcpTargets(root, { provider, homeDir = os.homedir() } = {}) {
  if (provider === "claude") {
    return { provider, format: "json", scope: "user", alias: MCP_SERVER_ALIAS, path: path.join(homeDir, ".claude.json") };
  }
  if (provider === "codex") {
    return { provider, format: "toml", scope: "user", alias: MCP_SERVER_ALIAS, path: path.join(homeDir, ".codex", "config.toml") };
  }
  return null;
}

// Pure: merge the Agentify server into a parsed ~/.claude.json object. Every
// unrelated top-level key and every other mcpServers entry is preserved. A
// byte-identical entry is a no-op; a *different* existing agentify entry (a
// custom command, wrapper, env, extra options) is a conflict we refuse to
// overwrite — never silently clobber the user's registration.
export function applyClaudeMcpRegistration(config, { alias = MCP_SERVER_ALIAS, entry = buildClaudeMcpEntry() } = {}) {
  const base = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const servers = base.mcpServers && typeof base.mcpServers === "object" && !Array.isArray(base.mcpServers)
    ? base.mcpServers
    : {};
  // Property existence, not truthiness: a `null`/`false`/`0` value is still an
  // existing entry we must preserve as a conflict, not overwrite.
  if (Object.prototype.hasOwnProperty.call(servers, alias)) {
    return JSON.stringify(servers[alias]) === JSON.stringify(entry)
      ? { config: base, changed: false, action: "unchanged" }
      : { config: base, changed: false, action: "conflict" };
  }
  return {
    config: { ...base, mcpServers: { ...servers, [alias]: entry } },
    changed: true,
    action: "added",
  };
}

// Line-level TOML handling (no TOML dependency, mirroring config-audit.js). We
// only ever *append* a new [mcp_servers.<alias>] table, and only when it is
// provably safe to do so — an existing configuration is never rewritten, so the
// user's own edits (and TOML validity) always survive.

// Multiline strings (""" … """ / ''' … ''') can contain text that looks like a
// TOML header or key — e.g. the documented MCP snippet embedded in an
// `instructions = """…"""` value. Blank out those continuation lines before any
// line-based scanning so we never treat string contents as real config (which
// could otherwise corrupt the file on rewrite). A lightweight lexer skips
// comments and single-line strings so a `"""` inside `# a comment` or `"a"`
// never opens a false multiline region.
function codexMask(text) {
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  const inactive = new Set();
  let lineIndex = 0;
  let mlDelim = null; // active multiline-string delimiter, or null
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\n") {
      lineIndex += 1;
      if (mlDelim) {
        inactive.add(lineIndex);
      }
      i += 1;
      continue;
    }
    if (mlDelim) {
      if (source.startsWith(mlDelim, i)) {
        i += 3;
        mlDelim = null;
      } else {
        i += 1;
      }
      continue;
    }
    // Comment: ignore to end of line (the \n handler advances the line).
    if (ch === "#") {
      const nl = source.indexOf("\n", i);
      if (nl === -1) {
        break;
      }
      i = nl;
      continue;
    }
    // Multiline string opens before a single-quote is considered.
    if (source.startsWith('"""', i) || source.startsWith("'''", i)) {
      mlDelim = source.slice(i, i + 3);
      i += 3;
      continue;
    }
    // Single-line string: skip to its close on the same line (basic strings
    // honor backslash escapes; literal strings do not).
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== "\n") {
        if (quote === '"' && source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return lines.map((line, index) => (inactive.has(index) ? "" : line)).join("\n");
}

// The lines belonging to the first table whose header matches, up to the next
// table header, or null when the table is absent.
function tomlTableLines(text, headerPattern) {
  let inBlock = false;
  const block = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (headerPattern.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^\s*\[/.test(line)) {
      break;
    }
    if (inBlock) {
      block.push(line);
    }
  }
  return inBlock ? block.join("\n") : null;
}

// TOML treats a bare key, a "double-quoted", and a 'single-quoted' key as
// equivalent, and allows whitespace around the dots in a dotted key/header. The
// alias segment and dot separators below tolerate all of those so equivalent
// spellings are recognized rather than missed (which would let us append a
// duplicate table and invalidate the file).
function codexAliasSegment(alias) {
  const a = escapeRegExp(alias);
  return `(?:${a}|"${a}"|'${a}')`;
}
const TOML_DOT = "\\s*\\.\\s*";
// TOML lets the `mcp_servers` root key itself be quoted, and the header may
// name a child table (e.g. [mcp_servers.agentify.env]) — both still refer to
// the same logical `mcp_servers.agentify` table.
const MCP_SERVERS_SEG = "(?:mcp_servers|\"mcp_servers\"|'mcp_servers')";

// Matches the parent table header we author, [mcp_servers.<alias>], allowing a
// quoted root key and whitespace around dots (but not a child sub-table).
function codexParentHeaderPattern(alias, flags = "") {
  return new RegExp(`^\\s*\\[\\s*${MCP_SERVERS_SEG}${TOML_DOT}${codexAliasSegment(alias)}\\s*\\]`, flags);
}

// Matches the parent header OR any child sub-table [mcp_servers.<alias>.…],
// including the array-of-tables spelling [[mcp_servers.<alias>]].
function codexAnyHeaderPattern(alias, flags = "") {
  return new RegExp(`^\\s*\\[\\[?\\s*${MCP_SERVERS_SEG}${TOML_DOT}${codexAliasSegment(alias)}(?:${TOML_DOT}[^\\]]+)?\\s*\\]\\]?`, flags);
}

// A child sub-table header, [mcp_servers.<alias>.something].
function codexChildHeaderPattern(alias, flags = "") {
  return new RegExp(`^\\s*\\[\\[?\\s*${MCP_SERVERS_SEG}${TOML_DOT}${codexAliasSegment(alias)}${TOML_DOT}[^\\]]+\\s*\\]\\]?`, flags);
}

function codexAgentifyHeaderBlock(maskedText, alias) {
  return tomlTableLines(maskedText, codexParentHeaderPattern(alias));
}

// The root-table lines: everything before the first [table] header. A dotted or
// inline `mcp_servers…` key only defines the *global* mcp_servers when it lives
// in root scope; under a `[foo]` header it belongs to `foo`, so scoping the
// scan here prevents false positives like `[foo]\nmcp_servers.agentify = …`.
function codexRootScope(maskedText) {
  const lines = String(maskedText || "").split(/\r?\n/);
  const firstHeader = lines.findIndex((line) => /^\s*\[/.test(line));
  return (firstHeader === -1 ? lines : lines.slice(0, firstHeader)).join("\n");
}

// True when an Agentify MCP server is defined in *any* Codex representation:
// the dotted table header we write, a root-scope dotted key at any depth
// (`mcp_servers.agentify = …` or `mcp_servers.agentify.command = …`), an
// `agentify` key inside a `[mcp_servers]` table, or a root-scope inline
// `mcp_servers = { agentify = … }` assignment — across bare/quoted spellings
// and whitespace around dots, and ignoring text inside multiline strings.
// Catching every form stops us from appending a second definition that would
// make the whole config invalid.
export function codexMcpRegistered(tomlText, { alias = MCP_SERVER_ALIAS } = {}) {
  const masked = codexMask(tomlText);
  const aliasAlt = codexAliasSegment(alias);
  if (codexAnyHeaderPattern(alias, "m").test(masked)) {
    return true;
  }
  const root = codexRootScope(masked);
  if (new RegExp(`^\\s*${MCP_SERVERS_SEG}${TOML_DOT}${aliasAlt}\\s*[.=]`, "m").test(root)) {
    return true;
  }
  const tableBlock = tomlTableLines(masked, new RegExp(`^\\s*\\[\\s*${MCP_SERVERS_SEG}\\s*\\]\\s*(?:#.*)?$`));
  if (tableBlock !== null && new RegExp(`^\\s*${aliasAlt}\\s*[.=]`, "m").test(tableBlock)) {
    return true;
  }
  const inline = root.match(new RegExp(`^\\s*${MCP_SERVERS_SEG}\\s*=\\s*\\{[\\s\\S]*?\\}`, "m"));
  if (inline && new RegExp(`(?:[{,\\s])${aliasAlt}\\s*=`).test(inline[0])) {
    return true;
  }
  return false;
}

// A registered server is only "current"/authored-by-Agentify when it is exactly
// the table we write: the single [mcp_servers.<alias>] header carrying ONLY
// `command = "agentify"` and `args = ["serve"]`, with no extra keys and no child
// sub-tables. A wrong command/args, an extra field (cwd, env, timeout…), or a
// child table means the user customized it — a conflict we neither overwrite nor
// delete, so status stays honest and uninstall never removes a custom entry.
export function codexMcpMatches(tomlText, { alias = MCP_SERVER_ALIAS, command = MCP_SERVER_COMMAND, args = MCP_SERVER_ARGS } = {}) {
  const masked = codexMask(tomlText);
  // A child sub-table means extra configuration we did not author.
  if (codexChildHeaderPattern(alias, "m").test(masked)) {
    return false;
  }
  const block = codexAgentifyHeaderBlock(masked, alias);
  if (block === null) {
    return false;
  }
  const commandLine = new RegExp(`^command\\s*=\\s*["']${escapeRegExp(command)}["']$`);
  const argsInner = args.map((value) => `["']${escapeRegExp(value)}["']`).join("\\s*,\\s*");
  const argsLine = new RegExp(`^args\\s*=\\s*\\[\\s*${argsInner}\\s*,?\\s*\\]$`);
  let hasCommand = false;
  let hasArgs = false;
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (commandLine.test(line)) {
      hasCommand = true;
      continue;
    }
    if (argsLine.test(line)) {
      hasArgs = true;
      continue;
    }
    // Any other key means the entry carries custom configuration.
    return false;
  }
  return hasCommand && hasArgs;
}

// True when appending a new [mcp_servers.<alias>] table would be unsafe because
// an inline whole-table assignment (`mcp_servers = { … }`) already defines
// `mcp_servers`; TOML forbids extending it with a dotted subtable.
function codexAppendUnsafe(text) {
  return new RegExp(`^\\s*${MCP_SERVERS_SEG}\\s*=`, "m").test(codexRootScope(codexMask(text)));
}

export function applyCodexMcpRegistration(tomlText, { alias = MCP_SERVER_ALIAS, command = MCP_SERVER_COMMAND, args = MCP_SERVER_ARGS } = {}) {
  const text = typeof tomlText === "string" ? tomlText : "";
  if (codexMcpRegistered(text, { alias })) {
    // Leave any existing definition untouched; distinguish the exact table we
    // author (no-op) from anything else (a conflict the user must resolve).
    return codexMcpMatches(text, { alias, command, args })
      ? { text, changed: false, action: "unchanged" }
      : { text, changed: false, action: "conflict" };
  }
  if (codexAppendUnsafe(text)) {
    // An inline mcp_servers table exists; appending a dotted subtable would
    // redefine it and break the file. Refuse rather than corrupt.
    return { text, changed: false, action: "conflict" };
  }
  const block = [
    `[mcp_servers.${alias}]`,
    `command = ${JSON.stringify(command)}`,
    `args = [${args.map((value) => JSON.stringify(value)).join(", ")}]`,
  ].join("\n");
  const separator = text.length === 0 ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return { text: `${text}${separator}${block}\n`, changed: true, action: "added" };
}

// Pure removal of the Agentify server from a parsed ~/.claude.json object. Only
// the agentify entry is dropped; every unrelated key and sibling server stays.
export function removeClaudeMcpRegistration(config, { alias = MCP_SERVER_ALIAS } = {}) {
  const base = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  if (!base.mcpServers || typeof base.mcpServers !== "object" || !(alias in base.mcpServers)) {
    return { config: base, changed: false };
  }
  const nextServers = { ...base.mcpServers };
  delete nextServers[alias];
  const next = { ...base };
  if (Object.keys(nextServers).length > 0) {
    next.mcpServers = nextServers;
  } else {
    delete next.mcpServers;
  }
  return { config: next, changed: true };
}

// Pure removal of the [mcp_servers.<alias>] header table we author from Codex
// config text. Only that table form is removed; a definition in some other
// shape we did not write is left alone.
export function removeCodexMcpRegistration(tomlText, { alias = MCP_SERVER_ALIAS } = {}) {
  const text = typeof tomlText === "string" ? tomlText : "";
  // Drop the parent table AND every child sub-table ([mcp_servers.agentify.env]
  // etc.) so no dangling child implicitly redefines the server. Header/boundary
  // decisions use the masked view so text inside a multiline string is never
  // mistaken for a header, while the original lines are what we emit.
  const removePattern = codexAnyHeaderPattern(alias);
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const maskedLines = codexMask(text).split(/\r?\n/);
  const out = [];
  let changed = false;
  let index = 0;
  while (index < lines.length) {
    const masked = maskedLines[index] ?? "";
    if (/^\s*\[/.test(masked) && removePattern.test(masked)) {
      changed = true;
      index += 1;
      // Consume the table body up to the next header (masked so a header inside
      // a multiline string is not mistaken for one), which also carries us into
      // any adjacent child sub-table so it is removed in the same pass.
      while (index < lines.length && !/^\s*\[/.test(maskedLines[index] ?? "")) {
        index += 1;
      }
      // Absorb exactly one blank separator line left immediately after the
      // removed block — never a global blank-line collapse that would alter
      // unrelated formatting or multiline-string values.
      if (index < lines.length && (lines[index] ?? "").trim() === "") {
        index += 1;
      }
      continue;
    }
    out.push(lines[index]);
    index += 1;
  }
  if (!changed) {
    return { text, changed: false };
  }
  return { text: out.join(eol), changed: true };
}

// A timestamped copy so a backup can never clobber an earlier one or a file
// the user named `.bak`. Only taken when we are about to change the file.
async function backupConfigFile(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.agentify-bak-${stamp}`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

// Write via a temp file + atomic rename so a crash mid-write can never leave a
// provider config truncated or half-written (the rename either fully replaces
// the file or does not). This does not add cross-process locking — a provider
// CLI writing concurrently could still lose an interleaved change — but it
// removes the partial-file outage risk, and the pre-write backup covers the
// rest. A symlink-managed config is written through to its real target (the
// symlink is preserved), and the existing file's permission bits are carried
// over so a restrictive mode (e.g. 0600) is never silently widened.
async function atomicWriteFile(filePath, content) {
  let target = filePath;
  let mode = null;
  try {
    target = await fs.realpath(filePath);
    mode = (await fs.stat(target)).mode & 0o777;
  } catch {
    // New file: no symlink to follow and no prior mode to preserve.
  }
  const tempPath = `${target}.agentify-tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, content, "utf8");
  if (mode !== null) {
    await fs.chmod(tempPath, mode);
  }
  try {
    await fs.rename(tempPath, target);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function mcpRegistrationResult(targets, { changed, action, existed, backup, dryRun }) {
  return {
    provider: targets.provider,
    supported: true,
    format: targets.format,
    path: targets.path,
    alias: targets.alias,
    command: `${MCP_SERVER_COMMAND} ${MCP_SERVER_ARGS.join(" ")}`,
    // On a real run the entry is now present; on a dry run it is present only
    // if it already was (a would-add has not written anything yet).
    registered: dryRun ? !changed : true,
    changed,
    action: dryRun && changed ? `would-${action}` : action,
    existed,
    backup,
    dry_run: dryRun,
  };
}

export async function registerMcpServer(options = {}) {
  const provider = normalizeIntegrationProvider(options.provider);
  const homeDir = options.homeDir || os.homedir();
  const targets = resolveMcpTargets(options.root, { provider, homeDir });
  const dryRun = options.dryRun === true;
  if (!targets) {
    return { provider, supported: false, registered: false, changed: false, path: null };
  }

  const existed = await exists(targets.path);
  const raw = existed ? await readText(targets.path) : "";

  if (targets.format === "json") {
    let parsed = {};
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        // Never overwrite a config we cannot safely round-trip.
        return {
          provider,
          supported: true,
          format: "json",
          path: targets.path,
          alias: targets.alias,
          registered: false,
          changed: false,
          existed,
          error: `existing config is not valid JSON and was left untouched: ${error.message}`,
        };
      }
    }
    // Valid JSON whose top level is not an object (array, string, number, null)
    // would be discarded by a merge — reject it rather than replace the file.
    if (raw.trim() && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
      return {
        provider,
        supported: true,
        format: "json",
        path: targets.path,
        alias: targets.alias,
        registered: false,
        changed: false,
        existed,
        error: `existing config's top-level value is not a JSON object and was left untouched; fix ${targets.path} then re-run`,
      };
    }
    // Valid object, but an unexpected mcpServers shape (array, string, …) would
    // be silently discarded by a naive merge — reject it as a schema conflict.
    if (parsed && typeof parsed === "object" && parsed.mcpServers !== undefined
      && (parsed.mcpServers === null || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers))) {
      return {
        provider,
        supported: true,
        format: "json",
        path: targets.path,
        alias: targets.alias,
        registered: false,
        changed: false,
        existed,
        error: `existing "mcpServers" is not an object and was left untouched; fix ${targets.path} then re-run`,
      };
    }
    const result = applyClaudeMcpRegistration(parsed, { alias: targets.alias });
    if (result.action === "conflict") {
      // A different agentify entry already exists — preserve it rather than
      // overwrite a working custom registration.
      return {
        provider,
        supported: true,
        format: "json",
        path: targets.path,
        alias: targets.alias,
        command: `${MCP_SERVER_COMMAND} ${MCP_SERVER_ARGS.join(" ")}`,
        registered: true,
        changed: false,
        action: "conflict",
        conflict: true,
        existed,
        backup: null,
        dry_run: dryRun,
        error: `a different "${targets.alias}" MCP entry already exists in ${targets.path}; left untouched — remove it (\`claude mcp remove ${targets.alias}\`) or edit it to run \`${MCP_SERVER_COMMAND} ${MCP_SERVER_ARGS.join(" ")}\`, then re-run`,
      };
    }
    let backup = null;
    if (result.changed && !dryRun) {
      await ensureDir(path.dirname(targets.path));
      if (existed) {
        backup = await backupConfigFile(targets.path);
      }
      await atomicWriteFile(targets.path, `${JSON.stringify(result.config, null, 2)}\n`);
    }
    return mcpRegistrationResult(targets, { changed: result.changed, action: result.action, existed, backup, dryRun });
  }

  const result = applyCodexMcpRegistration(raw, { alias: targets.alias });
  if (result.action === "conflict") {
    // Two distinct causes need different remediation, so the message is chosen
    // from the actual config shape rather than a one-size-fits-all "append this"
    // that could itself produce invalid TOML.
    const alreadyDefined = codexMcpRegistered(raw, { alias: targets.alias });
    const authoredTable = `[mcp_servers.${targets.alias}]\ncommand = ${JSON.stringify(MCP_SERVER_COMMAND)}\nargs = [${MCP_SERVER_ARGS.map((value) => JSON.stringify(value)).join(", ")}]`;
    const error = alreadyDefined
      ? `an Agentify entry already exists in ${targets.path} in a form Agentify did not author; leave it if it already runs \`${MCP_SERVER_COMMAND} ${MCP_SERVER_ARGS.join(" ")}\`, otherwise edit it to match:\n${authoredTable}`
      : `\`mcp_servers\` is defined as an inline table in ${targets.path}; a dotted subtable cannot be appended without breaking it — add \`${targets.alias} = { command = ${JSON.stringify(MCP_SERVER_COMMAND)}, args = [${MCP_SERVER_ARGS.map((value) => JSON.stringify(value)).join(", ")}] }\` inside that inline table by hand`;
    return {
      provider,
      supported: true,
      format: "toml",
      path: targets.path,
      alias: targets.alias,
      command: `${MCP_SERVER_COMMAND} ${MCP_SERVER_ARGS.join(" ")}`,
      registered: alreadyDefined,
      changed: false,
      action: "conflict",
      conflict: true,
      existed,
      backup: null,
      dry_run: dryRun,
      error,
    };
  }
  let backup = null;
  if (result.changed && !dryRun) {
    await ensureDir(path.dirname(targets.path));
    if (existed) {
      backup = await backupConfigFile(targets.path);
    }
    await atomicWriteFile(targets.path, result.text);
  }
  return mcpRegistrationResult(targets, { changed: result.changed, action: result.action, existed, backup, dryRun });
}

export async function mcpRegistrationStatus(options = {}) {
  const provider = normalizeIntegrationProvider(options.provider);
  const homeDir = options.homeDir || os.homedir();
  const targets = resolveMcpTargets(options.root, { provider, homeDir });
  if (!targets) {
    return { provider, supported: false, registered: false, current: false, path: null };
  }
  const existed = await exists(targets.path);
  const raw = existed ? await readText(targets.path) : "";
  if (targets.format === "json") {
    let parsed = {};
    try {
      parsed = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return { provider, supported: true, path: targets.path, registered: false, current: false, unreadable: true };
    }
    const registered = Boolean(parsed?.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers) && parsed.mcpServers[targets.alias]);
    // "current" means the exact entry we author — a conflicting custom entry is
    // registered but not current.
    const current = registered && applyClaudeMcpRegistration(parsed, { alias: targets.alias }).action === "unchanged";
    return { provider, supported: true, path: targets.path, registered, current };
  }
  const registered = codexMcpRegistered(raw, { alias: targets.alias });
  const current = registered && codexMcpMatches(raw, { alias: targets.alias });
  return { provider, supported: true, path: targets.path, registered, current };
}

// The symmetric counterpart to registerMcpServer: remove the Agentify server
// from the provider config, backing up first and preserving everything else.
export async function unregisterMcpServer(options = {}) {
  const provider = normalizeIntegrationProvider(options.provider);
  const homeDir = options.homeDir || os.homedir();
  const targets = resolveMcpTargets(options.root, { provider, homeDir });
  const dryRun = options.dryRun === true;
  if (!targets) {
    return { provider, supported: false, changed: false, path: null };
  }
  const existed = await exists(targets.path);
  if (!existed) {
    return { provider, supported: true, path: targets.path, changed: false, existed: false };
  }
  const raw = await readText(targets.path);

  if (targets.format === "json") {
    let parsed = {};
    try {
      parsed = raw.trim() ? JSON.parse(raw) : {};
    } catch (error) {
      return { provider, supported: true, path: targets.path, changed: false, existed, error: `existing config is not valid JSON and was left untouched: ${error.message}` };
    }
    const servers = parsed?.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers
      : {};
    // Only remove the entry we authored — never delete a custom/conflicting
    // registration (including a falsy one) a later global uninstall touches.
    if (Object.prototype.hasOwnProperty.call(servers, targets.alias)
      && JSON.stringify(servers[targets.alias]) !== JSON.stringify(buildClaudeMcpEntry())) {
      return { provider, supported: true, path: targets.path, changed: false, existed, skipped: "not-authored", note: "left an existing agentify entry Agentify did not author" };
    }
    const result = removeClaudeMcpRegistration(parsed, { alias: targets.alias });
    let backup = null;
    if (result.changed && !dryRun) {
      backup = await backupConfigFile(targets.path);
      await atomicWriteFile(targets.path, `${JSON.stringify(result.config, null, 2)}\n`);
    }
    return { provider, supported: true, path: targets.path, changed: result.changed, existed, backup, dry_run: dryRun };
  }

  // Only remove a Codex table that matches what we author; a conflicting or
  // hand-authored table is left in place.
  if (codexMcpRegistered(raw, { alias: targets.alias }) && !codexMcpMatches(raw, { alias: targets.alias })) {
    return { provider, supported: true, path: targets.path, changed: false, existed, skipped: "not-authored", note: "left an existing agentify table Agentify did not author" };
  }
  const result = removeCodexMcpRegistration(raw, { alias: targets.alias });
  let backup = null;
  if (result.changed && !dryRun) {
    backup = await backupConfigFile(targets.path);
    await atomicWriteFile(targets.path, result.text);
  }
  return { provider, supported: true, path: targets.path, changed: result.changed, existed, backup, dry_run: dryRun };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
