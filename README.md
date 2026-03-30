# agentify

[![npm version](https://img.shields.io/npm/v/agentify)](https://www.npmjs.com/package/agentify)
[![license](https://img.shields.io/npm/l/agentify)](./LICENSE)
[![node](https://img.shields.io/node/v/agentify)](https://nodejs.org)

Orchestration layer for AI agent coding workflows. Scans repos, generates docs, validates safety, and manages sessions across **Codex**, **Claude**, **Gemini**, and **OpenCode**.

```
  agentify v0.2.0

  ~ scan: analyzed 214 files and detected 6 modules
  ~ scan: wrote index artifacts
  ~ doc: completed 6/6 modules
  + Validation passed

  ----------------------------------------
  Run Complete
  ----------------------------------------
  Artifacts: 4
  Modules:   6
  Validation: passed
  ----------------------------------------
```

---

## Table of Contents

- [Install](#install)
- [Recommended Tools](#recommended-tools)
- [AI Providers](#ai-providers)
- [Local Development](#local-development)
- [Quick Start](#quick-start)
- [Full Codex Workflow](#full-codex-workflow)
- [Commands](#commands)
- [Options](#options)
- [Capability Tiers](#capability-tiers)
- [Ghost Mode](#ghost-mode)
- [Keeping Docs in Sync](#keeping-docs-in-sync)
- [Git Hooks](#git-hooks)
- [Providers](#providers)
- [Generated Artifacts](#generated-artifacts)
- [Supported Stacks](#supported-stacks)
- [Configuration](#configuration)
- [Safety Model](#safety-model)
- [Development](#development)

---

## Install

```bash
npm install -g agentify
```

Requires **Node.js >= 20**.

## Recommended Tools

For the best experience, install these optional tools. Agentify works without them but produces faster scans and richer output when they are available.

```bash
# Tier 1 -- fast search and file enumeration
brew install ripgrep fd        # macOS
# or: cargo install ripgrep fd-find

# Tier 2 -- structural code queries and symbol extraction
brew install ast-grep          # macOS
npm install -g tree-sitter-cli
# or: cargo install ast-grep tree-sitter-cli
```

Run `agentify doctor` after installing to verify your tier.

## AI Providers

To generate richer, model-powered documentation instead of deterministic local output, install and authenticate one of the supported provider CLIs:

| Provider   | Install / Auth                             |
| ---------- | ------------------------------------------ |
| Codex      | `npm i -g @openai/codex` + OpenAI API key |
| Claude     | [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) |
| Gemini     | [Gemini CLI](https://github.com/google-gemini/gemini-cli) |
| OpenCode   | [OpenCode CLI](https://github.com/sst/opencode) |

Without a provider, `--provider local` (the default) works fully offline.

## Local Development

Use agentify from a local clone without publishing to npm.

**Option A -- global link:**

```bash
cd /path/to/agentify
pnpm link --global          # or: npm link --global
```

Now `agentify` is on your `PATH`. Use it from any project. To unlink:

```bash
pnpm uninstall -g agentify  # or: npm unlink -g agentify
```

**Option B -- run directly:**

```bash
node /path/to/agentify/src/cli.js doctor --root /path/to/your/repo
```

## Quick Start

```bash
cd /path/to/your/repo
agentify doctor                        # check toolchain tier
agentify init                          # scaffold .agents/ and baseline docs
agentify update --provider codex       # scan + doc + validate + test
agentify validate                      # verify freshness and safety
```

After this your repo has a full `.agents/index.json`, module docs, dependency graph, and run reports. You are ready for the [Full Codex Workflow](#full-codex-workflow).

---

## Full Codex Workflow

This is the end-to-end flow for using Agentify with Codex on a repo that has already been initialized (`agentify init` + at least one `agentify update`).

### Step 1 -- Start a session

Fork a new session. This snapshots the current index, HEAD commit, and module list into `.agents/session/<id>/`.

```bash
agentify session fork --tool codex --name "add-payments"
#  + Session forked: sess_20260330_a1b2c3
#  > Path: /path/to/repo/.agents/session/sess_20260330_a1b2c3
```

Save the session id for later. You can also get it as JSON:

```bash
agentify session fork --tool codex --name "add-payments" --json
```

### Step 2 -- Run Codex through the exec wrapper

Use `agentify exec` to wrap your Codex invocation. When Codex finishes (exit 0), Agentify **automatically runs scan + doc + validate** to sync all module docs, the index, and metadata with whatever Codex changed.

```bash
agentify exec --provider codex -- codex exec "implement the payments module"
```

What happens behind the scenes:

1. Agentify snapshots the current `git status`.
2. Codex runs with full terminal control.
3. After Codex exits 0, Agentify diffs the file tree.
4. Agentify re-runs **scan** (re-indexes modules and deps) and **doc** (regenerates module docs and headers for changed files).
5. Agentify **validates** the repo to confirm nothing unsafe was written.

If Codex exits non-zero the refresh is skipped and the exit code is forwarded.

### Step 3 -- Continue working, fork, or resume

**List sessions** to see what exists:

```bash
agentify session list
#  > sess_20260330_a1b2c3  codex  2026-03-30T16:20:00.000Z
```

**Resume** an existing session to get its bootstrap context (markdown on stdout). Pipe it to a file or feed it into your next Codex run:

```bash
agentify session resume --session sess_20260330_a1b2c3
```

This outputs the session's bootstrap including HEAD at fork time, module list, and checklist state. Save it for reference:

```bash
agentify session resume --session sess_20260330_a1b2c3 > .agents/last-bootstrap.md
```

**Fork from an existing session** if you want to branch off halfway. The new session inherits the parent's checklist:

```bash
agentify session fork --tool codex --name "payments-v2" --from sess_20260330_a1b2c3
```

### Step 4 -- Run more Codex turns

Each time you run another Codex task, wrap it with `exec` so docs stay in sync:

```bash
agentify exec --provider codex -- codex exec "add unit tests for payments"
agentify exec --provider codex -- codex exec "handle error cases in checkout flow"
```

Every successful run re-scans and re-generates docs automatically. The index, module metadata, headers, and dependency graph are always up to date after each turn.

### Step 5 -- Commit with validation

If you installed git hooks (`agentify hooks install`), the pre-commit hook runs `agentify validate` automatically. Otherwise, run it manually before committing:

```bash
agentify validate
git add -A && git commit -m "feat: payments module"
```

### Step 6 -- Final sync after the session

When you are done with a multi-turn session, run a final full update to make sure everything is aligned with the committed state:

```bash
agentify update --provider codex
```

This runs scan, doc, validate, and tests. The HTML report (`agentify-report.html`) and `output.txt` are written with the full run summary.

### Quick reference

```bash
# one-time setup (already done)
agentify init && agentify update --provider codex

# start a session
agentify session fork --tool codex --name "my-feature"

# work with codex (auto-syncs after each run)
agentify exec --provider codex -- codex exec "your task"
agentify exec --provider codex -- codex exec "another task"

# halfway: fork or resume
agentify session fork --tool codex --name "my-feature-v2" --from sess_...
agentify session resume --session sess_... > context.md

# finish up
agentify validate
agentify update --provider codex
git add -A && git commit -m "feat: done"
```

---

## Commands

| Command      | Description                                          |
| ------------ | ---------------------------------------------------- |
| `init`       | Create baseline Agentify artifacts                   |
| `scan`       | Run deterministic repo scan and write index           |
| `doc`        | Generate docs, metadata, and key-file headers         |
| `update`     | Run scan -> doc -> validate -> test pipeline          |
| `validate`   | Validate freshness, schemas, and safety rules         |
| `exec`       | Wrap an agent command with auto-refresh               |
| `query`      | Query the repository index (owner, deps, changed)     |
| `session`    | Manage session fork/resume for continuity             |
| `hooks`      | Install/remove git hooks (pre-commit, post-merge)     |
| `doctor`     | Check toolchain health and capability tier             |
| `cache`      | Manage the content-addressed cache                    |

`agentify doc` can run directly after `agentify init`; if `.agents/index.json` is missing, Agentify derives module/index state on the fly (including `--ghost` runs).

## Options

```
--provider <local|codex|claude|gemini|opencode>
--strict <true|false>       Fail closed on validation issues (default: true)
--languages <auto|ts|python|dotnet|java|kotlin|swift>
--dry-run                   Report planned changes without writing
--ghost                     Route outputs to .current_session/ (no source changes)
--json                      Machine-readable JSON output only
--root <path>               Target repo root (default: cwd)
```

### Exec flags

```
agentify exec [flags] -- <command...>

--fail-on-stale             Exit 80 if validation fails post-refresh
--timeout <seconds>         Kill wrapped command after N seconds
--skip-refresh              Skip post-command refresh
```

## Capability Tiers

Agentify works at Tier 0 with just Node.js, but **Tier 2 is strongly recommended** for the best output quality. Higher tiers enable faster scans, structural code understanding, and more accurate dependency graphs.

| Tier | Tools                       | What improves                            |
| ---- | --------------------------- | ---------------------------------------- |
| 0    | (none)                      | Basic Node.js scanning                   |
| 1    | `rg`, `fd`                  | 10-50x faster text search and file walks |
| 2    | + `ast-grep`, `tree-sitter` | Structural queries, symbol extraction, deeper analysis |

Check your current tier:

```bash
agentify doctor
```

```
  agentify v0.2.0

  > Capability tier: Tier 2

  +-------------+------+---------+--------------------+
  | Tool        | Tier | Status  | Version            |
  +-------------+------+---------+--------------------+
  | rg          | 1    | OK      | 15.1.0             |
  | fd          | 1    | OK      | 10.4.2             |
  | ast-grep    | 2    | OK      | 0.38.1             |
  | tree-sitter | 2    | OK      | 0.24.7             |
  +-------------+------+---------+--------------------+

  > Node.js: v22.22.0
  > Platform: darwin arm64
```

If any tools show `MISSING`, the install command is shown in the Version column. See [Recommended Tools](#recommended-tools).

## Ghost Mode

Run without modifying source files. All outputs go to `.current_session/`:

```bash
agentify update --ghost --provider local
```

## Keeping Docs in Sync

**Agentify does not watch files in the background.** Editing sources does not by itself run `update`. You trigger sync explicitly or via the exec wrapper and hooks.

| Mechanism | When it runs | What gets refreshed |
| --------- | ------------ | ------------------- |
| `agentify update` | You run it manually | Full pipeline: scan, doc, validate, tests |
| `agentify exec -- ...` | After the wrapped command exits 0 | Re-runs scan + doc + validate automatically |
| `agentify exec --skip-refresh` | Same wrapper, no post-step | Nothing; use for quick one-off commands |
| Git hooks | pre-commit / post-merge | pre-commit: validate. post-merge: scan |
| Manual | Any time | `scan`, `doc`, or `validate` individually |

**`exec` is the main automatic sync path.** It runs after the child process finishes successfully. There is no continuous file-watcher.

## Git Hooks

```bash
agentify hooks install     # pre-commit (validate) + post-merge (scan)
agentify hooks status
agentify hooks remove
```

- **pre-commit** runs `agentify validate` so you cannot commit stale or unsafe artifacts.
- **post-merge** runs `agentify scan` to refresh the index after a merge or pull.

## Providers

| Provider   | Best for                              | Speed  | Token Usage     |
| ---------- | ------------------------------------- | ------ | --------------- |
| `local`    | Offline, CI fallback, deterministic   | Fast   | None            |
| `codex`    | Richer summaries, agent orchestration | Slower | Recorded        |
| `claude`   | Schema-constrained structured output  | Slower | Recorded        |
| `gemini`   | Gemini-based generation with stats    | Slower | Recorded        |
| `opencode` | Event-stream based generation         | Slower | Recorded        |

```bash
agentify update --provider codex --module-concurrency 4
```

## Generated Artifacts

```
AGENTS.md                   # root navigation for humans and agents
AGENTIFY.md                 # consolidated run summary
docs/repo-map.md            # repo-level module map
docs/modules/*.md           # per-module documentation
.agents/index.json          # machine-readable repo/module index
.agents/modules/*.json      # per-module metadata
.agents/graphs/deps.json    # inter-module dependency graph
.agents/runs/*.json         # run reports with token accounting
```

## Supported Stacks

- TypeScript / JavaScript
- Python
- .NET / C#
- Java / Android
- Kotlin / Android
- Swift / iOS

## Configuration

Create `.agentify.yaml` in your project root:

```yaml
provider: local
strict: true
languages: auto
maxFilesPerModule: 20
moduleConcurrency: 4
tokenReport: true

budgets:
  perFile: 8000
  perModule: 32000

cache:
  enabled: true
  maxAgeDays: 7
```

## Safety Model

Agentify enforces strict boundaries on what it writes:

**Allowed**: `AGENTS.md`, `AGENTIFY.md`, `docs/**`, `.agents/**`, top-of-file comment headers in key files.

**Disallowed**: Code logic edits, non-comment changes in code files, writes outside approved locations.

Validation fails closed by default (`--strict true`).

## Development

```bash
git clone https://github.com/user/agentify.git
cd agentify
npm install
npm test
```

Architecture:

```
src/
  cli.js            # entry point
  main.js           # arg parsing, command dispatch
  core/
    commands.js     # scan, doc, update, validate orchestration
    config.js       # .agentify.yaml loading and defaults
    detect.js       # stack and module detection
    exec.js         # exec wrapper with pre/post refresh
    fs.js           # file system utilities
    git.js          # git abstractions
    graph.js        # dependency graph builder
    headers.js      # file header management
    hooks.js        # git hook install/remove
    lock.js         # advisory lockfile
    provider.js     # AI provider interface
    query.js        # repository index queries
    cache.js        # content-addressed cache
    schema.js       # schema versioning and migration
    session.js      # session fork/resume
    toolchain.js    # capability tier detection
    ui.js           # presentation layer (colors, tables, spinners)
    validate.js     # safety and freshness validation
```

## License

[MIT](./LICENSE)
