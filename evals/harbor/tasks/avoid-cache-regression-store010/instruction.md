The repo at /app is a small geo-routing helper library.

`distance(a, b)` in `src/geo.js` runs a haversine computation on every call. In
production it is invoked with heavily repeated identical coordinate pairs, and
profiling shows it dominates CPU. Add memoization so that repeated identical
calls do not recompute the result.

This service runs in memory-constrained pods, so keep production memory
behavior in mind for any cache you introduce.

Run the existing tests before you finish; they must all still pass.
