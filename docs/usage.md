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
agentify ctx explain "task"      # dry-run: what would be injected for this task, and why
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

## Token-budgeted context injection

Per-task context (`relevant` mode) is selected under an explicit token budget, not just item caps. The BM25 matcher proposes candidates; a deterministic selector then picks the highest value-per-token set that fits, so a long marginal note can never crowd out the task itself. Selection is explainable end to end:

```bash
agentify ctx explain "fix the payment gateway retries"   # dry run: policy, budget, every include/skip reason
```

`ctx explain` costs nothing (no provider call), never marks items as seen, and shows the governing profile, the effective budget with its source and reason, and each candidate's score, age, estimated tokens, and decision (`within_budget`, `truncated_to_fit`, `over_budget`, `stale_refs`, `seen_this_session`, `below_min_score`, `exceeds_max_age`).

```yaml
context:
  injection: relevant       # relevant (default) | digest | off
  maxInjectedTokens: 1200   # explicit pin; omit (null) to let the policy resolve it
  minScore: null            # optional relevance gate on match candidates
  maxAgeDays: null          # optional recency gate
  reserve:
    decisions: 250          # budget slices held for safety-critical classes so
    failures: 250           # bulky low-value items cannot crowd them out
```

Rules the selector guarantees:

- The **full rendered block** (headers and footer included) never exceeds the budget beyond the documented tokenizer tolerance (~4 chars/token estimate; a render backstop enforces the estimate exactly).
- **Decisions and unresolved failures get reserved budget** but never bypass the hard total cap: an oversized decision/failure is truncated with provenance (`… [truncated from N chars]`); oversized items of other classes are skipped with a reason.
- Selection and rendering are **deterministic** — same state, same byte-identical block. Claude prompt caching is prefix-sensitive, so the stable Agentify instructions stay in the cacheable prefix (managed CLAUDE.md/settings blocks) while this bounded, task-varying block arrives as a per-prompt suffix via the `UserPromptSubmit` hook.
- **Zero matches emit nothing** — no context block, no ledger write, no telemetry event.
- Items skipped for budget are **not** marked as seen; they stay eligible for the next prompt.

With no explicit `maxInjectedTokens`, the documented default is **1200 tokens** — and the effective budget participates in the optimization profile (see `agentify models`): `cost` moves to the smallest evaluated budget that meets its quality floor, `balanced` to the best measured cost per pass, and `performance` to a larger budget only when ablation evidence shows a pass-rate gain. Evidence comes from local `agentify eval` runs with `context_ablations` (below); with insufficient evidence every profile keeps the default. `AGENTIFY_CTX_BUDGET` and `AGENTIFY_CTX_INJECTION` env vars override budget and mode per process (used by eval ablations).

Every injection records telemetry (`context_injection` value events): candidates, selected/skipped reasons, scores, ages, chars/tokens, suppression-as-seen, match latency, profile, and budget — surfaced by `agentify value` and eval reports.

### Measuring context ROI (eval ablations)

Add `context_ablations` to an eval task manifest to turn context configurations into measurable arms:

```yaml
arms: [agentify, plain-safe]
context_ablations: [relevant, digest, off, relevant@600]   # budget variants: relevant@<tokens>
```

The agentify arm expands into one arm per ablation (`agentify`, `agentify-ctx-digest`, `agentify-ctx-off`, `agentify-ctx-relevant-600`), each pinned via env overrides in that attempt only. Ablation arms pair against the default `agentify` arm in `agentify eval report`, which also aggregates per-arm context metrics (injections, items, tokens, truncations, over-budget skips, match latency) into `context_metrics`. Tune `maxInjectedTokens` defaults only from these results.

### Second harness: Harbor container benchmarks

