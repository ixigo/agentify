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

Agentify turns a Git repo into an AI-agent-ready workspace.

It indexes your codebase, writes agent-facing context, validates repo state, and wraps provider CLIs so Codex, Claude, Gemini, OpenCode, or local workflows start with better context and leave the repo refreshed.

> [!WARNING]
> Agentify is still under active development. Use it for testing first, and avoid running it directly on your main production repository until you are comfortable with the generated artifacts.

## Try It

Install Agentify from a local checkout:

```bash
git clone https://github.com/ixigo/agentify.git
cd agentify
pnpm install
pnpm link --global
agentify --version
```

Then move into a Git repo you want to prepare:

```bash
cd /path/to/your/repo
git rev-parse --is-inside-work-tree
agentify doctor
```

On macOS, use the fastest bootstrap path:

```bash
agentify this --provider codex
agentify up
agentify check
```

On Linux, CI, or pre-provisioned machines, initialize manually:

```bash
agentify init --provider codex
agentify up
agentify check
```

Requires Node.js 20 or newer and pnpm. Provider-backed runs also require the provider CLI you choose, such as `codex`, `claude`, `gemini`, or `opencode`.

## Agents

Use this checklist when an AI agent is setting up Agentify for a repo.

> [!IMPORTANT]
> Run Agentify commands from inside the target Git repo, not from the Agentify source checkout. Verify first with `git rev-parse --is-inside-work-tree`.

```bash
# 1. Install the Agentify CLI if it is not already available.
git clone https://github.com/ixigo/agentify.git
cd agentify
pnpm install
pnpm link --global

# 2. Move to the repo the user wants prepared.
cd /path/to/target/repo
git rev-parse --is-inside-work-tree

# 3. Check machine and repo readiness.
agentify doctor

# 4. Bootstrap on macOS, or use init on already-provisioned machines.
agentify this --provider codex
# agentify init --provider codex

# 5. Refresh generated context and validate state.
agentify up
agentify check
```

For already-initialized repos, prefer `agentify up --provider local` and `agentify check` before re-running init. Skills are intentionally opt-in: do not install them unless the user asks or the task requires one.

<details>
<summary>Optional agent commands</summary>

```bash
# Install skills only after explicit opt-in.
agentify skill install all --provider codex --scope project

# Preview task context before running a provider.
agentify plan "your task"

# Open the provider with Agentify context and let it ask for the task.
agentify run --provider codex

# Run a bounded task.
agentify run --provider codex "your task"

# Use durable session memory for a longer workstream.
# Open a durable session with context and let the provider ask for the task.
agentify sess run --provider codex --name "<stream>"

agentify sess run --provider codex --name "<stream>" "<first task>"
agentify sess resume --session <session-id> "<next task>"
agentify handoff --session <session-id> "handoff for the next agent"
```

</details>

## Run An Agent Task

Once the repo is initialized:

```bash
agentify run --provider codex "add tests for the checkout retry logic"
```

After the first provider-backed run, Agentify remembers the repo's provider, so follow-up tasks can be shorter:

```bash
agentify run "implement the retry backoff"
agentify check
```

Interactive `run` starts a fresh provider task with a compact prompt. Run `agentify run` without a task to open the provider with Agentify context and let the provider ask what to do next, or pass the task directly as `agentify run "task"`. Add `--resume` or `--continue` only when you want to resume the provider's most recent session. Use `--context-mode routed` when you want bounded retrieval guidance without full source excerpts. Add `--with-context` when you explicitly want Agentify to inject selected files, related tests, prior memory, and execution rules into the first provider message.

```bash
agentify run --resume "finish the retry backoff"
agentify run --with-context "implement the retry backoff"
agentify run --context-mode routed "implement the retry backoff"
```

For longer workstreams, use sessions:

```bash
agentify sess run --provider codex --name "checkout-retries"
agentify sess run --provider codex --name "checkout-retries" "map the current checkout flow"
agentify sess resume --session <session-id> "finish the implementation"
agentify handoff --session <session-id> "handoff to the next agent"
```

## Routed Context Mode

Agentify cannot delete tokens from a provider context that is already running. Routed mode prevents bloat before launch: `plan`, `run --with-context`, and `sess *` send a bounded prompt with ranked summaries, file slices, related tests, and session memory instead of dumping the whole repo. Between launches, sessions compact prior work into `.agents/session/<id>/context.json`, `bootstrap.md`, `memory-context.md`, and rolling summaries, then retrieve exact slices only when needed.

For a test-writing workflow:

```bash
agentify plan "add analytics tests"
agentify context search analytics
agentify context fetch src/analytics/report.ts --symbol buildReport
agentify context fetch src/analytics/report.ts --lines 20:60
agentify sess resume --session <session-id> "write tests from the prepared compacted context"
```

