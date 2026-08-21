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

<details open>
<summary><strong>For humans</strong> — wire it into a repo, then get out of the way</summary>

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

</details>

<details>
<summary><strong>For agents</strong> — you drive Agentify, not the human</summary>

After install, the human steps back — the coding agent runs Agentify itself. Claude Code does this through lifecycle hooks with no extra effort; Codex and other agents follow the installed `AGENTS.md` guidance. Call every command with `--json` for machine-readable output.

```bash
# start of session — load durable context (Claude Code's SessionStart hook does this automatically)
agentify ctx load --json

# before repeating a shell command that may have failed before
agentify ctx precheck "<cmd>" --json

# when you learn something worth keeping
agentify ctx note "<gotcha or open thread>"
agentify ctx decision "chose X over Y because Z"

# before finishing a change: blast radius + only the affected tests
agentify risk --since origin/main --json
agentify test --since origin/main --run --json

# shell work out to the best-suited model instead of doing it all inline
agentify delegate quick "<small edit>" --write
agentify delegate review --diff origin/main

# end of a long task
agentify ctx handoff --json
```

Every other agent — Cursor, Zed, Windsurf, Gemini CLI, Claude Desktop — reaches the same capabilities over [MCP](https://modelcontextprotocol.io): run `agentify serve` from the repo root.

</details>

## Commands

All commands accept `--json` for machine-readable output — which is how agents are expected to call them. Grouped below; expand a section for its commands.

<details>
<summary><strong>Core</strong> — install, status, housekeeping (6)</summary>

| Command | What it does |
| --- | --- |
| `agentify install [--global] [--provider claude\|codex\|all]` | Wire Agentify into the repo (or your home config) |
| `agentify uninstall [--global]` | Remove the managed block and hooks |
| `agentify status` | Integration + context-tracking status |
| `agentify doctor` | Toolchain and provider CLI readiness |
| `agentify clean` | Prune stale generated artifacts |
| `agentify completion zsh\|bash\|fish` | Shell completion |

</details>

<details>
<summary><strong>Context</strong> — the working-memory store (9)</summary>

| Command | What it does |
| --- | --- |
| `agentify ctx load` | Digest of recent activity, notes, hot files |
| `agentify ctx note "<text>"` | Record a note for future sessions |
| `agentify ctx decision "<text>"` | Record a durable technical decision; `agentify ctx decisions "<topic>"` answers "why did we choose X" later |
| `agentify ctx explain "<task>"` | Dry-run of per-task injection: token budget, profile, and every include/skip/truncate reason — nothing recorded |
| `agentify ctx precheck "<cmd>"` | Check whether a command failed in an earlier session (automatic via PreToolUse hook) |
| `agentify ctx handoff ["task"]` | Write a handoff summary |
| `agentify ctx summarize` | ~3-line model-written session summary (automatic on session end) |
| `agentify ctx share [--off]` | Make notes committable team memory — with decisions, that's a lightweight team ADR log |
| `agentify ctx pause\|resume\|clear` | Start from scratch: stop the digest + tracking, or archive and reset (`AGENTIFY_CTX=off` for one session); `agentify ctx status` shows event/note counts, log size, paused state |

</details>

<details>
<summary><strong>Model routing</strong> — delegate, stats, value, analyze (6)</summary>

| Command | What it does |
| --- | --- |
| `agentify delegate <kind> ["task"]` | Shell a task out to the routed model (`--diff`, `--write`) |
| `agentify models` | Model routing table + provider availability |
| `agentify route explain "<task>"` | Dry-run the routing decision for a task |
| `agentify stats [--days N]` | Machine-wide CLI/hook/MCP invocations plus session and delegation usage |
| `agentify value [--days N] [--format text\|json\|html]` | Evidence-backed impact: reused context, rejected stale data, intercepted failures, routing economics, and focused tests |
| `agentify analyze [--days N] [--scope current-repo\|global] [--format text\|json\|html] [--no-open]` | Privacy-first analysis of your local Claude Code/Codex session history: usage, tool patterns, evidence-backed Agentify opportunities, a 0–100 usage scorecard that grades model-vs-task matchups ("a gun at a fist fight" gets called out as a delegation candidate), and exactly one roast. Metadata only, consent-gated (`--yes`), zero AI spend; `--dry-run` previews what would be read |

</details>

<details>
<summary><strong>Evaluation</strong> — paired benchmarks + Harbor (2)</summary>

| Command | What it does |
| --- | --- |
| `agentify eval init\|run\|report\|compare\|list` | Paired Agentify+Claude vs plain-Claude benchmarks with deterministic grading, cost-performance reports, and CI regression gates |
| `agentify eval harbor validate\|plan\|import` | Harbor (Terminal-Bench 2.0) adapter: token-free dataset validation, spend ceilings, and importing container-run results into the native report (`docs/harbor.md`) |
| `agentify eval swebench validate\|plan\|import` | SWE-bench Verified warm/cold adapter: pinned sample validation, hard spend ceilings, and importing official-harness results (`docs/swebench.md`) |

</details>

<details>
<summary><strong>Structural index</strong> — scan, query, risk, test (6)</summary>

| Command | What it does |
| --- | --- |
| `agentify scan` | Build the SQLite structural index |
| `agentify query <owner\|deps\|changed\|search\|def\|refs\|callers\|impacts>` | Structural queries over the index |
| `agentify risk --since <ref>` | Blast radius + suggested regression tests |
| `agentify test [--since <ref>] [--run]` | Select (and run) only the tests affected by a change, via the structural index — npm scripts, pytest, `go test` (package-scoped), cargo, Maven/Gradle, and `dotnet test` runners |
| `agentify up` | scan -> check |
| `agentify check` | Validate index freshness and generated artifacts |

</details>

<details>
<summary><strong>Workflows &amp; serve</strong> — MCP, ACP, skills, review, hooks (6)</summary>

| Command | What it does |
| --- | --- |
| `agentify workflow list\|install` | Board-to-draft-PR workflow bundle for your platform |
| `agentify serve` | MCP server over stdio — Agentify tools for any MCP-capable agent |
| `agentify acp --provider <claude\|codex>` | ACP pass-through proxy with optional context injection and session capture |
| `agentify skill list\|install` | Install bundled agent skills (Claude, Codex, Gemini, OpenCode) |
| `agentify review [--diff <ref>] [--push]` | Cross-vendor review of a change (`--push` reviews outgoing commits) |
| `agentify hooks install\|remove\|status` | Optional git hooks (pre-commit check, post-merge rescan, opt-in pre-push review) |

</details>

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

Exposed tools: `ctx_load`, `ctx_note`, `ctx_match`, `ctx_decisions` (read the decision log before re-proposing a settled direction), `ctx_handoff` (leave a handoff at the end of a long task) — the persistent-context set — plus `query` (structural queries), `risk` (blast radius), `test_select` (impact-aware test selection). The server is bundled with the CLI and supports both legacy 2025-era clients and the stateless MCP `2026-07-28` protocol, including discovery, validated per-request metadata, and cacheable tool lists.

## Full-agent sessions over ACP

MCP exposes Agentify tools to an existing agent. [ACP](https://agentclientprotocol.com/) is the full-agent transport: an ACP-capable editor or client launches Agentify as a transparent proxy, and Agentify launches the downstream Claude or Codex adapter.

```bash
# Install the adapter used by the downstream provider.
npm install -g @agentclientprotocol/codex-acp

# Configure the ACP client to launch this command from the repo root.
agentify acp --provider codex
```

The proxy forwards ACP messages unchanged, including methods Agentify does not recognize. Its two Agentify-specific behaviors are opt-in:

```yaml
context:
  acpInjection: relevant  # off (default) | relevant | digest
  acpCapture: auto        # off (default) | auto | all | compare
```

`acpInjection` adds a token-budgeted context block to the first user turn. `acpCapture: auto` records edits, commands, failures, and session outcomes for hookless downstreams such as Codex; for Claude, whose hooks already own the main context store, it writes only the diagnostic comparison log so events are not double-counted. `agentify ctx capture-report` compares proxy capture with hook capture.

The workspace boundary is enforced for the repo root and its subdirectories, including symlink resolution, so a session outside the workspace cannot receive or write this repo's context. Both features honor `agentify ctx pause`. Claude's ACP adapter currently requires Node 22+; Agentify itself remains Node 20+ and prints a clear warning on an older runtime.

ACP client configuration is still manual: `agentify install` sets up guidance, hooks, MCP, and the index, but does not yet edit editor-specific ACP client config.

## One-command install and the first-run win

`agentify install` does the whole setup in one pass and prints a **receipt** of what it did. It:

1. **Detects** which provider CLIs are installed (Claude Code, Codex) and whether each is authenticated.
2. **Registers the Agentify MCP server** with every installed provider — Claude Code in `~/.claude.json`, Codex in `~/.codex/config.toml` — so the tools are actually reachable. Registration is idempotent, backs up the config before writing, and preserves every unrelated key. Re-running never adds a second entry.
3. **Wires guidance and hooks** (`CLAUDE.md` / `AGENTS.md`, Claude Code lifecycle hooks).
4. **Keeps new Agentify-owned project files local** through a managed `.gitignore` block. Mixed-ownership files are ignored only when Agentify creates them, and project skills add their exact installed directory instead of hiding the provider's whole skill tree. `CLAUDE.md` and `AGENTS.md` remain visible to Git; `.gitignore` is the tracked control file. Existing tracked files stay tracked—Agentify never stages their removal. `ctx share` is the explicit opt-in that re-includes team notes.
5. **Builds the structural index** for `query` / `risk` / `test_select`.
6. **Shows a first-run win** immediately: recent activity, hot files, and unresolved failed commands from your local sessions — or, on a repo with no Agentify history yet, a setup audit of your global provider config.

```bash
agentify install                       # detect + register + index, everything present
agentify install --provider claude     # force a specific provider (registers even if the CLI is absent)
agentify install --skip-mcp            # guidance + hooks only, no MCP registration
agentify install --no-index            # skip the structural index build
agentify install --no-progress         # suppress the interactive progress display
agentify install --home <dir>          # target a non-default home (used by tests; never touches your real config)
```

In an interactive terminal, install keeps the current phase animated and leaves
completed phases with their elapsed time on screen. Machine-readable JSON and
non-interactive output stay clean; the JSON receipt includes the same per-phase
timings under `timings`.

If a provider is installed but not authenticated, the install **warns and continues** — the MCP registration is written anyway (it is just config; auth is separate), and the receipt tells you which login command to run.

**ACP registration is not part of install yet.** The `agentify acp` proxy is available, but the receipt reports client registration as unavailable so it never claims to have edited an editor-specific ACP config.

### Manual fallback

Every automated step has a manual equivalent, in case you prefer to do it by hand or the automation is skipped:

| Automated step | Manual equivalent |
| --- | --- |
| Register MCP with Claude Code | `claude mcp add --scope user agentify -- agentify serve` (the automated path writes the user-scoped entry in `~/.claude.json`; Claude's default scope is project-local) |
| Register MCP with Codex | `codex mcp add agentify -- agentify serve`, or add a `[mcp_servers.agentify]` table (`command = "agentify"`, `args = ["serve"]`) to `~/.codex/config.toml` |
| Guidance + hooks | `agentify install --skip-mcp` |
| Build the index | `agentify scan` |
| See the first-run win later | `agentify ctx load` (session digest) or `agentify analyze --include-config` (setup audit) |
| Undo everything | `agentify uninstall` removes guidance and hooks; the user-scoped MCP registration is shared across repos, so it is removed only with `agentify uninstall --global` or `--mcp`. Manually: `claude mcp remove agentify` / delete the `[mcp_servers.agentify]` table |

Honest scope: Claude Code tracking is automatic via hooks; Codex is guidance-driven (`AGENTS.md`); hidden provider transcripts are never replayed. The install output does not claim otherwise.

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

Every CLI, hook, and MCP tool invocation contributes a private machine-wide daily count with no arguments, paths, or repo identity. Every delegation is also logged repo-locally with duration, token usage, and cost (real numbers where the provider CLI reports them, ~4 chars/token estimates otherwise). `agentify stats` breaks usage down by source and command, and delegations by kind and model — so you can see adoption and what routing cheap work to cheap models is actually saving.

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

**Second harness (Harbor):** to make sure the signal isn't an artifact of Agentify's own runner, a portable 38-task benchmark dataset ships under `evals/harbor/` for [Harbor](https://www.harborframework.com) (Terminal-Bench 2.0): container-isolated tasks, an `agentify-claude` installed agent paired against Harbor's plain `claude-code` agent on the same image/model/verifier, plus an optimization-profile matrix suite. Harbor never becomes a runtime dependency — `agentify eval harbor validate` (schema + fixture answer-leak checks, token-free, runs in CI), `agentify eval harbor plan --suite smoke` (hard spend ceiling before launch), and `agentify eval harbor import <job-dir>` (Harbor trials become native runs, so `eval report`/`compare` work unchanged with provenance labeled). See `docs/harbor.md`.

**External benchmark (SWE-bench Verified):** `evals/swebench/` adds an optional
repo-warm-up experiment over a pinned, bounded SWE-bench Verified sample. The
cold and Agentify-warm arms use the same fresh checkout, issue, Claude model,
and limits; only the warm arm restores a repository-only context store. Gold
and test data are barred from warm-up by an input allowlist plus a runtime leak
scan, and the official SWE-bench Docker harness grades generated patches.
`agentify eval swebench plan` prints the maximum spend before launch; imported
reports label `harness: swebench` and add turns-to-first-edit telemetry. This is
not an official leaderboard run. See `docs/swebench.md`.

**First nightly results (2026-07-14** — the then-8-task nightly × 2 arms × 3 attempts, `claude-haiku-4-5`, $2.10 actual spend against its $16.80 ceiling; the dataset has since grown to 38 tasks and a 15-task nightly, not yet re-run; receipts committed under `evals/results/harbor-20260714/`**):** the Agentify arm passed **24/24** attempts vs **21/24** for plain Claude Code on the same images, model, and verifiers. All three baseline failures landed on the prior-failure-avoidance task, where a production incident recorded in the context store is the only thing separating the arms — the seeded note turned 0/3 into 3/3. Both honesty controls held: the mechanical task (context adds nothing) and the misleading-context task (wrong-but-plausible notes must not cause damage) tied at 3/3 per arm, with zero flakes across 48 trials. The report still declares **no winner**, by design: 3 discordant pairs (all favoring Agentify) give an exact sign-test p = 0.25 and overlapping Wilson intervals, and the fail-closed winner rule requires CI separation *and* p < 0.05 — accumulating nightly runs (or more attempts on discordant tasks) is what gets there. On cost, the Agentify arm averaged $0.055/attempt vs $0.033 (+66%): persistent context is paid for in tokens, and on the one task with signal that ~$0.03 premium was the difference between failing and passing. This suite deliberately measures the **context layer only** — delegation (routing quick/mechanical work to cheaper models, reviews to the other vendor), which is designed to win that per-attempt premium back in real workflows, runs context-off by construction and can't function in single-vendor containers, so its economics are measured separately by `agentify stats`, `agentify value`, and the native eval profiles rather than claimed here.

**Downshift matrix results (2026-08-19** — 9 tasks (3 scenario families × 3 difficulties) × 2 arms × 3 attempts × the then-3-rung model ladder = 162 trials, $9.21 spent of the ceiling; receipts + regenerable grid under `evals/results/harbor-20260819/`; the suite has since grown to a 2-rung, 15-task, 180-trial ladder with two additional scenario families (#318)**):** `agentify eval grid` declares the campaign's suite-level winner under the fail-closed rule (≥5 discordant pairs favoring Agentify, exact sign-test p < 0.05, *and* non-overlapping Wilson 95% intervals — every clause must hold, discordant wins spanning ≥2 task families included): **WINNER: agentify — pooled over 54 gradeable pairs, 51/54 vs 36/54 for plain Claude Code, discordant 16/1 spanning 2 families, p = 0.000275, Wilson 84.9–98.1% vs 53.4–77.8%.** Where the wins come from, stated plainly: 14 of 16 are the prior-failure-avoidance family — the baseline re-introduced the recorded production regression on every one of its graded failures while Agentify never did — and 2 are pairs where the baseline hung and died mid-run while Agentify finished (counted symmetrically; an Agentify crash handed the baseline its 1). On the `sonnet-4-5` rungs **cost per passing task also flips in Agentify's favor** ($0.150 vs $0.192 at hard): recalled context is cheaper than rediscovery at frontier-model prices. Honest scope: this is Agentify's own context benchmark (now 38 tasks); only attempts the provider itself reported as never-ran are excluded (50 of the 54 attempts on the since-retired `claude-3-5-haiku` rung — API 404; the suite is now a 2-rung ladder), crashes and lost telemetry count as failures for their own arm, one family still dominates the wins (broadening the family bank is #318), and the stricter single-cell #317 target is not yet met. Paired multisession and cross-vendor runs from the same campaign tied at `haiku-4-5` (with a measured **147,508-token rediscovery receipt** on the multisession pair); details in `docs/harbor.md`.

**Five-family downshift results (2026-08-21** — 15 tasks (5 scenario families × 3 difficulties) × 2 arms × 3 attempts × 2 model rungs = 180 trials; receipts + regenerable grid under `evals/results/harbor-20260821-downshift5/`**):** both fail-closed verdicts are now met by the tool, not by hand. Suite-level (#322 rule): **WINNER agentify — 84/86 (98%) vs 56/86 (65%) pooled gradeable pairs, discordant 28/0 spanning two task families, exact sign p = 7.45×10⁻⁹, Wilson CIs separated (91.9–99.4% vs 54.6–74.4%)**. Per-cell (#317, ≥5 discordant in a single model×difficulty cell at p < 0.05): **met for the first time, in two cells**. The newest task family — cap-the-parallel-fanout, added days earlier — is the single biggest separator (16 of the 28 wins), and three of the five families tied outright. Four baseline attempts are excluded as infrastructure: reviewing the first write-up of this campaign showed four "wins" sat opposite a *crashed* baseline, and once the importer preserved the provider's exception type the cause was plain — failures inside the agent's own install step, before any model ran. Correcting that cost the bigger headline (32/0 across four families) and left the honest one above. The claim, scoped: on realistic regression traps whose fix lives only in recorded project memory, durable repo memory turns a coin flip into a near-certainty.

**Store-size ladder (2026-08-21** — does budgeted retrieval beat context stuffing once a store is realistic? 3 scenarios × store100/store300, then 9 attempts per arm at store300; receipts under `evals/results/harbor-20260821-storeladder/`**):** **no — not on this bank.** At 300-note stores, pooled over 27 attempts per arm: CLAUDE.md stuffing 24/27, Agentify 20/27, plain Claude 2/27. Paired: **18/0 discordant against no-memory (p = 8×10⁻⁶, decisive)**, but **2/6 against stuffing (p = 0.29, not significant, direction favouring stuffing)** — at near-identical cost ($2.18 vs $2.09), so the "stuffing pays a context tax" premise does not hold at this scale either. Two committed token-free diagnostics show why this is *not* a retrieval bug: the seeded note is retrieved at every store size with no rank decay, and every real note survives the token budget. Agentify gets exactly the right knowledge and converts it less often on one of three scenarios. Published as-is: the claim this benchmark supports is **memory versus no memory**, not Agentify versus memory banks.

**First competitor head-to-head (2026-08-20** — 8 tasks × 4 arms × 5 attempts, same image/model/budget/verifier per arm, every armed arm given the same knowledge in its own tool's native format; $9.17 in reported provider subtotals covering 155 of 160 attempts (the 5 uncosted attempts are lost-telemetry provider errors, counted against their own arms) of the $56.00 ceiling; receipts under `evals/results/harbor-20260820-headtohead/`**):** against plain Claude Code, Agentify passed **36/40 vs 26/40** with pooled discordant **10/0** (sign p = 0.00195 — a strong directional result whose pooled Wilson intervals still overlap at 5 attempts per task, so the fail-closed rule declares no winner yet) — and against [Serena](https://github.com/oraios/serena) (the free LSP code-intelligence MCP, pinned 1.7.0), discordant **9/0**: Serena did not recover the seeded incident knowledge even from its own native memories. No attempt imported as a preflight abort, though one Serena attempt died after ~9h with no telemetry and is counted as a Serena failure — the conservative direction. Against the zero-infrastructure **CLAUDE.md memory-bank stuffing** arm the result is a **statistical tie** (37/40 vs 36/40, discordant 3/2 for the memory bank; incomplete cost telemetry supports no cheaper-arm conclusion) — published deliberately: at this suite's tiny fixture size, stuffing is competitive, and budgeted retrieval's advantage must show up at store *scale*, which a store-size ladder will test next. Until that run exists, Agentify claims no superiority over memory-bank stuffing on small stores.

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
