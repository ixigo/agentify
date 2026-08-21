# Benchmarks: what has actually been measured

Every number here is backed by committed receipts under
[`evals/results/`](../evals/results/README.md) — the raw imported runs plus the
report each one produces — and `test/eval-receipts.test.js` fails CI if the
current code stops reproducing them. Numbers that moved after review are shown
with what they were, because the corrections are part of the evidence.

- Harness mechanics: [`docs/harbor.md`](harbor.md) (container suites, arms,
  fairness rules) and [`docs/swebench.md`](swebench.md).
- Receipts layout and how to add a campaign:
  [`evals/results/README.md`](../evals/results/README.md).

## The three harnesses

| Harness | What it is | Cost |
| --- | --- | --- |
| `agentify eval` (native) | Paired arms on one repo task in disposable clones at a pinned `base_ref`, deterministic graders, hard per-attempt budget/turn/timeout ceilings | Paid, per run |
| **Harbor** (Terminal-Bench 2.0) | 38 container tasks under `evals/harbor/`, our own dataset `agentify-context-bench`; catches anything that only looks like a win inside Agentify's own runner | Paid, per run; `validate`/`plan`/`import` are token-free |
| **SWE-bench Verified** | Optional repo-warm-up experiment over a pinned, bounded sample, graded by the official Docker harness | Paid; never run yet |

The arms that recur below:

- `agentify` — normal integration: hooks, guidance block, seeded context store.
- `plain-claude` / `claude-code` / `plain-safe` — the same model with no memory
  layer (`plain-claude` is a pinned parity baseline sharing our exact
  invocation code; harbor's builtin `claude-code` pins no version and applies
  no turn cap).
- `memorybank-claude` — the same knowledge stuffed verbatim into `CLAUDE.md`
  (the zero-infrastructure practice).
