---
name: worktree-autopilot
description: Detect the repo's worktree workflow, create a fresh task worktree, implement the change there, verify it, commit it, and return merge-back commands for the user to run locally. Use when the user explicitly wants isolated autonomous implementation with worktree or Worktrunk conventions.
---

# Worktree Autopilot

Operate end to end using an isolated task worktree. Ask for clarification only when a required input is truly missing.

## Workflow

1. Detect repo status, current branch, existing worktree context, and whether Worktrunk or another repo-standard worktree flow is available.
2. Choose the correct base branch from the current repo state.
3. Create a fresh task branch and worktree before making changes:
   - Prefer the repo's existing Worktrunk flow when present.
   - Otherwise use plain `git worktree add` with a deterministic branch name derived from the task.
4. Move into the new worktree and identify impacted files and repo conventions there.
5. Implement the smallest viable change that completes the task.
6. Run relevant verification automatically:
   formatting
   linting
   type checks
   unit and integration tests relevant to the touched code
7. Iterate on failures until fixed or blocked by a real external dependency.
8. Commit the result with a clear conventional commit message.
9. Do not merge the task branch back automatically. Return:
   summary of edits
   verification results
   commit hash
   task worktree path
   branch name
   exact local commands the user can run from the original checkout to merge or cherry-pick the result
   follow-up risks or notes

## GitHub-Scoped Tasks

If the user provides an issue number, PR number, or otherwise asks for a GitHub-scoped task, do not infer GitHub details locally. Resolve the GitHub context through `gh-autopilot` first, then continue with isolated worktree execution once the task is concretely defined.

`worktree-autopilot` owns code execution. `gh-autopilot` owns GitHub object resolution and GitHub-side actions.

## Worktree Detection

Check for repo-local conventions before falling back to raw git:

- Existing helper scripts or docs mentioning `worktrunk`
- Worktree-related Make, package, shell, or task runner commands
- Existing sibling worktrees from `git worktree list`

If Worktrunk is present, follow that flow first. If not, use standard git worktrees and state that fallback explicitly.

## Operating Rules

- Inspect repo state before editing.
- Do not perform implementation work on the original checkout if an isolated worktree can be created safely.
- Prefer repo scripts and existing tooling over generic commands.
- Prefer deterministic, scriptable steps over ad hoc editing when possible.
- Report exact blockers and every attempted fix when blocked.
- Leave the original checkout untouched except for creating the new worktree and branch.

## Guardrails

- Do not use destructive commands unless they are clearly safe within the repo and required by the task.
- Do not rewrite unrelated history.
- Do not force-push.
- Do not merge back into the original branch automatically unless the user explicitly asks for it.
- Do not touch secrets, credentials, CI settings, or deployment config unless the task explicitly requires it.
- Do not bypass failing checks by deleting assertions, disabling tests, or weakening protections unless the task explicitly asks for that and the output explains it.
- Do not knowingly commit broken code.

## Output Format

- `Task understood`
- `Base branch`
- `Worktree created`
- `Files changed`
- `Verification run`
- `Result`
- `Commit hash`
- `Merge-back commands`
- `Notes`
