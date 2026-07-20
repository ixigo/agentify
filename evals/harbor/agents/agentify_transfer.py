"""Harbor installed agents: cross-vendor transfer (Codex writes -> Claude reads).

This is the cross-vendor arm of the "beat the paired benchmark" epic (#316).
It measures Agentify's single most defensible claim — *switch agents, keep the
repo's working memory* — which no single-vendor harness can score above zero on
by construction.

A two-phase (write -> recall) task is executed by TWO different providers: phase
A ("seed") is run by **Codex**, which records the runtime gotcha it discovers
via the installed `AGENTS.md` guidance (`agentify ctx note`); phase B (graded
"recall") is run by **Claude Code**, which recalls that finding through the
SessionStart digest and avoids the same bug. Only phase B is scored.

The **only** thing that bridges the two providers is Agentify's on-disk
`.agentify/context/` store. No provider transcript ever crosses the barrier:
Codex keeps its session under `CODEX_HOME`, Claude runs
`--no-session-persistence`, and neither reads the other's trajectory. This is
the same "hidden provider state is never replayed" invariant the whole dataset
holds to — here it also makes the transfer *vendor-neutral*, which is exactly
what a plain Claude-only or Codex-only harness cannot do.

Two arms live here:
  * ``AgentifyTransferAgent``   — Codex(seed) -> Claude(recall), store shared.
                                  Expected: pass.
  * ``CrossVendorNoMemoryAgent``— the identical flow with ``AGENTIFY_CTX=off``
                                  in both phases, so the store never bridges the
                                  barrier. Expected: fail. That gap is the whole
                                  comparison. (Reuses the exact switch
                                  ``agentify delegate`` uses to keep children
                                  memoryless.)

Credential reality (see docs/harbor.md): this arm needs BOTH vendors' creds
co-resident in the trial container — ``OPENAI_API_KEY`` (or an in-container
``CODEX_AUTH_JSON_SRC`` auth.json for subscription auth) for Codex, and the
same Claude contract as ``agentify_claude.py`` (``ANTHROPIC_API_KEY`` or
``CLAUDE_FORCE_OAUTH=1`` + ``CLAUDE_CODE_OAUTH_TOKEN``). The two-container relay
fallback for cred-isolated environments is documented in docs/harbor.md.

Not part of Agentify's npm runtime: this file is only ever imported by a locally
installed ``harbor`` CLI, e.g.

    harbor run -c suites/crossvendor.yaml

or directly:

    harbor run -p tasks -m anthropic/claude-haiku-4-5-20251001 \
        -a agents.agentify_transfer:AgentifyTransferAgent
"""

import os
import shlex

from agents.agentify_claude import (
    AgentifyClaudeAgent,
    DEFAULT_AGENTIFY_SPEC,
    DEFAULT_CLAUDE_CODE_VERSION,
    FIXTURES_PATH,
    SEED_INSTRUCTION_PATH,
    SEED_TRAJECTORY_PATH,
    TRAJECTORY_PATH,
)

# Env-overridable, mirroring DEFAULT_CLAUDE_CODE_VERSION / DEFAULT_AGENTIFY_SPEC
# in agentify_claude.py. Codex is not part of dataset.json's provenance pins
# (those cover the graded Claude arm); a CI matrix pins it here to keep the seed
# provider reproducible across runs.
DEFAULT_CODEX_SPEC = os.environ.get("AGENTIFY_EVAL_CODEX_SPEC", "@openai/codex@0.144.6")

# A writable CODEX_HOME inside the trial container, so Codex's session/rollout
# state stays isolated here and never becomes something the Claude phase reads.
CODEX_HOME = "/tmp/agentify-codex-home"
# Codex `--json` is a JSONL event stream, not a single result envelope; capture
# the final assistant message separately for provenance.
SEED_LAST_MESSAGE_PATH = "/logs/agent/seed-last-message.txt"
GRADED_LAST_MESSAGE_PATH = "/logs/agent/last-message.txt"

# Codex auth bootstrap, run inside the trial container before `codex exec`.
# Prefers a mounted auth.json (subscription / ChatGPT OAuth via `codex login`),
# else materializes one from OPENAI_API_KEY (API-key auth). Plain string literal
# (not str.format) so the JSON braces stay literal.
_CODEX_AUTH_SETUP = (
    "export CODEX_HOME=" + CODEX_HOME + ' && mkdir -p "$CODEX_HOME"'
    ' && if [ -n "${CODEX_AUTH_JSON_SRC:-}" ] && [ -f "${CODEX_AUTH_JSON_SRC}" ]; then'
    ' cp "${CODEX_AUTH_JSON_SRC}" "$CODEX_HOME/auth.json";'
    ' elif [ -n "${OPENAI_API_KEY:-}" ]; then'
    ' printf \'{"OPENAI_API_KEY": "%s"}\' "$OPENAI_API_KEY" > "$CODEX_HOME/auth.json";'
    " fi"
)


