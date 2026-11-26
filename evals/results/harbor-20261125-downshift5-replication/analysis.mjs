#!/usr/bin/env node
// Five-family downshift REPLICATION (#322 rule) on agentify v0.5.0.
//
// This campaign contains THREE full 180-trial runs of the identical
// pre-registered downshift suite (same agentify v0.5.0, dataset 1.2.0,
// subscription OAuth). They exist because `harbor job resume` re-runs the WHOLE
// suite fresh rather than only the errored trials (see DEVIATIONS.md D7):
//   A  2026-11-25__18-19-12  original run (conc 2); 25 install host-faults
//   B  2026-11-25__23-05-12  resume #1 (conc 2);    25 install host-faults
//   C  2026-11-26__12-18-47  resume #2 (conc 1);    0 host-faults  <-- PRIMARY
// PRIMARY = C by the completeness rule (the only run where all 180 pre-registered
// trials are gradeable). The rule was fixed AFTER the runs (DEVIATIONS.md D7);
// it is outcome-independent (data completeness, not pass counts / p), and the
// verdict is identical across A, B and C, so the choice cannot change it.
//
// Every number here is recomputed from the committed run dirs, side by side
// with the 2026-08-21 campaign's committed runs, reusing the same statistics
// the report code ships (isGradeableAttempt, signTestPValue, wilsonInterval).
//
//   node evals/results/harbor-20261125-downshift5-replication/analysis.mjs
//   node .../analysis.mjs --json
//
// Pairing is by (task, model, repeat_index): a Harbor run bundles both arms of
// ONE (task, model) cell, so pairing within a run by repeat_index pins
// task+model. The pooled suite verdict and per-cell figures are over MATCHED
// gradeable pairs (the tool's #322 denominator). Arm totals (all gradeable
// attempts) are shown too, to reconcile with campaign.json published aggregates.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isGradeableAttempt,
  signTestPValue,
  wilsonInterval,
} from "../../../src/core/eval-report.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOV_RUNS = path.join(HERE, "runs");
const AUG_RUNS = path.join(HERE, "..", "harbor-20260821-downshift5", "runs");
const JSON_OUT = process.argv.includes("--json");

const PRIMARY_JOB = "2026-11-26__12-18-47";
const JOB_LABEL = {
  "2026-11-25__18-19-12": "A original (conc 2)",
  "2026-11-25__23-05-12": "B resume#1 (conc 2)",
  "2026-11-26__12-18-47": "C resume#2 (conc 1) PRIMARY",
};
const DIFFICULTY_ORDER = { easy: 0, medium: 1, hard: 2 };
const taskFamily = (t) => String(t ?? "").replace(/-(medium|hard|store\d+)$/, "");

async function readJson(p) { return JSON.parse(await fs.readFile(p, "utf8")); }

// Load every run under a root, tagging each with its harbor job.
async function loadRuns(runsRoot) {
  const runs = [];
  let entries;
  try { entries = (await fs.readdir(runsRoot, { withFileTypes: true })).filter((e) => e.isDirectory()); }
  catch { return runs; }
  for (const entry of entries) {
    const runDir = path.join(runsRoot, entry.name);
    const meta = await readJson(path.join(runDir, "run.json"));
    const task = meta.plan?.task || {};
    const job = meta.harbor?.job || "unknown";
    const byArm = new Map();
    for (const order of meta.plan?.order || []) {
      let record;
      try { record = await readJson(path.join(runDir, "attempts", order.attempt_id, "result.json")); }
      catch { continue; }
      const arm = String(record.arm || order.arm);
      if (!byArm.has(arm)) byArm.set(arm, new Map());
      byArm.get(arm).set(record.repeat_index, record);
    }
    runs.push({ job, task: task.id, model: task.model, difficulty: task.difficulty, family: taskFamily(task.id), byArm });
  }
  return runs;
}

