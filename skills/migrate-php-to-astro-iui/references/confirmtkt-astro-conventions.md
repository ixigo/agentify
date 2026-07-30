# ConfirmTkt PHP to Astro conventions

Use this reference as a discovery checklist. Repository code and applicable
instructions remain authoritative.

## Locate ownership before editing

Inspect:

- Root and nested `AGENTS.md` files.
- `package.json`, workspace configuration, Node engine, Astro config, aliases,
  adapter, middleware, and brand environment variables.
- Similar routes under `src/pages`, their screen composition, and their
  layouts.
- Existing `MetaTag`, schema, breadcrumb, header, footer, app-install, search,
  and error-state surfaces.
- Existing API clients, configuration hosts, request helpers, types, and cache
  policy.
- Existing ConfirmTkt components and current `@ixigo/iui` usage.

Prefer the nearest page with the same rendering and data shape over a
superficially similar visual page.

## Route boundary

Keep the Astro page thin:

1. Parse and validate path/query inputs.
2. Normalize case, separators, codes, language, and default date exactly once.
3. Return an early redirect or status when required.
4. Fetch through a server-only adapter.
5. Convert the API response into a typed page model.
6. Derive metadata and visible content from the same model.
7. Compose a screen component.

Do not allow route parsing, API response shape, and display formatting to leak
through every component.

For dynamic SEO routes, test representative valid, alias, uppercase, invalid,
empty, and upstream-failure cases. Redirects should be single-hop and should
not require client JavaScript.

## Data boundary

Preserve:

- Endpoint and host selection.
- Parameter names and encoding.
- Date/timezone defaults.
- Language and brand values.
- Required headers and credentials.
- Timeout, retry, empty-result, and error semantics.

Use a server-only module for secrets or internal hosts. Normalize the response
into a stable page model with named fields rather than passing the raw payload
to UI components.

Use one resolved page model for:

- Canonical and alternate URLs.
- Title, description, and social metadata.
- Breadcrumbs and primary heading.
- Visible route summary and list/table content.
- JSON-LD.

This prevents metadata and body content from drifting.

## Rendering and hydration

Use Astro for content that is available at request time:

- Primary heading and route summary.
- Train or result lists.
- Explanatory SEO content.
- FAQs, tables, breadcrumbs, and internal links.
- Empty and error messages.

Use a React island only when the user interaction requires browser state, such
as an autocomplete, date picker, modal, or client-side tracking boundary.
Choose the narrowest `client:*` directive that still satisfies the behavior.

Do not fetch the primary route data again inside a hydrated island.

## Component and file boundaries

- Reuse an existing component when its public contract matches the intent.
- Keep Astro composition in `.astro`.
- Keep React interaction in a focused `.tsx` component.
- Keep exported/shared types in the nearest dedicated type module when local
  repository rules require it.
- Keep server adapters and normalization outside UI files.
- Put only page-specific layout styling beside the owning component.
- Prefer existing tokens and responsive utilities over new global CSS.

## Brand behavior

Verify how the project switches ConfirmTkt and Ixigo at build or request time.
Do not hardcode a ConfirmTkt-only component into a shared surface without
respecting the established brand boundary.

When the task targets ConfirmTkt first, keep the data/page model brand-neutral
where practical and isolate brand-specific composition or metadata at the
existing owner seam.
