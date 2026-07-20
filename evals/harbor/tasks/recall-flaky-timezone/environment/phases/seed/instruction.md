The repo at /app is a reporting service. Timestamps arrive as UTC ISO strings.

Add a **daily** bucketing helper in a new file `src/daily.js`:

- Export `bucketByDay(timestamps)` that takes an array of ISO timestamp
  strings and returns an object mapping each day (formatted `YYYY-MM-DD`) to
  the number of timestamps that fall on it.
- Add a test in `test/daily.test.js`. It must include this exact boundary
  case: the timestamp `2026-03-31T23:30:00Z` belongs to the day
  `2026-03-31`.

Run `node --test` and make sure the whole suite passes before you finish.

If you run into anything surprising about how dates behave in this
environment while getting that boundary case to pass, record the root cause
for future sessions with `agentify ctx note "<what you learned>"` so the next
task does not have to rediscover it.
