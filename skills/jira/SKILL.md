---
name: jira
description: Manage Jira work items through Atlassian CLI `acli`, including picking up assigned tickets, daily to-do triage, transitioning statuses, editing summaries/descriptions/assignees/labels, updating the current ticket, and creating new Jira tasks or bugs. Use when the user asks about Jira tickets, assigned work, current ticket updates, daily Jira workflow, moving work to In Progress/Done/To Do, or creating/editing Jira work items.
---

# Jira

## Overview

Use this skill to operate Jira through `acli jira workitem` with a bias toward narrow, explicit changes. Prefer discovering the current ticket from local context, showing the intended command for risky changes, and validating command support with local `acli --help` output when syntax is uncertain.

## Safety Rules

- Treat `create`, `edit`, and `transition` as live Jira mutations.
- Execute a live mutation only when the user clearly asks for the action. If the target ticket, project, status, or bulk scope is ambiguous, ask one concise question.
- Never apply a JQL or filter-based edit/transition with broad scope unless the user explicitly confirms the query/filter and the intended status or fields.
- Use `--yes` only when the operation scope is explicit and the user already requested non-interactive execution.
- Do not invent Jira project keys, assignees, labels, or statuses. Infer them from local branch/ticket context only when obvious, then state the inference.

## Setup Checks

Run these before a workflow if Jira access or command shape is uncertain:

```bash
command -v acli
acli jira --help
acli jira workitem --help
acli jira auth status
```

If `acli` is not installed when the Jira skill is invoked, do not continue with Jira operations. Tell the user to install and authenticate:

```bash
brew tap atlassian/homebrew-acli
brew install acli
acli jira auth login --web
```

If `acli` is installed but unauthenticated, ask the user to run `acli jira auth login --web` or authenticate with their site/email/token as shown by `acli jira auth login --help`.

When a read/search command is needed, inspect available subcommands first because the exact `acli` surface may differ by version:

```bash
acli jira workitem --help
acli jira workitem list --help
acli jira workitem search --help
```

Load `references/acli-workitem.md` when exact create/edit/transition examples are needed.

## Jira URLs

After every successful Jira operation, return the direct Jira URL for each affected work item so the user can open it immediately. Resolve the site from `acli jira auth status` and construct:

```text
https://<site>/browse/<KEY>
```

Example: if auth status reports `Site: ixigodev.atlassian.net`, key `ABC-123` should be returned as `https://ixigodev.atlassian.net/browse/ABC-123`.

For create operations, parse the created key from `acli` output or run a narrow follow-up lookup only if needed. For edit, transition, view, comment, and search/list workflows, use the explicit keys already in the command/result. If the operation affects multiple keys, return one URL per key. If the site cannot be resolved, say that the Jira URL could not be constructed and include the key plus the command to open it:

```bash
acli jira workitem view KEY-123 --web
```

## Daily Assigned Work

For requests like "pick my task", "what should I do today", or "daily todo":

1. Discover assigned open work with the narrowest supported read command. Prefer JQL if the installed `acli` supports it:

```jql
assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, updated DESC
```

2. If multiple items are returned, summarize the top candidates by key, status, priority, and summary. Do not transition anything until the user chooses or the requested choice is obvious.
3. If exactly one active item is obvious and the user asked to pick it up, transition it to `In Progress`:

```bash
acli jira workitem transition --key "KEY-123" --status "In Progress"
```

4. For "everyday todo" style requests, produce a short work plan from assigned open tickets, then offer or perform explicit transitions requested by the user.

## Current Ticket Workflow

For requests like "update current ticket", "move this ticket", or "mark current as done":

1. Try to identify the Jira key from local context:

```bash
git branch --show-current
git log -1 --pretty=%B
```

Look for keys like `ABC-123`. If more than one key is plausible, ask which one to use.
2. Inspect available status names if the target status is not one of the user's known statuses.
3. Transition or edit only the resolved key:

```bash
acli jira workitem transition --key "ABC-123" --status "Done"
acli jira workitem edit --key "ABC-123" --description "Updated description"
```

## Creating Work Items

For a new task or bug, collect the minimum required fields: summary, project, and type. Ask for missing fields only when they cannot be inferred safely.

Use direct flags for simple items:

```bash
acli jira workitem create --summary "New Task" --project "TEAM" --type "Task"
```

Use JSON for richer items or when preserving multiline text. Generate a template first if the installed `acli` supports it:

```bash
acli jira workitem create --generate-json
acli jira workitem create --from-json "workitem.json"
```

## Editing Work Items

Prefer key-scoped edits:

```bash
acli jira workitem edit --key "KEY-1" --summary "New Summary"
acli jira workitem edit --key "KEY-1" --description "Updated description"
```

Use JQL/filter scoped edits only when the user explicitly requests bulk changes:

```bash
acli jira workitem edit --jql "project = TEAM" --assignee "user@atlassian.com"
acli jira workitem edit --filter 10001 --description "Updated description" --yes
```

## Helper Script

Use `scripts/jira_workitem.py` to construct common commands without hand-writing quoting. It prints commands by default and runs them only with `--run`.

Examples:

```bash
python3 /Users/ranveer.kumar/.codex/skills/jira/scripts/jira_workitem.py assigned-jql
python3 /Users/ranveer.kumar/.codex/skills/jira/scripts/jira_workitem.py transition --key KEY-1 --status "In Progress"
python3 /Users/ranveer.kumar/.codex/skills/jira/scripts/jira_workitem.py create --summary "New Task" --project TEAM --type Task
```
