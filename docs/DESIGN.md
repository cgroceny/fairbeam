# Design guide

`design-system/tokens.css` is the single source of truth. This page explains the rules behind it. When the two disagree, the tokens file wins; fix this page.

## Identity

Fairbeam should read like a measuring instrument. Keep it calm, dense and precise, with nothing decorative.

- **Warm paper neutrals.** The neutral ramp is `--al-paper-*`: off-white paper in light mode, graphite in dark mode. Surfaces are separated by small steps in tone and by hairline borders. Shadows (`--al-shadow-pop`) are only for floating elements such as popovers and dialogs.
- **Copper is the only accent** (`--al-copper-*`), the metal the antennas are made of. It is used for:
  - the one primary action on a screen (`--al-action`)
  - focus (`--al-focus`, `--al-focus-ring`)
  - selection (`--al-selection`)
  - accent text sparingly (`--al-accent-text`)

  A screen with two copper buttons has a hierarchy problem.
- **Type.** Use IBM Plex Sans for UI text (`--al-font-sans`) and IBM Plex Mono for numbers, units and code (`--al-font-mono`). Numbers in tables and spec sheets use tabular figures (`font-variant-numeric: tabular-nums`) so columns align. The scale is compact (11–20 px, `--al-text-*`) because this is a dense tool, not a reading page.

## Tokens

- Components use **role tokens only**, for example `--al-bg`, `--al-surface`, `--al-text-2`, `--al-border`, `--al-action`, `--al-series-1` and `--al-3d-metal`.
- Components never use raw hex values, and never use a ramp step such as `--al-copper-600` directly. Ramp steps exist only so role tokens can be defined from them.
- Canvas and WebGL code that needs concrete colors reads role tokens at runtime (`src/lib/cssvar.ts`) and re-reads them when the theme changes.
- Spacing, radius and motion also come from tokens:
  - space: `--al-space-0` (2 px, hairline nudges only) and `--al-space-1` to `--al-space-7` (4, 8, 12, 16, 24, 32, 48 px), a 4 px base. Never use other values for padding, gaps or margins.
  - spacing roles, which say what a step is for: `--al-pad-panel` (16 px panel, dialog and header inset), `--al-pad-hud` (12 px inset of 3D overlays), `--al-gap-stack` (8 px between rows in a section), `--al-gap-cluster` (8 px between inline controls) and `--al-gap-label` (8 px from a section label to its content)
  - controls: `--al-control-h` 30 px and `--al-control-h-sm` 24 px (the minimum hit target), `--al-icon` 16 px, `--al-icon-sm` 14 px, `--al-icon-stroke` 1.75
  - radius: `--al-radius-sm`, `--al-radius`, `--al-radius-lg`
  - motion: `--al-ease`, `--al-dur` (140 ms)
- Layout sizes are tokens too: `--al-header-h`, `--al-left-w`, `--al-right-w`, `--al-dock-h`, `--al-dock-bar-h`. `--al-dock-h` is `clamp(300px, 34dvh, 440px)`, so the results dock grows on tall screens; a height the user drags wins over it.
- Interaction roles, all defined in both themes: `--al-accent` (native range inputs, strokes; the same as `--al-action`), `--al-link` (bare links), `--al-placeholder` (placeholder text, `--al-text-3`: 6.0:1 light, 6.6:1 dark), `--al-control-border` (the boundary of an input, select or filter field: `--al-border-strong`, at least 3:1) and `--al-radius-md`. Do not write `var(--al-x, #hex)` fallbacks: a name that is not in `tokens.css` is a bug.
- Segmented controls use `--al-track-bg`, `--al-track-hover`, `--al-selected-bg` and `--al-selected-ring`. The selected segment is a raised cell with a 1 px ring (5.2:1 against the track in light, 7.1:1 in dark), so it never looks like a hovered one.
- Overlay and brand colors are role tokens as well: `--al-scrim` behind dialogs and `--al-brand-mark` for the logo.

