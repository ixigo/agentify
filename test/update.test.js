import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { runScan, runDoc } from "../src/core/commands.js";
import { validateRepo } from "../src/core/validate.js";

test("scan and doc generate required artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-update-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "auth", "index.ts"), "export const login = () => true;\n");

  const config = await loadConfig(root, { provider: "local", dryRun: false, tokenReport: true });
  await runScan(root, config);
  await runDoc(root, config);
  const result = await validateRepo(root, config);

  assert.equal(result.passed, true);
  assert.equal(await fs.stat(path.join(root, ".agents", "index.json")).then(() => true), true);
  assert.equal(await fs.stat(path.join(root, "docs", "modules", "auth.md")).then(() => true), true);
  assert.equal(await fs.stat(path.join(root, "AGENTIFY.md")).then(() => true), true);
  const summary = await fs.readFile(path.join(root, "AGENTIFY.md"), "utf8");
  assert.match(summary, /# AGENTIFY\.md/);
  assert.match(summary, /## Run Metrics/);
});
