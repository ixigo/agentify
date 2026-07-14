"""Harbor installed agent: Claude Code with Agentify installed and seeded.

This is the `agentify-claude` arm of the paired benchmark (#298). It runs on
the exact same task image, model, and budget as Harbor's plain `claude-code`
agent; the only difference is that Agentify is installed in the task repo
(hooks + managed CLAUDE.md guidance) and the task's context fixtures — baked
into every image at /opt/agentify-fixtures — are moved into the live
.agentify/context store before the provider starts.

Written against harbor 0.18.0 (see dataset.json pins). Not part of
Agentify's npm runtime: this file is only ever imported by a locally
installed `harbor` CLI, e.g.

    harbor run -p tasks -m anthropic/claude-haiku-4-5-20251001 \
        -a agents.agentify_claude:AgentifyClaudeAgent

Auth (mirrors the builtin claude-code agent): ANTHROPIC_API_KEY when set;
subscription OAuth via CLAUDE_FORCE_OAUTH=1 + CLAUDE_CODE_OAUTH_TOKEN
(from `claude setup-token`).
"""

import json
import os
import shlex

from harbor.agents.installed.base import BaseInstalledAgent

# Keep in sync with dataset.json pins; env overrides let a CI matrix test a
# release candidate without editing committed files.
DEFAULT_CLAUDE_CODE_VERSION = os.environ.get("AGENTIFY_EVAL_CLAUDE_CODE_VERSION", "2.1.208")
# Full npm install spec, not just a version: until Agentify is published to
# the npm registry under this name, point it at a git ref or tarball, e.g.
# AGENTIFY_EVAL_AGENTIFY_SPEC="github:ixigo/agentify#<commit>".
DEFAULT_AGENTIFY_SPEC = os.environ.get("AGENTIFY_EVAL_AGENTIFY_SPEC", "agentify@0.4.0")

FIXTURES_PATH = "/opt/agentify-fixtures"
# /logs/agent is synced back to the trial's agent/ directory on the host, so
# populate_context_post_run can read it from self.logs_dir without an
# explicit download step.
TRAJECTORY_PATH = "/logs/agent/trajectory.json"


class AgentifyClaudeAgent(BaseInstalledAgent):
    """Claude Code + Agentify, seeded with the task's context fixtures."""

    def __init__(self, *args, profile: str = "balanced", max_budget_usd: float = 0.35,
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

    def _auth_env(self) -> dict:
        # Same contract as harbor's builtin claude-code agent: the API key
        # wins by default; CLAUDE_FORCE_OAUTH=1 drops it so the CLI uses the
        # subscription token from `claude setup-token`.
        oauth_token = (self._get_env("CLAUDE_CODE_OAUTH_TOKEN") or "").strip()
        force_oauth = (self._get_env("CLAUDE_FORCE_OAUTH") or "").strip().lower() not in ("", "0", "false")
        if force_oauth and not oauth_token:
            raise RuntimeError(
                "CLAUDE_FORCE_OAUTH is set but CLAUDE_CODE_OAUTH_TOKEN is not. "
                "Run `claude setup-token` to get one, or unset CLAUDE_FORCE_OAUTH."
            )
        api_key = "" if force_oauth else (self._get_env("ANTHROPIC_API_KEY") or "")
        env = {
            "ANTHROPIC_API_KEY": api_key,
            "CLAUDE_CODE_OAUTH_TOKEN": oauth_token,
            # Telemetry off inside trial containers; sandbox flag lets the
            # CLI run non-interactively as the container user.
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "IS_SANDBOX": "1",
        }
        return {key: value for key, value in env.items() if value}

    async def install(self, environment) -> None:
        # Task images are node:22-based (see dataset Dockerfiles), so npm is
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
            **self._auth_env(),
            "AGENTIFY_PROFILE": self._profile,
            # Attempt telemetry must describe this trial only.
            "AGENTIFY_CTX_SESSION": "harbor-trial",
        }
        command = (
            "mkdir -p /logs/agent && cd /app"
            " && claude -p {instruction} --output-format json"
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

        def _tokens(*keys):
            total = 0
            found = False
            for key in keys:
                value = usage.get(key)
                if isinstance(value, (int, float)):
                    total += int(value)
                    found = True
            return total if found else None

        # AgentContext semantics (harbor 0.18.0): n_input_tokens includes
        # cache reads/writes; n_cache_tokens is the cached share.
        context.n_input_tokens = _tokens(
            "input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
        )
        context.n_cache_tokens = _tokens("cache_read_input_tokens")
        context.n_output_tokens = _tokens("output_tokens") if "output_tokens" in usage else None
        cost = envelope.get("total_cost_usd")
        if isinstance(cost, (int, float)):
            context.cost_usd = float(cost)
        context.metadata = {
            "agentify_profile": self._profile,
            "num_turns": envelope.get("num_turns"),
            "stop_subtype": envelope.get("subtype"),
        }
