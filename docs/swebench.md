# SWE-bench Verified warm-up protocol

Agentify's [SWE-bench Verified](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified)
arm asks one narrow question: after a repository-only
exploration session, does durable Agentify context help a fresh Claude Code
session resolve real issues with less rediscovery than the same model starting
cold?

This is an optional external benchmark. The Python runner and official Docker
grader live under `evals/swebench/`; they are not npm dependencies and are
never invoked by ordinary Agentify commands.

## What is pinned

`evals/swebench/dataset.json` pins:

- `princeton-nlp/SWE-bench_Verified` test data at revision
  `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`;
- the official `swebench` grader at `4.1.0`;
- Claude Code `2.1.215`, Agentify `0.4.0`, Node `22.22.0`, and the exact model;
- per-session turn and dollar caps;
- a one-instance smoke suite and a six-instance sample containing two issues
  each from Django, Matplotlib, and pytest.

The six-instance suite is a committed repo-stratified sample of SWE-bench
Verified, not an official “Verified Lite” dataset and not a leaderboard run.

## Paired protocol

For each repository, the runner checks out the first selected `base_commit`,
installs Agentify, runs `agentify scan`, and starts one read-only Claude Code
exploration session using the static prompt in
`evals/swebench/warmup/instruction.md`. After Claude exits, the controller
records its returned durable observations with `agentify ctx note`; the model
never receives a write-capable tool. The resulting `.agentify/context/` store is
snapshotted once and reused by every warm attempt for that repository.

Every scored attempt then starts from a fresh checkout at that instance's
exact `base_commit`:

- `claude-code` is a cold, single-session baseline with no Agentify install;
- `agentify` installs Agentify, restores the repository warm store, rebuilds
  the index at the instance commit, and starts a new non-persistent session;
- both arms receive the same issue text, model, turn cap, dollar cap, and base
  commit;
- trial and within-trial arm order are randomized before inference and written
  to `job.json`, preventing systematic cache or machine-load ordering bias;
- both arms use a fresh isolated Claude home, so host hooks, MCP servers,
  plugins, instructions, and saved sessions cannot leak into the baseline;
- each checkout is a one-commit shallow fetch with no remote, tags, later refs,
  or post-base objects for the provider to inspect;
- the generated `git diff` is written in the official prediction JSONL shape;
- only after every provider session has ended, the selected full rows are
  written into the private job directory so grading uses the exact pinned
  snapshot rather than reloading a moving dataset name;
- `python -m swebench.harness.run_evaluation` applies and grades each patch in
  the official Docker environment.

Provider sessions are never resumed. Only `.agentify/context/` crosses the
warm-up/scored barrier.

## Contamination controls

The committed instance list contains only `instance_id`, `repo`,
`base_commit`, and difficulty. Validation rejects committed issue text, gold or
test patches, hints, and test lists.

At runtime the full dataset row remains in the parent Python process. The
warm-up subprocess receives an explicit two-field projection: `repo` and
`base_commit`. It receives neither the issue nor any grader input. The static
prompt is also checked for instance placeholders and test-oriented language.

After warm-up, the runner derives leak markers from gold/test patch additions,
the issue text, and FAIL_TO_PASS node ids, then scans both the Claude trajectory
and every `.agentify/context/` file. A match aborts before any scored warm
session and reports only a SHA-256 marker, not the answer. The runner also
compares `git status` before and after warm-up and aborts if exploration changed
the checkout. Each warm attempt carries a passed contamination receipt;
`agentify eval swebench import` refuses one without it.

Before each scored session, harness-owned Agentify/configuration changes are
sealed into a temporary setup commit. The prediction is the provider diff
against that seal, including intent-to-add files, so integration files do not
pollute the warm patch and newly created solution files are not dropped.

These checks establish a data-flow and artifact barrier. They do not prove the
model has never seen SWE-bench during pretraining, so results must not be
described as training-data contamination evidence.

## Prerequisites

