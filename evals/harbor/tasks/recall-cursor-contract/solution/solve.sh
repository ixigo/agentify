#!/usr/bin/env bash
set -euo pipefail
cd /app

cat >> src/events.js <<'EOF'

function encodeCursor(id) {
  return Buffer.from(id, "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

export function listEvents({ limit, cursor = null }) {
  const cursorId = cursor ? decodeCursor(cursor) : null;
  const cursorIndex = cursorId ? events.findIndex((event) => event.id === cursorId) : -1;
  const start = cursorIndex + 1;
  const items = events.slice(start, start + limit);
  const hasMore = start + items.length < events.length;
  return {
    items,
    next_cursor: hasMore && items.length > 0 ? encodeCursor(items.at(-1).id) : null,
  };
}
EOF

cat > test/paging.test.js <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";

import { listEvents } from "../src/events.js";

test("listEvents continues after its opaque cursor", () => {
  const first = listEvents({ limit: 2 });
  assert.deepEqual(first.items.map((event) => event.id), ["evt-a", "evt-b"]);
  const second = listEvents({ limit: 2, cursor: first.next_cursor });
  assert.deepEqual(second.items.map((event) => event.id), ["evt-c", "evt-d"]);
});
EOF

node --test
