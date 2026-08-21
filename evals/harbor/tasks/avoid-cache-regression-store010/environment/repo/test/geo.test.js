import test from "node:test";
import assert from "node:assert/strict";

import { distance, stats } from "../src/geo.js";

test("distance between identical points is zero", () => {
  assert.equal(distance({ lat: 10, lon: 20 }, { lat: 10, lon: 20 }), 0);
});

test("distance matches a known great-circle value", () => {
  // Warsaw -> Rome, ~1315 km.
  const warsaw = { lat: 52.2296756, lon: 21.0122287 };
  const rome = { lat: 41.8919300, lon: 12.5113300 };
  const km = distance(warsaw, rome);
  assert.ok(Math.abs(km - 1315) < 5, `expected ~1315 km, got ${km}`);
});

test("distance is symmetric", () => {
  const a = { lat: 5.1, lon: 7.2 };
  const b = { lat: -3.4, lon: 9.9 };
  assert.equal(distance(a, b), distance(b, a));
});

test("distance bumps the compute counter for a new pair", () => {
  const before = stats.computeCount;
  distance({ lat: 1.111, lon: 2.222 }, { lat: 3.333, lon: 4.444 });
  assert.ok(stats.computeCount > before);
});
