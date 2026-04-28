import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exists } from "../src/core/fs.js";
import {
  installAllBuiltinSkills,
  installBuiltinSkill,
  listBuiltinSkills,
  resolveBuiltinSkill,
  resolveSkillInstallTargets,
} from "../src/core/skills.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function listRelativeFiles(rootDir) {
  const results = [];

  async function walk(currentDir, prefix = "") {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      results.push(relativePath);
    }
  }

  await walk(rootDir);
  return results;
}

async function readPackageJson() {
  const raw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
  return JSON.parse(raw);
}

async function listSkillDirs(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test("listBuiltinSkills exposes built-in catalog and alias", async () => {
  const skills = listBuiltinSkills();
  const names = skills.map((skill) => skill.name);
  const expectedNames = await listSkillDirs(path.join(repoRoot, "skills"));

  assert.deepEqual(names.sort(), expectedNames);
  for (const skill of skills) {
    assert.equal(skill.sourceDir, path.join(repoRoot, "skills", skill.name));
  }
  assert.deepEqual(resolveBuiltinSkill("god-mode").name, "worktree-autopilot");
  assert.deepEqual(resolveBuiltinSkill("worktree-verifier").name, "worktree-autopilot");
  assert.deepEqual(resolveBuiltinSkill("gh-issue-autopilot").name, "gh-autopilot");
  assert.deepEqual(resolveBuiltinSkill("gh-issue-killer").name, "issue-killer");
});

test("resolveSkillInstallTargets expands provider all for project scope", () => {
  const root = "/tmp/agentify-skill-root";
  const result = resolveSkillInstallTargets(root, {
    name: "god-mode",
    provider: "all",
    scope: "project",
    defaultProvider: "local",
  });

  assert.equal(result.skill.name, "worktree-autopilot");
  assert.deepEqual(result.providers, ["codex", "claude", "gemini", "opencode"]);
  assert.deepEqual(
    result.targets.map((target) => target.targetDir),
    [
      path.join(root, ".codex", "skills", "worktree-autopilot"),
      path.join(root, ".claude", "skills", "worktree-autopilot"),
      path.join(root, ".gemini", "skills", "worktree-autopilot"),
      path.join(root, ".opencode", "skills", "worktree-autopilot"),
    ]
  );
});

test("installBuiltinSkill copies codex skill bundle into project scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-skill-codex-"));
  const result = await installBuiltinSkill(root, {
    name: "grill-me",
    provider: "codex",
    scope: "project",
  });

  const skillPath = path.join(root, ".codex", "skills", "grill-me", "SKILL.md");
  const uiPath = path.join(root, ".codex", "skills", "grill-me", "agents", "openai.yaml");

  assert.equal(result.results[0].status, "installed");
  assert.equal(await exists(skillPath), true);
  assert.equal(await exists(uiPath), true);
});

test("installBuiltinSkill copies architecture skill references into project scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-skill-arch-"));
  const result = await installBuiltinSkill(root, {
    name: "improve-codebase-architecture",
    provider: "codex",
    scope: "project",
  });

  const skillPath = path.join(root, ".codex", "skills", "improve-codebase-architecture", "SKILL.md");
  const referencePath = path.join(root, ".codex", "skills", "improve-codebase-architecture", "REFERENCE.md");

  assert.equal(result.results[0].status, "installed");
  assert.equal(await exists(skillPath), true);
  assert.equal(await exists(referencePath), true);
});

test("installBuiltinSkill copies gh autopilot skill bundle into project scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-skill-gh-auto-"));
  const result = await installBuiltinSkill(root, {
    name: "gh-autopilot",
    provider: "codex",
    scope: "project",
  });

  const skillPath = path.join(root, ".codex", "skills", "gh-autopilot", "SKILL.md");
  const uiPath = path.join(root, ".codex", "skills", "gh-autopilot", "agents", "openai.yaml");

  assert.equal(result.results[0].status, "installed");
  assert.equal(await exists(skillPath), true);
  assert.equal(await exists(uiPath), true);
});

