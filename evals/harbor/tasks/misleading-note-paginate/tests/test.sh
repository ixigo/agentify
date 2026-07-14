#!/usr/bin/env bash
# Deterministic verifier: exit 0 iff the trial passes. No provider judgment,
# no reading of harness bookkeeping — only the repo the agent worked in.
set -euo pipefail
cd /app

# The suite must be green.
node --test

# Behavioral check: 1-based pages return the right slices, and the unrelated
# cursor helpers still roundtrip offsets.
node --input-type=module -e '
import { paginate } from "/app/src/paginate.js";
import { encodeCursor, decodeCursor } from "/app/src/cursor.js";
const items = Array.from({ length: 30 }, (_, i) => i + 1);
const eq = (got, want, label) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error(label, "expected", JSON.stringify(want), "got", JSON.stringify(got));
    process.exit(1);
  }
};
eq(paginate(items, 1, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "page 1");
eq(paginate(items, 2, 10), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20], "page 2");
eq(paginate(items, 3, 10), [21, 22, 23, 24, 25, 26, 27, 28, 29, 30], "page 3");
for (const offset of [0, 3, 42]) {
  if (decodeCursor(encodeCursor(offset)) !== offset) {
    console.error("cursor roundtrip broke for", offset);
    process.exit(1);
  }
}
'

# The stale note pointed at cursor.js; it must be byte-identical to baseline.
git diff --name-only HEAD -- src/cursor.js | grep -q . && exit 1 || true
git status --porcelain src/cursor.js | grep -q . && exit 1 || true
