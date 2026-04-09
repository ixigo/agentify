---
name: gh-issue-autopilot
description: Pick the first or latest open GitHub issue with gh CLI, implement it autonomously in a tight loop (code, validate, test, fix), and commit when all checks pass. Verify gh authentication first, and by default only pick issues authored by the authenticated user unless the human explicitly asks for all issues or a different author.
---

# GH Issue Autopilot

Run end-to-end with minimal human interaction.

## Workflow

1. Confirm repository and auth are ready:
   - `git rev-parse --is-inside-work-tree`
   - `gh auth status`
   - `GH_USER="$(gh api user --jq .login)"`
2. Select issue based on user mode:
   - `latest`: most recently created open issue
   - `first`: oldest open issue
   - default scope: issues authored by `$GH_USER`
   - only widen scope when the human explicitly asks
3. Fetch issue details and convert to an execution checklist.
4. Implement the smallest viable change.
5. Run verification loop automatically:
   - format/lint/typecheck (if present)
   - relevant unit/integration tests
   - repository standard checks
6. If checks fail, fix and rerun until pass or truly blocked.
7. Commit with message referencing issue number.
8. Report summary, checks, and commit hash.

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

## Operating Rules

- Prefer repo scripts and existing CI-like commands.
- Keep scope to the selected issue.
- Use small commits and deterministic commands.
- If blocked by external dependency, stop and report exact blocker and attempts.

## Guardrails

- Do not modify unrelated issues or backlog ordering.
- Do not skip failing checks by weakening tests or protections.
- Do not force-push or rewrite shared history.
- Do not close an issue unless explicitly requested.
