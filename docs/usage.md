# Agentify Usage

Agentify is installed once per repo (or once globally) and is then driven by your coding agent. This guide covers the human-facing setup and the small set of commands you might run yourself.

## Install

Agentify is installed straight from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/ixigo/agentify/main/install.sh | bash
```

The installer checks Node.js 20+ and git, runs `npm install -g` against the GitHub repo, and verifies the CLI. Equivalent manual command: `npm install -g github:ixigo/agentify`. Pin a ref with `AGENTIFY_REF=<branch|tag|sha>`.

Then wire up your repo:

```bash
cd /path/to/your/repo
agentify install
```

`agentify install` does four things:

1. Appends a managed guidance block to `CLAUDE.md` (created if missing) teaching the agent to use `agentify ctx`, `query`, and `risk`.
2. Adds Claude Code hooks to `.claude/settings.json`:
   - `SessionStart` runs `agentify ctx load --hook` and injects a context pointer (or digest) into the new session.
   - `UserPromptSubmit` runs `agentify ctx match --hook` to inject only context related to each prompt.
   - `PreToolUse` (Bash) runs `agentify ctx precheck --hook` to warn before repeating a previously-failed command.
   - `PostToolUse` (file edits and Bash) runs `agentify ctx track --hook` to record activity and command failures.
   - `PostToolUse` (`ExitPlanMode`) runs `.claude/hooks/plan-to-html.mjs` to save approved plans as standalone files under `plans/`.
   - `SessionEnd` records the session close and triggers the background session summary.
3. Writes baseline repo files: `.agentify.yaml` (config), `.agentignore`, `.guardrails`, and the `.agentify/` runtime directory (gitignored).
4. Prints next steps.

`agentify install --global` skips the repo files and instead writes the managed block and hooks into `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, and `~/.claude/hooks/plan-to-html.mjs`, so every repo you work in gets context tracking and plan rendering.

### Codex

```bash
agentify install --provider codex            # project: writes the block into AGENTS.md
agentify install --provider codex --global   # global: ~/.codex/AGENTS.md
agentify install --provider all              # Claude Code + Codex together
```

Codex has no lifecycle hooks, so the `AGENTS.md` block instructs Codex to run `agentify ctx load` at session start, record decisions with `agentify ctx note`, and write `agentify ctx handoff` before ending long tasks. Tracking is guidance-driven rather than automatic, but the context store and every command are shared between agents — notes left by a Claude Code session show up in the next Codex session and vice versa.

Re-running install is safe: the managed block is replaced in place and hooks are deduplicated. `agentify uninstall [--global]` removes exactly what install added and nothing else.

## Daily use

You generally do not need to run anything — the agent does. Useful commands when you do:

```bash
agentify status                  # is the integration installed? how much context is tracked?
agentify ctx load                # see what the agent sees at session start
agentify ctx note "gotcha: ..."  # leave a note for the agent's next session
agentify ctx decision "chose X over Y because Z"   # record a durable decision
agentify ctx handoff "task"      # write a handoff summary markdown
agentify test --run              # run only the tests your current change affects
agentify stats                   # what the delegate traffic cost this month
```

## Context tracking

Events live in `.agentify/context/events.jsonl`, notes in `.agentify/context/notes.jsonl`, handoffs under `.agentify/context/handoffs/`. Events are compact single-line JSON records:

```json
{"ts":"2026-07-07T07:37:01Z","sid":"abc12345","type":"edit","path":"src/a.js"}
{"ts":"2026-07-07T07:37:04Z","sid":"abc12345","type":"cmd","cmd":"npm test","desc":"Run tests"}
```

The event log auto-compacts: past ~512 KB it is truncated to the most recent 1000 events. Command text is clipped to 200 characters and never includes command output. Hook-invoked commands (`--hook`) are designed to never fail and never block the agent.

## Failure memory

**Why:** agents rediscover the same dead ends. A command that failed three sessions ago gets retried verbatim, fails the same way, and burns the same tokens.

**What happens:** command results are tracked, not just commands. A Bash tool call that exits non-zero is recorded with its exit code and an error snippet. Two things then use that record:

1. The digest and per-task matches get a *"Commands that failed and were not retried successfully"* section — only commands whose **most recent** run failed; one later success clears the failure.
2. A `PreToolUse` hook (`agentify ctx precheck --hook`, installed by `agentify install`) fires when the agent is about to run the *exact same command* that failed in a **previous** session, and injects a warning:

