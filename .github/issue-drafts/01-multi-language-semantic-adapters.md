## Problem
Semantic coverage is TS/JS-first, so Python/Go/Java/.NET repos lack equivalent semantic depth for plan/query quality.

## Current code touchpoints
- Semantic orchestration is centered on `semantic.tsjs.*` and TS/JS refresh flow.
- Planner/query already consume semantic facts where present.

## Proposed solution (efficient path)
1. Add semantic adapter interface with normalized project/symbol/edge outputs.
2. Keep current TS/JS worker as first adapter.
3. Implement Python first, then Go, Java, and .NET.
4. Reuse existing semantic tables where possible; add minimal schema extensions only when required.

## Acceptance criteria
- Semantic refresh stores non-zero projects/symbols/edges for new language repos.
- Planner and query outputs show semantic signal in those repos.
- TS/JS behavior remains backward-compatible.

## Verification checklist
- Run semantic refresh on fixture repos for Python/Go/Java/.NET.
- Validate semantic-backed `query search` results.
- Validate planner quality uplift versus structural-only baseline.
