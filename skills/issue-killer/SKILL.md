---
name: issue-killer
description: Launch opted-in GitHub issues into supervised tmux panes, each with its own Worktrunk worktree and Codex or Claude agent prompt for draft PR creation.
---

# Issue Killer

Use this skill when the user wants parallel supervised issue-solving agents across multiple worktrees.

## Workflow

1. Require either explicit GitHub issue URLs or an opt-in label. Do not select arbitrary open issues.
2. Use the Agentify CLI command instead of hand-rolling tmux panes:

```bash
agentify issue-killer --issue-provider github --label agentify-ready --agent-provider codex --limit 5
```

Issue-killer launches provider panes in YOLO mode by default, bypassing provider permission prompts. Use `--bypass-permissions=false` only when a supervised run should keep provider approvals enabled.

3. For explicit issues, pass comma-separated URLs:

```bash
agentify issue-killer --issue-provider github --issue-url https://github.com/ORG/REPO/issues/123,https://github.com/ORG/REPO/issues/124 --agent-provider claude --limit 2
```

4. After launch, supervise with:

```bash
tmux attach -t gh-issue-killer
```

## Guardrails

- V1 supports GitHub issues only.
- Issues must be selected by `--label` or `--issue-url`.
- The command creates Worktrunk worktrees before launching panes.
- Panes run interactive Codex or Claude agents.
- Panes default to provider permission bypass and include a YOLO-mode warning in the provider prompt.
- Agents should create draft PRs by default.
- Do not force-push, merge, or mark PRs ready for review unless the user explicitly asks.
