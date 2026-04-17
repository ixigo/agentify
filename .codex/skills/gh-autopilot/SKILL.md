---
name: gh-autopilot
description: Handle GitHub issue, PR, review, comment, and label workflows with gh CLI. Resolve GitHub context first, then hand code changes to worktree-autopilot when isolated implementation is needed.
---

# GH Autopilot

Run end-to-end with minimal human interaction.

## Workflow

1. Confirm repository and auth are ready:
   - `git rev-parse --is-inside-work-tree`
   - `gh auth status`
   - `GH_USER="$(gh api user --jq .login)"`
2. Detect the GitHub task type from user intent:
   - issue triage or issue execution
   - pull request creation
   - pull request review or review comments
   - labels, assignees, status, or other metadata updates
3. Resolve the GitHub target:
   - explicit issue or PR number from the user
   - `latest`: most recently created open issue
   - `first`: oldest open issue
   - default scope: authored by the authenticated user unless the user explicitly widens scope
4. Fetch the canonical GitHub details and turn them into an execution or review checklist.
5. If the task requires code changes, delegate the implementation phase to `worktree-autopilot`:
   - pass the resolved issue or PR context
   - keep GitHub orchestration here
   - let `worktree-autopilot` own isolated worktree creation, implementation, verification, and commit
6. If the task is GitHub-only, complete it directly with `gh`.
7. Report the GitHub actions taken, any resulting commit or branch, and next commands or links.

## Issue Selection Commands

Resolve current user:

```bash
GH_USER="$(gh api user --jq .login)"
```

Latest open issue authored by current user (default):

```bash
gh issue list --state open --limit 100 --author "$GH_USER" --json number,title,createdAt --jq 'sort_by(.createdAt) | reverse | .[0]'
```

First open issue authored by current user (default):

```bash
gh issue list --state open --limit 100 --author "$GH_USER" --json number,title,createdAt --jq 'sort_by(.createdAt) | .[0]'
```

If explicitly requested to include all authors, drop `--author "$GH_USER"`.

Load full issue:

```bash
gh issue view <number> --json number,title,body,labels,assignees,url
```

Load full PR:

```bash
gh pr view <number> --json number,title,body,state,labels,assignees,reviewDecision,url
```

## Operating Rules

- Keep GitHub orchestration concerns here even when code execution is delegated elsewhere.
- Prefer repo scripts and existing CI-like commands.
- Keep scope to the selected GitHub object.
- Use small commits and deterministic commands.
- If blocked by external dependency, stop and report exact blocker and attempts.

## Guardrails

- Do not modify unrelated GitHub objects or backlog ordering.
- Do not skip failing checks by weakening tests or protections.
- Do not force-push or rewrite shared history.
- Do not close or merge anything unless explicitly requested.
