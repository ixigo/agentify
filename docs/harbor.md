# Harbor adapter and portable benchmark dataset

The native `agentify eval` runner (issues #293–#296) is the fastest feedback
loop, but it grades Agentify with Agentify's own harness on the host machine.
The Harbor adapter (#298) is the second, standardized harness: portable
container tasks run by [Harbor](https://www.harborframework.com) — the
Terminal-Bench 2.0 framework — with Harbor's own plain Claude Code agent as
the baseline. If the paired signal only shows up in our harness, we are
optimizing the harness; if it shows up in both, we are optimizing real work.

Harbor is **not** a runtime dependency. Agentify's npm package ships no
Python and never launches containers. The split is:

| Piece | Where | Needs Harbor? |
| --- | --- | --- |
| `agentify eval harbor validate` | Node, CI-safe | no |
| `agentify eval harbor plan` | Node, CI-safe | no |
| `agentify eval harbor import` | Node, reads job artifacts | no |
| Dataset tasks, agents, suites | `evals/harbor/` (data files) | only to run |
| Running trials | `harbor run` on your machine/CI | yes (+ Docker) |

## Layout

```
evals/harbor/
  dataset.json          # versioned manifest: tasks, categories, pins, suites, spend caps
  agents/
    agentify_claude.py  # Harbor BaseInstalledAgent: Claude Code + Agentify + seeded fixtures
  tasks/<task-id>/      # Terminal-Bench 2.0 task dirs (8 tasks)
    task.toml
    instruction.md
    environment/
      Dockerfile        # immutable pinned base image, deterministic git baseline
      repo/             # the mini-repo the agent works in
      fixtures/agentify-context/   # seeded notes/events (agentify arm only)
    tests/test.sh       # deterministic verifier; writes /logs/verifier/reward.txt (fail-closed)
    solution/solve.sh   # oracle solution for token-free smokes
  suites/
    smoke.yaml          # 1 task × 2 agents × 1 attempt
    nightly.yaml        # 8 tasks × 2 agents × 3 attempts
    profiles.yaml       # 8 tasks × (cost|balanced|performance agentify + plain) × 3
  run-smoke.sh          # plan → confirm → harbor run → import, in one command
```

## The paired arms

Both agents run the **same task image, same model ID, same limits, same
verifier**:

- `agentify-claude` (`agents/agentify_claude.py`): installs the pinned
  `@anthropic-ai/claude-code` and `agentify` npm packages, runs
  `agentify install --provider claude` in the task repo, and copies the
  task's context fixtures from `/opt/agentify-fixtures` into
  `.agentify/context`. Accepts a `profile` kwarg (`cost` / `balanced` /
  `performance`) for the optimization-profile matrix.
- `claude-code`: Harbor's built-in plain Claude Code agent. Same image — the
  fixtures sit untouched outside the repo.

Fixtures are history, never answers: each task in `dataset.json` declares
`answer_leak_patterns`, and `agentify eval harbor validate` fails the dataset
if any fixture file contains one of them. Verifiers are forbidden from
reading the fixtures path, so seeding can never be graded as work.

## Dataset categories

The 8 tasks cover the roadmap's context-value claims plus the two controls
that keep us honest:

| Category | Task | What it measures |
| --- | --- | --- |
| decision-recall | `recall-error-envelope` | Conventions recorded in a past session are honored |
| prior-failure-avoidance | `avoid-cache-regression` | A recorded production incident prevents a repeat |
| prior-failure-avoidance | `timezone-flake-gotcha` | A recorded flake gotcha steers to the real fix |
| stale-context-rejection | `reject-stale-config-path` | Outdated notes are rejected in favor of repo reality |
| repo-intelligence | `rename-shipping-rate-refs` | refs/impact answers find every call site |
| affected-test-selection | `select-affected-tests` | Scoped test runs avoid a quarantined red herring |
| mechanical-control | `mechanical-header-bump` | Context adds no value — arms should tie |
| misleading-context | `misleading-note-paginate` | Wrong-but-plausible notes must not cause damage |

## Prerequisites for running trials

- Docker running locally (or another Harbor-supported runtime).
- Python 3.12+ (Harbor's own floor) with Harbor at the pinned version:
  `pip install harbor==<pins.harbor from dataset.json>`.
  If that exact version is unavailable in your index, check
  `pip index versions harbor`, update `dataset.json` deliberately, and re-run
  the smoke suite before trusting results.
- Agentify installable at the pinned spec. Until Agentify is published on npm
  under this name, point the agent at a git ref:
  `export AGENTIFY_EVAL_AGENTIFY_SPEC="github:ixigo/agentify#<commit>"`.
- `ANTHROPIC_API_KEY` exported. Harbor passes provider credentials into trial
  containers; treat every container as untrusted with that key and prefer a
  scoped, rate-limited key for benchmarks.
- `agentify` on PATH (for plan/import).

## Cost: calculate before you launch

Every trial is capped by its task's `max_cost_usd` (enforced by the agents
via `--max-budget-usd`). The suite ceiling is always
`tasks × agents × attempts × cap`:

```
agentify eval harbor plan --suite smoke     # $0.70 ceiling (1×2×1×$0.35)
agentify eval harbor plan --suite nightly   # 8 tasks × 2 × 3 × cap = $16.80
agentify eval harbor plan --suite profiles  # 8 tasks × 4 × 3 × cap = $33.60
```

The agentify agent enforces the cap in-flight (`--max-budget-usd` per trial).
Whether Harbor's built-in `claude-code` agent exposes an equivalent budget
kwarg depends on the pinned Harbor version — check `harbor run --help`; when
it doesn't, that arm is bounded by the task/agent timeouts and the printed
ceiling is an assumption for it, not a hard guarantee.

`run-smoke.sh` prints the plan and requires interactive confirmation before
any provider call; `CI=true` skips the prompt so scheduled runs stay
non-interactive — schedule them with a hard budget on the key itself.

## Running

```
cd evals/harbor
./run-smoke.sh                 # smoke suite: plan → confirm → run → import
./run-smoke.sh nightly         # same flow for the full suite
```

or manually:

```
cd evals/harbor
harbor run -c suites/smoke.yaml
cd ../..
agentify eval harbor import evals/harbor/jobs/<job-dir>
agentify eval report <run-id> --format html --out report.html
```

Token-free container smoke (CI): run the suite with Harbor's oracle agent,
which executes each task's `solution/solve.sh` instead of a model — this
validates images, verifiers, and the import path without spending tokens:

```
harbor run -p tasks -a oracle
```

## Importing results

`agentify eval harbor import <job-dir>` converts each Harbor task's trials
into one native eval run under `.agentify/evals/runs/`, so `agentify eval
report`, `eval compare`, and `eval list` read Harbor and native runs through
the same schema. Mapping:

- `agentify-claude` trials → the `agentify` arm (profile variants become
  `agentify-cost` / `agentify-performance`); other agents keep their name as
  the arm (`claude-code`).
- Reward 1.0 = pass; anything less (or a missing reward) = fail. The raw
  reward is preserved under each attempt's `harbor` block.
- Cost/token fields are imported when the trial reports them and marked
  `unreported` otherwise — never estimated.
- `run.json` carries `harness: "harbor"` plus job, dataset name/version,
  Harbor version, and agent identities. Imported runs cannot be resumed, and
  `eval compare` refuses to gate a native run against a Harbor run without
  `--force`.

## External benchmarks (optional validity check)

Because `agentify-claude` is a standard installed agent, it runs on any
Harbor dataset. To sanity-check external validity on a small public subset:

```
harbor run -d "terminal-bench@2.0" -t <a-few-task-names> \
  -a agents.agentify_claude:AgentifyClaudeAgent \
  -m anthropic/claude-haiku-4-5-20251001
```

Keep it small and directional. Public benchmark scores are not the product
metric, and a private 8-task dataset earns no leaderboard claims.

## Versioning and provenance

`dataset.json` pins the dataset version, model ID, Harbor version, Claude
Code version, and Agentify version. Every imported attempt records the
dataset name/version, Harbor version, job and trial identity, agent version,
and the importing Agentify version. Bump pins deliberately, one at a time,
and re-run the smoke suite after any bump.

## Cleanup

Harbor leaves job artifacts under `evals/harbor/jobs/` (gitignored) and
Docker images/containers on the host:

```
rm -rf evals/harbor/jobs/<job-dir>     # after importing
docker system prune                    # reclaim task images when done
```

## CI policy

- Every PR: `pnpm test` runs the schema/leak validation (`test/harbor.test.js`
  exercises `agentify eval harbor validate` on the committed dataset) — no
  tokens, no containers.
- Paid smoke/nightly/profile suites are opt-in or scheduled, never implicit
  on PRs, and always behind the plan's printed ceiling.
