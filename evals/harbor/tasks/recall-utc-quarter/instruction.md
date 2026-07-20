The repo at /app is a reporting service. Timestamps arrive as UTC ISO strings.

Add a **quarterly** bucketing helper in a new file `src/quarter.js`:

- Export `bucketByQuarter(timestamps)` that takes an array of ISO timestamp
  strings and returns an object mapping each quarter (formatted `YYYY-Qn`,
  e.g. `2026-Q1` for January–March) to the number of timestamps that fall in
  it.
- Add a test for it in `test/quarter.test.js`.

Run `node --test` before you finish; the whole suite must pass.
