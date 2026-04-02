# Bottleneck Issues Backlog (Derived from QNA §21/§22)

This document maps each bottleneck from `QNA.md` sections **21** and **22** into a ready-to-publish GitHub issue draft.

## 1) [feature] Add multi-language semantic adapters (Python/Go/Java/.NET)

### Problem
Semantic enrichment is currently TS/JS-first, which creates uneven planning/query quality across non-TS/JS repositories.

### Why this matters in code today
- Semantic refresh and worker pipeline are currently TypeScript/JavaScript-centric (`semantic.tsjs.*`, TS worker, TS project discovery).
- Planner/query can consume semantic facts, but only where those facts exist.

### Proposed solution (efficient path)
1. Introduce a semantic adapter interface with a normalized output contract (`projects`, `symbols`, `edges`, `surfaces`, `packages`).
2. Keep existing TS/JS implementation as adapter #1 (`tsjs`) to avoid regressions.
3. Add Python adapter first (AST + import/call graph lite), then Go, then Java/.NET.
4. Persist outputs in existing semantic tables where possible; add minimal schema extension only for language-specific metadata.
5. Extend `semantic refresh` to iterate adapters selected by config/language detection.

### Acceptance criteria
- Running semantic refresh on Python/Go/Java/.NET repos stores non-zero semantic projects, symbols, and edges.
- Planner ranking uses those facts with measurable improvement over structural-only baseline.
- Existing TS/JS behavior remains backward compatible.

### Verification checklist
- `agentify semantic refresh` on at least one repo per new language.
- `agentify query search <symbol>` returns semantic-backed hits.
- `agentify plan "task" --json` shows semantic contribution metadata.

### Implementation hints
- Start from `src/core/semantic.js` refresh orchestration and `src/core/semantic-worker.js` TS extraction.
- Reuse `loadSemanticPlannerFacts` / semantic dependency loaders already consumed by planner and query.

---

## 2) [feature] Add explainable planning mode (`agentify plan --explain`)

### Problem
Planner selection is deterministic but rationale is too compact, causing black-box perception.

### Why this matters in code today
- Scoring reasons exist internally (`pushReason` in module/file/symbol scoring), but there is no first-class explain output mode.

### Proposed solution (efficient path)
1. Add `--explain` flag to `plan` CLI.
2. Return score decomposition by dimension:
   - lexical/token match,
   - dependency proximity,
   - semantic boost,
   - changed-file/recency boosts,
   - final weighted score.
3. Keep default concise output unchanged; explain mode emits verbose table/JSON.
4. Add stable reason codes (machine-parseable) plus human labels.

### Acceptance criteria
- `agentify plan --explain` emits per-file and per-symbol scoring breakdown.
- Output available in text and JSON modes.
- Existing `plan` output remains unchanged when flag omitted.

### Verification checklist
- Compare `agentify plan "task"` vs `agentify plan "task" --explain`.
- Validate reason-code stability with tests.

### Implementation hints
- Thread reason metadata from `scoreModule`, `scoreFile`, and `scoreSymbol` through final selection and renderers.

---

## 3) [feature] Add semantic health diagnostics (`agentify doctor --semantic`)

### Problem
Optional semantic mode is often underused because teams lack visibility into health, staleness, and coverage.

### Why this matters in code today
- Doctor currently prints a compact semantic summary when semantic mode is enabled, but there is no dedicated deep-diagnostic command path.

### Proposed solution (efficient path)
1. Add `doctor --semantic` mode with detailed sections:
   - discovered projects,
   - last refresh timestamp,
   - stale fingerprints,
   - parse/analysis failures,
   - symbol/edge/surface counts and coverage trend.
2. Add exit codes for CI:
   - non-zero when semantic is enabled but coverage is below threshold or projects are stale/failed.
3. Emit both human and JSON diagnostics.

### Acceptance criteria
- Command reports per-project health and actionable remediation.
- CI can gate on stale/failing semantic projects.
- JSON schema documented and tested.

### Verification checklist
- Run on healthy and intentionally-broken semantic projects.
- Validate CI behavior by toggling stale/failure scenarios.

