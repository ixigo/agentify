import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  PLAN_RENDERER_MARKER,
  PLAN_RENDERER_SCRIPT_NAME,
  applyManagedBlock,
  buildManagedBlock,
  buildManagedHooks,
  claudeIntegrationStatus,
  installClaudeIntegration,
  mergeManagedHooks,
  removeManagedBlock,
  stripManagedHooks,
  uninstallClaudeIntegration,
} from "../src/core/integrations.js";

test("applyManagedBlock adds a managed block to empty and existing text", () => {
  const empty = applyManagedBlock("");
  assert.equal(empty.changed, true);
  assert.equal(empty.action, "added");
  assert.ok(empty.text.includes(MANAGED_BLOCK_BEGIN));
  assert.ok(empty.text.includes(MANAGED_BLOCK_END));

  const existing = applyManagedBlock("# My project\n\nSome notes.\n");
  assert.equal(existing.changed, true);
  assert.equal(existing.action, "added");
  assert.ok(existing.text.startsWith("# My project"));
  assert.ok(existing.text.includes(MANAGED_BLOCK_BEGIN));
});

test("applyManagedBlock is idempotent for a current block", () => {
  const first = applyManagedBlock("# Project\n");
  const second = applyManagedBlock(first.text);
  assert.equal(second.changed, false);
  assert.equal(second.action, "unchanged");
  assert.equal(second.text, first.text);
});

test("applyManagedBlock updates an outdated block in place", () => {
  const outdated = `# Project\n\n${MANAGED_BLOCK_BEGIN}\nold agentify guidance\n${MANAGED_BLOCK_END}\n\n## Trailing\n`;
  const result = applyManagedBlock(outdated);
  assert.equal(result.changed, true);
  assert.equal(result.action, "updated");
  assert.ok(result.text.includes(buildManagedBlock()));
  assert.ok(result.text.includes("## Trailing"));
  assert.equal(result.text.indexOf(MANAGED_BLOCK_BEGIN), result.text.lastIndexOf(MANAGED_BLOCK_BEGIN));
});

test("removeManagedBlock strips the block and preserves surrounding content", () => {
  const withBlock = applyManagedBlock("# Project\n\nKeep me.\n").text;
  const removed = removeManagedBlock(withBlock);
  assert.equal(removed.changed, true);
  assert.ok(removed.text.includes("# Project"));
  assert.ok(removed.text.includes("Keep me."));
  assert.ok(!removed.text.includes(MANAGED_BLOCK_BEGIN));

  const noBlock = removeManagedBlock("# Project only\n");
  assert.equal(noBlock.changed, false);
  assert.equal(noBlock.text, "# Project only\n");
});

test("mergeManagedHooks merges into existing settings and preserves user hooks", () => {
  const userHook = {
    matcher: "Bash",
    hooks: [{ type: "command", command: "my-linter" }],
  };
  const settings = {
    permissions: { allow: ["Bash"] },
    hooks: { PostToolUse: [userHook] },
  };

  const merged = mergeManagedHooks(settings);
  assert.equal(merged.changed, true);
  // User's non-managed hook survives.
  assert.ok(merged.settings.hooks.PostToolUse.some((entry) => entry === userHook));
  // Managed events are present.
  for (const event of Object.keys(buildManagedHooks())) {
    assert.ok(Array.isArray(merged.settings.hooks[event]));
  }
  const planHook = merged.settings.hooks.PostToolUse.find((entry) => entry.matcher === "ExitPlanMode");
  assert.ok(planHook);
  assert.match(planHook.hooks[0].command, new RegExp(PLAN_RENDERER_SCRIPT_NAME));
  assert.equal(planHook.hooks[0].statusMessage, "Rendering plan to HTML...");
  // Unrelated settings untouched.
  assert.deepEqual(merged.settings.permissions, { allow: ["Bash"] });

  // Idempotent second merge.
  const again = mergeManagedHooks(merged.settings);
  assert.equal(again.changed, false);
  assert.deepEqual(again.settings, merged.settings);
});

test("stripManagedHooks removes only agentify entries and keeps user hooks", () => {
  const userHook = {
    matcher: "Bash",
    hooks: [{ type: "command", command: "my-linter" }],
  };
  const merged = mergeManagedHooks({ hooks: { PostToolUse: [userHook] } });

  const stripped = stripManagedHooks(merged.settings);
  assert.equal(stripped.changed, true);
  assert.deepEqual(stripped.settings.hooks.PostToolUse, [userHook]);
  // Managed-only events are dropped entirely.
  assert.equal(stripped.settings.hooks.SessionStart, undefined);

  const noManaged = stripManagedHooks({ hooks: { PostToolUse: [userHook] } });
  assert.equal(noManaged.changed, false);
});

