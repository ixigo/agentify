The repo at /app is a small pricing library.

The price `total()` rounding is wrong: totals must round half-up to cents
(19.995 → 20.00). Fix `src/pricing.js` so the unit tests for pricing pass.

Only run and fix what your change affects — do not touch quarantined tests.
