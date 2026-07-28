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
  applyClaudeMcpRegistration,
  applyCodexMcpRegistration,
  applyManagedBlock,
  buildManagedBlock,
  buildManagedHooks,
  claudeIntegrationStatus,
  codexMcpMatches,
  codexMcpRegistered,
  installClaudeIntegration,
  mcpRegistrationStatus,
  mergeManagedHooks,
  registerMcpServer,
  removeClaudeMcpRegistration,
  removeCodexMcpRegistration,
  removeManagedBlock,
  resolveMcpTargets,
  stripManagedHooks,
  uninstallClaudeIntegration,
  unregisterMcpServer,
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

// ---------------------------------------------------------------------------
// MCP server registration (#338)
// ---------------------------------------------------------------------------

test("applyClaudeMcpRegistration adds the entry, preserves unrelated keys, and is idempotent", () => {
  const before = { numStartups: 7, projects: { "/repo": { allowedTools: [] } }, mcpServers: { other: { command: "x" } } };
  const first = applyClaudeMcpRegistration(before);
  assert.equal(first.changed, true);
  assert.equal(first.action, "added");
  // Unrelated top-level keys and sibling MCP servers survive untouched.
  assert.equal(first.config.numStartups, 7);
  assert.deepEqual(first.config.projects, { "/repo": { allowedTools: [] } });
  assert.deepEqual(first.config.mcpServers.other, { command: "x" });
  assert.deepEqual(first.config.mcpServers.agentify, { type: "stdio", command: "agentify", args: ["serve"] });

  const second = applyClaudeMcpRegistration(first.config);
  assert.equal(second.changed, false);
  assert.equal(second.action, "unchanged");
});

test("applyCodexMcpRegistration appends a table once and preserves existing content", () => {
  const before = "[model]\nname = \"gpt\"\n";
  const first = applyCodexMcpRegistration(before);
  assert.equal(first.changed, true);
  assert.ok(first.text.startsWith(before.trimEnd()));
  assert.match(first.text, /\[mcp_servers\.agentify\]/);
  assert.match(first.text, /command = "agentify"/);
  assert.match(first.text, /args = \["serve"\]/);

  assert.equal(codexMcpRegistered(first.text), true);
  const second = applyCodexMcpRegistration(first.text);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test("registerMcpServer writes agentify into a fixture claude.json, backs up, and is idempotent", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mcp-claude-"));
  const configPath = path.join(home, ".claude.json");
  await fs.writeFile(configPath, JSON.stringify({ numStartups: 3, mcpServers: { keep: { command: "keep" } } }, null, 2), "utf8");

  const first = await registerMcpServer({ provider: "claude", homeDir: home });
  assert.equal(first.registered, true);
  assert.equal(first.changed, true);
  assert.equal(first.action, "added");
  assert.equal(first.path, configPath);
  // A backup of the pre-change config exists.
  assert.ok(first.backup);
  await fs.access(first.backup);

  const written = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(written.numStartups, 3);
  assert.deepEqual(written.mcpServers.keep, { command: "keep" });
  assert.deepEqual(written.mcpServers.agentify, { type: "stdio", command: "agentify", args: ["serve"] });

  // Re-running is a no-op: no change and no second registration entry.
  const second = await registerMcpServer({ provider: "claude", homeDir: home });
  assert.equal(second.changed, false);
  assert.equal(second.action, "unchanged");
  assert.equal(second.backup, null);
  const reWritten = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(Object.keys(reWritten.mcpServers).length, 2);

  const status = await mcpRegistrationStatus({ provider: "claude", homeDir: home });
  assert.equal(status.registered, true);
  assert.equal(status.current, true);
});

test("registerMcpServer creates a codex config.toml when absent and stays idempotent", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mcp-codex-"));
  const targets = resolveMcpTargets("/repo", { provider: "codex", homeDir: home });
  assert.equal(targets.path, path.join(home, ".codex", "config.toml"));

  const first = await registerMcpServer({ provider: "codex", homeDir: home });
  assert.equal(first.registered, true);
  assert.equal(first.changed, true);
  // File did not exist, so there is nothing to back up.
  assert.equal(first.existed, false);
  assert.equal(first.backup, null);

  const toml = await fs.readFile(targets.path, "utf8");
  assert.match(toml, /\[mcp_servers\.agentify\]/);

  const second = await registerMcpServer({ provider: "codex", homeDir: home });
  assert.equal(second.changed, false);
  assert.equal(second.action, "unchanged");
});

