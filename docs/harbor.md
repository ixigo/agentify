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
  tasks/<task-id>/      # Terminal-Bench 2.0 task dirs (9 tasks; 1 multi-session)
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

## Multi-session tasks (write -> recall)

Single-session tasks can only measure whether an agent reads *pre-seeded*
context. Agentify's real edge is durable memory the agent **produces itself**
and recalls in a later session — the thing a memoryless harness cannot carry
forward at all. Two-phase tasks measure exactly that (issue #315).

A two-phase task ships a phase-A **seed** instruction at
`environment/phases/seed/instruction.md` (baked into the image at
`/opt/agentify-seed/instruction.md` by the task Dockerfile) and declares
`"phases": ["seed", "recall"]` in `dataset.json`. The graded phase-B
**recall** instruction is the ordinary `instruction.md`, and the verifier
scores phase B exactly as for any other task.

- **`agentify-claude`** runs phase A, then phase B. The two run under
  different session ids (`harbor-seed`, `harbor-trial`) and the provider keeps
  no session (`--no-session-persistence`), so the **only** thing that bridges
  them is Agentify's on-disk `.agentify/context/` store — written by the hooks
  during phase A, injected by the SessionStart digest in phase B. That is the
  barrier: repo tree and `.agentify/context/` cross it; provider conversation
  state never does (the same "hidden provider state is never replayed"
  invariant the whole dataset holds to).
- **`claude-code`** (baseline) has no memory layer, so it never runs the seed
  phase — a memoryless agent has no prior session to carry forward. It starts
  the graded phase cold. That gap *is* the comparison.

**Fairness and cost.** The `agentify-claude` arm spends phase-A tokens the
baseline does not; that is the memory *investment*. The adapter records it in
trial metadata (`seed_cost_usd`, `seed_num_turns`) so it is never hidden. On
import, the seed cost is folded into the arm's total `cost_usd` — so
cost-per-pass and frontier analyses charge the Agentify arm for the full
investment, not just the graded recall phase — while the split
(`recall_cost_usd`, `seed_cost_usd`) is preserved beside it for the amortized
cost-per-recall analysis (#319), which weighs the investment against the
rediscovery it saves across future sessions. Because the arm runs two provider
passes, a two-phase task's `max_cost_usd` in `dataset.json` is set to cover
both (worst-case ceiling; the baseline spends at most half).

Validation (`agentify eval harbor validate`) enforces the format: the seed
file and the `phases` declaration must agree, **neither** prompt may contain
an `answer_leak_pattern`, and the Dockerfile must actually bake the seed
instruction in (or the seed phase would silently no-op). Run the suite with
`harbor run -c suites/multisession.yaml` — and always `agentify eval harbor
plan --suite multisession` first for the spend ceiling.

## Cross-vendor transfer tasks (Codex writes -> Claude reads)

Multi-session tasks above still run Claude against Claude. Agentify's single
most defensible claim — **"switch agents, keep the repo's working memory"** —
is only exercised when the two phases are run by **different vendors**. That is
the arm no single-vendor harness can tie: a plain Claude-only *or* Codex-only
harness has **zero** cross-vendor state transfer by construction — a finding
produced by one vendor is structurally invisible to the other, so it scores 0
here no matter how good the underlying agent is. The pass is only possible
because Agentify's store is vendor-neutral.

The `crossvendor` suite runs a two-phase task where **phase A (seed) is
executed by Codex** and **phase B (graded recall) by Claude Code**, against the
same repo and the same `.agentify/context/` store. Codex records the runtime
gotcha it discovers via the installed `AGENTS.md` guidance
(`agentify ctx note`); Claude recalls it through the SessionStart digest and
avoids the same bug. Only phase B is scored. Adapter:
`agents/agentify_transfer.py`.

Two arms:

- **`agentify-transfer`** (`AgentifyTransferAgent`) — Codex(seed) ->
  Claude(recall), store shared. Imports as the `agentify` arm. Expected: pass.
- **`crossvendor-nomem`** (`CrossVendorNoMemoryAgent`) — the *identical*
  Codex -> Claude flow with `AGENTIFY_CTX=off` in both phases, so the digest
  injects nothing and Claude never sees Codex's finding. Same providers, same
  order, same budget — the **only** difference is the memory layer (it reuses
  the exact switch `agentify delegate` uses to keep children memoryless).
  Expected: fail. That gap is the whole comparison, and it is what a
  single-vendor harness scores 0 on.

An optional reverse direction (Claude seed -> Codex recall) is supported via
the adapter's `direction: claude-to-codex` kwarg but is **not** wired into the
committed suite: Codex has no SessionStart hook, so its recall depends on the
`AGENTS.md` guidance running `agentify ctx load`, which is less deterministic
than Claude's hook-driven injection.

**Privacy invariant preserved.** The *only* thing that crosses the barrier is
`.agentify/context/`. Codex keeps its session under `CODEX_HOME`; Claude runs
`--no-session-persistence`; neither provider reads the other's trajectory (each
writes its own `/logs/agent/*-trajectory` file). No provider transcript ever
crosses — the same "hidden provider state is never replayed" invariant the
whole dataset holds to, here made *vendor-neutral*.

**Credential-isolation reality.** Harbor's installed-agent model is one trial =
one container, so the committed suite runs both providers **in a single
container that carries both vendors' credentials** — a deliberate relaxation of
the single-vendor-cred norm noted below. Provide both:

- Codex (phase A): `OPENAI_API_KEY`, or an in-container `auth.json` (from
  `codex login`) pointed at by `CODEX_AUTH_JSON_SRC` for subscription auth.
- Claude (phase B): the same contract as `agentify-claude` — `ANTHROPIC_API_KEY`,
  or `CLAUDE_FORCE_OAUTH=1` + `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.

The Codex CLI version is pinned in the adapter via `AGENTIFY_EVAL_CODEX_SPEC`
(default `@openai/codex@0.144.6`); Codex reports no `total_cost_usd`, so a Codex
seed's cost imports as *unreported* (never zero), consistent with the rest of
the import path.

For environments that truly cannot co-locate two vendors' credentials in one
container, the equivalent is a **two-container relay**: run phase A in a
Codex-cred container, snapshot `.agentify/context/`, and mount it read-only into
a Claude-cred container for phase B. It preserves the same privacy invariant
(only the store crosses) but needs orchestration outside Harbor's
single-container installed-agent model, so the committed suite uses the
single-container form.

Launch with `harbor run -c suites/crossvendor.yaml`; always `agentify eval
harbor plan --suite crossvendor` first (ceiling `2 tasks × 2 agents × 3
attempts × $0.70 = $8.40`).

## Dataset categories

The tasks cover the roadmap's context-value claims plus the two controls
that keep us honest:

| Category | Task | What it measures |
| --- | --- | --- |
| decision-recall | `recall-error-envelope` | Conventions recorded in a past session are honored |
| prior-failure-avoidance | `avoid-cache-regression` | A recorded production incident prevents a repeat |
| prior-failure-avoidance | `timezone-flake-gotcha` | A recorded flake gotcha steers to the real fix |
| prior-failure-avoidance (multi-session) | `recall-flaky-timezone` | A gotcha the agent *hit and recorded* in a seed session is recalled in the next |
| prior-failure-avoidance (cross-vendor) | `recall-utc-quarter` | A gotcha **Codex** hit and recorded in a seed session is recalled by **Claude** in the next |
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
agentify eval harbor plan --suite smoke        # $0.70 ceiling (1×2×1×$0.35)
agentify eval harbor plan --suite nightly      # 8 tasks × 2 × 3 × cap = $16.80
agentify eval harbor plan --suite profiles     # 8 tasks × 4 × 3 × cap = $33.60
agentify eval harbor plan --suite multisession # 1 task × 2 × 3 × $0.70 = $4.20
agentify eval harbor plan --suite crossvendor  # 2 tasks × 2 × 3 × $0.70 = $8.40
```

Cross-vendor trials additionally require **both** vendors' credentials in the
trial container (`OPENAI_API_KEY` for Codex on top of the Claude auth above) —
see "Cross-vendor transfer tasks".

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
PYTHONPATH="$PWD" harbor run -c suites/smoke.yaml   # PYTHONPATH resolves the custom agent import
# pipx caveat: pipx's harbor shebang is `python -E`, which ignores PYTHONPATH.
# run-smoke.sh handles this automatically; manually, invoke the CLI through
# harbor's own interpreter:
#   PYTHONPATH="$PWD" ~/.local/pipx/venvs/harbor/bin/python \
#     -c 'from harbor.cli.main import app; app()' run -c suites/smoke.yaml
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

## Results so far

First full nightly suite (2026-07-14, job `nightly-20260714`: 8 tasks × 2 arms
× 3 attempts, `claude-haiku-4-5`, `max_turns` 16, $2.10 spent of the $16.80
ceiling, 48/48 trials, zero flakes):

| arm | passes | pooled Wilson 95% CI | cost/attempt |
| --- | --- | --- | --- |
| agentify | 24/24 (100%) | 86.2–100% | $0.055 |
| claude-code | 21/24 (87.5%) | 69.0–95.7% | $0.033 |

- All three baseline failures were on `avoid-cache-regression`
  (prior-failure-avoidance): the recorded incident note is the only difference
  between the arms, and it separated 3/3 from 0/3 — reproducing the
  1-attempt result from the same day's first paired run.
- Both controls held: `mechanical-header-bump` and `misleading-note-paginate`
  tied 3/3 per arm — context neither inflates unrelated tasks nor causes
  damage when a seeded note is wrong.
- **No winner is declared.** 3 discordant pairs, all favoring agentify, give
  an exact two-sided sign-test p = 0.25 with overlapping CIs; the fail-closed
  winner rule needs CI separation and p < 0.05 (≥5 discordant pairs).
  Accumulate nightly runs, or raise attempts on discordant tasks.
- `eval compare --fail-on "pass_rate_drop>0.02"` against the same-day
  1-attempt baseline passed all 8 task gates (exit 0).
- The turns bump from 12 to 16 worked: one cap-hit in 48 trials (verifier
  still passed it), down from four in 16 trials at cap 12.

Scope caveat when quoting these numbers: this *nightly* suite measures the
**context layer only** (hooks, seeded notes, repo intelligence), Claude against
Claude. Cross-vendor **transfer** (Codex writes -> Claude reads) is measured
separately by the `crossvendor` suite above, not by these numbers. Cross-vendor
**delegation/review** remains out of scope by construction — `agentify
delegate` launches children with `AGENTIFY_CTX=off` — so the +66% per-attempt
cost above is the price of context alone, not a statement about whole-workflow
economics (that is what `agentify stats` / `agentify value` and the native eval
profiles measure).

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
