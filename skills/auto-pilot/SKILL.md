---
name: auto-pilot
description: Execute a task end-to-end with minimal user interaction by deriving requirements from the repository first, then implementing, validating, and committing autonomously.
---

# Auto Pilot

Use this skill when the user wants autonomous execution with little to no back-and-forth.

## Core Behavior

- Treat the request as permission to run end to end.
- Start by answering the question: **"What should be built here?"** from repository evidence first.
- Prefer repository facts over user follow-up questions.
- Ask the user only when a hard requirement is truly unknowable from code, docs, history, or issue context.

## Workflow

1. **Interpret task intent**
   - Parse the user request into explicit goal, constraints, and success criteria.
   - If the goal is vague, infer a concrete task from the codebase and nearby docs.

2. **Self-serve discovery (no human dependency by default)**
   - Inspect README, usage docs, tests, configs, and related modules.
   - Use targeted code search (`rg`) to find ownership, patterns, and extension points.
   - Build a short internal implementation plan before editing.

3. **Implement autonomously**
   - Make the smallest complete change that satisfies the inferred goal.
   - Follow existing conventions (structure, naming, error handling, testing style).
   - Avoid unrelated refactors.

4. **Validate and iterate**
   - Run relevant checks automatically (tests, lint, type checks, or repo-standard scripts).
   - Fix failures and re-run until passing or externally blocked.

5. **Finalize**
   - Summarize what changed, why, and evidence used from the repository.
   - Report commands executed and outcomes.
   - If requested by environment workflow, commit with a clear conventional message.

## Decision Rules

- If two plausible implementations exist, choose the one most consistent with current repo patterns.
- If product intent is missing, infer from tests, naming, adjacent modules, and current docs.
- Mark inferred assumptions clearly in the final summary.
- Escalate to the user only for true product decisions that cannot be safely inferred.

## Guardrails

- Do not fabricate requirements not grounded in repository context.
- Do not ask the user broad discovery questions when answers exist in the codebase.
- Do not weaken tests or checks to force green builds.
- Do not make destructive or unrelated changes.
- Keep changes scoped, reversible, and well validated.

## Output Format

- `Goal interpreted`
- `Repository evidence used`
- `Plan executed`
- `Files changed`
- `Validation run`
- `Result`
- `Assumptions (if any)`
- `Next steps (optional)`
