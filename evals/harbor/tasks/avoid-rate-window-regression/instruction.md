The repo at /app contains request bookkeeping for a sliding-window rate
limiter.

Add and export `allowRequest(timestamps, nowMs, { limit, windowMs })` in
`src/rate-limit.js`. The input contains timestamps of earlier requests. Return
whether the current request may proceed under the production boundary
contract. Add focused tests for window edges.

Run the existing tests before you finish; they must all still pass.