`AGENTIFY.md`, `docs/repo-map.md`, module docs, and `context.json` are summaries and routing metadata. Treat `agentify context fetch ...` and selected file slices in a plan as exact code. Reported prompt and session context byte counts, such as `prompt_bytes` and `session_context_bytes`, are UTF-8 byte estimates for Agentify-managed material, not a provider token count or a guarantee about live provider context size.

Routed context artifacts are local/generated by default under `.agents/`, `.agentify/work/`, `AGENTIFY.md`, `docs/repo-map.md`, and `docs/modules/`. Agentify sanitizes repo test subprocess environments by default, but provider runs inherit the provider environment and Agentify is not a secret redactor for committed files or selected code slices. Keep secrets out of the repo, add paths to `.agentignore`, and only opt variables into `tests.env.passthrough` / `tests.env.extra` when tests require them.

## Caveman Mode

Caveman mode asks provider agents to answer tersely for lower output-token spend while keeping technical details exact.

Install it as an opt-in skill:

```bash
agentify skill install caveman --provider codex --scope project
```

Or apply it to one run/session prompt:

```bash
agentify run --caveman=ultra "summarize the risky auth paths"
AGENTIFY_CAVEMAN=full agentify run "map the checkout module"
```

Supported levels are `lite`, `full`, `ultra`, `wenyan`, `wenyan-lite`, `wenyan-full`, and `wenyan-ultra`. Commit messages, PR descriptions, code, and safety-critical confirmations stay normal prose. Rules adapted from the MIT-licensed [caveman](https://github.com/JuliusBrussee/caveman) project.

## Useful First Commands

| Goal | Command |
| --- | --- |
| Check local readiness | `agentify doctor` |
| Set up the current repo on macOS | `agentify this --provider codex` |
| Set up manually | `agentify init --provider codex` |
| Refresh index, checks, and detected tests | `agentify up` |
| Validate repo state | `agentify check` |
| Validate after intentional source edits | `agentify check --hook` |
| Preview rich task context | `agentify plan "your task"` |
| Search indexed repo context | `agentify query search --term auth` |
| Search routed context | `agentify context search auth` |
| Navigate semantic TS/JS facts | `agentify query refs --symbol useAuth` |
| Open provider with context | `agentify run` |
| Continue previous provider conversation | `agentify run --resume` |
| Run a bounded task | `agentify run "your task"` |
| Run with routed retrieval | `agentify run --context-mode routed "your task"` |
| Run with Agentify-selected context injected | `agentify run --with-context "your task"` |
| Start durable multi-run work | `agentify sess run --name "<stream>"` |
| Write a cross-agent handoff bundle | `agentify handoff --session <id> "next task"` |
| Install optional built-in skills into the repo | `agentify skill install all --provider codex --scope project` |
| Update Agentify-owned repo files after upgrading the CLI | `agentify sync` |

> **Note** — `agentify up` runs the repo's detected test command in a **sanitized environment** by default. Agentify detects common JavaScript/TypeScript, Python, Go, Rust, .NET, Java/Kotlin, and Swift test commands; if a non-JS stack is detected but no runnable test command is known, the test phase reports `unsupported` instead of silently skipping. The host shell's environment is not forwarded to the test subprocess; configure `tests.env.passthrough` / `tests.env.extra` (or set `tests.env.inherit: true`) in `.agentify.yaml` if a test suite needs specific variables. See [docs/DETAILED_README.md](./docs/DETAILED_README.md#project-test-environment) for the allowlist and override schema.

## CLI Reference

### Commands

| Command | Description |
| --- | --- |
| `init` | Create baseline Agentify artifacts |
| `index` | Build the SQLite repository index |
| `scan` | Alias for index |
| `doc` | Generate docs, metadata, and key-file headers |
| `up` | Run scan -> optional doc -> check -> test pipeline |
| `sync` | Upgrade repo-owned Agentify files, then run refresh |
| `check` | Validate freshness, schemas, and safety rules |
| `plan` | Preview the planner-selected context for a task |
| `context` | Search indexed context and fetch exact bounded file slices |
| `run` | Run provider template command with auto-refresh |
| `exec` | Advanced wrapper for custom agent commands |
| `handoff` | Write a cross-agent handoff bundle for a session |
| `this` | Bootstrap this macOS repo for a provider-backed Agentify workflow |
| `context` | Search, fetch, compact, and inspect routed context |
| `query` | Query the repository index (owner, deps, changed, def, refs, callers, impacts) |
| `risk` | Score PR blast radius and recommend regression tests |
| `skill` | Manage built-in agent skills |
| `sess` | Manage provider-backed sessions |
| `memory` | Manage agent memory helpers |
| `issue-killer` | Launch labelled GitHub issues into supervised tmux worktrees |
| `hooks` | Install/remove git hooks |
| `doctor` | Check toolchain health and capability tier |
| `semantic` | Refresh semantic TS/JS project facts |
| `clean` | Prune stale generated artifacts and dead Agentify folders |
| `cache` | Manage the content cache |

### Options

| Option | Description |
| --- | --- |
| `--provider <local|codex|claude|gemini|opencode>` | Choose a provider. `skill install` also accepts comma lists and `all`. |
| `--strict <true|false>` | Fail closed on validation issues |
| `--languages <auto|ts|python|go|rust|dotnet|java|kotlin|swift>` | Override language detection |
| `--dry-run` | Report planned changes without writing |
| `--docs` | Generate docs during refresh/update flows (on by default; use `--docs=false` to skip) |
| `--headers` | Apply `@agentify` headers to source files (off by default) |
| `--semantic` | Show detailed semantic diagnostics with doctor |
| `--provider-timeout-ms <ms>` | Fail provider doc calls after N milliseconds |
| `--ghost` | Route outputs to `.current_session/` |
| `--json` | Machine-readable JSON output only |
| `--explain` | Include planner score breakdowns for plan output |
| `--interactive`, `-i` | Force interactive mode (template providers default to interactive for `run`/`sess`) |
| `--continue` | Resume the provider's most recent session for `run`; omitted means a fresh provider task |
| `--resume` | Alias for `run --continue`; with `session`/`sess`, resume Agentify session context |
| `--context-mode` | Choose `compact` or `routed` run prompt behavior |
| `--with-context` | Inject planner-selected files, tests, and memory into `run` |
| `--context-mode <direct|routed>` | Use routed context retrieval for `run`/`sess` prompts |
| `--explain-plan` | Print planner output before executing `run` |
| `--caveman[=level]` | Terse output for `run`/`sess` (`lite`, `full`, `ultra`, `wenyan*`) |
| `--root <path>` | Target repo root (default: cwd) |
| `--scope <project|user>` | Skill install scope (`skill` command) |
| `--hook` | Hook-friendly validation for `check`/`up`: skip source body diffing |

### Exec Flags

| Flag | Description |
| --- | --- |
| `--fail-on-stale` | Exit 80 if validation fails post-refresh |
| `--timeout <seconds>` | Kill wrapped command after N seconds |
| `--skip-refresh` | Skip post-command refresh |

## What Agentify Creates

Depending on the command, Agentify can create or refresh:

```text
.agentify.yaml
.gitignore
.agentignore
.guardrails
.agentify/work/
.agents/index.db
.agents/runs/
.agents/session/
AGENTIFY.md
<module-root>/AGENTIFY.md
docs/repo-map.md
```

Commit `.agentify.yaml`, `.agentignore`, `.guardrails`, and the managed `.gitignore` block when you want Agentify policy shared with the repo. The managed `.gitignore` block keeps local/generated runtime output such as `.agents/`, `.agentify/work/`, `AGENTIFY.md`, `docs/repo-map.md`, `docs/modules/`, `output.txt`, and `agentify-report.html` out of Git by default.

## Best First Workflow

For a new repo:

```bash
agentify doctor
agentify init --provider codex
agentify up
agentify check
```

Skills are not installed during init. Add them only when you explicitly want repo-scoped skills:

```bash
agentify skill install all --provider codex --scope project
```

For day-to-day work:

```bash
agentify run "implement <task>"
agentify check
```

For a larger initiative:

```bash
agentify sess run --provider codex --name "<stream>" "<first task>"
agentify sess resume --session <session-id> "<next task>"
agentify check
```

## Optional Accelerators

- **MemPalace** — local AI memory backend that mines `agentify sess` transcripts and surfaces relevant prior context on recall. Install with `pipx install mempalace` (Python 3.9+); keep `mempalace` on `PATH` or set `AGENTIFY_MEMPALACE_CMD`. Setup details in [docs/usage.md § 6](./docs/usage.md).

## Learn More

- [docs/DETAILED_README.md](./docs/DETAILED_README.md) has the full command guide, provider behavior, semantic indexing, session memory, generated artifacts, and development notes.
- [docs/usage.md](./docs/usage.md) is a step-by-step Codex-oriented operating guide.
- [docs/ADVANCED_ONBOARDING.md](./docs/ADVANCED_ONBOARDING.md) covers team rollout patterns.
- [docs/LLM_PROMPT.md](./docs/LLM_PROMPT.md) is a single-file instruction prompt you can paste into an AI coding agent.
- [docs/QNA.md](./docs/QNA.md) answers common questions about how Agentify behaves.

## Development

```bash
git clone https://github.com/ixigo/agentify.git
cd agentify
pnpm install
pnpm test
```

License: [MIT](./LICENSE)
