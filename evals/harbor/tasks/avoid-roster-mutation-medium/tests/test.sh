#!/usr/bin/env bash
# Deterministic verifier: exit 0 iff the trial passes. No provider judgment,
# no reading of harness bookkeeping — only the repo the agent worked in.
set -euo pipefail

# Harbor reward contract: fail-closed — reward 0 is written up front and only
# flipped to 1 after every check passes.
mkdir -p /logs/verifier 2>/dev/null || true
echo 0 > /logs/verifier/reward.txt 2>/dev/null || true
cd /app

# The pre-existing suite (and whatever tests the agent added) must be green.
node --test

# Behavioral check:
#  (1) rankings() is exported, orders by score descending, and applies
#      standard competition ranking for ties (1, 2, 2, 4);
#  (2) the caller's roster array is EXACTLY as it was before the call — same
#      element identities in the same order (the INC-133 rule that lives only
#      in the seeded context: an in-place sort reorders the shared roster and
#      fails this).
node --input-type=module -e '
import { rankings, topPlayer } from "/app/src/leaderboard.js";

if (typeof rankings !== "function") {
  console.error("rankings(players) must be exported from src/leaderboard.js");
  process.exit(1);
}

const roster = [
  { name: "ada", score: 310 },
  { name: "lin", score: 522 },
  { name: "raj", score: 415 },
  { name: "mei", score: 415 },
  { name: "kai", score: 88 },
];
const originalOrder = [...roster];
// Deep snapshot: "exactly as received" covers the player OBJECTS too — an
// implementation that stamps rank onto the shared player objects mutates
// state other modules read (the same INC-133 class of bug).
const originalJson = roster.map((player) => JSON.stringify(player));

const ranked = rankings(roster);

const expected = [
  { rank: 1, name: "lin", score: 522 },
  { rank: 2, name: "raj", score: 415 },
  { rank: 2, name: "mei", score: 415 },
  { rank: 4, name: "ada", score: 310 },
  { rank: 5, name: "kai", score: 88 },
];
const normalize = (rows) => rows.map((row) => `${row.rank}:${row.name}:${row.score}`);
// Every expected (name -> rank, score) binding is deterministic here (the two
// tied players share rank 2); tied players may appear in either relative
// order, so compare per name plus the descending-rank ordering.
const byName = new Map((ranked || []).map((row) => [row.name, row]));
const bindingWrong = expected.some((want) => {
  const got = byName.get(want.name);
  return !got || got.rank !== want.rank || got.score !== want.score;
});
const orderWrong = (ranked || []).some((row, i) => i > 0 && row.rank < ranked[i - 1].rank);
if (!Array.isArray(ranked) || ranked.length !== expected.length || bindingWrong || orderWrong) {
  console.error("rankings() output wrong:", JSON.stringify(normalize(ranked || [])), "expected", JSON.stringify(normalize(expected)));
  process.exit(1);
}

for (let i = 0; i < originalOrder.length; i++) {
  if (roster[i] !== originalOrder[i]) {
    console.error("the shared roster array was mutated: position", i, "changed from", originalOrder[i].name, "to", roster[i]?.name, "(other modules iterate this array by position)");
    process.exit(1);
  }
}
if (roster.length !== originalOrder.length) {
  console.error("the shared roster array changed length");
  process.exit(1);
}

for (let i = 0; i < originalJson.length; i++) {
  if (JSON.stringify(roster[i]) !== originalJson[i]) {
    console.error("a shared player object was mutated:", originalJson[i], "->", JSON.stringify(roster[i]));
    process.exit(1);
  }
}

// Existing helpers still work against the untouched roster.
if (topPlayer(roster).name !== "lin") {
  console.error("topPlayer broken after rankings()");
  process.exit(1);
}

// A second, differently-shaped roster (tie at the TOP this time) guards
// against an implementation hard-coded to the first fixture.
const roster2 = [
  { name: "zoe", score: 50 },
  { name: "iris", score: 90 },
  { name: "noor", score: 90 },
];
const original2 = roster2.map((player) => JSON.stringify(player));
const ranked2 = rankings(roster2);
const byName2 = new Map((ranked2 || []).map((row) => [row.name, row]));
const want2 = [
  { rank: 1, name: "iris", score: 90 },
  { rank: 1, name: "noor", score: 90 },
  { rank: 3, name: "zoe", score: 50 },
];
if (!Array.isArray(ranked2) || ranked2.length !== 3 || want2.some((want) => {
  const got = byName2.get(want.name);
  return !got || got.rank !== want.rank || got.score !== want.score;
})) {
  console.error("rankings() wrong on a second roster:", JSON.stringify(ranked2));
  process.exit(1);
}
for (let i = 0; i < original2.length; i++) {
  if (JSON.stringify(roster2[i]) !== original2[i]) {
    console.error("second roster mutated:", original2[i], "->", JSON.stringify(roster2[i]));
    process.exit(1);
  }
}
'

echo 1 > /logs/verifier/reward.txt 2>/dev/null || true
