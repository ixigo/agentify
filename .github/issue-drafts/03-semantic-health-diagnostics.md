## Problem
Semantic mode is optional and underused because teams cannot quickly assess semantic freshness/coverage/failures.

## Current code touchpoints
- Doctor shows a compact semantic summary only when semantic mode is enabled.
- Validator has semantic status/coverage checks but no deep diagnostic report.

## Proposed solution (efficient path)
1. Add `agentify doctor --semantic` detail mode with:
   - discovered projects
   - stale fingerprints
   - parse/analysis failures
   - symbol/surface/edge counts and trend hints
2. Add machine-readable JSON output.
3. Add CI-friendly exit codes for stale/failing semantic projects.

## Acceptance criteria
- Per-project semantic health with actionable remediation.
- JSON output is stable and test-covered.
- CI can fail on stale/failing semantic conditions.

## Verification checklist
- Validate on healthy and intentionally broken semantic fixtures.
- Validate CI gating behavior.
