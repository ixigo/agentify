---
name: pr-creator
description: Create a draft PR for GitHub, GitLab, or Azure DevOps after validating required CLI prerequisites and authentication, then return a concise summary with the PR link.
---

# PR Creator

Create pull requests with strict prerequisite checks and clear operator feedback.

## Workflow

1. Ask the user which domain/provider to use:
   - GitHub
   - GitLab
   - Azure DevOps
2. Detect required CLIs and auth state before attempting PR creation.
3. If prerequisites are missing, stop and provide install/auth steps for the selected provider.
4. If prerequisites are satisfied, gather/confirm PR metadata:
   - base/target branch
   - source branch
   - title
   - description/body
5. Create a **draft** PR using the provider CLI.
6. Return a concise summary in chat including the PR URL.

## Provider Prerequisites

### GitHub
- Required CLI: `gh`
- Check install: `command -v gh`
- Check auth: `gh auth status`
- Draft PR command pattern: `gh pr create --draft ...`

### GitLab
- Required CLI: `glab`
- Check install: `command -v glab`
- Check auth: `glab auth status`
- Draft PR/MR command pattern: `glab mr create --draft ...`

### Azure DevOps
- Required CLI: `az` with Azure DevOps extension
- Check install: `command -v az`
- Check extension: `az extension show --name azure-devops`
- Check auth/context: verify sign-in and org/project defaults (`az account show`, `az devops configure --list`)
- Draft PR command pattern: `az repos pr create --draft true ...`

## Guardrails

- Never create a non-draft PR unless the user explicitly requests it.
- Do not guess missing branches; ask/confirm before creation.
- If creation command fails, report exact CLI error and next fix.
- Share the final PR link and key metadata in the response.

## Output Format

- `Provider`
- `Prerequisites`
- `Action`
- `PR link`
- `Notes`