test("installBuiltinSkill copies pr creator skill bundle into project scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-skill-pr-creator-"));
  const result = await installBuiltinSkill(root, {
    name: "pr-creator",
    provider: "codex",
    scope: "project",
  });

  const skillPath = path.join(root, ".codex", "skills", "pr-creator", "SKILL.md");
  const uiPath = path.join(root, ".codex", "skills", "pr-creator", "agents", "openai.yaml");

  assert.equal(result.results[0].status, "installed");
  assert.equal(await exists(skillPath), true);
  assert.equal(await exists(uiPath), true);
});

test("installBuiltinSkill copies commit creator skill bundle into project scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-skill-commit-creator-"));
  const result = await installBuiltinSkill(root, {
    name: "commit-creator",
    provider: "codex",
    scope: "project",
  });

  const skillPath = path.join(root, ".codex", "skills", "commit-creator", "SKILL.md");
  const uiPath = path.join(root, ".codex", "skills", "commit-creator", "agents", "openai.yaml");

  assert.equal(result.results[0].status, "installed");
  assert.equal(await exists(skillPath), true);
  assert.equal(await exists(uiPath), true);
});

test("installBuiltinSkill installs canonical skill name for alias across all providers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-skill-all-"));
  const result = await installBuiltinSkill(root, {
    name: "god-mode",
    provider: "all",
    scope: "project",
  });

  assert.equal(result.skill.name, "worktree-autopilot");
  assert.equal(result.results.length, 4);

  for (const provider of ["codex", "claude", "gemini", "opencode"]) {
    const baseDir = provider === "codex"
      ? path.join(root, ".codex", "skills")
      : provider === "claude"
        ? path.join(root, ".claude", "skills")
        : provider === "gemini"
          ? path.join(root, ".gemini", "skills")
          : path.join(root, ".opencode", "skills");
    const skillPath = path.join(baseDir, "worktree-autopilot", "SKILL.md");
    assert.equal(await exists(skillPath), true);
  }
});

test("installBuiltinSkill skips existing targets without force", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-skill-skip-"));
  await installBuiltinSkill(root, {
    name: "grill-me",
    provider: "claude",
    scope: "project",
  });

  const result = await installBuiltinSkill(root, {
    name: "grill-me",
    provider: "claude",
    scope: "project",
  });

  assert.equal(result.results[0].status, "skipped_exists");
});

test("repo-level skills are the canonical built-in skill bundles", async () => {
  const canonicalRoot = path.join(repoRoot, "skills");
  const packageJson = await readPackageJson();
  const skills = listBuiltinSkills();
  const canonicalFiles = await listRelativeFiles(canonicalRoot);

  assert.equal(await exists(path.join(repoRoot, "src", "builtin-skills")), false);
  assert.equal(packageJson.files.includes("src/**/*.js"), true);
  assert.equal(packageJson.files.includes("skills/"), true);
  assert.equal(packageJson.files.includes("src/builtin-skills/"), false);

  for (const skill of skills) {
    const skillFile = path.join(canonicalRoot, skill.name, "SKILL.md");
    assert.equal(canonicalFiles.includes(path.join(skill.name, "SKILL.md")), true);
    assert.equal(await exists(skillFile), true);
  }
});

test("installAllBuiltinSkills installs every built-in skill for codex project scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-skill-install-all-"));
  const expectedNames = await listSkillDirs(path.join(repoRoot, "skills"));
  const result = await installAllBuiltinSkills(root, {
    provider: "codex",
    scope: "project",
  });

  assert.deepEqual(result.installed_skills.sort(), expectedNames);

  for (const skillName of result.installed_skills) {
    const skillPath = path.join(root, ".codex", "skills", skillName, "SKILL.md");
    assert.equal(await exists(skillPath), true);
  }
});
