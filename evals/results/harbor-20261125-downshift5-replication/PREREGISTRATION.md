# Pre-registration: five-family downshift REPLICATION on agentify v0.5.0

**To be committed before any graded trial** on branch
`eval/downshift5-replication-202611`, in the same commit as this file and
*before* the receipts commit that adds `runs/`, `reports/`, and
`campaign.json`. Git history is the proof of order.

- Replicates: the 2026-08-21 five-family downshift campaign
  (`evals/results/harbor-20260821-downshift5/`, write-up in
  `docs/benchmarks.md` "2026-08-21 — Five-family downshift").
- Harness: Harbor 0.18.0, dataset `agentify-context-bench` **1.2.0** (current
  `main`; August ran **1.1.0** — see Deviations), models
  `claude-haiku-4-5-20251001` and `claude-sonnet-4-5-20250929`, subscription
  OAuth (CLAUDE_FORCE_OAUTH=1, no ANTHROPIC_API_KEY).
- Agentify under test: `github:ixigo/agentify#v0.5.0` (tag), resolved commit
  `dfcfb3c0007e2d517ee4e51cee09ec275a97f646`, package.json version 0.5.0.
  August ran `github:ixigo/agentify#7cd5351` (0.4.0).

## 1. Question

August's headline: on the 5-family × 3-difficulty × 2-rung matrix, Agentify
(durable repo memory) beat plain Claude Code decisively — suite-level WINNER
agentify, 84/86 vs 56/86, discordant 28/0 spanning 2 families, exact sign
p = 7.45e-9, Wilson CIs separated, with the #317 per-cell target met in 2
cells. **Replication question:** on agentify v0.5.0 (current release), do the
direction and significance hold? Same suite, tasks, arms, caps, attempts, and
the SAME pre-registered verdict rule.

## 2. Arms, tasks, n (identical to August)

- Suite: `evals/harbor/suites/downshift.yaml` (unchanged), 15 tasks =
  5 scenario families × 3 difficulties:
  recall-error-envelope, avoid-cache-regression, reject-stale-config-path,
  avoid-unbounded-fanout, avoid-roster-mutation — each at easy/medium/hard.
- Arms (2): `agentify` (`agents.agentify_claude:AgentifyClaudeAgent`,
  profile=balanced, max_budget_usd=0.35, max_turns=16) and `claude-code`
  (Harbor builtin baseline, max_budget_usd=0.35, no turn cap) — the exact two
  arms August used.
- Rungs (2): `anthropic/claude-haiku-4-5-20251001` (weakest accessible) and
  `anthropic/claude-sonnet-4-5-20250929` (stronger).
- n: 15 tasks × 2 arms × 3 attempts × 2 rungs = **180 trials.**
- Spend ceiling (token-free `plan`): 180 × $0.35 = **$63.00** worst case.
- A smoke (1 task × 2 arms × 1 attempt × 2 rungs = 4 trials) runs first to
  catch harness errors and is NOT graded or imported into published numbers.

## 3. Primary metric and verdict rule (pre-registered, SAME as August)

**Primary metric:** per-arm pass rate (Harbor binary verifier), Wilson 95%
intervals, pooled over gradeable attempts.

**Primary comparison:** paired two-sided sign test over discordant pairs,
pairing attempts by `(task, model, repeat_index)`.

**Suite-level winner (epic #322 rule, fail-closed on every clause):** declare
WINNER agentify iff **all** hold —
1. ≥5 discordant pairs favouring agentify, **spanning ≥2 distinct task
   families** (difficulty variants collapse into one family);
2. exact sign-test p < 0.05;
3. pooled Wilson 95% intervals for the two arms do **not** overlap.

**Secondary (per-cell #317 target):** a (model × difficulty) cell meets the
target iff ≥5 discordant pairs favour agentify at sign p < 0.05.

**Replication verdict (decided only by the rule above, computed from
receipts):**
- **Replicated** — suite-level WINNER agentify holds (all three clauses), same
  direction as August.
- **Weaker / partial** — direction favours agentify but at least one clause
  fails (e.g. fewer discordant pairs, one family, or overlapping Wilson).
- **Not replicated** — direction does not favour agentify, or no separation.

A point estimate never moves the verdict; only the pre-registered sign test +
Wilson separation do.

## 4. Validity: trial / fail / harness_error (SAME contract)

Per `evals/results/README.md` and the #322/#367 rules, enforced by
`isGradeableAttempt`:
- **valid pass / valid fail** — the graded `claude -p` phase ran and the
  verifier scored it. A graded-phase crash, timeout, or budget/turn exhaustion
  is a **fail against that arm** (the arm owns finishing within its cap). The
  agentify arm's `claude -p` uses `|| true` so turn/budget exhaustion is scored
  by the verifier, not errored out.
- **harness_error / invalid (excluded, counted for no arm)** — a failure
  *before* the graded model ran that is the host's fault: image build failure,
  `npm install` of Claude Code / Agentify failing, container/exec infra errors,
  or a provider-reported-inactive attempt (429/zero-model-activity). Only
  zero-model-activity host failures are excluded. Logged in `campaign.json`
  notes with counts and re-run when feasible.
- Rate-limit mid-run → pause/resume (`harbor job resume`) or re-run affected
  trials; pauses recorded in campaign notes.

## 5. Deviations from August (a replication must say exactly what differs)

1. **Agentify version (the intended variable):** 0.4.0
   (`github:ixigo/agentify#7cd5351`) → **0.5.0** (tag `v0.5.0`, commit
   `dfcfb3c0007e2d517ee4e51cee09ec275a97f646`). Set via
   `AGENTIFY_EVAL_AGENTIFY_SPEC=github:ixigo/agentify#v0.5.0`.
2. **Dataset / fixtures:** `agentify-context-bench` **1.1.0 → 1.2.0**. The
   benchmark fixtures were regenerated between August and November; the
   2026-11-25 injection-format campaign documented that 1.2.0 fixtures changed
   retrieval behaviour (needles that were previously missed became
   retrievable). This is a genuine confound for a pure replication but is
   unavoidable on current `main`, and is recorded prominently here and in the
   write-up.
3. **Claude Code CLI:** agentify arm installs pinned
   `@anthropic-ai/claude-code@2.1.208` (unchanged from the committed default in
   `agentify_claude.py`); the builtin `claude-code` baseline pins no version
   and installs whatever Harbor 0.18.0 resolves at run time (same policy as
   August — drifts with wall-clock; local probe CLI is 2.1.332).
4. **Models:** identical ids to August — no substitution. Both rungs probed
   reachable on the subscription on 2026-11-25. NOTE: `claude-sonnet-4-5`
   emits a retirement warning ("retired on November 30, 2026"), 5 days after
   this run; it still serves now.
5. **Harbor 0.18.0**, host colima/macOS aarch64 — unchanged.

## 6. Receipts and verification

On completion: `agentify eval harbor import` each job, copy run dirs into
`evals/results/harbor-20261125-downshift5-replication/runs/`, regenerate
`reports/` + verify with `node evals/results/verify.mjs --write`, and commit
runs + reports + `campaign.json` + docs together. `test/eval-receipts.test.js`
(runs `verify.mjs`) gates that published per-arm aggregates reproduce from the
committed raw runs. Paired sign tests, Wilson intervals, and the per-family /
per-cell breakdown are reproduced by `analysis.mjs` in the campaign directory,
side by side with the August numbers.
