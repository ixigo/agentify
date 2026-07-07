# Agentify Usage

Agentify is installed once per repo (or once globally) and is then driven by your coding agent. This guide covers the human-facing setup and the small set of commands you might run yourself.

## Install

```bash
npm install -g agentify   # or: pnpm add -g agentify

cd /path/to/your/repo
agentify install
```

`agentify install` does four things:

1. Appends a managed guidance block to `CLAUDE.md` (created if missing) teaching the agent to use `agentify ctx`, `query`, and `risk`.
2. Adds Claude Code hooks to `.claude/settings.json`:
   - `SessionStart` runs `agentify ctx load --hook` and injects a context digest into the new session.
   - `PostToolUse` (file edits and Bash) runs `agentify ctx track --hook` to record activity.
   - `SessionEnd` records the session close.
3. Writes baseline repo files: `.agentify.yaml` (config), `.agentignore`, `.guardrails`, and the `.agentify/` runtime directory (gitignored).
4. Prints next steps.

`agentify install --global` skips the repo files and instead writes the managed block and hooks into `~/.claude/CLAUDE.md` and `~/.claude/settings.json`, so every repo you work in gets context tracking.

### Codex

```bash
agentify install --provider codex            # project: writes the block into AGENTS.md
agentify install --provider codex --global   # global: ~/.codex/AGENTS.md
agentify install --provider all              # Claude Code + Codex together
```

Codex has no lifecycle hooks, so the `AGENTS.md` block instructs Codex to run `agentify ctx load` at session start, record decisions with `agentify ctx note`, and write `agentify ctx handoff` before ending long tasks. Tracking is guidance-driven rather than automatic, but the context store and every command are shared between agents — notes left by a Claude Code session show up in the next Codex session and vice versa.

Re-running install is safe: the managed block is replaced in place and hooks are deduplicated. `agentify uninstall [--global]` removes exactly what install added and nothing else.

## Daily use

You generally do not need to run anything — the agent does. Useful commands when you do:

```bash
agentify status                  # is the integration installed? how much context is tracked?
agentify ctx load                # see what the agent sees at session start
agentify ctx note "gotcha: ..."  # leave a note for the agent's next session
agentify ctx handoff "task"      # write a handoff summary markdown
```

## Context tracking

Events live in `.agentify/context/events.jsonl`, notes in `.agentify/context/notes.jsonl`, handoffs under `.agentify/context/handoffs/`. Events are compact single-line JSON records:

```json
{"ts":"2026-07-07T07:37:01Z","sid":"abc12345","type":"edit","path":"src/a.js"}
{"ts":"2026-07-07T07:37:04Z","sid":"abc12345","type":"cmd","cmd":"npm test","desc":"Run tests"}
```

The event log auto-compacts: past ~512 KB it is truncated to the most recent 1000 events. Command text is clipped to 200 characters and never includes command output. Hook-invoked commands (`--hook`) are designed to never fail and never block the agent.

## Structural index (optional but recommended)

```bash
agentify scan     # build/refresh .agentify/index.db and docs/repo-map.md
agentify check    # verify the index matches HEAD
agentify up       # scan + check in one step
```

The index powers:

```bash
agentify query search --term checkout
agentify query def --symbol buildReport
agentify query refs --symbol buildReport
agentify query impacts --file src/pay/retry.ts
agentify query owner --file src/pay/retry.ts
agentify query deps --module payments
agentify query changed --since origin/main
agentify risk --since origin/main
```

All support `--json`. The CLAUDE.md block teaches the agent to run `agentify scan` itself when the index is stale.

## Model routing

Install writes a `models.routes` table into `.agentify.yaml` mapping kinds of work to models. The agent (or you) can shell tasks out:

```bash
agentify models                                       # routing table + which CLIs are installed
agentify delegate quick "fix the typo in README"      # small work → fast, cheap model
agentify delegate quick "rename X to Y" --write       # allow the delegated model to edit files
agentify delegate review --diff origin/main           # post-change review by the other vendor
agentify delegate heavy "design the retry strategy"
agentify delegate research "summarize how auth works here"
```

Defaults: `quick`/`research` → Claude Haiku, `implement` → Claude Sonnet, `heavy` → Claude Opus, `review` → Codex (its CLI default model). If a route's CLI is missing, Agentify falls back to the other vendor. Delegations are non-interactive and read-only unless `--write` is passed (`claude -p --permission-mode acceptEdits` / `codex exec --full-auto`). Override routes:

```yaml
models:
  routes:
    review:
      provider: codex
      model: null          # null = the codex CLI's configured default
    quick:
      provider: claude
      model: haiku
```

## Git hooks (optional)

```bash
agentify hooks install   # pre-commit: agentify check --hook; post-merge: agentify scan
agentify hooks status
agentify hooks remove
```

## Skills (optional)

Agentify bundles a catalog of agent skills (TDD, PR workflows, triage, and more):

```bash
agentify skill list
agentify skill install grill-me --provider claude --scope project
agentify skill install all --provider claude --scope project
```

## Housekeeping

```bash
agentify doctor            # toolchain + provider CLI readiness
agentify clean --dry-run   # preview pruning of stale run artifacts
agentify clean --all       # prune legacy planned/session artifacts too
```

## Shell completion

```bash
# zsh
source <(agentify completion zsh)
# bash
source <(agentify completion bash)
# fish
agentify completion fish | source
```

## Configuration

`.agentify.yaml` is created on install with defaults; the interesting knobs:

```yaml
strict: true          # check fails closed
languages: auto       # scanner language selection
moduleStrategy: auto  # module clustering strategy
hooks:
  preCommit: true     # managed git hooks (agentify hooks install)
  postMerge: true
cleanup:
  keepRuns: 20
  maxRunAgeDays: 14
```

## Other agents

Automatic hook tracking targets Claude Code; Codex is supported through `AGENTS.md` guidance (`--provider codex`). Any other agent (Gemini, OpenCode, ...) can still use Agentify directly — the commands are plain CLI with `--json` output: `agentify ctx load`, `agentify ctx note`, `agentify query ...`, `agentify risk`. Add equivalent guidance to that agent's instruction file and, if it supports lifecycle hooks, wire `agentify ctx track --hook` the same way.
