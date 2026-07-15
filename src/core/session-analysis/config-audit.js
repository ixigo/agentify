import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { homeRelative } from "./normalize.js";

// Opt-in (--include-config) audit of global provider configuration. The
// allowlist is the contract: only the files and keys named here are ever
// opened, and what leaves this module is structural — sizes, counts,
// names of skills/agents/hooks, and a handful of allowlisted enum-ish
// values. Instruction text, settings values, env values, and anything
// credential-shaped (auth.json, keychains, caches, backups, SQLite
// stores, shell snapshots) are never read or never emitted.
export const CONFIG_AUDIT_SCHEMA_VERSION = "config-audit-v1";

// ~4 chars per token: a deliberate rough estimate, labeled as such.
function tokenEstimate(bytes) {
  return Math.round(bytes / 4);
}

const SECRET_KEY_PATTERN = /key|token|secret|password|credential|auth/i;

async function statFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

async function instructionFileFacts(filePath) {
  const stat = await statFile(filePath);
  if (!stat) return { present: false };
  let lines = 0;
  let nonEmptyLines = [];
  try {
    const text = await fs.readFile(filePath, "utf8");
    lines = text.split("\n").length;
    // Normalized non-empty lines are kept IN MEMORY only, for the
    // cross-provider duplication count; they are never emitted.
    nonEmptyLines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 8);
  } catch {
    return { present: true, bytes: stat.size, unreadable: true };
  }
  return {
    present: true,
    bytes: stat.size,
    lines,
    always_loaded_token_estimate: tokenEstimate(stat.size),
    oversized: tokenEstimate(stat.size) > 2_000,
    _lines: nonEmptyLines,
  };
}

// kind: "dirs" lists installed component directories (skills), "files"
// lists manifests with the given extension (agents/commands). Symlinked
// installations are resolved via stat so they are inventoried too.
async function listNames(dirPath, { kind, extension = ".md" }) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stat = await fs.stat(path.join(dirPath, entry.name));
        isDir = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue;
      }
    }
    if (kind === "dirs" && isDir) {
      names.push(entry.name);
    } else if (kind === "files" && isFile && path.extname(entry.name) === extension) {
      names.push(path.basename(entry.name, extension));
    }
  }
  return names.sort();
}

// Allowlisted values pass only when they look like a plain identifier;
// anything else (custom strings, URLs, paths, whatever a user typed) is
// withheld. slice() is not redaction — this gate is.
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9 ._/-]{1,64}$/;

function gateValue(value) {
  const text = String(value);
  return SAFE_VALUE_PATTERN.test(text) ? text : "(value withheld)";
}

// Claude settings: structural counts plus a few allowlisted scalars.
// Values of env vars and anything secret-shaped never leave this function.
const CLAUDE_SETTINGS_SCALAR_ALLOWLIST = ["model", "theme", "autoUpdates", "includeCoAuthoredBy"];

async function auditClaudeSettings(settingsPath) {
  const stat = await statFile(settingsPath);
  if (!stat) return { present: false };
  let settings;
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  } catch {
    return { present: true, unreadable: true };
  }
  const permissions = settings.permissions && typeof settings.permissions === "object" ? settings.permissions : {};
  return {
    present: true,
    allowlisted: Object.fromEntries(
      CLAUDE_SETTINGS_SCALAR_ALLOWLIST
        .filter((key) => typeof settings[key] === "string" || typeof settings[key] === "boolean")
        .map((key) => [key, typeof settings[key] === "boolean" ? settings[key] : gateValue(settings[key])]),
    ),
    permission_allow_rules: Array.isArray(permissions.allow) ? permissions.allow.length : 0,
    permission_deny_rules: Array.isArray(permissions.deny) ? permissions.deny.length : 0,
    hook_events: settings.hooks && typeof settings.hooks === "object" ? Object.keys(settings.hooks).length : 0,
    env_vars: settings.env && typeof settings.env === "object" ? Object.keys(settings.env).length : 0,
    other_keys: Object.keys(settings).filter((key) => !["permissions", "hooks", "env", ...CLAUDE_SETTINGS_SCALAR_ALLOWLIST].includes(key)).length,
  };
}

// Codex config.toml: line-level structural parse (no TOML dependency).
// Only allowlisted top-level scalars are echoed; secret-shaped keys are
// counted, never named or valued.
const CODEX_CONFIG_SCALAR_ALLOWLIST = ["model", "model_provider", "approval_policy", "sandbox_mode", "model_reasoning_effort"];

