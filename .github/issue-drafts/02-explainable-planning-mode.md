## Problem
Planner decisions are deterministic but not sufficiently explainable, creating black-box behavior for users.

## Current code touchpoints
- `scoreModule` / `scoreFile` / `scoreSymbol` accumulate reasons internally.
- Current plan output does not expose full per-item score decomposition.

## Proposed solution (efficient path)
1. Add `agentify plan --explain`.
2. Output per-module/file/symbol score components:
   - lexical/token match
   - dependency proximity
   - semantic contribution
   - recency/changed-file boost
3. Keep default output unchanged when `--explain` is omitted.
4. Add stable reason codes for JSON consumers.

## Acceptance criteria
- `--explain` provides deterministic, complete score breakdowns in text and JSON.
- Existing non-explain output remains unchanged.

## Verification checklist
- Compare normal plan vs explain output.
- Add tests to lock reason-code format.
