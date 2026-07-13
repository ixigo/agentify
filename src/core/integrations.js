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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
