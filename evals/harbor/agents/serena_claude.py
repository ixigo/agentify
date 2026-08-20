"""Harbor installed agent: Claude Code with the Serena MCP server (competitor).

This is the `serena-claude` competitor arm of the head-to-head suite (plan
task 1.4). Serena (github.com/oraios/serena) is the widely-used free
code-intelligence MCP server — LSP-backed symbol navigation plus a
project-memory feature (markdown files under .serena/memories that its tools
can list and read). It is the closest open competitor to Agentify's
query/refs/impacts surface, which makes it the right first head-to-head arm.

Fairness contract (see docs/harbor.md "Competitor arms"): the SAME committed
fixture source every arm shares (/opt/agentify-fixtures, baked into the task
image) is rendered into Serena's native memory format at trial start — one
markdown memory with the notes/decisions and one with previously-failed
commands. No new fixture files are committed, so the dataset's answer-leak
validation keeps a single surface to scan. The provider invocation is
inherited byte-for-byte from AgentifyClaudeAgent (same model, budget, turn
cap, flags); the inherited AGENTIFY_* env vars are inert here.

EXPERIMENTAL ARM — honest caveats, disclosed rather than hidden:
- Serena is installed at a pinned version (see SERENA_VERSION) via uv, which
  bootstraps its own Python; its LSP language servers may download on first
  use inside the trial container (network is available — the same network
  the npm installs use). Startup latency counts against the arm's wall
  clock, as it would for a real user.
- A trial where Serena's MCP server fails to start degrades to plain Claude
  Code with memory files on disk; the import marks nothing special. Read
  per-attempt trajectories before quoting a Serena number in public.

Written against harbor 0.18.0 (see dataset.json pins).
"""

import os

from agents.agentify_claude import (
    DEFAULT_CLAUDE_CODE_VERSION,
    AgentifyClaudeAgent,
)

# Pinned competitor version (PyPI serena-agent; requires Python 3.11-3.14,
# which uv provisions itself). Env override mirrors the other pins.
SERENA_VERSION = os.environ.get("AGENTIFY_EVAL_SERENA_VERSION", "1.7.0")

# Render the shared fixtures into Serena's native project memories. Node is in
# every task image (node:22 base).
_RENDER_SERENA_MEMORIES = r"""
cd /app && mkdir -p .serena/memories && if [ -d /opt/agentify-fixtures ]; then node -e '
const fs = require("fs");
const read = (name) => {
  try {
    return fs.readFileSync("/opt/agentify-fixtures/" + name, "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
};
const notes = read("notes.jsonl");
const failures = read("events.jsonl").filter((e) => e.type === "cmd" && e.fail);
if (notes.length) {
  const body = ["# Project decisions and gotchas from prior sessions", ""]
    .concat(notes.map((n) => "- " + (n.type === "decision" ? "[decision] " : "") + n.note));
  fs.writeFileSync(".serena/memories/project-history.md", body.join("\n") + "\n");
}
if (failures.length) {
  const body = ["# Commands that failed in earlier sessions", ""]
    .concat(failures.map((f) => "- `" + f.cmd + "`" + (f.err ? " — " + f.err : "")));
  fs.writeFileSync(".serena/memories/failed-commands.md", body.join("\n") + "\n");
}
'; fi
"""


class SerenaClaudeAgent(AgentifyClaudeAgent):
    """Claude Code + Serena MCP, seeded with the shared fixtures as memories."""

    @staticmethod
    def name() -> str:
        return "serena-claude"

    async def install(self, environment) -> None:
        # Pinned provider CLI; no Agentify in this arm.
        await self.exec_as_root(
            environment,
            "npm install -g --no-fund --no-audit "
            f"@anthropic-ai/claude-code@{DEFAULT_CLAUDE_CODE_VERSION}",
        )
        # uv bootstraps its own Python and puts the pinned serena on PATH for
        # every user via /usr/local/bin.
        await self.exec_as_root(
            environment,
            "curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh"
            " && UV_TOOL_BIN_DIR=/usr/local/bin uv tool install -p 3.13"
            f" serena-agent=={SERENA_VERSION}",
        )
        # Native memories from the shared fixture source, then register the
        # MCP server with Claude Code (local scope: written to the agent
        # user's ~/.claude.json for /app, connected without interactive
        # approval — the same reason the mcp-descriptions suite avoids
        # project-scope .mcp.json).
        await self.exec_as_agent(environment, _RENDER_SERENA_MEMORIES)
        await self.exec_as_agent(
            environment,
            "cd /app && claude mcp add serena --"
            " serena start-mcp-server --context ide-assistant --project /app",
        )
