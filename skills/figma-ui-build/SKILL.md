---
name: figma-ui-build
description: Build frontend UI from a Figma node using a user-provided node image plus cached Figma metadata, mapping styles to local codebase patterns, implementing with existing components, and validating through ui-screenshot-eval. Use when the user provides a Figma URL, Figma node, design link, or asks to build UI from Figma with a visual eval loop while avoiding Figma image export rate limits.
---

# Figma UI Build

Use this skill when a user asks to build local frontend UI from a Figma node.

## Inputs

- Required: Figma URL with `node-id`.
- Required visual reference: a user-provided node picture/screenshot of the exact Figma node.
- Optional: localhost route, Storybook ID, component hint, framework hint, screenshot output directory, cached/raw node JSON, or dry-run request.
- Required for live Figma metadata calls: `FIGMA_TOKEN` or `FIGMA_ACCESS_TOKEN` in the environment or shell config.

Never print or persist the raw Figma token.

If the user gives only a Figma link and no node picture, ask them to provide the node picture before starting implementation. Do not call Figma's image export API as a substitute.

## Workflow

1. Collect the node picture and parse/fetch metadata
   - Save the user-provided node picture into the project or run artifact area, then pass it as `--reference-image`.
   - Run the bundled helper from the target project root:

```bash
node .codex/skills/figma-ui-build/scripts/figma-ui-build.mjs "<figma-url>" \
  --project-root . \
  --reference-image "<path-to-user-provided-node-picture>" \
  --component-hint "<component name or role>" \
  --route "<localhost route or full URL>"
```

   - Use `--dry-run` when the user asks for analysis only.
   - The helper writes `.figma-ui-build/<run-id>/figma-node.raw.json`, `figma-spec.json`, the copied `reference.*` image, `component-matches.json`, `implementation-plan.md`, and `ui-eval-input.json`.
   - The helper caches node metadata in `.figma-ui-build/cache/` and reuses it on later runs. Use `--refresh` only when the Figma node changed and a live metadata refresh is necessary.
   - Use `--raw-node <json>` if the user already exported node JSON and you need to avoid Figma API calls entirely.

2. Extract design details
   - Use the provided node picture as the visual source of truth for spacing, alignment, typography scale, color appearance, borders, radius, shadows, image treatment, and interaction states visible in the image.
   - Use `figma-spec.json` for exact metadata that is cheap to obtain or already cached: node size, autolayout direction/gap/padding, text nodes, fills, effects, and visible text.
   - If picture and metadata conflict, prefer the picture for rendered visual fidelity and note the mismatch.

3. Inspect local UI conventions
   - Read the helper's `component-matches.json` and `implementation-plan.md`.
   - Prefer matched components when confidence is high.
   - Reuse the app's styling system, tokens, utilities, and component library.
   - Avoid new dependencies unless the user explicitly asks.

4. Build the UI
   - Edit or create the narrowest component surface that satisfies the Figma node.
   - Prefer existing design tokens over literal values.
   - Add a stable `data-testid` to the root element being evaluated.
   - Keep implementation changes small and reviewable.

5. Validate with `ui-screenshot-eval`
   - Load and follow the existing `ui-screenshot-eval` skill after implementation.
   - Run its Playwright preflight before capture:

```bash
node .codex/skills/ui-screenshot-eval/scripts/capture.mjs --check
```

   - Capture the implementation route or Storybook preview with the stable selector.
   - Compare the scoped element screenshot against `.figma-ui-build/<run-id>/reference.*`.
   - Loop on spacing, typography, colors, states, and layout until no material gaps remain.

6. Final report
   - Include the provided reference image path, implementation screenshot path, stable selector, changed files, visual gaps fixed, and any remaining differences.
   - If a route or Storybook target is missing, report that implementation was built but screenshot capture could not run.

## Helper Commands

Preflight token and parser support:

```bash
node .codex/skills/figma-ui-build/scripts/figma-ui-build.mjs --check
```

Dry-run artifacts only:

```bash
node .codex/skills/figma-ui-build/scripts/figma-ui-build.mjs "<figma-url>" \
  --reference-image "<path-to-user-provided-node-picture>" \
  --dry-run
```

Local parsing only, useful for debugging URL formats:

```bash
node .codex/skills/figma-ui-build/scripts/figma-ui-build.mjs "<figma-url>" --parse-only
```

## Guardrails

- Do not claim visual parity until `ui-screenshot-eval` captures the implemented UI.
- Do not treat text-only task detail as a visual reference.
- Do not call Figma's image export API; ask for a user-provided node picture instead.
- Do not refresh Figma metadata repeatedly. Reuse `.figma-ui-build/cache/` unless the node has changed or the user asks for fresh metadata.
- Do not leak `FIGMA_TOKEN` in logs, files, prompts, diffs, or reports.
- Do not hardcode project-specific paths into the skill.
- Do not overwrite screenshots or reports outside `.figma-ui-build/` unless the user asks.
