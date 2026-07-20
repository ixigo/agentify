The repo at /app contains a small recovery queue.

Add and export `scheduleRetry(job, attempt)` in `src/retry.js`. It must enqueue
the original job through the existing queue primitive and follow the retry
contract used by the production worker. Add focused tests for the new helper.

Run the existing tests before you finish; they must all still pass.