- Claude Code `2.1.215` with `ANTHROPIC_API_KEY` or a
  `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`; host credential stores
  are deliberately unavailable inside isolated benchmark homes;
- the local Agentify CLI on `PATH`;
- Python plus `datasets` for pinned snapshot loading;
- `swebench==4.1.0`, Docker, and the [official harness](https://www.swebench.com/SWE-bench/reference/harness/)
  host requirements for
  grading. The official harness recommends an x86_64 host, at least 120 GB free
  storage, 16 GB RAM, and 8 CPU cores; arm64 support is experimental.

Install only in the benchmark environment, not in Agentify's npm package:

```sh
python3 -m venv .venv-swebench
. .venv-swebench/bin/activate
pip install datasets swebench==4.1.0
```

## Validate, price, run, and report

Token-free validation is safe in CI:

```sh
agentify eval swebench validate
agentify eval swebench plan --suite smoke
agentify eval swebench plan --suite repo-stratified-6
```

Current maximum provider spend:

| suite | instances | repositories | scored sessions | warm-ups | ceiling |
| --- | ---: | ---: | ---: | ---: | ---: |
| `smoke` | 1 | 1 | 2 | 1 | $4.50 |
| `repo-stratified-6` | 6 | 3 | 12 | 3 | $25.50 |

The six-instance warm-up ceiling is $1.50 total, allocated once across six warm
attempts ($0.25 per instance). Official Docker grading consumes compute and
storage but makes no model call.

The one-command wrapper prints the ceiling and asks before any provider call:

```sh
evals/swebench/run-swebench.sh smoke
```

The explicit phases are:

```sh
python3 evals/swebench/runner.py run \
  --suite smoke \
  --output evals/swebench/jobs/job-smoke \
  --yes
python3 evals/swebench/runner.py grade \
  --job evals/swebench/jobs/job-smoke
agentify eval swebench import evals/swebench/jobs/job-smoke
agentify eval report <run-id> --format html --out swebench-report.html
```

The runner refuses to reuse an existing job directory. Job artifacts are
gitignored and contain provider trajectories, generated patches, and a private
local grader dataset with answer-bearing fields. Keep them private unless
deliberately reviewed and redacted.

## Metrics and claim rules

The imported aggregate report uses one paired repeat index per
instance/attempt and exposes:

- resolved percentage as per-arm `pass_rate`, with a Wilson 95% interval;
- cost per resolved instance as `cost.per_pass_usd`;
- mean turns to first edit per arm and the paired baseline-minus-Agentify
  exploration-turn total, plus an exact paired sign-test receipt;
- exact paired discordance and the existing McNemar evidence receipt;
- warm-up cost as a one-time repository investment allocated across every warm
  attempt that reused it.

Official run reports distinguish unresolved, empty, and unapplicable model
patches from Docker, image-build, or test infrastructure errors. Those three
are model outcomes; the adapter recognizes the pinned harness's explicit
`Patch Apply Failed` marker, while every other error remains infrastructure.
Infrastructure errors make grading fail and cannot be imported as model
failures. Import also requires a fully graded result for the complete
instance × attempt × arm cross-product.

`turns_to_first_edit` is derived from the pinned Claude Code `stream-json`
trajectory and counts the first `Edit`, `Write`, `MultiEdit`, or `NotebookEdit`
tool call. Attempts that edit only through shell commands are reported as
unavailable, never zero.

Quote a result only with the dataset revision, suite, model, attempts, cost
coverage, confidence interval, paired significance, and contamination status.
Do not call the six-instance sample a SWE-bench score or leaderboard result.

## Results status

No paid run is committed with the adapter. Therefore there is currently no
claim that Agentify improves resolved percentage, cost per resolved instance,
or turns to first edit on SWE-bench Verified. Populate this section only from a
reviewed imported report; synthetic importer tests are not benchmark evidence.

This explicit empty result is intentional scope honesty: implementation and
CI validation are reproducible without silently spending provider budget or
pretending fixture data meets the external acceptance threshold.
