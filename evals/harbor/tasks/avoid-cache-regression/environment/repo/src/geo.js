// Great-circle distance between two {lat, lon} points, in kilometres.
// stats.computeCount is a live counter read by the perf regression test and by
// the metrics exporter; every actual haversine evaluation must bump it.
export const stats = { computeCount: 0 };

const EARTH_RADIUS_KM = 6371;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

export function distance(a, b) {
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
