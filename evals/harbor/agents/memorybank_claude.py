"""Harbor installed agent: Claude Code with a static "memory bank" CLAUDE.md.

This is the `memorybank-claude` competitor arm of the head-to-head suite
(plan task 1.4). It represents the zero-infrastructure practice popularized
by Cline-style memory banks and hand-maintained CLAUDE.md files: every piece
of prior-session knowledge is stuffed verbatim into CLAUDE.md, so the model
carries ALL of it in context on every turn — no store, no retrieval, no
budgeting, no staleness handling.

Fairness contract (see docs/harbor.md "Competitor arms"): this arm renders
the SAME committed fixture source every arm shares (/opt/agentify-fixtures,
baked into the task image) into its own native format at trial start. It
gets exactly the knowledge the agentify arm gets — durable notes/decisions
plus previously-failed commands — just delivered the memory-bank way. No new
fixture files are committed, so the dataset's answer-leak validation keeps a
single surface to scan.

The provider invocation is inherited byte-for-byte from AgentifyClaudeAgent
(same model, budget, turn cap, flags), so the ONLY differences under test
are what is installed in the repo and how the knowledge reaches the model.
The inherited AGENTIFY_* env vars are inert here — Agentify is never
installed in this arm.

Written against harbor 0.18.0 (see dataset.json pins).
"""

from agents.agentify_claude import (
    DEFAULT_CLAUDE_CODE_VERSION,
    AgentifyClaudeAgent,
)

# Renders the shared fixtures into a CLAUDE.md "memory bank" section. Node is
# already in every task image (they are node:22-based). Kept as one script so
# the whole render is a single exec: notes/decisions verbatim, plus the failed
# commands the events log remembers — the same knowledge classes Agentify's
# digest carries, with none of its selection or budgeting.
_RENDER_MEMORY_BANK = r"""
cd /app && if [ -d /opt/agentify-fixtures ]; then node -e '
const fs = require("fs");
const read = (name) => {
  try {
    return fs.readFileSync("/opt/agentify-fixtures/" + name, "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
};
const notes = read("notes.jsonl");
const failures = read("events.jsonl").filter((e) => e.type === "cmd" && e.fail);
const lines = ["", "## Project memory (prior sessions)", ""];
for (const n of notes) lines.push("- " + (n.type === "decision" ? "[decision] " : "") + n.note);
if (failures.length) {
  lines.push("", "### Commands that failed in earlier sessions", "");
  for (const f of failures) lines.push("- `" + f.cmd + "`" + (f.err ? " — " + f.err : ""));
}
fs.appendFileSync("CLAUDE.md", lines.join("\n") + "\n");
'; fi
"""


class MemoryBankClaudeAgent(AgentifyClaudeAgent):
    """Claude Code + the shared fixtures stuffed verbatim into CLAUDE.md."""

    @staticmethod
    def name() -> str:
        return "memorybank-claude"

    async def install(self, environment) -> None:
        # Pinned provider CLI only — no Agentify. The memory bank IS the tool.
        await self.exec_as_root(
            environment,
            "npm install -g --no-fund --no-audit "
            f"@anthropic-ai/claude-code@{DEFAULT_CLAUDE_CODE_VERSION}",
        )
        await self.exec_as_agent(environment, _RENDER_MEMORY_BANK)
