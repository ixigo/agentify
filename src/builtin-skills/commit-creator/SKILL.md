---
name: commit-creator
description: Create high-quality commits using Conventional Commit prefixes (feat, fix, chore, refactor, docs, test, etc.) with focused staging and clear messages.
---

# Commit Creator

Produce clean, review-friendly commits that follow standup/conventional style prefixes.

## Workflow

1. Inspect git state and summarize changed files.
2. Propose commit grouping strategy (one or more commits) based on logical change sets.
3. Ask/confirm commit type prefix for each commit:
   - `feat:` new behavior
   - `fix:` bug fix
   - `chore:` maintenance/tooling
   - `refactor:` code restructuring without behavior change
   - `docs:` documentation-only changes
   - `test:` test-only changes
   - `perf:` performance improvements
   - `build:` build/dependency updates
   - `ci:` CI/CD config updates
4. Stage only the files/hunks relevant to each commit.
5. Write concise subject lines and informative bodies when needed.
6. Create commit(s) and report hashes with summaries.

## Quality Rules

- Keep commits atomic and scoped.
- Avoid mixing unrelated concerns in one commit.
- Prefer imperative subject lines (e.g., `refactor: simplify provider resolution`).
- Mention why in the body when the change is non-obvious.
- If no changes are staged, stop and explain what is missing.

## Output Format

- `Plan`
- `Commits created`
- `Files per commit`
- `Notes`
