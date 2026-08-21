#!/usr/bin/env bash
# Oracle solution: lets `harbor run` with the oracle agent smoke the task
# end-to-end without any provider tokens.
set -euo pipefail
cd /app

cat > src/geo.js <<'EOF'
// Great-circle distance between two {lat, lon} points, in kilometres.
// stats.computeCount is a live counter read by the perf regression test and by
// the metrics exporter; every actual haversine evaluation must bump it.
export const stats = { computeCount: 0 };

const EARTH_RADIUS_KM = 6371;

// Bounded memo: capped at 1024 entries, evicting the oldest key first when the
// limit is exceeded (Map preserves insertion order). This keeps repeated calls
// cheap without letting the cache grow without bound in memory-constrained pods.
const CACHE_LIMIT = 1024;
const memo = new Map();

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

function compute(a, b) {
  stats.computeCount += 1;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function distance(a, b) {
  const key = `${a.lat},${a.lon}|${b.lat},${b.lon}`;
  if (memo.has(key)) {
    return memo.get(key);
  }
  const value = compute(a, b);
  memo.set(key, value);
  if (memo.size > CACHE_LIMIT) {
    memo.delete(memo.keys().next().value);
  }
  return value;
}
EOF

node --test
