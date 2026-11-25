"""Harbor installed agents: Agentify injection-FORMAT ablation arms (#400).

The 2026-08-21 store-size ladder left one question open: at 300-note stores
Agentify's budgeted injection (20/27) trails plain `CLAUDE.md` stuffing
(24/27), and the gap concentrates in a single scenario (retry-schedule, 3/9 vs
6/9). Retrieval plumbing was already ruled out by a token-free diagnostic
(`agentify ctx explain`): the task's needle is ranked and delivered. The two
surviving hypotheses were injection **FORMAT** — a compact matched digest
injected once at the prompt vs. the same knowledge rendered in full and present
on every turn — and plain noise at n=9/scenario.

This module adds the two format arms that decompose that hypothesis. Both reuse
AgentifyClaudeAgent's install (pinned Claude Code + Agentify + the shared
`/opt/agentify-fixtures` seeded into `.agentify/context`), model, budget, turn
cap, flags, and cost provenance — so the ONLY thing under test is how the SAME
selected knowledge reaches the model. Knowledge is held equal: every arm sees
the identical committed fixture store, and the baseline, full-note, and persist
arms all draw from Agentify's own per-task BM25 selection of it.

  * ``AgentifyFullNoteClaudeAgent`` (arm ``fullnote-claude``) — the baseline
    relevant-mode pipeline with the injection token budget lifted
    (``AGENTIFY_CTX_BUDGET`` huge), so every note that matches the prompt
    renders in full with no budget trimming. Tests the "compact digest vs full
    notes" half of the format hypothesis. It is a near-negative-control: the
    committed diagnostic shows the store300 selections already fit well under
    the default 1200-token budget (247 / 333 / 132 tokens used), so if the
    budget were silently dropping relevant notes this arm would separate from
    baseline, and if it is not, this arm confirms it empirically.

  * ``AgentifyPersistClaudeAgent`` (arm ``persist-claude``) — Agentify's SAME
    per-task selection (computed with `agentify ctx match "<instruction>"`),
    but written into `CLAUDE.md` so it is present on EVERY model turn, with the
    SessionStart/UserPromptSubmit hook injection turned OFF so the persistent
    block is the sole delivery. Tests the "injected once at the prompt vs. read
    from a file every turn" half. In these single-prompt (`claude -p`) recall
    tasks there is only one user prompt, so "re-inject on every turn" has no
    second prompt to fire on; a persistent in-context file is the only
    hook-supported way to make the selection present on every turn, so that is
    what this arm measures.

Neither arm needs a product code change: both ride the existing
``AGENTIFY_CTX_BUDGET`` / ``AGENTIFY_CTX_INJECTION`` env overrides (the seams
the runtime already exposes "so eval context ablations flip behaviour per
attempt without touching the workspace's committed config") plus one
host-side render step. The CLAUDE.md-stuffing reference ceiling is the
existing ``memorybank-claude`` arm.

Arm naming note: Harbor's importer (`harborArmForAgent`) folds every agent
whose name contains "agentify" into the single "agentify" arm. These arms must
import as their OWN buckets, so their names deliberately carry no "agentify"
substring; the baseline AgentifyClaudeAgent remains the "agentify" arm the
report pairs each of them against.

Written against harbor 0.18.0 (see dataset.json pins).
"""

import shlex

from agents.agentify_claude import (
    AgentifyClaudeAgent,
    TRAJECTORY_PATH,
)

# A budget large enough that the selector never trims: the store300 selections
# render in a few hundred tokens, so 100k tokens is "no cap" in practice while
# staying a concrete, logged number rather than a magic sentinel.
_FULLNOTE_BUDGET_TOKENS = "100000"


class AgentifyFullNoteClaudeAgent(AgentifyClaudeAgent):
    """Baseline relevant-mode injection with the token budget lifted."""

    @staticmethod
    def name() -> str:
        return "fullnote-claude"

    def _extra_env(self) -> dict:
        # Lift the injection budget so the full matched set renders untrimmed.
        # resolveBudgetSettings reads AGENTIFY_CTX_BUDGET as the strongest
        # (env) override of max_injected_tokens.
        return {"AGENTIFY_CTX_BUDGET": _FULLNOTE_BUDGET_TOKENS}


class AgentifyPersistClaudeAgent(AgentifyClaudeAgent):
    """Agentify's per-task selection pinned into CLAUDE.md (present every turn).

    Overrides only the graded phase: these store tasks are single-phase (no
    `/opt/agentify-seed`), so there is no seed phase to preserve. The render
    reproduces the baseline's exact selection — `agentify ctx match` runs the
    same BM25 → budget pipeline against the same instruction and prints the same
    block the UserPromptSubmit hook would inject — then appends it to CLAUDE.md.
    The graded `claude -p` runs with AGENTIFY_CTX_INJECTION=off so the hook does
    NOT also inject it; the persistent file is the only channel. Selection and
    rendered content are thus held identical to baseline, and the ONLY variable
    is once-at-the-prompt vs. present-on-every-turn.
    """

    @staticmethod
    def name() -> str:
        return "persist-claude"

    async def run(self, instruction: str, environment, context) -> None:
        auth = self._auth_env()

        # Render Agentify's per-task selection for THIS instruction and append it
        # to CLAUDE.md. `ctx match` prints only the digest (or a no-context
        # line) and records nothing (recordInjection:false). `|| true` and the
        # emptiness/err guards keep a render miss from failing the graded trial:
        # a persist arm with an empty block simply degrades toward plain, which
        # is measured honestly, never as a harness error. FORCE_COLOR=0 keeps
        # ANSI codes out of the committed file.
        render_command = (
            "cd /app"
            " && agentify ctx match {prompt} --root /app > /tmp/agentify-match.txt 2>/dev/null || true"
            " && if [ -s /tmp/agentify-match.txt ]"
            " && ! grep -q 'No related context found' /tmp/agentify-match.txt; then"
            " { printf '\\n'; cat /tmp/agentify-match.txt; printf '\\n'; } >> CLAUDE.md; fi"
        ).format(prompt=shlex.quote(instruction))
        await self.exec_as_agent(environment, render_command, env={
            **auth,
            "AGENTIFY_PROFILE": self._profile,
            "FORCE_COLOR": "0",
            "NO_COLOR": "1",
        })

        # Graded recall — identical to the base graded phase, with hook injection
        # suppressed so the persistent CLAUDE.md block is the sole delivery.
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
        await self.exec_as_agent(environment, command, env={
            **auth,
            "AGENTIFY_PROFILE": self._profile,
            "AGENTIFY_CTX_SESSION": "harbor-trial",
            # The persistent CLAUDE.md block is the delivery; the hook must not
            # double-inject the same selection at the prompt.
            "AGENTIFY_CTX_INJECTION": "off",
        })