```text
Agentify: this exact command failed in a previous session (2026-07-07) (exit 1):
error: relation "orders" already exists. If the underlying cause was not fixed
since, try a different approach instead of retrying it as-is.
```

Warnings are deduplicated per session and never fire for failures the current session already saw (the agent was there). Check manually with `agentify ctx precheck "<command>"`.

**When to care:** you don't run anything — it's automatic once installed. It matters most for expensive commands (migrations, deploys, long test suites) where a doomed retry costs minutes.

## Session summaries

When a session ends, Agentify asks a fast model (the `quick` route) to compress it into a ~3-line handoff — "fixed the retry double-charge, root cause was a regenerated idempotency key, PR #232 open" — and stores it in `.agentify/context/summaries.jsonl`. Summaries appear in the digest ("What recent sessions did") and are matched per task like notes. This happens in a detached background process, so the SessionEnd hook returns instantly, sessions with fewer than 3 tracked events are skipped, and each session is summarized at most once. Disable with `context.sessionSummaries: false` in `.agentify.yaml`; run one manually with `agentify ctx summarize [--session <id>]`.

## Team-shared notes

By default all context is local to your checkout. `agentify ctx share` flips notes into committable team memory:

```bash
agentify ctx share        # .agentify/context/notes.jsonl becomes committable
git add .agentify/context/notes.jsonl && git commit -m "share agent notes"
agentify ctx share --off  # back to fully local
```

Once committed, every teammate's agent sees your notes in its digest and per-task matches — "don't regenerate idempotency keys per attempt" becomes shared knowledge instead of personal memory. Events, summaries, and handoffs always stay local; only `notes.jsonl` is shared, and re-running `agentify install` or `scan` preserves whichever mode is active.

## Stale-note flagging

**Why:** the biggest failure mode of persistent agent memory is the confidently-wrong stale note. "The vault code is in src/pay/vault-legacy.js" is helpful until that file moves — then it actively misleads.

**What happens:** whenever notes are injected (digest, per-task match, decisions list), any repo-relative file path mentioned in the note text is checked against the working tree. Paths that no longer exist get the note flagged in place:

```text
### Notes left for this session
- [2026-07-07] payment idempotency key logic lives in src/pay/retry.js — never regenerate per attempt
- [2026-07-07] legacy card vault code is in src/pay/vault-legacy.js, do not touch without
  compliance — STALE? references missing path(s): src/pay/vault-legacy.js; verify before trusting
```

The note isn't deleted — the knowledge may still be right, just relocated — but the agent is told to verify instead of trusting. `agentify ctx status` reports a `stale_note_count` so you can spot memory rot at a glance.

## Decision log

**Why:** "why did we choose X" gets relitigated every few weeks — by teammates and by agents, who will happily "improve" a settled trade-off they know nothing about.

**How:**

```bash
agentify ctx decision "chose idempotency keys stored client-side over server-side dedup \
  because the gateway retries before our server sees the request"

agentify ctx decisions                              # list all decisions
agentify ctx decisions "why client side idempotency keys"   # ranked query
```

```text
Decisions matching "why client side idempotency keys":
- [2026-07-07] chose idempotency keys stored client-side over server-side dedup
  because the gateway retries before our server sees the request
```

Decisions are notes with `type: decision` (`ctx note --type decision` is equivalent): they live in the same `notes.jsonl`, get their own *"Decisions on record"* digest section, match per-task like any note, and are staleness-checked. Combined with `agentify ctx share`, the committed notes file doubles as a lightweight, queryable team ADR log — no separate docs/adr directory to maintain.

**When to record one:** any time the agent (or you) makes a choice a future session could plausibly reverse without context — library picks, storage formats, API shapes, deliberately-rejected alternatives. The managed guidance block teaches the agent to do this on its own.

## Context injection modes

By default (`context.injection: relevant` in `.agentify.yaml`) context arrives only when it matters: the session starts with a one-line pointer, and each prompt you type is matched against the store — only related notes, session summaries, files, and past failures are injected, deduplicated per session, via the `UserPromptSubmit` hook. Asking about "payment retries" pulls the retry notes; a CSS question pulls nothing.

