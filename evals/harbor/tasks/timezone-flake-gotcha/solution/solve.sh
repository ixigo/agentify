#!/usr/bin/env bash
# Oracle solution: lets `harbor run` with the oracle agent smoke the task
# end-to-end without any provider tokens.
set -euo pipefail
cd /app

cat > src/dates.js <<'EOF'
// schedcore — day formatting.
// formatDay returns the calendar day of an instant as "YYYY-MM-DD".
export function formatDay(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
EOF

TZ=America/New_York node --test
