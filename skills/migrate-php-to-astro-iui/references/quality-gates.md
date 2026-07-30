# SEO, accessibility, performance, and quality gates

Define thresholds before implementation. Use stricter repository or
user-provided requirements when present.

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

## Evidence table

Report each gate as `pass`, `fail`, `blocked`, or `not run`, with:

```text
gate | command or URL | result | artifact | limitation
```

Never collapse partial validation into a generic "all checks passed."
