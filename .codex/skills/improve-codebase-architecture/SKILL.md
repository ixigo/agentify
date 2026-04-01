---
name: improve-codebase-architecture
description: Explore a codebase to find architectural improvement opportunities, focusing on making the codebase more testable by deepening shallow modules and consolidating tightly-coupled concepts. Use when the user wants refactoring opportunities, architecture RFCs, better module boundaries, or more AI-navigable code.
---

# Improve Codebase Architecture

Explore the codebase the way an AI or a new maintainer would. Treat friction while reading as signal.

If subagents are available, use explorer-style subagents for discovery and parallel interface design. If they are not available, do the same work locally and still produce multiple competing interfaces.

## Workflow

### 1. Explore the codebase

Read the codebase organically and note where understanding breaks down:

- One concept requires bouncing across many small files
- An interface is nearly as complex as its implementation
- Pure helper functions exist only to make unit tests possible, while the actual bugs hide in orchestration
- Tight coupling lives in seams between modules
- The code is hard to test at the real boundary

Prefer firsthand observations over generic architectural advice.

### 2. Present candidates

Present a numbered list of deepening opportunities. For each candidate, include:

- `Cluster`: the modules or concepts involved
- `Why they're coupled`: shared types, call patterns, or co-ownership of a concept
- `Dependency category`: use the categories in [REFERENCE.md](REFERENCE.md)
- `Test impact`: which narrow unit tests could be replaced by boundary tests

Do not propose interfaces yet. End with: `Which of these would you like to explore?`

### 3. Wait for the user's pick

Do not skip this choice unless the user already selected a candidate.

### 4. Frame the problem space

Before designing interfaces, explain the problem space for the chosen candidate:

- Constraints a new interface must satisfy
- Dependencies it must rely on or absorb
- A rough illustrative code sketch that makes the constraints concrete

This is not the proposal. It is a grounding artifact for the next step.

After showing the explanation, continue immediately to interface design so the user can think while that work runs.

### 5. Design multiple interfaces

Produce at least 3 radically different interface designs. When subagents are available, run them in parallel with distinct constraints:

- Design 1: minimize the interface to 1-3 entry points
- Design 2: maximize flexibility for extensions and edge cases
- Design 3: optimize for the most common caller and make the default path trivial
- Design 4: if cross-boundary dependencies dominate, use ports and adapters

Each design must include:

1. Interface signature
2. Usage example
3. Complexity hidden internally
4. Dependency strategy using the guidance in [REFERENCE.md](REFERENCE.md)
5. Trade-offs

Present the designs sequentially, then compare them in prose.

After the comparison, give a recommendation. Be opinionated. If a hybrid is strongest, say so explicitly.

### 6. Wait for interface selection

Accept either:

- an explicit user pick
- an explicit approval of your recommendation

### 7. Write the RFC locally

Do not create a GitHub issue. Write the RFC as a local markdown file under `.agentify/work/`.

Use the RFC template in [REFERENCE.md](REFERENCE.md). Pick a concise slug and write to:

`.agentify/work/<slug>.md`

Return the path and a 2-4 sentence summary of the recommendation.

## Guardrails

- Do not jump to interface design before showing candidates.
- Do not treat "extract helper" as an architecture improvement by default.
- Prefer boundary tests over tests that assert internal call choreography.
- Prefer deeper modules with smaller public surfaces.
- Keep the chosen design grounded in actual callers and actual dependencies.
- Respect repo guardrails in `.guardrails` when present.
