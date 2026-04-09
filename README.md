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

Agentify is a repository orchestration CLI for AI coding workflows. It builds a searchable repo index, generates AI-facing docs, validates repository state, and wraps provider CLIs so the repository stays fresh while agents work.

Supported providers: `local`, `codex`, `claude`, `gemini`, `opencode`.

License: [MIT](./LICENSE)

> [!WARNING]
> Agentify is still under active development.
> Use it for testing only, and do not run it against your main repository yet.

## Install

```bash
git clone https://github.com/ixigo/agentify.git
cd agentify
pnpm install
pnpm link --global
agentify --version
```

Agentify is not published to npm yet, so the current setup path is a global link from a local checkout.

Requires `Node.js >= 20` and `pnpm`.

## Quick Start

### Fastest path on macOS

```bash
cd /path/to/your/repo
agentify this --provider codex
agentify up
agentify check
```

Use this when you want Agentify to bootstrap the current Git repo, verify/install local tooling, and prepare a provider-backed workflow with the fewest manual steps.

### Manual path on any platform

```bash
cd /path/to/your/repo
agentify init --provider codex
agentify up
agentify check
```

Use this when you already manage local dependencies yourself or when `agentify this` is not available.

## Recommended Setup For Best Results

If you want Agentify to reach its full potential, do more than `init -> up -> check`.
The highest-leverage setup is:

1. verify the toolchain and optional accelerators
2. enable the repo with the right provider
3. install repo-scoped skills and hooks
4. turn on semantic indexing for TS/JS repos
5. use `run` for bounded work and `sess *` for longer streams

Recommended sequence:

```bash
cd /path/to/your/repo
agentify doctor
agentify init --provider codex
agentify skill install all --provider codex --scope project
agentify hooks install
agentify up
agentify check
```

If you are on macOS and want bootstrap automation instead of manual init:

```bash
cd /path/to/your/repo
agentify doctor
agentify this --provider codex
agentify skill install all --provider codex --scope project
agentify hooks install
agentify up
agentify check
```

Why this is better than a minimal setup:

- `doctor` tells you whether required tier tools are missing and whether optional features like MemPalace are available.
- project-scoped skills make provider behavior more repeatable across contributors and sessions.
- hooks keep the repo healthier between manual runs.
- `up` and `check` ensure the repo is indexed, documented, and validated before agent work starts.

## Single-File LLM Instructions

If you want one markdown file you can share as a URL or paste directly into Codex, Claude, Gemini, OpenCode, or another coding agent, use [LLM_PROMPT.md](./LLM_PROMPT.md).

It is written so the model treats the current working directory as the target repo, runs `agentify doctor`, chooses `init` vs `sync`, suggests the right next steps from command output, and executes the normal maintenance flow.

## How To Think About The CLI

- `init` creates the baseline repo files Agentify needs.
- `index` and `scan` build the SQLite index used for planner and query features.
- `doc` turns the index into markdown docs, summaries, and file headers.
- `check` verifies freshness, schema health, and safety rules.
- `up` runs the full maintenance pipeline in one command.
- `sync` upgrades repo-owned Agentify files when the CLI adds new baseline features.
- `plan` and `query` help you inspect the indexed repo before you hand work to an agent.
- `run`, `exec`, and `sess` launch provider workflows and keep the repo refreshed afterward.

## Command Guide

### Core Repo Commands

