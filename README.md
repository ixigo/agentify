```text
    _                    _   _  __
   / \   __ _  ___ _ __ | |_(_)/ _|_   _
  / _ \ / _` |/ _ \ '_ \| __| | |_| | | |
 / ___ \ (_| |  __/ | | | |_| |  _| |_| |
/_/   \_\__, |\___|_| |_|\__|_|_|  \__, |
        |___/                      |___/
```

# Agentify

[![npm version](https://img.shields.io/npm/v/agentify)](https://www.npmjs.com/package/agentify)
[![license](https://img.shields.io/npm/l/agentify)](./LICENSE)
[![node](https://img.shields.io/node/v/agentify)](https://nodejs.org)

> **Switch agents. Keep the repo's working memory.**

> **Install once. Your coding agent uses it automatically.** From then on, the agent drives Agentify—not you: Claude Code through lifecycle hooks, Codex through installed guidance.

Agentify keeps durable working context with the repository instead of trapping it inside one agent harness. Install Claude Code and Codex support against the same `.agentify/context/` store, switch between them, and let the next agent load the recorded decisions, session summaries, failures, hot files, and recent activity instead of rediscovering the project. MCP exposes the same capabilities to other compatible agents.

Agentify does not replay a provider's hidden conversation state or copy private chain-of-thought. It carries forward explicit, compact project evidence that should survive the switch.

Think of it like [`rtk`](https://github.com/rtk-ai/rtk): a tool you install into a project that wires itself into your agent's configuration and then stays out of your way.

## How it works

```
agentify install --provider all
  |-- CLAUDE.md             <- Claude Code guidance
  |-- AGENTS.md             <- Codex guidance: load, note, decide, hand off
  |-- .claude/settings.json <- Claude Code hooks:
  |     SessionStart -> agentify ctx load     (inject context digest)
  |     PreToolUse   -> agentify ctx precheck (warn before repeating a failed command)
  |     PostToolUse  -> agentify ctx track    (record edits + commands + failures)
  |     ExitPlanMode -> plan-to-html.mjs      (save approved plans to plans/*.html)
  |     SessionEnd   -> agentify ctx track    (close out the session)
  `-- .agentify/            <- shared JSONL context store + optional repo index
```

Every session after that:

1. **Session starts** -> Claude Code's hook injects the digest automatically; Codex follows the installed `AGENTS.md` guidance and runs `agentify ctx load` against the same store.
2. **Agent works** -> Claude Code hooks track file edits and shell commands automatically (compact JSONL, auto-compacted, capped at ~512 KB). Command failures are remembered and checked before a retry. Codex has no lifecycle hooks: its installed guidance tells the agent to load context and explicitly record durable notes, decisions, and handoffs as it works.
3. **Agent learns something worth keeping** -> it runs `agentify ctx note "..."`. Notes are verified when injected: if a note references a file that no longer exists, it's flagged as possibly stale so the agent re-verifies instead of trusting outdated memory.
4. **Session ends** -> Agentify creates a short extractive handoff from tracked evidence with zero model cost (`agentify ctx handoff` for explicit ones; an LLM refinement is a budgeted opt-in).

No daemon, no database server, no per-command wrapping. Context tracking is plain JSONL under `.agentify/context/`.

## Quick start

Agentify installs straight from GitHub (no npm registry release needed):

```bash
curl -fsSL https://raw.githubusercontent.com/ixigo/agentify/main/install.sh | bash
```

<details>
<summary>Other install methods</summary>

```bash
# npm can install directly from git
npm install -g github:ixigo/agentify

# or clone + link for development
git clone https://github.com/ixigo/agentify.git && cd agentify
pnpm install && pnpm link --global
```

Pin a branch, tag, or commit with the installer: `AGENTIFY_REF=v0.3.0 bash install.sh`.

</details>

```bash
cd /path/to/your/repo
agentify install --provider all   # Claude Code + Codex, one repo-owned store

# or wire one harness only
agentify install --provider claude
agentify install --provider codex

# optional: build the structural index for query/risk commands
agentify scan
```

Prefer a single global setup instead of per-repo files?

```bash
agentify install --global --provider all     # Claude Code + Codex global guidance
```

Check or undo at any time:

```bash
agentify status
agentify uninstall            # removes only Agentify's managed block and hooks
```

Both install and uninstall are surgical: they only touch content between `<!-- agentify:begin -->` / `<!-- agentify:end -->` markers, Agentify-managed hook entries, and Agentify's generated `.claude/hooks/plan-to-html.mjs` file. Your own CLAUDE.md content and hooks are preserved.

## Commands

| Command | What it does |
| --- | --- |
| `agentify install [--global] [--provider claude\|codex\|all]` | Wire Agentify into the repo (or your home config) |
| `agentify uninstall [--global]` | Remove the managed block and hooks |
| `agentify status` | Integration + context-tracking status |
| `agentify ctx load` | Digest of recent activity, notes, hot files |
| `agentify ctx note "<text>"` | Record a note for future sessions |
| `agentify ctx decision "<text>"` | Record a durable technical decision; `agentify ctx decisions "<topic>"` answers "why did we choose X" later |
| `agentify ctx explain "<task>"` | Dry-run of per-task injection: token budget, profile, and every include/skip/truncate reason — nothing recorded |
| `agentify ctx precheck "<cmd>"` | Check whether a command failed in an earlier session (automatic via PreToolUse hook) |
| `agentify ctx handoff ["task"]` | Write a handoff summary |
| `agentify ctx summarize` | ~3-line model-written session summary (automatic on session end) |
| `agentify ctx share [--off]` | Make notes committable team memory — with decisions, that's a lightweight team ADR log |
| `agentify ctx status` | Event/note counts, log size, paused state |
| `agentify ctx pause\|resume\|clear` | Start from scratch: stop the digest + tracking, or archive and reset (`AGENTIFY_CTX=off` for one session) |
| `agentify delegate <kind> ["task"]` | Shell a task out to the routed model (`--diff`, `--write`) |
| `agentify models` | Model routing table + provider availability |
| `agentify stats [--days N]` | Session + delegation usage: runs, tokens, cost by kind and model |
| `agentify value [--days N] [--format text\|json\|html]` | Evidence-backed impact: reused context, rejected stale data, intercepted failures, routing economics, and focused tests |
| `agentify analyze [--days N] [--scope current-repo\|global] [--format text\|json\|html] [--no-open]` | Privacy-first analysis of your local Claude Code/Codex session history: usage, tool patterns, evidence-backed Agentify opportunities, a 0–100 usage scorecard that grades model-vs-task matchups ("a gun at a fist fight" gets called out as a delegation candidate), and exactly one roast. Defaults to a local Agentify-themed HTML report and opens it in your browser; use `--no-open` for CI/headless runs. Metadata only, consent-gated (`--yes`), zero AI spend; `--dry-run` previews what would be read |
| `agentify eval init\|run\|report\|compare\|list` | Paired Agentify+Claude vs plain-Claude benchmarks with deterministic grading, cost-performance reports, and CI regression gates |
| `agentify eval harbor validate\|plan\|import` | Harbor (Terminal-Bench 2.0) adapter: token-free dataset validation, spend ceilings, and importing container-run results into the native report (`docs/harbor.md`) |
| `agentify scan` | Build the SQLite structural index |
| `agentify query <owner|deps|changed|search|def|refs|callers|impacts>` | Structural queries over the index |
| `agentify risk --since <ref>` | Blast radius + suggested regression tests |
| `agentify test [--since <ref>] [--run]` | Select (and run) only the tests affected by a change, via the structural index |
| `agentify up` | scan -> check |
| `agentify check` | Validate index freshness and generated artifacts |
| `agentify serve` | MCP server over stdio — Agentify tools for any MCP-capable agent |
| `agentify skill list|install` | Install bundled agent skills (Claude, Codex, Gemini, OpenCode) |
| `agentify review [--diff <ref>] [--push]` | Cross-vendor review of a change (`--push` reviews outgoing commits) |
| `agentify hooks install|remove|status` | Optional git hooks (pre-commit check, post-merge rescan, opt-in pre-push review) |
| `agentify doctor` | Toolchain and provider CLI readiness |
| `agentify clean` | Prune stale generated artifacts |
| `agentify completion zsh|bash|fish` | Shell completion |

All commands accept `--json` for machine-readable output — which is how agents are expected to call them.

## Beyond Claude Code and Codex: MCP

Hooks are Claude Code-specific and `AGENTS.md` guidance is best-effort. For every other agent — Cursor, Zed, Windsurf, Gemini CLI, Claude Desktop — Agentify speaks [MCP](https://modelcontextprotocol.io):

```bash
agentify serve        # stdio MCP server, run from the repo root
```

```bash
# Claude Code (as an alternative or complement to hooks)
claude mcp add agentify -- agentify serve

# Cursor/Zed/anything else: register `agentify serve` as a stdio MCP server
```

Exposed tools: `ctx_load`, `ctx_note`, `ctx_match` (persistent context), `query` (structural queries), `risk` (blast radius), `test_select` (impact-aware test selection). No extra dependencies — the server is part of the CLI.

## Model routing

`agentify install` also configures **model routing**: a table mapping kinds of work to the model best suited for it, written into `.agentify.yaml`. The guidance block teaches the agent to shell work out instead of doing everything inline:

```bash
agentify delegate quick "rename getUser to fetchUser in src/api.ts" --write
agentify delegate review --diff origin/main     # independent review by a different vendor
agentify delegate heavy "why does this deadlock under load?"
agentify delegate research "what does RFC 6902 say about array patches?"
agentify delegate auto "fix the failing checkout flow"   # classify the task, pick the route
agentify models                                  # show the routing table + availability
agentify route explain "design the migration" --profile performance   # dry-run the decision
```

| Kind | Default route | Used for |
| --- | --- | --- |
| `quick` | Claude Haiku | Small, low-impact edits, mechanical changes, quick questions |
| `implement` | Claude Sonnet | Standard feature work and multi-file refactors |
| `heavy` | Claude Opus | Architecture decisions, deep debugging, high-risk changes |
| `review` | Codex (CLI default model) | Independent post-change review by a different vendor |
| `research` | Claude Haiku | Fast exploration, summarization, doc lookups |

Defaults use version-independent Claude aliases and the Codex CLI's configured default model, so they don't rot as models are released. If a route's CLI isn't installed, Agentify falls back to the other vendor automatically **at the same capability tier** (economy/balanced/frontier) — a missing Codex never silently upgrades a review to a frontier-priced model. Override any route in `.agentify.yaml` under `models.routes`. Delegations run non-interactively (`claude -p` / `codex exec`), read-only by default — pass `--write` to allow edits.

Delegate execution goes through **provider adapters** in one registry: each provider declares how its headless command is built, how its structured output parses into normalized usage/cost, which ceilings it can enforce natively (anything else is covered by the pre-run rolling budget check and the wall-clock timeout, and surfaced per run as `unsupported_controls` — never silently ignored), and its per-tier models. Current tier models: Claude `haiku`/`sonnet`/`opus` aliases; Codex `gpt-5.6-luna`/`gpt-5.6-terra`/`gpt-5.6-sol`; override under `models.tiers`.

**Gemini CLI and OpenCode are opt-in delegate providers**: when installed they show up in `agentify models` and work with an explicit `--provider gemini|opencode`, but they never join default routes or fallback chains until the repo enables them (`models.providers.gemini.enabled: true`) — price alone is not evidence of coding quality; run the eval suite (`agentify eval`) against them first. Per-route fallback chains can be pinned with `models.routes.<kind>.fallbacks` and are validated against unknown providers, loops, and cost-tier escalation beyond the active profile's bound.

**Routing profiles** choose how to route inside the hard budget ceilings (never widening them). Set `models.profile` in `.agentify.yaml`, `AGENTIFY_PROFILE`, or `--profile` per run — explicit `--provider`/`--model` always wins:

- `cost` — cheapest evaluated route meeting a quality floor; never downgrades without sufficient eval evidence.
- `balanced` (default) — lowest measured cost per passing task; with no eval evidence it behaves exactly like the manual routes.
- `performance` — highest measured pass rate within your ceilings; escalates only on measured gains, not price.

Profiles feed on locally recorded `agentify eval` runs; recommendations never rewrite your config (no self-modifying router). `agentify route explain "<task>"` or `delegate --dry-run` shows the full decision: profile, tier, limits, fallback chain, and the evidence behind it, with alias-drift warnings when routes use unpinned model aliases.

Want a second vendor's eyes on every push? Enable the opt-in pre-push hook (`hooks.prePush: true` in `.agentify.yaml`, then `agentify hooks install`): each `git push` triggers `agentify review --push` — an independent review of the outgoing commits by the other vendor's model. Advisory only; it never blocks the push.

Every delegation is logged locally with duration, token usage, and cost (real numbers where the provider CLI reports them, ~4 chars/token estimates otherwise). `agentify stats` breaks it down by kind and model — so you can see what routing cheap work to cheap models is actually saving.

## Make the invisible value visible

Agentify's context and guardrails run quietly. Generate a local receipt that makes their observable impact shareable:

```bash
agentify value --days 7
agentify value --days 7 --format json
agentify value --days 7 --format html  # writes agentify-value-report.html
```

The HTML report is self-contained and shows decisions surfaced in later tasks, stale context rejected before injection, prior command failures intercepted before a repeat, estimated context tokens with their evidence sources, delegation cost and latency, focused test files selected instead of the indexed full suite, and deterministic eval cost per passing task. Claims remain deliberately bounded: provider costs are never guessed, token counts are marked as estimates, and a warning is not presented as proof that a command was abandoned.

## Paired evaluation: does Agentify actually help?

Cost only means something next to task success. `agentify eval` runs the same task, prompt, pinned Claude model, and budget through paired arms and grades each attempt with deterministic checks — so you can see whether Agentify's context raises pass rate or lowers cost per pass versus plain Claude:

- **`agentify`** — normal integration: hooks, guidance block, seeded context.
- **`plain-safe`** — `claude --safe-mode`: a vanilla-Claude baseline with no CLAUDE.md, hooks, skills, or MCP.
- **`plain-project`** — only Agentify's managed CLAUDE.md/settings blocks removed; unrelated project guidance kept.

```bash
agentify eval init my-task          # commit-pinned manifest in evals/my-task.yaml
agentify eval run my-task --dry-run # exact arm commands + maximum possible spend, no provider call
agentify eval run my-task --repeat 3
agentify eval list                  # tasks and past runs with per-arm pass rates
```

Every attempt runs in a disposable clone at the manifest's immutable `base_ref` — never in your checkout — with a hard per-attempt budget/turn/timeout ceiling, so a run can never spend more than `arms × repeats × cap`. Pass/fail comes from the manifest's `grader.commands` and `forbidden_paths`, never from the provider exit code. Artifacts (patch, provider output, per-attempt grades) land under `.agentify/evals/runs/`, spend is recorded toward the same rolling budget caps as delegations, and interrupted runs resume with `--resume <run-id>` re-executing only missing attempts.

Turn a run into a decision with `agentify eval report [run-id] --format json|md|html`: per-arm pass rates with 95% confidence intervals, provider-reported vs unreported cost kept separate, cost per passing task, paired deltas with discordant-pair counts, and a cost-quality frontier with marginal dollars per additional pass. Underpowered, partial, or unpaired runs are labeled and never produce a confident winner. For CI, `agentify eval compare current.json baseline.json --fail-on 'pass_rate_drop>0.02' --fail-on 'cost_per_pass_increase>0.10' --fail-on 'p95_latency_increase>0.20'` exits 0 when gates pass, 1 on a violation (naming the exact gate), and 2 on invalid input. Teams on promptfoo can export a run into its results format with `--format promptfoo` (a dependency-free interchange file; the raw prompt stays out of it, identified by hash only).

**Second harness (Harbor):** to make sure the signal isn't an artifact of Agentify's own runner, a portable 8-task benchmark dataset ships under `evals/harbor/` for [Harbor](https://www.harborframework.com) (Terminal-Bench 2.0): container-isolated tasks, an `agentify-claude` installed agent paired against Harbor's plain `claude-code` agent on the same image/model/verifier, plus an optimization-profile matrix suite. Harbor never becomes a runtime dependency — `agentify eval harbor validate` (schema + fixture answer-leak checks, token-free, runs in CI), `agentify eval harbor plan --suite smoke` (hard spend ceiling before launch), and `agentify eval harbor import <job-dir>` (Harbor trials become native runs, so `eval report`/`compare` work unchanged with provenance labeled). See `docs/harbor.md`.

**First nightly results (2026-07-14** — 8 tasks × 2 arms × 3 attempts, `claude-haiku-4-5`, $2.10 actual spend against the $16.80 ceiling**):** the Agentify arm passed **24/24** attempts vs **21/24** for plain Claude Code on the same images, model, and verifiers. All three baseline failures landed on the prior-failure-avoidance task, where a production incident recorded in the context store is the only thing separating the arms — the seeded note turned 0/3 into 3/3. Both honesty controls held: the mechanical task (context adds nothing) and the misleading-context task (wrong-but-plausible notes must not cause damage) tied at 3/3 per arm, with zero flakes across 48 trials. The report still declares **no winner**, by design: 3 discordant pairs (all favoring Agentify) give an exact sign-test p = 0.25 and overlapping Wilson intervals, and the fail-closed winner rule requires CI separation *and* p < 0.05 — accumulating nightly runs (or more attempts on discordant tasks) is what gets there. On cost, the Agentify arm averaged $0.055/attempt vs $0.033 (+66%): persistent context is paid for in tokens, and on the one task with signal that ~$0.03 premium was the difference between failing and passing. This suite deliberately measures the **context layer only** — delegation (routing quick/mechanical work to cheaper models, reviews to the other vendor), which is designed to win that per-attempt premium back in real workflows, runs context-off by construction and can't function in single-vendor containers, so its economics are measured separately by `agentify stats`, `agentify value`, and the native eval profiles rather than claimed here.

## Platform workflows

Whether you're on GitHub, GitLab, or Azure DevOps, there's a prebuilt workflow to get things done — triage the board, pick up an item, implement it in an isolated worktree, and raise a draft PR:

```bash
agentify workflow list        # shows bundles + which platform CLI is installed
agentify workflow install     # auto-detects gh/glab/azure from the git remote
agentify workflow install azure --provider claude
```

| Platform | CLI | Bundle |
| --- | --- | --- |
| GitHub | `gh` | github-triage, grill-me, gh-autopilot, issue-killer, worktree-autopilot, pr-creator, commit-creator |
| GitLab | `glab` | gitlab-triage, grill-me, glab-autopilot, issue-killer, worktree-autopilot, pr-creator, commit-creator |
| Azure DevOps | `az` | azure-devops-triage, grill-me, ado-autopilot, issue-killer, worktree-autopilot, pr-convention-learner, pr-creator, commit-creator |

**Worktrees and parallel work:** single tasks run through `worktree-autopilot` (fresh branch + `git worktree`, verify, commit, draft PR). When several opted-in issues are ready, `issue-killer` fans them out — one tmux pane and one worktree per issue, each running an interactive agent, supervised via `tmux attach -t issue-killer`. Every worktree has its own `.agentify/` store, so context tracking stays per-checkout, and `agentify ctx note` records what's in flight so later sessions know.

**You never invoke the workflow by name.** The bundle installs as agent skills, and the agent matches them to plain requests — a typical day:

```text
"triage the new issues"           → github-triage labels the board, marks agentify-ready
"pick up issue 231"               → gh-autopilot + worktree-autopilot: isolated branch,
                                    implement, test, cross-vendor review, draft PR
"file an issue for rate limiting" → grill-me interviews you until it's concrete, then files it
"kill everything agentify-ready"  → issue-killer fans out tmux worktree agents
next session                      → the SessionStart digest recalls what's in flight
```

Per-platform guides: [GitHub](https://ixigo.github.io/agentify/pages/workflow-gh.html) · [GitLab](https://ixigo.github.io/agentify/pages/workflow-glab.html) · [Azure DevOps](https://ixigo.github.io/agentify/pages/workflow-azure.html)

## What the agent sees

Context arrives when it's relevant, not as a firehose. Sessions start with a one-line pointer, and each prompt is matched against the store — only related notes and files get injected (deduplicated per session). Ask about payment retries:

```markdown
## Agentify context (relevant to this task)
### Related notes from earlier sessions
- [2026-07-05] payment retries: idempotency key lives in src/pay/retry.ts, do not regenerate per attempt

### Files previously worked on that look related
- src/pay/retry.ts (14 edits)
- src/pay/retry.test.ts (9 edits)

```

Prefer the old always-on behavior? Set `context.injection: digest` in `.agentify.yaml` (`off` disables injection entirely; tracking continues either way).

## Requirements

- Node.js 20+
- Git
- Claude Code for the automatic hook integration, or Codex for guidance-driven tracking via `AGENTS.md` (any other agent can still call `agentify ctx` / `query` / `risk` directly)

## Development

```bash
git clone https://github.com/ixigo/agentify.git
cd agentify
pnpm install
node --test
pnpm link --global   # for local CLI testing
```

More detail in [docs/usage.md](./docs/usage.md). Agent-facing setup prompt in [docs/LLM_PROMPT.md](./docs/LLM_PROMPT.md).

## License

MIT
