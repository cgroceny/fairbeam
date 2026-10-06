# UI audit (September 2026)

Scope: the viewer in `src/` at 1440×900, 1280×800, 1060×760, 1024×768 and 390×844, light and dark, for
all three bundled projects (patch antenna, Sierpinski monopole iterations 0 and 3), every dock tab
(Reflection, Impedance, Smith, Pattern, Port signals) plus Table mode, the VBA macro export dialog, chart and
3D tooltips, and the mesh-plane controls.

Method: screenshots, plus measurements in the page, because pixels alone mislead:

- a script collected the bounding box of every chart `<text>` and reported overlaps between labels,
  labels leaving the SVG, the legend or note covering a label, HUD panels overlapping each other,
  page-level horizontal scroll, header overflow and dock-bar controls pushed out of view. It was run
  for every project × tab at each viewport size. After the fixes it reports nothing at 1440, 1280, 1024
  and 390 px.
- WCAG 2.x contrast was computed from the values in `design-system/tokens.css` (not eyeballed).
- every interactive element was measured for the 24 px minimum target size.

Each finding lists the issue, then the fix.

## Layout

| # | Issue | Fix |
| --- | --- | --- |
| L1 | **The 3D view and the dock kept their old width when the window got narrower.** `.center` was a grid with an implicit `auto` column, and the chart SVG (explicit `width`) and the CSS2D label layer (inline px width) fed their last size back into it. At 390 px the view and the dock stayed 1024 px wide: the page scrolled sideways. At 1280 px after switching project, the dock ran under the right panel. | `.center` gets `grid-template-columns: minmax(0, 1fr)`; the viewport and dock get `min-width: 0`; chart SVGs are `position: absolute`, so their pixel size is out of flow. |
| L2 | **Below 1040 px the panels stacked at full width**, one after the other. At 1024×768 the page was 2 714 px tall, mostly two 1 024 px-wide columns of short label/value rows. | Between 720 and 1040 px the two panels sit side by side under the view and dock; below 720 px they are a single column. The page is now about 2 060 px tall at 1024 px. |
| L3 | Stacked layout: the view was 62vh (523 px on a phone) and the dock only 320 px, so the dock bar wrapped and the charts got squeezed. The header scrolled away. | View `clamp(300px, 56svh, 600px)` and dock 340 px. Below 720 px: view `clamp(280px, 50svh, 480px)` and dock 360 px. The header is sticky when stacked. |
| L4 | **Spacing did not follow a rhythm.** Paddings and gaps used 5, 6, 9, 10, 14 and 18 px as well as the tokens. The header was 16 px on the left and 12 px on the right, so the right-hand controls did not line up with the panel content below. | Every padding, gap and margin now uses the 4 px scale (`--al-space-*`) or a rhythm role: `--al-pad-panel` 16 px for panels, dialog and header; `--al-pad-hud` 12 px; `--al-gap-stack`, `--al-gap-cluster` and `--al-gap-label` 8 px. The header is 16 px on both sides, level with the panel content. |
| L5 | Header crowding at mid widths. The model id, cell count, status, a 340 px picker and four actions all competed for space, and the meta block disappeared completely below 1040 px, taking the convergence status with it. | The meta block collapses in steps: the cell count goes below 1360 px, the model id below 1180 px, and the status pill stays down to 420 px. The picker shrinks and shows an ellipsis. Below 640 px, Open shows only its icon (`.btn-label`). |
| L6 | The dock bar scrolled horizontally with its scrollbar hidden. At 390 px the Table button and the frequency chips were off screen, and nothing showed they were there. | The dock bar wraps: tabs stay on the first row and the tools move to a second, right-aligned row. Below 640 px the tabs use 8 px padding so all five fit at 390 px. |
| L7 | The dialog was 94 vw × 90 vh at every size. On a phone the options and the code preview were each squeezed into half of a fixed-height box. | The scrim has a 16 px inset on desktop. Below 640 px the dialog is full screen, the body scrolls as one column, and the code preview keeps at least 240 px. The footer wraps. |

## Controls and consistency

