# `agentify loop` — the autonomous build loop

One brief in, one graded branch out.

`loop` takes a task (a Jira key, a Figma node, a defect, a sentence), isolates
it in a fresh git worktree, lets an agent implement it, runs acceptance gates,
feeds the failures back, and iterates until the gates hold or a ceiling trips.
It commits the winning branch, optionally opens a draft PR, and always writes a
report.

```bash
agentify loop run --task "Add a retry banner to the checkout page" --dry-run
agentify loop run --jira XCT-10874 --serve "pnpm dev" --serve-url http://localhost:3000
agentify loop run --figma "https://figma.com/design/…?node-id=9786-23492" --figma-image node.png
agentify loop status
agentify loop report --format html --out loop.html
```

## Why the loop is not the agent

The agent only edits. Everything that decides *whether to keep going* lives in
Node:

| Decision | Owned by | Why not the model |
| --- | --- | --- |
| Is it done? | Gates (exit codes, thresholds, index levels) | A model asked whether it finished says yes |
| Keep iterating? | Iteration cap, run budget, wall clock, stall detection | An unattended loop needs a ceiling nobody has to watch |
| What may it touch? | Forbidden paths, reverted between iterations | One bad iteration must not persist into the branch |
| Ship it? | The harness, after the gates pass | The agent never commits, pushes, or opens a PR |

This is what makes `loop` safe to start and walk away from. The trade is that a
loop is only as good as its gates: a thin gate ladder produces a confident green
report that checked almost nothing, which is why `--dry-run` prints the ladder
and `loop run` says which gates it could not infer.

### What the agent can and cannot do

The implement step runs through the normal `delegate` path, which means:

- **Edits are auto-accepted** (`--permission-mode acceptEdits` for Claude), so
  the agent can freely write code.
- **Shell commands are not broadly granted.** An iteration may not be able to
  run the build or the test suite itself, so the gate verdicts are usually the
  agent's only feedback signal. That is the intended shape — the gates are the
  oracle — but it does mean a thin ladder starves the agent of information as
  well as failing to check the work.
- **Context tracking is off inside an iteration** (`AGENTIFY_CTX=off`), the same
  as any delegated run, so a loop cannot recurse into its own hooks. The
  worktree still carries whatever `CLAUDE.md` and `.claude/` the base commit
  has.

## Inputs

Pass a committed brief, or let the CLI synthesize one:

| Flag | Builds |
| --- | --- |
| `--task "<text>"` | A plain implementation brief |
| `--bug "<text>"` | A defect brief that is reproduce-first and ships as `fix` |
| `--jira <KEY>` | Fetches the work item through `acli`; the key becomes the commit's `Refs:` trailer |
| `--figma <url>` | A design brief from a Figma node URL (must carry `node-id`) |
| `--figma-image <path>` | A screenshot of the node. Repeatable — pass several for states, crops, or breakpoints |

`--figma` and `--figma-image` are independent: either alone is enough, and most
runs supply both. The URL gives cached node metadata; the screenshots are the
truth about rendered appearance. `--jira` can be combined with either.

Jira goes through `acli`, not the Atlassian MCP server, because a loop is meant
to run unattended: the MCP path needs an interactive OAuth handshake a headless
run cannot complete.

## Gates

Gates run in order and a blocking failure short-circuits the rest — there is no
point paying for a cross-vendor review when the build is broken. Gates that
never ran are reported as `skipped`, so the ladder shows how far the iteration
actually got.

| Kind | Passes when | Notes |
| --- | --- | --- |
| `command` | The command exits 0 | The default kind |
| `agentify-tests` | Affected tests pass | Uses the structural index — no command to maintain |
| `playwright` | The e2e run exits 0 | Needs a running app |
| `visual` | Similarity to a reference ≥ `min_score` | Needs a running app and a `data-testid` |
| `review` | A reviewer from another vendor returns `VERDICT: pass` | Costs money on every iteration |
| `risk` | Blast radius is at or below `max_level` | Uses the structural index |

Two rules hold everywhere: a gate that cannot determine an outcome is an
`error`, never a pass; and only blocking gates count toward the score the loop
compares between iterations, so an advisory gate flipping green never looks like
progress toward shipping.

### The review gate

The reviewer must end its reply with `VERDICT: pass — <reason>` or
`VERDICT: block — <reason>`. A review with no verdict line is an `error`, not an
approval — otherwise a truncated or crashed reviewer waves the work through.

### The visual gate

The gate captures the element through `ui-screenshot-eval`'s Playwright helper
and scores it against every reference, keeping the best match.

- **Same dimensions** → an exact per-pixel score.
- **Different dimensions** (a Figma picture vs a render) → pixels do not
  correspond at all, so the score is *structural*: luminance downsampled to a
  64×64 grid, which tracks layout, mass, and contrast while ignoring resolution.

The report always says which basis produced the number. A structural score is a
similarity heuristic, not a pixel oracle — chasing its last few points is wasted
effort. For true pixel regression, use Playwright's own `toHaveScreenshot` in a
`playwright` gate.

The helper must be installed in the target repo (`agentify skill install
ui-screenshot-eval`): it imports `playwright` as a bare specifier, which Node
resolves from the script's own directory, so Agentify's bundled copy would look
in the wrong `node_modules`.

