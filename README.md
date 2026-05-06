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

> **Turn any Git repo into an AI-agent-ready workspace.**

Agentify indexes your codebase, writes agent-facing context, validates repo state, and wraps provider CLIs (Codex, Claude, Gemini, OpenCode) so AI coding agents start with rich context and leave the repo refreshed.

> [!WARNING]
> Agentify is under active development. Test on a sandbox repo before running it on production code.

---

## 🚀 Quick Start

Pick your path. **Skip the section that doesn't apply to you.**

<table>
<tr>
<td width="50%" valign="top">

### 👤 [For Humans](#-for-humans)

You'll install and run Agentify yourself.

**Best when:** you want full control, are exploring features, or are setting up a long-lived workflow.

</td>
<td width="50%" valign="top">

### 🤖 [For Agents](#-for-agents)

Paste a single prompt to your AI assistant — it handles install, bootstrap, and verification.

**Best when:** you want zero-touch setup. Hand the work to Claude/Codex/Gemini and review the result.

</td>
</tr>
</table>

---

## 👤 For Humans

<details >
<summary><b>1. Prerequisites</b></summary>

| Tool | Version | Required |
| --- | --- | --- |
| Node.js | 20+ | ✅ |
| pnpm | latest | ✅ |
| Git | any recent | ✅ |
| Provider CLI | `codex` / `claude` / `gemini` / `opencode` | optional, only for provider-backed runs |

</details>

<details >
<summary><b>2. Install Agentify</b></summary>

```bash
git clone https://github.com/ixigo/agentify.git
cd agentify
pnpm install
pnpm link --global
agentify --version
```

</details>

<details >
<summary><b>3. Bootstrap a target repo</b></summary>

```bash
cd /path/to/your/repo
git rev-parse --is-inside-work-tree   # confirm you're inside a Git repo
agentify doctor                        # check toolchain readiness
```

**macOS — fastest path:**

```bash
agentify this --provider codex
agentify up
agentify check
```

**Linux / CI / pre-provisioned machines:**

```bash
agentify init --provider codex
agentify up
agentify check
```

</details>

<details>
<summary><b>4. Run a task</b></summary>

```bash
# Bounded one-shot
agentify run --provider codex "add tests for the checkout retry logic"

# After first provider-backed run, provider is remembered
agentify run "implement the retry backoff"
agentify check

# Long workstream with durable session memory
agentify sess run --provider codex --name "checkout-retries"
agentify sess resume --session <session-id> "finish the implementation"
agentify handoff --session <session-id> "handoff for the next agent"
```

</details>

<details>
<summary><b>5. Optional: install skills</b></summary>

Skills are opt-in. Install only if you need them:

```bash
agentify skill install all --provider codex --scope project
agentify skill install caveman --provider codex --scope project   # terse output mode
```

</details>

---

## 🤖 For Agents

> **Copy the block below and paste it to your AI agent (Claude, Codex, Gemini, OpenCode).** The agent will install Agentify, bootstrap the current repo, and verify the result without further input.

````markdown
You are setting up Agentify in the user's current Git repository.

## Goal
Install the Agentify CLI (if missing), bootstrap this repo, run the validation
pipeline, and report a one-line status. Stop and ask the user before any
destructive action.

## Pre-flight
1. Confirm we are inside a Git work tree:
   `git rev-parse --is-inside-work-tree`
   If not a Git repo, ask the user to run `git init` first. Do not init silently.
2. Confirm Node.js >= 20 (`node -v`) and pnpm is available (`pnpm -v`).
   If pnpm is missing, install it via `npm i -g pnpm` only after confirming with the user.

## Install Agentify (skip if `agentify --version` works)
```bash
git clone https://github.com/ixigo/agentify.git ~/.agentify-cli
cd ~/.agentify-cli && pnpm install && pnpm link --global
agentify --version
```

## Bootstrap the target repo
Run from the *target repo*, not from the Agentify checkout.

```bash
cd <target-repo>
agentify doctor

# macOS:
agentify this --provider codex
# OR (Linux / CI / already provisioned):
# agentify init --provider codex

agentify up
agentify check
```

## Defaults & rules
- Default provider: `codex`. If the user mentions Claude / Gemini / OpenCode,
  swap `--provider` accordingly.
- Do **not** install skills unless the user explicitly asks.
- Do **not** modify `.gitignore`, `.agentignore`, or `.guardrails` outside of
  what `agentify init`/`agentify this` produces.
- If `agentify check` fails, surface the failure verbatim and stop.

## Report
Reply with: provider used, files created/modified (from `git status`), and
the result of `agentify check` (pass/fail + first failing line if any).
````

That's it. The agent will leave the repo with `.agentify.yaml`, `.agentignore`, `.guardrails`, an updated `.gitignore`, an `AGENTIFY.md`, and a populated `.agents/` index.

---

## 🧠 What Agentify Creates

