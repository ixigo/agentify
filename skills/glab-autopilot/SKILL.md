---
name: glab-autopilot
description: Handle GitLab issue, merge request, review, comment, and label workflows via glab CLI, and hand code changes off to worktree-autopilot when isolated implementation is needed.
---

# GLab Autopilot

Run GitLab orchestration end-to-end with minimal human interaction. Use `glab`
for GitLab operations and keep implementation work in the appropriate coding
workflow once the GitLab context is resolved.

`glab-issues-autopilot` and `gitlab-issues-autopilot` are legacy aliases for
this broader skill. Treat `glab-autopilot` as the canonical workflow.

## Workflow

1. Confirm repository and auth are ready:
   - `git rev-parse --is-inside-work-tree`
   - `command -v glab`
   - `glab auth status`
   - `glab repo view`
   - `GLAB_USER="$(glab api user | jq -r .username)"`
2. Detect the GitLab task type from user intent:
   - issue triage or issue execution
   - merge request creation
   - merge request review, comments, or status
   - labels, assignees, state, milestones, or other metadata updates
3. Resolve the GitLab target:
   - explicit issue or merge request number
   - GitLab issue or merge request URL
   - `latest`: most recently created open issue
   - `first`: oldest open issue
   - default issue scope: authored by the authenticated user unless the human
     explicitly widens scope
4. Fetch the canonical GitLab details and turn them into an execution or review
   checklist.
5. If the task requires code changes, delegate implementation to
   `worktree-autopilot`:
   - pass the resolved issue or merge request context
   - keep GitLab orchestration here
   - let `worktree-autopilot` own isolated worktree creation, implementation,
     verification, and commit
6. If the task is GitLab-only, complete it directly with `glab`.
7. Report GitLab actions taken, any resulting commit or branch, and next
   commands or links.

## Repository And Auth Commands

```bash
git rev-parse --is-inside-work-tree
command -v glab
glab auth status
glab repo view
GLAB_USER="$(glab api user | jq -r .username)"
```

If `jq` is unavailable, use `glab api user` and read the `username` field from
the JSON output.

## Issue Selection Commands

Resolve current user:

```bash
GLAB_USER="$(glab api user | jq -r .username)"
```

Latest open issue authored by current user by default:

```bash
glab issue list --state opened --author "$GLAB_USER" --per-page 100 --output json | jq 'sort_by(.created_at) | reverse | .[0]'
```

First open issue authored by current user by default:

```bash
glab issue list --state opened --author "$GLAB_USER" --per-page 100 --output json | jq 'sort_by(.created_at) | .[0]'
```

If explicitly requested to include all authors, drop `--author "$GLAB_USER"`.

Load full issue details:

```bash
glab issue view <number> --output json
```

For issue URLs, extract the project context from the URL first when it differs
from the current checkout. Confirm with `glab repo view` before mutating
anything.

## Merge Request Commands

Load full merge request details:

```bash
glab mr view <number> --output json
```

Create a draft merge request after validation and push:

```bash
glab mr create --draft --title "<title>" --description "<body>"
```

Use `glab mr note`, `glab mr update`, or other supported `glab mr` subcommands
only after confirming the target merge request number and repository.

## Operating Rules

- Keep GitLab orchestration concerns here even when code execution is delegated
  elsewhere.
- Prefer repo scripts and existing CI-like commands.
- Keep scope to the selected GitLab issue or merge request.
- Validate `glab` auth and repository context before any GitLab mutation.
- Use small commits and deterministic commands.
- If blocked by missing `glab`, auth, permissions, or unsupported `glab`
  functionality, stop and report exact blocker and attempts.

## Guardrails

- Do not modify unrelated GitLab issues, merge requests, labels, or backlog
  ordering.
- Do not skip failing checks by weakening tests or protections.
- Do not force-push or rewrite shared history.
- Do not close issues or merge merge requests unless explicitly requested.
