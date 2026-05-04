import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig, persistProviderPreference, syncConfigFile } from "../src/core/config.js";

test("persistProviderPreference creates and updates .agentify.yaml", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-"));

  await persistProviderPreference(root, "codex");
  let config = await loadConfig(root);
  assert.equal(config.provider, "codex");

  await persistProviderPreference(root, "gemini");
  config = await loadConfig(root);
  assert.equal(config.provider, "gemini");
});

test("loadConfig applies nested semantic flags", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-semantic-"));

  const config = await loadConfig(root, {
    "semantic.tsjs.enabled": true,
    "semantic.tsjs.worker-concurrency": 2,
  });

  assert.equal(config.semantic.tsjs.enabled, true);
  assert.equal(config.semantic.tsjs.workerConcurrency, 2);
});

test("loadConfig keeps doctor --semantic from replacing semantic settings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-doctor-semantic-"));

  const config = await loadConfig(root, {
    semantic: true,
    "semantic.tsjs.enabled": true,
  });

  assert.equal(config.semantic.tsjs.enabled, true);
});

test("loadConfig applies planner execution budget overrides", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-planner-budget-"));
  await fs.writeFile(
    path.join(root, ".agentify.yaml"),
    [
      "planner:",
      "  maxAdditionalReadsBeforeEdit: 1",
      "  maxWidenings: 0",
      "  editAfterSelectedContextUnlessBlocked: false",
      "",
    ].join("\n"),
    "utf8",
  );

  const config = await loadConfig(root);

  assert.equal(config.planner.maxAdditionalReadsBeforeEdit, 1);
  assert.equal(config.planner.maxWidenings, 0);
  assert.equal(config.planner.editAfterSelectedContextUnlessBlocked, false);
});

test("hook config drops deprecated autoRefresh setting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-hooks-"));
  await fs.writeFile(
    path.join(root, ".agentify.yaml"),
    "hooks:\n  preCommit: false\n  postMerge: true\n  autoRefresh: true\n",
    "utf8",
  );

  const config = await loadConfig(root);
  assert.deepEqual(config.hooks, { preCommit: false, postMerge: true });

  await syncConfigFile(root, config);
  const synced = await fs.readFile(path.join(root, ".agentify.yaml"), "utf8");
  assert.doesNotMatch(synced, /autoRefresh/);
  assert.match(synced, /preCommit: false/);
});
