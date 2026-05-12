# Agentify Usage

This is the short, everyday guide. The default path is macOS bootstrap. If you are not on macOS, use the collapsed manual setup section.

`agentify doctor` is the first command to run in any repo. It checks whether the local machine has the tools Agentify and AI coding workflows need. On macOS, `agentify this --provider codex` can install missing bootstrap tools after `doctor` shows what is missing. On other platforms, install the missing tools manually and rerun `doctor`.

## Quick Start

### macOS

```bash
git clone https://github.com/ixigo/agentify.git
cd agentify
pnpm install
pnpm link --global

cd /path/to/your/repo
agentify doctor
agentify this --provider codex
codex login            # only if bootstrap reports login_required
agentify doctor
agentify up
agentify check
```

That is enough for a normal repo. `agentify this` initializes the repo, writes baseline Agentify files, installs missing macOS tool dependencies when needed, and checks provider auth.

Skills are not installed by default. If you want repo-scoped skills later, opt in explicitly:

```bash
agentify skill install all --provider codex --scope project
```

<details>
<summary>Manual setup for Linux, CI, or pre-provisioned machines</summary>

```bash
git clone https://github.com/ixigo/agentify.git
cd agentify
pnpm install
pnpm link --global
pnpm add --global @openai/codex tree-sitter-cli

codex login

cd /path/to/your/repo
agentify doctor
agentify init --provider codex
agentify up
agentify check
```

Install these native tools with your OS package manager when `doctor` reports them missing:

- `rg`
- `fd`
- `ast-grep`
- `tree-sitter`

Optional:

- `mempalace` for stronger session-memory recall
- `rtk` for command-output compression; verify the correct binary with `rtk gain`

`doctor` also reports whether `pnpm` is available and whether external provider binaries (`codex`, `claude`, `gemini`, `opencode`) are installed. Provider binary presence is reported separately from provider auth readiness.

</details>

## Daily Commands

Start or refresh a repo:

```bash
agentify doctor
agentify up --provider local
agentify check
```

Run a small task:

```bash
agentify run
agentify run "fix the checkout retry bug"
agentify run --with-context "fix the checkout retry bug"
agentify run --rtk "fix the checkout retry bug with noisy test output"
```

The default interactive `run` starts a fresh provider task with a small prompt. Run `agentify run` without a task to open the provider with Agentify context and let the provider ask what to do next, or pass the task directly as `agentify run "task"`. Add `--resume` or `--continue` only when you want to resume the provider's most recent session, and use `--with-context` when you want Agentify to inject selected files, related tests, prior memory, and execution rules into the first provider prompt.

Add `--rtk` when RTK is installed and command output is likely to be large. Agentify verifies RTK with `rtk gain`, adds compact provider guidance for `run`/`sess run`, and wraps Agentify-owned project tests for `up --rtk`; it does not change global Codex or RTK config.

Use a session for work that will continue later:

```bash
agentify sess run --provider codex --name "checkout-retries"
agentify sess run --provider codex --name "checkout-retries" "implement retries and tests"
agentify sess resume --session <session-id> "continue from review feedback"
agentify handoff --session <session-id> "summarize current state"
```

Use AFK when planning should happen in one interactive provider session and implementation should start later in a fresh worktree:

```bash
agentify afk create --provider codex "add checkout retries"
agentify afk run .agentify/planned/checkout-retries.md
agentify clean --planned --sessions
```

`afk create` writes a validated plan under `.agentify/planned/`. `afk run` starts fresh by default, creates an isolated branch/worktree, runs detected tests, and commits only after verification passes. Use `--current-worktree` only when you intentionally want to run in the current checkout, `--no-commit` when you want to review unstaged changes yourself, and `--cleanup delete` when the plan should be removed after a successful run.

Before a PR or handoff:

```bash
agentify check
agentify risk --since origin/main
```

Optional shell aliases for shorter daily use:

