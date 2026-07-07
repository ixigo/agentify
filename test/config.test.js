import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig, writeDefaultConfig } from "../src/core/config.js";

test("loadConfig returns the trimmed default configuration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-defaults-"));

  const config = await loadConfig(root);

  assert.equal(config.provider, "local");
  assert.equal(config.strict, true);
  assert.equal(config.languages, "auto");
  assert.equal(config.moduleStrategy, "auto");
  assert.deepEqual(config.toolchain, { zoekt: false });
  assert.deepEqual(config.hooks, { preCommit: true, postMerge: true, prePush: false });
  assert.deepEqual(config.runtime, { store: "local", sharedStorePath: null });
  assert.deepEqual(config.cleanup, {
    keepRuns: 20,
    maxRunAgeDays: 14,
    keepGhostRuns: 3,
    maxGhostAgeDays: 3,
    pruneInvalidSessions: true,
  });
});

test("loadConfig deep-merges repository .agentify.yaml overrides", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-merge-"));
  await fs.writeFile(
    path.join(root, ".agentify.yaml"),
    ["provider: codex", "hooks:", "  postMerge: false", "runtime:", "  store: shared", ""].join("\n"),
    "utf8",
  );

  const config = await loadConfig(root);

  assert.equal(config.provider, "codex");
  assert.deepEqual(config.hooks, { preCommit: true, postMerge: false, prePush: false });
  assert.equal(config.runtime.store, "shared");
  assert.equal(config.runtime.sharedStorePath, null);
});

test("loadConfig applies nested dashed flag overrides", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-flags-"));

  const config = await loadConfig(root, {
    "cleanup.keep-runs": 5,
    "toolchain.zoekt": true,
  });

  assert.equal(config.cleanup.keepRuns, 5);
  assert.equal(config.toolchain.zoekt, true);
});

test("loadConfig drops the deprecated autoRefresh hook setting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-hooks-"));
  await fs.writeFile(
    path.join(root, ".agentify.yaml"),
    "hooks:\n  preCommit: false\n  postMerge: true\n  autoRefresh: true\n",
    "utf8",
  );

  const config = await loadConfig(root);

  assert.deepEqual(config.hooks, { preCommit: false, postMerge: true, prePush: false });
});

test("writeDefaultConfig creates .agentify.yaml and leaves an existing file untouched", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-write-"));
  const config = await loadConfig(root);

  const configPath = await writeDefaultConfig(root, config);
  assert.equal(configPath, path.join(root, ".agentify.yaml"));

  const written = await fs.readFile(configPath, "utf8");
  assert.match(written, /provider: local/);
  assert.match(written, /preCommit: true/);
  assert.doesNotMatch(written, /autoRefresh/);

  await fs.writeFile(configPath, "provider: codex\n", "utf8");
  await writeDefaultConfig(root, config);
  assert.equal(await fs.readFile(configPath, "utf8"), "provider: codex\n");
});

test("writeDefaultConfig honors dry-run by not writing a file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-dry-"));
  const config = await loadConfig(root);

  await writeDefaultConfig(root, config, { dryRun: true });

  await assert.rejects(() => fs.access(path.join(root, ".agentify.yaml")));
});
