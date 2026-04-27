import test from "node:test";
import assert from "node:assert/strict";

import { assertSupportedProvider, buildProviderTemplateCommand } from "../src/core/provider-command.js";

test("buildProviderTemplateCommand returns codex argv", () => {
  const argv = buildProviderTemplateCommand("codex", "implement login");
  assert.deepEqual(argv, ["codex", "exec", "implement login"]);
});

test("buildProviderTemplateCommand returns interactive codex argv", () => {
  const argv = buildProviderTemplateCommand("codex", "implement login", {
    root: "/tmp/repo",
    interactive: true,
  });
  assert.deepEqual(argv, ["codex", "--cd", "/tmp/repo", "implement login"]);
});

test("buildProviderTemplateCommand can bypass permissions for interactive codex", () => {
  const argv = buildProviderTemplateCommand("codex", "implement login", {
    root: "/tmp/repo",
    interactive: true,
    bypassPermissions: true,
  });
  assert.deepEqual(argv, [
    "codex",
    "--cd",
    "/tmp/repo",
    "--dangerously-bypass-approvals-and-sandbox",
    "implement login",
  ]);
});

test("buildProviderTemplateCommand returns opencode argv with root", () => {
  const argv = buildProviderTemplateCommand("opencode", "implement login", { root: "/tmp/repo" });
  assert.deepEqual(argv, ["opencode", "run", "implement login", "--dir", "/tmp/repo"]);
});

test("buildProviderTemplateCommand returns interactive claude argv", () => {
  const argv = buildProviderTemplateCommand("claude", "implement login", { interactive: true });
  assert.deepEqual(argv, ["claude", "implement login"]);
});

test("buildProviderTemplateCommand can bypass permissions for interactive claude", () => {
  const argv = buildProviderTemplateCommand("claude", "implement login", {
    interactive: true,
    bypassPermissions: true,
  });
  assert.deepEqual(argv, [
    "claude",
    "--dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "implement login",
  ]);
});

test("buildProviderTemplateCommand returns interactive gemini argv", () => {
  const argv = buildProviderTemplateCommand("gemini", "implement login", { interactive: true });
  assert.deepEqual(argv, ["gemini", "implement login"]);
});

test("buildProviderTemplateCommand returns interactive opencode argv with root", () => {
  const argv = buildProviderTemplateCommand("opencode", "implement login", {
    root: "/tmp/repo",
    interactive: true,
  });
  assert.deepEqual(argv, ["opencode", "--dir", "/tmp/repo", "implement login"]);
});

test("buildProviderTemplateCommand rejects local provider", () => {
  assert.throws(() => buildProviderTemplateCommand("local", "task"), /cannot execute agent commands/);
});

test("assertSupportedProvider rejects unknown provider", () => {
  assert.throws(() => assertSupportedProvider("unknown-provider"), /unsupported provider/);
});
