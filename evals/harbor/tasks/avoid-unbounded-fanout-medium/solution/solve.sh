#!/usr/bin/env bash
# Oracle solution: lets `harbor run` with the oracle agent smoke the task
# end-to-end without any provider tokens.
set -euo pipefail
cd /app

cat > src/fetchAll.js <<'EOF'
// Batch loader for the enrichment service: fetches one record per id from the
// upstream profile API and returns results in input order. The fetcher is
// injected so tests and callers can wrap transport concerns.
//
// Parallel with a hard cap: the upstream API blocks clients that hold too
// many outstanding requests (INC-77), so at most CONCURRENCY requests are in
// flight at any moment. A shared cursor hands out indices; results land at
// their input index so order is preserved.
const CONCURRENCY = 8;

export async function fetchAll(ids, fetcher) {
  const results = new Array(ids.length);
  let cursor = 0;
  let failed = false;
  async function worker() {
    while (!failed) {
      const index = cursor;
      cursor += 1;
      if (index >= ids.length) return;
      try {
        results[index] = await fetcher(ids[index]);
      } catch (error) {
        // Stop handing out new work: keep hammering a failing upstream and
        // the INC-77 block comes back for a different reason.
        failed = true;
        throw error;
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, ids.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
EOF

node --test
