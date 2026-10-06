# Patch drawing walkthrough

This example was built from an empty design using the running designer's controls, rather than
injected into its store. The editable file is
[ux_inset_patch_24.design.json](../examples/designs/ux_inset_patch_24.design.json).

The illustrative target is 2.4 GHz over a 1.8–3.2 GHz simulation band. The board is 70 x 60 x
1.6 mm FR4 (the built-in 4.3 permittivity / 0.02 loss-tangent entry); the copper entry uses the
built-in PEC approximation. The patch is 38 x 29 mm, with two 1 x 8 mm inset notches and a
3 mm-wide microstrip feed. A 50 ohm discrete port spans the ground to the feed at y = -29 mm.
These values are an educational drawing, not a matched or validated antenna. No solver,
convergence study or efficiency measurement was performed for this example.

## Steps used

1. Create an Empty design, choose the Top camera, and draw a Brick's opposite corners on the
   canvas. Type `1.6` for height and press Enter. In the shape form, name it `substrate`, retain
   FR4, and refine the corners to x = ±35 mm and y = ±30 mm.
2. Add a Brick named `ground` with the same x/y bounds, copper material and Zmin = Zmax = 0.
   A single flat axis creates a sheet. The shape summary now explicitly says which axis is flat.
3. Add the copper patch with x = ±19 mm, y = ±14.5 mm and Zmin = Zmax = 1.6 mm.
4. Use its properties' Add a cut twice. Both cuts are at z = 1.6 mm and span y = -14.5 to
   -6.5 mm. Their x ranges are -2.5 to -1.5 mm and 1.5 to 2.5 mm.
5. Add another Brick into the existing `patch` solid: x = ±1.5 mm, y = -29 to -6.5 mm and
   z = 1.6 mm. This joins the feed and patch under one metal property.
6. Add a discrete port, set its start to `[0, -29, 0]` and stop to `[0, -29, 1.6]`, retain the
   z direction, 50 ohms and excitation. Set the band, set `f0` to 2.4 GHz, and save.
7. Choose Iso or Top and Fit to inspect the entire board. Collapse the Checks dock for more
   canvas space. Setup checks passing is separate from RF performance validation.

## Findings and changes

- Closing a shape form previously left keyboard focus on the document when its temporary
  Shapes-menu opener had disappeared. It now falls back to the canvas. Because this form is
  modeless, closing it also preserves focus deliberately moved to a camera or another control.
- Camera announcements exposed keys such as `viewport.view.top` followed by English text.
  Both the view and fit announcement now use EN/TR translations.
- The brick summary previously displayed only a zero dimension for a PCB sheet. It now names
  the flat axis explicitly; no material or geometry is changed by the wording.

The EN/TR browser regression `npm run check:shape-workflow` covers Cancel/OK focus, modeless
camera focus, translated announcements and the sheet summary on a 1024 px window.

Further UX candidates from this walkthrough are optional camera-context preservation when
adding a small feed, a more discoverable way to enlarge the canvas when Checks is empty, and
a width/length/thickness entry mode for PCB layers alongside the existing min/max coordinates.
These remain recommendations; the preview does not silently change existing camera or dock
preferences or the geometry-entry convention.

## Local Windows preview

The preview command `node scripts/build-windows-preview.mjs --python <python.exe> --seed-design
examples/designs/ux_inset_patch_24.design.json` makes an uninstalled folder build with its own
Tauri identity and package-local workspace. Follow the generated README and launcher: the
preview disables public updater checks and does not replace the installed app. A public release
still follows [RELEASES.md](RELEASES.md).