Matching is BM25-ranked over the whole context corpus with light plural stemming: a prompt about "payment **retries**" matches a note about the "**retry**" module, and rare distinctive terms outrank words that appear in every note — so long notes can't win by volume and boilerplate terms don't cause false matches.

```yaml
context:
  injection: relevant   # match context to each task (default)
  # injection: digest   # inject the full digest at every session start
  # injection: off      # never inject (tracking continues; use ctx load manually)
```

`agentify ctx match "<task>"` previews what a given prompt would pull in. `agentify ctx load` always shows the full digest regardless of mode.

## Continuing vs starting from scratch

Continuing is the default: every new session gets the digest injected and keeps accruing events. When you want a clean slate instead:

```bash
# one-off clean session — no digest, no tracking, nothing persisted
AGENTIFY_CTX=off claude

# switch tracking off until further notice (marker file in .agentify/context/)
agentify ctx pause
agentify ctx resume

# archive the store and start over (moved to .agentify/context/archive/<timestamp>/)
agentify ctx clear
agentify ctx clear --archive=false   # hard delete instead of archiving
```

- **Pause** stops both the session-start digest and event tracking, so scratch work doesn't pollute the history. `agentify ctx status` shows the paused state.
- **Clear** archives `events.jsonl` and `notes.jsonl` before resetting, so nothing is lost — restore by moving the files back.
- **Mid-conversation**, just tell the agent "ignore the previous context" — the managed guidance block instructs it to disregard the digest on request (and to offer `ctx pause` when you want tracking off too).

## Structural index (optional but recommended)

```bash
agentify scan     # build/refresh .agentify/index.db and docs/repo-map.md
agentify check    # verify the index matches HEAD
agentify up       # scan + check in one step
```

The index powers:

```bash
agentify query search --term checkout
agentify query def --symbol buildReport
agentify query refs --symbol buildReport
agentify query impacts --file src/pay/retry.ts
agentify query owner --file src/pay/retry.ts
agentify query deps --module payments
agentify query changed --since origin/main
agentify risk --since origin/main
```

All support `--json`. The CLAUDE.md block teaches the agent to run `agentify scan` itself when the index is stale.

## Impact-aware test selection

**Why:** agents run the full suite after every change because they can't tell which tests matter. On a suite that takes minutes, that's the slowest part of the loop.

**How:**

```bash
agentify test                        # select tests affected by working-tree changes
agentify test --since origin/main    # ...or by everything since a ref
agentify test --run                  # select and run them
```

`agentify test` walks the import graph in the structural index from your changed files and picks only the test files that (a) changed themselves, (b) import changed code directly or transitively, or (c) are recorded as covering a changed file. Verified example — a repo with two test files where only `src/pay/retry.js` changed:

```text
Selected tests: 1 file(s) from 1 changed file(s)
- test/retry.test.js (imports changed code)
Run:
- node --test test/retry.test.js
```

`test/dash.test.js` is untouched and not run. Selected files are grouped under the module's indexed test runner; `node --test` scripts are invoked directly (appending file args to `npm run test` breaks when the script pins its own paths), while jest/vitest/mocha-style runners get the files appended as filters. `--run` exits non-zero if any selected test fails. When changes have no related tests at all, the output says so and falls back to recommending the full suite — silence is never treated as coverage.

**When to use:** the guidance block teaches the agent to run `agentify test --since <ref> --run` before finishing a change instead of the full suite. Requires `agentify scan` (the index).

## Delegation usage: agentify stats

**Why:** model routing only pays off if you can see it working. Stats make the delegate traffic — and what it costs — visible.

**How:** every `agentify delegate` run is logged locally (`.agentify/context/delegations.jsonl`) with duration, token usage, and cost. Claude delegations run with `--output-format json`, so token counts and `total_cost_usd` are the provider's real numbers; other CLIs get ~4 chars/token estimates, and estimated rows are labeled as such.

```bash
agentify stats            # last 30 days
agentify stats --days 7
```

Real output after one Haiku research delegation and one Codex review in a demo repo:

```text
Agentify stats — last 30 day(s)

Sessions:
- 1 session(s), 0 edit(s), 1 command(s) (1 failed), 4 note(s)

Delegations:
- total: 2 run(s), 50.1k in / 530 out, cost $0.0212 (1/2 reported)

By kind:
- research: 1 run(s), 49.9k in / 301 out, cost $0.0212
- review: 1 run(s), 199 in / 229 out, cost n/a

By model:
- claude/haiku: 1 run(s), 49.9k in / 301 out, cost $0.0212
- codex: 1 run(s), 199 in / 229 out, cost n/a

Note: token counts for 1 run(s) are estimates (~4 chars/token); the provider
CLI reported no usage.
```

