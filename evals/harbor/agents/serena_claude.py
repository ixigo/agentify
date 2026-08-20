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
- run() preflights the MCP connection (`claude mcp list`) and ABORTS the
  trial before any graded token is spent when Serena is not connected —
  the exception then imports as a zero-activity harness error, excluded
  from the arm's statistics as non-gradeable infrastructure failure, so a
  plain-Claude pass can never be attributed to Serena and a broken server
  can never dilute Serena's numbers (PR review, plan task 1.4).

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
// FULL knowledge parity with what Agentify holds: every note, every edited
// file, and EVERY recorded command (not just failures) — an informative
// successful command must not be knowledge only one arm can see (PR review,
// plan task 1.4).
const notes = read("notes.jsonl");
const events = read("events.jsonl");
const edits = new Map();
for (const e of events) if (e.type === "edit" && e.path) edits.set(e.path, (edits.get(e.path) || 0) + 1);
const cmds = events.filter((e) => e.type === "cmd" && e.cmd);
if (notes.length) {
  const body = ["# Project decisions and gotchas from prior sessions", ""]
    .concat(notes.map((n) => "- " + (n.type === "decision" ? "[decision] " : "") + n.note));
  fs.writeFileSync(".serena/memories/project-history.md", body.join("\n") + "\n");
}
if (edits.size || cmds.length) {
  const body = ["# Activity from earlier sessions", ""];
  if (edits.size) {
    body.push("## Files edited", "");
    for (const [file, count] of edits) body.push("- " + file + (count > 1 ? " (" + count + " edits)" : ""));
  }
  if (cmds.length) {
    body.push("", "## Commands run", "");
    for (const c of cmds) body.push("- `" + c.cmd + "`" + (c.fail ? " — FAILED" + (c.err ? ": " + c.err : "") : ""));
  }
  fs.writeFileSync(".serena/memories/prior-activity.md", body.join("\n") + "\n");
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
        # Task images are node:22-bookworm-slim with no curl — install it
        # first (root, same apt the images already used for git/python3).
        # uv then bootstraps its own Python and puts the pinned serena on
        # PATH for every user via /usr/local/bin.
        await self.exec_as_root(
            environment,
            "apt-get update && apt-get install -y --no-install-recommends curl"
            " && curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh"
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
            " serena start-mcp-server --context claude-code --project /app",
        )

    async def run(self, instruction: str, environment, context) -> None:
        # Preflight: the trial is only a Serena trial if Claude actually holds
        # a connected Serena server. `claude mcp list` health-checks each
        # registered server; if serena is not connected, abort BEFORE spending
        # any graded token — the trial then imports as a zero-activity harness
        # error (non-gradeable infrastructure failure), never as a
        # plain-Claude result wearing Serena's name.
        # The health line must positively assert success AND carry no failure
        # marker: `claude mcp list` prints "✗ Failed to connect" on failure,
        # which a naive `grep -i connect` would happily match.
        await self.exec_as_agent(
            environment,
            "cd /app && mkdir -p /logs/agent"
            " && claude mcp list > /logs/agent/mcp-list.txt 2>&1 || true"
            " && serena_line=$(grep -i serena /logs/agent/mcp-list.txt || true)"
            " && if ! printf '%s' \"$serena_line\" | grep -qiE 'connected|✓'"
            " || printf '%s' \"$serena_line\" | grep -qiE 'fail|✗|error'; then"
            " echo 'serena MCP not connected — aborting trial as infrastructure failure' >&2;"
            " cat /logs/agent/mcp-list.txt >&2; exit 47; fi",
            env=self._auth_env(),
        )
        await super().run(instruction, environment, context)
