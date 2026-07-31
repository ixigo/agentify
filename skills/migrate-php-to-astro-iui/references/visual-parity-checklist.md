# Visual parity checklist

Visual parity means the migrated route renders **identically** to the reference:
same geometry, typography, color, spacing, imagery, and states, at every
captured viewport. Recognizable is not identical. Similar is not identical.

The implementation modernizes. The output does not change.

## Numeric gates

| Signal | Gate |
| --- | --- |
| Full-page pixel mismatch | at most 0.20% per viewport |
| Full-page height delta | at most 2px |
| Element `x`, `y`, `width`, `height` | at most 1px each |
| Enumerated computed styles | exact |
| Color channel tolerance | 8 / 255 per channel |
| Length tolerance | 0.5px |
| Missing reference content elements | 0 |
| Horizontal overflow behavior | must match |

These are defaults. Use stricter values when the user or repository defines
them. Never loosen them to make a run pass.

## Capture

Use `scripts/capture-visual-spec.mjs` for both sides. It records a full-page
screenshot plus the geometry and computed styles of every visible element.

Capture the reference **before implementing**, and capture the candidate from a
**production preview build**, never the dev server.

Both sides must share:

- The same viewport list — at minimum one mobile, one tablet, and one desktop
  width that the product actually uses.
- The same `--mask` selectors for volatile regions (ads, live timers, rotating
  offers, session-specific content).
- The same device scale factor, animation freezing, and settle delay.
- Comparable data. Prefer the same route, date, and authentication state; when
  upstream data cannot be pinned, mask the varying region rather than accepting
  the diff.

Capture each of these as its own spec directory:

- Loaded/default state.
- Empty or no-result state.
- Error state, when it can be reproduced safely.
- Each important interactive state: open picker, expanded FAQ, dialog, sticky
  header after scroll, hover and focus on primary controls.

Record the URL, viewport, data date, authentication state, and capture time for
every capture.

## Compare

Run `scripts/compare-visual-parity.mjs`. It exits non-zero until the gates pass.
Two independent signals are produced, and both matter:

- **`diff-<viewport>.png`** — pixel truth. Catches backgrounds, gradients,
  borders, icon shapes, font rendering, and anything that has no element anchor.
- **`findings-<viewport>.json`** — actionable truth. Names each mismatched
  element with expected and actual values.

A low pixel percentage does not prove parity on its own: a 1px padding shift on
one button can stay under the pixel threshold while being a real defect. Both
signals must be clean.

Work findings top-down. Structural failures (missing elements, container width,
breakpoint behavior) cause cascades of downstream position diffs — fix those
first and recapture before chasing individual style deltas.

## Manual review the tools cannot cover

After the automated gates pass, verify by hand:

- Hover, focus-visible, active, disabled, loading, and error appearance of every
  interactive control.
- Scroll-dependent behavior: sticky headers, reveal animations, parallax,
  lazy-loaded imagery.
- Text overflow and wrapping with the longest real route names, and with the
  supported languages.
- Zoom and reflow at 200%.
- Image aspect ratios, intrinsic sizes, `object-fit`, and reserved space.
- Print or reduced-motion variants when the legacy page defined them.
- Cross-browser rendering when the product supports non-Chromium browsers; the
  capture tool is Chromium-only.

## Classifying a remaining difference

Every difference left at completion gets exactly one label:

- `fixed` — resolved; parity report is clean.
- `data variance` — different upstream data, not a rendering difference. Prove
  it by masking the region and rerunning.
- `masked` — deliberately excluded from comparison; state the selector and why.
- `blocked` — cannot be verified (reference unrenderable, font or asset
  unavailable, upstream down). State exactly what is unverified.
- `user-approved divergence` — the user explicitly agreed to the change. Cite
  where they agreed.

There is no "close enough" label. If a difference does not fit one of these,
it is unresolved work.

## Honesty rules

- Do not claim parity for viewports or states you did not capture.
- Do not claim parity when the reference could not be rendered; say fidelity was
  verified by inspection against static screenshots only.
- Do not present a masked region as verified.
- Do not report a score without the artifact paths that produced it.