test("claude registration preserves a different existing agentify entry as a conflict", async () => {
  const custom = { type: "stdio", command: "/opt/agentify/bin/agentify", args: ["serve", "--verbose"], env: { A: "1" } };
  const applied = applyClaudeMcpRegistration({ mcpServers: { agentify: custom } });
  assert.equal(applied.changed, false);
  assert.equal(applied.action, "conflict");

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mcp-claude-conflict-"));
  const configPath = path.join(home, ".claude.json");
  const original = JSON.stringify({ mcpServers: { agentify: custom } }, null, 2);
  await fs.writeFile(configPath, original, "utf8");

  const result = await registerMcpServer({ provider: "claude", homeDir: home });
  assert.equal(result.action, "conflict");
  assert.equal(result.changed, false);
  assert.match(result.error, /already exists/);
  // The user's custom entry is left byte-for-byte untouched.
  assert.equal(await fs.readFile(configPath, "utf8"), original);

  const status = await mcpRegistrationStatus({ provider: "claude", homeDir: home });
  assert.equal(status.registered, true);
  assert.equal(status.current, false);

  // A later uninstall must not delete an entry Agentify did not author.
  const off = await unregisterMcpServer({ provider: "claude", homeDir: home });
  assert.equal(off.changed, false);
  assert.equal(await fs.readFile(configPath, "utf8"), original);
});

