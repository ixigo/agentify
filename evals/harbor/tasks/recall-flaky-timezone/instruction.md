The repo at /app is a reporting service. Timestamps arrive as UTC ISO strings.

Add a **monthly** bucketing helper in a new file `src/monthly.js`:

- Export `bucketByMonth(timestamps)` that takes an array of ISO timestamp
  strings and returns an object mapping each month (formatted `YYYY-MM`) to
  the number of timestamps that fall in it.
- Add a test for it in `test/monthly.test.js`.

Run `node --test` before you finish; the whole suite must pass.
