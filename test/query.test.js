import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runScan } from "../src/core/commands.js";
import { loadConfig } from "../src/core/config.js";
import { queryChanged, queryOwner, querySearch } from "../src/core/query.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

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

test("query owner and changed files use src fallback module for root TS app files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-query-ts-src-root-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src", "components"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "pages"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "App.tsx"), "export function App() { return null; }\n", "utf8");
  await fs.writeFile(path.join(root, "src", "main.tsx"), "import { App } from './App';\nexport { App };\n", "utf8");
  await fs.writeFile(path.join(root, "src", "components", "Button.tsx"), "export function Button() { return null; }\n", "utf8");
  await fs.writeFile(path.join(root, "src", "pages", "Home.tsx"), "export function Home() { return null; }\n", "utf8");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "local", dryRun: false });
  await runScan(root, config);

  const appOwner = await queryOwner(root, "src/App.tsx");
  const mainOwner = await queryOwner(root, "src/main.tsx");
  const componentOwner = await queryOwner(root, "src/components/Button.tsx");

  assert.equal(appOwner.module_id, "src");
  assert.equal(appOwner.module_root, "src");
  assert.equal(mainOwner.module_id, "src");
  assert.equal(componentOwner.module_id, "components");
  assert.equal(componentOwner.module_root, "src/components");

  const { stdout: baseCommit } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  await fs.appendFile(path.join(root, "src", "App.tsx"), "export const changed = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/App.tsx"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "change app entry"], { cwd: root });
  const changed = await queryChanged(root, baseCommit.trim());

  assert.deepEqual(changed.affected_modules, [{
    module_id: "src",
    module_name: "src",
    changed_files: [{
      status: "M",
      path: "src/App.tsx",
    }],
  }]);
});
