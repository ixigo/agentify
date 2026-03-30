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

## Install

```bash
npm install -g agentify
```

Requires **Node.js >= 20**.

### Recommended Tools

For the best experience, install these optional tools. Agentify works without them but produces faster scans and richer output when they're available.

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

### AI Providers (optional)

To generate richer, model-powered documentation instead of deterministic local output, install and authenticate one of the supported provider CLIs:

| Provider   | Install / Auth                             |
| ---------- | ------------------------------------------ |
| Codex      | `npm i -g @openai/codex` + OpenAI API key |
| Claude     | [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) |
| Gemini     | [Gemini CLI](https://github.com/google-gemini/gemini-cli) |
| OpenCode   | [OpenCode CLI](https://github.com/sst/opencode) |

Without a provider, `--provider local` (the default) works fully offline.

## Quick Start

```bash
agentify init                          # scaffold baseline artifacts
agentify update --provider codex       # scan + doc + validate + test
agentify validate                      # check freshness and safety
```

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

If any tools show `MISSING`, the install command is shown in the Version column. See [Recommended Tools](#recommended-tools) above.

## Ghost Mode

Run without modifying source files. All outputs go to `.current_session/`:

```bash
agentify update --ghost --provider local
```

## Sessions

Fork and resume agent sessions for multi-step workflows:

```bash
agentify session fork --tool codex --name "add-auth"
agentify session list
agentify session resume --session sess_20260330_abc123
```

## Git Hooks

Auto-validate on commit and refresh on merge:

```bash
agentify hooks install     # installs pre-commit + post-merge
agentify hooks status
agentify hooks remove
```

## Exec Wrapper

Wrap any agent command with automatic pre/post refresh and validation:

```bash
agentify exec -- codex --task "add user authentication"
agentify exec --fail-on-stale -- claude -p "refactor the API layer"
```

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
