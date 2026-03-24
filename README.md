# Agentify CLI

Agentify is a one-command CLI that makes an existing repository more agent-friendly without changing business logic by default.

It detects the primary stack, maps modules, generates durable docs and machine-readable metadata, inserts bounded top-of-file headers into selected key files, validates that only safe changes were made, and records run/token usage when the provider exposes it.

## Current Scope

Implemented stacks:
- TypeScript / JavaScript
- Python
- .NET / C#

Implemented commands:
- `agentify init`
- `agentify scan`
- `agentify doc`
- `agentify update`
- `agentify validate`

Provider support:
- `local`: deterministic local artifact generation
- `codex`: repo-manager plus per-module Codex sub-agent orchestration via `codex exec`

## Features

- Auto-detects repo stack and module boundaries
- Builds `.agents/index.json` and `.agents/graphs/deps.json`
- Generates module docs under `docs/modules/*`
- Generates root navigation docs: `AGENTS.md`, `docs/repo-map.md`, `AGENTIFY.md`
- Adds idempotent Agentify headers to selected key files only
- Enforces comment-only top-of-file edits in code files
- Tracks run metrics and token usage in `.agents/runs/*.json`
- Shows progress while scanning and generating docs
- Runs module generation in parallel with bounded concurrency

## Generated Artifacts

- `AGENTS.md`: root guidance for human and agent navigation
- `AGENTIFY.md`: consolidated generated summary for the latest run
- `docs/repo-map.md`: repo-level map and module links
- `docs/modules/*.md`: module-level docs
- `.agents/index.json`: repo/module index
- `.agents/modules/*.json`: per-module metadata
- `.agents/graphs/deps.json`: dependency graph
- `.agents/runs/*.json`: run report and token accounting

## Prerequisites

Required:
- Node.js `>= 20`

Optional but recommended:
- Git, if you want freshness validation against `HEAD`
- Codex CLI installed and authenticated, if using `--provider codex`

Examples:
- `node -v`
- `codex --help`

## Installation

From this repo:

```bash
npm install
chmod +x src/cli.js
```

Run directly:

```bash
node src/cli.js --help
```

Or via the package bin:

```bash
npm link
agentify --help
```

## Quickstart

Minimal end-to-end flow:

```bash
agentify init
agentify update --provider codex
agentify validate
```

Typical progress output:

```text
[agentify] scan: starting deterministic repository scan
[agentify] scan: analyzed 214 files and detected 6 modules
[agentify] scan: wrote index artifacts
[agentify] doc: starting documentation and metadata generation
[agentify] doc: prepared repo context from 12 top-level files
[agentify] doc: manager plan ready for 6 modules
[agentify] doc: dispatching 6 module jobs with concurrency 4
[agentify] doc: completed 2/6 modules, approx 34% of bounded context processed
[agentify] doc: completed 6/6 modules, approx 100% of bounded context processed
[agentify] doc: wrote module docs, metadata, run report, and AGENTIFY.md
```

Typical JSON summary from `agentify doc`:

```json
{
  "command": "doc",
  "modules_processed": 6,
  "files_with_headers": 18,
  "docs_written": 12,
  "token_usage": {
    "input_tokens": 72636,
    "output_tokens": 1967,
    "total_tokens": 74603,
    "by_module": [
      {
        "module_id": "__manager__",
        "input_tokens": 11818,
        "output_tokens": 403,
        "total_tokens": 12221
      }
    ]
  }
}
```

After a successful run, expect these files to exist:
- `AGENTS.md`
- `AGENTIFY.md`
- `docs/repo-map.md`
- `docs/modules/*.md`
- `.agents/index.json`
- `.agents/modules/*.json`
- `.agents/graphs/deps.json`
- `.agents/runs/*.json`

## Usage

Initialize baseline files:

```bash
agentify init
```

Run a deterministic scan only:

```bash
agentify scan
```

Generate docs and metadata with the local provider:

```bash
agentify doc --provider local
```

Generate docs and metadata with Codex:

```bash
agentify doc --provider codex
```

Run the full flow:

```bash
agentify update --provider codex
```

Validate generated artifacts and safety rules:

```bash
agentify validate
```

## Common Flags

- `--provider local|codex`
- `--mode branch|pr|patch`
- `--strict true|false`
- `--languages auto|ts|python|dotnet`
- `--module-strategy auto|workspace|src-folder|namespace`
- `--dry-run`
- `--max-files-per-module N`
- `--module-concurrency N`
- `--token-report true|false`
- `--root <path>`

Example:

```bash
agentify doc --provider codex --module-concurrency 6 --max-files-per-module 12
```

## Provider Comparison

### `local`

Use `local` when:
- you want deterministic output without external model calls
- you are working offline
- you want fast scaffolding or CI-safe fallback behavior

Behavior:
- no external provider dependency
- zero provider token usage
- docs and metadata are generated from deterministic repo signals
- useful for bootstrapping and validation pipelines

Tradeoffs:
- summaries are less nuanced
- module docs are more template-like
- no model-based repo interpretation beyond heuristics

Example:

```bash
agentify update --provider local
```

### `codex`

Use `codex` when:
- you want higher-quality summaries and richer module docs
- Codex CLI is installed and authenticated
- you want repo-manager plus sub-agent orchestration with token tracking

Behavior:
- runs one repo-level manager step
- runs one module job per module
- supports bounded parallelism with `--module-concurrency`
- records token usage when Codex returns it
- falls back to deterministic local generation if a Codex module job fails

Tradeoffs:
- slower than `local`
- depends on Codex CLI availability and connectivity
- token usage varies with repo size and file caps

Example:

```bash
agentify update --provider codex --module-concurrency 4
```

### Summary

| Provider | Best for | Speed | Quality | Network/Auth | Token Usage |
|---|---|---:|---:|---|---|
| `local` | offline runs, CI fallback, deterministic scaffolding | fast | moderate | not required | none |
| `codex` | richer summaries, agent-oriented docs, repo interpretation | slower | higher | required | recorded when available |

## Progress UX

Progress logs are written to `stderr` so JSON command output on `stdout` stays machine-readable.

Current progress reporting includes:
- scan start and completion
- total files and modules detected
- repo-context preparation
- manager-plan completion
- module job dispatch with concurrency
- module completion count
- approximate bounded-context progress
- final artifact write completion

## Safety Model

Allowed changes:
- `AGENTS.md`
- `AGENTIFY.md`
- `docs/**`
- `.agents/**`
- top-of-file comment/header insertions in supported code files

Disallowed changes:
- code logic edits
- non-comment edits in code files
- writes outside approved generated artifact locations

Validation is designed to fail closed.

## Codex Provider Notes

When `--provider codex` is used:
- Agentify runs one repo-level manager prompt first
- Then it runs one Codex module job per module
- Module jobs execute in parallel up to `--module-concurrency`
- Token usage is aggregated from Codex JSONL events when available

If Codex execution fails for a module, Agentify falls back to deterministic local generation for that module rather than writing arbitrary partial output.

## Development

Run tests:

```bash
npm test
```

Main implementation files:
- `src/main.js`
- `src/core/commands.js`
- `src/core/provider.js`
- `src/core/validate.js`
- `src/core/detect.js`

## Limitations

- JSON schema enforcement for generated artifact files themselves is still lightweight
- Patch/PR output modes are not yet fully implemented
- Stack-specific heuristics are stronger for TypeScript than for Python and .NET today
- Progress reporting is line-oriented CLI output, not a live TUI