- `serena-claude` — [Serena](https://github.com/oraios/serena) MCP 1.7.0, the
  free LSP code-intelligence competitor, same knowledge as native
  `.serena/memories`.

## Results so far

| Date | Campaign | Headline | Verdict |
| --- | --- | --- | --- |
| 2026-07-14 | Harbor nightly, 8 tasks | agentify 24/24 vs 21/24 | **No winner** (3 discordant, p = 0.25) |
| 2026-07-29 | MCP description ablation (native) | agentify 9/18 vs plain-safe 12/18 | **Lost**; ~zero tool calls |
| 2026-08-19 | multisession + crossvendor + downshift | downshift 51/56 vs 36/56 | **Winner** (16/1, p = 2.8e-4) |
| 2026-08-20 | First competitor head-to-head, 4 arms | stuffing 37/40, agentify 36/40, serena 27/40, plain 26/40 | **No difference detected** vs stuffing; strong vs plain/serena |
| 2026-08-21 | Five-family downshift, 180 trials | agentify 84/86 vs 56/86 | **Winner** (28/0, p = 7.5e-9) + per-cell target met |
| 2026-08-21 | Store-size ladder, 135 trials | stuffing 24/27 vs agentify 20/27 vs plain 2/27 | **No difference detected** vs stuffing; decisive vs plain |

### 2026-07-14 — first paired Harbor nightly

8 tasks × 2 arms × 3 attempts, `claude-haiku-4-5`, $2.10 of a $16.80 ceiling.
Agentify **24/24**, plain Claude Code **21/24**. All three baseline failures
landed on the prior-failure-avoidance task, where a recorded production
incident is the only thing separating the arms. Both honesty controls held
(the mechanical task and the misleading-note task tied 3/3). **No winner
declared**: 3 discordant pairs give p = 0.25 with overlapping intervals.
Cost: $0.055/attempt vs $0.033 (+66%). Receipts: `harbor-20260714`.

### 2026-07-29 — MCP description ablation

The first executed runs of `evals/mcp-descriptions` (6 runs, 39 attempts).
Agentify **9/18**, plain-safe **12/18**, the alternate description set 2/3.
The suite's own premise failed: across all attempts exactly **one** made any
`mcp__agentify__*` call, so the ablation compared 0 vs 0 and **no description
was adopted**. Consequence shipped: the server now sends initialize
`instructions` stating *when* to reach for each tool. Receipts:
`native-20260729`.

### 2026-08-19 — multisession, cross-vendor, and the first downshift matrix

- **downshift** (3 families × 3 difficulties × 2 model rungs): **51/56 vs
  36/56**, discordant **16/1 spanning two task families**, sign p = 2.75e-4,
  Wilson separated. Cost per passing task flips agentify-cheaper on the
  `sonnet-4-5` rungs ($0.150 vs $0.192 at hard).
- **multisession**: 3/3 both arms — a tie, but with the first measured
  rediscovery receipt: the baseline burned **147,508 more phase-B tokens**
  re-exploring what the agentify arm recalled. Cost break-even honestly
  `not reached` at haiku prices.
- **crossvendor** (Codex seeds → Claude recalls): all ties. `haiku-4-5`
  rediscovers the seeded gotcha without memory, so these tasks need harder
  variants before the suite can separate.

Receipts: `harbor-20260819`. The whole `claude-3-5-haiku` rung (54 attempts)
is excluded as void — the subscription stopped serving that model and every
attempt returned API 404 — which is why the ladder is now two rungs.

### 2026-08-20 — first competitor head-to-head

8 tasks × 4 arms × 5 attempts, same image/model/budget/verifier per arm, each
armed arm given the **same** fixture knowledge in its own tool's native
format. $9.17 of reported provider subtotals covering 155/160 attempts.

| arm | passes |
| --- | --- |
| memorybank-claude (CLAUDE.md stuffing) | 37/40 |
| agentify | 36/40 |
| serena-claude | 27/40 |
| plain-claude | 26/40 |

- **vs plain Claude Code**: discordant **10/0**, sign p = 1.95e-3 — a strong
  directional result, but the pooled Wilson intervals still overlap at five
  attempts per task, so the fail-closed rule declares **no winner**.
- **vs Serena**: discordant **9/0**. The leading free code-intelligence MCP
  did not recover the seeded incident knowledge even from its own native
  memories (0/5 on `avoid-cache-regression`).
- **vs CLAUDE.md stuffing**: a **statistical tie** (3/2 for the memory bank).
  Published under our own guardrail: a competitor matching Agentify is a
  finding to act on, not to bury. It is what motivated the store-size ladder.

Receipts: `harbor-20260820-headtohead`.

### 2026-08-21 — five-family downshift (the strongest result)

15 tasks (5 scenario families × 3 difficulties) × 2 arms × 3 attempts × 2
model rungs = 180 trials. Both pre-registered fail-closed rules are met **by
the tool**, not by hand:

> **Suite-level:** agentify **84/86 (98%)** vs plain claude-code **56/86
> (65%)** over 86 pooled gradeable pairs, discordant **28/0 spanning two task
> families**, exact sign p = **7.45e-9**, Wilson CIs separated (91.9–99.4% vs
> 54.6–74.4%).
>
> **Per-cell target** (≥5 discordant in a single model×difficulty cell at
> p < 0.05): **met for the first time**, in two cells.

The newest task family — cap-the-parallel-fanout, added days earlier — is the
single biggest separator (16 of the 28 wins). Three of the five families tied
outright. Receipts: `harbor-20260821-downshift5`.

### 2026-08-21 — store-size ladder (a null result)

Built to settle the head-to-head tie at realistic store sizes: the same
knowledge buried among deterministic decoys, larger rungs strict supersets of
smaller ones, all rungs under one uniform cap. Two jobs, 135 trials, $10.18 reported.

**store300, pooled over three scenarios (n = 27 per arm):**

| arm | passes | Wilson 95% | cost |
| --- | --- | --- | --- |
| memorybank-claude | **24/27 (88.9%)** | 71.9–96.2% | $2.09 |
| agentify | **20/27 (74.1%)** | 55.3–86.8% | $2.18 |
| plain-claude | 2/27 (7.4%) | 2.1–23.4% | $1.76 |

- **vs plain**: discordant **18/0**, p = 8.0e-6 — decisive.
- **vs stuffing**: discordant **2/6**, p = 0.29 — **no significant difference
  detected**, with the point estimate favouring stuffing, at similar cost.

So at 100–300 note stores this campaign found **no evidence that budgeted
retrieval outperforms dumping the whole store into `CLAUDE.md`** — and it is
not an equivalence result either: at n = 27 per arm the data cannot separate a
real deficit from noise, and proving "as good as" would need a pre-declared
margin and a non-inferiority test. The cost figures likewise show no
measurable context-tax penalty at this scale rather than proving none exists. Two committed token-free diagnostics
(`evals/harbor/tools/diagnose-injection.mjs`) rule out the comfortable
explanations: each scenario's needle rank is measured at every rung and is never worse at
300 notes than at 10, and **every** real note survives the token budget.
Agentify receives exactly the right knowledge and converts it less often on
one of three scenarios. Live hypotheses: injection **format** (compact digest
vs full notes re-read every turn) or noise at 9 attempts per scenario.

Roadmap consequence: **store size does not justify semantic-retrieval work** —
BM25 is not the bottleneck here. Receipts: `harbor-20260821-storeladder`.

## What we claim, and what we don't

**Supported today.** Durable repo memory turns realistic regression traps —
where the fix lives only in recorded project history — from a coin flip into a
near-certainty, versus the same agent with no memory layer: 28/0 discordant at
p = 7.5e-9 on the five-family matrix, 18/0 at p = 8e-6 on the store ladder,
9/0 against Serena.

**Not supported.** That Agentify beats a hand-maintained `CLAUDE.md` memory
bank. Two independent campaigns detected no significant difference at small
and medium store sizes, with point estimates favouring the memory bank, at
similar cost. Equivalence is not claimed either — no non-inferiority test has
been run. That is published, not buried.

**Never claimed.** Leaderboard standing. This is Agentify's own 38-task
context benchmark on our own hardware; every campaign discloses its scope,
its exclusions, and its uncosted attempts.

## Corrections log

Reviews repeatedly moved published numbers **down**. Kept here because a
benchmark whose corrections are invisible is not evidence.

| Correction | Effect |
| --- | --- |
| Harness errors were graded as arm failures (#367) | Whole void model rung excluded; verdicts recomputed on gradeable attempts only |
| Four "wins" had a *crashed* baseline opposite them | 32/0 across 4 families → **28/0 across 2**; qualifying cells 4 → 2 |
| Harbor exceptions serialized as `[object Object]` | Fixed to keep `exception_type`; install-phase failures now non-gradeable, and auditable |
| "Decisive" claimed while Wilson CIs overlapped | Head-to-head restated as a strong *directional* result, no declared win |
| Cost quoted without coverage | Head-to-head cost shown as subtotals over 155/160 attempts; cheaper-arm conclusion withdrawn |
| `sign_test_p` rounded to six decimals | Published an impossible exact `p = 0`; now six significant digits |
| Harbor silently dropped three tasks | Rung ids zero-padded, guard test added; the small rung is absent rather than reported |

## Reproducing

```bash
node evals/results/verify.mjs              # rebuild every committed receipt and diff it
node evals/harbor/tools/diagnose-injection.mjs   # token-free retrieval/completeness check
agentify eval harbor validate              # dataset schema + answer-leak checks, token-free
agentify eval harbor plan --suite <name>   # worst-case spend before any paid run
```

Paid suites are opt-in and never run in CI; `.github/workflows/bench.yml`
runs only the token-free validation, receipt verification, and spend
ceilings on a schedule.
