---
name: ui-screenshot-eval
description: Drive UI implementation with Playwright screenshots, stable data-testid anchors, and visual iteration against a screenshot or Figma reference. Use when building or changing frontend UI where the user provides a visual target, asks for before/after screenshots, or wants an eval loop for visual similarity.
---

# UI Screenshot Eval

Use this skill for frontend tasks where visual evidence matters.

## Preconditions

- A runnable app command and target page, preferably the localhost URL provided by the user.
- One or more task inputs from the user:
  - Localhost page URL, for example `http://localhost:3000/checkout`.
  - Screenshot path or Figma link to use as the visual reference.
  - Task details describing the UI change to build.
- If the user provides only task details and no visual reference, run this as before/after quality review only.
- Node.js available in the target repo.
- Playwright available in the target repo, usually through `@playwright/test` or `playwright`, with Chromium browser binaries installed.

## Tool Preflight

Before starting the app or running screenshots:

1. Check required tools in the target repo.
   - `command -v node`
   - `node .codex/skills/ui-screenshot-eval/scripts/capture.mjs --check`
2. If Node or Playwright is missing, stop and ask the user to install the missing tool instead of continuing.
3. If Playwright is present but browsers are missing, ask the user to run the install command printed by the helper.

## Workflow

1. Resolve the target
   - Use the user-provided localhost URL when available.
   - Use the screenshot path or Figma link as the visual reference when provided.
   - Use task details as the implementation brief; do not treat text-only details as a visual oracle.
   - Ask for a stable key only if the user did not provide one.
   - Prefer a semantic `data-testid`, for example `checkout-summary-card`.
   - Identify the main root element for the UI being built or changed.

2. Capture baseline before editing
   - Start the app using the repo's normal dev command.
   - Capture a full-page screenshot before changes when the page already exists.
   - Store artifacts under `.agentify/ui-eval/<task-key>/before/`.

3. Add the anchor
   - Add `data-testid="<task-key>"` to the changed UI root.
   - Keep the edit scoped to that feature root.
   - Verify the selector matches exactly one element.

4. Implement and capture after
   - Make the UI change.
   - Capture both full-page and scoped element screenshots.
   - Store artifacts under `.agentify/ui-eval/<task-key>/after/`.

5. Evaluate and loop
   - Compare the scoped element first, then the whole page.
   - Continue editing until the scoped result is materially aligned with the reference.
   - Use pixel diff only when a local reference screenshot and project tooling support it.
   - Treat Figma links as design references unless export/auth/font access is confirmed.

## Helper Script

Use the bundled capture helper from the installed skill directory:

```bash
node .codex/skills/ui-screenshot-eval/scripts/capture.mjs --check

node .codex/skills/ui-screenshot-eval/scripts/capture.mjs \
  --url http://localhost:3000/checkout \
  --test-id checkout-summary-card \
  --out .agentify/ui-eval/checkout-summary-card/before
```

Useful flags:

- `--check` to verify Playwright and Chromium are installed before capture.
- `--selector "[data-testid='checkout-summary-card']"` when the selector is not a test id.
- `--viewport 1440x900` to stabilize layout.
- `--wait-for ".loaded"` for app-specific readiness.
- `--storage-state path/to/state.json` for authenticated pages.
- `--full-page false` to capture only the current viewport for the full screenshot.

## Output Contract

Always finish with:

- Reference used.
- Stable selector used and uniqueness result.
- Before screenshot path, if captured.
- After full-page screenshot path.
- After scoped-element screenshot path.
- Remaining visual gaps or statement that no material gaps remain.

## Guardrails

- Do not claim reference matching when the user only gave a text task.
- Do not add anchors to unrelated ancestors just to make selection easy.
- Do not hide regressions outside the scoped element; review the full-page screenshot too.
- Do not require screenshots to be committed unless the user asks.
