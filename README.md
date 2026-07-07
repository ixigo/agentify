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

> **Install once. Your coding agent uses it automatically.**

Agentify gives AI coding agents lightweight, persistent context. You run `agentify install` once per repo; from then on **the agent drives Agentify, not you**. With Claude Code, hooks track what the agent touches automatically; with Codex, an `AGENTS.md` guidance block drives the same workflow. Every new session starts with a digest of what happened before.

Think of it like [`rtk`](https://github.com/rtk-ai/rtk): a tool you install into a project that wires itself into your agent's configuration and then stays out of your way.

## How it works

```
agentify install
  |-- CLAUDE.md             <- managed guidance block: how the agent should use agentify
  |-- .claude/settings.json <- Claude Code hooks:
  |     SessionStart -> agentify ctx load     (inject context digest)
  |     PreToolUse   -> agentify ctx precheck (warn before repeating a failed command)
  |     PostToolUse  -> agentify ctx track    (record edits + commands + failures)
  |     SessionEnd   -> agentify ctx track    (close out the session)
  `-- .agentify/            <- lightweight JSONL context store + optional repo index
```

Every session after that:

1. **Session starts** -> the hook injects a digest: recent notes, hot files, last activity.
2. **Agent works** -> file edits and shell commands are tracked automatically (compact JSONL, auto-compacted, capped at ~512 KB). Command failures are remembered: if the agent is about to rerun a command that failed in an earlier session and was never fixed, a warning is injected before it runs — no more rediscovering the same dead end every session.
3. **Agent learns something worth keeping** -> it runs `agentify ctx note "..."`. Notes are verified when injected: if a note references a file that no longer exists, it's flagged as possibly stale so the agent re-verifies instead of trusting outdated memory.
4. **Session ends** -> a fast model compresses the session into a ~3-line handoff, stored for future sessions (`agentify ctx handoff` for explicit ones).

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
agentify install          # wire up this repo (CLAUDE.md + Claude Code hooks)

# using Codex? this writes guidance into AGENTS.md instead
agentify install --provider codex
# or wire up both agents at once
agentify install --provider all

# optional: build the structural index for query/risk commands
agentify scan
```

Prefer a single global setup instead of per-repo files?

```bash
agentify install --global                    # ~/.claude/CLAUDE.md + ~/.claude/settings.json
agentify install --global --provider codex   # ~/.codex/AGENTS.md
```

Check or undo at any time:

```bash
agentify status
agentify uninstall            # removes only Agentify's managed block and hooks
```

Both install and uninstall are surgical: they only touch content between `<!-- agentify:begin -->` / `<!-- agentify:end -->` markers and hook entries whose command starts with `agentify ctx`. Your own CLAUDE.md content and hooks are preserved.

## Commands

| Command | What it does |
| --- | --- |
| `agentify install [--global] [--provider claude\|codex\|all]` | Wire Agentify into the repo (or your home config) |
| `agentify uninstall [--global]` | Remove the managed block and hooks |
| `agentify status` | Integration + context-tracking status |
| `agentify ctx load` | Digest of recent activity, notes, hot files |
| `agentify ctx note "<text>"` | Record a note for future sessions |
| `agentify ctx precheck "<cmd>"` | Check whether a command failed in an earlier session (automatic via PreToolUse hook) |
| `agentify ctx handoff ["task"]` | Write a handoff summary |
| `agentify ctx summarize` | ~3-line model-written session summary (automatic on session end) |
| `agentify ctx share [--off]` | Make notes committable team memory |
| `agentify ctx status` | Event/note counts, log size, paused state |
| `agentify ctx pause\|resume\|clear` | Start from scratch: stop the digest + tracking, or archive and reset (`AGENTIFY_CTX=off` for one session) |
| `agentify delegate <kind> ["task"]` | Shell a task out to the routed model (`--diff`, `--write`) |
| `agentify models` | Model routing table + provider availability |
| `agentify stats [--days N]` | Session + delegation usage: runs, tokens, cost by kind and model |
| `agentify scan` | Build the SQLite structural index |
| `agentify query <owner|deps|changed|search|def|refs|callers|impacts>` | Structural queries over the index |
| `agentify risk --since <ref>` | Blast radius + suggested regression tests |
| `agentify test [--since <ref>] [--run]` | Select (and run) only the tests affected by a change, via the structural index |
| `agentify up` | scan -> check |
| `agentify check` | Validate index freshness and generated artifacts |
| `agentify serve` | MCP server over stdio — Agentify tools for any MCP-capable agent |
| `agentify skill list|install` | Install bundled agent skills (Claude, Codex, Gemini, OpenCode) |
| `agentify hooks install|remove|status` | Optional git hooks (pre-commit check, post-merge rescan) |
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
agentify models                                  # show the routing table + availability
```

| Kind | Default route | Used for |
| --- | --- | --- |
| `quick` | Claude Haiku | Small, low-impact edits, mechanical changes, quick questions |
| `implement` | Claude Sonnet | Standard feature work and multi-file refactors |
| `heavy` | Claude Opus | Architecture decisions, deep debugging, high-risk changes |
| `review` | Codex (CLI default model) | Independent post-change review by a different vendor |
| `research` | Claude Haiku | Fast exploration, summarization, doc lookups |

Defaults use version-independent Claude aliases and the Codex CLI's configured default model, so they don't rot as models are released. If a route's CLI isn't installed, Agentify falls back to the other vendor automatically. Override any route in `.agentify.yaml` under `models.routes`. Delegations run non-interactively (`claude -p` / `codex exec`), read-only by default — pass `--write` to allow edits.

Every delegation is logged locally with duration, token usage, and cost (real numbers where the provider CLI reports them, ~4 chars/token estimates otherwise). `agentify stats` breaks it down by kind and model — so you can see what routing cheap work to cheap models is actually saving.

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
