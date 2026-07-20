// Aggregations over billing records. Date-bucketing helpers live in their own
// modules (src/monthly.js, src/quarter.js) so each reporting granularity can
// be added independently as it is needed.

export function sumAmounts(records) {
  return records.reduce((total, record) => total + record.amount, 0);
}
