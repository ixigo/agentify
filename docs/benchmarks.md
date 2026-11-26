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
| 2026-08-19 | multisession + crossvendor + downshift | downshift 51/54 vs 36/54 pairs | **Winner** (16/1, p = 2.8e-4) |
| 2026-08-20 | First competitor head-to-head, 4 arms | stuffing 37/40, agentify 36/40, serena 27/40, plain 26/40 | **No difference detected** vs stuffing; strong vs plain/serena |
| 2026-08-21 | Five-family downshift, 180 trials | agentify 84/86 vs 56/86 | **Winner** (28/0, p = 7.5e-9) + per-cell target met |
| 2026-08-21 | Store-size ladder, 135 trials | stuffing 24/27 vs agentify 20/27 vs plain 2/27 | **No difference detected** vs stuffing; decisive vs plain |
| 2026-11-25 | Injection-format ablation, 180 trials | agentify 31/45, full-note 35/45, persist 36/45, stuffing 32/45 | **Null on format**; the ladder's stuffing edge did not reproduce |
| 2026-11-25 | Downshift **replication** on v0.5.0, 180 trials (×3 runs) | agentify 89/90 vs 57/90 | **Replicated** — Winner agentify (32/0, p = 4.7e-10) in all three runs |

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

- **downshift** (3 families × 3 difficulties × 2 usable model rungs): arm
  totals **51/56 vs 36/56** gradeable attempts. The paired verdict is computed
  over the **54 pairs** where both arms have a gradeable attempt — **51/54 vs
  36/54** — discordant **16/1 spanning two task families**, sign p = 2.75e-4,
  Wilson separated (84.9–98.1% vs 53.4–77.8%). Read the CIs against the
  54-pair denominator, not the 56-attempt one. Cost per passing task flips
  agentify-cheaper on the `sonnet-4-5` rungs ($0.150 vs $0.192 at hard).
- **multisession**: 3/3 both arms — a tie, but with the first measured
  rediscovery receipt: the baseline burned **147,508 more phase-B tokens**
  re-exploring what the agentify arm recalled. Cost break-even honestly
  `not reached` at haiku prices.
- **crossvendor** (Codex seeds → Claude recalls): all ties. `haiku-4-5`
  rediscovers the seeded gotcha without memory, so these tasks need harder
  variants before the suite can separate.

Receipts: `harbor-20260819`. The `claude-3-5-haiku` rung is why the ladder is
now two rungs: of its 54 attempts, **50 returned the API-404 shape** with an
all-zero usage envelope (the model is not served to subscription accounts —
infrastructure void, not model weakness) and are excluded as non-gradeable.
The other **4 lost telemetry mid-run and are graded as failures**, so they are
inside the 56-attempt totals above. The rung is mostly, not entirely, void.

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
vs full notes re-read every turn) or noise at 9 attempts per scenario — both
**settled by the 2026-11-25 injection-format ablation below** (format: null;
the gap itself did not reproduce at equal, retrieved knowledge).

Roadmap consequence: **store size does not justify semantic-retrieval work** —
BM25 is not the bottleneck here. Receipts: `harbor-20260821-storeladder`.

### 2026-11-25 — injection-format ablation (the null, confirmed)

The ladder left two live explanations for its point-estimate gap: injection
**format/position**, or noise. This campaign decomposed format at equal
knowledge on the same store300 tasks — every arm seeded the identical 300-note
fixture, every arm's needle retrieved (verified token-free before launch;
`retrieval-diagnostic.md`). Four arms, 180 trials, `claude-haiku-4-5`, ~$12,
**0 harness errors**. Pre-registration — hypotheses, arms, n, the paired
sign-test verdict rule, and the harness/exclusion rules — was committed
*before any trial ran* (`PREREGISTRATION.md`).

- `agentify` — the baseline: a budgeted matched digest injected once at the prompt.
- `full-note` (`fullnote-claude`) — the same pipeline with the injection token
  budget lifted, so nothing is trimmed.
- `persist` (`persist-claude`) — the same selection pinned into `CLAUDE.md`,
  present on every turn, hook injection off.
- `memorybank-claude` — the whole store stuffed into `CLAUDE.md`, the ceiling.

