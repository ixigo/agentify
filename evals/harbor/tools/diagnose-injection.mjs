#!/usr/bin/env node
// Token-free check of what Agentify's per-task injection actually delivers for
// the store-size ladder fixtures. Two claims in the 2026-08-21 store-ladder
// write-up rest on this, so it ships as a rerunnable tool rather than a
// throwaway script:
//
//   1. RANK      — is the seeded "needle" note even a BM25 candidate, and where
//                  does it rank, at each store size?
//   2. COMPLETE  — do ALL of a task's real notes survive selection and the
//                  token budget, or does the budget silently drop one?
//
// Both answered YES at every rung (needle ranked #1-2 and injected; every real
// note delivered), which is what rules out "retrieval broke at scale" and
// "the budget truncated the answer" as explanations for the ladder result.
//
//   node evals/harbor/tools/diagnose-injection.mjs
//
// No provider calls, no containers, no cost: it builds a temp store from the
// committed fixtures and calls the same match pipeline the hooks use.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadContextSnapshot, matchContext, matchSnapshotToPrompt } from "../../../src/core/ctx.js";

const TASKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tasks");
const SCENARIOS = ["avoid-cache-regression", "recall-retry-schedule", "recall-webhook-signature"];
const RUNGS = ["010", "100", "300"];

function realNotesOf(base) {
  const p = path.join(TASKS, base, "environment", "fixtures", "agentify-context", "notes.jsonl");
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).note);
}

function tempStoreFrom(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-diag-"));
  fs.mkdirSync(path.join(dir, ".agentify", "context"), { recursive: true });
  fs.copyFileSync(fixture, path.join(dir, ".agentify", "context", "notes.jsonl"));
  return dir;
}

let failures = 0;
const ranksByScenario = new Map();
for (const base of SCENARIOS) {
  const instruction = fs.readFileSync(path.join(TASKS, base, "instruction.md"), "utf8").trim();
  const realNotes = realNotesOf(base);
  // The needle is the first seeded note: the decision the task cannot be
  // solved correctly without.
  const needleProbe = realNotes[0].slice(40, 90);
  for (const rung of RUNGS) {
    const fixture = path.join(TASKS, `${base}-store${rung}`, "environment", "fixtures", "agentify-context", "notes.jsonl");
    if (!fs.existsSync(fixture)) {
      // A missing rung must be loud: silently skipping it would let the
      // summary below claim a property it never measured.
      console.error(`MISSING fixture for ${base}-store${rung} (${fixture})`);
      failures += 1;
      continue;
    }
    const dir = tempStoreFrom(fixture);
    try {
      const snapshot = await loadContextSnapshot(dir, { maxNotes: 1000, verifyNotes: false });
      const ranked = (matchSnapshotToPrompt(snapshot, instruction).notes || [])
        .map((entry) => entry.note?.note ?? entry.note ?? "");
      const rank = ranked.findIndex((text) => text.includes(needleProbe));

      const injected = await matchContext(dir, instruction, { sessionId: `diag-${base}-${rung}` });
      const blob = JSON.stringify(injected.notes || []);
      const delivered = realNotes.filter((note) => blob.includes(note.slice(40, 90))).length;
      const complete = delivered === realNotes.length;
      // Invariants: the needle must be a candidate at all, and every real
      // note must survive the budget. Rank is recorded per rung so the
      // no-decay claim below is actually MEASURED rather than asserted.
      if (rank === -1) failures += 1;
      if (!complete) failures += 1;
      if (!ranksByScenario.has(base)) ranksByScenario.set(base, []);
      ranksByScenario.get(base).push({ rung, rank: rank === -1 ? Infinity : rank + 1 });
      console.log(
        `${base}-store${rung}`.padEnd(38),
        `store=${String(snapshot.notes.length).padStart(3)}`,
        `needle_rank=${rank === -1 ? "NOT RANKED" : rank + 1}`.padEnd(20),
        `real_notes_delivered=${delivered}/${realNotes.length}`,
        complete ? "COMPLETE" : "INCOMPLETE",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
// Rank stability is MEASURED here, not asserted. Every rung is compared
// against the smallest, not just the largest: a 1 -> 5 -> 1 excursion is a
// real regression that a first-vs-last check would report as "no decay".
console.log("\nNeedle rank by rung (lower is better):");
let decayed = 0;
for (const [base, ranks] of ranksByScenario) {
  const ordered = ranks.slice().sort((a, b) => Number(a.rung) - Number(b.rung));
  const baseline = ordered[0];
  const regressions = ordered.filter((r) => r.rank > baseline.rank);
  if (regressions.length) decayed += 1;
  console.log(
    `  ${base.padEnd(26)} ${ordered.map((r) => `store${r.rung}=${r.rank}`).join("  ")}`,
    regressions.length
      ? `  DEGRADED (store${baseline.rung}=${baseline.rank} -> ` +
          `${regressions.map((r) => `store${r.rung}=${r.rank}`).join(", ")})`
      : "  no decay",
  );
}

if (failures > 0) {
  console.error(`\n${failures} rung(s) lost the needle, dropped a real note, or was missing.`);
  process.exit(1);
}
if (decayed > 0) {
  console.error(`\n${decayed} scenario(s) ranked the needle WORSE at some larger rung than at the smallest.`);
  process.exit(1);
}
console.log("\nEvery rung: needle retrieved, every real note delivered, and no rung ranked the needle worse than the smallest store did.");
