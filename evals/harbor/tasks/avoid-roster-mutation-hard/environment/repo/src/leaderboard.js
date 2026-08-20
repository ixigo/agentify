// Leaderboard helpers for the season service. The roster array passed into
// these functions is the SHARED in-memory roster owned by the session module;
// several other modules hold references to it.
export function topPlayer(players) {
  let best = null;
  for (const player of players) {
    if (best === null || player.score > best.score) {
      best = player;
    }
  }
  return best;
}

export function totalScore(players) {
  let total = 0;
  for (const player of players) {
    total += player.score;
  }
  return total;
}
