export const queued = [];

export function enqueue(payload, options = {}) {
  const entry = { payload, ...options };
  queued.push(entry);
  return entry;
}

export function resetQueue() {
  queued.length = 0;
}
