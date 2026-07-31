# SEO, accessibility, performance, and quality gates

Define thresholds before implementation. Use stricter repository or
user-provided requirements when present.

## Visual fidelity gate

This gate outranks every other gate in this file. See
`visual-parity-checklist.md` for the full procedure.

| Metric | Target |
| --- | --- |
| Full-page pixel mismatch per viewport | at most 0.20% |
| Full-page height delta | at most 2px |
| Element geometry delta | at most 1px per edge or dimension |
| Computed-style mismatches | 0 |
| Missing reference content elements | 0 |

```bash
node .codex/skills/migrate-php-to-astro-iui/scripts/compare-visual-parity.mjs \
  --reference <reference-spec-dir> \
  --candidate <candidate-spec-dir> \
  --out <parity-out-dir>
```

The command exits non-zero until the route matches. Run it for every captured
state, not only the default one.

When this gate conflicts with anything below — a Lighthouse score, a bundle
budget, an accessibility improvement that changes rendered pixels — fidelity
wins and the conflict is reported to the user with evidence. Do not resolve it
by changing the appearance, and do not resolve it by loosening a tolerance.

## Indexable route contract

Verify the production-rendered response:

- Returns the intended HTTP status without a client redirect.
- Contains useful primary content without JavaScript.
- Has one descriptive `h1` and a logical heading outline.
- Has a unique title and meta description derived from resolved route data.
- Has one absolute canonical URL matching the normalized route.
- Emits reciprocal, absolute hreflang URLs for supported languages.
- Sets robots intentionally for valid, invalid, empty, and error states.
- Includes Open Graph and Twitter fields owned by the existing page/layout.
- Uses crawlable internal links with meaningful anchor text.
- Avoids duplicate, thin, placeholder, or hidden-only SEO content.

Test uppercase, alias, malformed, no-result, and upstream-error URLs. Document
whether each case redirects, renders an indexable response, returns `404`, or
uses `noindex`.

## Structured data

- Parse every `application/ld+json` block as JSON.
- Use only schema types justified by visible content.
- Keep names, URLs, dates, prices, counts, and FAQs consistent with the body.
- Prefer existing schema components and project conventions.
- Do not treat schema-validator syntax success as proof that content is eligible
  for a rich result.

## Accessibility

At minimum verify:

- Document language and page landmarks.
- Keyboard order, visible focus, and no keyboard trap.
- Correct native element for links, buttons, tables, and forms.
- Labels or accessible names for every control.
- Alternative text presence and decorative-image handling.
- Heading order and a single primary heading.
- Error/loading announcements for interactive islands.
- Contrast and zoom/reflow at mobile and desktop widths.

Lint is evidence, not a complete accessibility audit.

Corrections that do not change rendered pixels — landmarks, `alt` text, labels,
correct native elements, heading levels, ARIA, focus order — are always in
scope. When a native element changes appearance through user-agent styles, reset
those styles so the output stays identical.

A correction that *does* change appearance — contrast, focus-ring visibility,
hit-area size, font size — must be raised with the user and approved before it
ships. Report it as a recommendation with the reference values and the proposed
values; do not apply it unilaterally and do not drop it silently.

## Production validation

Run the project's own commands using its required Node version. A typical Astro
sequence is:

```bash
pnpm format
pnpm lint
pnpm build
pnpm preview
```

Prefer a format check or changed-file formatting when the project formatter
would rewrite unrelated files.

Audit the rendered route with the bundled script. Treat its regex-based checks
as a fast deterministic gate, then inspect the rendered document and browser
accessibility tree for behavior it cannot prove.

## Lighthouse and Core Web Vitals

Run Lighthouse against the production preview or deployed build. Use a stable
viewport, throttling profile, and route state. Run at least three times and
report the median plus report paths.

Unless the user or repository defines stricter gates, target:

| Metric | Target |
| --- | --- |
| Lighthouse Performance | at least 95 |
| Lighthouse Accessibility | at least 95 |
| Lighthouse Best Practices | at least 95 |
| Lighthouse SEO | at least 95 |
| LCP | at most 2.5 seconds |
| CLS | at most 0.10 |
| INP field target | at most 200 milliseconds |

Lighthouse lab runs do not directly measure field INP. Use Total Blocking Time
and interaction traces as lab diagnostics, and label field data separately.

Inspect regressions in:

- Server response and API latency.
- LCP resource discovery, priority, sizing, and format.
- Font loading and metric stability.
- Hydrated JavaScript and third-party work.
- Layout shifts from images, ads, fonts, or async islands.
- Long tasks and interaction handlers.
- Render-blocking styles or scripts.

Do not lower a threshold to make a run pass. Fix owned causes, rerun the
production build, and disclose external or noisy limitations.

Fix performance without touching the output: preload and prioritize the LCP
resource, serve modern formats at the same rendered size, subset and preload the
reference fonts with matching metrics, defer or shrink hydration, remove
render-blocking work. If a target remains unreachable without a visible change,
report the trade-off and let the user choose. Never ship the visible change and
call the score a pass.

## Evidence table

Report each gate as `pass`, `fail`, `blocked`, or `not run`, with:

```text
gate | command or URL | result | artifact | limitation
```

Include one visual-fidelity row per viewport and per captured state, each with
its pixel mismatch percent and element-diff counts.

Never collapse partial validation into a generic "all checks passed," and never
report fidelity as a qualitative judgement when the numbers exist.
