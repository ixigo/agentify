import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig, persistProviderPreference } from "../src/core/config.js";

test("persistProviderPreference creates and updates .agentify.yaml", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-"));

  await persistProviderPreference(root, "codex");
  let config = await loadConfig(root);
  assert.equal(config.provider, "codex");

  await persistProviderPreference(root, "gemini");
  config = await loadConfig(root);
  assert.equal(config.provider, "gemini");
});
