# Pre-registration: injection-FORMAT ablation at equal knowledge (#400)

**Committed before any trial ran.** This file is the pre-registered analysis
plan. It is committed on branch `eval/400-injection-format` in the same commit
as the arms (`evals/harbor/agents/injection_format_claude.py`) and suites
(`evals/harbor/suites/injection-format*.yaml`), and *before* the receipts
commit that adds `runs/`, `reports/`, and `campaign.json`. Git history is the
proof of order.

- Issue: ixigo/agentify#400 (parent epic #401).
- Builds on: the 2026-08-21 store-size ladder
  (`evals/results/harbor-20260821-storeladder`, write-up in
  `docs/benchmarks.md` "store-size ladder (a null result)").
- Harness: Harbor 0.18.0, dataset `agentify-context-bench`, model
  `claude-haiku-4-5-20251001`, subscription OAuth (no ANTHROPIC_API_KEY).
- Agentify under test: `github:ixigo/agentify#abb425e` (v0.5.0, current `main`),
  installed into each trial container.

## 1. Question

At **equal knowledge** — every arm is seeded the identical committed
300-note fixture store — Agentify's budgeted injection trailed plain
`CLAUDE.md` stuffing on the store ladder (20/27 vs 24/27), with the deficit
concentrated in one scenario (recall-retry-schedule, 3/9 vs 6/9). Retrieval
*plumbing* was ruled out (the needle is ranked and delivered). The two
surviving hypotheses were injection **FORMAT/POSITION** and **noise**. This
campaign tests format/position by decomposing it into two axes and measuring
each against the stuffing ceiling.

## 2. Arms (4), knowledge held equal

All arms share the same task image, model, `$0.70` per-trial budget cap, 16
turn cap, permission mode, and the same `/opt/agentify-fixtures` seeded into
`.agentify/context`. The only variable is how the SAME knowledge reaches the
model. Arm code is eval-only (env overrides + one render step); no product
code path changed.

| arm | delivery | selection | persistence | mechanism |
| --- | --- | --- | --- | --- |
| `agentify` (baseline) | matched digest injected once at the prompt | Agentify BM25, 1200-tok budget | once (first turn, stays in transcript) | current default (`relevant` mode) |
| `fullnote-claude` | matched digest injected once at the prompt | Agentify BM25, **budget lifted** (`AGENTIFY_CTX_BUDGET=100000`) | once | full notes, no budget trimming |
| `persist-claude` | the same matched digest written into `CLAUDE.md`, hook injection off | Agentify BM25, 1200-tok budget | **every turn** (persistent file) | once-at-prompt vs. present-every-turn |
| `memorybank-claude` | whole store stuffed verbatim into `CLAUDE.md` | **none** (all 300 notes) | every turn | reference ceiling |

- `agentify` vs `fullnote-claude` isolates the **budget/compaction** half of the
  format hypothesis.
- `agentify` vs `persist-claude` isolates the **position/persistence** half.
- `{agentify, fullnote-claude, persist-claude}` vs `memorybank-claude` is the
  **headline**: does any Agentify injection format reach the stuffing ceiling?

## 3. Trials and n

Two jobs, 180 trials total:

- **deep** (`suites/injection-format-deep.yaml`): `recall-retry-schedule-store300`
  only — the separator — **4 arms × 21 attempts = 84 trials**.
- **controls** (`suites/injection-format.yaml`): `avoid-cache-regression-store300`
  and `recall-webhook-signature-store300` (both near-ceiling on the ladder) —
  **2 tasks × 4 arms × 12 attempts = 96 trials**.

Per arm: retry-schedule n=21, each control n=12, pooled n=45. A smoke
(`injection-format-smoke.yaml`, 4 trials) runs first to catch harness errors
and is NOT graded or imported into the published numbers.

Spend ceiling (token-free `plan`): deep $58.80 + controls $67.20 = **$126.00**
worst case; expected ≈ $14 at the ladder-deep $0.077/attempt rate. The design
is held at ~180 trials; if power proves insufficient the response is to
report the limitation, not to silently expand (same discipline as the ladder).

## 4. Primary metric and verdict rule (pre-registered)

**Primary metric:** per-arm pass rate (Harbor binary verifier), with Wilson 95%
intervals.

