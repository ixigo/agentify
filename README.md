# agentify

[![npm version](https://img.shields.io/npm/v/agentify)](https://www.npmjs.com/package/agentify)
[![license](https://img.shields.io/npm/l/agentify)](./LICENSE)
[![node](https://img.shields.io/node/v/agentify)](https://nodejs.org)

Agent orchestration CLI for repository scanning, docs generation, validation, and session continuity across **Codex**, **Claude**, **Gemini**, and **OpenCode**.

## Install

```bash
npm install -g agentify
```

Requires **Node.js >= 20**.

## Quick Start

```bash
cd /path/to/your/repo
agentify init
agentify up --provider codex
agentify check
agentify run "implement retry logic for checkout"
```

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

Runs: `scan -> doc -> check -> tests`.

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
| `scan` | Deterministic repo scan + index artifacts |
| `doc` | Generate docs, metadata, and key-file headers |
| `up` | Full pipeline (`scan -> doc -> check -> tests`) |
| `check` | Validate freshness, schemas, and safety rules |
| `run` | Provider-template execution with auto-refresh |
| `exec` | Advanced wrapper for custom command after `--` |
| `sess` | Session lifecycle commands (`run`, `list`, `resume`, `fork`) |
| `query` | Query index (`owner`, `deps`, `changed`) |
| `hooks` | Install/remove/status git hooks |
| `doctor` | Toolchain and capability diagnostics |
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

## Providers

Supported providers:

- `local`
- `codex`
- `claude`
- `gemini`
- `opencode`

`local` is valid for scan/doc/up/check workflows, but `run` / `sess *` require an external provider (`codex|claude|gemini|opencode`) because they execute provider CLIs.

## Options

```txt
--provider <local|codex|claude|gemini|opencode>
--strict <true|false>
--languages <auto|ts|python|dotnet|java|kotlin|swift>
--dry-run
--ghost
--json
--interactive, -i
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
.agents/index.json
.agents/modules/*.json
.agents/graphs/deps.json
.agents/runs/*.json
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
```

## Development

```bash
git clone https://github.com/user/agentify.git
cd agentify
pnpm install
pnpm test
```

## License

[MIT](./LICENSE)
