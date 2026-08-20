// Batch loader for the enrichment service: fetches one record per id from the
// upstream profile API and returns results in input order. The fetcher is
// injected so tests and callers can wrap transport concerns.
export async function fetchAll(ids, fetcher) {
  const results = [];
  for (const id of ids) {
    // Sequential on purpose for now: one request at a time.
    results.push(await fetcher(id));
  }
  return results;
}
