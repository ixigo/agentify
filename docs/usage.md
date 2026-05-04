# Agentify Everyday Usage

This is the operating guide for a normal developer using Agentify day to day. It covers first-time setup, the required `doctor` check, daily refresh and validation, provider-backed work, sessions, and session memory.

`agentify doctor` is the mandatory first check for any developer environment. Run it even if you are not planning to use Agentify for a task that day: it verifies the local AI-coding toolchain and shows exactly which required or recommended tools are missing. On macOS, `agentify this --provider <provider>` can install missing bootstrap tools after `doctor` exposes the gaps. On other platforms, install the tools from the `doctor` hints with your package manager, then rerun `doctor`.

## Everyday Flow

For most developers, the normal lifecycle is:

1. Check the machine and repo toolchain.

```bash
agentify doctor
```

2. Initialize the repo once.

```bash
agentify this --provider codex   # macOS bootstrap path
# or
agentify init --provider codex   # manual/pre-provisioned path
```

3. Generate or refresh repo context.

```bash
agentify up
```

4. Install hooks once per repo.

```bash
agentify hooks install
```

Skills are not installed by default. Install them only when the repo or team intentionally wants provider-specific behavior under `.codex/skills/`, `.claude/skills/`, `.gemini/skills/`, or `.opencode/skills/`.

5. Use lightweight runs for small tasks and sessions for multi-step work.

```bash
agentify run "fix the checkout retry bug"
agentify sess run --provider codex --name "checkout-retries" "implement retries and tests"
agentify sess resume --session <session-id> "continue from the last checkpoint"
```

6. Finish with validation and risk review before handing off or opening a PR.

```bash
agentify check
agentify risk --since origin/main
agentify handoff --session <session-id> "handoff current state"
```

If you only want a deterministic maintenance pass and do not need model-backed docs, use:

```bash
agentify up --provider local
```

## What "Agent Ready" Means

A repository is ready when all of these are true:

- `agentify doctor` reports the expected capability tier for the repo.
- `codex --version` works.
- `codex login status` shows Codex is logged in.
- `.agentify.yaml` exists and the repo provider is `codex`.
- Baseline repo artifacts exist: `.agentignore`, `.guardrails`, `.agentify/work/`.
- Generated Agentify artifacts exist: `.agents/index.db`, root `AGENTIFY.md`, `docs/repo-map.md`, and module-root `AGENTIFY.md` files.
- `agentify check` passes.

## Prerequisites

Required:

- A Git repository.
- Node.js 20 or newer.
- `agentify` available on `PATH` from a local checkout.
- Codex CLI installed and authenticated.

Recommended local tools:

- `rg`
- `fd`
- `ast-grep`
- `tree-sitter`
- `mempalace` for optional session-memory acceleration

`agentify doctor` reports these tools and prints install hints for anything missing. Agentify's macOS bootstrap command installs missing versions of the required native tools automatically.

## Fastest Setup On macOS

Use this path if you are on macOS and want the shortest reliable setup.

### 1. Link Agentify from a local checkout

```bash
git clone https://github.com/ixigo/agentify.git
cd /path/to/agentify
pnpm install
pnpm link --global
```

### 2. Move into the repository

```bash
cd /path/to/your/repo
```

### 3. Run doctor first

```bash
agentify doctor
```

Treat `doctor` as the environment gate. If it reports missing tier tools, either let the macOS bootstrap install them in the next step or install them yourself and rerun `agentify doctor`.

### 4. Bootstrap the repo for Codex

```bash
agentify this --provider codex
```

What this does:

- Verifies the current path is inside a Git repository.
- Checks for Homebrew.
- Installs missing local tools when needed: `ripgrep`, `fd`, `ast-grep`, `tree-sitter-cli`.
- Installs Codex CLI when needed: `npm install -g @openai/codex`.
- Writes repo-local Agentify config and baseline artifacts.
- Checks whether Codex auth is ready.

### 5. If bootstrap says login is required, authenticate Codex

```bash
codex login
codex login status
```

### 6. Re-run doctor after bootstrap

```bash
agentify doctor
```

This confirms the installed tools are now visible on `PATH`.

### 7. Generate the index, validation output, and run tests

```bash
agentify up
```

`agentify up` runs:

- `scan`
- `check`
- repo tests when a runnable test command is detected

Detected commands include common JavaScript/TypeScript package scripts plus Python, Go, Rust, .NET, Java/Kotlin, and Swift project test commands. If a non-JS stack is detected but Agentify cannot identify a runnable command, the test phase reports `unsupported` and `up` exits non-zero instead of presenting a false-green run.

