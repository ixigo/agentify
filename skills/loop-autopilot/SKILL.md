---
name: loop-autopilot
description: Implement one graded iteration of an autonomous Agentify loop — read the brief and the previous gate failures, make the smallest change that turns the red gates green, and stop. Use when running inside `agentify loop`, or when a task should be driven by acceptance gates that decide completion instead of the agent deciding it.
---

# Loop Autopilot

This skill governs the work *inside* one iteration of `agentify loop`. The
harness owns the loop; you own the edit.

Named `loop-autopilot` rather than `loop` on purpose: Claude Code ships a
built-in `/loop` command for interval-running a prompt, and the two are
unrelated.

## What the harness already decided

Do not redo any of this — it is fixed before you are invoked:

- **Isolation.** You are in a dedicated git worktree on a loop-owned branch.
- **Termination.** The iteration count, the dollar ceiling, the turn ceiling,
  and the wall clock are enforced outside your process.
- **Completion.** The acceptance gates decide whether the work is done. Your
  own judgment that the task looks finished does not end the loop, and saying
  it is finished does not make a red gate green.
- **Shipping.** The harness commits, and opens a draft PR when asked. You do
  not run `git commit`, `git push`, or any PR command.

## Your iteration

1. **Read the failures first.** When the prompt contains a "What failed last
   iteration" section, that is the entire agenda. Fix those gates before doing
   anything else, and do not start unrelated work while a gate is red.
2. **Read before writing.** Find the closest existing feature in the repo and
   match its structure, naming, error handling, and test style. A change that
   passes the gates but looks foreign to the codebase is a bad change.
3. **Make the smallest complete change.** Resist refactors the brief did not
   ask for; they widen the diff the review gate has to judge and the blast
   radius the risk gate has to score.
4. **Leave the tree runnable.** The gates execute immediately after you stop.
   Half-applied edits, a syntax error in an unrelated file, or a stray debug
   server will fail gates that have nothing to do with the task.

## Reading gate failures

Each failure arrives as `gate "<id>" (<kind>) <status>: <detail>`.

| Kind | What a failure means | Where to look |
| --- | --- | --- |
| `command` | The command exited non-zero | The tail in the detail, then the gate log |
| `agentify-tests` | Affected tests failed | Run the same selection locally: `agentify test --since <base> --run` |
| `playwright` | End-to-end run failed | Playwright's own report in the repo |
| `visual` | Rendered UI is too far from the reference | Compare the captured screenshot against the reference |
| `review` | A reviewer from another vendor found a blocking defect | The reason in the detail is the finding |
| `risk` | The change's blast radius exceeded the ceiling | Narrow the change, or split it |

An `error` status is not a verdict about your code — it means the gate could
not run (a missing dev server, an unreadable reference image, a reviewer that
returned nothing). Fix the cause if it is inside the repo; otherwise say so
plainly in your reply rather than editing around it.

## Visual work

When the brief carries a Figma node URL or reference screenshots:

- The screenshots are the truth about rendered appearance. Where Figma
  metadata and a screenshot disagree, follow the screenshot and note it.
- Use `figma-ui-build` for node metadata and local component matching, and
  `ui-screenshot-eval` for capture and iteration.
- Add exactly one stable `data-testid` on the feature root — the visual gate
  needs it to resolve to exactly one element.
- Reuse the app's tokens and components. New dependencies are out of scope.

Differently sized images are scored on layout structure, not pixels, so chasing
the last few points of a structural score is usually wasted effort. Fix what is
visibly wrong: spacing, scale, weight, color, alignment, and states.

## Hard rules

- Never edit CI workflow files or agent settings. Those edits are reverted
  between iterations and reported as a violation.
- Never weaken a gate to make it pass — do not delete or skip a failing test,
  loosen a threshold, or special-case the checker. If a gate is genuinely
  wrong, leave it red and say why in your reply; the operator reads it.
- Never add a dependency unless the task cannot be done without one.
- Never commit, push, or open a pull request.

## When you cannot finish

Say so in your reply, concretely: which gate you could not turn green, what you
tried, and what a human would need to decide. A run that stalls with a clear
account of the blocker is far more useful than one that spends its remaining
iterations guessing.
