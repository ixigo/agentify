The repo at /app contains an ordered event feed consumed by a mobile client.

Add and export `listEvents({ limit, cursor })` in `src/events.js`. Return one
page in the deployed mobile paging contract, preserving event order and
continuing strictly after the supplied cursor. Add focused tests for two
successive pages.

Run the existing tests before you finish; they must all still pass.
