# Migration contract

Use this contract to separate behavior that must survive the migration from
legacy implementation details that should not.

## Inventory template

Create one row for every meaningful legacy surface:

```text
legacy surface | source owner | input/data | public behavior | destination owner | treatment | verification
```

Allowed treatments:

- `preserve`: behavior and presentation are reproduced exactly.
- `adapt`: behavior is re-expressed through the destination architecture while
  the rendered output stays identical.
- `replace`: an existing destination component takes over, verified to render
  identically to the reference.
- `retire`: remove obsolete behavior with an explicit reason and user approval
  when anything visible changes.
- `defer`: keep out of the current phase with a named follow-up boundary.

`adapt` and `replace` describe the implementation, never the appearance. A
treatment that produces a visible difference is not `adapt` — it is a
divergence, and it needs the user's approval before it ships.

Do not use `copy` as a treatment. Copying markup or CSS is an implementation
choice, not evidence that behavior was preserved — and pasting a legacy
stylesheet is not how fidelity is achieved. Reproduce the rendered result from
the captured visual spec.

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

Visual parity is judged by measurement, not by resemblance: pixel diff plus
element geometry and computed styles, at every captured viewport and state. See
`visual-parity-checklist.md` for the gates.

Reproduce the rendered result, not the source that produced it. Do not carry
over AMP wrappers, duplicated responsive trees, utility class names, or obsolete
CSS — and do not let dropping them change a single rendered pixel.

Every visible surface in this section needs a fidelity plan: the exact values it
must hit, and which component defaults must be overridden to hit them.

## Evidence required at completion

For every `preserve`, `adapt`, or `replace` row, link at least one of:

- Unit or integration test.
- Rendered HTML audit.
- HTTP assertion.
- Accessibility check.
- Production build output.
- Lighthouse report.

Every row that owns a visible surface additionally requires the parity report
entry covering it: pixel mismatch percent for its viewports plus a clean element
diff. A screenshot on its own is not evidence of parity — it is evidence that
something was captured.

For every `retire` or `defer` row, state the product or technical rationale and
who owns the follow-up decision.
