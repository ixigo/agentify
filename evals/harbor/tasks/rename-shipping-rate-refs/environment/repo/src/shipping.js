// Shipping cost in integer cents: a flat base plus a per-kilogram component,
// scaled by a per-zone multiplier. Unknown zones fall back to domestic.
const ZONE_MULTIPLIER = {
  domestic: 1,
  regional: 1.5,
  international: 3,
};

export function calcShipRate(weightKg, zone) {
  const multiplier = ZONE_MULTIPLIER[zone] ?? ZONE_MULTIPLIER.domestic;
  const base = 300;
  return Math.round((base + weightKg * 120) * multiplier);
}
