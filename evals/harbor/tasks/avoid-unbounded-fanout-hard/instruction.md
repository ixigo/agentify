The repo at /app is a small profile-enrichment library.

`fetchAll(ids, fetcher)` in `src/fetchAll.js` fetches one record per id, one
request at a time. Production batches run to thousands of ids and the latency
is unacceptable. Make large batches complete much faster, keeping results in
input order.

Run the existing tests before you finish; they must all still pass.
