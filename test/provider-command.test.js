import test from "node:test";
import assert from "node:assert/strict";

import { assertSupportedProvider, buildProviderTemplateCommand } from "../src/core/provider-command.js";

test("buildProviderTemplateCommand returns codex argv", () => {
  const argv = buildProviderTemplateCommand("codex", "implement login");
  assert.deepEqual(argv, ["codex", "exec", "implement login"]);
});

test("buildProviderTemplateCommand returns opencode argv with root", () => {
  const argv = buildProviderTemplateCommand("opencode", "implement login", { root: "/tmp/repo" });
  assert.deepEqual(argv, ["opencode", "run", "implement login", "--dir", "/tmp/repo"]);
});

test("buildProviderTemplateCommand rejects local provider", () => {
  assert.throws(() => buildProviderTemplateCommand("local", "task"), /cannot execute agent commands/);
});

test("assertSupportedProvider rejects unknown provider", () => {
  assert.throws(() => assertSupportedProvider("unknown-provider"), /unsupported provider/);
});