test("codex detection ignores a header that lives inside a multiline string", () => {
  const withString = [
    "instructions = \"\"\"",
    "Register Agentify like this:",
    "[mcp_servers.agentify]",
    "command = \"agentify\"",
    "args = [\"serve\"]",
    "\"\"\"",
    "",
    "[model]",
    "name = \"gpt\"",
  ].join("\n");
  // The header is documentation text, not a real table.
  assert.equal(codexMcpRegistered(withString), false);
  // A safe append is possible and must not disturb the multiline string.
  const applied = applyCodexMcpRegistration(withString);
  assert.equal(applied.changed, true);
  assert.match(applied.text, /instructions = """/);
  assert.match(applied.text, /\[model\]/);
  // Removal of the appended table leaves the documentation string intact.
  const removed = removeCodexMcpRegistration(applied.text);
  assert.match(removed.text, /Register Agentify like this:/);
  assert.match(removed.text, /\[model\]/);
});

test("codex masking does not treat a triple-quote inside a comment as a string", () => {
  const withComment = [
    "# example config: \"\"\" not a real string",
    "[mcp_servers.agentify]",
    "command = \"agentify\"",
    "args = [\"serve\"]",
  ].join("\n");
  // The comment must not mask the real table below it.
  assert.equal(codexMcpRegistered(withComment), true);
  assert.equal(codexMcpMatches(withComment), true);
});

test("codex ownership is strict: a customized entry is neither matched nor removed", async () => {
  const custom = "[mcp_servers.agentify]\ncommand = \"agentify\"\nargs = [\"serve\"]\ncwd = \"/work\"\n";
  assert.equal(codexMcpRegistered(custom), true);
  assert.equal(codexMcpMatches(custom), false);

  const withChild = "[mcp_servers.agentify]\ncommand = \"agentify\"\nargs = [\"serve\"]\n\n[mcp_servers.agentify.env]\nDEBUG = \"1\"\n";
  assert.equal(codexMcpMatches(withChild), false);

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mcp-custom-"));
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  const configPath = path.join(home, ".codex", "config.toml");
  await fs.writeFile(configPath, custom, "utf8");
  const off = await unregisterMcpServer({ provider: "codex", homeDir: home });
  assert.equal(off.changed, false);
  assert.equal(await fs.readFile(configPath, "utf8"), custom);
});

test("claude registration rejects a non-object top-level JSON value", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mcp-toplevel-"));
  const configPath = path.join(home, ".claude.json");
  await fs.writeFile(configPath, "[1, 2, 3]", "utf8");
  const result = await registerMcpServer({ provider: "claude", homeDir: home });
  assert.equal(result.registered, false);
  assert.equal(result.changed, false);
  assert.match(result.error, /top-level value is not a JSON object/);
  assert.equal(await fs.readFile(configPath, "utf8"), "[1, 2, 3]");
});

test("claude registration treats a falsy existing agentify entry as a conflict", () => {
  for (const value of [null, false, 0, ""]) {
    const applied = applyClaudeMcpRegistration({ mcpServers: { agentify: value } });
    assert.equal(applied.changed, false, `expected conflict for agentify=${JSON.stringify(value)}`);
    assert.equal(applied.action, "conflict");
  }
});

test("registerMcpServer preserves an existing config's permission bits", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mcp-mode-"));
  const configPath = path.join(home, ".claude.json");
  await fs.writeFile(configPath, JSON.stringify({ numStartups: 1 }, null, 2), "utf8");
  await fs.chmod(configPath, 0o600);

  await registerMcpServer({ provider: "claude", homeDir: home });
  const mode = (await fs.stat(configPath)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600 preserved, got 0${mode.toString(8)}`);
});

test("claude registration refuses a non-object mcpServers value", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mcp-shape-"));
  const configPath = path.join(home, ".claude.json");
  const original = JSON.stringify({ mcpServers: ["oops"] }, null, 2);
  await fs.writeFile(configPath, original, "utf8");

  const result = await registerMcpServer({ provider: "claude", homeDir: home });
  assert.equal(result.registered, false);
  assert.equal(result.changed, false);
  assert.match(result.error, /not an object/);
  assert.equal(await fs.readFile(configPath, "utf8"), original);
});

test("codex detection recognizes an array-of-tables spelling", () => {
  const arrayTable = "[[mcp_servers.agentify]]\ncommand = \"agentify\"\nargs = [\"serve\"]\n";
  assert.equal(codexMcpRegistered(arrayTable), true);
  // Not the single-table form we author, so it is a conflict, not a no-op.
  assert.equal(applyCodexMcpRegistration(arrayTable).changed, false);
});

test("codex registration treats a table pointing elsewhere as a conflict, not a no-op", async () => {
  const stale = "[mcp_servers.agentify]\ncommand = \"old-agentify\"\nargs = [\"wrong\"]\n";
  assert.equal(codexMcpRegistered(stale), true);
  assert.equal(codexMcpMatches(stale), false);
  const applied = applyCodexMcpRegistration(stale);
  assert.equal(applied.changed, false);
  assert.equal(applied.action, "conflict");
  // The stale config is left byte-for-byte untouched.
  assert.equal(applied.text, stale);

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mcp-conflict-"));
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  const configPath = path.join(home, ".codex", "config.toml");
  await fs.writeFile(configPath, stale, "utf8");

  const result = await registerMcpServer({ provider: "codex", homeDir: home });
  assert.equal(result.action, "conflict");
  assert.equal(result.changed, false);
  assert.match(result.error, /already exists .* in a form Agentify did not author/);
  assert.equal(await fs.readFile(configPath, "utf8"), stale);

  const status = await mcpRegistrationStatus({ provider: "codex", homeDir: home });
  assert.equal(status.registered, true);
  // A conflicting entry is NOT current — status stays honest.
  assert.equal(status.current, false);
});

test("codex matching requires both the command and the serve args", () => {
  const wrongArgs = "[mcp_servers.agentify]\ncommand = \"agentify\"\nargs = [\"wrong\"]\n";
  assert.equal(codexMcpMatches(wrongArgs), false);
  assert.equal(applyCodexMcpRegistration(wrongArgs).action, "conflict");

  const right = "[mcp_servers.agentify]\ncommand = \"agentify\"\nargs = [ \"serve\" ]\n";
  assert.equal(codexMcpMatches(right), true);
  assert.equal(applyCodexMcpRegistration(right).action, "unchanged");
});

test("codex registration recognizes equivalent TOML spellings so it never double-appends", () => {
  // Quoted alias, whitespace around the dot, and a deeper dotted key are all
  // the same logical table in TOML — each must count as already registered.
  for (const spelling of [
    "[mcp_servers.\"agentify\"]\ncommand = \"agentify\"\n",
    "[mcp_servers.'agentify']\ncommand = \"agentify\"\n",
    "[mcp_servers . agentify]\ncommand = \"agentify\"\n",
    "mcp_servers.agentify.command = \"agentify\"\nmcp_servers.agentify.args = [\"serve\"]\n",
  ]) {
    assert.equal(codexMcpRegistered(spelling), true, `expected registered for: ${spelling}`);
    // None of these are the exact table we author, so appending is refused.
    assert.equal(applyCodexMcpRegistration(spelling).changed, false, `expected no append for: ${spelling}`);
  }
});

test("codex registration refuses to append when mcp_servers is an inline table", () => {
  const inline = "mcp_servers = { foo = { command = \"foo\" } }\n";
  // agentify is not present, but appending a dotted subtable would break TOML.
  assert.equal(codexMcpRegistered(inline), false);
  const applied = applyCodexMcpRegistration(inline);
  assert.equal(applied.changed, false);
  assert.equal(applied.action, "conflict");
  assert.equal(applied.text, inline);

  // An inline table that already carries agentify is detected as registered.
  const withAgentify = "mcp_servers = { agentify = { command = \"agentify\", args = [\"serve\"] } }\n";
  assert.equal(codexMcpRegistered(withAgentify), true);
});

test("codex detection respects table scope and does not false-positive under other tables", () => {
  // `mcp_servers.agentify` here belongs to [foo], not the global mcp_servers,
  // so it must NOT count as registered — and a safe append must proceed.
  const scoped = "[foo]\nmcp_servers.agentify.command = \"other\"\n";
  assert.equal(codexMcpRegistered(scoped), false);
  const applied = applyCodexMcpRegistration(scoped);
  assert.equal(applied.changed, true);
  assert.equal(applied.action, "added");
  assert.match(applied.text, /\[mcp_servers\.agentify\]/);
});

test("codex registration detects agentify declared inside a [mcp_servers] table", () => {
  const nested = "[mcp_servers]\nagentify = { command = \"agentify\", args = [\"serve\"] }\n";
  assert.equal(codexMcpRegistered(nested), true);
  // We cannot verify the inline form is exactly ours, so it is a conflict, not
  // a silent no-op that appends a duplicate key.
  assert.equal(applyCodexMcpRegistration(nested).action, "conflict");
});

test("codex detection handles a quoted mcp_servers root key and child sub-tables", () => {
  const quotedRoot = "[\"mcp_servers\".agentify]\ncommand = \"agentify\"\nargs = [\"serve\"]\n";
  assert.equal(codexMcpRegistered(quotedRoot), true);
  // Same logical table — must not append a duplicate.
  assert.equal(applyCodexMcpRegistration(quotedRoot).changed, false);

  const withChild = "[mcp_servers.agentify]\ncommand = \"agentify\"\nargs = [\"serve\"]\n\n[mcp_servers.agentify.env]\nDEBUG = \"1\"\n";
  assert.equal(codexMcpRegistered(withChild), true);
});

test("removeCodexMcpRegistration removes the agentify table and its child sub-tables", () => {
  const before = "[model]\nname = \"gpt\"\n\n[mcp_servers.agentify]\ncommand = \"agentify\"\nargs = [\"serve\"]\n\n[mcp_servers.agentify.env]\nDEBUG = \"1\"\n\n[other]\nk = 1\n";
  const removed = removeCodexMcpRegistration(before);
  assert.equal(removed.changed, true);
  assert.doesNotMatch(removed.text, /mcp_servers\.agentify/);
  assert.doesNotMatch(removed.text, /DEBUG/);
  assert.match(removed.text, /\[model\]/);
  assert.match(removed.text, /\[other\]/);
});

test("removeCodexMcpRegistration preserves CRLF and unrelated blank lines", () => {
  // A multiline string with internal blank lines, then our table at the end.
  const before = [
    "instructions = \"\"\"",
    "line one",
    "",
    "",
    "line two",
    "\"\"\"",
    "",
    "[mcp_servers.agentify]",
    "command = \"agentify\"",
    "args = [\"serve\"]",
  ].join("\r\n") + "\r\n";
  const removed = removeCodexMcpRegistration(before);
  assert.equal(removed.changed, true);
  // CRLF endings are preserved.
  assert.ok(removed.text.includes("\r\n"), "CRLF endings must be preserved");
  // The multiline string's internal blank lines are untouched.
  assert.match(removed.text, /line one\r\n\r\n\r\nline two/);
  assert.doesNotMatch(removed.text, /mcp_servers\.agentify/);
});

test("removeClaudeMcpRegistration drops only the agentify entry", () => {
  const before = { numStartups: 4, mcpServers: { agentify: { command: "agentify" }, other: { command: "x" } } };
  const removed = removeClaudeMcpRegistration(before);
  assert.equal(removed.changed, true);
  assert.equal(removed.config.numStartups, 4);
  assert.deepEqual(removed.config.mcpServers, { other: { command: "x" } });

  // When agentify was the only server, mcpServers is dropped entirely.
  const solo = removeClaudeMcpRegistration({ mcpServers: { agentify: {} } });
  assert.equal(solo.config.mcpServers, undefined);

  const noop = removeClaudeMcpRegistration({ mcpServers: { other: {} } });
  assert.equal(noop.changed, false);
});

test("removeCodexMcpRegistration removes the agentify table and preserves the rest", () => {
  const before = "[model]\nname = \"gpt\"\n\n[mcp_servers.agentify]\ncommand = \"agentify\"\nargs = [\"serve\"]\n\n[other]\nk = 1\n";
  const removed = removeCodexMcpRegistration(before);
  assert.equal(removed.changed, true);
  assert.doesNotMatch(removed.text, /mcp_servers\.agentify/);
  assert.match(removed.text, /\[model\]/);
  assert.match(removed.text, /\[other\]/);
});

test("registerMcpServer / unregisterMcpServer round-trip for both providers", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mcp-roundtrip-"));
  await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({ numStartups: 1 }, null, 2), "utf8");

  await registerMcpServer({ provider: "claude", homeDir: home });
  await registerMcpServer({ provider: "codex", homeDir: home });

  const claudeOff = await unregisterMcpServer({ provider: "claude", homeDir: home });
  assert.equal(claudeOff.changed, true);
  assert.ok(claudeOff.backup);
  const claudeJson = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"));
  assert.equal(claudeJson.mcpServers, undefined);
  assert.equal(claudeJson.numStartups, 1);

  const codexOff = await unregisterMcpServer({ provider: "codex", homeDir: home });
  assert.equal(codexOff.changed, true);
  const codexToml = await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(codexToml, /mcp_servers\.agentify/);

  // Unregistering again is a clean no-op.
  const again = await unregisterMcpServer({ provider: "claude", homeDir: home });
  assert.equal(again.changed, false);
});

test("registerMcpServer refuses to overwrite an unparseable claude.json", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mcp-bad-"));
  const configPath = path.join(home, ".claude.json");
  await fs.writeFile(configPath, "{ not valid json ", "utf8");

  const result = await registerMcpServer({ provider: "claude", homeDir: home });
  assert.equal(result.registered, false);
  assert.equal(result.changed, false);
  assert.match(result.error, /not valid JSON/);
  // Left exactly as it was.
  assert.equal(await fs.readFile(configPath, "utf8"), "{ not valid json ");
});
