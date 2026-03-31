import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runScan } from "../src/core/commands.js";
import { loadConfig } from "../src/core/config.js";
import { querySearch } from "../src/core/query.js";

test("querySearch reads an existing index when the database is read-only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-query-readonly-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "station.ts"),
    "export function findMetroStation(query) { return query.trim(); }\n",
    "utf8",
  );

  const config = await loadConfig(root, { provider: "local", dryRun: false });
  await runScan(root, config);

  const dbPath = path.join(root, ".agents", "index.db");
  const dbDir = path.join(root, ".agents");
  await fs.chmod(dbPath, 0o444);
  await fs.chmod(dbDir, 0o555);

  try {
    const result = await querySearch(root, "station");
    assert.ok(result.files.some((fileInfo) => fileInfo.path === "src/station.ts"));
  } finally {
    await fs.chmod(dbDir, 0o755);
    await fs.chmod(dbPath, 0o644);
  }
});
