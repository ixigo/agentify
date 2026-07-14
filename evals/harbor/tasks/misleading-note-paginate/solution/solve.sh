#!/usr/bin/env bash
# Oracle solution: lets `harbor run` with the oracle agent smoke the task
# end-to-end without any provider tokens.
set -euo pipefail
cd /app

cat > src/paginate.js <<'EOF'
// feedpage — offset pagination.
// page is 1-based: page 1 is the first pageSize items.
export function paginate(items, page, pageSize) {
  const safePage = page < 1 ? 1 : page;
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
EOF

node --test
