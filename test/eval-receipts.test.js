// Committed benchmark receipts (evals/results/) must stay reproducible: every
// published number is backed by a raw run dir plus a report.json that the
// CURRENT report code regenerates exactly. If a change to the statistics or
// report shape alters what these runs compute, this test fails — update the
// receipts with `node evals/results/verify.mjs --write` in the same change,
// so published numbers and code never drift apart silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsRoot = path.join(repoRoot, "evals", "results");

test("committed benchmark receipts are reproducible by current report code", () => {
  const result = spawnSync(process.execPath, [path.join(resultsRoot, "verify.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `verify.mjs failed (regenerate with --write if a report-code change is intentional):\n${result.stdout}\n${result.stderr}`,
  );
});

test("every committed run dir has a receipt and labeled harness provenance", () => {
  const datasets = fs
    .readdirSync(resultsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(datasets.length > 0, "no result datasets committed");
  let runCount = 0;
  for (const dataset of datasets) {
    const runsRoot = path.join(resultsRoot, dataset, "runs");
    if (!fs.existsSync(runsRoot)) continue;
    for (const runId of fs.readdirSync(runsRoot)) {
      runCount += 1;
      const reportPath = path.join(resultsRoot, dataset, "reports", `${runId}.report.json`);
      assert.ok(fs.existsSync(reportPath), `missing receipt for ${dataset}/${runId}`);
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      assert.equal(report.run_id, runId);
      // Provenance must ride along so cross-harness numbers are never mixed
      // silently (per the #298 decision).
      assert.ok(typeof report.harness === "string" && report.harness.length > 0, `unlabeled harness in ${dataset}/${runId}`);
    }
  }
  assert.ok(runCount > 0, "no committed run dirs found");
});
