## Problem
Blast-radius estimation and regression test prioritization are still mostly manual.

## Current code touchpoints
- Dependency and semantic graph data already exists.
- No unified risk scoring or prioritized regression recommendation command.

## Proposed solution (efficient path)
1. Add risk model using dependency fan-out + semantic edge centrality + changed-file signals.
2. Add `agentify risk` (or `check --risk`) command with:
   - risk score
   - impacted modules/files/symbols
   - prioritized test command list
3. Expose text + JSON outputs for CI and run summaries.

## Acceptance criteria
- Deterministic risk report and prioritized test recommendations.
- JSON output stable enough for automation.

## Verification checklist
- Validate high/low-risk fixture scenarios.
- Confirm alignment with graph neighborhoods.