// Paired pool over matched gradeable pairs + full arm totals, within a filter.
function stats(runs, filter = () => true) {
  let pairs = 0, agPairPass = 0, blPairPass = 0, left = 0, right = 0;
  let agAtt = 0, agPass = 0, blAtt = 0, blPass = 0, ngAg = 0, ngBl = 0;
  const fams = new Set();
  for (const run of runs) {
    if (!filter(run)) continue;
    const l = run.byArm.get("agentify") || new Map();
    const r = run.byArm.get("claude-code") || new Map();
    for (const rec of l.values()) { if (isGradeableAttempt(rec)) { agAtt++; if (rec.pass) agPass++; } else ngAg++; }
    for (const rec of r.values()) { if (isGradeableAttempt(rec)) { blAtt++; if (rec.pass) blPass++; } else ngBl++; }
    for (const [idx, lr] of l) {
      const rr = r.get(idx); if (!rr) continue;
      if (!isGradeableAttempt(lr) || !isGradeableAttempt(rr)) continue;
      pairs++; if (lr.pass) agPairPass++; if (rr.pass) blPairPass++;
      if (lr.pass && !rr.pass) { left++; fams.add(run.family); }
      else if (!lr.pass && rr.pass) right++;
    }
  }
  return { pairs, agPairPass, blPairPass, left, right, fams,
    armAg: { passes: agPass, attempts: agAtt }, armBl: { passes: blPass, attempts: blAtt }, ngAg, ngBl };
}

// Pre-registered three-clause #322 winner rule (fail-closed), over matched pairs.
function verdict(runs, filter) {
  const s = stats(runs, filter);
  const wAg = wilsonInterval(s.agPairPass, s.pairs);
  const wBl = wilsonInterval(s.blPairPass, s.pairs);
  const p = signTestPValue(s.left, s.right);
  const c1 = s.left >= 5 && s.fams.size >= 2 && s.left > s.right;
  const c2 = p < 0.05;
  const c3 = Boolean(wAg && wBl && wAg.low > wBl.high);
  return { s, wAg, wBl, p, c1, c2, c3, winner: c1 && c2 && c3 };
}

const nov = await loadRuns(NOV_RUNS);
const aug = await loadRuns(AUG_RUNS);
if (nov.length === 0) { console.error(`no runs under ${NOV_RUNS}`); process.exit(1); }
const jobs = [...new Set(nov.map((r) => r.job))].sort();

function scopeObj(runs, filter) {
  const v = verdict(runs, filter);
  return {
    pairs: v.s.pairs,
    agentify_pairs: `${v.s.agPairPass}/${v.s.pairs}`,
    claude_code_pairs: `${v.s.blPairPass}/${v.s.pairs}`,
    agentify_wilson: v.wAg, claude_code_wilson: v.wBl,
    arm_totals: { agentify: v.s.armAg, claude_code: v.s.armBl },
    non_gradeable: { agentify: v.s.ngAg, claude_code: v.s.ngBl },
    discordant: `${v.s.left}/${v.s.right}`,
    families_spanned: [...v.s.fams].sort(),
    sign_test_p: v.p,
    clauses: { c1_5plus_2fam: v.c1, c2_sign_p: v.c2, c3_wilson_sep: v.c3 },
    winner_agentify: v.winner,
  };
}

const report = { primary_job: PRIMARY_JOB, runs: {}, august: scopeObj(aug, () => true) };
for (const job of jobs) report.runs[job] = { label: JOB_LABEL[job] || job, ...scopeObj(nov, (r) => r.job === job) };

