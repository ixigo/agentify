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

test("runClean prunes orphaned Agentify artifacts and stale folders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-clean-"));
  await fs.mkdir(path.join(root, "docs", "modules"), { recursive: true });
  await fs.mkdir(path.join(root, ".agents", "modules"), { recursive: true });
  await fs.mkdir(path.join(root, ".agents", "runs"), { recursive: true });
  await fs.mkdir(path.join(root, ".agents", "session", "broken"), { recursive: true });
  await fs.mkdir(path.join(root, ".current_session", "ghost_old"), { recursive: true });
  await fs.mkdir(path.join(root, ".current_session", "ghost_keep"), { recursive: true });

  await fs.writeFile(path.join(root, ".agents", "index.json"), JSON.stringify({
    modules: [
      {
        doc_path: "docs/modules/auth.md",
        metadata_path: ".agents/modules/auth.json"
      }
    ]
  }, null, 2));
  await fs.writeFile(path.join(root, "docs", "modules", "auth.md"), "# auth\n");
  await fs.writeFile(path.join(root, "docs", "modules", "dead.md"), "# dead\n");
  await fs.writeFile(path.join(root, ".agents", "modules", "auth.json"), "{}\n");
  await fs.writeFile(path.join(root, ".agents", "modules", "dead.json"), "{}\n");
  await fs.writeFile(path.join(root, ".agents", "runs", "keep.json"), "{}\n");
  await fs.writeFile(path.join(root, ".agents", "runs", "old.json"), "{}\n");
  await fs.writeFile(path.join(root, ".current_session", "ghost_old", "ghost-report.json"), "{}\n");
  await fs.writeFile(path.join(root, ".current_session", "ghost_keep", "ghost-report.json"), "{}\n");

  await setOldMtime(path.join(root, ".agents", "runs", "old.json"), 10);
  await setOldMtime(path.join(root, ".current_session", "ghost_old"), 10);

  const config = await loadConfig(root, { provider: "local" });
  config.cleanup.keepRuns = 1;
  config.cleanup.maxRunAgeDays = 1;
  config.cleanup.keepGhostRuns = 1;
  config.cleanup.maxGhostAgeDays = 1;

  const result = await runClean(root, config);

  assert.ok(result.removed_paths.includes("docs/modules/dead.md"));
  assert.ok(result.removed_paths.includes(".agents/modules/dead.json"));
  assert.ok(result.removed_paths.includes(".agents/runs/old.json"));
  assert.ok(result.removed_paths.includes(".current_session/ghost_old"));
  assert.ok(result.removed_paths.includes(".agents/session/broken"));

  assert.equal(await fs.stat(path.join(root, "docs", "modules", "dead.md")).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(path.join(root, ".agents", "modules", "dead.json")).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(path.join(root, ".agents", "runs", "old.json")).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(path.join(root, ".current_session", "ghost_old")).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(path.join(root, ".agents", "session", "broken")).then(() => true).catch(() => false), false);

  assert.equal(await fs.stat(path.join(root, "docs", "modules", "auth.md")).then(() => true), true);
  assert.equal(await fs.stat(path.join(root, ".agents", "modules", "auth.json")).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(path.join(root, ".agents", "runs", "keep.json")).then(() => true), true);
  assert.equal(await fs.stat(path.join(root, ".current_session", "ghost_keep")).then(() => true), true);
});

test("runClean dry-run reports removals without deleting files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-clean-dry-"));
  await fs.mkdir(path.join(root, "docs", "modules"), { recursive: true });
  await fs.mkdir(path.join(root, ".agents", "modules"), { recursive: true });
  await fs.mkdir(path.join(root, ".agents", "cache", "blobs", "aa"), { recursive: true });

  await fs.writeFile(path.join(root, ".agents", "index.json"), JSON.stringify({
    modules: []
  }, null, 2));
  await fs.writeFile(path.join(root, "docs", "modules", "dead.md"), "# dead\n");
  await fs.writeFile(path.join(root, ".agents", "modules", "dead.json"), "{}\n");
  await fs.writeFile(path.join(root, ".agents", "cache", "blobs", "aa", "aa.blob"), "blob\n");
  await fs.writeFile(path.join(root, ".agents", "cache", "manifest.json"), JSON.stringify({
    modules: {
      stale: {
        blobs: ["aa"],
        updated_at: new Date(Date.now() - (10 * 86400000)).toISOString()
      }
    }
  }, null, 2));

  const config = await loadConfig(root, { provider: "local", dryRun: true });
  const result = await runClean(root, config);

  assert.ok(result.removed_paths.includes("docs/modules/dead.md"));
  assert.ok(result.removed_paths.includes(".agents/modules/dead.json"));
  assert.equal(result.removed_cache_blobs, 1);
  assert.equal(await fs.stat(path.join(root, "docs", "modules", "dead.md")).then(() => true), true);
  assert.equal(await fs.stat(path.join(root, ".agents", "modules", "dead.json")).then(() => true), true);
  assert.equal(await fs.stat(path.join(root, ".agents", "cache", "blobs", "aa", "aa.blob")).then(() => true), true);
});
