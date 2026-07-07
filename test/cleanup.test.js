import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { runClean } from "../src/core/cleanup.js";

async function setOldMtime(targetPath, daysAgo) {
  const date = new Date(Date.now() - (daysAgo * 86400000));
  await fs.utimes(targetPath, date, date);
}

async function pathExists(targetPath) {
  return fs.stat(targetPath).then(() => true).catch(() => false);
}

test("runClean prunes stale run reports, ghost runs, and invalid sessions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-clean-"));
  await fs.mkdir(path.join(root, ".agentify", "runs"), { recursive: true });
  await fs.mkdir(path.join(root, ".agentify", "session", "broken"), { recursive: true });
  await fs.mkdir(path.join(root, ".agentify", "session", "valid"), { recursive: true });
  await fs.mkdir(path.join(root, ".current_session", "ghost_old"), { recursive: true });
  await fs.mkdir(path.join(root, ".current_session", "ghost_keep"), { recursive: true });

  await fs.writeFile(path.join(root, ".agentify", "runs", "keep.json"), "{}\n");
  await fs.writeFile(path.join(root, ".agentify", "runs", "old.json"), "{}\n");
  await fs.writeFile(path.join(root, ".agentify", "session", "valid", "session-manifest.json"), "{}\n");
  await fs.writeFile(path.join(root, ".current_session", "ghost_old", "ghost-report.json"), "{}\n");
  await fs.writeFile(path.join(root, ".current_session", "ghost_keep", "ghost-report.json"), "{}\n");

  await setOldMtime(path.join(root, ".agentify", "runs", "old.json"), 10);
  await setOldMtime(path.join(root, ".current_session", "ghost_old"), 10);

  const config = await loadConfig(root, { provider: "local" });
  config.cleanup.keepRuns = 1;
  config.cleanup.maxRunAgeDays = 1;
  config.cleanup.keepGhostRuns = 1;
  config.cleanup.maxGhostAgeDays = 1;

  const result = await runClean(root, config);

  assert.ok(result.removed_paths.includes(".agentify/runs/old.json"));
  assert.ok(result.removed_paths.includes(".current_session/ghost_old"));
  assert.ok(result.removed_paths.includes(".agentify/session/broken"));

  assert.equal(await pathExists(path.join(root, ".agentify", "runs", "old.json")), false);
  assert.equal(await pathExists(path.join(root, ".current_session", "ghost_old")), false);
  assert.equal(await pathExists(path.join(root, ".agentify", "session", "broken")), false);

  assert.equal(await pathExists(path.join(root, ".agentify", "runs", "keep.json")), true);
  assert.equal(await pathExists(path.join(root, ".current_session", "ghost_keep")), true);
  assert.equal(await pathExists(path.join(root, ".agentify", "session", "valid")), true);

  // Removed cache/module-doc cleanup groups no longer appear in the result payload.
  assert.equal("removed_cache_blobs" in result, false);
  assert.equal("orphaned_module_artifacts" in result, false);
});

test("runClean dry-run reports removals without deleting files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-clean-dry-"));
  await fs.mkdir(path.join(root, ".agentify", "runs"), { recursive: true });
  await fs.writeFile(path.join(root, ".agentify", "runs", "old.json"), "{}\n");
  await setOldMtime(path.join(root, ".agentify", "runs", "old.json"), 30);

  const config = await loadConfig(root, { provider: "local", dryRun: true });
  config.cleanup.maxRunAgeDays = 1;
  const result = await runClean(root, config);

  assert.equal(result.dry_run, true);
  assert.ok(result.removed_paths.includes(".agentify/runs/old.json"));
  assert.equal(await pathExists(path.join(root, ".agentify", "runs", "old.json")), true);
  assert.equal("removed_cache_blobs" in result, false);
});
