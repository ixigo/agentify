# Visual and content parity checklist

Visual parity means preserving the recognizable information hierarchy,
brand language, states, and task flow while expressing them through the current
design system. It does not mean copying legacy pixels or CSS defects.

## Baseline

Capture the same representative route at:

- Mobile viewport used by the product.
- Desktop viewport used by the product.
- Loaded/default state.
- Empty or no-result state.
- Error state when it can be reproduced safely.
- Important interactive states such as open picker, expanded FAQ, or dialog.

Record the URL, viewport, data/date, authentication state, and capture time.

## Compare in this order

### 1. Content contract

- Primary heading, route names, counts, dates, and fares.
- Section presence and order.
- Train/result fields and labels.
- Supporting SEO copy, FAQs, and internal links.
- Calls to action and navigation destinations.
- Empty, error, loading, and unavailable content.

### 2. Information hierarchy

- Header and search prominence.
- Primary action prominence.
- Heading levels and grouping.
- Result-card/table scan order.
- Mobile collapse or reorder behavior.

### 3. Brand and component fidelity

- ConfirmTkt layout, typography, color, spacing, radius, and icon language.
- Existing IUI control appearance and states.
- Header, footer, breadcrumbs, app-install, and other shared surfaces.
- No one-off styling language introduced by the migration.

### 4. Geometry and responsive behavior

- Container width, columns, gaps, alignment, and wrapping.
- Image aspect ratios and reserved space.
- Sticky/fixed elements and safe-area behavior.
- Text overflow, long route names, localization, and zoom/reflow.

### 5. Interaction

- Keyboard and pointer behavior.
- Focus placement and visible focus.
- Search/date/selection state.
- Links, redirects, deep links, analytics, and back navigation.
- Loading and error recovery.

## Evidence

Prefer:

- Full-page before/after screenshots.
- Scoped screenshots for primary components.
- Stable `data-testid` anchors used only at the owned feature root.
- A short difference log classified as fixed, intentional modernization, data
  variance, or blocked.

Do not claim exact parity when the source cannot be rendered, the data differs,
fonts/assets are unavailable, or only one viewport was checked. State the
verified scope precisely.
