# Reference

## Dependency Categories

Use one primary category per candidate and explain why.

### 1. Pure Domain

Deterministic logic over values and domain types.

- Hide rules, normalization, and state transitions
- Prefer passing plain data instead of services
- Good fit when many helper functions leak the underlying rules

### 2. Workflow Orchestration

A use case that coordinates several collaborators in sequence.

- Hide ordering, retries, fallbacks, and error mapping
- Good fit when tests mostly assert who calls whom
- Prefer boundary tests around the workflow entry point

### 3. Gateway / Adapter

A boundary around external systems or side effects.

- Hide transport details, serialization, file layout, CLI invocation, and caching
- Prefer narrow ports and stable return types
- Good fit when several callers repeat the same setup or translation steps

### 4. Policy / Convention

Rules that define what is allowed, preferred, or protected in the repo or product.

- Hide path rules, safety checks, config merging, feature gates, or naming rules
- Good fit when behavior depends on scattered defaults and guardrails
- Prefer a small interface that answers policy questions directly

## Dependency Strategies

Use one of these strategies, or combine them deliberately:

- `Value in, value out`: best for pure domain modules
- `Injected ports`: best for gateways or ports-and-adapters designs
- `Owned collaborators`: best when a deep module should absorb setup and keep callers simple
- `Context object`: use sparingly when several dependencies always travel together

Explain why the strategy matches the dependency category.

## Local RFC Template

Write RFCs under `.agentify/work/` using this structure.

~~~md
# <Title>

## Summary

<1-2 paragraphs describing the problem and the proposed deepened module>

## Problem

- Current cluster:
- Why the parts are coupled:
- Primary dependency category:
- Why current tests are insufficient:

## Constraints

- Constraint 1
- Constraint 2
- Constraint 3

## Proposed Interface

~~~ts
// Illustrative signature only
~~~

## Usage

~~~ts
// Typical caller path
~~~

## Hidden Complexity

- Complexity absorbed by the module
- Complexity removed from callers

## Dependency Strategy

- Strategy:
- Dependencies owned by the module:
- Dependencies supplied by callers:

## Test Plan

- Boundary tests to add
- Narrow unit tests to remove or simplify

## Migration Plan

1. Introduce the new module behind the chosen boundary.
2. Migrate the highest-value callers first.
3. Delete the redundant seam-level helpers and tests.

## Trade-offs

- Trade-off 1
- Trade-off 2

## Open Questions

- Question 1
~~~