| # | Issue | Fix |
| --- | --- | --- |
| C1 | Control heights varied: buttons 30, small buttons 26, segmented buttons 24 or 22, chips 24, icon buttons 30 or 24. Icon sizes varied from 13 to 16 px, with stroke 2. | Two heights: `--al-control-h` 30 px and `--al-control-h-sm` 24 px. The control sets the icon size in CSS (`--al-icon` 16 px, `--al-icon-sm` 14 px), whatever `size` prop the JSX passes. All lucide icons use one stroke, `--al-icon-stroke` 1.75. |
| C2 | Focus rings were clipped or missing. The tab strip's `overflow-x` clipped the outer ring on tabs, `box-shadow` does not paint on `<tr>` (far-field rows), and SVG markers only thickened their dot. | Tabs and segmented buttons get an inset ring. Selectable rows get an inset `outline`. SVG markers draw a focus-color ring on their 28 px hit circle. The dialog shows the ring together with its shadow. |
| C3 | The checkbox tick was a white SVG. In dark mode the action color is copper-400, where white is 2.9:1. | The tick is a CSS mask filled with `--al-action-text`: 5.7:1 in light and 5.8:1 in dark. |
| C4 | Hit targets: the mesh-axis segmented buttons were 22 px, and checkbox rows were about 22 px. | Every interactive element is ≥ 24 px (measured). Checkbox rows are 28 px, the range input 24 px, part rows 40 px and markers 28 px. |
| C5 | Hover and active states were uneven. Pressed Table and ghost-button states were almost invisible in dark mode, and the view buttons had no `aria-pressed`. | Consistent hover on all controls. Pressed ghost buttons use `--al-surface-3` with a strong border. The view buttons expose `aria-pressed`. |
| C6 | Raw colors in component CSS: the scrim `rgba(18,17,16,.42)` and the brand mark on a ramp step (`--al-copper-500`). | New role tokens `--al-scrim` (with a dark value) and `--al-brand-mark`. |

## Panels, lists and tables

| # | Issue | Fix |
| --- | --- | --- |
| P1 | Values in key/value lists were left-aligned in a column whose width depended on the longest label, so numbers did not line up and the right edge was ragged. | `.kv` right-aligns values in tabular figures, and labels take the remaining width. The long openEMS version string sits on a secondary line with an ellipsis (`.kv-sub`, full text in `title`). |
| P2 | Tables: units shared the header line ("Center GHz", "Dmax dBi"), the two results tables had no titles, and the selected far-field row had side padding that its header did not have, so the last column sat 8 px off its header. | Units go on a second header line (`.th-unit`). Tables have captions ("Matched bands, \|S11\| below −10 dB", "Far field · select a row to show its pattern"). Header padding matches the row inset. Rows are 28 px. |
| P3 | The Run status box sat directly on the list below it with no gap. | `.status-block + .kv` gets 12 px. |
| P4 | The data table in Table mode stretched across the whole dock at 33 px per row, so columns were far apart and hard to read across. | Compact table: `width: auto`, `min-width: min(100%, 560px)`, 24 px rows, a sticky header with a hairline and a row hover. |

## Charts

| # | Issue | Fix |
| --- | --- | --- |
| G1 | **Label collisions found by measurement:** the Reflection marker label "2.43" sat on the x tick "2.50" (the dip reaches the bottom of the plot). The direct labels "Incident"/"Reflected" and "Re Zin"/"Im Zin" overprinted, and so did the "50 Ω reference" label. Smith marker labels collided with each other (3.30/6.22/7.30 GHz) and with the real-axis labels. The polar top ring label sat under "0°". | New `src/charts/labels.ts` with `declutter()`, a greedy vertical push that treats fixed labels as obstacles. Line charts declutter reference and direct labels together. Marker labels move above the dot when below would reach the axis. Smith markers declutter against the real-axis labels, which sit just above the axis. Polar ring labels run at 15°, between the spokes. |
| G2 | The legend was drawn inside the plot (top-left, over the first gridline and data) in both Impedance and Port signals. | Charts with a legend reserve a 32 px strip above the plot, and the legend aligns with the plot's left edge. The polar chart reserves 28 px. |
| G3 | The y gutter was fixed at 56 px: "−0.020" was cramped, and short labels such as "0" wasted space. Tick labels used the tooltip formatter ("−10.0", "5.00"). | The gutter is sized to the widest tick label. Ticks use step-aware precision ("0, −10, −20"; "1.0, 1.5"). Negative values use a real minus sign (U+2212). |
| G4 | Labels over gridlines or data were hard to read. | Chart labels drawn over the plot get a surface-colored halo (`.c-halo`, `paint-order: stroke`) instead of a box. |
| G5 | The line-chart tooltip flipped using a hard-coded 190 px and could still leave the plot. Polar and Smith tooltips covered the legend. Tooltip values had no units. | The tooltip flips to the left of the crosshair in the right half of the plot (`.flip-x`). The polar tooltip moved to the top right, under the legend strip. The heading reads "7.92 GHz", and each value carries the unit from the axis title ("89.4 Ω"). |
| G6 | The polar chart showed no unit for its rings. A half-plane pattern was pinned to the top and left empty space below; at 390 px the "−90°" label touched the edge. | Note "Rings in dBi · θ = 0° is +z" in the legend strip. The half plane is centered vertically and the label pad is 34 px. |
| G7 | Smith ±jx labels were placed at 1.07 R and centered, so they overlapped the rim and the trace (+j0.2). | Labels sit 8 px outside the rim, anchored away from the circle (end on the left, start on the right). The chart margin grew from 26 to 34 px to fit them. |

