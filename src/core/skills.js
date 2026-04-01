import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDir, exists } from "./fs.js";
import { SUPPORTED_PROVIDERS } from "./provider-command.js";

const BUILTIN_SKILL_ROOT = fileURLToPath(new URL("../builtin-skills", import.meta.url));

export const SKILL_INSTALL_PROVIDERS = SUPPORTED_PROVIDERS.filter((provider) => provider !== "local");

const BUILTIN_SKILLS = [
  {
    name: "grill-me",
    aliases: [],
    description:
      'Interview the user relentlessly about a plan or design until reaching shared understanding, then map the final plan to GitHub issues via gh CLI when requested. Use when the user wants to stress-test a plan, get grilled on their design, or says "grill me".',
  },
  {
    name: "improve-codebase-architecture",
    aliases: [],
    description:
      "Explore a codebase to find architectural refactors that deepen shallow modules, improve testability, and draft a local architecture RFC. Use when the user wants refactoring opportunities, tighter boundaries, or more AI-navigable modules.",
  },
  {
    name: "gh-issue-autopilot",
    aliases: [],
    description:
      "Select the first or latest open GitHub issue via gh CLI, implement it autonomously, run validation/test loops, and commit once checks pass.",
  },
  {
    name: "worktree-verifier",
    aliases: ["god-mode"],
    description:
      "Run an autonomous coding workflow in the current repository or worktree with minimal human interaction, including verification and commit.",
  },
];

const BUILTIN_SKILL_INDEX = new Map();
for (const skill of BUILTIN_SKILLS) {
  BUILTIN_SKILL_INDEX.set(skill.name, skill);
  for (const alias of skill.aliases) {
    BUILTIN_SKILL_INDEX.set(alias, skill);
  }
}

function normalizeSkillName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeScope(value) {
  const scope = String(value || "project").trim().toLowerCase();
  if (scope !== "project" && scope !== "user") {
    throw new Error('skill scope must be "project" or "user".');
  }
  return scope;
}

function normalizeProviderToken(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (!provider) {
    return "";
  }
  if (provider === "local") {
    throw new Error('skills are installable only for codex, claude, gemini, opencode, or "all".');
  }
  if (!SKILL_INSTALL_PROVIDERS.includes(provider)) {
    throw new Error(
      `unsupported skill provider "${provider}". Supported providers: ${SKILL_INSTALL_PROVIDERS.join(", ")}, all`
    );
  }
  return provider;
}

function getDefaultSkillProvider(defaultProvider) {
  return SKILL_INSTALL_PROVIDERS.includes(defaultProvider) ? defaultProvider : "codex";
}

function parseProviderSelection(rawProvider, defaultProvider) {
  if (rawProvider === undefined || rawProvider === null || rawProvider === false) {
    return [getDefaultSkillProvider(defaultProvider)];
  }

  const raw = String(rawProvider).trim().toLowerCase();
  if (!raw || raw === "true") {
    return [getDefaultSkillProvider(defaultProvider)];
  }
  if (raw === "all") {
    return [...SKILL_INSTALL_PROVIDERS];
  }

  const selected = [];
  const seen = new Set();
  for (const token of raw.split(",")) {
    const provider = normalizeProviderToken(token);
    if (!provider || seen.has(provider)) {
      continue;
    }
    seen.add(provider);
    selected.push(provider);
  }

  if (selected.length === 0) {
    return [getDefaultSkillProvider(defaultProvider)];
  }

  return selected;
}

function getCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function getHomeDir(rootDir, scope, projectRelativeDir, userDir) {
  return scope === "project" ? path.join(rootDir, projectRelativeDir) : userDir;
}

export function getSkillInstallBaseDir(rootDir, provider, scope = "project") {
  const normalizedScope = normalizeScope(scope);
  const normalizedProvider = normalizeProviderToken(provider);

  switch (normalizedProvider) {
    case "codex":
      return getHomeDir(rootDir, normalizedScope, path.join(".codex", "skills"), path.join(getCodexHome(), "skills"));
    case "claude":
      return getHomeDir(rootDir, normalizedScope, path.join(".claude", "skills"), path.join(os.homedir(), ".claude", "skills"));
    case "gemini":
      return getHomeDir(rootDir, normalizedScope, path.join(".gemini", "skills"), path.join(os.homedir(), ".gemini", "skills"));
    case "opencode":
      return getHomeDir(
        rootDir,
        normalizedScope,
        path.join(".opencode", "skills"),
        path.join(os.homedir(), ".config", "opencode", "skills")
      );
    default:
      throw new Error(`unsupported skill provider "${provider}"`);
  }
}

export function resolveBuiltinSkill(name) {
  const normalized = normalizeSkillName(name);
  const skill = BUILTIN_SKILL_INDEX.get(normalized);
  if (!skill) {
    const available = BUILTIN_SKILLS.map((item) => item.name).join(", ");
    throw new Error(`unknown built-in skill "${name}". Available skills: ${available}`);
  }

  return {
    ...skill,
    requestedName: String(name),
    sourceDir: path.join(BUILTIN_SKILL_ROOT, skill.name),
  };
}

export function listBuiltinSkills() {
  return BUILTIN_SKILLS.map((skill) => ({
    ...skill,
    providers: [...SKILL_INSTALL_PROVIDERS],
    sourceDir: path.join(BUILTIN_SKILL_ROOT, skill.name),
  }));
}

export function resolveSkillInstallTargets(rootDir, {
  name,
  provider,
  scope = "project",
  defaultProvider = "codex",
} = {}) {
  const skill = resolveBuiltinSkill(name);
  const normalizedScope = normalizeScope(scope);
  const providers = parseProviderSelection(provider, defaultProvider);

  return {
    skill,
    scope: normalizedScope,
    providers,
    targets: providers.map((selectedProvider) => {
      const baseDir = getSkillInstallBaseDir(rootDir, selectedProvider, normalizedScope);
      return {
        provider: selectedProvider,
        baseDir,
        targetDir: path.join(baseDir, skill.name),
      };
    }),
  };
}

async function copySkillDirectory(sourceDir, targetDir) {
  await ensureDir(path.dirname(targetDir));
  await fs.cp(sourceDir, targetDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
}

export async function installBuiltinSkill(rootDir, options = {}) {
  const { skill, scope, providers, targets } = resolveSkillInstallTargets(rootDir, options);
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const results = [];

  if (!(await exists(skill.sourceDir))) {
    throw new Error(`built-in skill source not found: ${skill.sourceDir}`);
  }

  for (const target of targets) {
    const alreadyExists = await exists(target.targetDir);
    let status;

    if (alreadyExists && !force) {
      status = dryRun ? "would_skip_exists" : "skipped_exists";
    } else if (dryRun) {
      status = alreadyExists ? "would_replace" : "would_install";
    } else {
      if (alreadyExists) {
        await fs.rm(target.targetDir, { recursive: true, force: true });
      }
      await copySkillDirectory(skill.sourceDir, target.targetDir);
      status = alreadyExists ? "replaced" : "installed";
    }

    results.push({
      provider: target.provider,
      base_dir: target.baseDir,
      target_dir: target.targetDir,
      existed: alreadyExists,
      status,
    });
  }

  return {
    command: "skill install",
    scope,
    providers,
    dry_run: dryRun,
    force,
    skill: {
      requested_name: skill.requestedName,
      name: skill.name,
      aliases: skill.aliases,
      description: skill.description,
      source_dir: skill.sourceDir,
    },
    results,
  };
}
