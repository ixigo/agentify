#!/usr/bin/env node
// Injection-format campaign (#400): per-arm pass rates with Wilson 95% CIs and
// the pre-registered paired two-sided sign test over discordant pairs, computed
// from the committed run dirs in this directory. Reproducible receipt math:
// everything here reads only runs/*/run.json + attempts/*/result.json and reuses
// the same statistics the report code ships (wilsonInterval, signTestPValue,
// isGradeableAttempt) so these numbers cannot drift from campaign.json.
//
//   node evals/results/harbor-20261125-injection-format/analysis.mjs
//   node .../analysis.mjs --json
//
// Pairing is by (task, repeat_index): attempts are paired only within the same
// task and repeat, then discordant counts pool across tasks. Non-gradeable
// attempts (status invalid/error) are excluded from every arm and pair, exactly
// as armMetrics/discordantPairs do in eval-report.js.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isGradeableAttempt,
  signTestPValue,
  wilsonInterval,
} from "../../../src/core/eval-report.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(HERE, "runs");
const JSON_OUT = process.argv.includes("--json");

// Baseline first; the pre-registered comparisons fan out from it.
const ARM_ORDER = ["agentify", "fullnote-claude", "persist-claude", "memorybank-claude"];
// Every pre-registered pair (left vs right). The report natively pairs
// agentify-vs-each; the last two are the "does the best format reach the
// ceiling" pairs the report does not emit, computed here from the same runs.
const PAIRS = [
  ["agentify", "memorybank-claude"],
  ["fullnote-claude", "memorybank-claude"],
  ["persist-claude", "memorybank-claude"],
  ["agentify", "fullnote-claude"],
  ["agentify", "persist-claude"],
];

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

// runs -> [{ task, byArm: Map<arm, Map<repeat_index, record>> }]
async function loadRuns() {
  const runs = [];
  let entries;
  try {
    entries = (await fs.readdir(RUNS_ROOT, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch {
    return runs;
  }
  for (const entry of entries) {
    const runDir = path.join(RUNS_ROOT, entry.name);
    const meta = await readJson(path.join(runDir, "run.json"));
    const task = meta.plan?.task?.id || entry.name;
    const byArm = new Map();
    for (const order of meta.plan?.order || []) {
      let record;
      try {
        record = await readJson(path.join(runDir, "attempts", order.attempt_id, "result.json"));
      } catch {
        continue;
      }
      const arm = String(record.arm || order.arm);
      if (!byArm.has(arm)) byArm.set(arm, new Map());
      byArm.get(arm).set(record.repeat_index, record);
    }
    runs.push({ task, byArm });
  }
  return runs.sort((a, b) => a.task.localeCompare(b.task));
}

function armTotals(runs, arm, taskFilter = null) {
  let passes = 0;
  let attempts = 0;
  for (const run of runs) {
    if (taskFilter && run.task !== taskFilter) continue;
    for (const record of (run.byArm.get(arm) || new Map()).values()) {
      if (!isGradeableAttempt(record)) continue;
      attempts += 1;
      if (record.pass) passes += 1;
    }
  }
  return { passes, attempts };
}

// Discordant split for left vs right, pooled over tasks (pairs within task by
// repeat_index). Returns { pairs, leftWins, rightWins }.
function discordant(runs, left, right, taskFilter = null) {
  let pairs = 0;
  let leftWins = 0;
  let rightWins = 0;
  for (const run of runs) {
    if (taskFilter && run.task !== taskFilter) continue;
    const l = run.byArm.get(left) || new Map();
    const r = run.byArm.get(right) || new Map();
    for (const [idx, lr] of l) {
      const rr = r.get(idx);
      if (!rr) continue;
      if (!isGradeableAttempt(lr) || !isGradeableAttempt(rr)) continue;
      pairs += 1;
      if (lr.pass && !rr.pass) leftWins += 1;
      else if (!lr.pass && rr.pass) rightWins += 1;
    }
  }
  return { pairs, leftWins, rightWins };
}

function fmtWilson(passes, attempts) {
  const w = wilsonInterval(passes, attempts);
  if (!w) return "—";
  return `${(w.low * 100).toFixed(1)}–${(w.high * 100).toFixed(1)}%`;
}

function nonGradeableByStatus(runs) {
  const counts = {};
  for (const run of runs) {
    for (const byRepeat of run.byArm.values()) {
      for (const record of byRepeat.values()) {
        if (isGradeableAttempt(record)) continue;
        counts[record.status] = (counts[record.status] || 0) + 1;
      }
    }
  }
  return counts;
}

const runs = await loadRuns();
if (runs.length === 0) {
  console.error(`no runs under ${path.relative(process.cwd(), RUNS_ROOT)} — import the jobs first`);
  process.exit(1);
}
const tasks = [...new Set(runs.map((r) => r.task))].sort();

const report = { tasks, scopes: {}, non_gradeable: nonGradeableByStatus(runs) };

function buildScope(label, taskFilter) {
  const arms = {};
  for (const arm of ARM_ORDER) {
    const { passes, attempts } = armTotals(runs, arm, taskFilter);
    if (attempts === 0 && !runs.some((r) => r.byArm.has(arm))) continue;
    const w = wilsonInterval(passes, attempts);
    arms[arm] = { passes, attempts, pass_rate: attempts ? passes / attempts : null, wilson: w };
  }
  const comparisons = [];
  for (const [left, right] of PAIRS) {
    if (!arms[left] || !arms[right]) continue;
    const d = discordant(runs, left, right, taskFilter);
    comparisons.push({
      left, right,
      pairs: d.pairs,
      discordant: `${d.leftWins}/${d.rightWins}`,
      left_wins: d.leftWins,
      right_wins: d.rightWins,
      sign_test_p: signTestPValue(d.leftWins, d.rightWins),
    });
  }
  return { label, taskFilter, arms, comparisons };
}

report.scopes.pooled = buildScope("pooled (all tasks)", null);
for (const task of tasks) report.scopes[task] = buildScope(task, task);

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const ng = Object.entries(report.non_gradeable);
  console.log(`# Injection-format analysis (#400)\n`);
  console.log(`Tasks: ${tasks.join(", ")}`);
  console.log(`Non-gradeable (excluded): ${ng.length ? ng.map(([k, v]) => `${k}=${v}`).join(", ") : "none"}\n`);
  for (const key of ["pooled", ...tasks]) {
    const scope = report.scopes[key];
    if (!scope) continue;
    console.log(`## ${scope.label}\n`);
    console.log(`| arm | pass | rate | Wilson 95% |`);
    console.log(`| --- | --- | --- | --- |`);
    for (const arm of ARM_ORDER) {
      const a = scope.arms[arm];
      if (!a) continue;
      console.log(`| ${arm} | ${a.passes}/${a.attempts} | ${a.pass_rate === null ? "—" : (a.pass_rate * 100).toFixed(1) + "%"} | ${fmtWilson(a.passes, a.attempts)} |`);
    }
    console.log(`\n| comparison (left vs right) | pairs | discordant L/R | sign-test p |`);
    console.log(`| --- | --- | --- | --- |`);
    for (const c of scope.comparisons) {
      console.log(`| ${c.left} vs ${c.right} | ${c.pairs} | ${c.discordant} | ${c.sign_test_p} |`);
    }
    console.log("");
  }
}