| Command | What it does | Why and when to use it | Example |
| --- | --- | --- | --- |
| `agentify init` | Creates baseline Agentify artifacts such as `.agentify.yaml`, `.agentignore`, `.guardrails`, `.agentify/work/`, `.agents/`, and `docs/modules/`. | Use once when enabling a repo manually, especially on Linux or pre-provisioned machines where you do not want bootstrap automation. | `agentify init --provider codex` |
| `agentify index` | Scans the repo and writes the SQLite index. | Use when you want the machine-readable repo graph refreshed but do not need markdown docs yet. | `agentify index` |
| `agentify scan` | Alias for `index`. | Use it when you prefer the word "scan" in scripts or team docs. Functionally it is the same as `index`. | `agentify scan` |
| `agentify doc` | Generates `AGENTIFY.md`, module docs, repo map updates, and refreshes eligible file headers. | Use after indexing when you want human-readable and agent-readable documentation updated. | `agentify doc` |
| `agentify up` | Runs the full pipeline: `index -> doc -> check -> tests` when a runnable test command is detected. | Use as the default maintenance command when you want the whole repo refreshed and validated in one step. | `agentify up` |
| `agentify sync` | Upgrades repo-owned Agentify files, refreshes repo-scoped built-in skills and managed hooks, then runs a local `scan -> doc -> check -> tests` pass. | Use after upgrading the Agentify CLI itself when you want an already-Agentified repo to pick up newly added config keys, baseline artifacts, hook templates, or built-in project skills. | `agentify sync` |
| `agentify check` | Validates freshness, schema state, and guardrail/safety expectations. | Use before committing, after a large refresh, or inside hooks/CI to confirm Agentify artifacts are consistent. | `agentify check` |
| `agentify semantic refresh` | Refreshes semantic TypeScript/JavaScript project facts when semantic indexing is enabled. | Use in TS/JS-heavy repos when you want richer planner/query/doc output without running the full pipeline. | `agentify semantic refresh` |
| `agentify clean` | Prunes stale generated artifacts, dead sessions, old run outputs, and invalid Agentify folders. | Use when the repo accumulates outdated docs, runs, or broken session folders and you want safe cleanup. | `agentify clean --dry-run` |
| `agentify doctor` | Checks toolchain health and capability tier. | Use during setup or when a provider/tooling command is failing and you need a concrete readiness report. | `agentify doctor` |

### Planning, Execution, And Continuity

| Command | What it does | Why and when to use it | Example |
| --- | --- | --- | --- |
| `agentify plan` | Builds the planner-selected execution context for a task and prints it as JSON. | Use before `run` when you want to inspect the exact prompt context and file selection Agentify will choose. | `agentify plan "add retry logic to checkout"` |
| `agentify run` | Uses the selected provider template command, executes the task, then refreshes the repo afterward. | Use for normal day-to-day agent work when you want Agentify to own context selection and post-run maintenance. | `agentify run --provider codex "implement payment retries"` |
| `agentify exec` | Runs a custom command after `--`, then performs the same refresh lifecycle as `run`. | Use when you want full control over the provider command line but still want Agentify wrapping, timeout handling, and refresh behavior. | `agentify exec -- codex exec "fix auth bug"` |
| `agentify this` | Bootstraps the current macOS repo for provider-backed Agentify use. | Use on macOS when you want the shortest path to a working repo and are okay with Agentify verifying/installing local dependencies. | `agentify this --provider codex` |
| `agentify sess run` | Creates or resumes a session and launches the provider with session bootstrap context. | Use for work that will span multiple agent runs and needs durable context under `.agents/session/`. | `agentify sess run --provider codex --name "payments-v2" "add tests"` |
| `agentify sess resume` | Resumes a previous session by id and relaunches the provider with that bootstrap context. | Use when you want to continue a prior thread without manually rebuilding context. | `agentify sess resume --session sess_20260331_ab12cd "continue"` |
| `agentify sess fork` | Forks an existing session into a new branch of work. | Use when you want to preserve the old session but try a different implementation or direction. | `agentify sess fork --from sess_20260331_ab12cd --name "payments-alt" "try alternate design"` |
| `agentify sess list` | Lists known sessions for the repo. | Use when you need to find an id to resume or audit previous work threads. | `agentify sess list` |

Session memory is automatic for `sess *` commands. Session runs write durable artifacts such as `transcript.md`, `memory-context.md`, and `launches.jsonl` under `.agents/session/<id>/`, and `sess resume` / `sess fork` automatically inject recent transcript excerpts into the next prompt without requiring a separate memory command.

Normal `run` is intentionally lightweight. It does not persist durable session memory artifacts under `.agents/session/`; if you need reusable memory across multiple launches, use `sess *`.

### Query, Skills, Hooks, And Cache