class AgentifyTransferAgent(AgentifyClaudeAgent):
    """Cross-vendor two-phase agent: Codex seeds, Claude recalls (default).

    Reuses the Claude auth contract, session-barrier flags, and cost provenance
    parsing from :class:`AgentifyClaudeAgent`; adds a Codex seed phase and the
    dual-provider install.
    """

    def __init__(self, *args, direction: str = "codex-to-claude",
                 codex_model: str = "gpt-5.6-terra", **kwargs):
        super().__init__(*args, **kwargs)
        if direction not in ("codex-to-claude", "claude-to-codex"):
            raise ValueError(
                f"direction must be 'codex-to-claude' or 'claude-to-codex', got {direction!r}"
            )
        self._direction = direction
        self._codex_model = codex_model
        self._seed_provider, self._graded_provider = (
            ("codex", "claude") if direction == "codex-to-claude" else ("claude", "codex")
        )

    @staticmethod
    def name() -> str:
        return "agentify-transfer"

    # Overridden by the no-memory baseline to force AGENTIFY_CTX=off; empty here.
    def _extra_run_env(self) -> dict:
        return {}

    def _codex_auth_env(self) -> dict:
        # Mirrors harbor's builtin Codex agent contract: default OPENAI_API_KEY;
        # opt into subscription auth by pointing CODEX_AUTH_JSON_SRC at an
        # auth.json already present in the container.
        env = {"CODEX_HOME": CODEX_HOME}
        api_key = (self._get_env("OPENAI_API_KEY") or "").strip()
        if api_key:
            env["OPENAI_API_KEY"] = api_key
        auth_src = (self._get_env("CODEX_AUTH_JSON_SRC") or "").strip()
        if auth_src:
            env["CODEX_AUTH_JSON_SRC"] = auth_src
        return env

    # -- command builders ---------------------------------------------------
    # Claude command mirrors AgentifyClaudeAgent.run's graded phase verbatim
    # (kept here so the base arm stays byte-identical and un-refactored).
    def _claude_command(self, prompt_arg: str, trajectory: str, turns: int,
                        *, tolerate_failure: bool) -> str:
        return (
            "mkdir -p /logs/agent && cd /app"
            " && claude -p {prompt} --output-format json"
            " --model {model} --max-budget-usd {budget} --max-turns {turns}"
            " --no-session-persistence --permission-mode acceptEdits"
            " > {trajectory}{tail}"
        ).format(
            prompt=prompt_arg,
            model=shlex.quote(self._claude_model),
            budget=self._max_budget_usd,
            turns=turns,
            trajectory=trajectory,
            tail=" 2>/dev/null || true" if tolerate_failure else "",
        )

    def _codex_command(self, prompt_arg: str, trajectory: str, last_message: str, turns: int,
                       *, tolerate_failure: bool) -> str:
        # Codex has no native dollar/turn cap (see provider-registry.js); the
        # container timeout and Agentify's pre-run check bound it. --dangerously-
        # bypass-approvals-and-sandbox lets it write files and run `agentify ctx
        # note` non-interactively — safe only because the trial IS the sandbox.
        run = (
            " codex exec --skip-git-repo-check --json"
            " --dangerously-bypass-approvals-and-sandbox -C /app"
            " --model " + shlex.quote(self._codex_model) +
            " --output-last-message " + last_message +
            " " + prompt_arg +
            " > " + trajectory +
            (" 2>/dev/null || true" if tolerate_failure else "")
        )
        return "mkdir -p /logs/agent && cd /app && " + _CODEX_AUTH_SETUP + " &&" + run

    # -- phases -------------------------------------------------------------
    async def _seed(self, environment) -> None:
        # Guarded by the seed file so single-phase tasks skip it; `|| true` so a
        # seed failure never fails the graded trial — the arm is measured by what
        # survives into phase B, not by phase A's own success.
        if self._seed_provider == "codex":
            body = self._codex_command(
                '"$(cat ' + SEED_INSTRUCTION_PATH + ')"',
                SEED_TRAJECTORY_PATH, SEED_LAST_MESSAGE_PATH, self._seed_max_turns,
                tolerate_failure=True,
            )
            env = {**self._codex_auth_env(), "AGENTIFY_PROFILE": self._profile,
                   "AGENTIFY_CTX_SESSION": "harbor-seed", "CLAUDE_SESSION_ID": "harborsd",
                   **self._extra_run_env()}
        else:
            body = self._claude_command(
                '"$(cat ' + SEED_INSTRUCTION_PATH + ')"',
                SEED_TRAJECTORY_PATH, self._seed_max_turns, tolerate_failure=True,
            )
            env = {**self._auth_env(), "AGENTIFY_PROFILE": self._profile,
                   "AGENTIFY_CTX_SESSION": "harbor-seed", **self._extra_run_env()}
        command = "if [ -f " + SEED_INSTRUCTION_PATH + " ]; then " + body + "; fi"
        await self.exec_as_agent(environment, command, env=env)

    async def _graded(self, instruction: str, environment) -> None:
        if self._graded_provider == "codex":
            command = self._codex_command(
                shlex.quote(instruction), TRAJECTORY_PATH, GRADED_LAST_MESSAGE_PATH,
                self._max_turns, tolerate_failure=False,
            )
            env = {**self._codex_auth_env(), "AGENTIFY_PROFILE": self._profile,
                   "AGENTIFY_CTX_SESSION": "harbor-trial", **self._extra_run_env()}
        else:
            command = self._claude_command(
                shlex.quote(instruction), TRAJECTORY_PATH, self._max_turns,
                tolerate_failure=False,
            )
            env = {**self._auth_env(), "AGENTIFY_PROFILE": self._profile,
                   "AGENTIFY_CTX_SESSION": "harbor-trial", **self._extra_run_env()}
        await self.exec_as_agent(environment, command, env=env)

    async def install(self, environment) -> None:
        # Task images are node:22-based; install BOTH provider CLIs and Agentify.
        await self.exec_as_root(
            environment,
            "npm install -g --no-fund --no-audit "
            f"@anthropic-ai/claude-code@{DEFAULT_CLAUDE_CODE_VERSION} "
            f"{DEFAULT_CODEX_SPEC} "
            f"{DEFAULT_AGENTIFY_SPEC}",
        )
        # Wire Agentify into the task repo for BOTH providers: AGENTS.md guidance
        # for Codex, CLAUDE.md + SessionStart hooks for Claude (additive —
        # different files). Then seed the fixtures as the repo's prior context.
        await self.exec_as_agent(
            environment,
            "cd /app && agentify install --provider claude"
            " && agentify install --provider codex"
            f" && if [ -d {FIXTURES_PATH} ]; then"
            " mkdir -p .agentify/context"
            f" && cp -R {FIXTURES_PATH}/. .agentify/context/; fi",
        )

    async def run(self, instruction: str, environment, context) -> None:
        # Phase A (seed) then phase B (graded recall). Providers are chosen by
        # direction; the store is the only thing that bridges them.
        await self._seed(environment)
        await self._graded(instruction, environment)

    def populate_context_post_run(self, context) -> None:
        # Reuse the base's best-effort Claude-envelope parsing for the graded
        # phase (a no-op when the graded provider is Codex, whose JSONL stream is
        # not a Claude result envelope — cost is then left unreported, never
        # zero). Then stamp the cross-vendor provenance the import needs.
        super().populate_context_post_run(context)
        seed_ran = (self.logs_dir / "seed-trajectory.json").exists()
        metadata = dict(getattr(context, "metadata", None) or {})
        # Codex reports no total_cost_usd; a Codex seed's cost is unreported. Only
        # keep a seed cost when the seed provider is Claude (the reverse arm).
        codex_seed = self._seed_provider == "codex"
        metadata.update({
            "direction": self._direction,
            "seed_provider": self._seed_provider,
            "graded_provider": self._graded_provider,
            "cross_vendor": self._seed_provider != self._graded_provider,
            # Two-phase for the import's cost/analysis path even when the Codex
            # seed leaves no parseable envelope.
            "multisession": seed_ran,
            "seed_cost_usd": None if codex_seed else metadata.get("seed_cost_usd"),
            "seed_num_turns": None if codex_seed else metadata.get("seed_num_turns"),
        })
        context.metadata = metadata


class CrossVendorNoMemoryAgent(AgentifyTransferAgent):
    """No-memory baseline: the identical Codex->Claude flow with the context
    layer switched off. ``AGENTIFY_CTX=off`` makes ``isContextPaused`` true, so
    the SessionStart digest injects nothing in the graded phase — Claude never
    sees Codex's finding. Same providers, same order, same budget: the ONLY
    difference is the memory layer, which is exactly what a single-vendor harness
    lacks. Its name carries no "agentify" substring, so it imports as its own
    baseline arm (not the agentify arm).
    """

    @staticmethod
    def name() -> str:
        return "crossvendor-nomem"

    def _extra_run_env(self) -> dict:
        return {"AGENTIFY_CTX": "off"}