```text
.agentify.yaml              # repo policy (committed)
.agentignore                # paths agentify ignores (committed)
.guardrails                 # safety rules for agents (committed)
.gitignore                  # managed block added (committed)
AGENTIFY.md                 # agent-facing repo overview (generated, gitignored)
docs/repo-map.md            # routing map (generated, gitignored)
<module>/AGENTIFY.md        # per-module context (generated, gitignored)
.agents/index.db            # SQLite repo index (gitignored)
.agents/runs/, .agents/session/   # run + session state (gitignored)
.agentify/work/             # scratch / staging (gitignored)
```

Commit `.agentify.yaml`, `.agentignore`, `.guardrails`, and the managed `.gitignore` block. Everything under `.agents/` and `.agentify/work/` is local runtime.

---

## 📚 Useful Commands

| Goal | Command |
| --- | --- |
| Check readiness | `agentify doctor` |
| Bootstrap (macOS) | `agentify this --provider codex` |
| Bootstrap (manual) | `agentify init --provider codex` |
| Refresh index + checks + tests | `agentify up` |
| Validate repo state | `agentify check` |
| Hook-friendly validate | `agentify check --hook` |
| Preview task context | `agentify plan "your task"` |
| Search indexed context | `agentify query search --term auth` |
| Search routed context | `agentify context search auth` |
| Find symbol references | `agentify query refs --symbol useAuth` |
| Open provider with context | `agentify run` |
| Resume last provider session | `agentify run --resume` |
| Run a bounded task | `agentify run "your task"` |
| Routed retrieval mode | `agentify run --context-mode routed "your task"` |
| Inject selected context | `agentify run --with-context "your task"` |
| Start a durable session | `agentify sess run --name "<stream>"` |
| Cross-agent handoff | `agentify handoff --session <id> "next task"` |
| Install built-in skills | `agentify skill install all --provider codex --scope project` |
| Sync repo files after upgrade | `agentify sync` |

> **Note** — `agentify up` runs the repo's detected test command in a **sanitized environment** by default. Configure `tests.env.passthrough` / `tests.env.extra` (or `tests.env.inherit: true`) in `.agentify.yaml` if your tests need specific variables. See [docs/DETAILED_README.md](./docs/DETAILED_README.md#project-test-environment).

---

## 🛣️ Routed Context Mode

Agentify cannot delete tokens from a provider context that is already running. **Routed mode prevents bloat before launch:** `plan`, `run --with-context`, and `sess *` send a bounded prompt with ranked summaries, file slices, related tests, and session memory instead of dumping the whole repo.

```bash
agentify plan "add analytics tests"
agentify context search analytics
agentify context fetch src/analytics/report.ts --symbol buildReport
agentify context fetch src/analytics/report.ts --lines 20:60
agentify sess resume --session <id> "write tests from the prepared compacted context"
```

`AGENTIFY.md`, `docs/repo-map.md`, module docs, and `context.json` are summaries and routing metadata. Treat `agentify context fetch ...` and selected file slices in a plan as exact code.

Reported `prompt_bytes` and `session_context_bytes` are UTF-8 byte estimates for Agentify-managed material — **not** a provider token count or a guarantee about live provider context size.

Routed artifacts are local/generated under `.agents/`, `.agentify/work/`, `AGENTIFY.md`, `docs/repo-map.md`, and `docs/modules/`. Agentify sanitizes test subprocess envs, but provider runs inherit the provider environment. **Agentify is not a secret redactor** — keep secrets out of the repo, add paths to `.agentignore`, and only opt variables into `tests.env.passthrough` / `tests.env.extra` when needed.

---

## 🗿 Caveman Mode

Terse provider answers for lower output-token spend, technical details preserved.

```bash
# As a skill
agentify skill install caveman --provider codex --scope project

# Per-run
agentify run --caveman=ultra "summarize the risky auth paths"
AGENTIFY_CAVEMAN=full agentify run "map the checkout module"
```

