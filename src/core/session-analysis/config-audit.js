import fs from "node:fs/promises";
import path from "node:path";

import { stableHash } from "./normalize.js";

const SECRET_KEY = /(?:api[_-]?key|auth|credential|password|secret|token)/i;
const CLAUDE_ALLOWED_KEYS = new Set(["model", "permissions", "hooks", "enabledPlugins", "statusLine", "outputStyle"]);
const CODEX_ALLOWED_KEYS = new Set([
  "model",
  "model_provider",
  "approval_policy",
  "sandbox_mode",
  "web_search",
  "features.multi_agent",
  "features.web_search",
  "features.apps",
  "features.plugins",
]);

async function statFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? { present: true, bytes: stat.size } : { present: false, bytes: 0 };
  } catch {
    return { present: false, bytes: 0 };
  }
}

async function countEntries(directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isFile()))
      .length;
  } catch {
    return 0;
  }
}

function instructionFacts(text) {
  const rules = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, "").replace(/\s+/g, " ").toLowerCase())
    .filter((line) => line && !line.startsWith("#"));
  return rules.map((line) => ({
    hash: stableHash(line, 32),
    polarity: /\b(?:never|must not|do not|don't)\b/.test(line) ? "deny" : "allow",
    subject: stableHash(line.replace(/\b(?:never|must not|do not|don't|always|must)\b/g, "").replace(/\s+/g, " ").trim(), 32),
  }));
}

function claudeSettingsFacts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { settings_keys: [], secret_keys_excluded: 0 };
  const keys = Object.keys(value);
  return {
    settings_keys: keys.filter((key) => CLAUDE_ALLOWED_KEYS.has(key)).sort(),
    secret_keys_excluded: keys.filter((key) => SECRET_KEY.test(key)).length,
  };
}

function codexSettingsFacts(text) {
  const settings = new Set();
  let secretKeys = 0;
  let section = "";
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (!keyMatch) continue;
    const key = section ? `${section}.${keyMatch[1]}` : keyMatch[1];
    if (SECRET_KEY.test(key)) {
      secretKeys += 1;
    } else if (CODEX_ALLOWED_KEYS.has(key)) {
      settings.add(key);
    }
  }
  return { settings_keys: [...settings].sort(), secret_keys_excluded: secretKeys };
}

async function readAllowed(filePath, dryRun) {
  const stat = await statFile(filePath);
  if (!stat.present || dryRun) return { ...stat, text: null };
  try {
    return { ...stat, text: await fs.readFile(filePath, "utf8") };
  } catch {
    return { ...stat, text: null, unreadable: true };
  }
}

export async function auditGlobalConfig(homeDir, options = {}) {
  const claudeHome = path.join(homeDir, ".claude");
  const codexHome = path.join(homeDir, ".codex");
  const claudeInstructions = await readAllowed(path.join(claudeHome, "CLAUDE.md"), options.dryRun);
  const codexInstructions = await readAllowed(path.join(codexHome, "AGENTS.md"), options.dryRun);
  const claudeSettings = await readAllowed(path.join(claudeHome, "settings.json"), options.dryRun);
  const codexSettings = await readAllowed(path.join(codexHome, "config.toml"), options.dryRun);

  const instructionRules = [];
  if (claudeInstructions.text !== null) instructionRules.push(...instructionFacts(claudeInstructions.text));
  if (codexInstructions.text !== null) instructionRules.push(...instructionFacts(codexInstructions.text));
  const ruleCounts = new Map();
  const subjectPolarities = new Map();
  for (const rule of instructionRules) {
    ruleCounts.set(rule.hash, (ruleCounts.get(rule.hash) || 0) + 1);
    if (!subjectPolarities.has(rule.subject)) subjectPolarities.set(rule.subject, new Set());
    subjectPolarities.get(rule.subject).add(rule.polarity);
  }

  let claudeShape = { settings_keys: [], secret_keys_excluded: 0 };
  if (claudeSettings.text !== null) {
    try {
      claudeShape = claudeSettingsFacts(JSON.parse(claudeSettings.text));
    } catch {
      claudeShape = { settings_keys: [], secret_keys_excluded: 0, malformed: true };
    }
  }
  const codexShape = codexSettings.text === null
    ? { settings_keys: [], secret_keys_excluded: 0 }
    : codexSettingsFacts(codexSettings.text);

  const instructionBytes = claudeInstructions.bytes + codexInstructions.bytes;
  return {
    schema_version: "global-config-audit-v1",
    dry_run: options.dryRun === true,
    instructions: {
      files: Number(claudeInstructions.present) + Number(codexInstructions.present),
      bytes: instructionBytes,
      estimated_tokens: Math.ceil(instructionBytes / 4),
      rules: instructionRules.length,
      duplicate_rules: [...ruleCounts.values()].filter((count) => count > 1).length,
      potential_conflicts: [...subjectPolarities.values()].filter((polarities) => polarities.size > 1).length,
    },
    providers: {
      claude: {
        instruction_present: claudeInstructions.present,
        settings_present: claudeSettings.present,
        ...claudeShape,
        integrations: {
          agents: await countEntries(path.join(claudeHome, "agents")),
          skills: await countEntries(path.join(claudeHome, "skills")),
          hooks: await countEntries(path.join(claudeHome, "hooks")),
          commands: await countEntries(path.join(claudeHome, "commands")),
        },
      },
      codex: {
        instruction_present: codexInstructions.present,
        settings_present: codexSettings.present,
        ...codexShape,
        integrations: {
          rules: await countEntries(path.join(codexHome, "rules")),
          skills: await countEntries(path.join(codexHome, "skills")),
          plugins: await countEntries(path.join(codexHome, "plugins")),
        },
      },
    },
    excluded_categories: [
      "auth and credential files",
      "SQLite databases and WAL files",
      "caches and backups",
      "shell snapshots",
      "arbitrary memories and content stores",
    ],
  };
}
