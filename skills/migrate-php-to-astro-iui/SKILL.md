---
name: migrate-php-to-astro-iui
description: Migrate legacy ConfirmTkt PHP or AMP pages from UI/Website into the Astro seo-pages application as a pixel-exact reproduction of the reference UI, preserving route, data, content, SEO, and rendered appearance. Use when a PHP page must become a server-first Astro route whose rendered output is visually indistinguishable from the legacy page or supplied design reference, verified by screenshot pixel diff and computed-style comparison alongside build, accessibility, SEO, and Lighthouse evidence.
---

# Migrate PHP to Astro IUI

Migrate the page through a repository-first evidence loop. Modernize the
implementation — routing, data fetching, hydration, and SEO — while reproducing
the reference UI exactly. The architecture changes; the rendered pixels do not.

## Visual fidelity contract

This is the primary acceptance criterion, not a nice-to-have.

**The migrated route must render identically to the reference at every captured
viewport and state.** "Identically" means measured, not asserted:

| Signal | Gate |
| --- | --- |
| Full-page screenshot pixel diff | at most 0.20% mismatching pixels per viewport |
| Full-page height | within 2px of the reference |
| Element geometry (`x`, `y`, `width`, `height`) | within 1px per edge |
| Enumerated computed styles | exact, with per-channel color tolerance 8 and length tolerance 0.5px |
| Reference content elements missing from the candidate | zero |

Never claim parity from code inspection, component reuse, or a side-by-side
glance. Run `scripts/compare-visual-parity.mjs` and report its numbers.

### Precedence when goals collide

1. **Rendered appearance wins.** Every other preference yields to it.
2. Architecture goals — server-first rendering, minimal hydration, typed data,
   SEO correctness — are satisfied *within* that constraint. They govern how the
   output is produced, never what it looks like.
3. **Design-system reuse is a means, not a goal.** Reuse a ConfirmTkt or
   `@ixigo/iui` component only when it can be made to render identically to the
   reference. When a component's built-in typography, spacing, radius, color, or
   states cannot be overridden to match, use semantic markup with exact CSS
   instead and record the reason in the migration map. Do not accept a visual
   delta to keep a component.
4. **Do not silently improve the design.** Legacy spacing quirks, odd
   breakpoints, unusual colors, and layout defects are reproduced by default.
   List them as proposed fixes in the completion report and let the user decide.
5. **Invisible accessibility and semantic corrections are always allowed** —
   landmarks, `alt` text, labels, correct native elements, heading levels, and
   ARIA. Anything that changes rendered pixels (contrast, focus rings, hit
   areas, font size) requires explicit user approval first.
6. **Never lower a fidelity threshold to pass.** If a Lighthouse or Core Web
   Vitals target can only be reached by changing the appearance, report the
   conflict with evidence and ask. Do not choose the score over the pixels.

## Required inputs

Resolve these from the request and repository before editing:

- Legacy PHP entry file and any included files that own behavior.
- Destination Astro project, brand, route shape, and representative route.
- **A renderable visual reference**: the production URL, a locally runnable
  legacy route, or supplied screenshots with their viewport widths. Fidelity is
  only verifiable against something that renders — establish this early.
- API contract, redirect/canonical rules, supported languages, and empty/error
  behavior.
- Quality thresholds explicitly requested by the user.

Do not block on details that repository inspection can answer. Ask only when a
choice would materially change public behavior or rendered appearance and cannot
be established from code or a live reference.

## Load the relevant references

Read these files before implementation:

- [references/visual-parity-checklist.md](references/visual-parity-checklist.md)
  first — it defines the capture, comparison, and evidence procedure that the
  rest of the work is validated against.
- [references/confirmtkt-astro-conventions.md](references/confirmtkt-astro-conventions.md)
  for repository discovery, route ownership, data boundaries, and hydration.
- [references/iui-component-map.md](references/iui-component-map.md) before
  selecting or creating UI components.
- [references/migration-contract.md](references/migration-contract.md) while
  inventorying behavior and assigning each legacy surface a treatment.
- [references/quality-gates.md](references/quality-gates.md)
  before defining acceptance criteria or running final validation.

Treat every path and component name in the references as a search cue. Verify
the current repository before using it.

## Workflow

### 1. Establish repository boundaries

1. Read the applicable `AGENTS.md`, imported instructions, and nearest nested
   instructions for both source and destination.
2. Inspect branch, staged changes, unstaged changes, and untracked files.
3. Identify the project package manager, required Node version, package
   scripts, rendering mode, brand configuration, and deployment adapter.
4. Confirm the visual tooling is usable before implementing:

```bash
node .codex/skills/migrate-php-to-astro-iui/scripts/capture-visual-spec.mjs --check
```

5. Run the mandatory modern-web-guidance search for current HTML, performance,
   accessibility, and browser guidance before implementing frontend code.
6. Preserve unrelated user changes. Do not commit or push unless the user
   explicitly authorizes it under repository rules.

### 2. Inventory the legacy contract

