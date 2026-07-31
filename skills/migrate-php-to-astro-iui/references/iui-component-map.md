# IUI and local component mapping

Reuse by user intent, then prove the component can render the reference exactly.
Verify every component against the installed `@ixigo/iui` version and a current
repository example.

Reuse is a means of matching the reference with less code — it is never a reason
to accept a visual difference. A component that cannot be made to match is the
wrong component for this migration, however well it fits semantically.

## Discovery commands

Run from the Astro project root:

```bash
rg -n "from '@ixigo/iui|from \"@ixigo/iui" src
rg -n "from '@ixigo/icons|from \"@ixigo/icons" src
rg --files src/components src/screens | sort
```

Search for the intended interaction or content name as well as the IUI import.
Local wrappers often own brand, spacing, analytics, or responsive behavior that
a raw primitive does not.

## Intent map

| Legacy intent | Search locally first | Typical IUI primitive to verify |
| --- | --- | --- |
| Page title, labels, body copy | Typography wrappers and nearby pages | `Typography` |
| Primary or secondary action | Brand button wrappers | `Button` |
| Search fields | Existing train search forms | `Input`, `Button` |
| Date selection | Existing train/date controls | Current date-picker surface |
| FAQ disclosure | Existing FAQ component | `Accordion`, `AccordionHead`, `AccordionBody` |
| Tabs or grouped panels | Existing tabs in the same brand | `Tabs`, `TabList`, `Tab`, `TabPanel` |
| Mobile drawer/modal | Existing sheet/dialog wrapper | `Dialog` or current sheet surface |
| Compact filters or choices | Existing filter components | `Chip`, `Checkbox` |
| Repeating horizontal content | Existing carousel wrapper | `Carousel`, `CarouselItem` |
| Header/footer/navigation | ConfirmTkt layout components | Local component, not a new primitive |
| Breadcrumbs | Existing Astro breadcrumb component | Local component |
| Train search/results | Existing train components and API model | Adapt local component before creating one |

The names above are candidates, not guarantees. Package exports change.

## Reuse decision

Use this order:

1. Existing ConfirmTkt component with matching behavior.
2. Existing shared component already used by ConfirmTkt.
3. Existing IUI primitive composed with semantic HTML.
4. Semantic Astro markup for static content.
5. A new focused component when no owner exists.

**Fidelity test.** Before adopting a candidate, compare its rendered values
against the reference `visual-spec.json` entry for that surface: font family,
size, weight, line height, letter spacing, color, background, padding, border
width and color, radius, shadow, and the box dimensions it produces. Then:

- Values match, or match after a supported prop/token override → reuse it.
- Values differ but the component exposes a sanctioned styling seam
  (`className`, a CSS-module override, a variant prop) → reuse it and apply the
  exact reference values through that seam.
- Values differ and matching would require fighting the component — overriding
  internals, `!important` cascades, or wrapper hacks that break its states →
  **do not use it.** Drop to semantic markup with exact CSS and record the
  rejection and its reason in the migration map.

Never adopt a component and then adjust the design toward what it renders.

When adapting an existing component, preserve its public contract and avoid
adding route-specific conditions to a generic component. A small page adapter
is usually safer.

## Styling rules

- Use the exact values from the reference spec. Prefer a repository token when
  it resolves to that exact value; otherwise use the literal value and note it.
  Do not round to the nearest token — a "close" token is a visual defect.
- A cluster of literal values means the reference predates the current token
  set. Report the pattern to the user instead of quietly reconciling it.
- Keep semantic elements: headings, lists, tables, links, buttons, and forms —
  chosen so they do not change rendered output. Reset the user-agent defaults
  the new element introduces.
- Keep selectors local and avoid broad element resets.
- Do not recreate an IUI component in CSS when the component itself can match.
- Do not copy AMP boilerplate, normalize styles, or legacy utility classes;
  reproduce their rendered effect instead, then verify that removing them did
  not shift anything.
- Match focus, hover, active, disabled, loading, empty, and error appearance
  against captured reference states, not against component defaults.

## Hydration check

For every React component, answer:

- What browser-only state or event requires hydration?
- Can the surrounding content remain Astro?
- Can the island receive server-normalized props without fetching again?
- Can it load on visibility or interaction instead of initial page load?

If there is no browser-only requirement, render the surface in Astro.
