# Azure DevOps PR History Queries

Read-only Azure Repos and Azure Boards retrieval for a quarter window. Nothing
here mutates a pull request. Do not complete, abandon, vote on, or comment on a
PR from this skill.

## Resolve tooling, identity, and scope first

```bash
command -v az
az extension show --name azure-devops
az account show
az devops configure --list
az account show --query "user.name" -o tsv
```

Record the organization, project, and the authenticated user. `az repos pr list`
filters by `--creator`, which needs that identity — Azure Repos has no `@Me`
shorthand for PR listing the way WIQL has for work items.

Resolve org/project from, in order: an explicit Azure DevOps URL the user gave,
`az devops configure --list` defaults, then Azure Repos remotes shaped like
`https://dev.azure.com/{org}/{project}/_git/{repo}`. When the remote-derived and
configured values disagree, report both and ask which to use before querying.

## List the user's pull requests

`az repos pr list` has no date filter. Fetch by creator and status, then filter
client-side on the dates `scripts/quarter-window.mjs` emits under `azure`.

```bash
az repos pr list \
  --creator "<user@example.com>" \
  --status completed \
  --top 500 \
  --org "https://dev.azure.com/<org>" \
  --project "<project>" \
  -o json > .agentify/quarter-goals/<label>/prs-completed-raw.json
```

Repeat with `--status active` and `--status abandoned`. Add `--repository <repo>`
to narrow to one repository; omit it for project-wide scope. Run once per project
when the user works across several, and merge the arrays.

`--top 500` is a cap, not a window. If a status returns exactly the cap, say the
list was truncated and either raise `--top` or use the dated route below —
silently reporting a truncated count understates the quarter.

Also fetch PRs the user reviewed rather than authored when the summary should
cover review load:

```bash
az repos pr list --reviewer "<user@example.com>" --status completed --top 500 -o json
```

Keep authored and reviewed lists separate. Reviewing a PR is not shipping it.

## Server-side date filtering fallback

When client-side filtering is impractical (very large repos, truncated lists),
query the REST surface through `az devops invoke` and report the exact route:

```bash
az devops invoke \
  --area git \
  --resource pullrequests \
  --route-parameters project="<project>" repositoryId="<repo>" \
  --query-parameters \
    searchCriteria.status=completed \
    searchCriteria.creatorId="<identity-guid>" \
    searchCriteria.queryTimeRangeType=Closed \
    searchCriteria.minTime="<min_time>" \
    searchCriteria.maxTime="<max_time>" \
    '$top=500' \
  --api-version 7.1 \
  -o json
```

`searchCriteria.creatorId` expects an identity GUID, not an email. Resolve it
before using this route, or drop the criterion and filter by author client-side.
Verify parameter support against the API version the org actually serves.

## Fields the summarizer groups on

`pullRequestId`, `title`, `status`, `repository.name`, `createdBy.uniqueName`,
`creationDate`, `closedDate`, `sourceRefName`, `targetRefName`, `isDraft`,
`mergeStatus`, and `url` when present.

`sourceRefName` matters most for cross-linking: branches like
`refs/heads/feature/ABC-123-fix-fare` are how PRs get matched back to Jira keys.
A team that does not put keys in branch names or PR titles will produce many
unlinked PRs — attribute those by repository and say the linkage is weak.

## Optional Azure Boards work items

If the team tracks some work in Azure Boards rather than Jira, add:

```bash
az boards query --wiql "SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.ChangedDate] >= '<start>' ORDER BY [System.ChangedDate] DESC" -o json
```

Report Boards items as a separate source. Do not merge them into the Jira counts.

## Failure modes

- Missing `az`: tell the user to install Azure CLI and stop.
- Missing extension: run or suggest `az extension add --name azure-devops`.
- No org/project defaults: ask for a URL or suggest
  `az devops configure --defaults organization=<url> project=<project>`.
- Expired PAT (`Access Denied: The Personal Access Token used has expired`):
  stop until auth is refreshed. Do not fall back to partial data silently.
- Identity unresolved: stop rather than listing every PR in the project.

## Guardrails

- Do not store or print PATs, tokens, or `az` credentials anywhere.
- Do not infer authorship from a PR title that mentions someone.
- Do not count draft or abandoned PRs as delivered work; report them separately.
