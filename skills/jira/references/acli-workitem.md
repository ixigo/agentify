# acli Jira Work Item Reference

Use these examples as the baseline syntax for Jira work-item mutations.

## Create

```bash
acli jira workitem create --summary "New Task" --project "TEAM" --type "Task"
acli jira workitem create --from-file "workitem.txt" --project "PROJ" --type "Bug" --assignee "user@atlassian.com" --label "bug,cli"
acli jira workitem create --generate-json
acli jira workitem create --from-json "workitem.json"
```

Minimum practical fields: `--summary`, `--project`, and `--type`.

## Edit

```bash
acli jira workitem edit --key "KEY-1,KEY-2" --summary "New Summary"
acli jira workitem edit --jql "project = TEAM" --assignee "user@atlassian.com"
acli jira workitem edit --filter 10001 --description "Updated description" --yes
acli jira workitem edit --generate-json
acli jira workitem edit --from-json "workitem.json"
```

Prefer `--key` for normal edits. Use `--jql` or `--filter` only for intended bulk updates.

## Transition

```bash
acli jira workitem transition --key "KEY-1,KEY-2" --status "Done"
acli jira workitem transition --jql "project = TEAM" --status "In Progress"
acli jira workitem transition --filter 10001 --status "To Do" --yes
```

Known statuses from the user's examples: `To Do`, `In Progress`, `Done`.

## Useful JQL

Assigned open work:

```jql
assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, updated DESC
```

Project-scoped open work:

```jql
project = TEAM AND statusCategory != Done ORDER BY priority DESC, updated DESC
```
