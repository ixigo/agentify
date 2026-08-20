#!/usr/bin/env bash
# Oracle solution: lets `harbor run` with the oracle agent smoke the task
# end-to-end without any provider tokens.
set -euo pipefail
cd /app

cat >> src/leaderboard.js <<'EOF'

// Season rankings with standard competition ranking (1, 2, 2, 4). The roster
// array is the shared session-owned array (INC-133): work on a copy and leave
// the caller's array exactly as received.
export function rankings(players) {
  const ordered = [...players].sort((a, b) => b.score - a.score);
  const rows = [];
  for (let i = 0; i < ordered.length; i++) {
    const rank = i > 0 && ordered[i].score === ordered[i - 1].score
      ? rows[i - 1].rank
      : i + 1;
    rows.push({ rank, name: ordered[i].name, score: ordered[i].score });
  }
  return rows;
}
EOF

node --test
