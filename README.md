# agentify

[![npm version](https://img.shields.io/npm/v/agentify)](https://www.npmjs.com/package/agentify)
[![license](https://img.shields.io/npm/l/agentify)](./LICENSE)
[![node](https://img.shields.io/node/v/agentify)](https://nodejs.org)

Agent orchestration CLI for repository indexing, context planning, docs generation, validation, and session continuity across **Codex**, **Claude**, **Gemini**, and **OpenCode**.

## Install

```bash
npm install -g agentify
```

Requires **Node.js >= 20**.

## Quick Start

```bash
cd /path/to/your/repo
agentify this --provider codex
agentify skill install grill-me --provider codex --scope project
agentify clean
agentify check
agentify run "implement retry logic for checkout"
```

`agentify this` is the macOS bootstrap path. It defaults to the current working directory, can prompt for provider/path when flags are omitted, verifies/install required local tools, writes the repo-local provider, and initializes missing Agentify artifacts.

## Day-to-Day Workflow

### 1) Use `run` for normal task execution

```bash
agentify run --provider codex "implement payment retries"
agentify run "add tests for retry backoff"   # reuses sticky provider in this repo
agentify run --provider codex --interactive "fix auth bug in Codex TUI"
```

`run` executes your provider command and then automatically refreshes scan + doc + check.

### 2) Use `sess` for continuity

```bash
agentify sess run --provider codex --name "payments-v2" "implement initial module"
agentify sess run --provider codex --interactive --name "payments-v2" "continue in interactive Codex"
agentify sess list
agentify sess resume --session sess_20260331_ab12cd "continue from previous checkpoint"
agentify sess fork --from sess_20260331_ab12cd --name "payments-alt" "try alternate design"
```

`sess run`, `sess resume`, and `sess fork` launch the provider directly using session context.
Pass `--interactive` to launch the interactive Codex CLI instead of `codex exec`. This currently applies only to the `codex` provider.

### 3) Run full pipeline when needed

```bash
agentify up
```

Runs: `index -> doc -> check -> tests`.

## Sticky Provider Behavior

Provider defaults are repo-local and persisted in `.agentify.yaml`.

- Any explicit `--provider` on these commands updates repo default:
  - `run`
  - `exec`
  - `sess run`
  - `sess resume`
  - `sess fork`
- Commands without `--provider` reuse the stored repo default.

Example:

```bash
agentify run --provider codex "task A"
agentify run "task B"     # uses codex in the same repo
```

## Commands

| Command | Description |
| --- | --- |
| `init` | Create baseline Agentify artifacts |
| `index` | Build the SQLite repository index |
| `scan` | Alias for `index` |
| `doc` | Generate docs, metadata, and key-file headers |
| `up` | Full pipeline (`index -> doc -> check -> tests`) |
| `check` | Validate freshness, schemas, and safety rules |
| `plan` | Preview the planner-selected context for a task |
| `run` | Provider-template execution with auto-refresh |
| `exec` | Advanced wrapper for custom command after `--` |
| `this` | Bootstrap the current macOS repo for a provider-backed workflow |
| `skill` | List and install built-in agent skills for supported providers |
| `sess` | Session lifecycle commands (`run`, `list`, `resume`, `fork`) |
| `query` | Query index (`owner`, `deps`, `changed`, `search`) |
| `hooks` | Install/remove/status git hooks |
| `doctor` | Toolchain and capability diagnostics |
| `clean` | Prune stale generated artifacts and dead Agentify folders |
| `cache` | Cache maintenance (`gc`, `status`) |

## Session Commands

```bash
agentify sess run [--provider <name>] [--name <label>] [--from <parent-id>] "task"
agentify sess list
agentify sess resume --session <id> "task"
agentify sess fork --from <id> [--provider <name>] [--name <label>] "task"
```

Notes:

- `sess resume` also accepts positional id: `agentify sess resume <id> "task"`.
- Session manifests now store `provider` (legacy `tool` is still read for old sessions).

## Skill Commands

```bash
agentify skill list
agentify skill install grill-me --provider claude --scope project
agentify skill install god-mode --provider all --scope project
agentify skill install worktree-verifier --provider codex --scope user
```

Built-in skills:

- `grill-me`
- `improve-codebase-architecture`
- `worktree-verifier` (alias: `god-mode`)

Notes:

- `--provider` accepts `codex`, `claude`, `gemini`, `opencode`, comma-separated lists, or `all`.
- `--scope project` installs inside the current repo using provider-specific directories such as `.codex/skills/`, `.claude/skills/`, `.gemini/skills/`, and `.opencode/skills/`.
- `--scope user` installs into the provider's user-level skill directory.
- Skill installs do not update the repo's sticky execution provider.

## Providers

Supported providers:

- `local`
- `codex`
- `claude`
- `gemini`
- `opencode`

`local` is valid for scan/doc/up/check workflows, but `run` / `sess *` require an external provider (`codex|claude|gemini|opencode`) because they execute provider CLIs.

## Bootstrap Command

```bash
agentify this
agentify this --provider codex
agentify this --provider codex --root /path/to/repo
```

Notes:

- `this` currently supports macOS only.
- The command uses the current working directory when `--root` is omitted.
- Supported bootstrap providers are `codex`, `claude`, `gemini`, and `opencode`.
- Homebrew is required for macOS package installation.
- Normal TTY mode keeps bootstrap progress to a single compact line and suppresses installer logs unless something fails.

## Options

```txt
--provider <local|codex|claude|gemini|opencode>
--strict <true|false>
--languages <auto|ts|python|dotnet|java|kotlin|swift>
--dry-run
--ghost
--json
--interactive, -i
--scope <project|user>
--root <path>
```

### Exec Flags

```txt
--fail-on-stale
--timeout <seconds>
--skip-refresh
```

`exec` usage:

```bash
agentify exec [flags] -- <command...>
agentify exec --provider codex -- codex exec "fix auth bug"
```

## Migration (Hard Cutover)

| Removed | Replacement |
| --- | --- |
| `agentify update` | `agentify up` |
| `agentify validate` | `agentify check` |
| `agentify session ...` | `agentify sess ...` |
| `--tool` | `--provider` |

Old command/flag names now fail fast with migration errors.

## Recommended Tools

```bash
# Tier 1
brew install ripgrep fd

# Tier 2
brew install ast-grep
npm install -g tree-sitter-cli
```

Run diagnostics:

```bash
agentify doctor
```

## Ghost Mode

```bash
agentify up --ghost --provider local
```

Outputs are written under `.current_session/`.

## Generated Artifacts

```txt
AGENTS.md
AGENTIFY.md
docs/repo-map.md
docs/modules/*.md
.agents/index.db
.agents/runs/*.json
.agentignore
.guardrails
.agentify/work/*
.agents/session/*
```

## Configuration

Create `.agentify.yaml` in repo root:

```yaml
provider: local
strict: true
languages: auto
maxFilesPerModule: 20
moduleConcurrency: 4
tokenReport: true
cleanup:
  keepRuns: 20
  maxRunAgeDays: 14
  keepGhostRuns: 3
  maxGhostAgeDays: 3
```

Cleanup workflow:

```bash
agentify clean
agentify clean --dry-run
```

`clean` safely removes:

- orphaned `docs/modules/*.md`
- stale legacy `.agents/modules/*.json`
- stale `.agents/runs/*.json`
- stale `.current_session/ghost_*` folders
- invalid `.agents/session/*` folders without manifests

## Development

```bash
git clone https://github.com/user/agentify.git
cd agentify
pnpm install
pnpm test
```

## License

[MIT](./LICENSE)