Levels: `lite`, `full`, `ultra`, `wenyan`, `wenyan-lite`, `wenyan-full`, `wenyan-ultra`. Commit messages, PR descriptions, code, and safety-critical confirmations stay normal prose. Adapted from MIT-licensed [caveman](https://github.com/JuliusBrussee/caveman).

---

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

> **Note** — `agentify up` runs the repo's detected test command in a **sanitized environment** by default and enforces `tests.timeoutMs` to avoid hanging indefinitely. Agentify detects common JavaScript/TypeScript, Python, Go, Rust, .NET, Java/Kotlin, and Swift test commands; if a non-JS stack is detected but no runnable test command is known, the test phase reports `unsupported` instead of silently skipping. The host shell's environment is not forwarded to the test subprocess; configure `tests.env.passthrough` / `tests.env.extra` (or set `tests.env.inherit: true`) in `.agentify.yaml` if a test suite needs specific variables. See [docs/DETAILED_README.md](./docs/DETAILED_README.md#project-test-environment) for the allowlist and override schema.
## 📖 CLI Reference

<details>
<summary><b>Commands</b></summary>

| Command | Description |
| --- | --- |
| `init` | Create baseline Agentify artifacts |
| `index` / `scan` | Build the SQLite repository index |
| `doc` | Generate docs, metadata, key-file headers |
| `up` | scan → optional doc → check → test pipeline |
| `sync` | Upgrade repo-owned Agentify files, then refresh |
| `check` | Validate freshness, schemas, safety rules |
| `plan` | Preview planner-selected context for a task |
| `context` | Search indexed context, fetch bounded slices |
| `run` | Run provider with auto-refresh |
| `exec` | Advanced wrapper for custom agent commands |
| `handoff` | Write cross-agent handoff bundle for a session |
| `this` | Bootstrap macOS repo for provider-backed workflow |
| `query` | Query the repo index (owner, deps, changed, def, refs, callers, impacts) |
| `risk` | Score PR blast radius, recommend regression tests |
| `skill` | Manage built-in agent skills |
| `sess` | Manage provider-backed sessions |
| `memory` | Manage agent memory helpers |
| `issue-killer` | Launch labelled GitHub issues into supervised tmux worktrees |
| `hooks` | Install/remove git hooks |
| `doctor` | Toolchain health + capability tier |
| `semantic` | Refresh semantic TS/JS facts |
| `clean` | Prune stale generated artifacts |
| `cache` | Manage the content cache |

</details>

<details>
<summary><b>Options</b></summary>

| Option | Description |
| --- | --- |
| `--provider <local\|codex\|claude\|gemini\|opencode>` | Choose provider. `skill install` also accepts comma lists and `all`. |
| `--strict <true\|false>` | Fail closed on validation issues |
| `--languages <auto\|ts\|python\|go\|rust\|dotnet\|java\|kotlin\|swift>` | Override language detection |
| `--dry-run` | Report planned changes without writing |
| `--docs` | Generate docs during refresh (on by default; `--docs=false` to skip) |
| `--headers` | Apply `@agentify` headers to source files (off by default) |
| `--semantic` | Detailed semantic diagnostics with doctor |
| `--provider-timeout-ms <ms>` | Fail provider doc calls after N ms |
| `--ghost` | Route outputs to `.current_session/` |
| `--json` | Machine-readable JSON output only |
| `--explain` | Include planner score breakdowns for plan output |
| `--interactive`, `-i` | Force interactive mode (template providers default to interactive for `run`/`sess`) |
| `--continue` | Resume the provider's most recent session for `run`; omitted means a fresh provider task |
| `--resume` | Alias for `run --continue`; with `session`/`sess`, resume Agentify session context |
| `--context-mode` | Choose `compact` or `routed` run prompt behavior |
| `--with-context` | Inject planner-selected files, tests, and memory into `run` |
| `--context-mode <direct|routed>` | Use routed context retrieval for `run`/`sess` prompts |
| `--bypass-permissions` | Explicitly bypass provider permission prompts for `issue-killer` panes |
| `--explain-plan` | Print planner output before executing `run` |
| `--caveman[=level]` | Terse output (`lite`, `full`, `ultra`, `wenyan*`) |
| `--root <path>` | Target repo root (default: cwd) |
| `--scope <project\|user>` | Skill install scope |
| `--hook` | Hook-friendly validation: skip source body diffing |

</details>

<details>
<summary><b>Exec flags</b></summary>

| Flag | Description |
| --- | --- |
| `--fail-on-stale` | Exit 80 if validation fails post-refresh |
| `--timeout <seconds>` | Kill wrapped command after N seconds |
| `--skip-refresh` | Skip post-command refresh |

</details>

---

## 🧩 Optional Accelerators

- **MemPalace** — local AI memory backend that mines `agentify sess` transcripts and surfaces relevant prior context on recall. Install: `pipx install mempalace` (Python 3.9+). Keep `mempalace` on `PATH` or set `AGENTIFY_MEMPALACE_CMD`. Setup: [docs/usage.md § 6](./docs/usage.md).

---

## 📚 Learn More

- [docs/DETAILED_README.md](./docs/DETAILED_README.md) — full command guide, provider behavior, semantic indexing, sessions, generated artifacts, dev notes
- [docs/usage.md](./docs/usage.md) — step-by-step Codex-oriented operating guide
- [docs/ADVANCED_ONBOARDING.md](./docs/ADVANCED_ONBOARDING.md) — team rollout patterns
- [docs/LLM_PROMPT.md](./docs/LLM_PROMPT.md) — single-file instruction prompt for any AI coding agent
- [docs/QNA.md](./docs/QNA.md) — common questions

---

## 🛠️ Development

```bash
git clone https://github.com/ixigo/agentify.git
cd agentify
pnpm install
pnpm test
```

License: [MIT](./LICENSE)
