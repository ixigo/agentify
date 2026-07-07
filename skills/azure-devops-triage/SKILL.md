---
name: azure-devops-triage
description: >
  Triage Azure Boards work items by inspecting fields, comments, states, and tags
  with az CLI. Use when the user wants to review, classify, update, or prepare
  Azure DevOps work items for agent execution.
---

# Azure DevOps Triage

Triage Azure Boards work items safely. Inspect first, recommend changes by
default, and mutate only when the user explicitly asks.

## Workflow

1. Confirm prerequisites:
   - `command -v az`
   - `az extension show --name azure-devops`
   - `az account show`
   - `az devops configure --list`
2. Resolve the target work item:
   - explicit Azure Boards URL
   - numeric work item ID
   - `latest` or `first` active work item assigned to or created by the authenticated user when identity is available
3. Fetch details:
   - `az boards work-item show --id <id>`
4. Inspect standard fields:
   - `System.Title`
   - `System.State`
   - `System.WorkItemType`
   - `System.AssignedTo`
   - `System.CreatedBy`
   - `System.Tags`
   - `System.Description`
5. Inspect discussion/comments where supported by the configured Azure DevOps CLI
   version. If the CLI lacks a direct command, use `az devops invoke` against the
   work item comments API and report the route used.
6. Produce a triage summary with:
   - current state and owner
   - inferred type and priority signals from fields/tags
   - missing information
   - recommended state/tag/assignee changes
   - whether the item is ready for implementation handoff
7. If implementation is requested and the item is ready, hand the resolved
   context to `ado-autopilot` or `worktree-autopilot`.

## Workflow: Create a New Work Item

When the user asks to create a new work item — or triage surfaces work that needs one — do not file it straight away:

1. Invoke the `grill-me` skill first: interview the user one question at a time (each with a recommended answer) until the requirement is concrete — scope, acceptance criteria, affected code, risks. Explore the codebase instead of asking when the repo can answer.
2. Summarize the resulting plan and confirm the user wants it published.
3. Only then create the work item(s) with `az boards work-item create --type <Bug|Task|User Story> --title ...`, mapping grill-me's feature/fix/chore/docs/test grouping onto the project's work item types.
4. Apply the agreed tags (for example `agentify-ready`) so the item enters the normal triage flow.

Skip the interview only when the user hands over an already-complete spec and explicitly asks to file it verbatim.

## Conservative State Mapping

Azure Boards process templates vary. Treat these as suggestions, not universal
truth:

- GitHub `open`: an active/nonterminal Azure Boards state such as `New`, `Active`, `To Do`, or `Committed`.
- GitHub `ready`: use tags such as `agentify-ready` only if the project already uses them or the user asks.
- GitHub `in progress`: recommend the nearest existing in-progress state after inspecting available field values.
- GitHub `closed`: terminal states vary; do not close or resolve work items unless explicitly requested.

Prefer tags for lightweight classification only when that matches the existing
project convention. Preserve existing tags and append new tags intentionally.

## Useful Commands

```bash
az boards work-item show --id <id>
az boards work-item update --id <id> --fields System.Tags="tag1; tag2"
az boards work-item update --id <id> --state "<state>"
az boards query --wiql "SELECT [System.Id], [System.Title], [System.State] FROM WorkItems WHERE [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC"
```

Only run update commands after the user has clearly approved the exact mutation.

## Failure Modes

- Missing Azure DevOps extension: install with `az extension add --name azure-devops`.
- Missing organization/project defaults: request a work item URL or configure defaults with `az devops configure`.
- Stale PAT/auth: report the exact Azure CLI error and stop.
- Unknown process template: inspect current fields and recommend, do not assume.

## Output Format

- `Work item`
- `Current fields`
- `Discussion signals`
- `Readiness`
- `Recommended changes`
- `Next action`