// Per-family and per-cell: for the PRIMARY run only (plus August per-family).
const prim = (r) => r.job === PRIMARY_JOB;
const families = [...new Set(nov.filter(prim).map((r) => r.family))].sort();
report.primary_by_family = {};
for (const f of families) {
  const n = verdict(nov, (r) => prim(r) && r.family === f);
  const a = verdict(aug, (r) => r.family === f);
  report.primary_by_family[f] = { aug: `${a.s.left}/${a.s.right}`, aug_p: a.p, nov: `${n.s.left}/${n.s.right}`, nov_p: n.p };
}
const models = [...new Set(nov.filter(prim).map((r) => r.model))].sort();
const diffs = [...new Set(nov.filter(prim).map((r) => r.difficulty))].sort((x, y) => (DIFFICULTY_ORDER[x] ?? 9) - (DIFFICULTY_ORDER[y] ?? 9));
report.primary_by_cell = {};
for (const m of models) for (const d of diffs) {
  const v = verdict(nov, (r) => prim(r) && r.model === m && r.difficulty === d);
  if (v.s.pairs === 0) continue;
  report.primary_by_cell[`${m} × ${d}`] = {
    agentify: `${v.s.agPairPass}/${v.s.pairs}`, claude_code: `${v.s.blPairPass}/${v.s.pairs}`,
    discordant: `${v.s.left}/${v.s.right}`, sign_test_p: v.p,
    cell_317_met: v.s.left >= 5 && v.p < 0.05,
  };
}

if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const W = (w) => (w ? `${(w.low * 100).toFixed(1)}–${(w.high * 100).toFixed(1)}%` : "—");
console.log(`# Five-family downshift REPLICATION — agentify v0.5.0 (three full runs)\n`);
console.log(`Primary = ${PRIMARY_JOB} (completeness rule, set after the runs; see DEVIATIONS.md D7).`);
console.log(`The #322 verdict is identical across all three runs, so the choice of primary cannot change it.\n`);
console.log(`## Side-by-side: every full run vs 2026-08-21 (pooled matched pairs)\n`);
console.log(`| run | pairs | agentify | claude-code | discordant a/b | sign p | families | WINNER? |`);
console.log(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
const row = (label, o) => console.log(`| ${label} | ${o.pairs} | ${o.agentify_pairs} (${W(o.agentify_wilson)}) | ${o.claude_code_pairs} (${W(o.claude_code_wilson)}) | ${o.discordant} | ${o.sign_test_p} | ${o.families_spanned.length} | ${o.winner_agentify} |`);
row("2026-08-21 v0.4.0", report.august);
for (const job of jobs) row(report.runs[job].label, report.runs[job]);
console.log(`\nArm totals (reconcile with campaign.json published aggregates):`);
for (const job of jobs) {
  const t = report.runs[job].arm_totals; const ng = report.runs[job].non_gradeable;
  console.log(`  ${report.runs[job].label}: agentify ${t.agentify.passes}/${t.agentify.attempts}, claude-code ${t.claude_code.passes}/${t.claude_code.attempts}  (non-gradeable: agentify ${ng.agentify}, claude-code ${ng.claude_code})`);
}
const pj = report.runs[PRIMARY_JOB];
console.log(`\n## PRIMARY clauses (#322, fail-closed): WINNER agentify = ${pj.winner_agentify}`);
console.log(`- (1) >=5 discordant spanning >=2 families: ${pj.clauses.c1_5plus_2fam} (${pj.discordant}, families: ${pj.families_spanned.join(", ")})`);
console.log(`- (2) exact sign p < 0.05: ${pj.clauses.c2_sign_p} (p=${pj.sign_test_p})`);
console.log(`- (3) Wilson intervals separated: ${pj.clauses.c3_wilson_sep} (agentify ${W(pj.agentify_wilson)} vs claude-code ${W(pj.claude_code_wilson)})`);
console.log(`\n## PRIMARY per-family discordant a/b (Aug | Nov)\n`);
console.log(`| family | Aug a/b (p) | Nov a/b (p) |`);
console.log(`| --- | --- | --- |`);
for (const f of families) { const x = report.primary_by_family[f]; console.log(`| ${f} | ${x.aug} (${x.aug_p}) | ${x.nov} (${x.nov_p}) |`); }
console.log(`\n## PRIMARY per-cell (model × difficulty) — #317 secondary target\n`);
console.log(`| cell | agentify | claude-code | discordant a/b | sign p | #317 met |`);
console.log(`| --- | --- | --- | --- | --- | --- |`);
for (const [k, c] of Object.entries(report.primary_by_cell)) console.log(`| ${k} | ${c.agentify} | ${c.claude_code} | ${c.discordant} | ${c.sign_test_p} | ${c.cell_317_met} |`);
console.log("");
