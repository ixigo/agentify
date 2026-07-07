# Agentify Setup Prompt (paste to your agent)

Paste this into Claude Code (or any coding agent with shell access) inside the target repository:

```text
Set up Agentify in this repository.

1. Ensure prerequisites: Node.js 20+ and git. Install agentify if missing:
   npm install -g agentify
2. From the repo root, run: agentify install --json
   (Running inside Codex instead of Claude Code? Use: agentify install --provider codex --json,
   or agentify install --provider all --json to wire up both.)
   Confirm the output shows the managed guidance block (CLAUDE.md or AGENTS.md) and, for Claude
   Code, the hooks were written.
3. Build the structural index: agentify scan --json
4. Verify: agentify status --json and agentify check --json should both succeed.
5. Report what was installed and where (CLAUDE.md, .claude/settings.json, .agentify/).

Do not edit the managed block between <!-- agentify:begin --> and <!-- agentify:end --> by hand.
```

After setup, the agent will automatically:

- receive a context digest at every session start (SessionStart hook),
- have its file edits and commands tracked (PostToolUse hook),
- see guidance in CLAUDE.md for `agentify ctx note`, `agentify ctx handoff`, `agentify query`, and `agentify risk`,
- have model routing available: `agentify delegate quick|implement|heavy|review|research` shells work out to the best-suited model (`agentify models` shows the table).
