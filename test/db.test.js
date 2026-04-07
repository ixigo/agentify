import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runScan } from "../src/core/commands.js";
import { loadConfig } from "../src/core/config.js";
import { closeIndexDatabase, openIndexDatabase } from "../src/core/db.js";

function octalMode(stats) {
  return (stats.mode & 0o777).toString(8);
}

test("openIndexDatabase read-only snapshots use user-only permissions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-db-readonly-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "station.ts"),
    "export function findMetroStation(query) { return query.trim(); }\n",
    "utf8",
  );

  const config = await loadConfig(root, { provider: "local", dryRun: false });
  await runScan(root, config);

  const db = openIndexDatabase(root, { readOnly: true });
  const tempDir = db.__agentifyTempDir;
  const snapshotPath = path.join(tempDir, "index.db");

  try {
    assert.equal(octalMode(await fs.stat(tempDir)), "700");
    assert.equal(octalMode(await fs.stat(snapshotPath)), "600");

    for (const suffix of ["-wal", "-shm"]) {
      const sidecarPath = `${snapshotPath}${suffix}`;
      const exists = await fs.access(sidecarPath).then(() => true).catch(() => false);
      if (exists) {
        assert.equal(octalMode(await fs.stat(sidecarPath)), "600");
      }
    }
  } finally {
    closeIndexDatabase(db);
  }

  await assert.rejects(() => fs.access(tempDir));
});