A portable 8-task dataset under `evals/harbor/` runs the same paired question through [Harbor](https://www.harborframework.com) (Terminal-Bench 2.0) with container isolation and Harbor's plain `claude-code` agent as the baseline — catching anything that only looks like a win inside Agentify's own runner. Harbor stays out of the npm runtime:

```bash
agentify eval harbor validate            # schema + fixture answer-leak checks (CI, token-free)
agentify eval harbor plan --suite smoke  # hard spend ceiling + launch/import commands
evals/harbor/run-smoke.sh                # plan → confirm → harbor run → import, one command
agentify eval harbor import evals/harbor/jobs/<job>   # trials become native runs
```

Imported runs are labeled `harness: harbor` in `eval report` (with dataset/Harbor/job provenance), cannot be resumed, and refuse `eval compare` against native runs without `--force`. Full prerequisites, cost math, the profile-matrix suite, and cleanup live in `docs/harbor.md`.

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

When a session ends, Agentify compresses it into a short handoff — "Edited 3 file(s): src/pay/retry.ts (3x)… Ran 5 command(s), 1 failed… Open: `pnpm test` still failing" — and stores it in `.agentify/context/summaries.jsonl`. Summaries appear in the digest ("What recent sessions did") and are matched per task like notes. This happens in a detached background process, so the SessionEnd hook returns instantly; no-op sessions, sessions with fewer than 3 tracked events, duplicate sessions, and already-summarized sessions are skipped.

By default the summary is **extractive**: built deterministically from the tracked evidence (edited files, command outcomes, notes/decisions, unresolved failures) with zero model cost. An LLM-refined summary is an explicit, budgeted opt-in — it receives only the extractive summary (never the raw activity log), runs on the `quick` route under `context.summary.maxBudgetUsd`, and falls back to the extractive text on any failure:

```yaml
context:
  sessionSummaries: extractive   # extractive (default) | llm | off — legacy true/false still work
  summary:
    maxChars: 600
    llmMinEvents: 20             # llm mode only kicks in for sessions this large
    maxBudgetUsd: 0.03
```

Run one manually with `agentify ctx summarize [--session <id>]`; `agentify stats` shows summary counts, LLM spend, and how often summaries are later injected.

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

**How:** every `agentify delegate` run is logged locally (`.agentify/context/delegations.jsonl`) as a versioned `delegation-v2` record: fresh input, cache-read, cache-write, and output tokens kept separate; provider-reported cost (never fabricated); the requested alias vs the resolved model ID; latency phases; and the budget ceiling the run operated under. Prompts are stored only as a hash — no prompt text or command arguments land in telemetry. Claude delegations run with `--output-format json`, so token counts and `total_cost_usd` are the provider's real numbers; Codex runs with `--json` for its usage stream (its final answer comes via `--output-last-message`); anything unreported gets ~4 chars/token estimates, and estimated rows are labeled as such. Old `stats-v1` lines still count in totals and are marked as legacy aggregates.

The report includes P50/P95 latency, cache read/write/fresh ratios, daily cost trend, cost-reporting coverage, fallback reasons, budget-stopped runs, and a session-summary maintenance view (count, LLM spend, injection rate).

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

## Session history analysis: agentify analyze

**Why:** `stats` and `value` report Agentify-owned telemetry. `analyze` looks at the other side — the local Claude Code and Codex session history you already have — and shows usage, tool patterns, and concrete, evidence-backed places where Agentify capabilities would have helped. Plus exactly one roast, because the data earned it.

**How:** `agentify analyze` streams the JSONL session stores (`~/.claude/projects`, `~/.codex/sessions`) in metadata-only mode. It is consent-gated: the first thing it does is disclose the resolved roots, file counts, and bytes, and ask before scanning (pass `--yes` non-interactively, or `--dry-run` to preview without parsing any record bodies). Transcript bodies are never analyzed, retained, or uploaded; shell commands are classified in memory into pattern counts (grep storms, full-suite test runs, repeated failures matched by irreversible fingerprint) and the command text never appears in any output. No model is started and AI spend is $0.

```bash
agentify analyze --dry-run                  # what would be read, nothing parsed
agentify analyze                            # current repo, last 30 days, text brief
agentify analyze --days 7 --format html     # writes agentify-session-analysis.html
agentify analyze --scope global --yes       # across projects, names pseudonymized
agentify analyze --provider codex --json    # full auditable schema
agentify analyze --no-cache                 # re-parse everything, skip the cache
agentify analyze --source-root codex=./fixtures/codex --yes   # custom store; repeatable per provider
agentify analyze --content local-extractive --yes             # opt-in: classify prompt text in memory
agentify analyze --include-config --yes                       # opt-in: structural audit of global config
```

`--include-config` adds a structural audit of allowlisted global configuration: per-provider sizes and always-loaded token estimates of `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` (plus a cross-provider duplicated-line count), permission/hook/env **counts** from `settings.json`, a handful of allowlisted keys from `config.toml`, and the names of installed skills/agents/commands. Only identifier-like values (model names, approval policies) pass a safe-value gate — any custom string under an allowlisted key is shown as `(value withheld)`. Instruction text and env values are never reproduced; `auth.json`, credentials, caches, backups, and databases are never opened. Both the consent disclosure and `--dry-run` list the exact allowlisted sources, and the privacy receipt records what was read.

`--content local-extractive` is an explicit opt-in that sharpens work-type classification: prompt text is matched against deterministic keyword rules **in memory during the streaming parse** — only rule-match counts and a category label survive; the text itself is never persisted, cached, rendered, or uploaded, and no model is started. The consent disclosure names the mode, sessions classified this way carry `work_type_source: "content-hint"`, and the privacy receipt records that transcript bodies were analyzed in memory. Default remains `metadata-only`.

Repeated scans are incremental: normalized session metadata (never transcript or command content) is cached privately (mode 0600) under the Agentify store, keyed by file size, mtime, and parser version, so unchanged session files are not re-parsed. Cache hits and misses are reported under `coverage.cache` in JSON output; `--no-cache` re-parses everything. In a TTY, a single self-overwriting progress line on stderr shows per-provider files/bytes/sessions during the scan (JSON stdout stays valid); with `--no-progress` or a non-TTY stderr nothing is emitted at all.

The report also carries a **usage scorecard**: each session is classified by tool mix into a work type (`conversation`, `research`, `quick-fix`, `implementation`, `debugging`, or an honest `mixed`), matched against the weight class of the model that ran it, and scored 0–100 from token generation per turn, failure hygiene, cache efficiency, and search discipline. Sessions where a heavyweight model did featherweight work are flagged `overkill` — the report calls the matchup ("a gun at a fist fight") and lists them as delegation candidates for `agentify delegate quick|research`. The verdicts are labeled heuristics for orientation and entertainment: an overkill flag is a candidate, never proof a cheaper model would have succeeded. In the HTML report the per-session table is filterable by provider, work type, and matchup using CSS-only controls, so the page still contains no script tag at all.

The report contains headline totals (sessions, active time, token dimensions with cache split, tool calls), models observed, per-session rows with work type, matchup, score, and turns, structured file activity (observed reads only — opaque shell calls are counted, never mined for paths), and recommendation cards. Every recommendation states what was observed, why the alternative is better for that pattern, the exact command to run, its confidence, a verification step, and a caveat; rules that did not fire are listed with the reason. Cost is labeled `unavailable` because local stores carry no billed cost — token-derived guesses are deliberately not presented as spend. The HTML output is self-contained, Agentify-themed, and ends with a privacy receipt of exactly what was read.

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

### Budgets

Every route carries a hard per-run ceiling — dollars, agent turns, and wall-clock — so no Agentify-initiated paid run is ever unbounded. Claude delegations receive `--max-budget-usd`/`--max-turns` natively (plus `--no-session-persistence` for one-shot runs); providers without an in-flight dollar stop (Codex) are covered by the pre-run rolling check and the timeout — `agentify models` shows which limits each route can enforce natively. Cross-vendor fallback keeps the original ceiling; it never resets or raises the budget. Invalid budgets fail before any provider process starts.

```yaml
models:
  budget:
    dailyUsd: 5            # rolling caps over locally recorded spend (null = no cap)
    monthlyUsd: 50
    onLimit: block         # block (default) or warn
  routes:
    quick:
      maxBudgetUsd: 0.10   # per-run ceilings
      maxTurns: 4
      timeoutSeconds: 120
      effort: null
```

Per-run overrides: `agentify delegate quick "…" --max-budget-usd 0.05 --max-turns 2 --effort low` (also on `agentify review`). Budget-stopped runs are reported distinctly from provider failures and timeouts, in both human and `--json` output.

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