`doc` runs by default in `up`. Pass `--docs=false` only when you explicitly want to skip markdown refreshes.

### 8. Confirm the repo is ready

```bash
agentify check
```

At this point the repo is Agentify + Codex ready.

## Manual Setup On Linux, Non-Bootstrap Environments, Or Pre-Provisioned Machines

Use this when `agentify this` is not available or you want to manage dependencies yourself.

### 1. Link Agentify and install the Codex CLI

```bash
git clone https://github.com/ixigo/agentify.git
cd /path/to/agentify
pnpm install
pnpm link --global
pnpm add --global @openai/codex tree-sitter-cli
```

### 2. Install the recommended native tools with your OS package manager

Make sure these binaries are available on `PATH` with these exact names:

- `rg`
- `fd`
- `ast-grep`
- `tree-sitter`

### 3. Log into Codex

```bash
codex login
codex login status
```

### 4. Move into the repository

```bash
cd /path/to/your/repo
```

### 5. Run doctor before initializing the repo

```bash
agentify doctor
```

Fix missing tools from the printed install hints before continuing. This step matters even on machines where you do not plan to run Agentify commands often, because the same toolchain powers fast repo search, semantic indexing, and provider context quality.

### 6. Initialize Agentify with Codex as the repo provider

For a fresh repo with no existing Agentify config:

```bash
agentify init --provider codex
```

If the repo already has `.agentify.yaml`, make sure it contains:

```yaml
provider: codex
```

### 7. Generate repository artifacts

```bash
agentify up
```

If you want the exact steps separately instead of the full pipeline:

```bash
agentify scan
agentify doc
agentify check
```

## What Gets Created

After `agentify this` or `agentify init`:

- `.agentify.yaml`
- `.gitignore` with a managed Agentify generated-artifact block
- `.agentignore`
- `.guardrails`
- `.agentify/work/`
- `.agents/`
- `.agents/runs/`
- `<module-root>/AGENTIFY.md`

After `agentify scan`:

- `.agents/index.db`
- `docs/repo-map.md`

After `agentify doc`:

- `AGENTIFY.md`
- `<module-root>/AGENTIFY.md`
- `.agents/runs/*.json`
- refreshed `@agentify` file headers when applicable

Most commands also write run evidence to:

- `output.txt`
- `agentify-report.html`

Commit `.agentify.yaml`, `.agentignore`, `.guardrails`, and the managed `.gitignore` block when you want shared Agentify policy in the repo. The `.gitignore` block keeps `.agents/`, `.agentify/work/`, `.current_session/`, generated docs, and run reports out of normal Git status by default.

## How To Verify A Repo Is Really Ready

Run these checks:

```bash
agentify check
agentify plan "summarize the highest-risk area in this repo"
agentify query search --term auth
```

You should also confirm:

- `AGENTIFY.md` exists at the repo root.
- `.agents/index.db` exists.
- `docs/repo-map.md` exists.
- module roots contain generated `AGENTIFY.md` docs.

## Day-To-Day Codex Workflow

Use `agentify run` instead of calling `codex exec` directly when you want Agentify to keep the repo fresh.

### Start the day with a health check

Run this after switching repos, pulling a large branch, changing Node/provider installs, or onboarding to a new machine:

```bash
agentify doctor
```

`doctor` is read-only. It does not initialize the repo and does not change generated artifacts. It tells you whether the machine has the required baseline tools and whether optional accelerators such as semantic indexing and MemPalace are available.

For a cheap daily refresh that does not spend provider tokens:

```bash
git pull
agentify up --provider local
agentify check
```

Use the default provider only when you want provider-backed docs or normal agent execution:

```bash
agentify up
agentify run "fix the failing checkout test"
```

### Run a normal task

```bash
agentify run --provider codex "implement payment retries"
```

After the first sticky Codex run, the repo keeps `codex` as its default provider, so later runs can omit `--provider`:

```bash
agentify run "add tests for retry backoff"
```

### Use caveman mode for terse output

Use `--caveman` when you want lower output-token usage for a run or session. A bare flag uses `full`; pass a level for stricter compression.

```bash
agentify skill install caveman --provider codex --scope project
agentify run --provider codex --caveman=ultra "explain why checkout retries fail"
```

Example response style:

```text
Retry state resets each render. Hook local var lost. Move attempt count to ref or reducer. Add test around second retry.
```

Environment fallback works for scripts and CI:

```bash
AGENTIFY_CAVEMAN=full agentify run "summarize stale index risk"
```

Caveman mode does not rewrite commit messages, PR descriptions, code blocks, or safety-sensitive confirmations.

### Run inside the interactive provider CLI

