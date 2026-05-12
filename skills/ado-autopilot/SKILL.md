---
name: ado-autopilot
description: >
  Orchestrate Azure Boards work items and Azure Repos pull requests with az CLI.
  Use when the user provides an Azure DevOps work item or PR URL/ID, asks to pick
  up Azure Boards work, or wants Azure Repos PR creation/review handling. Resolve
  Azure DevOps context first, then hand code changes to worktree-autopilot.
---

# ADO Autopilot

Run Azure DevOps work-item and PR workflows end-to-end with explicit CLI context,
readiness checks, and conservative mutation rules.

## Workflow

1. Confirm local repository and Azure DevOps tooling are ready:
   - `git rev-parse --is-inside-work-tree`
   - `command -v az`
   - `az extension show --name azure-devops`
   - `az account show`
   - `az devops configure --list`
2. Resolve organization, project, and repository from:
   - explicit Azure DevOps URL fields
   - `az devops configure --list` defaults
   - Azure Repos git remotes such as `https://dev.azure.com/{org}/{project}/_git/{repo}`
3. Detect the requested Azure DevOps object:
   - Azure Boards work item URL or numeric ID
   - Azure Repos pull request URL or numeric ID
   - `latest` or `first` active work item assigned to or created by the authenticated user when identity is available
4. Fetch canonical details before deciding:
   - work item: `az boards work-item show --id <id>`
   - PR: `az repos pr show --id <id>`
5. Convert the resolved context into an execution checklist.
6. Keep Azure DevOps orchestration in this skill. If code changes are needed,
   invoke `worktree-autopilot` with the resolved work item or PR context.
7. Validate, commit, push, and create a draft PR only when the user asked for that
   workflow or the surrounding task requires delivery.

## Work Item Resolution

Use explicit IDs or URLs first. For shorthand selection, keep the default scope
to the authenticated user when the CLI can determine identity.

```bash
az boards work-item show --id <id>
az boards query --wiql "SELECT [System.Id], [System.Title], [System.State] FROM WorkItems WHERE [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC"
```

If `@Me` or identity resolution is not available, stop and ask for a work item ID
or URL instead of broadening scope silently. Inspect returned `System.State`
values before treating an item as active because terminal states vary by process
template.

Read these standard fields when present:

- `System.Id`
- `System.Title`
- `System.State`
- `System.WorkItemType`
- `System.AssignedTo`
- `System.CreatedBy`
- `System.Tags`
- `System.Description`

## Pull Request Workflows

Prefer normal Azure Repos CLI commands first:

```bash
az repos pr show --id <id>
az repos pr list --status active
az repos pr create --draft true --source-branch <branch> --target-branch <branch> --title <title> --description <body>
```

When `az repos pr` omits review-thread payloads, fall back to the Azure DevOps
REST surface through `az devops invoke` and report the exact route used:

```bash
az devops invoke \
  --area git \
  --resource pullRequestThreads \
  --route-parameters project=<project> repositoryId=<repo> pullRequestId=<id> \
  --api-version 7.1
```

For richer review-comment resolution and convention learning, use the existing
`pr-convention-learner` skill. For draft PR creation across hosts, reuse
`pr-creator` command patterns instead of inventing a separate PR flow.

## Failure Modes

- Missing `az`: tell the user to install Azure CLI.
- Missing Azure DevOps extension: run or suggest `az extension add --name azure-devops`.
- Missing org/project defaults: ask for a URL or run `az devops configure --defaults organization=<url> project=<project>`.
- Stale PAT/auth: surface errors such as `Access Denied: The Personal Access Token used has expired` and stop until auth is refreshed.
- Remote/config mismatch: report both the Azure Repos remote-derived org/project and configured `az devops` defaults before mutating anything.
- Missing PR review threads from CLI: use `az devops invoke` fallback and include the route in the response.

## Guardrails

- Do not close work items, complete PRs, bypass policies, or mutate state unless
  the user clearly asks.
- Do not store PATs or credentials in skill files, docs, prompts, or commits.
- Do not assume all Azure Boards projects use Scrum, Agile, or CMMI-specific
  states beyond standard `System.*` fields.
- Keep implementation work isolated through `worktree-autopilot` after context
  is resolved.
