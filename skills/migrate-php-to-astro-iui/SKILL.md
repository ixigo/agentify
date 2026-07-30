---
name: migrate-php-to-astro-iui
description: Migrate legacy ConfirmTkt PHP or AMP pages from UI/Website into the Astro seo-pages application while preserving route, data, content, SEO, and visual contracts. Use when a PHP page must become a server-first Astro route that reuses existing ConfirmTkt components and @ixigo/iui, minimizes client hydration, and is iteratively verified with build, accessibility, visual-parity, SEO, Core Web Vitals, and Lighthouse evidence.
---

# Migrate PHP to Astro IUI

Migrate the page through a repository-first evidence loop. Preserve the legacy
contract, but express it through the destination app's current architecture and
design system instead of transliterating PHP, AMP markup, or CSS.

## Required inputs

Resolve these from the request and repository before editing:

- Legacy PHP entry file and any included files that own behavior.
- Destination Astro project, brand, route shape, and representative route.
- Existing production or locally rendered legacy URL, when available.
- API contract, redirect/canonical rules, supported languages, and empty/error
  behavior.
- Quality thresholds explicitly requested by the user.

Do not block on details that repository inspection can answer. Ask only when a
choice would materially change public behavior and cannot be established from
code or a live reference.

## Load the relevant references

Read these files before implementation:

- [references/confirmtkt-astro-conventions.md](references/confirmtkt-astro-conventions.md)
  for repository discovery, route ownership, data boundaries, and hydration.
- [references/iui-component-map.md](references/iui-component-map.md) before
  selecting or creating UI components.
- [references/migration-contract.md](references/migration-contract.md) while
  inventorying behavior and assigning each legacy surface a treatment.
- [references/quality-gates.md](references/quality-gates.md)
  before defining acceptance criteria or running final validation.
- [references/visual-parity-checklist.md](references/visual-parity-checklist.md)
  when a legacy page, screenshot, or production URL can be compared visually.

Treat every path and component name in the references as a search cue. Verify
the current repository before using it.

## Workflow

### 1. Establish repository boundaries

1. Read the applicable `AGENTS.md`, imported instructions, and nearest nested
   instructions for both source and destination.
2. Inspect branch, staged changes, unstaged changes, and untracked files.
3. Identify the project package manager, required Node version, package
   scripts, rendering mode, brand configuration, and deployment adapter.
4. Run the mandatory modern-web-guidance search for current HTML, performance,
   accessibility, and browser guidance before implementing frontend code.
5. Preserve unrelated user changes. Do not commit or push unless the user
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

### 3. Capture the baseline

When the legacy route is runnable, capture desktop and mobile screenshots plus
its rendered HTML before editing. Prefer the user-selected Browser or Chrome
surface when one is explicitly named. Otherwise use the repository's supported
local visual tooling.

If the source cannot run, use the PHP inventory and any supplied screenshot as
the baseline. State that visual fidelity is only partially verifiable.

Store generated evidence under
`.agentify/php-astro-migration/<task-key>/`; do not commit it unless requested.

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
legacy surface | contract | destination owner | treatment | evidence
```

Use `reuse`, `adapt`, `semantic Astro`, `new component`, or `omit with reason`
as treatments. Do not start implementation until every important legacy
surface has an owner or an explicit omission rationale.

### 5. Choose and state the architecture

Default to:

- A thin Astro page route that validates params and composes a screen.
- A server-only API adapter that preserves request semantics.
- A typed normalized page model consumed by metadata and rendering.
- Astro components for static and server-rendered content.
- Small React islands only for interactions that require browser state.
- Existing ConfirmTkt/IUI components before new primitives or styling.

Keep canonicalization and redirects at the earliest server-owned seam. Avoid a
client redirect or a duplicate fetch to discover the canonical route.

State the chosen route, data, metadata, component, hydration, caching, and
failure-state boundaries before making broad changes.

### 6. Implement in contract-sized slices

Implement in this order:

1. Route parsing, input normalization, redirect rules, and typed data adapter.
2. Metadata, canonical, hreflang, robots, and schema driven from normalized
   server data.
3. Semantic page skeleton and visible primary content.
4. Existing design-system components and responsive layout.
5. Isolated interactive islands, analytics, and deep links.
6. Empty, error, invalid-route, and slow-data states.

Prefer source HTML order that is meaningful without CSS or JavaScript. Keep
critical content and primary headings in the server response.

### 7. Validate and iterate

Run focused checks after each slice and the full relevant project gates before
finishing:

1. Format and lint changed files.
2. Run Astro/type checks, focused tests, and the production brand build.
3. Preview the production build; do not use the development server for final
   Lighthouse claims.
4. Audit the rendered representative route:

```bash
node .codex/skills/migrate-php-to-astro-iui/scripts/audit-rendered-route.mjs \
  "http://127.0.0.1:4321/trains/example-to-example-train-tickets" \
  --expect-canonical \
  "https://www.confirmtkt.com/trains/example-to-example-train-tickets" \
  --output ".agentify/php-astro-migration/example/rendered-audit.json"
```

5. Compare desktop and mobile screenshots against the baseline. If
   `ui-screenshot-eval` is installed, use it for stable full-page and scoped
   evidence.
6. Run Lighthouse at least three times per required profile and report the
   median. Inspect the actual report rather than only the aggregate score.
7. Fix owned failures, rebuild, and rerun the affected gates until they pass.

Stop only when required gates pass or an external dependency blocks progress.
For a blocker, report the exact gate, command or URL, failure evidence, and
which parts remain verified.

## Guardrails

- Do not copy the PHP file line-for-line or bring over thousands of lines of
  legacy/AMP CSS.
- Do not invent API fallbacks, response fields, route aliases, or SEO copy.
- Do not bypass TLS verification or move a server API call into the browser.
- Do not introduce a new visual language when a local component, IUI primitive,
  or token already owns the intent.
- Do not import an IUI component without verifying it exists in the installed
  version and observing a local usage example.
- Do not hydrate the full page for convenience.
- Do not emit structured data for content that users cannot see.
- Do not declare visual parity from code inspection, accessibility from lint
  alone, or Lighthouse success from one noisy development-server run.
- Do not delete legacy behavior silently. Mark it preserved, replaced, or
  intentionally retired with evidence.

## Completion report

Finish with:

- Source file and destination route.
- Architecture and migration-map summary.
- Changed files and preserved contracts.
- IUI/existing components reused and any justified new component.
- Exact validation commands and results.
- Screenshot, rendered-audit, and Lighthouse artifact paths.
- Remaining differences, blocked gates, or unverified external behavior.