| Command | What it does | Why and when to use it | Example |
| --- | --- | --- | --- |
| `agentify query owner` | Shows ownership/context for a file from the index. | Use when you need to know which module or indexed context owns a file before changing it. | `agentify query owner --file src/payments/index.ts` |
| `agentify query deps` | Shows module dependency relationships from the index. | Use when you want to understand how a module depends on others before refactoring it. | `agentify query deps --module payments` |
| `agentify query changed` | Lists indexed items changed since a commit. | Use when you are auditing changes across a range or building context for recent work. | `agentify query changed --since HEAD~5` |
| `agentify query search` | Searches the index for matching files, symbols, and semantic surfaces. | Use when you need a repo-aware search that goes beyond raw grep, especially after indexing and semantic refresh. | `agentify query search --term retry` |
| `agentify skill list` | Lists built-in skills available for installation. | Use when you want to see what behavior bundles Agentify can install for a provider. | `agentify skill list` |
| `agentify skill install` | Installs one built-in skill or all built-ins into project or user scope. | Use when you want repeatable agent behavior shared at the repo level or available globally for a provider. | `agentify skill install all --provider codex --scope project` |
| `agentify hooks install` | Installs Agentify git hooks. | Use when you want automatic validation or refresh behavior tied to Git events. | `agentify hooks install` |
| `agentify hooks status` | Shows whether Agentify hooks are installed. | Use when you are verifying local setup or debugging why hook-driven behavior is missing. | `agentify hooks status` |
| `agentify hooks remove` | Removes Agentify git hooks. | Use when you want to disable Agentify-managed hook behavior cleanly. | `agentify hooks remove` |
| `agentify cache status` | Shows cache blob counts and total size. | Use when you want to understand cache growth before cleanup. | `agentify cache status` |
| `agentify cache gc` | Garbage-collects old cache blobs. | Use when the cache should be trimmed without touching other generated repo artifacts. | `agentify cache gc --max-age 14` |

### Utility Commands

| Command | What it does | Why and when to use it | Example |
| --- | --- | --- | --- |
| `agentify --help` | Prints the CLI command summary and examples. | Use when you need a quick reminder of syntax from the terminal. | `agentify --help` |
| `agentify --version` | Prints the installed CLI version. | Use when debugging environment drift or reporting a bug. | `agentify --version` |

## Command Families In More Detail

### `run` vs `exec`

- Use `run` when you want Agentify to build the provider prompt for you.
- Use `exec` when you already know the exact provider command you want to run after `--`.
- Both commands support post-execution refresh behavior.
- `run` stays lightweight and does not persist durable session memory; use `sess *` when you want recallable history across launches.

Examples:

```bash
agentify run --provider codex "implement retry logic"
agentify exec --timeout 600 -- codex exec "implement retry logic"
```

### `sess` Commands

```bash
agentify sess run [--provider <name>] [--name <label>] [--from <parent-id>] "task"
agentify sess list
agentify sess resume --session <id> "task"
agentify sess fork --from <id> [--provider <name>] [--name <label>] "task"
```

Use sessions when the work is multi-step, the prompt context is too expensive to rebuild every time, or you want a durable audit trail under `.agents/session/`.

When a session is resumed or forked, Agentify first tries an automatic MemPalace-backed search across prior session transcripts for the current repo, then falls back to Agentify's built-in ranked transcript search, and finally to direct lineage replay if no broader match is found. Normal `run` prompts use the same automatic recall path, so relevant older session decisions can surface even without a session id or explicit memory command.

`agentify doctor` reports MemPalace explicitly as an optional capability, so missing session-memory acceleration shows up in setup diagnostics instead of only appearing as a silent fallback at runtime.

Choose `sess *` whenever the work spans multiple launches or you want Agentify to keep durable memory for later reuse.

### `query` Commands

```bash
agentify query owner --file <path>
agentify query deps --module <id>
agentify query changed --since <commit>
agentify query search --term <value>
```

Use `query` when you want answers from Agentify's indexed understanding of the repo rather than raw filesystem output.

### `skill` Commands

```bash
agentify skill list
agentify skill install <name|all> --provider <name|all> --scope <project|user>
```

Built-in skills:

- `grill-me`
- `improve-codebase-architecture`
- `gh-issue-autopilot`
- `worktree-verifier` (alias: `god-mode`)
- `pr-creator`
- `commit-creator`

Use `--scope project` when you want the repository to carry its own provider skill setup under directories like `.codex/skills/`. Use `--scope user` when you want skills installed globally for your local account.

### `hooks` Commands

```bash
agentify hooks install
agentify hooks status
agentify hooks remove
```

Use hooks when you want Agentify checks and refreshes to happen automatically around Git operations instead of relying on people to remember them manually.

### `cache` Commands

```bash
agentify cache status
agentify cache gc
```

Use `cache status` to inspect cache growth. Use `cache gc` when you want to reclaim space without deleting the full Agentify index or docs.

## Sticky Provider Behavior