Text contrast on the default surfaces:

| Token | Light | Dark |
| --- | --- | --- |
| `--al-text` | 17.9:1 | 15.4:1 |
| `--al-text-2` | 6.9:1 | 9.9:1 |
| `--al-text-3` | 6.0:1 on surface, ≥ 4.75:1 on surface-3 / viewport | 6.6:1, ≥ 5.4:1 |
| `--al-chart-muted` (tick labels) | 5.2:1 | 5.2:1 |
| `--al-text-disabled` | intentionally low (disabled state only) | |

These ratios are computed from the token values, not estimated by eye. Recompute them whenever you change a text or surface token; every text role must stay at 4.5:1 or above on every surface it is used on.

Code editor syntax colors are role tokens as well (`--al-code-*`, defined in `editor.css` from existing roles). Numbers use `--al-code-number` from `tokens.css` (light 6.6:1, dark 5.9:1 on the surface) because `--al-series-1` is only 4.4:1 as text on the light surface. On the active line, the lowest ratio is comments at 5.4:1 in light mode and 6.2:1 in dark mode.

## Layout primitives

These classes live in `src/styles/app.css`. New UI (panels, dialogs, toolbars) should compose them rather than add one-off spacing.

**Structure**

- `.panel > .section`: a side-panel block with `--al-pad-panel` inset and a hairline between sections. Start a section with `.section-label`, an uppercase 11 px label with an 8 px gap below it. The label is a flex row, so a small action (`.btn-sm`, `.icon-btn-sm`, `.push`) can sit on its right.
- `.stack` / `.stack-sm` / `.stack-lg`: vertical flow with 8, 4 or 16 px gaps.
- `.cluster` / `.cluster-sm`: a wrapping row of inline controls with 8 or 4 px gaps. `.push` sends an item to the far end.

**Data**

- `.kv`: a spec list, `<dl>` with `<dt>`/`<dd>`. Values are right-aligned in tabular figures. Use `.kv-left` for prose values, and `.kv-sub` for a secondary line inside a value (it truncates with an ellipsis; put the full text in `title`).
- `.table`: numeric cells take `.num`. Put units on their own header line with `<span class="th-unit">GHz</span>`, and title the table with `<caption>`. For clickable rows use `tr.row-select` with `tabindex="0"`; add `.selected` for the current row.
- `.status` (pill) and `.status-block` (box) with `-good`, `-warn` or `-critical`. Always pair them with an icon and a label.

**Controls**

- `.btn` (30 px), `.btn-sm` (24 px), `.btn-primary` (at most one per screen) and `.btn-ghost`. Wrap button text in `<span class="btn-label">` if it may collapse to icon-only below 640 px.
- `.icon-btn` (30 px, 16 px icon), `.icon-btn-sm` (24 px, 14 px icon) and `.icon-btn-bordered` for use over the 3D view. The control sets the icon size, so the `size` prop on the icon does not matter.
- `.seg` with `.seg-btn` for a segmented control (add `.seg-sm` for mono labels). `.chip-btn` for a toggle chip. `.toggle` for a checkbox row, with `.toggle-list` around a group. Any other native `<input type="checkbox">` or `type="radio"` (dialogs, forms) is drawn by a global rule in `app.css` with the same 14 px box and copper fill, so do not add `accent-color` or a blue native control.
- Focus: every control shows `--al-focus-ring`. Controls inside a scrolling strip (tabs) or a segmented control use an inset ring instead, and table rows use an inset outline.

**Dialogs, menus and keyboard**

