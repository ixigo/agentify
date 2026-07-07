---
name: issue-killer
description: Launch opted-in issues into supervised tmux panes, each with its own git worktree and a Codex or Claude agent prompt for draft PR creation. Works with GitHub issues natively; GitLab and Azure Boards via their CLIs.
---

# Issue Killer

Use this skill when the user wants parallel supervised issue-solving agents across multiple worktrees.

## Workflow

1. Require either explicit issue URLs/IDs or an opt-in label. Do not select arbitrary open issues.
2. Fetch the opted-in issues with the platform CLI:

```bash
# GitHub
gh issue list --label agentify-ready --state open --limit 5 --json number,title,url

# GitLab
glab issue list --label agentify-ready --output json | head -c 20000

# Azure Boards
az boards query --wiql "SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.Tags] CONTAINS 'agentify-ready' AND [System.State] = 'New'" -o json
```

3. For each selected issue, create an isolated worktree on a fresh branch (use Worktrunk `wt` if the repo standardizes on it, otherwise plain git):

```bash
git worktree add ../<repo>-issue-<N> -b issue/<N>-<slug> origin/<default-branch>
```

4. Launch one tmux pane per issue inside its worktree, running an interactive agent seeded with the issue context:

```bash
tmux new-session -d -s issue-killer
tmux new-window -t issue-killer -n "issue-<N>" -c ../<repo>-issue-<N>
tmux send-keys -t issue-killer:"issue-<N>" \
  'claude "Work GitHub issue #<N>: <title>. Read the issue with gh issue view <N>. Implement, verify with the repo test suite, commit, and open a DRAFT pull request. Do not merge or force-push."' Enter
```

   Use `codex` instead of `claude` when the user prefers Codex panes. Respect `agentify models` routing when the user has no preference: implementation panes default to the `implement` route's provider.

5. After launch, tell the user how to supervise:

```bash
tmux attach -t issue-killer
```

6. Record the fan-out in context so later sessions know what is in flight:

```bash
agentify ctx note "issue-killer: launched issues <N1>,<N2> into worktrees; draft PRs expected"
```

## Guardrails

- Issues must be selected by an opt-in label or explicit URLs/IDs — never arbitrary open issues.
- Create the worktree before launching the pane; one worktree per issue, never shared.
- Each worktree gets its own `.agentify/` context store; notes and tracking stay per-checkout.
- Panes run interactive agents so the user can intervene; warn the user before launching panes with permission bypass, and only do so when they explicitly ask.
- Agents should create draft PRs (GitHub `--draft`, GitLab `--draft`, Azure `--draft true`) by default.
- Do not force-push, merge, or mark PRs ready for review unless the user explicitly asks.
- Clean up merged worktrees with `git worktree remove` when the user asks to wrap up.