```bash
agentify run --provider codex "fix auth bug in Codex TUI"
agentify run --provider claude "fix auth bug in Claude CLI"
```

Template runs are interactive by default across providers.
`--interactive` is still accepted as an explicit override.

### Use sessions for longer work

Use `sess` whenever the work is likely to span multiple prompts, multiple days, or multiple people. Sessions are the default path for durable memory.

```bash
agentify sess run --provider codex --name "payments-v2" "implement initial module"
agentify sess resume --session <session-id> "continue from the last checkpoint"
agentify sess fork --from <session-id> --name "payments-alt" "try an alternate design"
agentify sess list
agentify handoff --session <session-id> "handoff to the next agent"
```

Each session writes durable artifacts under `.agents/session/<id>/`:

- `bootstrap.md` with the starting context given to the provider
- `context.json` and `checklist.json` with selected repo context and tasks
- `memory-context.md` with recalled prior session memory
- `transcript.md`, `turns.jsonl`, and `launches.jsonl` when capture is available
- `handoff.md` and `handoff.json` after `agentify handoff`

`agentify handoff` writes ranked context, touched symbols, recommended tests, unresolved TODO/risk lines, and overlap hints from recent session handoffs. Use it before handing work to another developer or another agent.

### How session memory works day to day

Session memory is automatic when you use `agentify sess run`, `sess resume`, or `sess fork`.

- Without MemPalace, Agentify still uses local session artifacts and recent structured history.
- With MemPalace installed, Agentify can mine prior session transcripts and inject more relevant memory into future sessions.
- Normal `agentify run` can reuse existing session memory, but it does not create durable session history. Use `sess *` when future recall matters.

The normal memory-aware loop is:

```bash
agentify sess run --provider codex --name "feature-name" "start the task"
agentify sess resume --session <session-id> "continue after review feedback"
agentify handoff --session <session-id> "summarize state for the next developer"
```

### Launch opted-in issues in parallel

Use `issue-killer` when you want supervised parallel issue solving across Worktrunk worktrees. V1 supports GitHub only, requires either an opt-in label or explicit issue URLs, and opens interactive tmux panes for Codex or Claude.

Issue-killer launches Codex and Claude with provider permission checks bypassed inside each isolated issue worktree. The pane prompt explicitly allows task-related shell, git, gh, package-manager, test, commit, push, and draft PR commands without asking for additional approval.

```bash
agentify issue-killer --issue-provider github --label agentify-ready --agent-provider codex --limit 5
agentify issue-killer --issue-provider github --issue-url https://github.com/org/repo/issues/123,https://github.com/org/repo/issues/124 --agent-provider claude --limit 2
tmux attach -t gh-issue-killer
```

### Preview context before execution

```bash
agentify plan "add rate limiting to checkout"
```

### Search the repo index directly

```bash
agentify query search --term retry
agentify query owner --file src/payments/index.ts
agentify query deps --module <module-id>
agentify query def --symbol useAuth
agentify query refs --symbol useAuth
agentify query callers --symbol useAuth
agentify query impacts --file src/auth/useAuth.ts
```

## How To Get The Most Out Of Agentify + Codex

### 0. Run doctor and verify the capability tier

```bash
agentify doctor
```

Look for:

- missing required tier tools such as `rg` and `fd`
- whether `ast-grep` and `tree-sitter` are available
- whether MemPalace is detected as an optional accelerator
- whether semantic TS/JS projects have already been indexed

### 1. Install hooks

```bash
agentify hooks install
```

This adds:

- a `pre-commit` hook that runs `agentify check --hook`. In `--hook` mode the
  validator still checks freshness, unsafe changed paths, and unsafe generated
  artifacts under `.agents/` and `docs/`, but it does not flag intentional
  source-file edits in the working tree, so ordinary commits are not blocked.
- a `post-merge` hook that refreshes the scan and deterministic local docs

### 2. Optionally install project-local skills for Codex

Agentify does not install skills during `doctor`, `init`, `this`, `up`, `run`, or `sess`. Skill installation is intentionally explicit because it writes provider-specific agent instructions into the repo or user scope.

```bash
agentify skill install all --provider codex --scope project
```

This installs all built-in skills in one shot. Use it only when the team has decided the repo should carry the full built-in skill set.

```bash
agentify skill install worktree-autopilot --provider codex --scope project
agentify skill install grill-me --provider codex --scope project
agentify skill install issue-killer --provider codex --scope project
```

Use project scope when you want the repo to carry its own agent behavior under `.codex/skills/`. Use user scope when the behavior should stay local to one developer machine.

### 3. Keep guardrails repo-specific