```bash
# ~/.zshrc or ~/.bashrc
alias ag='agentify'
alias agd='agentify doctor'
alias agu='agentify up'
alias agul='agentify up --provider local'
alias agc='agentify check'
alias agr='agentify run'
alias ags='agentify sess'
alias agsr='agentify sess run'
alias agsl='agentify sess list'
alias agsh='agentify handoff'
```

Then reload your shell:

```bash
source ~/.zshrc
```

Optional shell completion for command, flag, provider, skill, session, and path suggestions:

```bash
# zsh, current shell only
source <(agentify completion zsh)

# bash, current shell only
source <(agentify completion bash)

# fish, current shell only
agentify completion fish | source
```

For persistent zsh completion, save the printed script as `_agentify` in a directory on `fpath`:

```bash
mkdir -p ~/.zsh/completions
agentify completion zsh > ~/.zsh/completions/_agentify
```

Then add this before `compinit` in `~/.zshrc` if that directory is not already on `fpath`:

```bash
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit && compinit
```

For persistent fish completion:

```bash
mkdir -p ~/.config/fish/completions
agentify completion fish > ~/.config/fish/completions/agentify.fish
```

`agentify completion <zsh|bash|fish>` only prints a completion script. It does not edit `~/.zshrc`, `~/.bashrc`, fish config, or completion directories for you. Dynamic values are read from the current repo, so providers and installed skills appear when configured, sessions appear after Agentify session state exists, and path suggestions follow the shell's current working directory.

## What To Use When

| Need | Command |
| --- | --- |
| Check machine/repo readiness | `agentify doctor` |
| First-time macOS bootstrap | `agentify this --provider codex` |
| First-time manual setup | `agentify init --provider codex` |
| Refresh repo context and run tests | `agentify up` |
| Cheap deterministic refresh | `agentify up --provider local` |
| Validate generated state | `agentify check` |
| Validate after intentional source edits | `agentify check --hook` |
| Open provider with context | `agentify run` |
| Continue previous provider conversation | `agentify run --resume` |
| One-off provider task | `agentify run "task"` |
| One-off task with injected context | `agentify run --with-context "task"` |
| Plan now and execute later in a fresh worktree | `agentify afk create "task"` then `agentify afk run .agentify/planned/<slug>.md` |
| Durable multi-step work | `agentify sess run ...` |
| Continue durable work | `agentify sess resume --session <id> ...` |
| Handoff work | `agentify handoff --session <id> ...` |
| Find indexed repo context | `agentify query search --term <term>` |
| Preview selected context | `agentify plan "task"` |
| Install optional skills | `agentify skill install <name|all> --provider codex --scope project` |

## Optional Details

<details>
<summary>What doctor checks</summary>

`agentify doctor` is read-only. It does not initialize a repo and does not change generated artifacts.

It reports:

- local capability tier
- `pnpm` package-manager readiness
- required tools such as `rg` and `fd`
- richer analysis tools such as `ast-grep` and `tree-sitter`
- provider binaries such as `codex`, with auth status reported separately
- optional memory tooling such as `mempalace`
- semantic indexing status when enabled

Use this after switching machines, changing Node/provider installs, pulling a large repo setup change, or before debugging any Agentify behavior.

</details>

<details>
<summary>What init and this create</summary>

`agentify init --provider codex` creates the repo baseline:

- `.agentify.yaml`
- `.agentignore`
- `.guardrails`
- `.agentify/`
- `.agentify/runs/`
- managed Agentify block in `.gitignore`

`agentify this --provider codex` does the same setup and, on macOS, also checks Homebrew and installs missing bootstrap tools when you confirm.

Neither command installs skills. They only print the opt-in skill install command.

</details>

<details>
<summary>What up creates</summary>

`agentify up` runs the maintenance pipeline:

- `scan`
- `doc`
- `check`
- repo tests when Agentify detects a runnable test command

Generated outputs include:

- `.agentify/index.db`
- `docs/repo-map.md`
- root `AGENTIFY.md`
- module-root `AGENTIFY.md` files
- `.agentify/runs/*.json`
- `agentify-report.html`

Use `agentify up --provider local` when you want a cheap deterministic refresh without spending provider tokens or changing the sticky provider.