test("installClaudeIntegration and uninstallClaudeIntegration round-trip at project scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-claude-project-"));
  await fs.writeFile(path.join(root, "CLAUDE.md"), "# Existing project memory\n", "utf8");

  const install = await installClaudeIntegration(root);
  assert.equal(install.scope, "project");
  assert.equal(install.memory.changed, true);
  assert.equal(install.settings.changed, true);
  assert.equal(install.settings.renderer.changed, true);

  const memory = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
  assert.ok(memory.includes("# Existing project memory"));
  assert.ok(memory.includes(MANAGED_BLOCK_BEGIN));

  const settings = JSON.parse(await fs.readFile(path.join(root, ".claude", "settings.json"), "utf8"));
  assert.ok(Array.isArray(settings.hooks.PostToolUse));
  assert.ok(settings.hooks.PostToolUse.some((entry) => entry.matcher === "ExitPlanMode"));
  const rendererPath = path.join(root, ".claude", "hooks", PLAN_RENDERER_SCRIPT_NAME);
  const renderer = await fs.readFile(rendererPath, "utf8");
  assert.ok(renderer.includes(PLAN_RENDERER_MARKER));

  const statusInstalled = await claudeIntegrationStatus(root);
  assert.equal(statusInstalled.installed, true);
  assert.equal(statusInstalled.memory.installed, true);
  assert.equal(statusInstalled.memory.current, true);
  assert.equal(statusInstalled.settings.installed, true);
  assert.equal(statusInstalled.settings.renderer.installed, true);

  // Idempotent reinstall.
  const reinstall = await installClaudeIntegration(root);
  assert.equal(reinstall.memory.changed, false);
  assert.equal(reinstall.settings.changed, false);
  assert.equal(reinstall.settings.renderer.changed, false);

  const uninstall = await uninstallClaudeIntegration(root);
  assert.equal(uninstall.memory.changed, true);
  assert.equal(uninstall.settings.changed, true);
  assert.equal(uninstall.settings.renderer.changed, true);

  const afterMemory = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
  assert.ok(afterMemory.includes("# Existing project memory"));
  assert.ok(!afterMemory.includes(MANAGED_BLOCK_BEGIN));
  await assert.rejects(() => fs.access(rendererPath));

  const statusRemoved = await claudeIntegrationStatus(root);
  assert.equal(statusRemoved.installed, false);
});

test("installClaudeIntegration writes into homeDir/.claude for global scope", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-claude-home-"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-claude-global-root-"));

  const install = await installClaudeIntegration(root, { global: true, homeDir });
  assert.equal(install.scope, "global");
  assert.equal(install.memory.path, path.join(homeDir, ".claude", "CLAUDE.md"));

  const memory = await fs.readFile(path.join(homeDir, ".claude", "CLAUDE.md"), "utf8");
  assert.ok(memory.includes(MANAGED_BLOCK_BEGIN));
  // Nothing written into the project root at global scope.
  await assert.rejects(() => fs.access(path.join(root, "CLAUDE.md")));

  const status = await claudeIntegrationStatus(root, { global: true, homeDir });
  assert.equal(status.installed, true);

  const uninstall = await uninstallClaudeIntegration(root, { global: true, homeDir });
  assert.equal(uninstall.scope, "global");
  assert.equal(uninstall.memory.changed, true);

  const afterStatus = await claudeIntegrationStatus(root, { global: true, homeDir });
  assert.equal(afterStatus.installed, false);
});

test("installClaudeIntegration dry-run does not touch the filesystem", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-claude-dry-"));
  const result = await installClaudeIntegration(root, { dryRun: true });
  assert.equal(result.dry_run, true);
  assert.equal(result.memory.changed, true);
  await assert.rejects(() => fs.access(path.join(root, "CLAUDE.md")));
  await assert.rejects(() => fs.access(path.join(root, ".claude", "settings.json")));
});

test("codex integration targets AGENTS.md and has no hook settings", async () => {
  const { resolveIntegrationTargets, installIntegration, uninstallIntegration, integrationStatus } = await import("../src/core/integrations.js");

  const projectTargets = resolveIntegrationTargets("/repo", { provider: "codex" });
  assert.equal(projectTargets.memoryPath, path.join("/repo", "AGENTS.md"));
  assert.equal(projectTargets.settingsPath, null);

  const globalTargets = resolveIntegrationTargets("/repo", { provider: "codex", global: true, homeDir: "/home/u" });
  assert.equal(globalTargets.memoryPath, path.join("/home/u", ".codex", "AGENTS.md"));
  assert.equal(globalTargets.settingsPath, null);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-codex-"));
  try {
    const installed = await installIntegration(dir, { provider: "codex" });
    assert.equal(installed.provider, "codex");
    assert.equal(installed.settings.supported, false);
    const agentsMd = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    assert.ok(agentsMd.includes(MANAGED_BLOCK_BEGIN));
    assert.ok(agentsMd.includes("Codex has no automatic lifecycle hooks"));

    const status = await integrationStatus(dir, { provider: "codex" });
    assert.equal(status.installed, true);
    assert.equal(status.settings.supported, false);

    const removed = await uninstallIntegration(dir, { provider: "codex" });
    assert.equal(removed.memory.changed, true);
    const after = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    assert.ok(!after.includes(MANAGED_BLOCK_BEGIN));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resolveIntegrationProviders expands all and rejects unknown providers", async () => {
  const { resolveIntegrationProviders } = await import("../src/core/integrations.js");
  assert.deepEqual(resolveIntegrationProviders(undefined), ["claude"]);
  assert.deepEqual(resolveIntegrationProviders("codex"), ["codex"]);
  assert.deepEqual(resolveIntegrationProviders("all"), ["claude", "codex"]);
  assert.deepEqual(resolveIntegrationProviders(undefined, { fallback: "all" }), ["claude", "codex"]);
  assert.throws(() => resolveIntegrationProviders("gemini"), /Unsupported integration provider/);
});