- Every modal calls `useModal(dialog, close, initial?)` from `src/lib/dialog.ts`. It handles initial focus, Escape, keeping Tab inside the dialog, and returning focus to the opener. Structure: `.scrim > .dialog`, then `.dialog-head` (title, description with `aria-describedby`, close icon button), `.dialog-body` (options column, then preview column) and `.dialog-foot` (muted meta text on the left, `.dialog-actions` on the right with at most one `.btn-primary`). Dialogs are full screen at ≤ 640 px. Give a scrollable preview `tabindex="0"`.
- Menus: `.menu` (fixed position, kept inside the viewport by the component), `.menu-item`, and `.menu-row` for inline options. They must support Up and Down, Home and End, and Escape (which returns focus to the trigger), and close on Tab, scroll and resize. The trigger has `aria-haspopup="menu"` and `aria-expanded`.
- Segmented choices: `role="radiogroup"` with `role="radio"` buttons and `onKeyDown={radioGroupKeys}` from `src/lib/a11y.ts`.

**Header collapse**

The header is one row at every width, and exactly one copper button stays in it. Label a header button with `<span class="btn-label collapse-xl">`: the label hides at ≤ 1280 px and the button becomes a square icon button, so it must also have an `aria-label` and a `title`. At ≤ 760 px every `.btn-label` in `.header-actions` hides. `.hide-sm` (≤ 640 px) and `.hide-xs` (≤ 480 px) remove secondary text or controls. New header buttons should follow the same order: collapse secondary actions first and hide optional ones last.

**Center stage**

The 3D | Drawing switch (`.stage-switch`) owns the top-left corner of `.stage`. A view's own top-left toolbar starts at `left: var(--al-stage-tl)`. The drawing view is a size container named `drawing`, and the white sheet sits on `--al-sheet-surround`.

**Charts and overlays**

