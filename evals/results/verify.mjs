#!/usr/bin/env node
// Verify (or regenerate) the committed benchmark receipts under evals/results/.
//
// Every published benchmark number must be reproducible from the committed
// raw run artifacts by the current report code. This script rebuilds each
// run's report from its committed run dir in an isolated temp store and
// compares it against the committed report.json:
//
//   node evals/results/verify.mjs           # verify: exit 1 on any mismatch
//   node evals/results/verify.mjs --write   # regenerate report.json files
//
// A mismatch means the report/statistics code now computes different numbers
// than the ones published from these runs — either fix the regression or
// regenerate the receipts with --write in the same change that alters the
// math, so the published numbers and the code never drift apart silently.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { buildEvalReport } from "../../src/core/eval-report.js";

const RESULTS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const WRITE = process.argv.includes("--write");

async function listRunDirs() {
  const out = [];
  for (const entry of await fs.readdir(RESULTS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runsRoot = path.join(RESULTS_ROOT, entry.name, "runs");
    let runs;
    try {
      runs = await fs.readdir(runsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const run of runs) {
      if (run.isDirectory()) out.push({ dataset: entry.name, runId: run.name, runDir: path.join(runsRoot, run.name) });
    }
  }
  return out.sort((a, b) => a.runId.localeCompare(b.runId));
}

// Rebuild one run's report inside a fresh temp store so nothing on the host
// (a real .agentify store, other runs) can leak into the receipt.
async function rebuildReport({ runId, runDir }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-receipts-"));
  try {
    const storeRun = path.join(root, ".agentify", "evals", "runs", runId);
    await fs.mkdir(path.dirname(storeRun), { recursive: true });
    await fs.cp(runDir, storeRun, { recursive: true });
    return await buildEvalReport(root, {}, runId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const runs = await listRunDirs();
if (runs.length === 0) {
  console.error("no committed run dirs found under evals/results/*/runs/");
  process.exit(1);
}

let failures = 0;
for (const run of runs) {
  const reportPath = path.join(path.dirname(path.dirname(run.runDir)), "reports", `${run.runId}.report.json`);
  const rebuilt = await rebuildReport(run);
  if (WRITE) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(rebuilt, null, 2)}\n`);
    console.log(`wrote ${path.relative(RESULTS_ROOT, reportPath)}`);
    continue;
  }
  let committed;
  try {
    committed = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch {
    console.error(`MISSING receipt: ${path.relative(RESULTS_ROOT, reportPath)} (regenerate with --write)`);
    failures += 1;
    continue;
  }
  if (isDeepStrictEqual(rebuilt, committed)) {
    console.log(`ok ${run.dataset}/${run.runId}`);
  } else {
    console.error(`MISMATCH ${run.dataset}/${run.runId}: current report code no longer reproduces the committed receipt`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`\n${failures} receipt(s) failed verification.`);
  process.exit(1);
}
console.log(WRITE ? `\nwrote ${runs.length} receipt(s).` : `\nall ${runs.length} receipts reproducible.`);
