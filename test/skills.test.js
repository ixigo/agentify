import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { exists } from "../src/core/fs.js";
import { installBuiltinSkill, listBuiltinSkills, resolveBuiltinSkill, resolveSkillInstallTargets } from "../src/core/skills.js";

test("listBuiltinSkills exposes built-in catalog and alias", () => {
  const skills = listBuiltinSkills();
  const names = skills.map((skill) => skill.name);

  assert.deepEqual(names.sort(), ["gh-issue-autopilot", "grill-me", "improve-codebase-architecture", "worktree-verifier"]);
  assert.deepEqual(resolveBuiltinSkill("god-mode").name, "worktree-verifier");
});

test("resolveSkillInstallTargets expands provider all for project scope", () => {
  const root = "/tmp/agentify-skill-root";
  const result = resolveSkillInstallTargets(root, {
    name: "god-mode",
    provider: "all",
    scope: "project",
    defaultProvider: "local",
  });

  assert.equal(result.skill.name, "worktree-verifier");
  assert.deepEqual(result.providers, ["codex", "claude", "gemini", "opencode"]);
  assert.deepEqual(
    result.targets.map((target) => target.targetDir),
    [
      path.join(root, ".codex", "skills", "worktree-verifier"),
      path.join(root, ".claude", "skills", "worktree-verifier"),
      path.join(root, ".gemini", "skills", "worktree-verifier"),
      path.join(root, ".opencode", "skills", "worktree-verifier"),
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

test("installBuiltinSkill copies gh issue autopilot skill bundle into project scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-skill-gh-auto-"));
  const result = await installBuiltinSkill(root, {
    name: "gh-issue-autopilot",
    provider: "codex",
    scope: "project",
  });

  const skillPath = path.join(root, ".codex", "skills", "gh-issue-autopilot", "SKILL.md");
  const uiPath = path.join(root, ".codex", "skills", "gh-issue-autopilot", "agents", "openai.yaml");

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

  assert.equal(result.skill.name, "worktree-verifier");
  assert.equal(result.results.length, 4);

  for (const provider of ["codex", "claude", "gemini", "opencode"]) {
    const baseDir = provider === "codex"
      ? path.join(root, ".codex", "skills")
      : provider === "claude"
        ? path.join(root, ".claude", "skills")
        : provider === "gemini"
          ? path.join(root, ".gemini", "skills")
          : path.join(root, ".opencode", "skills");
    const skillPath = path.join(baseDir, "worktree-verifier", "SKILL.md");
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