## 3D view HUD

| # | Issue | Fix |
| --- | --- | --- |
| H1 | On small viewports the color scale (top right) collided with the view toolbar (top left). At 390 px they overlapped by about 40 px. | The viewport is a size container. Below 560 px the color scale moves under the toolbar and drops its long caption (body 72 px). |
| H2 | The part tooltip always opened to the bottom right and was clipped near the right and bottom edges. | It flips horizontally within 220 px of the right edge and vertically within 120 px of the bottom. |
| H3 | Color-bar legibility: a 10 px ramp with no edge, tick labels offset by half a line from the ramp ends, and a muted title. | 12 px ramp with a hairline edge. Tick labels are centered on the ramp ends, the title uses `--al-text` and the ticks use a real minus sign. |
| H4 | HUD insets and surfaces were inconsistent: the readout was a pill while the other items were rounded rectangles, and heights varied. | One inset (`--al-pad-hud`) and one surface style. The readout is 24 px with `--al-radius-sm`. The bottom-right group wraps instead of running under the axis gizmo. |

## Theme and contrast

WCAG ratios, computed from the tokens (text needs 4.5:1):

| Pair | Before | After |
| --- | --- | --- |
| light `--al-text-3` on `--al-surface-3` / `--al-viewport` | 4.34 / 4.38 (fail) | 4.75 / 4.79 |
| light `--al-chart-muted` (tick labels) on `--al-surface` | 4.28 (fail) | 5.24 |
| light `--al-warn` on `--al-warn-bg` | 4.497 (fail) | 5.28 |
| dark checkbox tick on `--al-action` | 2.9 (white) | 5.76 |
| dark `--al-text-3` on `--al-surface` / `--al-surface-3` | 6.57 / 5.37 | unchanged (passes) |
| dark `--al-chart-muted` on `--al-surface` | 5.17 | unchanged (passes) |

| # | Issue | Fix |
| --- | --- | --- |
| T1 | **The theme button left the 3D view in the old theme.** `applyTheme` set the signal before `data-theme`, so the viewport re-read the old tokens. The pattern surface did not rebuild on a manual toggle at all. | `applyTheme` sets the attribute first. The pattern effect also listens to `theme` (a one-line change in `Viewport.tsx`). |
| T2 | `prefers-reduced-motion` only disabled transitions. | Also disables animations and smooth scrolling. |

## States and wording

| # | Issue | Fix |
| --- | --- | --- |
| S1 | Before the project index loaded, the empty state "No projects yet" flashed. | Shows "Loading project…" (`role="status"`) until the first project has loaded. |
| S2 | The dock showed "This project has geometry only" while a project was still loading. The message was a grid, so its inline `<span>` broke onto its own line. | The message appears only when a bundle has no results: "Geometry only: this project has not been simulated. Run it with `fairbeam run` to see results here." It is a centered block of up to 46 characters. |
| S3 | The error banner used the critical color with no icon. | Banner with icon and text, following the status rule. |
| S4 | The empty state (no projects) was left-aligned at 48 px with no maximum measure. | Text width up to 60ch on the 4 px scale. Mentions Open as well as drag and drop. |

## Left as is (deliberately)

- Numbers in the side panels are formatted by `src/lib/format.ts` (`num()`), which uses a hyphen-minus ("-38.5"). Charts now use U+2212. Changing `num()` also changes the VBA macro output, so it is left for the owner of the formatting and export code.
- The line-chart tooltip stays at the top of the plot instead of following the pointer vertically, which keeps the crosshair values in one place.
- Between 1040 and about 1100 px the three-column layout is tight: the center is about 530 px and the dock bar wraps to two rows for multi-band projects. The breakpoint stays at 1040 px so a 1080 px window still gets three columns.

## Round 2: drawing view, export package, figure menu, header

