# Quarter Summary Contract

The deliverable is an evidence-backed record of what the user actually shipped in
the window, shaped so it can be pasted into a quarterly goal or review document.
Themes come from metadata. Goal statements come from the agent. Neither comes
from guesswork.

## Required sections

### 1. Scope

State, in one block:

- Window label, start date, end date, and whether it is a rolling three-month
  span or a calendar quarter.
- Whose work it covers: the Jira account from `acli jira auth status` and the
  Azure DevOps identity from `az account show`.
- Every source queried, with the exact command or route used.
- Counts pulled per source, and any source that was unavailable.

If the two identities do not plainly belong to the same person, say so. A
mismatched pair silently merges two people's work.

### 2. Headline numbers

Straight from the summarizer's `totals`, with no rounding up:

- Jira items resolved in window, and items still in flight.
- Pull requests completed in window, plus active and abandoned counts.
- Repositories touched.
- Themes identified.

Never present a truncated or partial fetch as a complete count. Label it
`at least N` and name the cap that truncated it.

### 3. Goal themes

One block per theme, ordered by evidence weight:

```text
Theme:      <theme label> (<kind>: epic | component | label | project | repository)
Goal:       <one sentence, past tense, what changed for users or the system>
Delivered:  <2-5 bullets of concrete outcomes>
Evidence:   <Jira keys with URLs> | <PR ids with repository>
Span:       <first activity> to <last activity>
Confidence: high | medium | low  (+ why, when not high)
```

Rules for the `Goal` line:

- Write it from ticket summaries, PR titles, and branch names you actually read.
- Describe outcome, not activity. "Cut checkout API p95 by moving fare lookup
  server-side" beats "worked on fare tickets".
- Confidence is `low` when the theme rests on unlinked PRs or on `updated`
  timestamps rather than resolutions. Say which.
- If a theme's metadata is too thin to support any outcome claim, list the
  evidence and write `Goal: not inferable from available metadata`. Do not
  invent an achievement to fill the line.

### 4. Carrying into next quarter

Open assigned work from the `in_flight` list, with status and last-touched date.
Do not promise dates or commit the user to anything.

### 5. Coverage and gaps

Reproduce the summarizer's `gaps` and `cross_links` honestly:

- Pull requests with no known Jira key, grouped by repository.
- Jira keys referenced by PRs but absent from the Jira export.
- Jira items with no linked pull request.
- Records that fell outside the window, and records with no usable date.
- Sources that were unavailable, truncated, or unauthorized.

This section is not optional. A summary without it reads as complete when it is
not.

## Evidence rules

- Every claim cites at least one Jira key or pull request id.
- A Jira key counts as delivery evidence only when it resolved in the window or
  its status category is Done. Otherwise it is in-flight evidence.
- A pull request counts as delivery evidence only when it is `completed` and its
  `closedDate` falls in the window. Draft, active, and abandoned PRs are context.
- A reviewed PR is review contribution, never authored delivery.
- Commit counts and diff line counts are not outcomes. Omit them unless the user
  explicitly asks.
- Do not estimate effort, hours, story points, or impact percentages that no
  source reported.

## Output artifacts

Write generated files under `.agentify/quarter-goals/<window-label>/`:

- `window.json` — the resolved window.
- `jira-raw.json`, `prs-*-raw.json` — untouched source payloads.
- `activity-summary.json` — summarizer output.
- `quarter-summary.md` — the human deliverable.

Do not commit these unless the user asks. They contain work history and account
identifiers.

## Guardrails

- Never write a token, PAT, cookie, or password into any artifact.
- Never mutate Jira or Azure DevOps state from this skill.
- Do not compare the user against teammates or produce a performance rating.
- Do not fabricate a theme, metric, epic, or outcome that the fetched data does
  not support.
