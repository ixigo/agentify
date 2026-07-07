<!-- agentify:begin -->
## Agentify

Agentify provides lightweight context tracking and repo intelligence for this workspace.
File edits and commands are tracked automatically through hooks — do not log them manually.
Use these commands where they help:

- `agentify ctx load` — recent activity, notes, and hot files from earlier sessions. Run it when starting work if the session did not already inject it.
- `agentify ctx note "<text>"` — record a gotcha or open thread worth remembering in later sessions. Prefer this over ad-hoc scratch files.
- `agentify ctx decision "chose X over Y because Z"` — record a durable technical decision with its rationale. Query later with `agentify ctx decisions "<topic>"` before revisiting settled questions.
- `agentify ctx handoff` — write a handoff summary before ending a long task.
- If the user says to ignore previous context or start from scratch, disregard the injected digest; run `agentify ctx pause` when they want tracking off, `agentify ctx resume` to turn it back on, or `agentify ctx clear` to archive and reset the store.
- `agentify query search|def|refs|callers|impacts` — structural queries over the repo index (`agentify scan` rebuilds it if stale).
- `agentify risk --since <ref>` — blast radius and suggested regression tests before finishing a change.
- `agentify test --since <ref> --run` — select and run only the tests affected by the change instead of the full suite.

Model routing is configured (see `agentify models`). Shell out work to the model best suited for it instead of doing everything inline:

- `agentify delegate quick "<task>"` — small, low-impact edits and quick questions go to a fast, cheap model. Add `--write` to let it apply edits.
- `agentify delegate review --diff <ref>` — after completing a change, get an independent review from a different model vendor before finishing.
- `agentify delegate heavy "<task>"` — architecture questions and gnarly debugging go to the strongest model.
- `agentify delegate research "<question>"` — fast lookups and summaries.

For issue-board work (triage, pick up an item, implement in an isolated worktree, raise a draft PR), prebuilt platform workflows exist: `agentify workflow install` detects GitHub, GitLab, or Azure DevOps from the git remote and installs the skill bundle. `agentify workflow list` shows what each bundle does.

All commands support `--json` for machine-readable output.
<!-- agentify:end -->
