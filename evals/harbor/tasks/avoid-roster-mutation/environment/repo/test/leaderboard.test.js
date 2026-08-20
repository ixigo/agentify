import test from "node:test";
import assert from "node:assert/strict";

import { topPlayer, totalScore } from "../src/leaderboard.js";

test("topPlayer finds the highest score", () => {
  const players = [
    { name: "ada", score: 310 },
    { name: "lin", score: 522 },
    { name: "raj", score: 415 },
  ];
  assert.equal(topPlayer(players).name, "lin");
});

test("topPlayer of an empty roster is null", () => {
  assert.equal(topPlayer([]), null);
});

test("totalScore sums the roster", () => {
  const players = [
    { name: "ada", score: 100 },
    { name: "lin", score: 250 },
  ];
  assert.equal(totalScore(players), 350);
});
