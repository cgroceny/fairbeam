# Display scaling verification

Windows system scaling reduces the CSS viewport. Responsive layout must use CSS
width/height, while WebGL's backing buffer follows the fractional device pixel ratio.

The changes of `codex-windows/ui-scaling` are merged into main and passed source and automated
checks. The pass below was made on the three-tab ribbon of that time; the ribbon has since become
one row with six tabs (Home, Modeling, Transform, Simulation, Optimize, Post-processing) that
`fitRibbon()` fits to the center column, and the result plots open as main-area tabs. A first visual pass (headless Edge, before = main, after = this branch) covered Start,
Designer Modeling/Setup/Simulation, Checks, Simulation settings and Results 3D/Reflection/
Pattern at 1280×720 @1.5, 1536×864 @1.25, 1100×700 @1.5 and the 1728×1117 @2 reference
(Designer and Results unchanged there). Local shots use
`.sim/codex/shots/<screen>-<width>x<height>-before|after.png`. That pass found and fixed a
document scrollbar in Results (hidden checkboxes escaping the shorter side panel), a clipped
benchmark table in Specifications (right column restored to 288 px in Results) and wrapped
dock statistics (180 px side columns reverted). The remaining states below are unverified.

## Source findings and changes

| Surface | Finding / change |
| --- | --- |
| Start | `PanelBoundary` passes children through; its `home-wrap` class only styles the fallback. Bound and scroll the actual Home root in short windows. Reduce short-window spacing. |
| Designer ribbon | At the time: wide fixed-size groups wrapped, and below 1440 CSS px the buttons became 30 px icon buttons with accessible names and hover titles. Now the ribbon is one row at every width (`src/styles/ribbon.css`): `fitRibbon()` first drops labels (icon-only 30 px buttons with the label as title and accessible name), then folds groups into drop-down buttons, and last lets the row scroll. All six tabs keep their controls. |
| Tree / inspector | At 1100 CSS px, fixed side columns consume most of the width. Narrow columns and independent panel toggles release space without unmounting the panels. Opening Run reveals the right panel. Long design names/files have ellipses and titles. |
| Designer dock | Bound height to 28dvh (150–260 px). Statistics columns keep their default width (180 px wrapped values such as `2.453 GHz`). Checks, Parameters, Run, Runs and Log keep their existing scroll regions; S-parameters, Pattern and the other result plots are main-area tabs now. |
| HUD / status | Bound the mesh overlay to the model region and move it below camera controls. Compact status spacing and allow long cursor values to shrink/scroll. Existing status container queries remain. |
| Dialogs | Simulation settings, Run, Brick/Cylinder, port and other shared dialogs receive an explicit short-window maximum height and zero minimum height on their middle row. Existing inner scrolling, focus trap and footer remain. Port implementation is untouched. |
| Confirmations | Home deletion confirmation is inline in the scrolling Home region; unsaved changes use the in-app Save / Don't save / Cancel dialog (not a native `window.confirm`). |
| Results (the Examples view) | Shared side-panel toggles and a viewport-relative dock in short windows; the right column stays 288 px. Reflection/Smith/Pattern are SVG, Table already scrolls, Compare already has a bounded popover, Figure already clamps its menu to the viewport. These still require rendered inspection. |
| Canvas | Shared Designer/Results WebGL canvas updates DPR on resize and on a re-armed resolution media query. Unmount removes the listener. Fractional DPR is retained; existing Retina cap of 2 is unchanged. SVG charts and explicit-DPI export canvases need no monitor DPR scaling. |
| Splash | Short-window content can scroll, including long setup/error diagnostics and wrapping buttons. No runtime code changes. |

## Required image matrix

Capture each state below before and after at:

- 1280×720 @1.5, 1536×864 @1.25, 1100×700 @1.5;
- 1707×960 @1.5;
- 1728×1117 @2 (Mac layout reference).

Also audit every Windows CSS size at both 1.25 and 1.5. Move between DPR 1.25,
1.5 and 2 while keeping CSS dimensions unchanged; compare the canvas backing
dimensions with `floor(CSS size) × DPR` (integer-rounded by three.js).

Screen names: `start`, `designer-modeling`, `designer-transform`, `designer-simulation`, `designer-optimize`, `designer-post`,
`designer-inspector`, `designer-mesh`, `designer-checks`, `designer-run`,
`designer-sparams`, `designer-pattern`, `designer-log`, `dialog-settings`,
`dialog-run`, `dialog-brick`, `dialog-cylinder`, `dialog-port`, `confirmation`,
`results-reflection`, `results-smith`, `results-pattern`, `results-compare`,
`results-table`, `results-figure`, `splash` (starting/setup/error).

Path pattern (local, ignored by git):
`.sim/codex/shots/<screen>-<width>x<height>-before|after.png`.

Inspect keyboard access to both panel toggles, each ribbon tab and button, hidden
panel restoration, all dock tools, modal footers and scrolling, and HUD overlap.
Check there is no horizontal document scrolling. Keep ≥1440 px widths and tall
windows visually unchanged; the new panel toolbar is hidden there. On a Mac,
compare the 1728×1117 @2 pair and repeat in WKWebView, including monitor changes.

## Automated verification

`npx tsc --noEmit`, `npm run -s build`, all package `check:*` scripts, and the
fractional DPR lifecycle regression passed. `check:designer` now includes the
lifecycle regression. Logs are local at `.sim/codex/verification/`; export check
artifacts were redirected into that folder, without changing the examples.

The design detector ran in degraded regex mode because its optional HTML parser
modules are unavailable; no dependencies were installed for it. Its two warnings
refer to existing splash typography and progress animation. It cannot substitute
for the missing screenshots. No native build, real solver run, or physical
monitor-switch test was performed.