Run the bundled inventory from the destination project root:

```bash
node .codex/skills/migrate-php-to-astro-iui/scripts/inventory-php-page.mjs \
  "../UI/Website/example.php" \
  --output ".agentify/php-astro-migration/example/legacy-inventory.json"
```

Then trace included files and runtime dependencies that the static inventory
cannot resolve. Record:

- Accepted URL shapes, query/body inputs, normalization, and redirects.
- API endpoints, request parameters, response fields, time/date defaults, and
  timeout or fallback behavior.
- Metadata, canonical, hreflang, robots, Open Graph, Twitter, and JSON-LD.
- Visible headings, sections, tables, links, forms, calls to action, and
  empty/error states.
- Analytics, app-deep-link, authentication, and brand-specific behavior.
- Desktop/mobile differences and legacy behavior that is intentionally obsolete.

Never infer a production contract solely from appearance. Trace the value from
input through data fetch, normalization, metadata, render, and navigation.

### 3. Capture the reference visual spec

This is a blocking prerequisite. Do not write page markup before the reference
spec exists — implementing first and comparing later produces a
redesign-then-patch loop that never converges.

Capture the legacy route at the product's real breakpoints:

```bash
node .codex/skills/migrate-php-to-astro-iui/scripts/capture-visual-spec.mjs \
  --url "https://www.confirmtkt.com/trains/example-to-example-train-tickets" \
  --label reference \
  --viewports "390x844,768x1024,1440x900" \
  --mask ".ad-slot,[data-testid='live-timer']" \
  --out ".agentify/php-astro-migration/example/reference"
```

This writes a full-page PNG per viewport plus `visual-spec.json` containing the
geometry and computed styles of every visible element. That JSON is the
specification you implement against — read it, do not guess values from a
screenshot.

Also capture every non-default state the route can reach: empty/no-result, error,
and each important interactive state (open picker, expanded FAQ, dialog). Give
each its own `--out` directory.

Record the URL, viewport, data date, authentication state, and capture time.
Mask volatile regions (ads, live timers, rotating offers) with `--mask` so data
churn cannot be mistaken for a fidelity failure — and mask the same selectors on
both sides.

Store generated evidence under `.agentify/php-astro-migration/<task-key>/`; do
not commit it unless requested.

**If the reference cannot be rendered** and only static screenshots exist,
extract the design values from the images (measure spacing, sample colors, match
type sizes) and say plainly in the completion report that the pixel-diff gate
could not run and fidelity is verified by inspection only. Never present that as
verified parity.

### 4. Find the destination owner seams

Search before creating files:

- Nearest dynamic Astro routes and route-param parsing.
- Existing ConfirmTkt page layouts, headers, footers, metadata, schema, and
  breadcrumb components.
- Existing API clients, server-only fetch utilities, types, caching, and error
  handling.
- Existing components with the same user intent, plus current
  `@ixigo/iui` and `@ixigo/icons` imports.
- Current styling tokens, CSS-module conventions, brand switches, and
  responsive breakpoints.
- Existing route tests, component tests, and preview/build commands.

Create a migration map with one row per legacy surface:

```text
legacy surface | contract | destination owner | treatment | fidelity plan | evidence
```

Use `reuse`, `adapt`, `semantic Astro`, `new component`, or `omit with reason`
as treatments. The `fidelity plan` column states how that surface will match the
reference spec: which tokens or exact values it uses, and — when a component is
reused — which of its defaults must be overridden. Do not start implementation
until every important legacy surface has an owner or an explicit omission
rationale approved by the user.

Compare each candidate component against the reference spec before committing to
it. A component that is close but not matchable is a worse choice than semantic
markup with exact CSS.

### 5. Choose and state the architecture

Default to:

- A thin Astro page route that validates params and composes a screen.
- A server-only API adapter that preserves request semantics.
- A typed normalized page model consumed by metadata and rendering.
- Astro components for static and server-rendered content.
- Small React islands only for interactions that require browser state.
- Existing ConfirmTkt/IUI components when they can render identically; semantic
  markup with exact CSS when they cannot.

Keep canonicalization and redirects at the earliest server-owned seam. Avoid a
client redirect or a duplicate fetch to discover the canonical route.

State the chosen route, data, metadata, component, hydration, caching, and
failure-state boundaries before making broad changes.

### 6. Implement in contract-sized slices

Implement in this order:

1. Route parsing, input normalization, redirect rules, and typed data adapter.
2. Metadata, canonical, hreflang, robots, and schema driven from normalized
   server data.
3. Page skeleton: containers, breakpoints, grid/flex structure, and the exact
   box model from the reference spec.
4. Visible primary content, typography, color, spacing, borders, radii, and
   shadows matched to the reference computed styles.
5. Component-level detail — icons, images at the reference intrinsic and
   rendered sizes, and every visual state.
6. Isolated interactive islands, analytics, and deep links.
7. Empty, error, invalid-route, and slow-data states, each matched to its own
   captured reference.