**Primary comparison:** paired **two-sided sign test on discordant pairs**
between each Agentify-format arm and `memorybank-claude`, pairing attempts by
`(task, repeat_index)` — the same test the earlier campaigns pre-registered.
The headline unit is the **retry-schedule** task (n=21 pairs), with the pooled
three-scenario result (n=45 pairs) reported as secondary. Reporting the exact
discordant split (b vs c), the sign-test p, and both Wilson intervals for every
pair is mandatory regardless of significance.

**Decision rule (fail-closed):**

1. **A format closes the gap** iff, for `fullnote-claude` OR `persist-claude`
   vs `memorybank-claude` on retry-schedule, the discordant split favours the
   Agentify arm (or is balanced) AND the sign test does **not** show
   memorybank significantly ahead at α = 0.05 — i.e. that arm is no longer
   detectably behind stuffing — AND that same arm is significantly ahead of the
   `agentify` baseline (sign test, α = 0.05) so the format change, not noise, is
   doing the work. In that case the format is shipped as the product default in
   a **separate** follow-up commit with tests, citing these receipts.
2. **Null result** otherwise: if neither format arm separates from the baseline
   and both remain behind memorybank by the same margin the ladder found, the
   format/position hypothesis is **retired** and published as such. The public
   claim stays "memory vs no memory". The write-up must then state the residual
   cause the data points to.
3. A point estimate alone never moves the claim; only the pre-registered sign
   test does. No equivalence ("as good as stuffing") is claimed without a
   pre-declared non-inferiority margin, which this suite does not run.

**Direction note / registered prediction (corrected pre-trial).** A token-free
diagnostic run before launch (`agentify ctx explain` on the **verbatim**
`instruction.md`, reproduced in `retrieval-diagnostic.md`) shows that at current
fixtures (dataset 1.2.0) Agentify's selector retrieves **every** answer-bearing
needle on all three scenarios — including, on retry-schedule, BOTH the lane note
(#c2901335, rank 1) and the delay-schedule note (ADR-42 #72c2540c, rank 2, score
8.59), which the real instruction's "recovery queue / production worker" terms
pull in. (An earlier draft of the diagnostic used a hand-paraphrase that dropped
those terms, scored ADR-42 at 0, and wrongly predicted a retrieval-driven null;
that error was caught before any trial was graded and is documented in
`retrieval-diagnostic.md`.) The revised prediction: because the delivered
knowledge is already correct and equal across `agentify`, `fullnote-claude`, and
`persist-claude`, the two format arms should move outcomes **little** (no missing
note for a bigger budget or a persistent copy to add). The live question is
whether `memorybank-claude` still leads: its whole-store CLAUDE.md is ~520k
cache-read tokens per turn and a smoke trial of it hit `error_max_turns` (17 >
16, scored a fail), so stuffing's ladder edge may shrink or reverse here. This is
a genuine open experiment; the verdict rule above is unchanged and decides it
either way.

## 5. Validity: what counts as a trial, a fail, a harness_error

Same contract as the prior Harbor campaigns (see
`evals/results/README.md` and the #322/downshift campaign notes):

- **valid pass / valid fail** — the graded `claude -p` phase ran and the
  verifier scored it. A graded-phase crash, timeout, or budget-exhaustion
  counts as a **fail against that arm** (the arm is responsible for finishing
  within its own cap). The persist arm's render step is best-effort: an empty
  CLAUDE.md block degrades the arm toward plain and is scored honestly, never
  excluded.
- **harness_error / invalid (excluded, not counted for any arm)** — a failure
  *before* the graded model ran that is the host's fault, not the arm's:
  image build failure, `npm install` of Claude Code / Agentify failing,
  container/exec infrastructure errors, or a provider-reported-inactive attempt
  (e.g. a subscription rate-limit / 429 with zero model activity). These are
  logged in `campaign.json.notes` with their count and re-run when feasible;
  they never silently shrink a cell. Only zero-model-activity attributable to
  the host is excluded — the same rule that governed every prior campaign.
- If the subscription rate-limits mid-run, the job is paused and resumed (or the
  affected trials re-run) rather than abandoned; the pause is recorded in the
  campaign notes.

## 6. Receipts and verification

On completion: import each job (`agentify eval harbor import`), copy the run
dirs into `runs/`, regenerate `reports/` and `campaign.json` aggregates with
`node evals/results/verify.mjs --write`, and commit runs + reports + docs
together. `test/eval-receipts.test.js` (which runs `verify.mjs`) gates that the
published per-arm aggregates reproduce from the committed raw runs. The
paired sign tests and Wilson intervals are computed from the same committed run
dirs by `analysis.mjs` in this directory, so every number in the write-up is
reproducible from receipts.