Failures and cross-vendor fallbacks are counted per bucket, so a route whose CLI keeps falling back stands out.

## Model routing

Install writes a `models.routes` table into `.agentify.yaml` mapping kinds of work to models. The agent (or you) can shell tasks out:

```bash
agentify models                                       # routing table + which CLIs are installed
agentify delegate quick "fix the typo in README"      # small work → fast, cheap model
agentify delegate quick "rename X to Y" --write       # allow the delegated model to edit files
agentify delegate review --diff origin/main           # post-change review by the other vendor
agentify delegate heavy "design the retry strategy"
agentify delegate research "summarize how auth works here"
```

Defaults: `quick`/`research` → Claude Haiku, `implement` → Claude Sonnet, `heavy` → Claude Opus, `review` → Codex (its CLI default model). If a route's CLI is missing, Agentify falls back to the other vendor. Delegations are non-interactive and read-only unless `--write` is passed (`claude -p --permission-mode acceptEdits` / `codex exec --full-auto`). Override routes:

```yaml
models:
  routes:
    review:
      provider: codex
      model: null          # null = the codex CLI's configured default
    quick:
      provider: claude
      model: haiku
```

## Platform workflows

`agentify workflow install` sets up a board-to-draft-PR workflow for your platform, delivered as a skill bundle the agent drives:

```bash
agentify workflow list               # bundles + CLI availability, detects your platform
agentify workflow install            # auto-detects gh / glab / azure from the git remote
agentify workflow install glab --provider claude --scope project
```

