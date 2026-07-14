"""Harbor installed agent: Claude Code with Agentify installed and seeded.

This is the `agentify-claude` arm of the paired benchmark (#298). It runs on
the exact same task image, model, and budget as Harbor's plain `claude-code`
agent; the only difference is that Agentify is installed in the task repo
(hooks + managed CLAUDE.md guidance) and the task's context fixtures — baked
into every image at /opt/agentify-fixtures — are moved into the live
.agentify/context store before the provider starts.

Not part of Agentify's npm runtime: this file is only ever imported by a
locally installed `harbor` CLI, e.g.

    harbor run -p tasks -m anthropic/claude-haiku-4-5-20251001 \
        -a agents.agentify_claude:AgentifyClaudeAgent

Versions are pinned via evals/harbor/dataset.json; bump them deliberately and
re-run the smoke suite, never implicitly.
"""

import json
import os
import shlex

from harbor.agents.installed.base import BaseInstalledAgent

# Keep in sync with dataset.json pins; `agentify eval harbor validate` checks
# the manifest, and this module reads the same pins via env overrides so a CI
# matrix can test a release candidate without editing committed files.
DEFAULT_CLAUDE_CODE_VERSION = os.environ.get("AGENTIFY_EVAL_CLAUDE_CODE_VERSION", "2.1.208")
# Full npm install spec, not just a version: until Agentify is published to
# the npm registry under this name, point it at a git ref or tarball, e.g.
# AGENTIFY_EVAL_AGENTIFY_SPEC="github:ixigo/agentify#<commit>".
DEFAULT_AGENTIFY_SPEC = os.environ.get("AGENTIFY_EVAL_AGENTIFY_SPEC", "agentify@0.4.0")

FIXTURES_PATH = "/opt/agentify-fixtures"
TRAJECTORY_PATH = "/tmp/agentify-claude-trajectory.json"


class AgentifyClaudeAgent(BaseInstalledAgent):
    """Claude Code + Agentify, seeded with the task's context fixtures."""

    def __init__(self, *args, profile: str = "balanced", max_budget_usd: float = 0.30,
                 max_turns: int = 12, **kwargs):
        super().__init__(*args, **kwargs)
        self._profile = profile
        self._max_budget_usd = max_budget_usd
        self._max_turns = max_turns

    @staticmethod
    def name() -> str:
        return "agentify-claude"

    @property
    def _claude_model(self) -> str:
        # Harbor model ids are provider-prefixed (anthropic/claude-...); the
        # claude CLI wants the bare model id.
        model = self.model_name or ""
        return model.split("/", 1)[1] if "/" in model else model

    async def install(self, environment) -> None:
        # Task images are node:20-based (see dataset Dockerfiles), so npm is
        # already present; install the pinned provider CLI and Agentify.
        await self.exec_as_root(
            environment,
            "npm install -g --no-fund --no-audit "
            f"@anthropic-ai/claude-code@{DEFAULT_CLAUDE_CODE_VERSION} "
            f"{DEFAULT_AGENTIFY_SPEC}",
        )
        # Wire Agentify into the task repo (hooks + managed CLAUDE.md block),
        # then seed the fixtures as the repo's prior context. The fixtures are
        # baked into the shared image, so the plain claude-code arm runs the
        # identical image and simply never touches them.
        await self.exec_as_agent(
            environment,
            "cd /app && agentify install --provider claude"
            f" && if [ -d {FIXTURES_PATH} ]; then"
            " mkdir -p .agentify/context"
            f" && cp -R {FIXTURES_PATH}/. .agentify/context/; fi",
        )

    async def run(self, instruction: str, environment, context) -> None:
        env = {
            "AGENTIFY_PROFILE": self._profile,
            # Attempt telemetry must describe this trial only.
            "AGENTIFY_CTX_SESSION": "harbor-trial",
        }
        command = (
            "cd /app && claude -p {instruction} --output-format json"
            " --model {model} --max-budget-usd {budget} --max-turns {turns}"
            " --no-session-persistence --permission-mode acceptEdits"
            " > {trajectory}"
        ).format(
            instruction=shlex.quote(instruction),
            model=shlex.quote(self._claude_model),
            budget=self._max_budget_usd,
            turns=self._max_turns,
            trajectory=TRAJECTORY_PATH,
        )
        await self.exec_as_agent(environment, command, env=env)
        await environment.download_file(TRAJECTORY_PATH, self.logs_dir / "trajectory.json")

    def populate_context_post_run(self, context) -> None:
        # Parse the Claude JSON result envelope for cost/token provenance.
        # Every field is best-effort: a missing trajectory must never fail a
        # graded trial, it just leaves cost unreported (the Agentify import
        # treats that as "unreported", never as zero).
        trajectory_path = self.logs_dir / "trajectory.json"
        try:
            envelope = json.loads(trajectory_path.read_text())
        except (OSError, ValueError):
            return
        if isinstance(envelope, list):
            envelope = next(
                (entry for entry in reversed(envelope)
                 if isinstance(entry, dict) and entry.get("type") == "result"),
                {},
            )
        if not isinstance(envelope, dict):
            return
        usage = envelope.get("usage") or {}
        try:
            context.n_input_tokens = int(usage.get("input_tokens") or 0)
            context.n_output_tokens = int(usage.get("output_tokens") or 0)
            context.n_cache_read_tokens = int(usage.get("cache_read_input_tokens") or 0)
        except (AttributeError, TypeError, ValueError):
            pass
        cost = envelope.get("total_cost_usd")
        if isinstance(cost, (int, float)):
            try:
                context.cost = float(cost)
            except (AttributeError, TypeError):
                pass