Provider defaults are repo-local and persisted in `.agentify.yaml`.

- An explicit `--provider` on `run`, `exec`, `sess run`, `sess resume`, or `sess fork` updates the repo's sticky provider.
- Commands like `up`, `sync`, `doc`, `check`, and `skill install` do not change the sticky execution provider.

Example:

```bash
agentify run --provider codex "task A"
agentify run "task B"
```

In the second command, Agentify reuses `codex` for the same repo.

## Important Flags

### General Flags

| Flag | Why and when to use it |
| --- | --- |
| `--provider <local|codex|claude|gemini|opencode>` | Choose the provider explicitly. Use this when setting or overriding the repo default for execution commands. |
| `--strict <true|false>` | Tighten validation behavior. Use this when you want failures to stop the workflow instead of being treated leniently. |
| `--languages <auto|ts|python|go|rust|dotnet|java|kotlin|swift>` | Override language detection. Use this when auto-detection is wrong or too broad for the repo. |
| `--dry-run` | Show what Agentify would do without writing changes. Use this before cleanup, installs, or config-affecting commands. |
| `--ghost` | Route outputs into `.current_session/`. Use this for ephemeral runs where you want isolated output artifacts. |
| `--json` | Emit machine-readable JSON. Use this when scripting around Agentify or integrating it into tooling. |
| `--interactive`, `-i` | Force interactive provider mode. Template providers already default to interactive mode for `run` and `sess`, but this is useful when you want to be explicit. |
| `--explain-plan` | Print the planner result before `run` executes. Use this when you want to inspect Agentify's chosen context first. |
| `--root <path>` | Target a repo other than the current working directory. Use this in scripts or monorepo tooling. |
| `--scope <project|user>` | Choose where skills are installed. Use `project` for repo-local behavior and `user` for account-level installs. |

### `exec`-Only Flags

| Flag | Why and when to use it |
| --- | --- |
| `--fail-on-stale` | Exit with code `80` if post-refresh validation fails. Use this in automation where stale artifacts should fail the job. |
| `--timeout <seconds>` | Kill the wrapped command after a time budget. Use this for long-running provider commands in CI or guarded local scripts. |
| `--skip-refresh` | Skip the post-command refresh. Use this only when you intentionally want the custom command without Agentify's usual follow-up maintenance. |

## Providers

- `local` is valid for maintenance workflows such as `index`, `doc`, `up`, and `check`.
- `run` and `sess *` require an external provider CLI: `codex`, `claude`, `gemini`, or `opencode`.
- `agentify this` supports provider-backed bootstrap on macOS and requires Homebrew for package installation.

## Semantic TypeScript/JavaScript Indexing

Semantic indexing is optional, but it is one of the highest-value features for TypeScript and JavaScript repositories.

Enable it in `.agentify.yaml`:

```yaml
provider: codex
semantic:
  tsjs:
    enabled: true
    workerConcurrency: 2
    timeoutMs: 45000
    memoryMb: 1536
```

Then refresh it with:

```bash
agentify doctor
agentify semantic refresh
agentify up
agentify check
```

Why use it:

- richer planner context for TS/JS repos
- semantic surfaces in `query search`
- better repo-map output
- deterministic semantic headers during doc generation

Use it when the repository is TypeScript- or JavaScript-heavy and raw dependency scanning is not enough.

How to verify it is active:

- `agentify doctor` shows a `Semantic TS/JS` section when semantic indexing is enabled and the repo has been indexed.
- `agentify query search --term <term>` starts returning semantic surfaces in addition to structural matches.
- `docs/repo-map.md` and module docs become richer after refreshes.

## MemPalace Session Memory Acceleration

MemPalace is optional, but it is the best way to accelerate session-memory recall once you start using `sess *` workflows heavily.

How to enable it:

1. install `mempalace` and keep it on `PATH`, or set `AGENTIFY_MEMPALACE_CMD`
2. run `agentify doctor` and confirm MemPalace is detected
3. use `agentify sess run`, `sess resume`, and `sess fork` so Agentify has durable session transcripts to mine

Example:

```bash
export AGENTIFY_MEMPALACE_CMD=/absolute/path/to/mempalace
agentify doctor
agentify sess run --provider codex --name "payments-v2" "implement retries"
agentify sess resume --session <session-id> "continue from the last checkpoint"
```

Important behavior:

