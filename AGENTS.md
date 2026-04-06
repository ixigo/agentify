# AGENTS.md

## Mission
Analyze this repository and create high-quality GitHub issues for future engineering work.

The workflow is problem-first, not solution-first.

## Non-negotiable behavior
- Create GitHub issues directly using `gh issue create`.
- Create issues one by one.
- Each issue must describe only one problem.
- Do not bundle unrelated findings into one issue.
- Do not ask the human follow-up questions unless absolutely required to proceed.
- Gather enough evidence from the repository, tests, docs, configs, and git history to make each issue actionable for a later coding agent.
- Prefer fewer high-signal issues over many weak issues.
- Never write vague issues.
- Adapt to the stack, language, framework, and repository structure discovered during analysis.

## Issue quality bar
Every issue must:
- name specific files or modules
- include technical evidence
- explain impact
- include a starting path for implementation
- be understandable without human clarification
- be narrow enough for one follow-up agent
- avoid speculative claims without repository evidence
