# PRD: Figma-to-Codebase UI Implementation + Eval Skill

## Goal

Build a reusable ChatGPT/Codex skill that takes a Figma design URL, extracts the file ID and node ID, fetches Figma node metadata and screenshot, analyzes the local codebase for matching styles/components, proposes or builds the closest implementation, and triggers the existing `ui-eval` skill to compare the Figma node screenshot against the built UI.

## Primary User Flow

User gives:

```text
Build this Figma node:
https://www.figma.com/design/<FILE_KEY>/<FILE_NAME>?node-id=9786-23492&t=...
```

The skill should:

1. Parse the Figma URL.
2. Read `FIGMA_TOKEN` from environment or shell config.
3. Fetch Figma node JSON.
4. Export the Figma node screenshot.
5. Convert Figma design properties into normalized CSS-like tokens.
6. Search the local codebase for matching components, styles, tokens, utilities, and design-system patterns.
7. Recommend or generate an implementation using existing patterns.
8. Run the app, Storybook, or preview target.
9. Capture the implemented UI screenshot.
10. Invoke the existing `ui-eval` skill with:
   - Figma screenshot
   - implementation screenshot
   - extracted style report
   - code diff or changed file paths
11. Return a final report with match score, differences, files changed, and suggested fixes.

## Non-goals

- Do not attempt perfect Figma-to-code generation.
- Do not prioritize raw CSS over existing codebase conventions.
- Do not hardcode project-specific paths unless configured.
- Do not expose `FIGMA_TOKEN` in logs, reports, prompts, or output files.
- Do not rely only on screenshots; use both Figma node JSON and visual comparison.

## Inputs

Required:

```bash
figma_url
```

Optional:

```bash
--project-root .
--component-hint "Train Package Card"
--route /train-packages
--storybook-id train-package-card--default
--framework react|next|vue|unknown
--eval-skill ui-eval
--output .figma-ui-build/<timestamp>
--dry-run
```

Supported Figma URL formats:

```text
https://www.figma.com/design/<fileKey>/<fileName>?node-id=9786-23492
https://www.figma.com/file/<fileKey>/<fileName>?node-id=9786%3A23492
https://www.figma.com/design/<fileKey>/<fileName>?node-id=9786:23492
```

Normalize node IDs:

```text
9786-23492 -> 9786:23492
9786%3A23492 -> 9786:23492
```

## Token Discovery

Priority order:

```bash
process.env.FIGMA_TOKEN
process.env.FIGMA_ACCESS_TOKEN
~/.zshrc
~/.bashrc
~/.profile
~/.config/fish/config.fish
```

Recognize patterns:

```bash
export FIGMA_TOKEN="..."
FIGMA_TOKEN=...
export FIGMA_ACCESS_TOKEN="..."
```

Security requirements:

- Never print the token.
- Mask token in debug logs, for example: `figd_****abcd`.
- Fail clearly if missing.

## Figma API Calls

Fetch node JSON:

```http
GET https://api.figma.com/v1/files/:file_key/nodes?ids=:node_id
```

Export node screenshot:

```http
GET https://api.figma.com/v1/images/:file_key?ids=:node_id&format=png&scale=2
```

Then download the returned image URL into the run artifact directory.

## Extracted Design Model

Create normalized JSON:

```json
{
  "source": {
    "figmaUrl": "...",
    "fileKey": "...",
    "nodeId": "9786:23492",
    "nodeName": "...",
    "fetchedAt": "..."
  },
  "layout": {
    "width": 320,
    "height": 180,
    "display": "flex",
    "direction": "column",
    "gap": 8,
    "padding": {
      "top": 12,
      "right": 16,
      "bottom": 12,
      "left": 16
    },
    "borderRadius": 12
  },
  "typography": [],
  "colors": [],
  "effects": [],
  "assets": [],
  "rawNodePath": "figma-node.raw.json",
  "screenshotPath": "figma.png"
}
```

## Figma-to-CSS Mapping

| Figma field | CSS-like output |
|---|---|
| `absoluteBoundingBox` | `width`, `height` |
| `fills` | `background`, `color` |
| `strokes` | `border-color` |
| `strokeWeight` | `border-width` |
| `cornerRadius` | `border-radius` |
| `effects` | `box-shadow` |
| `style.fontFamily` | `font-family` |
| `style.fontSize` | `font-size` |
| `style.fontWeight` | `font-weight` |
| `style.lineHeightPx` | `line-height` |
| `layoutMode` | `flex-direction` |
| `itemSpacing` | `gap` |
| `padding*` | `padding` |
| `layoutAlign` | `align-self` |
| `primaryAxisAlignItems` | `justify-content` |
| `counterAxisAlignItems` | `align-items` |

## Codebase Analysis

The skill should inspect:

```text
package.json
src/
app/
pages/
components/
ui/
styles/
tailwind.config.*
theme.*
tokens.*
*.module.css
*.scss
*.css
*.tsx
*.jsx
*.vue
storybook config
```

Detect:

- Framework: Next.js, React, Vite, Vue, etc.
- Styling: Tailwind, CSS modules, SCSS, styled-components, emotion, vanilla-extract.
- Component library: shadcn/ui, Radix, MUI, Chakra, internal design system.
- Token names for colors, spacing, radius, typography.
- Existing components with similar names or visual roles.

Search strategy:

