# Agentify + Codex Usage

This is the exact operating guide for turning a Git repository into an Agentify-managed, Codex-ready codebase.

## What "Agent Ready" Means

A repository is ready when all of these are true:

- `codex --version` works.
- `codex login status` shows Codex is logged in.
- `.agentify.yaml` exists and the repo provider is `codex`.
- Baseline repo artifacts exist: `.agentignore`, `.guardrails`, `.agentify/work/`.
- Generated Agentify artifacts exist: `.agents/index.db`, `AGENTS.md`, `AGENTIFY.md`, `docs/repo-map.md`, and `docs/modules/*.md`.
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

Agentify's macOS bootstrap command installs missing versions of those tools automatically.

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

### 3. Bootstrap the repo for Codex

```bash
agentify doctor
agentify this --provider codex
```

What this does:

- Verifies the current path is inside a Git repository.
- Checks for Homebrew.
- Installs missing local tools when needed: `ripgrep`, `fd`, `ast-grep`, `tree-sitter-cli`.
- Installs Codex CLI when needed: `npm install -g @openai/codex`.
- Writes repo-local Agentify config and baseline artifacts.
- Checks whether Codex auth is ready.

### 4. If bootstrap says login is required, authenticate Codex

```bash
codex login
codex login status
```

### 5. Generate the index, docs, validation output, and run tests

```bash
agentify up
```

`agentify up` runs:

- `scan`
- `doc`
- `check`
- repo tests when a runnable test command is detected

### 6. Confirm the repo is ready

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

### 5. Initialize Agentify with Codex as the repo provider

For a fresh repo with no existing Agentify config:

```bash
agentify doctor
agentify init --provider codex
```

If the repo already has `.agentify.yaml`, make sure it contains:

```yaml
provider: codex
```

### 6. Generate repository artifacts

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
- `.agentignore`
- `.guardrails`
- `.agentify/work/`
- `.agents/`
- `.agents/runs/`
- `docs/modules/`

After `agentify scan`:

- `.agents/index.db`
- `AGENTS.md`
- `docs/repo-map.md`

After `agentify doc`:

- `AGENTIFY.md`
- `docs/modules/*.md`
- `.agents/runs/*.json`
- refreshed `@agentify` file headers when applicable

Most commands also write run evidence to:

- `output.txt`
- `agentify-report.html`

## How To Verify A Repo Is Really Ready

Run these checks:

```bash
agentify check
agentify plan "summarize the highest-risk area in this repo"
agentify query search --term auth
```

You should also confirm:

- `AGENTS.md` exists at the repo root.
- `AGENTIFY.md` exists at the repo root.
- `.agents/index.db` exists.
- `docs/repo-map.md` exists.
- `docs/modules/` contains module docs.

## Day-To-Day Codex Workflow

Use `agentify run` instead of calling `codex exec` directly when you want Agentify to keep the repo fresh.

### Run a normal task

```bash
agentify run --provider codex "implement payment retries"
```

After the first sticky Codex run, the repo keeps `codex` as its default provider, so later runs can omit `--provider`:

```bash
agentify run "add tests for retry backoff"
```

### Run inside the interactive provider CLI

```bash
agentify run --provider codex "fix auth bug in Codex TUI"
agentify run --provider claude "fix auth bug in Claude CLI"
```

Template runs are interactive by default across providers.
`--interactive` is still accepted as an explicit override.

### Use sessions for longer work

```bash
agentify sess run --provider codex --name "payments-v2" "implement initial module"
agentify sess resume --session <session-id> "continue from the last checkpoint"
agentify sess fork --from <session-id> --name "payments-alt" "try an alternate design"
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

- a `pre-commit` hook that runs `agentify check`
- a `post-merge` hook that refreshes the scan

### 2. Install project-local skills for Codex

```bash
agentify skill install all --provider codex --scope project
```

This installs all built-in skills in one shot and is the recommended baseline for advanced teams.

```bash
agentify skill install worktree-verifier --provider codex --scope project
agentify skill install grill-me --provider codex --scope project
```

Use project scope when you want the repo to carry its own agent behavior under `.codex/skills/`.

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

### 5. Enable semantic TS/JS indexing for TypeScript and JavaScript repos

For TS/JS-heavy repos, turn this on in `.agentify.yaml`:

```yaml
provider: codex
semantic:
  tsjs:
    enabled: true
    workerConcurrency: 2
```

This improves semantic surfaces, deterministic headers, and repo-map quality for TS/JS projects.

After enabling it:

```bash
agentify semantic refresh
agentify up
agentify check
```

Use `agentify doctor` afterward to confirm semantic projects are being reported.

### 6. Enable MemPalace-backed session-memory acceleration

MemPalace is optional, but it is the most useful add-on when you use `sess *` frequently.

How to turn it on:

- install `mempalace` and keep it on `PATH`, or set `AGENTIFY_MEMPALACE_CMD`
- run `agentify doctor` and confirm MemPalace is detected
- prefer `agentify sess run`, `sess resume`, and `sess fork` for multi-step work so Agentify has durable session transcripts to mine

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
agentify this --provider codex
codex login            # only if bootstrap reports login_required
agentify up
agentify check
agentify hooks install
agentify skill install worktree-verifier --provider codex --scope project
agentify skill install grill-me --provider codex --scope project
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
agentify init --provider codex
agentify up
agentify check
agentify hooks install
agentify skill install worktree-verifier --provider codex --scope project
agentify skill install grill-me --provider codex --scope project
```

## Common Pitfalls

- `agentify this` is macOS-only.
- The bootstrap flow requires Homebrew.
- The target path must be inside a Git repository.
- `init --provider codex` only sets the provider when `.agentify.yaml` does not already exist.
- Sticky provider updates happen on `run`, `exec`, `sess run`, `sess resume`, and `sess fork`.
- `local` is valid for `scan`, `doc`, `up`, and `check`, but not for `run` or `sess *`.
- MemPalace is optional acceleration, not a hard requirement.
- `run` is lightweight; use `sess *` when you want durable memory artifacts under `.agents/session/`.

If those points are handled, the repository is ready for normal Agentify + Codex use.