async function auditCodexConfig(configPath) {
  const stat = await statFile(configPath);
  if (!stat) return { present: false };
  let text;
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch {
    return { present: true, unreadable: true };
  }
  const allowlisted = {};
  let tables = 0;
  let keys = 0;
  let secretLikeKeys = 0;
  let inTable = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // A table header may carry a trailing comment: [profiles.fast] # note
    if (/^\[[^\]]+\]/.test(line)) {
      tables += 1;
      inTable = true;
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    keys += 1;
    if (SECRET_KEY_PATTERN.test(match[1])) secretLikeKeys += 1;
    if (!inTable && CODEX_CONFIG_SCALAR_ALLOWLIST.includes(match[1])) {
      // Quoted value first; otherwise strip a trailing comment. The result
      // still passes the safe-value gate before it is emitted.
      const quoted = match[2].match(/^"([^"]*)"/);
      const value = quoted ? quoted[1] : match[2].split("#")[0].trim();
      allowlisted[match[1]] = gateValue(value);
    }
  }
  return { present: true, allowlisted, tables, keys, secret_like_keys_counted_not_read: secretLikeKeys };
}

// Duplicated guidance across the two global instruction files is a signal
// the user maintains the same rules twice.
function duplicationCount(linesA, linesB) {
  if (!linesA?.length || !linesB?.length) return 0;
  const setA = new Set(linesA);
  let duplicates = 0;
  for (const line of new Set(linesB)) {
    if (setA.has(line)) duplicates += 1;
  }
  return duplicates;
}

export function defaultClaudeHome() {
  return path.join(os.homedir(), ".claude");
}

export function defaultCodexHome() {
  return path.join(os.homedir(), ".codex");
}

export function configAuditSources({ claudeHome, codexHome }) {
  const claude = claudeHome || defaultClaudeHome();
  const codex = codexHome || defaultCodexHome();
  return [
    path.join(claude, "CLAUDE.md"),
    path.join(claude, "settings.json"),
    `${path.join(claude, "skills")}/ (names only)`,
    `${path.join(claude, "agents")}/ (names only)`,
    `${path.join(claude, "commands")}/ (names only)`,
    path.join(codex, "AGENTS.md"),
    `${path.join(codex, "config.toml")} (allowlisted keys)`,
    `${path.join(codex, "skills")}/ (names only)`,
  ];
}

export async function buildConfigAudit({ claudeHome, codexHome } = {}) {
  const claude = claudeHome || defaultClaudeHome();
  const codex = codexHome || defaultCodexHome();

  const claudeInstructions = await instructionFileFacts(path.join(claude, "CLAUDE.md"));
  const codexInstructions = await instructionFileFacts(path.join(codex, "AGENTS.md"));
  const duplicated = duplicationCount(claudeInstructions._lines, codexInstructions._lines);
  delete claudeInstructions._lines;
  delete codexInstructions._lines;

  const claudeAudit = {
    global_instructions: claudeInstructions,
    always_loaded_token_estimate: claudeInstructions.always_loaded_token_estimate || 0,
    settings: await auditClaudeSettings(path.join(claude, "settings.json")),
    skills: await listNames(path.join(claude, "skills"), { kind: "dirs" }),
    agents: await listNames(path.join(claude, "agents"), { kind: "files" }),
    commands: await listNames(path.join(claude, "commands"), { kind: "files" }),
  };
  const codexAudit = {
    global_instructions: codexInstructions,
    always_loaded_token_estimate: codexInstructions.always_loaded_token_estimate || 0,
    config: await auditCodexConfig(path.join(codex, "config.toml")),
    skills: await listNames(path.join(codex, "skills"), { kind: "dirs" }),
  };

  const findings = [];
  if (claudeInstructions.oversized || codexInstructions.oversized) {
    findings.push("A global instruction file exceeds ~2k tokens; every session of that provider pays the context cost before work starts.");
  }
  if (duplicated >= 3) {
    findings.push(`${duplicated} guidance line(s) are duplicated between global CLAUDE.md and AGENTS.md; consolidating avoids double maintenance and drift.`);
  }

  return {
    schema: CONFIG_AUDIT_SCHEMA_VERSION,
    homes: { claude: homeRelative(claude), codex: homeRelative(codex) },
    claude: claudeAudit,
    codex: codexAudit,
    cross_provider: {
      // Per-provider on purpose: a Claude session loads CLAUDE.md and a
      // Codex session loads AGENTS.md — no session pays the sum.
      duplicated_instruction_lines: duplicated,
    },
    findings,
    note: "Structural audit of allowlisted files only. Instruction text and env values are never reproduced; a handful of allowlisted identifier-like values (model, approval policy) pass a safe-value gate and everything else is withheld. Auth/credential/cache/backup/database files are never opened. Token figures are ~4-chars-per-token estimates.",
  };
}
