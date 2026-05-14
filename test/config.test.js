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

test("loadConfig provides project test timeout defaults", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-test-timeout-"));

  const config = await loadConfig(root);

  assert.equal(config.tests.timeoutMs, 600000);
});

test("loadConfig ignores repo-configured project test full-env inheritance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-test-env-inherit-"));
  await fs.writeFile(
    path.join(root, ".agentify.yaml"),
    [
      "tests:",
      "  env:",
      "    inherit: true",
      "    passthrough:",
      "      - MY_TEST_VAR",
      "    extra:",
      "      NODE_ENV: test",
      "",
    ].join("\n"),
    "utf8",
  );

  const config = await loadConfig(root);

  assert.equal(config.tests.env.inherit, false);
  assert.deepEqual(config.tests.env.passthrough, ["MY_TEST_VAR"]);
  assert.deepEqual(config.tests.env.extra, { NODE_ENV: "test" });
});

test("loadConfig allows explicit flag opt-in for project test full-env inheritance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-test-env-flag-"));
  await fs.writeFile(
    path.join(root, ".agentify.yaml"),
    [
      "tests:",
      "  env:",
      "    inherit: true",
      "",
    ].join("\n"),
    "utf8",
  );

  const config = await loadConfig(root, {
    "tests.env.inherit": true,
  });

  assert.equal(config.tests.env.inherit, true);
});

test("loadConfig provides provider env policy defaults", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-provider-env-"));

  const config = await loadConfig(root);

  assert.deepEqual(config.providerEnv, {
    inherit: false,
    passthrough: [],
    extra: {},
  });
});

test("loadConfig provides context orchestration defaults", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-context-defaults-"));

  const config = await loadConfig(root);

  assert.deepEqual(config.context, {
    mode: "compact",
    routedDefaultProvider: null,
    compactAfterRun: true,
    autoPrepareChildAboveKb: 96,
    maxFetchBytes: 12000,
    maxSearchResults: 12,
    allowProviderSummary: true,
  });
});

test("loadConfig applies nested context file and flag overrides", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-context-overrides-"));
  await fs.writeFile(
    path.join(root, ".agentify.yaml"),
    [
      "context:",
      "  mode: routed",
      "  autoPrepareChildAboveKb: 64",
      "  routedDefaultProvider: codex",
      "  maxFetchBytes: 8000",
      "  allowProviderSummary: false",
      "",
    ].join("\n"),
    "utf8",
  );

  const config = await loadConfig(root, {
    "context.mode": "routed",
    "context.max-fetch-bytes": 4096,
    "context.max-search-results": 5,
    "context.auto-prepare-child-above-kb": 128,
  });

  assert.equal(config.context.mode, "routed");
  assert.equal(config.context.routedDefaultProvider, "codex");
  assert.equal(config.context.maxFetchBytes, 4096);
  assert.equal(config.context.maxSearchResults, 5);
  assert.equal(config.context.autoPrepareChildAboveKb, 128);
  assert.equal(config.context.allowProviderSummary, false);
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
