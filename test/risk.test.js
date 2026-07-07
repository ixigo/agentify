import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runScan } from "../src/core/commands.js";
import { loadConfig } from "../src/core/config.js";
import { closeIndexDatabase, openIndexDatabase } from "../src/core/db/connection.js";
import { buildRiskReport } from "../src/core/risk.js";
import { runCli } from "../src/main.js";

const execFileAsync = promisify(execFile);

async function writeFile(root, filePath, text) {
  await fs.mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
  await fs.writeFile(path.join(root, filePath), text, "utf8");
}

async function withFixture(setup) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-risk-"));
  await writeFile(
    root,
    "package.json",
    JSON.stringify({ name: "risk-fixture", scripts: { test: "node --test" } }, null, 2)
  );
  await setup(root);
  const config = await loadConfig(root, { provider: "local", dryRun: false });
  config._suppressProgress = true;
  await runScan(root, config, { skipOutput: true, skipFinalize: true });
  return root;
}

test("buildRiskReport marks shared dependency changes high risk and prioritizes module tests", async () => {
  const root = await withFixture(async (fixtureRoot) => {
    await writeFile(fixtureRoot, "src/core.ts", "export function core() { return true; }\n");
    for (const name of ["alpha", "beta", "gamma", "delta"]) {
      await writeFile(
        fixtureRoot,
        `src/${name}.ts`,
        "import { core } from './core';\nexport function run() { return core(); }\n"
      );
    }
    await writeFile(
      fixtureRoot,
      "src/core.test.ts",
      "import { core } from './core';\nimport assert from 'node:assert/strict';\nassert.equal(core(), true);\n"
    );
  });

  const report = await buildRiskReport(root, {
    changedFiles: [{ status: "M", path: "src/core.ts" }],
  });

  assert.equal(report.risk.level, "high");
  assert.ok(report.risk.score >= 70);
  assert.ok(report.impacted.files.some((fileInfo) => fileInfo.path === "src/alpha.ts" && fileInfo.distance === 1));
  assert.ok(report.impacted.modules.some((moduleInfo) => moduleInfo.impacted_files.includes("src/core.ts")));
  assert.ok(report.impacted.symbols.some((symbolInfo) => symbolInfo.name === "core"));
  assert.ok(report.prioritized_test_commands.some((commandInfo) => commandInfo.command_line === "npm run test"));
});

test("buildRiskReport keeps unresolved structural imports in impact graph", async () => {
  const root = await withFixture(async (fixtureRoot) => {
    await writeFile(fixtureRoot, "src/domain.ts", "export function domain() { return true; }\n");
    await writeFile(fixtureRoot, "src/runtime.ts", "import { domain } from './domain';\nexport const value = domain();\n");
  });
  const db = openIndexDatabase(root);
  try {
    db.prepare("UPDATE imports SET to_path = NULL, to_module_id = NULL WHERE from_path = ?").run("src/runtime.ts");
  } finally {
    closeIndexDatabase(db);
  }

  const report = await buildRiskReport(root, {
    changedFiles: [{ status: "D", path: "src/domain.ts" }],
  });

  assert.ok(report.impacted.files.some((fileInfo) => fileInfo.path === "src/runtime.ts" && fileInfo.distance === 1));

  const renameReport = await buildRiskReport(root, {
    changedFiles: [{ status: "R", path: "src/domain-v2.ts", origPath: "src/domain.ts" }],
  });

  assert.ok(renameReport.impacted.files.some((fileInfo) => fileInfo.path === "src/runtime.ts" && fileInfo.distance === 1));
});

test("buildRiskReport keeps isolated test-only changes low risk", async () => {
  const root = await withFixture(async (fixtureRoot) => {
    await writeFile(fixtureRoot, "src/core.ts", "export function core() { return true; }\n");
    await writeFile(
      fixtureRoot,
      "src/core.test.ts",
      "import { core } from './core';\nimport assert from 'node:assert/strict';\nassert.equal(core(), true);\n"
    );
  });

  const report = await buildRiskReport(root, {
    changedFiles: [{ status: "M", path: "src/core.test.ts" }],
  });

  assert.equal(report.risk.level, "low");
  assert.ok(report.risk.score < 35);
  assert.deepEqual(report.impacted.files.map((fileInfo) => fileInfo.path), ["src/core.test.ts"]);
});

test("runCli risk --json emits a stable machine-readable report", async () => {
  const root = await withFixture(async (fixtureRoot) => {
    await writeFile(fixtureRoot, "src/core.ts", "export function core() { return true; }\n");
  });
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
  await writeFile(root, "src/core.ts", "export function core() { return false; }\n");

  const output = [];
  const originalLog = console.log;
  console.log = (...args) => {
    output.push(args.join(" "));
  };

  try {
    await runCli(["risk", "--root", root, "--json"]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(output.length, 1);
  const payload = JSON.parse(output[0]);
  assert.equal(payload.schema_version, "risk-v1");
  assert.equal(payload.command, "risk");
  assert.equal(payload.changed_files[0].path, "src/core.ts");
  assert.ok(Array.isArray(payload.prioritized_test_commands));
});

test("runCli risk rejects --since without a non-blank value", async () => {
  for (const argv of [
    ["risk", "--since"],
    ["risk", "--since", "--json"],
    ["risk", "--since", ""],
    ["risk", "--since=   "],
  ]) {
    await assert.rejects(
      () => runCli(argv),
      /risk --since requires a commit or ref value/,
    );
  }
});
