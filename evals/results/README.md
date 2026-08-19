# Committed benchmark receipts

Every benchmark number Agentify publishes (README, `docs/harbor.md`,
`docs/swebench.md`) must be auditable from this directory. Job artifacts under
`evals/harbor/jobs/` and the local run store under `.agentify/evals/runs/` are
gitignored working state — the moment a number is quoted anywhere public, its
backing runs move here as a permanent, reviewable receipt.

## Layout

```
evals/results/
  verify.mjs                     # reproduce receipts from run dirs; --write regenerates
  <dataset-or-campaign>/         # e.g. harbor-20260714
    campaign.json                # pins the exact run set per job + the published aggregates
    runs/<run-id>/               # the imported run, verbatim: run.json + attempts/*/result.json
    reports/<run-id>.report.json # eval report built from that run by the code at commit time
```

- `runs/` are byte-for-byte copies of the imported runs (`agentify eval harbor
  import`, `agentify eval swebench import`, or native runs). They carry full
  provenance: harness label, dataset name/version, tool pins, arm order, and
  per-attempt grading — never provider transcripts.
- `reports/` are the derived numbers. They exist so a reader can diff "what was
  published" against "what the current code computes".

## Verification (runs on every PR)

`test/eval-receipts.test.js` executes `node evals/results/verify.mjs`, which
checks four things per campaign:

1. every report is rebuilt from its committed run dir in an isolated temp
   store and must deep-equal the committed `report.json`;
2. the committed run set exactly matches `campaign.json` (a deleted run+receipt
   pair fails, so the documented campaign cannot shrink silently);
3. a receipt with no raw run dir behind it is an orphan and fails;
4. the `published.arms` aggregates in `campaign.json` (the totals quoted in
   README/docs, e.g. 24/24 vs 21/24) must equal the sums of the receipts.

If a change to the report or statistics code alters what these runs compute,
the test fails — regenerate with:

```
node evals/results/verify.mjs --write
```

in the same change, so the diff shows exactly how published numbers moved.

## Adding results from a new paid run

1. Import the job as usual (`agentify eval harbor import <job-dir>` /
   `agentify eval swebench import <job-dir>`).
2. Copy the imported run dirs from `.agentify/evals/runs/` into a new
   `evals/results/<campaign>/runs/` directory.
3. `node evals/results/verify.mjs --write`, then commit runs + reports
   together.
4. Quote numbers in docs only from these receipts, and link the campaign
   directory next to the claim.

## Committed campaigns

| campaign | date | what | runs |
| --- | --- | --- | --- |
| `harbor-20260714` | 2026-07-14 | First Harbor paired campaign on `agentify-context-bench` v1.0.0 (`claude-haiku-4-5`): `paired-full` job (6 runs) + `nightly-20260714` job (8 runs, the results quoted in README and `docs/harbor.md` — 24/24 vs 21/24, no winner declared, p = 0.25) | 14 |
