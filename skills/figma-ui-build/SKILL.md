---
name: figma-ui-build
description: Build frontend UI from a Figma node by fetching Figma metadata/screenshots, mapping styles to local codebase patterns, implementing with existing components, and validating through ui-screenshot-eval. Use when the user provides a Figma URL, Figma node, design link, or asks to build UI from Figma with a visual eval loop.
---

# Figma UI Build

Use this skill when a user asks to build local frontend UI from a Figma node.

## Inputs

- Required: Figma URL with `node-id`.
- Optional: localhost route, Storybook ID, component hint, framework hint, screenshot output directory, or dry-run request.
- Required for Figma API calls: `FIGMA_TOKEN` or `FIGMA_ACCESS_TOKEN` in the environment or shell config.

Never print or persist the raw Figma token.

## Workflow

1. Parse and fetch Figma artifacts
   - Run the bundled helper from the target project root:

```bash
node .codex/skills/figma-ui-build/scripts/figma-ui-build.mjs "<figma-url>" \
  --project-root . \
  --component-hint "<component name or role>" \
  --route "<localhost route or full URL>"
```

   - Use `--dry-run` when the user asks for analysis only.
   - The helper writes `.figma-ui-build/<run-id>/figma-node.raw.json`, `figma-spec.json`, `figma.png`, `component-matches.json`, `implementation-plan.md`, and `ui-eval-input.json`.

2. Inspect local UI conventions
   - Read the helper's `component-matches.json` and `implementation-plan.md`.
   - Prefer matched components when confidence is high.
   - Reuse the app's styling system, tokens, utilities, and component library.
   - Avoid new dependencies unless the user explicitly asks.

3. Build the UI
   - Edit or create the narrowest component surface that satisfies the Figma node.
   - Prefer existing design tokens over literal values.
   - Add a stable `data-testid` to the root element being evaluated.
   - Keep implementation changes small and reviewable.

4. Validate with `ui-screenshot-eval`
   - Load and follow the existing `ui-screenshot-eval` skill after implementation.
   - Run its Playwright preflight before capture:

```bash
node .codex/skills/ui-screenshot-eval/scripts/capture.mjs --check
```

   - Capture the implementation route or Storybook preview with the stable selector.
   - Compare the scoped element screenshot against `.figma-ui-build/<run-id>/figma.png`.
   - Loop on spacing, typography, colors, states, and layout until no material gaps remain.

5. Final report
   - Include the Figma screenshot path, implementation screenshot path, stable selector, changed files, visual gaps fixed, and any remaining differences.
   - If a route or Storybook target is missing, report that implementation was built but screenshot capture could not run.

## Helper Commands

Preflight token and parser support:

```bash
node .codex/skills/figma-ui-build/scripts/figma-ui-build.mjs --check
```

Dry-run artifacts only:

```bash
node .codex/skills/figma-ui-build/scripts/figma-ui-build.mjs "<figma-url>" --dry-run
```

Local parsing only, useful for debugging URL formats:

```bash
node .codex/skills/figma-ui-build/scripts/figma-ui-build.mjs "<figma-url>" --parse-only
```

## Guardrails

- Do not claim visual parity until `ui-screenshot-eval` captures the implemented UI.
- Do not treat text-only task detail as a visual reference.
- Do not leak `FIGMA_TOKEN` in logs, files, prompts, diffs, or reports.
- Do not hardcode project-specific paths into the skill.
- Do not overwrite screenshots or reports outside `.figma-ui-build/` unless the user asks.