Scope: the UI merged after round 1: the "3D | Drawing" switch and the drawing view, the export
package dialog, the "Figure" menu in the dock bar, and the new header buttons (Run, Export
package). The Run panel is excluded; it is being reworked on the primitives.

Method: the same as round 1. An in-page script checks stage overlays against each other, overlays
over the sheet after fitting, overlays leaving the stage, header overflow and page-level
horizontal scroll. It ran in both views and for all three sheets (A4, A3, Figure) at 1440, 1300,
1280, 1100, 1024, 900, 700, 390 and 360 px. After the fixes it reports nothing at any of them. The
checks also covered keyboard walks (menu, dialogs, radio groups), the 24 px target sweep and
light and dark themes.

| # | Issue | Fix |
| --- | --- | --- |
| R1 | **The header overflowed below about 460 px.** At 390 px it was 459 px wide, the page scrolled sideways and the project picker was 14 px. "Export package" never collapsed. | The header collapses in steps. At ≤ 1280 px, Open and Export package become icon buttons that keep their `aria-label` and `title`. At ≤ 760 px, Run collapses as well and the convergence pill leaves the header (it is in the spec panel). At ≤ 640 px the primary reads "VBA macro", and at ≤ 480 px the screenshot button is hidden (the package includes a 3D PNG). The header stays inside the viewport at every width tested, and the picker is ≥ 86 px at 360 px. There is still exactly one copper button. |
| R2 | The 3D \| Drawing switch was centered at the top of the stage with a drop shadow. It overlapped the 3D view toolbar and the drawing options toolbar below about 700 px, and the drawing export buttons below about 460 px. | The switch owns the top-left corner in both views and is flat, like the other overlays. Each view's toolbar starts to its right (`--al-stage-switch-w`, `--al-stage-tl`). |
| R3 | Drawing view overlays collided at narrow widths: the options toolbar overlapped the export buttons, and the scale readout overlapped the zoom group. The sheet was fitted with a fixed 72 px band, so it slid under a wrapped toolbar. | The toolbar rows are click-through containers that wrap, so empty space still pans. Export and zoom are joined groups built on `.seg`. A `drawing` container query below 620 px puts the export group on the switch row, gives the options the full width underneath, and stacks the readout above the zoom group. `fit()` measures the toolbars actually drawn and centers the sheet in the free area. |
| R4 | The sheet had a pop-up drop shadow on `--al-viewport`. In dark mode the white sheet glared on near-black. | New token `--al-sheet-surround`: paper-200 in light mode, graphite paper-800 in dark mode. The sheet has a hairline edge (`--al-border-strong`) instead of a shadow. |
| R5 | The zoom and export controls were separate bordered buttons, each export button repeated the download icon, and the zoom readout looked like a separate pill. | One joined zoom group (−, %, +, fit) and one export group (download icon, then SVG · PDF · PNG), with `aria-busy` while a PDF or PNG renders. |
| R6 | **The Figure menu could leave the viewport.** It was right-anchored with no flip or clamp. It stayed open while the page scrolled (in the stacked layout it floated detached), and Tab moved focus out while leaving it open. The arrow keys did not reach the width and format chips in a natural way, there was no Home or End, and focused items had only a faint background. | It opens below the trigger, flips above when there is no room, and is clamped 8 px from the left and right edges, with a maximum height. It closes on scroll (except scrolling inside itself), on resize and on Tab. Up and Down move through all items, Left and Right move through the chips, Home and End jump to the ends, and Escape closes it and returns focus to the trigger. Focused items get an inset focus ring. Below 640 px the trigger shows its icon only and is labeled "Export figure". |
| R7 | **The two dialogs behaved differently.** The package dialog trapped Tab; the macro dialog did not and focused itself. The package dialog's own `width`/`height` rule overrode the full-screen phone layout, so on a phone it was a 94 vw box. Paddings were 16/18 px, and each file line repeated the long folder name. | Shared `useModal` (`src/lib/dialog.ts`): initial focus, Escape, Tab kept inside the dialog, and focus returned to the opener. Both dialogs use it. Both have the same skeleton (head with title, description and close; options column and preview column; footer with meta text on the left and actions on the right) and the same spacing tokens. Both are full screen at ≤ 640 px. The file list shows the folder once, then indented paths. The scrollable macro preview and file list are focusable, so they can be scrolled from the keyboard. |
| R8 | The `role="radiogroup"` controls (view switch, sheet, projection, mesh axis, far-field chips) had no arrow keys. | `radioGroupKeys` (`src/lib/a11y.ts`): Left/Up and Right/Down select and focus the previous or next option (wrapping), and Home/End select the first or last. |
| R9 | Icons in the new components had no `aria-hidden`, and their sizes varied (13, 14 and 15 px). | Icons are `aria-hidden`, and the control sets their size, as in round 1. |

