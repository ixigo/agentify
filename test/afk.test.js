import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  extractAfkPlanMarkdown,
  renderAfkPlannerPrompt,
  validateAfkPlanMarkdown,
} from "../src/core/afk.js";
import { runCli } from "../src/main.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

function validPlan(slug = "checkout-retries") {
  return `---
schema_version: "1.0"
type: "agentify-afk-plan"
slug: "${slug}"
task: "add checkout retries"
created_at: "2026-05-07T00:00:00.000Z"
provider: "codex"
status: "ready"
---

# AFK Plan: ${slug}

## Goal
- Add retries.

## Non-Goals
- Do not change payments.

## Repo Context
- Use existing tests.

## Implementation Steps
- Edit the retry module.

## Files To Touch
- src/retry.js

## Tests To Run
- npm test

## Risks
- Retry loops.

## Done Criteria
- Tests pass.

## Cleanup
- agentify clean --planned
`;
}

async function installFakeCodex(binDir, behavior) {
  const codexPath = path.join(binDir, "codex");
  await fs.writeFile(codexPath, `#!/usr/bin/env node
${behavior}
`, "utf8");
  await fs.chmod(codexPath, 0o755);
  return codexPath;
}

test("AFK planner prompt includes the strict plan contract", () => {
  const prompt = renderAfkPlannerPrompt("Add checkout retries", {
    slug: "checkout-retries",
    provider: "codex",
    createdAt: "2026-05-07T00:00:00.000Z",
  });

  assert.match(prompt, /planning-only session/);
  assert.match(prompt, /planning-relevant skills such as `grill-me`/);
  assert.match(prompt, /Use `grill-me`-style questioning/);
  assert.match(prompt, /agentify context \.\.\./);
  assert.match(prompt, /Do not install skills during AFK create/);
  assert.match(prompt, /type: "agentify-afk-plan"/);
  assert.match(prompt, /## Implementation Steps/);
  assert.match(prompt, /User task:\nAdd checkout retries/);
});

test("AFK plan extraction validates the last provider markdown plan", () => {
  const output = `draft text
\`\`\`md
${validPlan("first-plan")}
\`\`\`
final text
\`\`\`markdown
${validPlan("final-plan")}
\`\`\``;

  const extracted = extractAfkPlanMarkdown(output);
  const plan = validateAfkPlanMarkdown(extracted);

  assert.equal(plan.frontmatter.slug, "final-plan");
});

test("agentify afk create captures provider output and writes a validated plan", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-afk-create-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-afk-create-bin-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await initGitRepo(root);
  await installFakeCodex(binDir, `console.log(${JSON.stringify(validPlan("checkout-retries"))});`);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    await runCli([
      "afk",
      "create",
      "--root",
      root,
      "--provider",
      "codex",
      "add checkout retries",
    ]);
  } finally {
    process.env.PATH = previousPath;
  }

  const planPath = path.join(root, ".agentify", "planned", "checkout-retries.md");
  const plan = validateAfkPlanMarkdown(await fs.readFile(planPath, "utf8"));
  assert.equal(plan.frontmatter.task, "add checkout retries");
});

test("agentify afk run creates an isolated worktree and commits verified provider changes", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-afk-run-parent-"));
  const root = path.join(parent, "repo");
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-afk-run-bin-"));
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      test: "node -e \"process.exit(0)\"",
    },
  }, null, 2), "utf8");
  await fs.mkdir(path.join(root, ".agentify", "planned"), { recursive: true });
  await fs.writeFile(path.join(root, ".agentify", "planned", "checkout-retries.md"), validPlan("checkout-retries"), "utf8");
  await initGitRepo(root);
  await installFakeCodex(binDir, `
const fs = require("node:fs");
fs.writeFileSync("afk-output.txt", "done\\n");
`);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    await runCli([
      "afk",
      "run",
      "--root",
      root,
      "--provider",
      "codex",
      ".agentify/planned/checkout-retries.md",
    ]);
  } finally {
    process.env.PATH = previousPath;
  }

  const worktreePath = path.join(parent, "repo.afk-checkout-retries");
  const branch = await execFileAsync("git", ["branch", "--show-current"], { cwd: worktreePath });
  const log = await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: worktreePath });
  const committedFiles = await execFileAsync("git", ["show", "--pretty=", "--name-only", "HEAD"], { cwd: worktreePath });
  const output = await fs.readFile(path.join(worktreePath, "afk-output.txt"), "utf8");

  assert.equal(branch.stdout.trim(), "afk/checkout-retries");
  assert.equal(log.stdout.trim(), "chore: complete AFK plan checkout-retries");
  assert.deepEqual(committedFiles.stdout.trim().split("\n"), ["afk-output.txt"]);
  assert.equal(output, "done\n");
});
