# Model x difficulty grid

Aggregated from 27 run(s). Baseline arm: `claude-code`.
Cells show the agentify-baseline pass-rate delta and the discordant-pair count (agentify-only / baseline-only). Models are ordered weakest-first (top row = weakest baseline), so context is load-bearing when the delta is largest at the top and shrinks downward toward the stronger models.

| model \ difficulty | easy | medium | hard |
| --- | --- | --- | --- |
| claude-3-5-haiku-20241022 | +0pp (0/0) | +0pp (0/0) | +0pp (0/0) |
| claude-haiku-4-5-20251001 | +33pp (3/0) | +33pp (3/0) | +33pp (3/0) |
| claude-sonnet-4-5-20250929 | +0pp (1/1) | +33pp (3/0) | +33pp (3/0) |

`[x]` = >=5 discordant pairs favoring agentify at p<0.05 (the #317 acceptance target); `*` = significant but fewer than 5 discordant.

## Cells

| model | difficulty | agentify | baseline | delta | discordant (a/b) | sign p | cost/pass a | cost/pass b |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-3-5-haiku-20241022 | easy | 0/9 (0%) | 0/9 (0%) | +0pp | 0/0 | 1.0000 | n/a | n/a |
| claude-3-5-haiku-20241022 | medium | 0/9 (0%) | 0/9 (0%) | +0pp | 0/0 | 1.0000 | n/a | n/a |
| claude-3-5-haiku-20241022 | hard | 0/9 (0%) | 0/9 (0%) | +0pp | 0/0 | 1.0000 | n/a | n/a |
| claude-haiku-4-5-20251001 | easy | 8/9 (89%) | 5/9 (56%) | +33pp | 3/0 | 0.2500 | n/a | n/a |
| claude-haiku-4-5-20251001 | medium | 9/9 (100%) | 6/9 (67%) | +33pp | 3/0 | 0.2500 | $0.0572 | $0.0573 |
| claude-haiku-4-5-20251001 | hard | 9/9 (100%) | 6/9 (67%) | +33pp | 3/0 | 0.2500 | $0.0658 | $0.0582 |
| claude-sonnet-4-5-20250929 | easy | 7/9 (78%) | 7/9 (78%) | +0pp | 1/1 | 1.0000 | n/a | n/a |
| claude-sonnet-4-5-20250929 | medium | 9/9 (100%) | 6/9 (67%) | +33pp | 3/0 | 0.2500 | $0.1535 | $0.1723 |
| claude-sonnet-4-5-20250929 | hard | 9/9 (100%) | 6/9 (67%) | +33pp | 3/0 | 0.2500 | $0.1499 | $0.1918 |

## Verdict

NOT MET: no cell reached >=5 discordant pairs favoring agentify at p<0.05 — context is not yet decisively load-bearing in this grid
