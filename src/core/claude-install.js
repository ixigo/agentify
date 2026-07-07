import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { ensureDir, exists, readText } from "./fs.js";

export const MANAGED_BLOCK_BEGIN = "<!-- agentify:begin -->";
export const MANAGED_BLOCK_END = "<!-- agentify:end -->";
export const MANAGED_HOOK_PREFIX = "agentify ctx ";

const TRACKED_TOOL_MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Bash";

export function buildManagedBlock() {
  return [
    MANAGED_BLOCK_BEGIN,
    "## Agentify",
    "",
    "Agentify provides lightweight context tracking and repo intelligence for this workspace.",
    "File edits and commands are tracked automatically through hooks — do not log them manually.",
    "Use these commands where they help:",
    "",
    "- `agentify ctx load` — recent activity, notes, and hot files from earlier sessions. Run it when starting work if the session did not already inject it.",
    "- `agentify ctx note \"<text>\"` — record a decision, gotcha, or open thread worth remembering in later sessions. Prefer this over ad-hoc scratch files.",
    "- `agentify ctx handoff` — write a handoff summary before ending a long task.",
    "- `agentify query search|def|refs|callers|impacts` — structural queries over the repo index (`agentify scan` rebuilds it if stale).",
    "- `agentify risk --since <ref>` — blast radius and suggested regression tests before finishing a change.",
    "",
    "All commands support `--json` for machine-readable output.",
    MANAGED_BLOCK_END,
  ].join("\n");
}

export function buildManagedHooks() {
  return {
    SessionStart: [
      {
        matcher: "",
        hooks: [
          { type: "command", command: "agentify ctx load --hook", timeout: 15 },
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
    && entry.hooks.some((hook) => typeof hook?.command === "string" && hook.command.startsWith(MANAGED_HOOK_PREFIX));
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

export function resolveIntegrationTargets(root, { global: isGlobal = false, homeDir = os.homedir() } = {}) {
  if (isGlobal) {
    const claudeDir = path.join(homeDir, ".claude");
    return {
      scope: "global",
      claudeDir,
      memoryPath: path.join(claudeDir, "CLAUDE.md"),
      settingsPath: path.join(claudeDir, "settings.json"),
    };
  }
  const claudeDir = path.join(root, ".claude");
  return {
    scope: "project",
    claudeDir,
    memoryPath: path.join(root, "CLAUDE.md"),
    settingsPath: path.join(claudeDir, "settings.json"),
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

export async function installClaudeIntegration(root, options = {}) {
  const targets = resolveIntegrationTargets(root, options);
  const dryRun = options.dryRun === true;

  const memoryBefore = (await exists(targets.memoryPath)) ? await readText(targets.memoryPath) : "";
  const memoryResult = applyManagedBlock(memoryBefore);

  const settingsBefore = await readSettings(targets.settingsPath);
  const settingsResult = mergeManagedHooks(settingsBefore);

  if (!dryRun) {
    if (memoryResult.changed) {
      await ensureDir(path.dirname(targets.memoryPath));
      await fs.writeFile(targets.memoryPath, memoryResult.text, "utf8");
    }
    if (settingsResult.changed) {
      await ensureDir(path.dirname(targets.settingsPath));
      await fs.writeFile(targets.settingsPath, `${JSON.stringify(settingsResult.settings, null, 2)}\n`, "utf8");
    }
  }

  return {
    scope: targets.scope,
    dry_run: dryRun,
    memory: {
      path: targets.memoryPath,
      action: memoryResult.action,
      changed: memoryResult.changed,
    },
    settings: {
      path: targets.settingsPath,
      changed: settingsResult.changed,
      events: Object.keys(buildManagedHooks()),
    },
  };
}

export async function uninstallClaudeIntegration(root, options = {}) {
  const targets = resolveIntegrationTargets(root, options);
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
  if (await exists(targets.settingsPath)) {
    const before = await readSettings(targets.settingsPath);
    const result = stripManagedHooks(before);
    settingsChanged = result.changed;
    if (result.changed && !dryRun) {
      await fs.writeFile(targets.settingsPath, `${JSON.stringify(result.settings, null, 2)}\n`, "utf8");
    }
  }

  return {
    scope: targets.scope,
    dry_run: dryRun,
    memory: { path: targets.memoryPath, changed: memoryChanged },
    settings: { path: targets.settingsPath, changed: settingsChanged },
  };
}

export async function claudeIntegrationStatus(root, options = {}) {
  const targets = resolveIntegrationTargets(root, options);

  const memoryText = (await exists(targets.memoryPath)) ? await readText(targets.memoryPath) : "";
  const memoryInstalled = memoryText.includes(MANAGED_BLOCK_BEGIN) && memoryText.includes(MANAGED_BLOCK_END);
  const memoryCurrent = memoryInstalled && !applyManagedBlock(memoryText).changed;

  let hooksInstalled = false;
  if (await exists(targets.settingsPath)) {
    try {
      const settings = await readSettings(targets.settingsPath);
      hooksInstalled = !mergeManagedHooks(settings).changed;
    } catch {
      hooksInstalled = false;
    }
  }

  return {
    scope: targets.scope,
    memory: { path: targets.memoryPath, installed: memoryInstalled, current: memoryCurrent },
    settings: { path: targets.settingsPath, installed: hooksInstalled },
    installed: memoryInstalled && hooksInstalled,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