Contrast: round 2 adds no new text colors. The new text sits on existing surfaces: package hints
`--al-text-3` on `--al-surface` (6.0:1 light, 6.6:1 dark), the folder line on `--al-surface-2`
(5.2:1, 6.0:1), and menu text `--al-text` on `--al-surface`. The sheet surround carries no text,
because every overlay has its own surface.

Left for later: the Run panel (a final pass comes after the runner rework); `.workspace.run-open`
in `runner.css` still sets a single column below 1040 px.

## Round 3: public site (landing page and demo build)

The site was checked from `site-dist/`, served locally with `python3 -m http.server`, at 1440, 1024,
768 and 360 px in light and dark. The same in-page script as before checked page overflow, heading
order, computed text contrast and target sizes.

- **Landing contrast.** The lowest text contrast is 5.15:1 in light mode (code comments,
  `--al-text-3` on `--al-surface-2`) and 5.76:1 in dark mode (the copper button). Nothing is below 4.5:1.
- **Landing structure.** No horizontal overflow at any width tested, including 360 px. Headings run
  h1, h2, h3 without skips. The page has a skip link, `header`/`nav`/`main`/`footer` landmarks,
  labeled sections and a visible focus outline.
- **Hit targets.** The header navigation links were 21 px tall; they now have 4 px vertical padding
  to reach 24 px.
- **Demo build.** In the demo at `/app/`, the Run button is replaced by a "Read-only demo" disclosure.
  It closes with Escape or a click outside, and its link targets `_top` so it also works inside the
  landing page's iframe. The demo makes no `/api` requests, loads the projects from `/app/projects/`,
  and finds the drawing-PDF fonts under `/app/assets/`.
- **Dock at 360 px.** The dock tabs were cut off at 360 px. Below 400 px they now use 6 px padding.

## Round 4: run panel, model editor, compare, surface currents, drawing round 2

Scope: everything merged since round 3.

- **Run panel:** Run tab, Sweep mode, history groups with the summary table, and the progress card.
- **Model code tab:** the CodeMirror theme, the error panel and the New model dialog.
- **Dock bar:** the Compare popover and the Re/Im and φ toggles.
- **Color scales:** the surface-current layer and its color scale.
- **Drawing view:** the "More" popover.
- **Package dialog:** the new "Export report (PDF)" action.
- **Layouts:** `run-open` and `code-open` at 1040 px and below.

Method: the same in-page checks as before, run at 1440, 1280, 1024 and 390 px in light and dark. The
run panel needs a run server. I used the real `fairbeam.server.App` in a scratch harness whose job
command is the recorded fake from `python/tests/fake_openems.py`, so the queue, the progress card,
sweeps and history were exercised without running openEMS.

Chart-label checks inside the automated sweep were unreliable this round. In the embedded browser a
chart's size is only measured when the pane repaints, so a newly created chart often measured 0 × 0.
I checked the charts by hand instead, after a repaint, including the three-series compare overlays.

