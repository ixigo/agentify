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

For longer workstreams, use sessions:

```bash
agentify sess run --provider codex --name "checkout-retries" "map the current checkout flow"
agentify sess resume --session <session-id> "finish the implementation"
agentify handoff --session <session-id> "handoff to the next agent"
```

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
| Preview task context | `agentify plan "your task"` |
| Search indexed repo context | `agentify query search --term auth` |
| Run a bounded task | `agentify run "your task"` |
| Start durable multi-run work | `agentify sess run --name "<stream>" "your task"` |
| Write a cross-agent handoff bundle | `agentify handoff --session <id> "next task"` |
| Install built-in skills into the repo | `agentify skill install all --provider codex --scope project` |
| Update Agentify-owned repo files after upgrading the CLI | `agentify sync` |

> **Note** — `agentify up` runs the repo's detected `package.json` test script in a **sanitized environment** by default. The host shell's environment is not forwarded to the test subprocess; configure `tests.env.passthrough` / `tests.env.extra` (or set `tests.env.inherit: true`) in `.agentify.yaml` if a test suite needs specific variables. See [docs/DETAILED_README.md](./docs/DETAILED_README.md#project-test-environment) for the allowlist and override schema.

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
docs/repo-map.md
docs/modules/
```

Commit `.agentify.yaml`, `.agentignore`, `.guardrails`, and the managed `.gitignore` block when you want Agentify policy shared with the repo. The managed `.gitignore` block keeps local/generated runtime output such as `.agents/`, `.agentify/work/`, `AGENTIFY.md`, `docs/repo-map.md`, `docs/modules/`, `output.txt`, and `agentify-report.html` out of Git by default.

## Best First Workflow

For a new repo:

```bash
agentify doctor
agentify init --provider codex
agentify skill install all --provider codex --scope project
agentify up
agentify check
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