</details>

<details>
<summary>Sessions and memory</summary>

Use `sess` when work should survive across prompts, days, or people.

```bash
agentify sess run --provider codex --name "payments-v2" "start implementation"
agentify sess list
agentify sess resume --session <session-id> "continue"
agentify sess fork --from <session-id> --name "payments-alt" "try another approach"
agentify handoff --session <session-id> "handoff to the next developer"
```

Session artifacts live under `.agentify/session/<id>/`:

- `bootstrap.md`
- `context.json`
- `checklist.json`
- `memory-context.md`
- `transcript.md`
- `turns.jsonl`
- `launches.jsonl`
- `handoff.md`
- `handoff.json`

Memory is automatic for sessions. Without MemPalace, Agentify uses local session artifacts and recent structured history. With MemPalace installed, it can mine prior transcripts and inject more relevant memory into later sessions.

Install MemPalace only if you want this acceleration:

```bash
pipx install mempalace
agentify doctor
```

</details>

<details>
<summary>Skills are opt-in</summary>

Agentify does not install skills during:

- `doctor`
- `init`
- `this`
- `up`
- `run`
- `sess`

Install skills only when the repo or user intentionally wants provider-specific behavior.

Project scope writes repo-local provider instructions, for example `.codex/skills/`:

```bash
agentify skill install all --provider codex --scope project
agentify skill install gh-autopilot --provider codex --scope project
agentify skill install glab-autopilot --provider codex --scope project
agentify skill install gitlab-triage --provider codex --scope project
agentify skill install ado-autopilot --provider codex --scope project
agentify skill install azure-devops-triage --provider codex --scope project
```

Azure DevOps skills require `az`, the `azure-devops` extension, a valid `az account show`, and configured organization/project defaults from `az devops configure --list`.

User scope keeps the install local to one developer machine:

```bash
agentify skill install caveman --provider codex --scope user
```

GitLab skills require `glab` in the target repository. Verify these before
using `glab-autopilot` or `gitlab-triage`:

```bash
command -v glab
glab auth status
glab repo view
```

Example GitLab requests after installing the skill:

```text
Use $glab-autopilot to resolve GitLab issue #42 and prepare a draft MR.
Use $glab-autopilot to inspect MR !7 and summarize review comments.
```

</details>

<details>
<summary>Hooks</summary>

Hooks are optional but useful after the repo is initialized:

```bash
agentify hooks install
```

This installs:

- `pre-commit`: runs `agentify check --hook`
- `post-merge`: refreshes scan and deterministic local docs

Plain `agentify check` is strict and reports tracked source body edits. Hook-friendly validation skips that source body diff because developers and agents may have intentionally changed code, while still checking generated state and unsafe paths.

Remove them with:

```bash
agentify hooks remove
```

</details>

<details>
<summary>Semantic indexing</summary>

Enable this only for repos that need richer symbol and surface context.

```yaml
provider: codex
semantic:
  enabled: true
  tsjs:
    enabled: true
    workerConcurrency: 2
```

Then run:

```bash
agentify semantic refresh
agentify up
agentify doctor --semantic
```

In CI, use:

```bash
agentify doctor --semantic --json --fail-on-stale
```

</details>

<details>
<summary>Useful query and planning commands</summary>

```bash
agentify plan "add rate limiting to checkout"
agentify query search --term retry
agentify query owner --file src/payments/index.ts
agentify query deps --module <module-id>
agentify query def --symbol useAuth
agentify query refs --symbol useAuth
agentify query callers --symbol useAuth
agentify query impacts --file src/auth/useAuth.ts
```

</details>

## Common Pitfalls

- `agentify this` is macOS-only.
- `agentify this` requires Homebrew on macOS.
- The target path must be inside a Git repository.
- `agentify doctor` checks readiness; it does not initialize the repo.
- `agentify init` does not install provider tools.
- Skills are never installed by default.
- `local` is valid for `scan`, `doc`, `up`, and `check`, but not for `run` or `sess`.
- Use `sess` instead of `run` when you want durable memory and handoff artifacts.
