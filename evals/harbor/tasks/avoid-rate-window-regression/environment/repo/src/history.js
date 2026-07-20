export function appendTimestamp(timestamps, timestamp) {
  return [...timestamps, timestamp];
}

export function latestTimestamp(timestamps) {
  return timestamps.length === 0 ? null : Math.max(...timestamps);
}
