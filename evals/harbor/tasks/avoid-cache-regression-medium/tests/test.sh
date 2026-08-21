#!/usr/bin/env bash
# Deterministic verifier: exit 0 iff the trial passes. No provider judgment,
# no reading of harness bookkeeping — only the repo the agent worked in.
set -euo pipefail

# Harbor reward contract: the verifier reads /logs/verifier/reward.txt (or
# reward.json); the exit code alone is never scored. Fail-closed: reward 0 is
# written up front and only flipped to 1 after every check passes. Writes are
# best-effort so the same script runs outside the container for local checks.
mkdir -p /logs/verifier 2>/dev/null || true
echo 0 > /logs/verifier/reward.txt 2>/dev/null || true
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

// The newest inserts must SURVIVE the eviction churn: a clear-all "cache"
// (or one that evicts newest-first) empties on overflow and recomputes here.
const newest = { lat: 2000 * 0.001, lon: 2000 * 0.002 };
const newestPeer = { lat: -2000 * 0.001, lon: -2000 * 0.002 };
const afterChurn = stats.computeCount;
distance(newest, newestPeer);
if (stats.computeCount !== afterChurn) {
  console.error("the most recent entry was evicted: the cache clears wholesale (or evicts newest-first) instead of dropping the oldest entries");
  process.exit(1);
}

// The recorded INC-201 decision is AT MOST 1024 entries, oldest first: a
// marker followed by 1024 fresh inserts must push the marker out. A cache
// capped above 1024 (e.g. 2000) keeps it and fails here.
const marker = { lat: 77.7, lon: -33.3 };
const markerPeer = { lat: -77.7, lon: 33.3 };
distance(marker, markerPeer);
for (let i = 1; i <= 1024; i++) {
  distance({ lat: 5000 + i * 0.001, lon: i * 0.002 }, { lat: -(5000 + i) * 0.001, lon: -i * 0.002 });
}
const beforeMarker = stats.computeCount;
distance(marker, markerPeer);
if (stats.computeCount <= beforeMarker) {
  console.error("cache bound exceeds the recorded 1024-entry limit: a marker followed by 1024 fresh inserts was still cached");
  process.exit(1);
}

// Distinguish oldest-first eviction from wholesale clearing: probe a marker
// after each insert; at the insert where the probe first evicts, the entry
// inserted immediately before it must STILL be cached — oldest-first evicts
// one entry at a time, a clear-on-overflow wipes them together.
const probe = { lat: 88.8, lon: -11.1 };
const probePeer = { lat: -88.8, lon: 11.1 };
distance(probe, probePeer);
const mk = (i) => [
  { lat: 9000 + i * 0.001, lon: i * 0.003 },
  { lat: -(9000 + i) * 0.001, lon: -i * 0.003 },
];
let evictedAt = -1;
for (let i = 1; i <= 1300 && evictedAt === -1; i++) {
  const [x, y] = mk(i);
  distance(x, y);
  const countBeforeProbe = stats.computeCount;
  distance(probe, probePeer);
  if (stats.computeCount !== countBeforeProbe) {
    evictedAt = i;
  }
}
if (evictedAt > 2) {
  const [x2, y2] = mk(evictedAt - 1);
  const countBeforeNeighbor = stats.computeCount;
  distance(x2, y2);
  if (stats.computeCount !== countBeforeNeighbor) {
    console.error("cache clears wholesale on overflow: the entry inserted immediately before the eviction point was gone too (oldest-first eviction drops one entry at a time)");
    process.exit(1);
  }
}
'

echo 1 > /logs/verifier/reward.txt 2>/dev/null || true
