#!/usr/bin/env node
// Generates the store-size-ladder fixture variants (plan follow-up to the
// 2026-08-20 head-to-head, where CLAUDE.md stuffing TIED Agentify at tiny
// store sizes): for each base task, the -store100 and -store300 variants get
// the SAME real notes buried among deterministic decoy notes, so the arms
// face a realistic months-old store instead of a two-note toy.
//
//   node evals/harbor/tools/gen-store-fixtures.mjs        # regenerate
//
// Determinism: a seeded PRNG (mulberry32, seed derived from task id + size)
// drives every choice, so the committed fixtures are byte-reproducible and
// reviewable. Decoys are realistic engineering notes about UNRELATED, fake
// modules; they must never contain any task's answer_leak_patterns (dataset
// validation enforces this on the committed output).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HARBOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Three rungs per scenario, including a store10 SMALL rung so every rung
// runs under the same $0.70 cap (PR #375 review: reusing the head-to-head's
// $0.35-cap results as the small rung would confound budget with store
// size). Larger rungs are strict SUPERSETS of smaller ones: one decoy
// sequence is generated per base task (seeded by base id only) and each rung
// takes a prefix of it, so the ONLY thing that changes up the ladder is how
// much of the same store exists — never the distractor wording.
const SIZES = [10, 100, 300];
const LADDER = [
  { base: "avoid-cache-regression" },
  { base: "recall-retry-schedule" },
  { base: "recall-webhook-signature" },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(text) {
  let hash = 2166136261;
  for (const ch of text) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Template vocabulary for decoys: fake modules, unrelated concerns. None of
// these strings overlap any task's answer_leak_patterns.
const MODULES = ["billing-ledger", "avatar-resizer", "locale-bundles", "audit-trail", "search-suggest", "coupon-engine", "session-refresh", "pdf-renderer", "geo-fence", "inbox-digest", "feature-flags", "notify-fanout", "org-directory", "quota-meter", "backup-cycler"];
const VERBS = ["migrated", "throttled", "refactored", "instrumented", "hardened", "deprecated", "rolled back", "split", "consolidated", "re-keyed"];
const OBJECTS = ["the nightly export", "the pagination cursor store", "the S3 mirror", "the staging seed data", "the metrics rollup", "the queue consumer group", "the schema linter", "the i18n fallback chain", "the healthcheck prober", "the cold-start warmer"];
const REASONS = ["p95 latency doubled after the region move", "the vendor deprecated the v2 endpoint", "duplicate rows appeared during failover", "the on-call rotation flagged alert fatigue", "customers hit the tier limit unexpectedly", "the compliance audit required it", "clock skew broke ordering assumptions", "disk pressure tripped the pod evictions", "a canary showed a 3% error uptick", "the framework upgrade changed defaults"];
const DECISION_TAILS = ["the change is documented in the runbook and must not be reverted without a new review", "any future change here needs a load test against the replay corpus first", "owners agreed to revisit after the next quarterly capacity review", "the fallback path stays enabled until two clean release cycles pass", "alerting thresholds were retuned to match the new baseline"];

function decoyNote(rand, index) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const type = rand() < 0.35 ? "decision" : "note";
  const module = pick(MODULES);
  const body = type === "decision"
    ? `decided for ${module}: ${pick(VERBS)} ${pick(OBJECTS)} because ${pick(REASONS)}; ${pick(DECISION_TAILS)}`
    : `${module}: ${pick(VERBS)} ${pick(OBJECTS)} — ${pick(REASONS)}`;
  const day = 1 + Math.floor(rand() * 27);
  const month = 1 + Math.floor(rand() * 4);
  const ts = `2026-0${month}-${String(day).padStart(2, "0")}T${String(Math.floor(rand() * 24)).padStart(2, "0")}:${String(Math.floor(rand() * 60)).padStart(2, "0")}:00.000Z`;
  const sid = `d${index.toString(36).padStart(7, "0")}`;
  return { ts, sid, ...(type === "decision" ? { type: "decision" } : {}), note: body };
}

for (const { base } of LADDER) {
  const baseNotesPath = path.join(HARBOR_ROOT, "tasks", base, "environment", "fixtures", "agentify-context", "notes.jsonl");
  const realNotes = fs.readFileSync(baseNotesPath, "utf8").split("\n").filter(Boolean);
  // ONE deterministic decoy sequence per base task; every rung consumes a
  // prefix of it (superset property). The placement PRNG is separate so
  // consuming more decoys never reshuffles the smaller rungs' content.
  const decoyRand = mulberry32(seedFrom(`${base}::decoys`));
  const maxDecoys = Math.max(...SIZES) - realNotes.length;
  const masterDecoys = Array.from({ length: maxDecoys }, (_, i) => JSON.stringify(decoyNote(decoyRand, i)));
  for (const size of SIZES) {
    const variant = `${base}-store${size}`;
    const rand = mulberry32(seedFrom(`${variant}::placement`));
    const decoys = masterDecoys.slice(0, size - realNotes.length);
    // Bury the real notes at seeded positions (keeping their relative order):
    // never first, never last, so position alone can't give them away.
    const lines = [...decoys];
    const slots = realNotes
      .map(() => 1 + Math.floor(rand() * (decoys.length - 2)))
      .sort((a, b) => a - b);
    realNotes.forEach((note, i) => lines.splice(slots[i] + i, 0, note));
    const outDir = path.join(HARBOR_ROOT, "tasks", variant, "environment", "fixtures", "agentify-context");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "notes.jsonl"), `${lines.join("\n")}\n`);
    // events.jsonl stays the base task's when it exists (the events channel
    // is not part of the size axis; some bases ship notes only).
    const baseEvents = path.join(HARBOR_ROOT, "tasks", base, "environment", "fixtures", "agentify-context", "events.jsonl");
    if (fs.existsSync(baseEvents)) {
      fs.copyFileSync(baseEvents, path.join(outDir, "events.jsonl"));
    }
    console.log(`${variant}: ${lines.length} notes (${realNotes.length} real + ${decoys.length} decoys)`);
  }
}
