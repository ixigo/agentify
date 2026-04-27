# Agentify Advanced Onboarding

This guide is for teams that want to drop Agentify into any repository with minimal maintenance overhead.

## Goals

- Keep setup consistent across repos.
- Install all built-in skills in one command.
- Make skill updates repeatable and low-risk.
- Avoid needing to understand every internal detail before using Agentify effectively.

## 1) One-time setup per machine

```bash
git clone https://github.com/ixigo/agentify.git
cd /path/to/agentify
pnpm install
pnpm link --global
```

## 2) One-time setup per repository

```bash
cd /path/to/repo
agentify init --provider codex
agentify skill install all --provider codex --scope project
agentify up
```

What this gives you:

- baseline Agentify repo artifacts (`.agentify.yaml`, `.agentify/work`, `.agentignore`, `.guardrails`)
- all built-in Codex skill packs in `.codex/skills/`
- fresh index/docs/check artifacts for deterministic task execution

## 3) Standard daily workflow

```bash
agentify run "implement <task>"
```

Use sessions for longer initiatives:

```bash
agentify sess run --provider codex --name "<stream-name>" "<task>"
agentify sess resume --session <session-id> "<next-step>"
```

## 4) Safe update workflow (repo-level)

When Agentify itself adds new repo-level features, sync the existing repository forward:

```bash
agentify sync
agentify check
```

This refreshes repo-owned config defaults, missing baseline artifacts, already-managed hooks, and detected repo-scoped built-in skills before running the normal maintenance pipeline locally.

## 5) Team abstraction pattern

To keep usage generic for contributors:

1. Commit the `.codex/skills/` directory in the repo.
2. Add short wrapper docs in your own `AGENTIFY.md` that reference only:
   - `agentify run ...`
   - `agentify sess ...`
   - `agentify sync` (for updates)
3. Avoid requiring contributors to memorize internal indexing/semantic implementation details.

Result: engineers and agents can use a stable interface, while maintainers can evolve internals independently.