## Ceilings

Every ceiling is explicit, and an omitted one resolves to a conservative default
rather than to "unbounded".

```yaml
limits:
  max_iterations: 6        # per candidate
  max_budget_usd: 6.0      # per candidate
  max_turns: 30            # per iteration
  timeout_seconds: 900     # per iteration
  # iteration_budget_usd defaults to max_budget_usd / max_iterations
```

A run also ends when the score fails to beat its best for two consecutive
iterations. The first iteration is exempt — it sets the baseline — so the
earliest a run can stall is the third iteration.

`--dry-run` prints the worst case before anything is spawned:

```
Maximum possible spend: $10.5 (1 candidate(s) x 6 iteration(s) x $1.75, review gates included)
```

Review gates are counted. Reporting only the agent's budget would be a ceiling
the run could legitimately blow through, which is worse than no ceiling at all.

When the provider reports no cost, the report says the dollar total is a lower
bound rather than implying a ceiling that was never checked; the per-call caps
and the iteration count still bound the run.

## Candidates

`--candidates N` races N implementations in N worktrees on N branches, grades
them on the same gates, and keeps the best. Candidates after the first get an
explicitly different engineering stance (smallest diff / most readable / mirror
the existing architecture), because N identical prompts produce N near-identical
attempts and a tournament between clones measures nothing.

A passing candidate always beats a non-passing one regardless of score —
"closest to done" is not done. Ties break toward the shorter, cheaper path.

Losing worktrees are removed unless you pass `--keep-worktrees`; their diffs and
gate logs survive under the run directory either way.

## Shipping

`ship.commit` is on by default: committing is local and reversible. The message
follows Conventional Commits (`ship.type`, `ship.scope`) with a `Refs:` trailer
when the brief carries a ticket key.

Opening a PR is outward-facing and stays opt-in. `--pr draft` pushes the branch
and opens a draft PR through whichever of `gh` / `glab` / `az` matches the
origin remote. Nothing in the loop pushes without it.

## Refusals

These paths are reverted between iterations and reported as violations, and a
brief can extend the list but never shrink it:

```
.github/workflows/**   .gitlab-ci.yml   azure-pipelines.yml
.claude/settings.json  .claude/settings.local.json
```

Reverting rather than only reporting is the point: a single iteration that
rewrote a CI workflow would otherwise leave that change in the branch — and in
the PR — no matter what the report said.

## Briefs

Commit a brief when a loop is worth re-running:

```bash
agentify loop init checkout-banner --ui   # scaffolds loops/checkout-banner.yaml
```

```yaml
schema: loop-brief-v1
id: checkout-banner
title: Retry banner on the checkout summary
intent: |
  Add a dismissible retry banner above the checkout summary when a payment
  attempt fails.
source:
  kind: figma
  figma_url: https://www.figma.com/design/abc/App?node-id=9786-23492
  figma_images: [docs/design/retry-banner.png]
acceptance:
  - The banner only renders after a failed attempt.
  - Dismissing it does not re-render on the next failure in the same session.
serve:
  command: pnpm dev
  url: http://localhost:3000
gates:
  - { id: build,  kind: command, run: pnpm build }
  - { id: lint,   kind: command, run: pnpm lint }
  - { id: tests,  kind: agentify-tests }
  - { id: e2e,    kind: playwright, run: pnpm test:e2e }
  - { id: visual, kind: visual, reference: [docs/design/retry-banner.png],
      url: "http://localhost:3000/checkout", test_id: checkout-retry-banner, min_score: 0.9 }
  - { id: review, kind: review }
limits: { max_iterations: 6, max_budget_usd: 6.0 }
ship: { commit: true, pr: none, type: feat, scope: payment }
```

Without a brief, the CLI infers a ladder from the repo — but only from commands
the repo actually declares. A guessed `npm test` that does not exist would fail
every iteration forever and read as the agent's fault, so what cannot be
inferred is left out and named in the plan.

## Artifacts and resume

```
.agentify/loop/runs/<run-id>/
  run.json          plan + brief, re-validated on resume
  brief.yaml        the exact brief that ran
  summary.json
  candidates/<id>/
    state.json      iterations, verdicts, spend, outcome
    patch.diff
    iterations/<n>/ prompt.md, agent.json, gates/*.log
```

`agentify loop run --resume <run-id>` re-runs only candidates that never
finished. Stored metadata is treated as data, not trusted instructions: the
brief is re-validated and the candidate list rebuilt from it.

## The skill

`loop-autopilot` governs the agent's work inside one iteration. It is named that
rather than `loop` because Claude Code ships an unrelated built-in `/loop`
command for interval-running a prompt.

```bash
agentify skill install loop-autopilot
```

## Outcomes

| Outcome | Means |
| --- | --- |
| `passed` | Every blocking gate passed |
| `stalled` | The score stopped improving for two consecutive iterations |
| `exhausted` | The iteration ceiling was reached with gates still red |
| `budget_exhausted` | The run budget was spent with gates still red |
| `budget_blocked` | A rolling `models.budget` cap refused to start a provider call |
| `error` | The run failed before it could be graded |

`loop run` exits non-zero for anything but `passed`.
