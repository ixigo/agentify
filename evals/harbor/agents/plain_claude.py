"""Harbor installed agent: pinned plain Claude Code (head-to-head baseline).

The head-to-head suite cannot use Harbor's builtin `claude-code` agent as its
baseline: the builtin pins no Claude Code version, applies no turn cap, and
runs with a different permission mode — so arm differences would be
confounded by provider configuration, not tool value (PR review, plan task
1.4). This arm subclasses AgentifyClaudeAgent so the provider invocation is
the SAME CODE as every other arm — same pinned CLI version, model, budget,
turn cap, permission mode — and overrides install() to put nothing in the
repo: no Agentify, no memory bank, no MCP server. The inherited AGENTIFY_*
env vars are inert without Agentify installed.

Written against harbor 0.18.0 (see dataset.json pins).
"""

from agents.agentify_claude import (
    DEFAULT_CLAUDE_CODE_VERSION,
    AgentifyClaudeAgent,
)


class PlainClaudeAgent(AgentifyClaudeAgent):
    """Pinned Claude Code, nothing else — the parity baseline."""

    @staticmethod
    def name() -> str:
        return "plain-claude"

    async def install(self, environment) -> None:
        await self.exec_as_root(
            environment,
            "npm install -g --no-fund --no-audit "
            f"@anthropic-ai/claude-code@{DEFAULT_CLAUDE_CODE_VERSION}",
        )
