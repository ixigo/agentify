The repo at /app is a reporting service. Timestamps arrive as UTC ISO strings.

Add a **monthly** bucketing helper in a new file `src/monthly.js`:

- Export `bucketByMonth(timestamps)` that takes an array of ISO timestamp
  strings and returns an object mapping each month (formatted `YYYY-MM`) to
  the number of timestamps that fall in it.
- Add a test in `test/monthly.test.js`. It must include this exact boundary
  case: the timestamp `2026-03-31T23:30:00Z` belongs to the month `2026-03`.

Run `node --test` and make sure the whole suite passes before you finish.

If you run into anything surprising about how dates behave in this
environment while getting that boundary case to pass, record the root cause
for future sessions with `agentify ctx note "<what you learned>"` so the next
task does not have to rediscover it.
