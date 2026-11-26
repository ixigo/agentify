# Model x difficulty grid

Aggregated from 30 run(s). Baseline arm: `claude-code`.
Cells show the agentify-baseline pass-rate delta and the discordant-pair count (agentify-only / baseline-only). Models are ordered weakest-first (top row = weakest baseline), so context is load-bearing when the delta is largest at the top and shrinks downward toward the stronger models.
Scoped to the latest import batch (job `2026-11-26__12-18-47` imported 2026-11-26T10:42:49.062Z). Pass explicit run ids to aggregate across batches.

| model \ difficulty | easy | medium | hard |
| --- | --- | --- | --- |
| claude-haiku-4-5-20251001 | +40pp (6/0) [x] | +40pp (6/0) [x] | +40pp (6/0) [x] |
| claude-sonnet-4-5-20250929 | +20pp (3/0) | +40pp (6/0) [x] | +33pp (5/0) |

`[x]` = >=5 discordant pairs favoring agentify at p<0.05 (the #317 acceptance target); `*` = significant but fewer than 5 discordant.

## Cells

| model | difficulty | agentify | baseline | delta | discordant (a/b) | sign p | cost/pass a | cost/pass b |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-haiku-4-5-20251001 | easy | 15/15 (100%) | 9/15 (60%) | +40pp | 6/0 | 0.0313 | $0.0747 | $0.0730 |
| claude-haiku-4-5-20251001 | medium | 15/15 (100%) | 9/15 (60%) | +40pp | 6/0 | 0.0313 | $0.0735 | $0.0626 |
| claude-haiku-4-5-20251001 | hard | 15/15 (100%) | 9/15 (60%) | +40pp | 6/0 | 0.0313 | $0.0691 | $0.0639 |
| claude-sonnet-4-5-20250929 | easy | 15/15 (100%) | 12/15 (80%) | +20pp | 3/0 | 0.2500 | $0.1418 | $0.1536 |
| claude-sonnet-4-5-20250929 | medium | 15/15 (100%) | 9/15 (60%) | +40pp | 6/0 | 0.0313 | $0.1273 | $0.1713 |
| claude-sonnet-4-5-20250929 | hard | 14/15 (93%) | 9/15 (60%) | +33pp | 5/0 | 0.0625 | $0.1420 | $0.1796 |

## Verdict

PASS: cell (model claude-haiku-4-5-20251001, difficulty easy) is a significant agentify win: 6 discordant pairs favor agentify vs 0 for baseline, sign-test p=0.03125

## Suite-level verdict (#322 rule, pooled gradeable pairs)

WINNER: **agentify** — pooled over 90 gradeable pairs: agentify 89/90 vs claude-code 57/90, discordant 32/0 spanning 2 task family(ies), sign-test p=4.65661e-10, Wilson CIs separated

- agentify 89/90 (99%, Wilson 94–99.8%) vs claude-code 57/90 (63%, Wilson 53–72.6%)
- non-gradeable excluded: agentify 0 harness error(s) + 0 invalid; claude-code 0 harness error(s) + 0 invalid
