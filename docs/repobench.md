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
`runner.py select`): **first row per distinct repository, in dataset order,
whose in-file context and contiguously-matching gold snippet verify at a
pinned commit; capped at 8 repositories**. The gold snippet must match the
same contiguous rule the scorer uses, so no pinned task carries an
unattainable `snippet_hit`. Commit resolution searches each file's history
newest-first up to a disclosed cutoff (`--max-commits`, default 1000). It is a bounded sample for protocol validation and directional
evidence, not a leaderboard run.

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
- `impacts` blast radius: does it reach the task file (`impact_hit`)? This
  query runs only when the def queries already retrieved the gold file, so
  its input is a retrieved candidate — the gold label itself never feeds any
  query.

`callers` shares its edge source with `refs` and is exercised through it.
This phase makes no provider call, so retrieval quality can be re-measured
freely.

### Paired completion (paid, bounded)

`runner.py run` runs both arms through identical fresh Claude Code sessions
in an empty scratch directory (plan mode, every standard tool disallowed,
isolated empty home): same instruction, same import statement, same in-file
context, same model and caps. Tool-freedom is enforced twice — the tool list
is disallowed up front, and the runner counts `tool_use` blocks in each
trajectory: any tool call invalidates the trial, and
`agentify eval repobench import` refuses an attempt whose `tool_calls`
receipt is not exactly zero. Session scratch directories and Claude homes
are unique per attempt and deleted afterwards, so a reused `--work-root`
caches only repository clones (each re-verified against its pinned commit
and re-indexed on every use), never session state. The model is observed
from the trajectory rather than asserted: any session whose observed model
set is not exactly the pinned model fails closed, and import re-checks the
receipt. The **only** difference between arms is the cross-file context
block:

- `claude-code` (baseline): in-file context only;
- `agentify`: plus up to 5 definition-anchored snippets selected mechanically
  by the same index queries — no model chooses the context, so any uplift
  attributes to the index. The 6,000-character budget bounds the serialized
  block as injected (path headers and comment prefixes included).

Predictions are the complete fenced model output (a multi-line answer is
graded whole, never truncated to its first line) and are scored locally with
the official RepoBench evaluator's definitions: exact match is
whitespace-token equality (`prediction.split() == target.split()`) and edit
similarity is `fuzz.ratio` (indel-costed Levenshtein, integer percent,
implemented dependency-free). Identifier F1 is a supplementary
CrossCodeEval-style diagnostic — a regex approximation that strips string
literals and comments and scores zero on an empty denominator — not a
RepoBench headline metric. There is no Docker grader; scoring is deterministic text
comparison, so the job is `graded` as soon as inference finishes.

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

- an Agentify **source checkout**: like the Harbor and SWE-bench adapters,
  the benchmark assets under `evals/` are not shipped in the npm package, so
  `agentify eval repobench …` must run from the repository root. The job
  records the checkout's commit and dirty state as a build receipt, since a
  semver pin alone cannot distinguish two builds reporting the same version;
- `git` and Node on `PATH`; scan and query invocations use the checkout's
  own CLI (`node src/cli.js`), never a globally installed `agentify`, so the
  build receipt describes the code that actually built the index;
- Claude Code `2.1.215` with `ANTHROPIC_API_KEY` or a
  `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (completion phase only);
- Python 3.10+ (stdlib only — rows come from the Hugging Face
  datasets-server REST API, hash-verified against the committed receipts);
- network access to Hugging Face and the pinned GitHub repositories.

The datasets-server row API serves only the dataset's default-branch HEAD,
so the runner first resolves HEAD and refuses to fetch when it no longer
equals the committed revision. If upstream ever advances, either update the
pin deliberately or materialize the pinned rows once with the `datasets`
library at the pinned revision into `--rows-cache` (`row-<index>.json`
files); cached rows are still verified against the committed sha256
receipts, so a wrong or tampered cache fails closed.

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

Import requires a fully scored job: the complete task × attempt × arm
cross-product, every exact-match verdict re-derived from the committed
answer-token hash against the attempt's recorded prediction (a hand-edited
score cannot survive import), a `tool_calls: 0` receipt on every attempt, a retrieval
receipt on every agentify attempt, and a valid retrieval summary bound to
this job's suite, dataset revision, and pinned Agentify version. Every suite
task must carry a per-task receipt matching its committed repo/commit pin,
the summary's aggregate metrics are recomputed from those receipts and must
agree, and each agentify attempt's retrieval data must match its task's
receipt — a job missing its token-free retrieval evidence, or carrying
fabricated or copied evidence, does not import. The imported aggregate report uses one paired repeat index per
task/attempt and exposes:

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
