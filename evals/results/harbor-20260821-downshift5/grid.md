# Model x difficulty grid

Aggregated from 30 run(s). Baseline arm: `claude-code`.
Cells show the agentify-baseline pass-rate delta and the discordant-pair count (agentify-only / baseline-only). Models are ordered weakest-first (top row = weakest baseline), so context is load-bearing when the delta is largest at the top and shrinks downward toward the stronger models.

| model \ difficulty | easy | medium | hard |
| --- | --- | --- | --- |
| claude-haiku-4-5-20251001 | +33pp (5/0) | +36pp (5/0) | +43pp (6/0) [x] |
| claude-sonnet-4-5-20250929 | +7pp (1/0) | +40pp (6/0) [x] | +38pp (5/0) |

`[x]` = >=5 discordant pairs favoring agentify at p<0.05 (the #317 acceptance target); `*` = significant but fewer than 5 discordant.

## Cells

| model | difficulty | agentify | baseline | delta | discordant (a/b) | sign p | cost/pass a | cost/pass b |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-haiku-4-5-20251001 | easy | 15/15 (100%) | 10/15 (67%) | +33pp | 5/0 | 0.0625 | $0.0675 | $0.0623 |
| claude-haiku-4-5-20251001 | medium | 14/14 (100%) | 9/14 (64%) | +36pp | 5/0 | 0.0625 | $0.0702 | $0.0530 |
| claude-haiku-4-5-20251001 | hard | 14/14 (100%) | 8/14 (57%) | +43pp | 6/0 | 0.0313 | $0.0683 | $0.0611 |
| claude-sonnet-4-5-20250929 | easy | 13/15 (87%) | 12/15 (80%) | +7pp | 1/0 | 1.0000 | $0.1437 | $0.1308 |
| claude-sonnet-4-5-20250929 | medium | 15/15 (100%) | 9/15 (60%) | +40pp | 6/0 | 0.0313 | $0.1234 | $0.1603 |
| claude-sonnet-4-5-20250929 | hard | 13/13 (100%) | 8/13 (62%) | +38pp | 5/0 | 0.0625 | $0.1291 | $0.1561 |

## Verdict

PASS: cell (model claude-haiku-4-5-20251001, difficulty hard) is a significant agentify win: 6 discordant pairs favor agentify vs 0 for baseline, sign-test p=0.03125

## Suite-level verdict (#322 rule, pooled gradeable pairs)

WINNER: **agentify** — pooled over 86 gradeable pairs: agentify 84/86 vs claude-code 56/86, discordant 28/0 spanning 2 task family(ies), sign-test p=7.45058e-9, Wilson CIs separated

- agentify 84/86 (98%, Wilson 91.9–99.4%) vs claude-code 56/86 (65%, Wilson 54.6–74.4%)
- non-gradeable excluded: agentify 0 harness error(s) + 0 invalid; claude-code 4 harness error(s) + 0 invalid
