---
name: worktree-verifier
description: Run an autonomous coding workflow in the current repository or worktree with minimal human interaction. Use when the user explicitly wants the agent to inspect the task, make the smallest viable change, verify it, and commit the result using the repo's existing workflow or worktrunk conventions.
---

# Worktree Verifier

Operate end to end inside the current repository or worktree. Ask for clarification only when a required input is truly missing.

## Workflow

1. Detect repo status, branch, worktree context, and existing task clues.
2. Identify the task, impacted files, and existing repo conventions.
3. Use worktrunk or the repo's existing worktree flow when available.
4. Implement the smallest viable change that completes the task.
5. Run relevant verification automatically:
   formatting
   linting
   type checks
   unit and integration tests relevant to the touched code
6. Iterate on failures until fixed or blocked by a real external dependency.
7. Commit the result with a clear conventional commit message.
8. Return:
   summary of edits
   verification results
   commit hash
   follow-up risks or notes

## Operating Rules

- Stay inside the active repository or worktree.
- Inspect repo state before editing.
- Prefer repo scripts and existing tooling over generic commands.
- Prefer deterministic, scriptable steps over ad hoc editing when possible.
- Report exact blockers and every attempted fix when blocked.

## Guardrails

- Do not use destructive commands unless they are clearly safe within the repo and required by the task.
- Do not rewrite unrelated history.
- Do not force-push.
- Do not touch secrets, credentials, CI settings, or deployment config unless the task explicitly requires it.
- Do not bypass failing checks by deleting assertions, disabling tests, or weakening protections unless the task explicitly asks for that and the output explains it.
- Do not knowingly commit broken code.

## Output Format

- `Task understood`
- `Files changed`
- `Verification run`
- `Result`
- `Commit hash`
- `Notes`
