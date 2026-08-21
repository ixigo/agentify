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

Agentify keeps durable working context — decisions, notes, session summaries, command failures, hot files — with the repository instead of inside one agent harness. Install it once and the agent drives it: Claude Code through lifecycle hooks, Codex through installed guidance, everything else over MCP.

It does not replay a provider's hidden conversation state or copy private chain-of-thought. It carries forward explicit, compact project evidence that should survive the switch.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ixigo/agentify/main/install.sh | bash

cd /path/to/your/repo
agentify install            # guidance + hooks + MCP registration + index
agentify status             # what is wired
agentify uninstall          # removes only Agentify's managed blocks and hooks
```

## How it works

```
agentify install
  |-- CLAUDE.md / AGENTS.md  <- agent guidance
  |-- .claude/settings.json  <- Claude Code lifecycle hooks
  `-- .agentify/             <- JSONL context store + optional repo index
```

1. **Session starts** — the digest is injected (hook on Claude Code, guidance on Codex).
2. **Agent works** — edits, commands, and failures are tracked automatically; a repeat of a previously failed command is flagged before it runs.
3. **Agent learns something** — `agentify ctx note "…"` / `agentify ctx decision "chose X over Y because Z"`.
4. **Session ends** — a short extractive handoff is written from tracked evidence, at zero model cost.

No daemon, no database server, no per-command wrapping.

## Commands you'll actually type

| Command | What it does |
| --- | --- |
| `agentify ctx load` | Digest of recent activity, notes, hot files |
| `agentify ctx note "<text>"` | Record a note for future sessions |
| `agentify ctx decision "<text>"` | Record a decision; query it later with `ctx decisions` |
| `agentify risk --since <ref>` | Blast radius + suggested regression tests |
| `agentify test --since <ref> --run` | Run only the tests a change affects |
| `agentify delegate <kind> "<task>"` | Shell work out to the model routed for it |
| `agentify serve` | MCP server for any MCP-capable agent |

Every command takes `--json`. Full reference and the other 28 commands: **[docs/README.md](./docs/README.md)**.

## Does it help?

Measured, with committed receipts under `evals/results/` and CI that fails if the code stops reproducing them. Against the same agent with no memory layer the effect is large and consistent (28/0 discordant pairs, p = 7.5e-9 on a 180-trial matrix); against a hand-maintained `CLAUDE.md` memory bank holding the same knowledge, two campaigns found **no significant difference** — published rather than buried. No leaderboard claims.

Full tables, caveats, and the corrections log: **[docs/benchmarks.md](./docs/benchmarks.md)**.

## Requirements

Node.js 20+, Git, and Claude Code (automatic hooks) or Codex (guidance-driven). Any other agent can call the CLI or connect over MCP.

## Documentation

- **[docs/README.md](./docs/README.md)** — command reference, integrations, and where everything else lives
- [docs/usage.md](./docs/usage.md) — the full guide
- [docs/benchmarks.md](./docs/benchmarks.md) — what has actually been measured

## Development

```bash
git clone https://github.com/ixigo/agentify.git && cd agentify
pnpm install && node --test
pnpm link --global
```

## License

MIT
