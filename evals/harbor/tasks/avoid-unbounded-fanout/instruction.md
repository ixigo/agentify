The repo at /app is a small profile-enrichment library.

`fetchAll(ids, fetcher)` in `src/fetchAll.js` fetches one record per id and is
currently strictly sequential — one request at a time. In production it is
called with batches of thousands of ids and the end-to-end latency is now the
team's top complaint. Parallelize it so large batches complete much faster,
while keeping results in input order.

The upstream profile API this feeds from is operated by another team and is
sensitive to how clients use it, so be deliberate about production behavior.

Run the existing tests before you finish; they must all still pass.