- `.chart` is the positioned box. Its SVG is absolutely positioned, so a chart never sizes its own container.
- Put `.c-halo` on any label drawn over the plot area. Marker labels (R1, M1, …) share one `declutter()` pass and stack upward when they sit on the same point; the polar ring labels sit on the bearing where the fewest curves cross them; the Smith real-axis labels move below the axis where the trace crosses them.
- Polar charts label series directly only when the chart is at least 420 × 320 px, in the free ring outside the angle labels. Below that, the legend strip (text plus color key, with the units note at its end) identifies the series; in-plot labels collided with the ring and angle ticks.
- Result toolbars (the Results dock bar and the designer's result bar) keep to one row where they can. Below 1160 px of dock width (`.dock-narrow`, set from a `ResizeObserver` because the Figure menu is `position: fixed` inside the dock and a container query would re-anchor it; 1000 px for `.dw-result-bar.is-narrow`) the labeled buttons fold to their icon: the text stays in the button at `font-size: 0`, so the accessible name and the `title` tooltip are unchanged. Give every such button an icon and a `title`.
- Use `declutter()` from `src/charts/labels.ts` for any set of point labels. Pass axis labels as `fixed` obstacles.
- `.chart-note` goes in a corner; `.chart-note-top` moves it into the legend strip.
- `.vp-hud-tl`, `.vp-hud-tr` and `.vp-hud-br` anchor overlays at `--al-pad-hud` from the viewport edges. Color scales go inside the single `.vp-scales` container (top right), never in their own absolutely positioned box: two scales sit side by side with shorter ramps, and on narrow viewports they wrap under the view toolbar. The viewport is a size container named `viewport`, so an overlay can adapt with `@container viewport (max-width: …)`.

**Keyboard map**

| Where | Keys |
| --- | --- |
| 3D view (focus it with Tab or a click; inset focus ring) | Arrow keys orbit · Shift+arrow keys pan · + / − zoom · 1 Iso, 2 Top, 3 Front, 4 Right · 0 or F fit · Tab / Shift+Tab step through the parts (highlighted, announced with name, material and size) · Escape clears the part · Tab past the last part leaves the view |
| Dock tabs, tabs in the Run panel | Left / Right, Home / End |
| Segmented controls and chips (`role=radiogroup`) | Arrow keys select, Home / End (`radioGroupKeys`) |
| Menus (Figure, More, S-parameter picker) | Up / Down, Left / Right on chip rows, Home / End, Escape (focus back to the trigger), Tab closes |
| Dialogs | Escape closes, Tab stays inside, focus returns to the opener (`useModal`) |
| Drawing view (focused) | + / − zoom, 0 fit, drag to pan |

The 3D view announces view changes and the selected part through a polite `aria-live` region. There
is no camera animation, so nothing needs a `prefers-reduced-motion` exception.

**Error containment and loading**

Wrap every major region in `PanelBoundary` (`src/components/PanelBoundary.tsx`). It is an
`ErrorBoundary` plus `Suspense`. A render error shows "<Region> failed to render: <message>" with
Reload panel and a details toggle, only in that region. The region re-mounts when another project
opens. Load anything not needed for the first paint with `lazy()` inside a `PanelBoundary`: the
drawing, the export dialogs, the run drawer, the array tab and the figure generators. Keep three.js
in the main bundle. Bundles are validated on open (`src/lib/validate.ts`); repaired problems appear
in a warning banner (`.banner-warn`) with a details list.

**Breakpoints**

| Width | Layout |
| --- | --- |
| ≤ 1360 px | The header hides the cell count. |
| ≤ 1280 px | Narrower side panels; `.collapse-xl` header labels hide (Open, Export package). |
| ≤ 1180 px | The header also hides the model id. |
| ≤ 1040 px | Stacked: sticky header, view and dock first, then the two panels side by side. |
| ≤ 760 px | All header labels hide (Run included) and the status pill leaves the header. |
| ≤ 720 px | Panels in one column; the pattern stats are hidden. |
| ≤ 640 px | Compact header, `.btn-label` and `.hide-sm` hidden, full-screen dialogs. |
| ≤ 480 px | `.hide-xs` hidden (the screenshot button). |

## Status colors

- `--al-good`, `--al-warn` and `--al-critical`, with their `-bg` variants, are **reserved for status**. Examples: converged or not converged, hit the timestep limit, unvalidated export.
- Status colors are never used as series colors or decoration.
- A status is **always shown with an icon and a text label** as well as color, for example a check icon plus "Converged". Color alone never carries the meaning.

## Charts

- **Lines.** Data lines are 2 px. Avoid markers except on the hovered point.
- **Grid and axes.** The grid is recessive: hairlines in `--al-chart-grid`, axes in `--al-chart-axis`, labels in `--al-chart-muted`. Highlighted ranges such as matched bands use `--al-chart-band`.
- **Tooltip.** Hovering shows a vertical crosshair, and the tooltip lists **all series** at that x in legend order, with units. The units are taken from the axis titles, so write axis titles as "Name (unit)". The tooltip flips to the left of the crosshair in the right half of the plot, so it never leaves the chart.
- **Legend.** Charts with two or more series get a legend **and** direct labels in a gutter to the right of the plot, at the height of each line's end, for two to four series whose line ends in the right 15 % of the plot (the gutter is as wide as the widest label, at most 30 % of the chart; a longer label is cut with an ellipsis and carries its full text as a tooltip). The labels never sit over the data. A single series needs neither; the axis title names it. The legend sits in its own strip above the plot, never over the data.
- **Labels.** Labels must not overprint. Reference-line labels stay inside the plot at its right end, the direct labels in the gutter; each set is decluttered, and point labels are decluttered against the axis labels (`src/charts/labels.ts`). Labels drawn over the plot get a halo (`.c-halo`), not a box.
- **Numbers.** Axis ticks use step-aware precision (0, −10, −20, not 0.0, −10.0). Negative values use the minus sign (U+2212), not a hyphen: in the charts, and in every number shown as text (`fmt` in `src/i18n`). Inputs and exported data (CSV, Touchstone, the copied marker table, reports) keep the ASCII hyphen-minus and the decimal point, and never use `fmt` (`scripts/check-report-text.mjs` and `scripts/check-i18n.mjs` guard it).
- **One y-axis per chart.** Never use dual axes. Quantities with different units go in separate charts. For example, Zin real and imaginary parts share Ω, but |S11| in dB gets its own chart.
- **Every chart has a table view** that shows the same data as numbers (tabular figures, units in the header).
- **Categorical order is fixed.**

  | Order | Token | Color |
  | --- | --- | --- |
  | Series 1 | `--al-series-1` | blue |
  | Series 2 | `--al-series-2` | orange |
  | Series 3 | `--al-series-3` | aqua |
  | Series 4 | `--al-series-4` | yellow |
  | Series 5 | `--al-series-5` | magenta |
  | Series 6 | `--al-series-6` | green |
  | Series 7 | `--al-series-7` | violet |
  | Series 8 | `--al-series-8` | red |

  Series always take colors in this order, so the same slot means the same thing across charts. Series 3 falls below 3:1 contrast on the light surface, so whenever it is used it **must** have a direct label, not only a legend swatch.
- **Up to eight series** (compared runs or projects). The eight slots pass a color-vision and contrast check on *adjacent* pairs in both themes (worst CVD ΔE 9.1 light / 8.4 dark, normal vision ≥ 19), the pairs that matter for line charts; slots 4 and 5 are also below 3:1 on the light surface. Past four series the chart drops the direct labels, so the relief is the legend, the tooltip that lists every series, and the table view (every chart has one). A ninth series is never a generated hue: comparisons stop at eight.
- **Composite encoding** where one color stands for one entity with several curves: compared multi-port runs draw each run in its color and each picked S_ij with its own dash (solid, dashed, dotted); legend and tooltip swatches repeat the dash.
- **Sequential data** uses the blue ramp `--al-seq-0` to `--al-seq-5`. In light mode high values are darker. In dark mode the ramp is re-selected so high values are lighter; it is not simply reversed.
- **3D field quantities** (the directivity surface and the surface current) use the field map `--al-field-0` to `--al-field-8` (Turbo, low → high, the same in both themes). The directivity surface still encodes dB in its radius too, so color is never the only channel.
- The palette is checked for contrast and color-vision differences. Do not introduce new chart colors in components; add a token instead.

## 3D view

- **Exact primitives.** Boxes, polygons, extruded polygons and cylinders are rebuilt from the bundle's primitives, so what you see matches what openEMS meshed. Bounding-box fallbacks (`exact: false`) are approximations. Flag them as such, for example with a warn status in the spec sheet, and never present them as exact.
- **Materials.**
  - Metals use a PBR material with copper color (`--al-3d-metal`), high metalness and moderate roughness, lit by an environment map.
  - Dielectrics are see-through (`--al-3d-dielectric`, partial opacity, no depth write in x-ray mode) so the conductors inside stay visible.
  - Ports are `--al-3d-port` and the NF2FF box is `--al-3d-nf2ff`.
  - The domain and the infinite PEC ground are recessive (`--al-3d-domain`, `--al-3d-ground`).
- **Render on demand.** There is no continuous animation loop. A frame is requested only when something changes: camera movement, resize, theme, visibility toggles or data. An idle viewer must use no GPU, to save battery.

## Dark mode

- Light is the default.
- Dark mode is **selected step by step, not inverted**. Every role token has a hand-picked dark value:
  - surfaces step down the graphite ramp
  - copper moves to lighter steps (`--al-copper-400` for actions, `-300` for accent text and focus) to keep contrast
  - status and chart colors have their own dark variants
  - the sequential ramp is re-selected
- Dark mode applies through `prefers-color-scheme: dark` unless `data-theme="light"` is set on the root element, or it is forced with `data-theme="dark"`. When adding a role token, define its dark value in **both** places in `tokens.css`: the media query and the `[data-theme="dark"]` block.
