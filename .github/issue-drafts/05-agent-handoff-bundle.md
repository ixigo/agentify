## Problem
Session artifacts exist but cross-agent handoff and conflict visibility are not first-class.

## Current code touchpoints
- Session system emits manifest/context/bootstrap/checklist.
- No dedicated handoff artifact generator with next actions + conflict detection.

## Proposed solution (efficient path)
1. Add `agentify handoff` command.
2. Produce deterministic markdown + JSON bundle including:
   - top-ranked context
   - touched symbol neighborhood
   - recommended tests
   - unresolved risks/TODOs
   - overlap/conflict hints with recent sessions
3. Store under session artifact paths.

## Acceptance criteria
- Handoff outputs are reproducible and concise.
- Includes clear next actions and conflict signals.

## Verification checklist
- Create/fork/resume flows with handoff output validation.
- Verify conflict hints for overlapping touched files.