**Pooled over three scenarios (n = 45 per arm):**

| arm | passes | Wilson 95% |
| --- | --- | --- |
| persist | **36/45 (80.0%)** | 66.2–89.1% |
| full-note | **35/45 (77.8%)** | 63.7–87.5% |
| memorybank-claude | 32/45 (71.1%) | 56.6–82.3% |
| agentify | 31/45 (68.9%) | 54.3–80.5% |

Pre-registered paired sign test **vs stuffing** (discordant pairs): agentify
7/8 (p = 1.0), full-note 7/4 (p = 0.55), persist 8/4 (p = 0.39) — **no arm
differs from the memory bank**. No format arm beats the baseline either
(full-note vs agentify p = 0.45, persist vs agentify p = 0.23). The
format/position hypothesis is **retired, not shipped** (pre-registered Rule 2):
nothing changed in the product.

**The deficit itself did not reproduce.** On the retry-schedule separator — the
one scenario that carried the ladder's whole gap — the result inverts:

| arm | retry-schedule (n = 21) |
| --- | --- |
| full-note | 13/21 (61.9%) |
| persist | 12/21 (57.1%) |
| agentify | 9/21 (42.9%) |
| memorybank-claude | **8/21 (38.1%)** |

`agentify` vs stuffing is 7/6 discordant (p = 1.0), and stuffing is the
**weakest** arm here. The cause is mechanical and now measured: the current
fixtures (dataset 1.2.0, regenerated since the ladder's 1.1.0) make the
retry-schedule delay needle retrievable from the verbatim instruction — the
selector returns both the lane note **and** ADR-42 (the exact `1s,1s,2s,3s,5s`
schedule) — so injection delivers the full answer, and the only differentiator
left, the 16-turn cap, cuts *against* the memory bank: its whole-store
`CLAUDE.md` is ~520k cache-read tokens per turn, and several stuffing attempts
exhausted the cap (`error_max_turns`, scored as fails per the pre-registered
rule) — the context tax made physical. The two control scenarios sit at
ceiling for every arm (cache 12/12 all arms; webhook 10–12/12). Sign tests and
intervals regenerate from the receipts via `analysis.mjs`.

Roadmap consequence: **injection format is not the lever** — at equal, retrieved
knowledge the four deliveries are statistically indistinguishable, so there is
no format change to ship. Receipts: `harbor-20261125-injection-format`.

### 2026-11-25 — downshift replication on v0.5.0 (replicated)

A pre-registered replication of the strongest result — the five-family downshift
matrix — on the current release. Same committed suite (15 tasks × 2 arms × 3
attempts × 2 rungs = 180 trials), same arms, caps, attempts, and the **same
pre-registered #322 verdict rule**. The intended variable is the agentify version
(0.4.0 → **0.5.0**, tag `v0.5.0`); the dataset also moved 1.1.0 → **1.2.0** (a
genuine confound, recorded below). Pre-registration and deviations were committed
before any graded trial (`PREREGISTRATION.md`, `DEVIATIONS.md`).

**Result: replicated.** Suite-level **WINNER agentify** (all three clauses), same
direction as August, discordant spanning the **same two families**
(avoid-unbounded-fanout + avoid-cache-regression; the other three tie).

> **Primary run** (`2026-11-26__12-18-47`), pooled over 90 matched gradeable
> pairs: agentify **89/90 (98.9%)** vs plain claude-code **57/90 (63.3%)**,
> discordant **32/0 spanning two families**, exact sign p = **4.66e-10**, Wilson
> CIs separated (94.0–99.8% vs 53.0–72.5%). The per-cell #317 target is met in
> **four** cells (haiku easy/medium/hard 6/0 each; sonnet medium 6/0) — up from
> two in August.

| campaign | agentify | claude-code | discordant | sign p | verdict |
| --- | --- | --- | --- | --- | --- |
| 2026-08-21 (v0.4.0, 1.1.0) | 84/86 (98%) | 56/86 (65%) | 28/0 | 7.45e-9 | Winner |
| 2026-11-25 (v0.5.0, 1.2.0) | 89/90 (99%) | 57/90 (63%) | 32/0 | 4.66e-10 | **Winner** |

**Three full runs, reported in full.** `harbor job resume` re-runs the whole
suite fresh (not just failed trials), so the recovery of the original run's
install-phase host-faults produced three complete 180-trial runs. The verdict is
**identical across all three**, which is the guard against after-the-fact
selection; the primary is the only run with zero excluded harness-errors (chosen
by a completeness rule set after the runs — see `DEVIATIONS.md` D7):

| run | pairs | agentify | claude-code | discordant | sign p | Winner? |
| --- | --- | --- | --- | --- | --- | --- |
| A original (conc 2) | 66 | 64/66 | 39/66 | 25/0 | 5.96e-8 | yes |
| B resume #1 (conc 2) | 66 | 65/66 | 43/66 | 22/0 | 4.77e-7 | yes |
| C resume #2 (conc 1, **primary**) | 90 | 89/90 | 57/90 | 32/0 | 4.66e-10 | yes |

**Deviations (full list in `DEVIATIONS.md`).** (D6) v0.5.0 bumped
`better-sqlite3` to 13, whose prebuilt aarch64 binding SIGSEGVs during the
install-time index build; since the downshift recall path is file-based and
never touches it, the harness install skipped that index build
(`--no-index`, env-gated) — the v0.5.0 product source is byte-identical. (D2)
dataset 1.2.0 fixtures make more needles retrievable than 1.1.0; the hard/medium
variants still strip the instruction hint, so the memoryless baseline cannot
recover the seeded decision and the direction replicates. (D7) the three-run
situation and primary-selection rule above. Every number regenerates from the
committed runs via `analysis.mjs`; receipts: `harbor-20261125-downshift5-replication`.

## What we claim, and what we don't

**Supported today.** Against the same agent with **no memory layer**, durable
repo memory turns realistic regression traps — where the fix lives only in
recorded project history — from a coin flip into a near-certainty: 28/0
discordant at p = 7.5e-9 on the five-family matrix, 18/0 at p = 8e-6 on the
store ladder.

Separately, and against a **memory-enabled competitor**: 9/0 discordant
against Serena, which was given the same seeded knowledge in its own native
`.serena/memories` and still did not recover it (0/5 on
`avoid-cache-regression`). That is a result about one competitor's retrieval,
not about having a memory layer at all, and it belongs in its own row.

**Not supported.** That Agentify beats a hand-maintained `CLAUDE.md` memory
bank. Three independent campaigns detected no significant difference: the
2026-08-20 head-to-head and the 2026-08-21 store ladder, whose point estimates
favoured the memory bank, and the 2026-11-25 injection-format ablation at equal
knowledge, whose point estimates slightly favoured the Agentify arms (with
stuffing the weakest arm on the one hard scenario, where its whole-store context
ran into the turn cap). Across all three the paired sign test is
non-significant, so the honest summary is **no detected difference either
way** — not an Agentify win, and not the memory bank's. Equivalence is not
claimed either; no non-inferiority test has been run. That is published, not
buried.

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
| Downshift quoted `51/56` attempts alongside CIs computed over 54 *pairs* | Both denominators now stated, with the paired figure (`51/54`) as the headline |
| "The whole void rung was excluded" | 50 of its 54 attempts were API-404s; the other **4 count as failures** inside the arm totals |
| Serena's 9/0 was pooled with the no-memory results | Split out: Serena had the same knowledge in its own native memories, so it is a competitor result, not a no-memory one |

## Reproducing

```bash
node evals/results/verify.mjs              # rebuild every committed receipt and diff it
node evals/results/harbor-20261125-injection-format/analysis.mjs  # paired sign tests + Wilson CIs from the run dirs
node evals/results/harbor-20261125-downshift5-replication/analysis.mjs  # three-run replication side-by-side vs August
node evals/harbor/tools/diagnose-injection.mjs   # token-free retrieval/completeness check
agentify eval harbor validate              # dataset schema + answer-leak checks, token-free
agentify eval harbor plan --suite <name>   # worst-case spend before any paid run
```

Paid suites are opt-in and never run in CI; `.github/workflows/bench.yml`
runs only the token-free validation, receipt verification, and spend
ceilings on a schedule.
