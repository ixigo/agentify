---
name: find-goals-per-quarter
description: Build an evidence-backed summary of the current user's own work over the last three months or a named calendar quarter by reading their Jira work items through Atlassian CLI `acli` and their Azure DevOps pull requests through `az`, cross-linking tickets to PRs, grouping the result into goal themes, and reporting coverage gaps. Use when the user asks what they shipped last quarter, wants quarterly goals or achievements found from their actual Jira and Azure DevOps activity, needs input for a self-review or performance summary, or asks for a summary of work done in the last three months.
---

# Find Goals Per Quarter

Reconstruct what the user actually delivered in a quarter from Jira work items
and Azure DevOps pull requests, then express it as goal themes with citations.
This skill is read-only: it queries, correlates, and writes local artifacts. It
never transitions a ticket, comments, votes, or touches a pull request.

## Scope rules

- Default to the authenticated user's own work. Never widen to a teammate, a
  whole team, or a whole project unless the user explicitly asks and names them.
- Default window is the rolling last three months. Use a calendar quarter when
  the user names one (`2026-Q2`, "last quarter", "Q1").
- If either identity cannot be resolved, stop and say which one. Do not summarize
  work that might belong to someone else.
- Do not compare the user against anyone or produce a rating.

## Required inputs

Resolve these before querying; ask only what you cannot determine:

- Window: rolling three months, or an explicit calendar quarter.
- Jira account and site, from `acli jira auth status`.
- Azure DevOps organization, project, and user identity, from `az account show`
  and `az devops configure --list`.
- Repository or project scope when the user works across several.
- Whether reviewed pull requests count toward the summary, not just authored ones.

## Load the relevant references

- [references/jira-history-queries.md](references/jira-history-queries.md)
  before running any `acli` read.
- [references/azure-pr-history-queries.md](references/azure-pr-history-queries.md)
  before running any `az` read.
- [references/quarter-summary-contract.md](references/quarter-summary-contract.md)
  before writing the deliverable.

Treat every command in the references as a candidate to verify against the
installed CLI version, not as guaranteed syntax.

## Workflow

### 1. Check tooling and identity

```bash
command -v acli && acli jira auth status
command -v az && az extension show --name azure-devops
az account show --query "user.name" -o tsv
az devops configure --list
```

Both CLIs are needed for a full summary. If exactly one is available, continue
with that source, state the missing half up front, and mark the summary partial.
If neither is available, stop and give install and login instructions:

```bash
brew tap atlassian/homebrew-acli && brew install acli && acli jira auth login --web
az login && az extension add --name azure-devops
```

### 2. Resolve the window

```bash
node .codex/skills/find-goals-per-quarter/scripts/quarter-window.mjs \
  --as-of 2026-07-30 \
  --months 3 \
  --pretty \
  --output ".agentify/quarter-goals/last-3-months/window.json"
```

Use `--quarter 2026-Q2` instead of `--months` for a calendar quarter. The output
carries the ready JQL strings, the Azure `min_time`/`max_time` pair, and the
client-side cutoff fields. Adjust the installed path if the skill lives under a
different provider directory.

### 3. Fetch Jira work items

Verify the read surface with `acli jira workitem search --help` first, then run
the emitted `resolved`, `closed_by_status_category`, `updated`, and `in_flight`
JQL queries. Merge and deduplicate by key into a single JSON array at
`.agentify/quarter-goals/<label>/jira-raw.json`.

Request `parent`, `labels`, and `components` when the command supports field
selection — the grouping collapses to project level without them.

### 4. Fetch Azure DevOps pull requests

Run `az repos pr list` per status (`completed`, `active`, `abandoned`) with
`--creator <identity>`, and per project when scope spans several. Save raw output
per status. Filter to the window client-side on `closedDate` for completed PRs and
`creationDate` for active ones. If a status returns exactly `--top`, treat the
list as truncated and either raise the cap or use the dated `az devops invoke`
route.

Fetch reviewed PRs separately only when the user wants review load included.

### 5. Correlate and summarize

```bash
node .codex/skills/find-goals-per-quarter/scripts/summarize-quarter-activity.mjs \
  --window ".agentify/quarter-goals/last-3-months/window.json" \
  --jira ".agentify/quarter-goals/last-3-months/jira-raw.json" \
  --prs ".agentify/quarter-goals/last-3-months/prs-completed-raw.json" \
  --jira-identity "user@example.com" \
  --azure-identity "user@example.com" \
  --pretty \
  --output ".agentify/quarter-goals/last-3-months/activity-summary.json"
```

The summarizer normalizes both payload shapes, matches Jira keys found in PR
titles and branch names against the fetched keys, groups evidence into themes by
epic, component, label, project, then repository, buckets activity by month, and
reports gaps. Read its `review_hints` before writing prose — they name the
weaknesses in the evidence you are about to summarize.

### 6. Read the evidence before writing

Open the highest-weight themes and read the actual ticket summaries and PR titles
behind them. Theme labels are grouping keys, not achievements. A goal statement
written from a theme label alone will be generic and probably wrong.

### 7. Write the deliverable

Follow `references/quarter-summary-contract.md` exactly: scope, headline numbers,
goal themes with citations and confidence, work carrying into next quarter, and
the coverage-and-gaps section. Write it to
`.agentify/quarter-goals/<label>/quarter-summary.md` and summarize the top themes
in the reply with Jira URLs and PR ids.

When the user asked for goals for the *coming* quarter, derive candidates from
in-flight work and open epics, label them clearly as proposals, and keep them
separate from the record of completed work.

## Guardrails

- Do not mutate Jira or Azure DevOps state, including "harmless" comments.
- Do not write tokens, PATs, or credentials into artifacts, notes, or commits.
- Do not count active, draft, or abandoned pull requests as delivered work.
- Do not count a reviewed pull request as authored delivery.
- Do not treat `updated` timestamps as completion evidence.
- Do not present a truncated fetch as a complete count.
- Do not invent epics, metrics, impact percentages, effort estimates, or outcomes
  that no source reported.
- Do not commit `.agentify/quarter-goals/` unless the user asks; it holds work
  history and account identifiers.

## Completion report

Finish with:

- Window, mode, and both resolved identities.
- Sources queried, exact commands, counts returned, and anything unavailable.
- Headline numbers and the top goal themes with citations.
- Work carrying into the next quarter.
- Coverage gaps, unlinked pull requests, and unverified Jira keys.
- Artifact paths written.
