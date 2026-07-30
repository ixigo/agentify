# IUI and local component mapping

Reuse by user intent, not by visual resemblance alone. Verify every component
against the installed `@ixigo/iui` version and a current repository example.

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

When adapting an existing component, preserve its public contract and avoid
adding route-specific conditions to a generic component. A small page adapter
is usually safer.

## Styling rules

- Reuse typography, color, spacing, radius, shadow, and breakpoint tokens.
- Keep semantic elements: headings, lists, tables, links, buttons, and forms.
- Use CSS only for page composition or a missing visual arrangement.
- Keep selectors local and avoid broad element resets.
- Do not recreate an IUI component in CSS.
- Do not copy AMP boilerplate, normalize styles, or legacy utility classes.
- Verify focus, hover, active, disabled, loading, empty, and error states.

## Hydration check

For every React component, answer:

- What browser-only state or event requires hydration?
- Can the surrounding content remain Astro?
- Can the island receive server-normalized props without fetching again?
- Can it load on visibility or interaction instead of initial page load?

If there is no browser-only requirement, render the surface in Astro.
