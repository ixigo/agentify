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
  |     SessionStart -> agentify ctx load   (inject context digest)
  |     PostToolUse  -> agentify ctx track  (record edits + commands)
  |     SessionEnd   -> agentify ctx track  (close out the session)
  `-- .agentify/            <- lightweight JSONL context store + optional repo index
```

Every session after that:

1. **Session starts** -> the hook injects a digest: recent notes, hot files, last activity.
2. **Agent works** -> file edits and shell commands are tracked automatically (compact JSONL, auto-compacted, capped at ~512 KB).
3. **Agent learns something worth keeping** -> it runs `agentify ctx note "..."`.
4. **Session ends** -> tracked automatically; `agentify ctx handoff` writes a summary when wrapping up long work.

No daemon, no database server, no per-command wrapping. Context tracking is plain JSONL under `.agentify/context/`.

## Quick start

```bash
npm install -g agentify   # or: pnpm add -g agentify

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
| `agentify ctx handoff ["task"]` | Write a handoff summary |
| `agentify ctx status` | Event/note counts and log size |
| `agentify scan` | Build the SQLite structural index |
| `agentify query <owner|deps|changed|search|def|refs|callers|impacts>` | Structural queries over the index |
| `agentify risk --since <ref>` | Blast radius + suggested regression tests |
| `agentify up` | scan -> check |
| `agentify check` | Validate index freshness and generated artifacts |
| `agentify skill list|install` | Install bundled agent skills (Claude, Codex, Gemini, OpenCode) |
| `agentify hooks install|remove|status` | Optional git hooks (pre-commit check, post-merge rescan) |
| `agentify doctor` | Toolchain and provider CLI readiness |
| `agentify clean` | Prune stale generated artifacts |
| `agentify completion zsh|bash|fish` | Shell completion |

All commands accept `--json` for machine-readable output — which is how agents are expected to call them.

## What the agent sees

At session start (via the `SessionStart` hook):

```markdown
## Agentify context (from previous sessions)
Last tracked activity: 2026-07-07T07:37:01Z across 3 session(s), 214 recent event(s).

### Notes left for this session
- [2026-07-05] payment retries: idempotency key lives in src/pay/retry.ts, do not regenerate per attempt

### Recently edited files
- src/pay/retry.ts (14 edits)
- src/pay/retry.test.ts (9 edits)

### Recent commands
- Run tests: `npm test -- retry`
```

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
