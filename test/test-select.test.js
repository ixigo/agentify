import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runScan } from "../src/core/commands.js";
import { loadConfig } from "../src/core/config.js";
import { buildTestSelection, renderTestSelection, runTestSelection } from "../src/core/test-select.js";

async function writeFile(root, filePath, text) {
  await fs.mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
  await fs.writeFile(path.join(root, filePath), text, "utf8");
}

async function withFixture(setup) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-select-"));
  await writeFile(
    root,
    "package.json",
    JSON.stringify({ name: "test-select-fixture", scripts: { test: "node --test" } }, null, 2)
  );
  await setup(root);
  const config = await loadConfig(root, { provider: "local", dryRun: false });
  config._suppressProgress = true;
  await runScan(root, config, { skipOutput: true, skipFinalize: true });
  return root;
}

async function coreFixture() {
  return withFixture(async (fixtureRoot) => {
    await writeFile(fixtureRoot, "src/core.ts", "export function core() { return true; }\n");
    await writeFile(
      fixtureRoot,
      "src/core.test.ts",
      "import { core } from './core';\nimport assert from 'node:assert/strict';\nassert.equal(core(), true);\n"
    );
    await writeFile(fixtureRoot, "src/other.ts", "export function other() { return 1; }\n");
    await writeFile(
      fixtureRoot,
      "src/other.test.ts",
      "import { other } from './other';\nimport assert from 'node:assert/strict';\nassert.equal(other(), 1);\n"
    );
  });
}

test("buildTestSelection picks only tests related to the changed files", async () => {
  const root = await coreFixture();

  const selection = await buildTestSelection(root, {
    changedFiles: [{ status: "M", path: "src/core.ts" }],
  });
  assert.ok(selection.indexed_test_count >= selection.selected_tests.length);

  const selectedPaths = selection.selected_tests.map((item) => item.path);
  assert.ok(selectedPaths.includes("src/core.test.ts"), `expected core.test.ts in ${selectedPaths}`);
  assert.ok(!selectedPaths.includes("src/other.test.ts"), "unrelated test should not be selected");

  assert.equal(selection.run_groups.length, 1);
  const group = selection.run_groups[0];
  // node --test scripts are invoked directly: appending file paths to
  // `npm run test` breaks when the script pins its own paths.
  assert.equal(group.command, "node");
  assert.deepEqual(group.args, ["--test", "src/core.test.ts"]);
  assert.equal(group.command_line, "node --test src/core.test.ts");

  const rendered = renderTestSelection(selection);
  assert.match(rendered, /src\/core\.test\.ts/);
});

test("buildTestSelection selects a changed test file directly and notes empty changes", async () => {
  const root = await coreFixture();

  const direct = await buildTestSelection(root, {
    changedFiles: [{ status: "M", path: "src/other.test.ts" }],
  });
  assert.ok(direct.selected_tests.some((item) => item.path === "src/other.test.ts" && item.reasons.includes("test file changed")));

  const empty = await buildTestSelection(root, { changedFiles: [] });
  assert.equal(empty.selected_tests.length, 0);
  assert.ok(empty.notes.some((note) => /No changed files/.test(note)));
});

test("runTestSelection runs each group and reports pass/fail", async () => {
  const root = await coreFixture();
  const selection = await buildTestSelection(root, {
    changedFiles: [{ status: "M", path: "src/core.ts" }],
  });

  const spawned = [];
  function fakeSpawn(command, args) {
    spawned.push({ command, args });
    const child = new EventEmitter();
    process.nextTick(() => child.emit("close", 0));
    return child;
  }

  const outcome = await runTestSelection(root, selection, { spawnImpl: fakeSpawn });
  assert.equal(outcome.passed, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "node");

  const { readValueEvents } = await import("../src/core/value-telemetry.js");
  const valueEvents = await readValueEvents(root);
  const focusedRun = valueEvents.find((event) => event.type === "focused_test_run");
  assert.ok(focusedRun, "expected focused_test_run value event");
  assert.equal(focusedRun.selected_test_files, selection.selected_tests.length);
  assert.equal(focusedRun.full_suite_files_avoided, selection.indexed_test_count - selection.selected_tests.length);

  function failingSpawn() {
    const child = new EventEmitter();
    process.nextTick(() => child.emit("close", 1));
    return child;
  }
  const failed = await runTestSelection(root, selection, { spawnImpl: failingSpawn });
  assert.equal(failed.passed, false);
});

test("scripts that are not node --test keep the package-runner invocation with appended filters", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-select-jest-"));
  await writeFile(
    root,
    "package.json",
    JSON.stringify({ name: "jest-fixture", scripts: { test: "jest --coverage" } }, null, 2)
  );
  await writeFile(root, "src/core.js", "export function core() { return true; }\n");
  await writeFile(
    root,
    "src/core.test.js",
    "import { core } from './core.js';\ntest('core', () => expect(core()).toBe(true));\n"
  );
  const config = await loadConfig(root, { provider: "local", dryRun: false });
  config._suppressProgress = true;
  await runScan(root, config, { skipOutput: true, skipFinalize: true });

  const selection = await buildTestSelection(root, {
    changedFiles: [{ status: "M", path: "src/core.js" }],
  });
  const group = selection.run_groups.find((item) => item.command);
  assert.ok(group, "expected a runnable group");
  assert.notEqual(group.command, "node");
  assert.ok(group.args.includes("src/core.test.js"));
});

test("node --test scripts with pinned paths produce a working direct invocation", async () => {
  // Regression: `npm run test -- <files>` on a script like `node --test test/`
  // made node treat `test/` plus the appended file as separate entry points
  // and crash. The selection must bypass npm and call node --test directly.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-select-pinned-"));
  await writeFile(
    root,
    "package.json",
    JSON.stringify({ name: "pinned-fixture", type: "module", scripts: { test: "node --test test/" } }, null, 2)
  );
  await writeFile(root, "src/core.js", "export function core() { return true; }\n");
  await writeFile(
    root,
    "test/core.test.js",
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { core } from '../src/core.js';\ntest('core', () => assert.equal(core(), true));\n"
  );
  const config = await loadConfig(root, { provider: "local", dryRun: false });
  config._suppressProgress = true;
  await runScan(root, config, { skipOutput: true, skipFinalize: true });

  const selection = await buildTestSelection(root, {
    changedFiles: [{ status: "M", path: "src/core.js" }],
  });
  const group = selection.run_groups.find((item) => item.command);
  assert.ok(group, "expected a runnable group");
  assert.equal(group.command, "node");
  assert.deepEqual(group.args, ["--test", "test/core.test.js"]);

  // And it actually runs green.
  const outcome = await runTestSelection(root, selection, { stdio: "ignore" });
  assert.equal(outcome.passed, true, JSON.stringify(outcome.results));
});
