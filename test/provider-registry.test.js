import test from "node:test";
import assert from "node:assert/strict";

import { BOOTSTRAP_PROVIDERS } from "../src/core/bootstrap.js";
import { SUPPORTED_PROVIDERS } from "../src/core/provider-command.js";
import { SKILL_INSTALL_PROVIDERS } from "../src/core/skills.js";
import {
  BOOTSTRAP_PROVIDER_NAMES,
  EXECUTABLE_PROVIDER_NAMES,
  PROVIDER_DEFINITIONS,
  SKILL_INSTALL_PROVIDER_NAMES,
  getProviderBootstrap,
} from "../src/core/provider-registry.js";

test("provider registry is the canonical source for provider capability lists", () => {
  assert.deepEqual(SUPPORTED_PROVIDERS, Object.keys(PROVIDER_DEFINITIONS));
  assert.deepEqual(BOOTSTRAP_PROVIDERS, BOOTSTRAP_PROVIDER_NAMES);
  assert.deepEqual(SKILL_INSTALL_PROVIDERS, SKILL_INSTALL_PROVIDER_NAMES);
  assert.deepEqual(EXECUTABLE_PROVIDER_NAMES, ["codex", "claude", "gemini", "opencode"]);
});

test("executable providers declare command, bootstrap, auth, and runtime metadata", () => {
  for (const provider of EXECUTABLE_PROVIDER_NAMES) {
    const definition = PROVIDER_DEFINITIONS[provider];
    assert.equal(typeof definition.buildTemplateCommand, "function");
    assert.equal(typeof definition.probeAuth, "function");
    assert.deepEqual(getProviderBootstrap(provider), definition.bootstrap);
    assert.equal(definition.runtime.kind, "external");
    assert.equal(typeof definition.runtime.defaultModel, "string");
    assert.equal(typeof definition.runtime.runner, "string");
  }
});

test("local provider remains validation-only and local-runtime only", () => {
  const definition = PROVIDER_DEFINITIONS.local;
  assert.equal(definition.executable, false);
  assert.equal(definition.skillInstall, false);
  assert.equal(definition.bootstrap, null);
  assert.equal(definition.runtime.kind, "local");
});