Edit `.guardrails` to add rules that matter in your codebase:

- forbidden deploy commands
- protected directories
- branch rules
- migration and rollback rules
- testing expectations

### 4. Use local refreshes when you do not need model-backed docs

If you want a cheap deterministic maintenance refresh without changing the repo's sticky execution provider, run:

```bash
agentify up --provider local
```

`up` is not a sticky-provider command, so this does not switch the repo away from Codex.

### 5. Enable semantic indexing

For TS/JS, Python, Go, Java, and .NET repos that need richer planner and query context, turn this on in `.agentify.yaml`:

```yaml
provider: codex
semantic:
  enabled: true
  tsjs:
    enabled: true
    workerConcurrency: 2
```

This improves semantic surfaces, deterministic headers, and repo-map quality. The TS/JS adapter uses the compiler-backed worker; Python, Go, Java, and .NET adapters store normalized project, symbol, surface, and edge facts.

After enabling it:

```bash
agentify semantic refresh
agentify up
agentify check
```

Use `agentify doctor` afterward to confirm semantic projects are being reported.
Use `agentify doctor --semantic --json --fail-on-stale` in CI when stale fingerprints, parse failures, analysis failures, or partial semantic coverage should fail the job.

### 6. Enable MemPalace-backed session-memory acceleration

MemPalace is optional, but it is the most useful add-on when you use `sess *` frequently.

How to install (Python 3.9+ required):

- `pipx install mempalace` is the recommended path. Plain `pip install mempalace` works too, but pulls ChromaDB and a ~300 MB embedding model on first index — prefer a virtualenv if you do not use `pipx`.
- Keep the resolved `mempalace` binary on `PATH`, or set `AGENTIFY_MEMPALACE_CMD` to its absolute path (useful when installed in a project-local venv).
- You do **not** need to run `mempalace init` yourself. Agentify lazily creates the per-repo palace under `.agents/mempalace/palace/` on the first `mine` call.
- Run `agentify doctor` and confirm MemPalace is detected.
- Prefer `agentify sess run`, `sess resume`, and `sess fork` for multi-step work so Agentify has durable session transcripts to mine.

Setup reference: <https://mempalaceofficial.com/guide/getting-started>.

> [!NOTE]
> Agentify binds the per-repo palace by setting `MEMPALACE_PALACE_PATH` when invoking `mempalace`. That env var is honored by `mempalace/config.py` but is not documented in `mempalace --help`; do not strip it as "dead" in future refactors of `src/core/session-memory.js`.

Important:

- normal `run` can reuse existing session history, but `run` does not create durable session history
- `sess *` is the right workflow when you want future recall and continuity

### 7. Tune budgets for large repos

If the codebase is large, tune `.agentify.yaml` instead of letting context sprawl:

```yaml
provider: codex
maxFilesPerModule: 20
planner:
  maxModules: 6
  maxFiles: 12
budgets:
  repo: 128000
  perModule: 32000
  perFile: 8000
```

## Recommended First-Time Command Sequence

If you want the shortest exact sequence for a fresh repo on macOS:

```bash
git clone https://github.com/ixigo/agentify.git
cd /path/to/agentify
pnpm install
pnpm link --global
cd /path/to/your/repo
agentify doctor
agentify this --provider codex
codex login            # only if bootstrap reports login_required
agentify doctor
agentify up
agentify check
agentify hooks install
# optional, intentional:
# agentify skill install all --provider codex --scope project
```

If you want the shortest exact sequence for a fresh repo without bootstrap:

```bash
git clone https://github.com/ixigo/agentify.git
cd /path/to/agentify
pnpm install
pnpm link --global
pnpm add --global @openai/codex tree-sitter-cli
codex login
cd /path/to/your/repo
agentify doctor
agentify init --provider codex
agentify up
agentify check
agentify hooks install
# optional, intentional:
# agentify skill install all --provider codex --scope project
```

## Common Pitfalls

- `agentify this` is macOS-only.
- The bootstrap flow requires Homebrew.
- The target path must be inside a Git repository.
- `init --provider codex` only sets the provider when `.agentify.yaml` does not already exist.
- Sticky provider updates happen on `run`, `exec`, `sess run`, `sess resume`, and `sess fork`.
- `local` is valid for `scan`, `doc`, `up`, and `check`, but not for `run` or `sess *`.
- Skills are never installed by default; `agentify skill install ...` is an intentional opt-in step.
- MemPalace is optional acceleration, not a hard requirement.
- `run` is lightweight; use `sess *` when you want durable memory artifacts under `.agents/session/`.

If those points are handled, the repository is ready for normal Agentify + Codex use.
