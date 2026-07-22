# RepoBench repo-context protocol

Agentify's [RepoBench](https://huggingface.co/datasets/tianyang/repobench_python_v1.1)
arm asks one narrow question about the repo-intelligence layer: when a task's
next line depends on code defined in *another file*, does the structural index
(`agentify scan` + `agentify query`) surface exactly that cross-file
dependency — and does injecting what it retrieved improve line completion?

It complements the SWE-bench arm: SWE-bench markets durable memory on
end-to-end issue resolution; RepoBench isolates retrieval quality of the
index, with the benchmark's own labeled gold cross-file context as ground
truth.

This is an optional external benchmark. The Python runner lives under
`evals/repobench/`; it is not an npm dependency and is never invoked by
ordinary Agentify commands.

## What is pinned

`evals/repobench/dataset.json` pins:

- `tianyang/repobench_python_v1.1`, split `cross_file_first`, at revision
  `8a7cf0c8942cc1aa066bf261839650ac55a2ff79`;
- Claude Code `2.1.215`, Agentify `0.4.0`, Node `22.22.0`, and the exact model;
- per-completion turn and dollar caps plus context-injection bounds;
- eight committed tasks, each with a pinned repository commit and sha256
  receipts for **every consumed dataset field** (`all_code`, `cropped_code`,
  `import_statement`, `next_line`, gold path, gold snippet).

RepoBench does not publish repository commits, so each task's commit was
resolved once by content verification and committed: at the pinned commit,
every non-empty in-file context line must appear in the file in order (the
dataset strips import lines out of `all_code`), the import statement must be
present, and the target line must follow the matched context. The runner
re-runs this verification on every checkout; the committed hashes are
re-checked against every fetched dataset row, so upstream dataset or
repository drift is a hard error rather than a silent re-benchmark.

The sample follows one committed, executable selection rule (also shipped as
`runner.py select`): **first content-verified row per distinct repository, in
dataset order, capped at 8 repositories**. It is a bounded sample for
protocol validation and directional evidence, not a leaderboard run.

## Two harnesses, one gold label

Every task in the `cross_file_first` split labels its gold cross-file
dependency: `context[gold_snippet_index]` names the defining file, the
identifier, and the exact snippet the next line depends on.

### Retrieval scoring (token-free, $0)

`runner.py retrieval` checks out each pinned commit, runs `agentify scan`,
derives query symbols **from the task's import statement only** (the answer
line and gold label never feed the query plan), and scores three index
angles:

- `def`/`refs` definitions: is the gold defining file among the returned
  candidate files (`def_hit`, hit@1, hit@5, MRR, macro precision), and does a
  returned definition's line range land inside the gold snippet
  (`snippet_hit`)?
- `refs` reverse edges: does the index list the task file as an importer of
  the gold defining file (`ref_edge_hit`)?
- `impacts` blast radius from the gold file: does it reach the task file
  (`impact_hit`)?

`callers` shares its edge source with `refs` and is exercised through it.
This phase makes no provider call, so retrieval quality can be re-measured
freely.

### Paired completion (paid, bounded)

`runner.py run` runs both arms through identical fresh Claude Code sessions
in an empty scratch directory (plan mode, edit tools disallowed, isolated
empty home): same instruction, same import statement, same in-file context,
same model and caps. The **only** difference is the cross-file context block:

- `claude-code` (baseline): in-file context only;
- `agentify`: plus up to 5 definition-anchored snippets (bounded to 6,000
  characters) selected mechanically by the same index queries — no model
  chooses the context, so any uplift attributes to the index.

Predictions are scored locally with RepoBench's standard metrics: exact
match, edit similarity (Levenshtein), and identifier F1. There is no Docker
grader; scoring is deterministic text comparison, so the job is `graded` as
soon as inference finishes.

## Answer isolation

- Committed tasks carry identity and hash receipts only; validation rejects
  any committed `next_line`, gold path/snippet, context list, or code fields.
- The completion instruction (`prompts/completion.md`) may splice only
  allowlisted fields (`file_path`, `import_statement`, `context_block`,
  `code`); validation rejects any other placeholder.
- Query symbols derive from `import_statement` alone.
- Retrieved snippets come from the pinned checkout, which legitimately may
  contain the answer's text (cross-file duplication is part of the
  benchmark). Every attempt records an `answer_in_context` receipt and the
  report shows the tally instead of silently benefiting from it.
- RepoBench v1.1 rows are public (repos created 2023-10 to 2024-02, dataset
  published 2024). These barriers are data-flow controls for the harness;
  they are **not** evidence the model never saw the repositories or dataset
  during pretraining, and results must not be described that way.

## Prerequisites

- `git`, Node, and the local Agentify CLI on `PATH` (retrieval phase);
- Claude Code `2.1.215` with `ANTHROPIC_API_KEY` or a
  `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (completion phase only);
- Python 3.10+ (stdlib only — rows come from the Hugging Face
  datasets-server REST API, hash-verified against the committed receipts);
- network access to Hugging Face and the pinned GitHub repositories.

## Validate, price, run, and report

Token-free validation is safe in CI:

```sh
agentify eval repobench validate
agentify eval repobench plan --suite smoke
agentify eval repobench plan --suite repo-8
```

Current maximum provider spend:

| suite | tasks | repositories | completion sessions | retrieval cost | ceiling |
| --- | ---: | ---: | ---: | ---: | ---: |
| `smoke` | 1 | 1 | 2 | $0 | $0.50 |
| `repo-8` | 8 | 8 | 16 | $0 | $4.00 |

The one-command wrapper runs the free retrieval phase first and asks before
any provider call:

```sh
evals/repobench/run-repobench.sh repo-8
```

The explicit phases are:

```sh
python3 evals/repobench/runner.py retrieval --suite repo-8 --output evals/repobench/jobs/job-repo-8
python3 evals/repobench/runner.py run --suite repo-8 --output evals/repobench/jobs/job-repo-8 --yes
agentify eval repobench import evals/repobench/jobs/job-repo-8
agentify eval report <run-id> --format html --out repobench-report.html
```

The runner refuses to reuse an existing job directory. Job artifacts are
gitignored and contain provider trajectories, predictions, and retrieval
receipts; the trajectories embed prompts built from dataset rows, so keep
them private unless deliberately reviewed.

## Metrics and claim rules

The imported aggregate report uses one paired repeat index per task/attempt
and exposes:

- exact match as per-arm `pass_rate` with a Wilson 95% interval, plus the
  paired discordance and McNemar evidence receipt;
- per-arm mean edit similarity and identifier F1 (`arms.<arm>.repobench`);
- the token-free retrieval summary (`repobench.retrieval`): gold-file hit
  rate, hit@1/hit@5, MRR, macro precision, snippet hit rate, and the
  reverse-edge receipts from `refs` and `impacts`;
- per-attempt `answer_in_context` and `gold_in_context` receipts.

Quote a result only with the dataset revision, split, suite, model, attempts,
and the selection rule. State the scope honestly: Python only, one task per
repository, eight repositories, line completion as a proxy for repo-context
reasoning. Do not present the sample as an official RepoBench leaderboard
score, and do not present retrieval hits as end-to-end task success.

## Results status

No scored run is committed with the adapter. Therefore there is currently no
claim that Agentify's index retrieves gold cross-file context at any
particular precision/recall, nor that index-supplied context improves exact
match or edit similarity on RepoBench. Populate this section only from a
reviewed imported report; synthetic importer tests are not benchmark
evidence.

This explicit empty result is intentional scope honesty: implementation and
CI validation are reproducible without silently spending provider budget or
pretending fixture data meets the external acceptance threshold.
