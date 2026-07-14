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
  assert.deepEqual(config.models.budget, { dailyUsd: null, monthlyUsd: null, onLimit: "block" });
  assert.equal(config.context.sessionSummaries, "extractive");
  assert.deepEqual(config.context.summary, { maxChars: 600, llmMinEvents: 20, maxBudgetUsd: 0.03 });
});

test("loadConfig merges budget and summary overrides and keeps legacy boolean summaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-budget-"));
  await fs.writeFile(
    path.join(root, ".agentify.yaml"),
    [
      "models:",
      "  budget:",
      "    dailyUsd: 2.5",
      "  routes:",
      "    quick:",
      "      maxBudgetUsd: 0.05",
      "context:",
      "  sessionSummaries: true",
      "  summary:",
      "    llmMinEvents: 5",
      "",
    ].join("\n"),
    "utf8",
  );

  const config = await loadConfig(root);
  assert.equal(config.models.budget.dailyUsd, 2.5);
  assert.equal(config.models.budget.onLimit, "block");
  assert.equal(config.models.routes.quick.maxBudgetUsd, 0.05);
  assert.equal(config.models.routes.quick.maxTurns, 4);
  // Legacy boolean survives the merge untouched; mode mapping happens in ctx.
  assert.equal(config.context.sessionSummaries, true);
  assert.equal(config.context.summary.llmMinEvents, 5);
  assert.equal(config.context.summary.maxChars, 600);
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

test("context budget defaults: explicit budget unset, gates null, reserves pinned", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-config-ctx-"));
  try {
    const config = await loadConfig(dir, {});
    // Deliberately null so the context policy can distinguish an explicit
    // repo pin from its own documented default (1200).
    assert.equal(config.context.maxInjectedTokens, null);
    assert.equal(config.context.minScore, null);
    assert.equal(config.context.maxAgeDays, null);
    assert.deepEqual(config.context.reserve, { decisions: 250, failures: 250 });

    await fs.writeFile(path.join(dir, ".agentify.yaml"), [
      "context:",
      "  maxInjectedTokens: 800",
      "  reserve:",
      "    decisions: 100",
    ].join("\n"));
    const pinned = await loadConfig(dir, {});
    assert.equal(pinned.context.maxInjectedTokens, 800);
    assert.deepEqual(pinned.context.reserve, { decisions: 100, failures: 250 });
    assert.equal(pinned.context.injection, "relevant");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
