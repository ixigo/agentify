## Problem
Agentify has semantic tables but lacks ergonomic LSP-like query commands for common navigation operations.

## Current code touchpoints
- Query supports `owner`, `deps`, `changed`, `search`.
- Semantic dependencies and search are already wired in query code.

## Proposed solution (efficient path)
1. Add:
   - `query def --symbol <name>`
   - `query refs --symbol <name>`
   - `query callers --symbol <name>`
   - `query impacts --file <path>`
2. Use deterministic symbol resolution with clear disambiguation behavior.
3. Traverse semantic edges with bounded depth and ranked output.

## Acceptance criteria
- New commands return deterministic, tested results from semantic data.
- TS/JS supported immediately; other languages improve as adapters land.

## Verification checklist
- Add fixtures/tests for each new subcommand.
- Validate output stability across repeated runs.
