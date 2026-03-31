---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when the user wants to stress-test a plan, get grilled on their design, pressure-test architecture, or mentions "grill me".
---

# Grill Me

Ask one question at a time. For every question, include a recommended answer.

If a question can be answered by exploring the codebase, explore the codebase instead of asking.

## Workflow

1. Start with the highest-risk unresolved decision.
2. Ask exactly one question.
3. After the question, include `Recommended answer:` with your best answer and brief reasoning.
4. Wait for the user's answer unless the repo can answer it directly.
5. Use each answer to identify the next dependent decision.
6. Keep going until the plan is concrete enough to implement or intentionally accepted with known risks.

## Areas To Cover

- Goal, scope, and non-goals
- Users, operators, and critical workflows
- Data model, state transitions, and invariants
- APIs, interfaces, and dependency boundaries
- Failure modes, rollback, and observability
- Performance, security, and permission constraints
- Testing, migration, and release plan
- Open assumptions and unresolved tradeoffs

## Guardrails

- Do not dump a long questionnaire.
- Do not ask questions the codebase can answer.
- Challenge vague or hand-wavy answers.
- Prefer concrete scenarios and edge cases over abstractions.
- Stop only when the remaining uncertainty is explicit and accepted.
