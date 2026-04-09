---
name: glab-issues-autopilot
description: Pick the first or latest open GitLab issue with glab CLI, implement it autonomously in a tight loop (code, validate, test, fix), and commit when all checks pass. Verify glab authentication and repository context first, and by default only pick issues authored by the authenticated user unless the human explicitly asks for all issues or a different author.
---

# GLab Issues Autopilot

Run end-to-end with minimal human interaction.

## Workflow

1. Confirm repository and auth are ready:
   - `git rev-parse --is-inside-work-tree`
   - `glab auth status`
   - `GLAB_USER="$(glab api user | jq -r .username)"`
2. Resolve repository context:
   - `glab repo view`
3. Select issue based on user mode:
   - `latest`: most recently created open issue
   - `first`: oldest open issue
   - default scope: issues authored by `$GLAB_USER`
   - only widen scope when the human explicitly asks
4. Fetch issue details and convert to an execution checklist.
5. Implement the smallest viable change.
6. Run verification loop automatically:
   - format/lint/typecheck (if present)
   - relevant unit/integration tests
   - repository standard checks
7. If checks fail, fix and rerun until pass or truly blocked.
8. Commit with message referencing issue number.
9. Report summary, checks, and commit hash.

## Issue Selection Commands

Resolve current user:

```bash
GLAB_USER="$(glab api user | jq -r .username)"
```

Latest open issue authored by current user (default):

```bash
glab issue list --state opened --author "$GLAB_USER" --per-page 100 --output json | jq 'sort_by(.created_at) | reverse | .[0]'
```

First open issue authored by current user (default):

```bash
glab issue list --state opened --author "$GLAB_USER" --per-page 100 --output json | jq 'sort_by(.created_at) | .[0]'
```

If explicitly requested to include all authors, drop `--author "$GLAB_USER"`.

Load full issue:

```bash
glab issue view <number> --output json
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