| # | Issue | Fix |
| --- | --- | --- |
| Q1 | **Study members could not be opened.** `loadProject` and the compare cache URL-encoded the whole path, so `studies/x/y.json` was requested as `studies%2Fx%2Fy.json` (404). The compare cache also ignored the demo's `/app/` base path. | `projectUrl()` in `src/env.ts` encodes each path segment, keeps the slashes and respects the base path; both callers use it. Checked in the demo build: a study member loads from `/app/projects/studies/...`. The picker still lists only the six `index.json` projects, so no broken entries appear. |
| Q2 | **The two color scales collided.** The surface-current scale was placed with a hard-coded `top: 232px` under the directivity scale. On viewports under 560 px both moved to the same corner, and at 1280 × 800 the stacked pair reached the scale bar. | Both scales live in one `.vp-scales` HUD container: side by side, with 96 px ramps when there are two, wrapping under the view toolbar on small viewports. The surface-current layer now also rebuilds on a manual theme toggle, as the directivity surface already did. |
| Q3 | Surface current in dark mode. The layer uses the same sequential ramp as the directivity surface; in dark mode low values recede toward the background on purpose. | Kept, since it is a data-encoding decision. The scale now always shows next to the model with a hairline-edged ramp, and it follows the theme (Q2). If the physics side wants low currents to stay visible on dark metal, that needs a scene change (opacity or a floor on the ramp), not a restyle. |
| Q4 | **Editor numbers were below 4.5:1.** Numbers used `--al-series-1`: 4.4:1 on the light surface and 3.98:1 on the active line. | New role token `--al-code-number`: light #1c5cab (6.6:1 on the surface, 5.97:1 on the active line), dark #5598e7 (5.9:1 and 5.5:1). Keywords, strings, comments and the gutter all compute at 5.15:1 or better in both themes. |
| Q5 | **Run-panel parameter rows were misaligned.** A transparent 6 px "modified" dot plus an 8 px gap indented every label by 14 px, and hints by 12 px, relative to their inputs. | The dot hangs in the panel gutter (absolute, −10 px), so label, input, hint and error share one left edge. |
| Q6 | In the stacked layout the page scrolls, and the run panel's sticky head and tabs slid under the sticky app header. | At 1040 px and below, the head and tabs stick below the header. The `run-open` stacked layout was already two panels side by side (runner branch). `code-open` puts the editor full width above the model panel, which is deliberate. |
| Q7 | Run-panel targets below 24 px: the summary-table sort buttons (32 × 14 and 10 × 28) and the "Full log" link (16 px tall). | Minimum 24 × 24 px for sort buttons; 24 px tall log link. |
| Q8 | The sweep estimate fallback ("no finished … run yet") was set in the mono number face and right-aligned, so it wrapped like a number. | `.rp-prose`: sans, small. |
| Q9 | **The Compare popover went off screen on phones.** It was anchored to the trigger's right edge, 340 px wide, and ran 98 px off the left edge at 390 px. | At 640 px and below it spans the dock bar (8 px insets). Checked at 390 px: 8–382 px. |
| Q10 | **Polar compare labels overprinted ticks.** The peak labels (three long project names) collided with ring and angle labels, and the three-entry legend overlapped the units note. | Peak labels sit in the free ring outside the angle labels and only where the chart has room (at least 420 × 320). Otherwise the legend strip identifies the series; it now holds the units note and grows when it wraps. Rule added to `docs/DESIGN.md`. |
| Q11 | Arrow keys were missing on the new radio groups (Re/Im, φ, drawing parameter labels, run mode, sweep "values as"). | `radioGroupKeys` on all of them. Every `role=radiogroup` in `src/` now has it. The New model template list uses native radios. |
| Q12 | **The New model dialog was inconsistent.** The display name used the mono face, the template legend was indented by the fieldset padding, and the dialog was not full screen on phones (`.dialog-sm` overrode the phone rule). | `.field-text` gives prose inputs the sans face. The legend is aligned, and the dialog is full screen at 640 px and below. It already used `useModal`; Escape returns focus to "New". |
| Q13 | The drawing "More" button was a transparent 24 px button in a row of 30 px bordered controls. | Toolbar buttons match the 30 px surface controls. |
| Q14 | The package dialog footer had three buttons (Cancel, Export report (PDF), Download .zip) and wrapped awkwardly. Cancel duplicated the close button, and the macro dialog has none. | Footer: Export report (PDF), then the Download .zip primary. |
| Q15 | At 390 px the dock showed three far-field chips plus Compare, Figure and Table, and the last chip scrolled out of view. | At 640 px and below the chips wrap onto a second line. |

Dark-mode text contrast in the run panel, editor chrome, Compare popover, More popover and New model
dialog: the lowest ratio is 5.76:1 (the copper buttons). Light mode: the lowest is 4.75:1 (the status
pill). The editor's own syntax colors are covered in Q4.

## Round 5: robustness and performance

Measured in the in-app browser (Chromium) on this laptop against the dev server and the demo build
(`site-dist/`, served locally). The baseline for load numbers is main at eb34bec, built the same way.

### Error containment and bundle validation

- **Error containment:** `PanelBoundary` wraps the model panel, the 3D view, the drawing, the dock,
  the spec and run panels, the array tab and both export dialogs. Test: a bundle with
  `solver = null` and a broken part bbox was forced past validation. The model and spec panels showed
  "failed to render: Cannot read properties of null…" with Reload panel and Details. The header, the
  3D view and the dock kept working, and opening the next project cleared both panels.
