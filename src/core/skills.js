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
    name: "auto-pilot",
    aliases: [],
    description:
      "Execute a task end-to-end with minimal user interaction by deriving requirements from the repository first, then implementing, validating, and committing autonomously.",
  },
  {
    name: "caveman",
    aliases: [],
    description:
      "Ultra-compressed caveman-speak output mode. Cuts ~65-75% of output tokens while keeping full technical accuracy. Supports intensity levels lite/full/ultra/wenyan.",
  },
  {
    name: "caveman-compress",
    aliases: [],
    description:
      "Placeholder for future memory-file compression using caveman-style input-token reduction.",
  },
  {
    name: "design-an-interface",
    aliases: [],
    description:
      'Generate multiple radically different interface designs for a module using parallel sub-agents. Use when the user wants API design options, module shape comparisons, or mentions "design it twice".',
  },
  {
    name: "domain-model",
    aliases: [],
    description:
      "Challenge a plan against the existing domain model, sharpen terminology, and update documentation such as CONTEXT.md and ADRs as decisions crystallize.",
  },
  {
    name: "edit-article",
    aliases: [],
    description:
      "Edit and improve articles by restructuring sections, improving clarity, and tightening prose.",
  },
  {
    name: "git-guardrails-claude-code",
    aliases: [],
    description:
      "Set up Claude Code hooks to block dangerous git commands such as push, reset --hard, clean, and branch deletion before they execute.",
  },
  {
    name: "github-triage",
    aliases: [],
    description:
      "Triage GitHub issues through a label-based state machine. Use when the user wants to create, triage, review, or prepare issues for agent work.",
  },
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
    name: "gh-autopilot",
    aliases: ["gh-issue-autopilot"],
    description:
      "Handle GitHub issue, PR, review, comment, and label workflows via gh CLI, and hand code changes off to worktree-autopilot when isolated implementation is needed.",
  },
  {
    name: "issue-killer",
    aliases: ["gh-issue-killer"],
    description:
      "Launch opted-in GitHub issues into supervised tmux panes, each with its own Worktrunk worktree and Codex or Claude agent prompt running with provider permission checks bypassed for draft PR creation.",
  },
  {
    name: "migrate-to-shoehorn",
    aliases: [],
    description:
      "Migrate test files from TypeScript `as` assertions to @total-typescript/shoehorn. Use when the user mentions shoehorn or partial test data.",
  },
  {
    name: "obsidian-vault",
    aliases: [],
    description:
      "Search, create, and manage notes in an Obsidian vault with wikilinks and index notes.",
  },
  {
    name: "qa",
    aliases: [],
    description:
      "Run an interactive QA session where the user reports bugs conversationally, the agent explores for context, and GitHub issues are filed.",
  },
  {
    name: "request-refactor-plan",
    aliases: [],
    description:
      "Create a detailed refactor plan with tiny commits through user interview, then file it as a GitHub issue.",
  },
  {
    name: "scaffold-exercises",
    aliases: [],
    description:
      "Create exercise directory structures with sections, problems, solutions, and explainers that pass linting.",
  },
  {
    name: "setup-pre-commit",
    aliases: [],
    description:
      "Set up Husky pre-commit hooks with lint-staged, Prettier, type checking, and tests in the current repo.",
  },
  {
    name: "tdd",
    aliases: [],
    description:
      "Guide test-driven development with a red-green-refactor loop. Use for test-first feature work, bug fixes, and integration-style tests.",
  },
  {
    name: "to-issues",
    aliases: [],
    description:
      "Break a plan, spec, or PRD into independently grabbable GitHub issues using tracer-bullet vertical slices.",
  },
  {
    name: "to-prd",
    aliases: [],
    description:
      "Turn the current conversation context into a PRD and submit it as a GitHub issue.",
  },
  {
    name: "triage-issue",
    aliases: [],
    description:
      "Triage a bug or issue by exploring the codebase to find root cause, then create a GitHub issue with a TDD-based fix plan.",
  },
  {
    name: "ubiquitous-language",
    aliases: [],
    description:
      "Extract a DDD-style ubiquitous language glossary from the current conversation, flag ambiguities, and save canonical terms to UBIQUITOUS_LANGUAGE.md.",
  },
  {
    name: "copy-mode",
    aliases: [],
    description:
      "Analyze a repository, extract architecture and conventions, and write agent-ready handoff docs to docs/architecture.md, prd.md, and summary.md.",
  },
  {
    name: "copy-pr",
    aliases: [],
    description:
      "Copy a GitHub or Azure DevOps PR URL onto a fresh local branch, verify diff parity, commit the recreated changes, and push automatically.",
  },
  {
    name: "worktree-autopilot",
    aliases: ["god-mode", "worktree-verifier"],
    description:
      "Detect the repo's worktree workflow, create a fresh task worktree, implement and verify the change there, commit it, and return the local merge-back commands.",
  },
  {
    name: "pr-creator",
    aliases: [],
    description:
      "Guide pull request creation across GitHub, GitLab, or Azure DevOps by checking CLI prerequisites/auth first, then opening a draft PR and returning the link.",
  },
  {
    name: "commit-creator",
    aliases: [],
    description:
      "Create focused, high-quality commits using conventional prefixes (feat/fix/chore/refactor/docs/test/etc.) with clear summaries.",
  },
  {
    name: "write-a-skill",
    aliases: [],
    description:
      "Create new agent skills with proper structure, progressive disclosure, and bundled resources.",
  },
  {
    name: "zoom-out",
    aliases: [],
    description:
      "Tell the agent to zoom out and provide broader context or a higher-level map of unfamiliar code.",
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

export async function installAllBuiltinSkills(rootDir, options = {}) {
  const skills = listBuiltinSkills();
  const results = [];

  for (const skill of skills) {
    const installed = await installBuiltinSkill(rootDir, {
      ...options,
      name: skill.name,
    });
    results.push(installed);
  }

  return {
    command: "skill-install-all",
    scope: results[0]?.scope || String(options.scope || "project"),
    provider_selection: String(options.provider || ""),
    default_provider: String(options.defaultProvider || "codex"),
    installed_skills: results.map((item) => item.skill.name),
    results,
  };
}

export async function detectProjectSkillProviders(rootDir) {
  const detected = [];

  for (const provider of SKILL_INSTALL_PROVIDERS) {
    const baseDir = getSkillInstallBaseDir(rootDir, provider, "project");
    if (await exists(baseDir)) {
      detected.push(provider);
    }
  }

  return detected;
}

export async function syncProjectBuiltinSkills(rootDir, options = {}) {
  const detectedProviders = await detectProjectSkillProviders(rootDir);
  const explicitSelection = options.provider !== undefined && options.provider !== null && options.provider !== false;
  const providers = explicitSelection
    ? parseProviderSelection(options.provider, options.defaultProvider)
    : detectedProviders;

  if (providers.length === 0) {
    return {
      command: "skill sync",
      scope: "project",
      explicit_selection: explicitSelection,
      detected_project_providers: detectedProviders,
      providers: [],
      results: [],
      status: "skipped_no_project_skill_roots",
    };
  }

  const results = [];
  for (const provider of providers) {
    results.push(await installAllBuiltinSkills(rootDir, {
      provider,
      scope: "project",
      force: true,
      dryRun: options.dryRun,
      defaultProvider: options.defaultProvider,
    }));
  }

  return {
    command: "skill sync",
    scope: "project",
    explicit_selection: explicitSelection,
    detected_project_providers: detectedProviders,
    providers,
    results,
    status: options.dryRun ? "would_sync" : "synced",
  };
}