1. Match by Figma node name.
2. Match by component hint.
3. Match by visible text from Figma node.
4. Match by style signature:
   - radius
   - colors
   - typography
   - layout
5. Match by semantic component role:
   - card
   - button
   - badge
   - modal
   - input
   - tabs
   - train package item

## Component Matching Output

Produce:

```json
{
  "matches": [
    {
      "file": "src/components/PackageCard.tsx",
      "confidence": 0.82,
      "reason": [
        "similar card layout",
        "uses same radius token",
        "contains matching badge pattern"
      ]
    }
  ],
  "recommendedBase": "src/components/PackageCard.tsx"
}
```

## Implementation Modes

### Dry run

Only produce:

- extracted design JSON
- CSS-style summary
- component match report
- implementation recommendation

### Build mode

Modify or create component code using existing conventions.

Rules:

- Prefer editing an existing component if confidence is greater than `0.75`.
- Prefer creating a new component if no strong match exists.
- Use the project’s styling system.
- Avoid introducing new dependencies.
- Prefer design tokens over literal values.
- Keep changes minimal and reviewable.

## UI Eval Integration

Expected handoff payload:

```json
{
  "figmaScreenshot": ".figma-ui-build/run-id/figma.png",
  "implementationScreenshot": ".figma-ui-build/run-id/implementation.png",
  "figmaSpec": ".figma-ui-build/run-id/figma-spec.json",
  "codebaseMatches": ".figma-ui-build/run-id/component-matches.json",
  "changedFiles": ["..."],
  "targetUrl": "http://localhost:3000/...",
  "notes": "Compare visual parity, spacing, typography, colors, and component fidelity."
}
```

The skill should support configurable invocation:

```bash
UI_EVAL_COMMAND="ui-eval --input {payload}"
```

or a skill handoff instruction:

```text
Trigger ui-eval with figmaScreenshot and implementationScreenshot.
```

## Artifacts

For every run, create:

```text
.figma-ui-build/<run-id>/
  figma-node.raw.json
  figma-spec.json
  figma.png
  component-matches.json
  implementation-plan.md
  changed-files.json
  implementation.png
  ui-eval-input.json
  ui-eval-report.md
```

## CLI Proposal

Command:

```bash
figma-ui-build "<figma_url>"   --project-root .   --component-hint "Train Package Card"   --route /train-packages   --eval
```

Dry run:

```bash
figma-ui-build "<figma_url>" --dry-run
```

## Error Handling

Missing token:

```text
FIGMA_TOKEN not found in env, ~/.zshrc, ~/.bashrc, or ~/.profile.
```

Invalid URL:

```text
Could not parse Figma file key or node-id.
```

No Figma access:

```text
Figma API returned 403. Check token permissions and file access.
```

No node found:

```text
Node 9786:23492 was not found in file qIfekFRB75vg5pzmMXBvvH.
```

No runnable preview:

```text
Implementation was generated, but screenshot capture could not run because no preview route/storybook target was detected.
```

## Acceptance Criteria

- Parses Figma file key and node ID from common URL formats.
- Reads token from env or shell config without leaking it.
- Fetches node JSON and screenshot.
- Produces normalized CSS-like design spec.
- Finds at least top 5 matching components/styles in codebase.
- Generates an implementation plan before code changes.
- Uses existing design tokens/styles where possible.
- Captures implementation screenshot.
- Triggers `ui-eval`.
- Produces final report with visual differences and recommended fixes.

## Suggested Implementation Stack

- Node.js/TypeScript CLI
- `commander` or `yargs` for CLI args
- native `fetch` or `undici`
- `tsx` for local execution
- `fast-glob` for codebase scanning
- `ts-morph` optional for TSX component analysis
- Playwright for screenshots
- `sharp` optional for image metadata/cropping

## Suggested Repository Structure

```text
figma-ui-build/
  package.json
  tsconfig.json
  src/
    cli.ts
    figma/
      parseFigmaUrl.ts
      readFigmaToken.ts
      fetchNode.ts
      exportImage.ts
      normalizeNode.ts
    codebase/
      detectProject.ts
      scanComponents.ts
      scanTokens.ts
      rankMatches.ts
    implementation/
      planImplementation.ts
      applyImplementation.ts
    screenshot/
      captureRoute.ts
      captureStorybook.ts
    eval/
      buildUiEvalPayload.ts
      runUiEval.ts
    utils/
      fs.ts
      logger.ts
```

## Codex Build Prompt

```text
Build a TypeScript CLI called figma-ui-build.

It should:
1. Accept a Figma URL.
2. Parse fileKey and nodeId.
3. Read FIGMA_TOKEN or FIGMA_ACCESS_TOKEN from env, ~/.zshrc, ~/.bashrc, or ~/.profile.
4. Fetch Figma node JSON from /v1/files/:fileKey/nodes.
5. Export node PNG from /v1/images/:fileKey.
6. Normalize Figma node styles into CSS-like JSON.
7. Scan the local codebase for matching components, styles, Tailwind tokens, CSS modules, and design-system usage.
8. Produce component-matches.json and implementation-plan.md.
9. In build mode, generate or update a component using existing styling conventions.
10. Capture a local screenshot through route or Storybook when provided.
11. Write ui-eval-input.json and invoke UI_EVAL_COMMAND if set.
12. Never log the Figma token.
13. Store all run artifacts under .figma-ui-build/<timestamp>/.
```