### Implementation hints
- Build on existing semantic project list + validator checks; consolidate into one diagnostics view.

---

## 4) [feature] Expand LSP-bridge query commands (def/refs/callers/impacts)

### Problem
LSP-style parity is partial; query UX lacks direct navigation commands expected by engineers.

### Why this matters in code today
- Query currently exposes owner/deps/changed/search; semantic tables already store symbol and edge data.

### Proposed solution (efficient path)
1. Add query subcommands:
   - `query def --symbol <name>`
   - `query refs --symbol <name>`
   - `query callers --symbol <name>`
   - `query impacts --file <path>`
2. Resolve symbols deterministically with fallback disambiguation prompts in JSON/text.
3. For callers/impacts, traverse semantic edges with optional depth limit.
4. Keep results bounded and rank by confidence to avoid noisy outputs.

### Acceptance criteria
- New commands return deterministic, test-covered results from semantic tables.
- Works with TS/JS immediately; automatically improves as new adapters land.

### Verification checklist
- Add fixture tests for each subcommand.
- Validate output stability across repeated runs.

### Implementation hints
- Leverage existing semantic edge/schema access in `src/core/query.js` and command wiring in `src/core/commands.js` / `src/cli.js`.

---

## 5) [feature] Add `agentify handoff` bundle for cross-agent collaboration

### Problem
Session manifests are useful but handoff ergonomics and parallel-work conflict visibility can be improved.

### Why this matters in code today
- Session artifacts include context/bootstrap/checklist, but no dedicated “next best action + risk/conflict” package command.

### Proposed solution (efficient path)
1. Introduce `agentify handoff` command to generate a deterministic bundle:
   - top-ranked context,
   - touched symbol neighborhood,
   - recommended tests,
   - unresolved risks/TODOs,
   - potential overlap/conflict with recent sessions.
2. Write output under `.agents/session/<id>/handoff.md` + JSON companion.
3. Add optional `--from <session>` and `--for <provider>` tuning.

### Acceptance criteria
- Handoff command produces reproducible markdown + JSON artifacts.
- Bundle includes explicit “next actions” and conflict warnings.

### Verification checklist
- Create session, run handoff, resume/fork, and confirm improved continuity.
- Validate conflict detection with overlapping file sets.

### Implementation hints
- Compose from existing session context fitting, planner selection, and query dependency data.

---

## 6) [feature] Add PR risk/regression prediction from dependency + semantic graph

### Problem
Feedback loop from code change to likely blast radius and test prioritization is still manual.

### Why this matters in code today
- Graph/dependency data exists, but no explicit risk score or prioritized regression test output.

### Proposed solution (efficient path)
1. Build a risk model using:
   - module dependency fan-out,
   - semantic edge centrality,
   - changed-file hotness,
   - historical test touchpoints (when available).
2. Add `agentify risk` (or `agentify check --risk`) to emit:
   - risk score,
   - impacted modules/files/symbols,
   - prioritized test command list.
3. Integrate with run/check summary artifacts.

### Acceptance criteria
- Command emits deterministic risk report and suggested tests.
- CI/test workflows can consume JSON output.

### Verification checklist
- Validate on sample PRs with known high/low blast radius.
- Ensure suggestions align with dependency and semantic neighborhoods.

### Implementation hints
- Reuse module graph construction and semantic edge queries from existing planner/query infrastructure.

---

## Suggested `gh` publish loop (when CLI/network is available)

```bash
while IFS= read -r title; do
  body_file="/tmp/${title//[^a-zA-Z0-9]/_}.md"
  # write corresponding section body to $body_file
  gh issue create --title "$title" --body-file "$body_file" --label feature
done <<'TITLES'
[feature] Add multi-language semantic adapters (Python/Go/Java/.NET)
[feature] Add explainable planning mode (`agentify plan --explain`)
[feature] Add semantic health diagnostics (`agentify doctor --semantic`)
[feature] Expand LSP-bridge query commands (def/refs/callers/impacts)
[feature] Add `agentify handoff` bundle for cross-agent collaboration
[feature] Add PR risk/regression prediction from dependency + semantic graph
TITLES
```
