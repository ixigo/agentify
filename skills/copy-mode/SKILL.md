---
name: copy-mode
description: Analyze a codebase with agents, extract architecture and engineering conventions, and write agent-ready handoff docs to docs/architecture.md, prd.md, and summary.md so another agent can implement against the repo with minimal backtracking.
---

# Copy Mode

Use this skill when the user wants a repo analyzed and packaged into implementation-ready documents for a follow-on agent.

If subagents are available and the user asked for agent-based analysis, use them. Prefer parallel read-only exploration with distinct responsibilities. If subagents are not available, do the same work locally.

## Outputs

Write exactly these files unless the user asks for different paths:

- `docs/architecture.md`
- `prd.md`
- `summary.md`

Create `docs/` if it does not exist.

## Goal

Produce a concise, factual handoff packet that lets another agent answer:

- What this codebase is and how it is structured
- Which conventions must be preserved
- What should be built next
- Where the likely integration points and risks are

## Workflow

### 1. Map the repo first

Inspect the codebase before making claims. Identify:

- Entrypoints, main apps, packages, and services
- Build, test, lint, and local-run commands
- Important configuration files
- Existing docs, ADRs, RFCs, or planning artifacts
- The dominant implementation patterns and module boundaries

Prefer `rg`, targeted file reads, and existing scripts over broad dumps.

### 2. Split exploration by concern

When subagents are allowed, run them in parallel with disjoint responsibilities:

- Repo map: architecture, entrypoints, module boundaries, runtime flow
- Conventions: naming, file organization, patterns, testing, error handling, API design
- Product intent: README, docs, issues, existing plans, feature flags, UI flows

Do not delegate write ownership of the final docs. Keep synthesis in the main agent.

### 3. Resolve assumptions from the repo

If an answer can be discovered from the repository, do not ask the user. Ask only for genuinely missing product intent or priority decisions that cannot be inferred safely.

Challenge weak assumptions. Mark inferred statements explicitly as inferred.

### 4. Write `docs/architecture.md`

Document the current system, not an imagined target state. Include:

- Repository overview
- High-level architecture and runtime shape
- Key modules, packages, or directories with responsibilities
- Important data flows, interfaces, and dependency boundaries
- Build, test, and developer workflow
- Extension points another agent should use
- Known technical risks, unclear areas, and constraints

Keep it implementation-oriented. Use concrete paths and commands when available.

### 5. Write `prd.md`

Describe the product or feature work another agent is expected to build from this repo context. Include:

- Goal
- Scope
- Non-goals
- Primary users or operators
- Critical workflows
- Functional requirements
- Non-functional requirements
- Constraints from the current codebase
- Acceptance criteria
- Open questions

If the repo does not define a clear next feature, write the most defensible inferred PRD and label it `Inferred from repository context`.

### 6. Write `summary.md`

Make this the fast-start brief for the next agent. Include:

- One-paragraph repo summary
- What to read first
- Commands to know
- Conventions to preserve
- Suggested implementation order
- Likely files to touch first
- Risks and ambiguity hotspots

This file should optimize for speed. Another agent should be able to start from it without reading everything else first.

### 7. Final response

Return:

- The paths written
- A short summary of what was learned
- Any major uncertainties that still need a human decision

## Guardrails

- Do not invent architecture details that are not supported by the repo.
- Do not produce generic boilerplate docs detached from the codebase.
- Do not ask broad discovery questionnaires.
- Do not overwrite substantial existing planning docs without reading and integrating them.
- Prefer concrete file paths, commands, and invariants over abstractions.
- Keep docs dense and agent-usable, not marketing-style prose.