The flow on every platform: **triage** the board with an opt-in label (`agentify-ready`), **pick up** an item (the autopilot skill resolves full context with `gh`/`glab`/`az`), **implement in isolation** (`worktree-autopilot` creates a fresh branch + git worktree, verifies with the repo's tests, commits), and **raise a draft PR/MR** (`pr-creator`; the Azure bundle adds `pr-convention-learner`, which checks reviewer conventions learned from past PRs).

### Do I have to invoke the workflow?

No. The bundle installs as agent skills (`.claude/skills/` for Claude Code, `.codex/skills/` for Codex), and skills are matched to your request automatically — each skill declares when it applies (triage requests, issue/PR URLs, "pick up work", parallel fan-out). You talk to the agent normally; it picks the right skill. The only command a human ever runs is the one-time `agentify workflow install`.

### A day with the workflow (GitHub example)

```text
9:05  you:   "triage the new issues"
      agent: → github-triage: classifies each issue, applies the label state
              machine, marks two small ones agentify-ready

9:20  you:   "pick up issue 231"
      agent: → gh-autopilot reads the issue + comments with gh
             → worktree-autopilot: branch issue/231-retry-bug in a fresh
               worktree, implements, runs the repo tests, commits
             → agentify delegate review --diff origin/main  (Codex gives an
               independent second opinion before the PR)
             → pr-creator opens a draft PR
             → agentify ctx note "231: retry bug was a stale idempotency key;
               fix in src/pay/retry.ts, PR #232 draft"

10:15 you:   "we should rate-limit the webhook endpoint — file an issue"
      agent: → grill-me interviews you one question at a time (each with a
              recommended answer) until scope and acceptance criteria are
              concrete, then files it with gh issue create and labels it

11:40 you:   "kill everything labeled agentify-ready"
      agent: → issue-killer: one tmux pane + one worktree per issue, each
               running its own agent toward a draft PR
      you:   tmux attach -t issue-killer   # watch them work

next morning, new session:
      SessionStart hook injects the digest — yesterday's notes, the in-flight
      fan-out, hot files — so you can just say "continue with the review
      feedback on #232".
```

The same day works verbatim on GitLab ("triage the new issues" → gitlab-triage, draft MRs) and Azure DevOps ("pick up work item 4512" → ado-autopilot over `az boards`).

### Worktrees and parallel issue-solving

- One task → `worktree-autopilot`: isolated worktree, verified change, merge-back commands returned to you.
- Many opted-in issues → `issue-killer`: one tmux pane + one worktree per issue, each running an interactive agent that ends in a draft PR. Supervise with `tmux attach -t issue-killer`.
- Context is per-checkout: each worktree has its own `.agentify/` store, so tracking never bleeds between parallel tasks. The fan-out itself is recorded with `agentify ctx note` so the next session knows what's in flight.
- Guardrails: issues are only picked up via opt-in labels or explicit URLs, PRs stay drafts, and nothing force-pushes or merges without an explicit ask.

## Git hooks (optional)

```bash
agentify hooks install   # pre-commit: agentify check --hook; post-merge: agentify scan
agentify hooks status
agentify hooks remove
```

### Cross-vendor review on push (opt-in)

**Why:** the model that wrote the code reviews it with the same blind spots. A different vendor's model catches different things — and the cheapest moment to catch them is before the push, not in PR review.

**How:** set `hooks.prePush: true` in `.agentify.yaml`, then `agentify hooks install`. From then on every `git push` runs `agentify review --push`: the outgoing commits are diffed against upstream and sent to the `review` route (Codex by default, i.e. not the vendor that wrote them). Real Codex output for a commit that added `ts: Date.now()` to a payment-retry payload:

```text
cross-vendor review by codex — diff since origin/main

**Findings**
- Medium: src/pay/retry.js now adds `ts: Date.now()` to the retry return value.
  This makes retryPayment(2, "k1") non-deterministic and changes the public
  shape from { attempt, key } to { attempt, key, ts }. For payment
  retry/idempotency code, that is risky: callers that serialize, compare,
  dedupe, cache, or sign the retry payload can now see different values for
  the same attempt/key.
```

The review is **advisory**: it prints findings and the push proceeds regardless (`|| true` in the hook), stays silent when there is no upstream or nothing to review, and can be run manually any time with `agentify review --diff <ref>`. It's opt-in because a model review at push time costs real seconds and tokens — enable it on repos where a second opinion is worth that.

## Skills (optional)

Agentify bundles a catalog of agent skills (TDD, PR workflows, triage, and more):

```bash
agentify skill list
agentify skill install grill-me --provider claude --scope project
agentify skill install all --provider claude --scope project
```

## Housekeeping

```bash
agentify doctor            # toolchain + provider CLI readiness
agentify clean --dry-run   # preview pruning of stale run artifacts
agentify clean --all       # prune legacy planned/session artifacts too
```

## Shell completion

```bash
# zsh
source <(agentify completion zsh)
# bash
source <(agentify completion bash)
# fish
agentify completion fish | source
```

## Configuration

`.agentify.yaml` is created on install with defaults; the interesting knobs:

```yaml
strict: true          # check fails closed
languages: auto       # scanner language selection
moduleStrategy: auto  # module clustering strategy
hooks:
  preCommit: true     # managed git hooks (agentify hooks install)
  postMerge: true
  prePush: false      # opt-in: cross-vendor review of outgoing commits
cleanup:
  keepRuns: 20
  maxRunAgeDays: 14
```

## Other agents: MCP server

Automatic hook tracking targets Claude Code; Codex is supported through `AGENTS.md` guidance (`--provider codex`). For everything else — Cursor, Zed, Windsurf, Claude Desktop, Gemini CLI, any MCP-capable client — Agentify speaks MCP:

```bash
agentify serve       # stdio MCP server; register it in your client
```

```bash
# Claude Code (as an alternative or complement to hooks)
claude mcp add agentify -- agentify serve
```

The server exposes six tools, all backed by the same store and index the hooks use: `ctx_load` (session digest), `ctx_note` (record a note or decision), `ctx_match` (context related to a described task), `query` (structural queries), `risk` (blast radius), `test_select` (impact-aware test selection). Tool descriptions teach the client when to call each, so an MCP-connected agent gets the whole workflow — load context at start, note decisions, select tests before finishing — without any hook support. No extra dependencies; the server is part of the CLI and holds no state between calls.

**When to use hooks vs MCP:** hooks are better in Claude Code (tracking is automatic and per-prompt injection is free); MCP is for clients without lifecycle hooks. Running both in Claude Code is fine — the note/query tools complement automatic tracking.

Any other agent can still use the plain CLI with `--json` output: `agentify ctx load`, `agentify ctx note`, `agentify query ...`, `agentify risk`. Add equivalent guidance to that agent's instruction file and, if it supports lifecycle hooks, wire `agentify ctx track --hook` the same way.
