# Jira History Queries

Read-only Jira retrieval for a quarter window. Every command here is a read. Do
not transition, edit, or comment on work items from this skill.

## Resolve identity and site first

```bash
command -v acli
acli jira auth status
```

Record the authenticated account and site. The summary must name whose work it
covers. If `acli` is missing or logged out, tell the user to run
`acli jira auth login --web` and stop — do not summarize a different account.

Construct work item URLs as `https://<site>/browse/<KEY>` so every cited key is
clickable.

## Verify the read surface before querying

The `acli` search surface differs by version. Inspect it instead of assuming:

```bash
acli jira workitem --help
acli jira workitem search --help
acli jira workitem list --help
acli jira workitem view --help
```

Prefer whichever subcommand accepts a JQL string plus a machine-readable output
flag (commonly `--jql` with `--json` or `--output json`). Record the exact
command you used in the deliverable.

```bash
acli jira workitem search --jql "<jql>" --json > .agentify/quarter-goals/<label>/jira-raw.json
```

If the installed `acli` has no JQL-capable read command, say so and use the REST
fallback below rather than reconstructing history from `view` calls one key at a
time.

## Window JQL

`scripts/quarter-window.mjs` emits these under `jira.jql`. Run the ones that
apply and merge the results by key:

- `resolved` — completed work with a real resolution date. Primary evidence.
- `closed_by_status_category` — catches projects that close items without
  setting `resolutiondate`.
- `updated` — everything touched in the window, including work that slipped.
- `in_flight` — open assigned work, for the "carrying into next quarter" section.
- `previously_assigned` — `assignee was currentUser()`, catches items reassigned
  after the user finished them. Not all sites index `was`; drop it if it errors.
- `worklog` — `worklogAuthor` / `worklogDate`, only useful when the team logs
  time. Skip silently when it returns nothing.
- `created` — items the user reported rather than delivered. Keep separate from
  delivery evidence.

Deduplicate by key across queries. A key appearing in several queries is one
item, not several.

## Fields worth requesting

Request these when the command supports field selection, because the summarizer
groups on them:

`key`, `summary`, `issuetype`, `status`, `status.statusCategory`, `project`,
`parent` (epic key and summary), `labels`, `components`, `created`, `updated`,
`resolutiondate`, `assignee`.

Missing `parent`, `labels`, and `components` collapse every item into a
project-level theme, which produces a vague summary. If the site has none of
them, say the grouping is project-level and why.

## REST fallback

Use only when `acli` cannot run a JQL read. Requires `JIRA_BASE_URL`,
`JIRA_EMAIL`, and `JIRA_API_TOKEN` in the environment — the same variables the
rest of Agentify uses. Verify the endpoint against the site's API version before
trusting the shape.

```bash
curl -sS -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "$JIRA_BASE_URL/rest/api/3/search/jql" \
  -d '{"jql":"<jql>","maxResults":100,"fields":["summary","issuetype","status","project","parent","labels","components","created","updated","resolutiondate","assignee"]}'
```

Page with the token the response returns until it stops returning one, and cap
the number of requests. Never echo `JIRA_API_TOKEN` into logs, files, notes, or
the deliverable.

## Guardrails

- Do not invent keys, epics, statuses, or resolution dates.
- Do not treat a ticket the user commented on as a ticket the user delivered.
- A quarter with no resolved items is a real result. Report it instead of
  padding the summary with `updated` noise.
