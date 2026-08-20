// Leaderboard helpers for the season service.
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