- Agentify tries MemPalace-backed recall first, then local transcript search, then direct lineage replay.
- `run` can benefit from existing session history, but `run` itself does not create durable session artifacts.
- Use `sess *` whenever you want future recall, auditability, or multi-launch continuity.

## Recommended Workflows

### One-off bounded work

```bash
agentify run --provider codex "implement payment retries"
agentify run "add tests for retry backoff"
```

Use this for focused tasks where you want Agentify to build context and refresh the repo afterward, but you do not need a named durable workstream.

If the task is large or you want to inspect the selected context first:

```bash
agentify plan "add retry logic to checkout"
agentify query search --term retry
agentify run "add retry logic to checkout"
```

### Long-running work with durable memory

```bash
agentify sess run --provider codex --name "payments-v2" "implement initial module"
agentify sess list
agentify sess resume --session <session-id> "finish the remaining tests"
agentify sess fork --from <session-id> --name "payments-alt" "try a simpler design"
```

Use this when the work spans multiple launches, you want a durable audit trail under `.agents/session/`, or you want later runs to reuse prior context automatically.

### Deterministic maintenance before or after larger changes

```bash
agentify up
agentify check
```

Use this when you want the repo refreshed and validated independent of any provider session.

### Upgrade an already-Agentified repo after Agentify itself changes

```bash
agentify sync
agentify check
```

Use this when the Agentify CLI adds new repo-level features and you want the existing codebase to adopt them. `sync` refreshes `.agentify.yaml` with newly added defaults, restores missing baseline artifacts, updates already-managed git hooks, refreshes repo-scoped built-in skills for detected project providers, and then runs the normal maintenance pipeline with the deterministic local provider so it does not depend on external provider auth.

### Cheap deterministic maintenance without changing the sticky provider

```bash
agentify up --provider local
```

Use this when you want the repo refreshed without switching the repo's execution provider away from `codex`, `claude`, `gemini`, or `opencode`.

### Recommended daily loop

```bash
agentify run "implement <task>"
agentify check
```

For longer initiatives:

```bash
agentify sess run --provider codex --name "<stream>" "<task>"
agentify sess resume --session <session-id> "<next-step>"
agentify check
```

This keeps the repo fresh, validated, and ready for the next launch instead of treating Agentify as a one-time bootstrap tool.

## Bootstrap Notes

```bash
agentify this
agentify this --provider codex
agentify this --provider codex --root /path/to/repo
```

- `this` is macOS-only.
- In non-interactive mode, `--provider` is required.
- The default root is the current working directory.
- Use it when you want Agentify to verify Homebrew, provider CLI availability, and recommended local tooling automatically.

## Codex Codebase Auditor Setup

This repository also ships a repo-local audit workflow for Codex that is separate from the published `agentify` CLI.

Commands:

```bash
./setup_codex_issue_agents.sh
codex "$(cat run_codex-codebase-auditor.txt)"
```

Why and when to use it:

- Use `./setup_codex_issue_agents.sh` when you want to scaffold the `.codex/` multi-agent audit configuration in the current repository.
- Use `codex "$(cat run_codex-codebase-auditor.txt)"` when you want Codex to run the issue-first repository audit and create evidence-backed GitHub issues one at a time with `gh`.

What it prepares:

- `.codex/config.toml`
- `.codex/agents/*.toml`
- `run_codex-codebase-auditor.txt`
- alignment with the repo's `AGENTS.md` issue-quality rules

Prerequisites:

- `codex` CLI installed and authenticated
- `gh auth status` already passing

## Generated Artifacts

Common generated paths:

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
.current_session/*
```

What creates them:

- `init` creates baseline config and working directories.
- `index` or `scan` writes the SQLite index and refreshes repo map basics.
- `doc` writes markdown docs, run reports, and eligible headers.
- `sess *` writes session manifests and bootstrap context under `.agents/session/`.
- `--ghost` writes isolated outputs under `.current_session/`.

## Development

```bash
git clone https://github.com/ixigo/agentify.git
cd agentify
pnpm install
pnpm test
```

`package.json` currently exposes:

```bash
npm test
```

Both forms run Node's built-in test runner for this repository.

## More Docs

- [usage.md](./usage.md) for a step-by-step Codex-oriented operating guide
- [ADVANCED_ONBOARDING.md](./ADVANCED_ONBOARDING.md) for more opinionated rollout patterns

## License

MIT. See [LICENSE](./LICENSE).
