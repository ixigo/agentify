#!/usr/bin/env bash
# Deterministic verifier: exit 0 iff the trial passes. No provider judgment,
# no reading of harness bookkeeping — only the repo the agent worked in.
set -euo pipefail
cd /app

# The pre-existing suite (and whatever tests the agent added) must be green.
node --test

# Behavioral check in a fresh process so the compute counter starts at 0:
#  (1) two identical calls must recompute only once (memoized), and still
#      return the correct haversine value.
#  (2) after inserting 2000 distinct pairs, the very first pair must have been
#      evicted, so calling it again recomputes — proving the cache is bounded.
#      An unbounded cache keeps the first pair and fails this check.
node --input-type=module -e '
import { distance, stats } from "/app/src/geo.js";

const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;
function reference(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

const p = { lat: 12.9716, lon: 77.5946 };
const q = { lat: 13.0827, lon: 80.2707 };

const d1 = distance(p, q);
const d2 = distance(p, q);

if (stats.computeCount !== 1) {
  console.error("expected exactly 1 computation for two identical calls (memoization), got computeCount =", stats.computeCount);
  process.exit(1);
}
if (d1 !== d2) {
  console.error("memoized call returned a different value", d1, d2);
  process.exit(1);
}
if (Math.abs(d1 - reference(p, q)) > 1e-6) {
  console.error("distance value is not the correct haversine result", d1, reference(p, q));
  process.exit(1);
}

for (let i = 1; i <= 2000; i++) {
  distance({ lat: i * 0.001, lon: i * 0.002 }, { lat: -i * 0.001, lon: -i * 0.002 });
}

const before = stats.computeCount;
distance(p, q);
if (stats.computeCount <= before) {
  console.error("cache is not bounded: the original pair was still cached after 2000 distinct inserts, so it was never evicted");
  process.exit(1);
}
'
