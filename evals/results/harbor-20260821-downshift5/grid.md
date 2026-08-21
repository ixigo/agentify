# Model x difficulty grid

Aggregated from 30 run(s). Baseline arm: `claude-code`.
Cells show the agentify-baseline pass-rate delta and the discordant-pair count (agentify-only / baseline-only). Models are ordered weakest-first (top row = weakest baseline), so context is load-bearing when the delta is largest at the top and shrinks downward toward the stronger models.

| model \ difficulty | easy | medium | hard |
| --- | --- | --- | --- |
| claude-haiku-4-5-20251001 | +33pp (5/0) | +40pp (6/0) [x] | +47pp (7/0) [x] |
| claude-sonnet-4-5-20250929 | +7pp (1/0) | +40pp (6/0) [x] | +47pp (7/0) [x] |

`[x]` = >=5 discordant pairs favoring agentify at p<0.05 (the #317 acceptance target); `*` = significant but fewer than 5 discordant.

## Cells

| model | difficulty | agentify | baseline | delta | discordant (a/b) | sign p | cost/pass a | cost/pass b |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-haiku-4-5-20251001 | easy | 15/15 (100%) | 10/15 (67%) | +33pp | 5/0 | 0.0625 | $0.0675 | $0.0623 |
| claude-haiku-4-5-20251001 | medium | 15/15 (100%) | 9/15 (60%) | +40pp | 6/0 | 0.0313 | $0.0723 | n/a |
| claude-haiku-4-5-20251001 | hard | 15/15 (100%) | 8/15 (53%) | +47pp | 7/0 | 0.0156 | $0.0692 | n/a |
| claude-sonnet-4-5-20250929 | easy | 13/15 (87%) | 12/15 (80%) | +7pp | 1/0 | 1.0000 | $0.1437 | $0.1308 |
| claude-sonnet-4-5-20250929 | medium | 15/15 (100%) | 9/15 (60%) | +40pp | 6/0 | 0.0313 | $0.1234 | $0.1603 |
| claude-sonnet-4-5-20250929 | hard | 15/15 (100%) | 8/15 (53%) | +47pp | 7/0 | 0.0156 | $0.1279 | n/a |

## Verdict

PASS: cell (model claude-haiku-4-5-20251001, difficulty hard) is a significant agentify win: 7 discordant pairs favor agentify vs 0 for baseline, sign-test p=0.015625

## Suite-level verdict (#322 rule, pooled gradeable pairs)

WINNER: **agentify** — pooled over 90 gradeable pairs: agentify 88/90 vs claude-code 56/90, discordant 32/0 spanning 4 task family(ies), sign-test p=0, Wilson CIs separated

- agentify 88/90 (98%, Wilson 92.3–99.4%) vs claude-code 56/90 (62%, Wilson 51.9–71.5%)
- non-gradeable excluded: agentify 0 harness error(s) + 0 invalid; claude-code 0 harness error(s) + 0 invalid