Use source HTML order that is meaningful without CSS or JavaScript, and keep
critical content and primary headings in the server response — but never let
that reorder rendered output. When semantic order and visual order genuinely
conflict, keep the visual result and note the ordering decision.

Match the reference's own values. Prefer a repository token when it resolves to
the exact reference value; when no token matches, use the literal value from the
spec rather than the nearest token. Record every such case — a cluster of them
usually means the reference predates the current token set, which is worth
telling the user.

Run the comparison after each visible slice rather than once at the end.

### 7. Validate and iterate

Run focused checks after each slice and the full relevant project gates before
finishing:

1. Format and lint changed files.
2. Run Astro/type checks, focused tests, and the production brand build.
3. Preview the production build; do not use the development server for final
   fidelity or Lighthouse claims.
4. Capture the candidate spec from the preview with the **same viewports, masks,
   and states** used for the reference:

```bash
node .codex/skills/migrate-php-to-astro-iui/scripts/capture-visual-spec.mjs \
  --url "http://127.0.0.1:4321/trains/example-to-example-train-tickets" \
  --label candidate \
  --viewports "390x844,768x1024,1440x900" \
  --mask ".ad-slot,[data-testid='live-timer']" \
  --out ".agentify/php-astro-migration/example/candidate"
```

5. Run the fidelity gate and fix what it reports:

```bash
node .codex/skills/migrate-php-to-astro-iui/scripts/compare-visual-parity.mjs \
  --reference ".agentify/php-astro-migration/example/reference" \
  --candidate ".agentify/php-astro-migration/example/candidate" \
  --out ".agentify/php-astro-migration/example/parity"
```

   It exits non-zero until the route matches. `findings-<viewport>.json` lists
   every mismatched element with expected and actual values — work that list
   top-down, recapture, and rerun. Inspect `diff-<viewport>.png` for regions the
   element diff cannot express, such as backgrounds, gradients, and icon shapes.
   Repeat for every captured state, not only the default one.

6. Audit the rendered representative route:

```bash
node .codex/skills/migrate-php-to-astro-iui/scripts/audit-rendered-route.mjs \
  "http://127.0.0.1:4321/trains/example-to-example-train-tickets" \
  --expect-canonical \
  "https://www.confirmtkt.com/trains/example-to-example-train-tickets" \
  --output ".agentify/php-astro-migration/example/rendered-audit.json"
```

7. Run Lighthouse at least three times per required profile and report the
   median. Inspect the actual report rather than only the aggregate score.
8. Fix owned failures, rebuild, recapture, and rerun the affected gates until
   they pass. **A green build with a failing parity report is not done.**

Stop only when required gates pass or an external dependency blocks progress.
For a blocker, report the exact gate, command or URL, failure evidence, and
which parts remain verified.

## Guardrails

- Do not copy the PHP file line-for-line, port AMP boilerplate, or paste
  thousands of lines of legacy stylesheet. Reproduce the *rendered result* from
  the captured spec, not the source that produced it.
- Do not redesign, modernize, tidy, or "improve" the appearance. No new spacing
  scale, no rounder corners, no updated palette, no rearranged sections.
- Do not accept a visual difference because a design-system component imposes
  it. Override it, or stop using the component.
- Do not declare parity from code inspection, component reuse, a single
  viewport, a development-server capture, or an unmasked comparison against
  volatile data.
- Do not compare against a differently-sized or differently-throttled capture.
  Same viewports, same masks, same states, same device scale factor on both
  sides.
- Do not raise `--pixel-threshold`, widen `--box-tolerance`, or add
  `--ignore-props` to make a run pass. Those flags exist for a documented,
  user-approved reason (a masked ad slot, a known font-metric limitation) and
  every use must appear in the completion report.
- Do not invent API fallbacks, response fields, route aliases, or SEO copy.
- Do not bypass TLS verification or move a server API call into the browser.
- Do not import an IUI component without verifying it exists in the installed
  version and observing a local usage example.
- Do not hydrate the full page for convenience.
- Do not emit structured data for content that users cannot see.
- Do not delete legacy behavior silently. Mark it preserved, replaced, or
  intentionally retired with evidence.

## Completion report

Finish with:

- Source file and destination route.
- Architecture and migration-map summary.
- Changed files and preserved contracts.
- **Fidelity result per viewport and state**: pixel mismatch percent, matched /
  mismatched / missing / extra element counts, and the verdict from
  `visual-parity.json`.
- Any remaining visual difference, each classified as `fixed`,
  `data variance`, `masked`, `blocked`, or `user-approved divergence`, with the
  reason. Never report "looks the same."
- Every tolerance flag used and its justification.
- Legacy visual defects reproduced on purpose, offered as optional follow-up
  fixes.
- Components reused, components rejected for fidelity reasons, and any justified
  new component.
- Exact validation commands and results.
- Screenshot, diff, parity-report, rendered-audit, and Lighthouse artifact paths.
- Blocked gates or unverified external behavior.
