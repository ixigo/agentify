---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, then produce an execution plan and open mapped GitHub issues via gh CLI (feature/fix/chore/docs/test) when requested.
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
7. When done, emit a final implementation plan grouped by issue type:
   - `feature`
   - `fix`
   - `chore`
   - `docs`
   - `test`
8. If the user asks to publish the plan, create GitHub issues with `gh issue create`.

## GitHub Issue Publishing

Use this only after the plan is complete and the user confirms publishing.

For each planned item:
- Build a concise title prefixed with issue type, e.g. `[feature] add retry policy`.
- Include acceptance criteria and a short verification checklist.
- Add labels matching issue type when available.

Preferred command shape:

```bash
gh issue create \
  --title "[feature] add retry policy" \
  --body "...plan details, acceptance criteria, verification..." \
  --label "feature"
```

If labels are missing, create issue without label and note it.

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
- Do not create GitHub issues without user confirmation.