- **Validation on open:** `src/lib/validate.ts` runs on every path (fetch, drop, run server).
  - **Refused, with the reasons:** a wrong schema; missing model, parts, mesh, domain or solver;
    non-numeric or out-of-range mesh lines; more than 20000 mesh lines.
  - **Repaired, with a warning banner:** port arrays with the wrong length, "NaN" strings (they become
    gaps), far-field grids that do not match θ × φ, mismatched signals, malformed parts, primitives,
    ports and materials, surface-current planes of the wrong size, and text fields that are not
    strings.
- **Node fuzz check:** `scripts/check-bundles.mjs`, part of `npm run check:exports`, runs 403
  checks. Every committed bundle, 15 study members included, validates with no warnings, and so does
  the synthetic array bundle, checked by drop in the browser. There are 21 targeted malformations.
  The 300-case random fuzz gave 253 bundles repaired, 47 refused and no throws on the open path. One
  case made an export throw; that is contained by the export's boundary.
- **Found by the fuzz:** a 1e308 coordinate exhausted memory in the drawing and VBA macro loops. Geometry
  is now limited to ±1e6 mm.

### Memory and listeners

- **Project switching:** 90 switches, with the pattern, surface current and mesh plane turned on each
  time. `renderer.info.memory` stayed constant each time the same project was open: 158 geometries,
  6 textures and 17 programs on the Sierpinski bundle. The JS heap stayed in a 41–64 MB garbage
  collection band with no upward trend, the DOM stayed at about 425 nodes, and there was one CSS2D
  label.
- **Fixed for re-mounts (Reload panel):**
  - material-owned textures (the shared environment map excepted);
  - the PMREM render target;
  - the axis-gizmo sprites;
  - every viewport listener (keyboard, pointer, view, controls, window events);
  - the label layer;
  - `forceContextLoss`, so WebGL contexts do not pile up.
- **Checked:** menus and popovers remove their document listeners on close and on cleanup. The run
  server has at most one EventSource, closed on detach. The `ResizeObserver`s disconnect on cleanup.

### Load performance (demo build, `npm run build:report`)

| | Before (eb34bec) | After |
| --- | --- | --- |
| Initial JS (gzip) | 273.8 KiB | 211.4 KiB (−23 %) |
| Initial JS (raw) | 939 KiB | 768 KiB |
| Initial CSS (gzip) | 11.9 KiB | 12.1 KiB |
| Lazy chunks | 6 | 21 (loaded on first use) |

- **Moved out of the first load:** DrawingView with the drawing code, the macro and package dialogs
  (`cst.ts`, fflate, the report), the run drawer (form, progress, history, editor store UI), the
  array tab, and the figure generators. three.js stays in the main bundle and is most of what remains.
- **Time to first render:** measured as the time until the app has mounted and requested the project
  list. With a warm cache on localhost it is about 15 ms both before and after, and the first project
  is loaded by about 58 ms in both. On a local machine the benefit does not show. The saving is the
  62 KiB less to transfer (about 0.3 s at 200 KB/s) and about 170 KiB less JS to parse and compile. I
  could not measure paint timings: the embedded browser runs the page as a hidden tab, so no paint
  entries are recorded.
- **Offline check:** the demo build at `/app/` opens the drawing, the VBA macro and the package
  dialog, and their chunks load from `/app/assets/`.

### 3D keyboard and accessibility

- The viewport is focusable with an inset focus ring, and `role="application"` with a description of
  the keys.
  - Arrow keys orbit, in 7.5° steps.
  - Shift+arrow keys pan.
  - + / − zoom.
  - 1–4 choose Iso, Top, Front or Right; 0 or F fits the model.
  - Tab / Shift+Tab step through the parts. The part is highlighted and announced, for example
    "Patch: PEC, 32 × 40 × 0 mm. Part 1 of 3."
  - Escape clears the part, and Tab past the last part leaves the viewport.
- An `aria-live="polite"` region announces view changes, fitting and zooming.
- There are no camera animations, so the view is safe with `prefers-reduced-motion`.
- Checked with real key presses in the browser: orbit, the Top view, pan, zoom, fit, part stepping
  and the announcements.

### Large bundles

- **Frame time:** 120 frames of orbiting, timed as `renderer.render` plus `gl.finish` plus a 1-pixel
  readback.

  | Bundle and layers | Median | p95 | Max | Draw calls | Triangles | Line segments |
  | --- | --- | --- | --- | --- | --- | --- |
  | Sierpinski, iteration 3 (67 primitives) | 1.2 ms | 1.5 ms | 3.6 ms | 140 | | |
  | Sierpinski with pattern and mesh plane | 1.2 ms | 1.5 ms | 3.0 ms | 144 | 9.5 k | 1.5 k |
  | Patch with pattern, mesh plane and surface current | 1.1 ms | 1.3 ms | 2.9 ms | 23 | 18 k | |

  That is far inside a 16.7 ms frame.
