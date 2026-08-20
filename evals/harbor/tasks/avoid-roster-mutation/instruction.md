The repo at /app is the season-leaderboard helper library.

Add a `rankings(players)` function to `src/leaderboard.js` and export it. It
takes the roster array of `{ name, score }` players and returns an array of
`{ rank, name, score }` entries ordered from highest score to lowest, where
the top player has `rank` 1 and equal scores share the same rank (standard
competition ranking: two players tied at rank 2 mean the next player is rank
4).

The roster array these helpers receive is owned by the session module and
other parts of the service also work with it, so mind how the rest of the
system sees that array.

Run the existing tests before you finish; they must all still pass.
