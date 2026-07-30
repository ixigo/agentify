# Migration contract

Use this contract to separate behavior that must survive the migration from
legacy implementation details that should not.

## Inventory template

Create one row for every meaningful legacy surface:

```text
legacy surface | source owner | input/data | public behavior | destination owner | treatment | verification
```

Allowed treatments:

- `preserve`: behavior and presentation remain materially the same.
- `adapt`: preserve intent through the destination architecture or design
  system.
- `replace`: use an existing destination component with the same contract.
- `retire`: remove obsolete behavior with an explicit reason.
- `defer`: keep out of the current phase with a named follow-up boundary.

Do not use `copy` as a treatment. Copying markup or CSS is an implementation
choice, not evidence that behavior was preserved.

## Public route contract

Record:

- Accepted path shapes and query parameters.
- Case, whitespace, encoding, slug, station, city, and language normalization.
- Canonical construction and every redirect condition.
- HTTP status for valid, alias, malformed, empty, and upstream-failure cases.
- Date and timezone defaults.
- Cache headers and request-vary inputs.
- Booking, deep-link, schedule, running-status, return-trip, and related links.

Redirect tests must assert the destination and number of hops.

## Data contract

Record:

- API host, endpoint, method, headers, and exact parameter names.
- Which inputs are server-derived versus user-derived.
- Required and optional response fields.
- Direct, nearby, empty, partial, redirect, and error payload shapes.
- Timeout, retry, stale-data, and fallback semantics.
- Derived values such as counts, fares, first/last/fastest trains, daily or
  weekly subsets, and availability status.

Keep a sanitized fixture for every materially different state. Never turn an
upstream failure into a valid empty result.

## Content and SEO contract

Record:

- Title, description, canonical, robots, hreflang, Open Graph, and Twitter.
- One primary heading and the visible section outline.
- Structured-data types and the visible content that supports each one.
- FAQ questions and answers.
- Route facts, tables, related links, and calls to action.
- Language and brand variants.

Generate metadata, visible copy, and structured data from the same normalized
page model.

## UI and interaction contract

Record:

- Desktop and mobile hierarchy, order, spacing, and responsive changes.
- Search, date, class, train, accordion, modal, and booking interactions.
- Loading, empty, error, disabled, and focus states.
- Analytics event names and impression/click boundaries.
- Existing ConfirmTkt, IUI, icon, token, layout, and footer/header owners.

Visual similarity is judged on hierarchy, geometry, typography, color,
content, and state behavior. Do not preserve AMP wrappers, duplicated
responsive trees, utility class names, or obsolete CSS merely because they
exist.

## Evidence required at completion

For every `preserve`, `adapt`, or `replace` row, link at least one of:

- Unit or integration test.
- Rendered HTML audit.
- HTTP assertion.
- Desktop/mobile screenshot.
- Accessibility check.
- Production build output.
- Lighthouse report.

For every `retire` or `defer` row, state the product or technical rationale and
who owns the follow-up decision.
