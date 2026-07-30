// Zero-install conformance suite for `agentify git analyze` — the gate for epic
// #347. Each `test()` below asserts one row of the epic's contract. See
// test/helpers/pristine-repo.js for the harness rationale.
//
// The premise under test: a stranger runs this command on a machine where
// nothing is installed and nothing will be. This repo has Agentify installed, a
// config, an index, a store, and every CLI on PATH — so this suite deliberately
// runs the real CLI inside a sealed sandbox (temp HOME/XDG_CACHE_HOME, a minimal
// PATH with a git argv spy and a provider-spawn spy, a pinned TZ, a planted
// secret) against a pristine fixture repo that has NONE of the install
// footprint.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createPristineRepo,
  createSandbox,
  runAnalyzeCli,
  snapshotTree,
  diffSnapshots,
  findGitViolations,
  gitSubcommand,
} from "./helpers/pristine-repo.js";

// Every window form the frozen surface accepts, exercised in one place so row 1
// covers the whole matrix.
const WINDOW_FORMS = [
  ["--days", "30"],
  ["--months", "3"],
  ["--quarter", "2", "--year", "2026"],
  ["--year", "2026"],
  ["--since", "2026-05-01", "--until", "2026-07-29"],
];

test("row 1: runs to completion in a repo with no Agentify install, for every window form", async () => {
  const repo = await createPristineRepo();
  const sandbox = await createSandbox();
  try {
    for (const form of WINDOW_FORMS) {
      const result = await runAnalyzeCli(sandbox, repo.root, [...form, "--format", "json"]);
      assert.equal(result.code, 0, `window ${form.join(" ")} exited ${result.code}\n${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.equal(report.command, "git analyze");
      assert.equal(report.schema_version, 5);
    }
  } finally {
    await sandbox.cleanup();
    await repo.cleanup();
  }
});
