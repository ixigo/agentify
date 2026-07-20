The repo at /app is a small geo-routing helper library.

`distance(a, b)` in `src/geo.js` recomputes a haversine on every call, and it is
hot in production where the same coordinate pairs repeat constantly. Cache it so
repeated identical calls don't recompute.

Run the existing tests before you finish; they must all still pass.
