# Agentify documentation

Start here for the detail the [root README](../README.md) deliberately leaves out.

| Doc | What's in it |
| --- | --- |
| [usage.md](./usage.md) | The full guide: install, context tracking, token-budgeted injection, failure memory, decisions, index, routing, budgets, workflows, hooks, skills, MCP, ACP |
| [benchmarks.md](./benchmarks.md) | Every measured campaign, what is and isn't claimed, corrections log, how to reproduce |
| [harbor.md](./harbor.md) | Harbor (Terminal-Bench 2.0) adapter and the portable 38-task dataset |
| [swebench.md](./swebench.md) | SWE-bench Verified warm/cold protocol and contamination controls |
| [LLM_PROMPT.md](./LLM_PROMPT.md) | Agent-facing setup prompt |

Per-platform workflow guides: [GitHub](https://ixigo.github.io/agentify/pages/workflow-gh.html) · [GitLab](https://ixigo.github.io/agentify/pages/workflow-glab.html) · [Azure DevOps](https://ixigo.github.io/agentify/pages/workflow-azure.html)

## Install methods

```bash
# recommended
curl -fsSL https://raw.githubusercontent.com/ixigo/agentify/main/install.sh | bash

# npm, straight from git
npm install -g github:ixigo/agentify

# clone + link for development
git clone https://github.com/ixigo/agentify.git && cd agentify
pnpm install && pnpm link --global
```

Pin a ref with the installer: `AGENTIFY_REF=v0.3.0 bash install.sh`.

Then wire a repo (or your home config):

```bash
agentify install --provider all      # Claude Code + Codex, one repo-owned store
agentify install --provider claude   # or a single harness
agentify install --global            # global guidance instead of per-repo files
agentify install --skip-mcp          # guidance + hooks only
agentify install --no-index          # skip the structural index build
agentify scan                        # build the index later
```

Install and uninstall are surgical: they only touch content between `<!-- agentify:begin -->` / `<!-- agentify:end -->` markers, Agentify-managed hook entries, and Agentify's generated `.claude/hooks/plan-to-html.mjs`. Your own CLAUDE.md content and hooks are preserved.

`agentify install` also detects installed provider CLIs, registers the MCP server with each (idempotent, config backed up, unrelated keys preserved), keeps new Agentify-owned files local through a managed `.gitignore` block, and prints a receipt with per-phase timings. A provider that is installed but unauthenticated warns and continues. ACP client registration is not part of install yet. Every automated step has a manual equivalent — see [usage.md](./usage.md#one-command-install-registration-index-and-a-first-run-win).

## Command reference

All commands accept `--json` for machine-readable output — which is how agents are expected to call them.

### Core

| Command | What it does |
| --- | --- |
| `agentify install [--global] [--provider claude\|codex\|all]` | Wire Agentify into the repo (or your home config) |
| `agentify uninstall [--global]` | Remove the managed block and hooks |
| `agentify status` | Integration + context-tracking status |
| `agentify doctor` | Toolchain and provider CLI readiness |
| `agentify clean` | Prune stale generated artifacts |
| `agentify completion zsh\|bash\|fish` | Shell completion |

### Context — the working-memory store

| Command | What it does |
| --- | --- |
| `agentify ctx load` | Digest of recent activity, notes, hot files |
| `agentify ctx note "<text>"` | Record a note for future sessions |
| `agentify ctx decision "<text>"` | Record a durable decision; `ctx decisions "<topic>"` answers "why did we choose X" later |
| `agentify ctx explain "<task>"` | Dry-run of per-task injection: budget, profile, every include/skip/truncate reason — nothing recorded |
| `agentify ctx precheck "<cmd>"` | Check whether a command failed in an earlier session (automatic via PreToolUse hook) |
| `agentify ctx handoff ["task"]` | Write a handoff summary |
| `agentify ctx summarize` | ~3-line model-written session summary (automatic on session end) |
| `agentify ctx share [--off]` | Make notes committable team memory — with decisions, a lightweight team ADR log |
| `agentify ctx pause\|resume\|clear` | Stop the digest + tracking, or archive and reset (`AGENTIFY_CTX=off` for one session); `ctx status` shows counts, log size, paused state |

### Model routing

| Command | What it does |
| --- | --- |
| `agentify delegate <kind> ["task"]` | Shell a task out to the routed model (`--diff`, `--write`) |
| `agentify models` | Model routing table + provider availability |
| `agentify route explain "<task>"` | Dry-run the routing decision for a task |
| `agentify stats [--days N]` | Machine-wide CLI/hook/MCP invocations plus session and delegation usage |
| `agentify value [--days N] [--format text\|json\|html]` | Evidence-backed impact: reused context, rejected stale data, intercepted failures, routing economics, focused tests |
| `agentify analyze [--days N] [--scope current-repo\|global] [--format text\|json\|html]` | Privacy-first analysis of local Claude Code/Codex session history: usage, tool patterns, delegation opportunities, a 0–100 scorecard, and exactly one roast. Metadata only, consent-gated (`--yes`), zero AI spend |

### Structural index

| Command | What it does |
| --- | --- |
| `agentify scan` | Build the SQLite structural index |
| `agentify query <owner\|deps\|changed\|search\|def\|refs\|callers\|impacts>` | Structural queries over the index |
| `agentify risk --since <ref>` | Blast radius + suggested regression tests |
| `agentify test [--since <ref>] [--run]` | Select (and run) only the tests a change affects — npm scripts, pytest, `go test`, cargo, Maven/Gradle, `dotnet test` |
| `agentify up` / `agentify check` | scan → check / validate index freshness and generated artifacts |

### Evaluation

| Command | What it does |
| --- | --- |
| `agentify eval init\|run\|report\|compare\|list` | Paired Agentify+Claude vs plain-Claude benchmarks with deterministic grading and CI regression gates |
| `agentify eval harbor validate\|plan\|import` | Harbor adapter: token-free dataset validation, spend ceilings, result import ([harbor.md](./harbor.md)) |
| `agentify eval swebench validate\|plan\|import` | SWE-bench Verified warm/cold adapter ([swebench.md](./swebench.md)) |

### Workflows & serve

| Command | What it does |
| --- | --- |
| `agentify workflow list\|install` | Board-to-draft-PR workflow bundle for your platform |
| `agentify serve` | MCP server over stdio |
| `agentify acp --provider <claude\|codex>` | ACP pass-through proxy with optional context injection and session capture |
| `agentify skill list\|install` | Install bundled agent skills (Claude, Codex, Gemini, OpenCode) |
| `agentify review [--diff <ref>] [--push]` | Cross-vendor review of a change |
| `agentify hooks install\|remove\|status` | Optional git hooks (pre-commit check, post-merge rescan, opt-in pre-push review) |

## Beyond Claude Code and Codex

Hooks are Claude Code-specific and `AGENTS.md` guidance is best-effort. Every other agent — Cursor, Zed, Windsurf, Gemini CLI, Claude Desktop — reaches the same capabilities over [MCP](https://modelcontextprotocol.io):

```bash
agentify serve                            # stdio MCP server, run from the repo root
claude mcp add agentify -- agentify serve  # Claude Code, as an alternative to hooks
```

Exposed tools: `ctx_load`, `ctx_note`, `ctx_match`, `ctx_decisions`, `ctx_handoff`, plus `query`, `risk`, and `test_select`. The server supports both legacy 2025-era clients and the stateless MCP `2026-07-28` protocol.

[ACP](https://agentclientprotocol.com/) is the full-agent transport: an ACP client launches `agentify acp --provider codex`, which launches the downstream adapter and forwards messages unchanged. Its two Agentify behaviors are opt-in (`context.acpInjection`, `context.acpCapture`) and the workspace boundary is enforced, including symlink resolution. Details in [usage.md](./usage.md#full-agent-sessions-acp-proxy).

## Model routing

Install writes a routing table into `.agentify.yaml` so the agent shells work out instead of doing everything inline:

| Kind | Default route | Used for |
| --- | --- | --- |
| `quick` | Claude Haiku | Small, low-impact edits, mechanical changes, quick questions |
| `implement` | Claude Sonnet | Standard feature work and multi-file refactors |
| `heavy` | Claude Opus | Architecture decisions, deep debugging, high-risk changes |
| `review` | Codex (CLI default model) | Independent post-change review by a different vendor |
| `research` | Claude Haiku | Fast exploration, summarization, doc lookups |

Defaults use version-independent aliases so they don't rot. A missing CLI falls back to the other vendor **at the same capability tier**, so it never silently upgrades a review to frontier pricing. Gemini CLI and OpenCode are opt-in providers and never join default routes until the repo enables them. Routing profiles (`cost`, `balanced`, `performance`) choose inside the hard budget ceilings, never widening them, and feed only on locally recorded `agentify eval` runs — recommendations never rewrite your config. Every delegation is logged with duration, tokens, and cost. Routes, tiers, fallback chains, and budgets: [usage.md](./usage.md#model-routing).

## Value report

```bash
agentify value --days 7 --format html   # writes agentify-value-report.html
```

Self-contained report of decisions surfaced in later tasks, stale context rejected before injection, prior failures intercepted before a repeat, estimated context tokens with their evidence sources, delegation cost and latency, focused tests selected instead of the full suite, and eval cost per passing task. Claims stay bounded: provider costs are never guessed, token counts are marked as estimates, and a warning is not presented as proof a command was abandoned.

## Paired evaluation

Cost only means something next to task success. `agentify eval` runs the same task, prompt, pinned model, and budget through paired arms and grades each attempt with deterministic checks:

- **`agentify`** — normal integration: hooks, guidance block, seeded context.
- **`plain-safe`** — `claude --safe-mode`: no CLAUDE.md, hooks, skills, or MCP.
- **`plain-project`** — only Agentify's managed blocks removed; unrelated project guidance kept.

```bash
agentify eval init my-task           # commit-pinned manifest in evals/my-task.yaml
agentify eval run my-task --dry-run  # exact arm commands + maximum possible spend, no provider call
agentify eval run my-task --repeat 3
agentify eval report [run-id] --format json|md|html
```

Every attempt runs in a disposable clone at the manifest's immutable `base_ref` — never in your checkout — under a hard per-attempt budget/turn/timeout ceiling, so a run can never spend more than `arms × repeats × cap`. Pass/fail comes from `grader.commands` and `forbidden_paths`, never the provider exit code. Reports give per-arm pass rates with 95% CIs, cost per passing task, paired deltas with discordant-pair counts, and a cost-quality frontier; underpowered or unpaired runs are labeled and never produce a confident winner. CI gating with `agentify eval compare current.json baseline.json --fail-on 'pass_rate_drop>0.02'`.

Two further harnesses guard against the signal being an artifact of Agentify's own runner: **Harbor** (a portable 38-task container benchmark, [harbor.md](./harbor.md)) and an optional **SWE-bench Verified** warm-up experiment ([swebench.md](./swebench.md)). Results: [benchmarks.md](./benchmarks.md).

## What the agent sees

Context arrives when it's relevant, not as a firehose. Sessions start with a one-line pointer; each prompt is matched against the store, and only related notes and files are injected (deduplicated per session):

```markdown
## Agentify context (relevant to this task)
### Related notes from earlier sessions
- [2026-07-05] payment retries: idempotency key lives in src/pay/retry.ts, do not regenerate per attempt

### Files previously worked on that look related
- src/pay/retry.ts (14 edits)
- src/pay/retry.test.ts (9 edits)
```

Prefer the old always-on behavior? Set `context.injection: digest` in `.agentify.yaml` (`off` disables injection entirely; tracking continues either way). The selection algorithm and its token budget are documented in [usage.md](./usage.md#token-budgeted-context-injection).

## Platform workflows

```bash
agentify workflow list        # bundles + which platform CLI is installed
agentify workflow install     # auto-detects gh / glab / azure from the git remote
```

| Platform | CLI | Bundle |
| --- | --- | --- |
| GitHub | `gh` | github-triage, grill-me, gh-autopilot, issue-killer, worktree-autopilot, pr-creator, commit-creator |
| GitLab | `glab` | gitlab-triage, grill-me, glab-autopilot, issue-killer, worktree-autopilot, pr-creator, commit-creator |
| Azure DevOps | `az` | azure-devops-triage, grill-me, ado-autopilot, issue-killer, worktree-autopilot, pr-convention-learner, pr-creator, commit-creator |

You never invoke a workflow by name — the bundle installs as agent skills and the agent matches them to plain requests ("triage the new issues", "pick up issue 231", "kill everything agentify-ready"). Single tasks run through `worktree-autopilot` (fresh branch + `git worktree`, verify, commit, draft PR); `issue-killer` fans several out, one tmux pane and worktree each. Every worktree has its own `.agentify/` store, so tracking stays per-checkout. More in [usage.md](./usage.md#platform-workflows).
