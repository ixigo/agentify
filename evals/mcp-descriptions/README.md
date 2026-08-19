# MCP tool-description ablation (#334)

A reproducible **paired** ablation of two description sets for Agentify's eight
MCP tools, measuring **tool-call rate** and **task outcome**:

- **Set A** — the current, shipped wording (`MCP_TOOL_DESCRIPTIONS.a` in
  `src/core/mcp-server.js`). The pairing baseline; arm label `agentify`.
- **Set B** — the same eight tools described **strictly as trigger conditions**
  ("When you are about to …, call this"). Opt-in, **not** the default; arm label
  `agentify-desc-b`.

Both sets have **identical tool names, schemas, and handlers** — only the
description string differs, so this isolates the description variable exactly as
#334 requires.

## How the arms are built (reused mechanism, not a new one)

This suite reuses the native harness's context-ablation arm mechanism
(`src/core/eval.js`): the same per-attempt env-toggle the context ablations use
(`AGENTIFY_CTX_INJECTION` / `AGENTIFY_CTX_BUDGET`). A task lists
`description_ablations: [a, b]`, and the `agentify` arm expands into:

| set | arm label         | env pinned per attempt        |
|-----|-------------------|-------------------------------|
| a   | `agentify`        | `AGENTIFY_MCP_DESCRIPTIONS=a`  |
| b   | `agentify-desc-b` | `AGENTIFY_MCP_DESCRIPTIONS=b`  |

`resolveDescriptionSet()` in the MCP server reads `AGENTIFY_MCP_DESCRIPTIONS`
(default `a`), so the spawned `agentify serve` renders the arm's set. The
`plain-safe` arm is the no-tools floor.

## The server is registered per arm — a missing server is an invalid run

#331 established that across 248 local sessions the Agentify MCP server was
**never registered**, so historically both arms would measure **zero** tool
calls and the ablation would be vacuous. Each task therefore sets
`mcp_tools: true`, which makes the harness:

1. **Register** the Agentify MCP server in every `agentify`-arm workspace via a
   project `.mcp.json` under the canonical alias `agentify` (so #331's
   `/agentify/i` detector attributes the calls). The server is the Agentify
   **under test** (`node <this repo>/src/cli.js serve`), not whatever is on
   `PATH` — otherwise a stale global install that ignores
   `AGENTIFY_MCP_DESCRIPTIONS` would serve set A to both arms;
2. **Assert availability as a precondition** before spending — the harness
   actually **launches the configured server and completes the MCP handshake**,
   requiring >0 tools *and* confirming the description text changes with the set
   (so A and B are genuinely different). After the run it also checks Claude's
   own init event (`mcp_servers[].status`) and marks the attempt **`invalid`**
   if Claude reported the server disconnected. Any `invalid` attempt is excluded
   from the pass-rate denominator (and from paired stats, the sign test, and the
   promptfoo export), never treated as a (misleading) zero-call pass/fail — an
   `agentify scan` index-build failure is treated the same way.

Three further safeguards keep the description the *only* variable under test on
`mcp_tools` arms: the tool definitions are **loaded upfront**
(`ENABLE_TOOL_SEARCH=false`) so the ablated text is in context from turn one
rather than hidden behind tool-search; Agentify's managed `CLAUDE.md` guidance
(which names the `agentify query` / `agentify risk` CLI) is **stripped** so the
MCP descriptions are the sole affordance and the agent cannot satisfy the task
via uncounted Bash CLI calls; and the structural index is built **after** setup
so `query` / `risk` are usable.

There is **no historical baseline** call rate to move (#331: unmeasurable from
local data, because the server was never registered). The **in-harness**
registration above is therefore the real baseline this ablation establishes.

## Measuring tool-call rate — #331 telemetry, not a second counter

Tool-call rate is measured with #331's telemetry
(`src/core/session-analysis/agentify-tools.js`, schema
`agentify-tool-telemetry-v1`), which detects `mcp__agentify__*` calls and
per-tool outcomes. So the events exist to detect, MCP-tool arms run the provider
with `--output-format stream-json --verbose`, and the harness persists the
captured event stream to `provider-stream.jsonl` per attempt (the compact
`provider-stdout.json` is only the final envelope, not a transcript). The
capture is bounded by the harness's output cap, so on a pathological, very long
attempt only the newest portion is retained; a 6–12 turn task is far under that
bound. This suite **depends on** #331's telemetry (it lands with PR #340); it is
deliberately **not** cherry-picked here and **no second counter is written**.

**Where the rate is computed (a deliberate dependency, not an omission):**
because #331's detector is not on this PR's base branch and #334 forbids a
second counter, this suite does **not** compute the tool-call rate in-repo. The
harness's job is to make the rate *measurable* — register the server, gate on
availability, and persist `provider-stream.jsonl` per attempt. Producing the
per-arm/per-tool counts is #331/#340's telemetry applied to those streams (its
`mcp__agentify__<tool>` detection rule), run once #340 lands. Until then — and
because #334 runs no paid experiments — the rate is intentionally unproduced,
consistent with "built but unexecuted." Outcome metrics (pass rate, cost) come
from `agentify eval report` as usual.

