---
name: copy-pr
description: Clone the code changes from a GitHub or Azure DevOps pull request URL into a fresh local branch, validate the copied diff, commit it, and push it automatically with minimal interaction.
---

# Copy PR

Use this skill when the user provides a PR URL and wants the same code change recreated on a new local branch automatically.

## Workflow

1. Validate inputs and repo context:
   - require a PR URL
   - ensure current directory is a git repository
   - capture current branch and clean/dirty status
2. Detect provider from the PR URL:
   - GitHub (`github.com`)
   - Azure DevOps (`dev.azure.com` or `visualstudio.com`)
3. Validate CLI auth for the provider:
   - GitHub: `gh auth status`
   - Azure DevOps: `az auth status` and `az devops configure --list`
4. Resolve PR metadata from the URL:
   - source branch
   - target branch
   - title
   - head commit
   - patch or file diff
5. Create a fresh local branch from the PR target branch (never reuse an old task branch):
   - naming: `copy-pr/<pr-number>-<slug>`
   - if the branch exists, create a suffixed variant such as `copy-pr/<pr-number>-<slug>-2`
6. Copy changes autonomously with no extra user interaction:
   - prefer fetching PR refs then cherry-picking or applying patch in order
   - if there are multiple commits, preserve commit order when feasible
   - resolve minor conflicts directly; if blocked, report exact blocker
7. Verify equivalence against the original PR diff:
   - compare changed files list
   - compare aggregated unified diff where practical
   - report any intentional or unavoidable differences
8. Run relevant project checks for touched areas (tests/lint/format when available).
9. Commit changes locally with a clear message summarizing PR parity.
10. Push branch to origin automatically.
11. Return:
    - provider and PR URL
    - new branch name
    - commit hash
    - push result
    - diff comparison summary and any deviations

## Provider Command Hints

### GitHub

- Parse owner/repo/pr-number from URL.
- Suggested metadata command:

```bash
gh pr view <url> --json number,title,baseRefName,headRefName,commits,files,url
```

- Suggested patch/diff retrieval:

```bash
gh pr diff <url>
```

- Suggested ref fetch (fallback):

```bash
git fetch origin pull/<pr-number>/head:copy-pr/source-<pr-number>
```

### Azure DevOps

- Parse organization/project/repository/pull request id from URL.
- Suggested metadata command:

```bash
az repos pr show --id <pr-id> --repository <repo> --project <project>
```

- Suggested changes retrieval:

```bash
az repos pr show --id <pr-id> --repository <repo> --project <project> --query changes
```

- If CLI output is insufficient, use `git fetch` PR refs from origin and derive diff locally.

## Operating Rules

- Default to autonomous execution once URL is provided.
- Do not ask follow-up questions unless a required credential or input is missing.
- Prefer deterministic shell commands over manual editing.
- Preserve semantic parity with the original PR over textual perfection.
- Keep scope limited strictly to the referenced PR.

## Guardrails

- Do not force-push.
- Do not rewrite shared history.
- Do not merge into protected branches automatically.
- Do not silently skip failed verification; report failures explicitly.