- The scale bar used to update the DOM on every frame; it now updates only when its value changes.
- **Mesh-plane cap:** at most 3000 lines are drawn. Beyond that every k-th line is drawn, the first
  and last included, with a note in the HUD, for example "Mesh plane: 1 in 2 of 4069 lines shown",
  checked with a 4000-line synthetic mesh. For plausible meshes (hundreds of lines) the cap never
  applies.

## Round 6: optimizer, multi-port, arrays, reference import, fabrication; landing and docs

Method as before: 1440, 1280, 1024 and 390 px, light and dark, keyboard only, computed WCAG
contrast, and the overlap/clipping/overflow script (children clipped by an `overflow: hidden` or
`clip` parent no longer count as overlaps). The Optimize progress card was driven by the real
`fairbeam.server.App` with the fake openEMS command, so no simulations ran.

### Checked

- **Optimize mode** (dipole and Wilkinson): form, presets, the *Driven ports* switch, the per-port
  cost estimate, the progress card with the log-scale cost chart, the evaluation table and the stop
  reason ("Stopped: max evaluations after 3 evaluations").
- **S-parameters tab** (Wilkinson, branch-line, low-pass, microstrip line): the S_ij picker, the
  matrix popover, the Smith port and quantity switches.
- **Array tab** (2×1, 4×1): weights table, the steer helper and the active-Γ warnings.
- **Compare → Reference data**: a synthetic `.s1p` gives the Comparison card (+46.5 MHz, +1.90 %
  shift); a garbage file gives the warn status block "garbage.txt: No numeric data found".
- **Package dialog**: the *Fabrication files* option, and its note on the dipole ("Unavailable: No
  dielectric substrate…").
- **Multi-port sweep summary**: markup reviewed against the single-port summary (same `.table`,
  `.th-unit` and number formatting). It could not be exercised live, because the fake runs write
  single-port bundles.

### Fixed

| Issue | Where | Fix |
| --- | --- | --- |
| Page 401 px wide at 390 px: the *Table* button pushed out of the dock bar | Wilkinson, S-parameters tab | `.dock-tools` and `.freq-chips` wrap instead of overflowing |
| Two identical "2.453 GHz" far-field chips (one per embedded element pattern) | 4×1 array | Chips name the port (" · P2") when frequencies repeat, with a title; the spec panel's far-field table gets a Port column when patterns carry one |
| Radiogroups without arrow keys: Smith port, Quantity | S-parameters tab | `radioGroupKeys` |
| S-matrix popover reachable only by Tab | S-parameters tab | New `gridKeys(e, cols)` in `src/lib/a11y.ts`: arrows move by row and column and skip disabled cells, Home/End jump; the grid has an accessible name |
| Comparison card values wrapped under their labels in the narrow spec panel | Spec panel | `.cmp-card .kv`: label column `minmax(64px, 1fr)`, values `max-content`, no wrap |
| Run panel crashed (contained by the panel boundary) on a *done* event whose best entry has no metrics | Optimize progress | Optional chaining on `best().metrics` |
| Decorative X icon announced | Compare picker | `aria-hidden` |

### Measured after the fixes

- No page overflow, no clipped or overlapping chart labels and no targets under 24 px at 390, 1024 and
  1280 px, in either theme, for all the views above.
- Worst text contrast: 4.75:1 in light (status pill in the run panel), 5.76:1 in dark.
- Landing page at 360, 768, 1024 and 1440 px, light and dark: no horizontal scroll, no table that
  needs to scroll, no contrast failure. Numbers and units in the result tables are joined by
  no-break spaces, so values such as "−3.05 dB" never split across lines on a phone.

### Notes for the integrator (logic, not changed)

- The Optimize *Vary* min/max carry over from the previous model: after switching from the dipole
  to the Wilkinson the fields showed 52.2 / 63.8 with "choose a parameter".
- An imported reference stays pinned when another project is opened, so its Comparison card
  compares against the wrong design until it is removed.

### Docs

- README.md is a short overview. The detailed sections moved unchanged into guides listed in
  [docs/README.md](README.md).
- `scripts/check-links.mjs` (in `npm run check:exports`, or `npm run check:links`) checks every
  relative link and `#anchor` in README.md, docs/*.md and the landing page. At the time of writing
  it checks 113 links.