**Dependency status (was a gap, now closed):** #331's detector enumerates all
**eight** tools including `ctx_decisions` / `ctx_handoff`, and
`test/session-analysis.test.js` asserts its list equals `buildMcpTools()`'s so
the next added tool fails a test instead of drifting. The runner also now
persists a per-attempt tally (`mcp_precondition.claude_tool_calls` /
`claude_tool_errors`, from `inspectClaudeMcpConnection` in `eval.js`) and
`agentify eval report` aggregates it per arm (`arms.<arm>.mcp_tools`: call
rate, calls/attempt, errors) — so future runs measure the headline metric
in-repo. Attempts recorded before the tally existed are reported as
*unmeasured*, never as zero-call.

## The task set is weighted toward "calling is correct"

| task                     | correct-to-call situation                          |
|--------------------------|----------------------------------------------------|
| `query-before-edit`      | find every usage before a repo-wide rename         |
| `impact-before-done`     | confirm nothing dependent is left broken before finishing |
| `trivial-edit-no-lookup` | **over-trigger control** — a lookup is *unwarranted* |

Each `mcp_tools` arm builds a structural index (`agentify scan`) during setup so
`query` and `risk` are actually usable, and plants any needed fixture in setup
so the graders fail on an unchanged workspace (a no-op attempt cannot pass).

**Over-triggering is a reported failure mode, not just under-calling.** If set B
raises calls on `trivial-edit-no-lookup` (where no lookup is warranted), that is
a regression and must be reported alongside any under-calling it fixes.

A fourth task exercising `ctx_decisions` ("consult a settled decision before
proposing a direction") was intentionally left out: Agentify's own
`UserPromptSubmit` injection surfaces recorded decisions in the ambient digest
(`renderContextDigest` has a "Decisions on record" section), so a seeded
decision reaches the agentify arm without a `ctx_decisions` call — the trigger
could not be isolated and the fixture would leak the answer. Measuring that
trigger cleanly needs ambient injection disabled for the task (a follow-up), on
top of the #331 detector extension above.

Task instructions describe the *situation*, never a tool or a lookup, and are
machine-checked for tool-name leakage (see `test/mcp-description-ablation.test.js`,
consistent with Harbor's `answer_leak_patterns` practice).

## Running (validate / plan only — no paid runs here)

```sh
# Per-task plan and worst-case spend, no provider call:
agentify eval run evals/mcp-descriptions/query-before-edit.yaml --dry-run --json

# A real paired run (spends real money — not executed in #334):
agentify eval run evals/mcp-descriptions/query-before-edit.yaml
```

## Status: executed 2026-07-29 — no descriptions changed, adoption is the bottleneck

First paid runs executed 2026-07-29 (Claude Code 2.1.220, 6 runs, 39
attempts; receipts committed under `evals/results/native-20260729/` and
verified by `test/eval-receipts.test.js`):

| task | agentify (set A) | agentify-desc-b | plain-safe |
| --- | --- | --- | --- |
| query-before-edit | 2/3 | — | 3/3 |
| impact-before-done | 0/3 | — | 0/3 |
| trivial-edit-no-lookup (control) | 3/3 | — | 3/3 |
| query-before-edit-cap16 | 3/3 | — | 3/3 |
| impact-before-done-cap16 | 0/3 | — | 0/3 |
| query-before-edit-ablation-cap16 | 1/3 | 2/3 | 3/3 |
| **total** | **9/18** | **2/3** | **12/18** |

Findings, stated plainly:

1. **The premise was not reached: agents barely call the tools at all.** From
   the local provider streams, exactly one attempt made any
   `mcp__agentify__*` call (2 `query` calls) across the six runs' 39
   attempts — set A and set B alike. The ablation compared 0-vs-0 on its
   headline metric, so
   **neither description set is adopted** and set A remains the default by
   status quo, not by evidence. (This preliminary stream-derived rate is not
   receipt-backed — those attempts predate the per-attempt tally; see the
   campaign notes. Future runs record `claude_tool_calls` per attempt and
   `eval report` aggregates the per-arm call rate.)
2. **Agentify never beat plain-safe in these runs** (tied 4 tasks, lost 2,
   both arms 0/3 on both `impact-before-done` variants) and cost ≈19–160%
   more per task.
   With no tool calls, the agentify arm pays the MCP/context overhead and
   collects none of the value — consistent with, not contradicting, the
   adoption diagnosis above.
3. **Consequence shipped:** the server now sends initialize `instructions`
   (`MCP_SERVER_INSTRUCTIONS` in `mcp-server.js`) stating *when* to reach for
   each tool — a product change shared by both description sets, so this
   ablation continues to vary description wording only. Re-run the suite after
   the instructions change to measure whether the base call rate moves.

Both description sets remain snapshotted in
`test/mcp-description-ablation.test.js` so a later edit cannot silently drift
from the ablated text.
