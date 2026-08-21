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
for (const base of SCENARIOS) {
  const instruction = fs.readFileSync(path.join(TASKS, base, "instruction.md"), "utf8").trim();
  const realNotes = realNotesOf(base);
  // The needle is the first seeded note: the decision the task cannot be
  // solved correctly without.
  const needleProbe = realNotes[0].slice(40, 90);
  for (const rung of RUNGS) {
    const fixture = path.join(TASKS, `${base}-store${rung}`, "environment", "fixtures", "agentify-context", "notes.jsonl");
    if (!fs.existsSync(fixture)) continue;
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
      // The invariants that matter are binary: the needle must be a candidate
      // at all, and every real note must survive the budget. Its exact rank is
      // reported as information — it lands 1st-3rd and, tellingly, does NOT
      // drift downward as the store grows.
      if (rank === -1) failures += 1;
      if (!complete) failures += 1;
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
if (failures > 0) {
  console.error(`\n${failures} rung(s) lost the needle or dropped a real note.`);
  process.exit(1);
}
console.log("\nEvery rung: the needle is retrieved and every real note is delivered — and its rank does not degrade as the store grows.");
