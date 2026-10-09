# Drawings, figures, the export package and fabrication files

## Export the current view

The header's **Export** menu follows the visible workspace. **Screenshot** captures its
active view; an empty or unavailable view disables capture and explains why. Export outcomes,
including cancellation and errors, appear in the global notice.

| Visible workspace | Available exports |
| --- | --- |
| Design 3D | Geometry, current design JSON and Python source, screenshot |
| Design result tab | Data and figures supported by the active result chart |
| Examples 3D | Geometry and available result data/figures |
| Examples Drawing | Drawing SVG, PDF and PNG |

Geometry export supports binary STL, GLB, a Blender render package and CST-compatible VBA macros (`.bas`). See
[Blender and mesh exports](BLENDER.md) for units, transforms and format limits. Geometry and
JSON exports use the current draft, including unsaved edits; Python export first saves edits
and stops if that save fails or conflicts. Empty geometry cannot produce a mesh, while design
source exports remain available. Switching views closes the menu so an
action cannot accidentally capture a previously visible chart or canvas.

### Parameters in the VBA macro export

The macro transfers supported geometry and setup commands; it does not reproduce the openEMS
discretization. Mesh line counts in comments are metadata, not a prescribed solver grid. After
import, inspect the calculation box, absorbing-boundary spacing, port contact and reference
impedance before solving. A completed run or an energy stopping criterion alone does not establish
mesh convergence. Check S-parameters with successive global and feed-local refinements while
keeping the geometry, boundary positions and port definition fixed.

When the Export dialog is opened on a design, the VBA macro is **parametric**: each design parameter becomes a
macro parameter with its value and description, and the fields that are expressions over them are
written as VBA expressions, so changing a parameter moves the model:

- brick bounds, cylinder radius / range / centre, sphere centre and radius, polygon points, elevation and extrusion
  length, lumped port end points and impedance, a dielectric's relative permittivity, and the frequency band;
- derived parameters stay expressions (`W*2`, `Sqr(W*L)/10 + (299.792458/f_min)/100`). Fairbeam's functions are translated
  to their VBA counterparts (`sqrt` is `Sqr`, `atan` is `Atn`, `floor` is `Int`, `wavelength(f)` is `299.792458/f` in mm, `log10`, `radians`,
  `degrees`, `//` and `%` are written out); `atan2` and `round(x, digits)` have no VBA equivalent;
- names keep their letters, digits and `_`; a name the macro language refuses (`sin`, `pi`, `Name`, `eps0` ...) or one that differs from
  another only in case gets a suffix, and the macro says which design parameter is which macro parameter;
- in the `.bas` the parameters are `MakeSureParameterExists` commands (`StoreParameter` is refused while a
  history is rebuilt).

What stays a number is listed in the dialog ("Written as numbers") and in the macro's header comments: parts with transforms, cut-outs
or a Boolean result (the bundle holds their result, not their expressions), shapes other than bricks, polygons, cylinders and
spheres, waveguide ports and lumped elements, a field whose expression does not give the exported value, an expression with no VBA
equivalent, and everything when the model is not exported in mm. Without a design (an example opened for viewing, the export
package) the export is numeric as before.

## Drawings, figures and the export package

- **Technical drawing.** In the Examples viewer (Start › Examples), the *3D | Drawing* switch above the viewport shows the design as a black-and-white engineering drawing built from the supported model primitives: top, front and side views (third-angle by default, first-angle optional) plus an isometric view, ISO 128 line weights, 45° section hatching on dielectrics seen edge-on, PEC sheets drawn solid black edge-on, a ground symbol for the infinite PEC half space, the lumped port symbol and automatic dimensions (sizes, substrate thickness, feed offset and gap, notches and inset slots, feed-line width and length, apex angles such as the gasket's 60° flare; equal outlines are dimensioned once and noted). *More* adds parameter labels ("patch_w = 32", on by default in figure mode), dashed hidden edges in the isometric view, a line-type legend and per-view dimension switches. Sheets: A4 or A3 with a title block (parameters, materials, scale, projection symbol), or *Figure* (16 cm wide, no sheet) for LaTeX/Word. Export as SVG, vector PDF (IBM Plex Sans embedded) or 300 dpi PNG. Code: `src/drawing/` (pure TypeScript, bundle → SVG).
- **Publication figures.** *Figure* in the Examples viewer's dock bar exports B&W |S11|, Zin, Smith chart and polar pattern charts, 8.8 cm (single column) or 18 cm (double column), as SVG or PDF.
- **Export package.** *Export package* in the header (in the designer also Post-processing › Report and export › **Package**) downloads `<model-id>_<yyyymmdd-hhmm>.zip` with `project.json`, a `README.md` report (setup, run, results, reproduce command), `data/s11.s1p` (Touchstone v1, `# GHz S RI R 50`), CSV data, the drawings, the figures, the VBA macro, a PNG of the 3D view and `report.pdf`.
- **PDF report.** *Export report (PDF)* in the package dialog (in the designer also Post-processing › Report and export › **PDF report**) writes a multi-page A4 vector PDF: summary with key results, the dimensioned drawing, parameter/solver/mesh/run tables, |S11|, Zin, Smith chart, one pattern page per far-field frequency and the reproduce command. Pages are composed as SVG and drawn with jsPDF by `src/drawing/svgpdf.ts`, so the same code runs in Node.
- `npm run check:exports` validates all of this on the example bundles and writes [examples/drawings/](../examples/drawings/) and [examples/reports/patch-antenna.pdf](../examples/reports/patch-antenna.pdf).

## Matched-band CSV columns

The export package's `data/bands.csv` has one row per matched band, with these columns in order:

| Column | Meaning |
| --- | --- |
| `f_lo_GHz`, `f_hi_GHz` | Band edges in GHz |
| `f_center_GHz` | Middle of the edges, `(f_lo + f_hi) / 2`, in GHz |
| `f_best_GHz` | Frequency of minimum S11 within the band, in GHz |
| `s11_min_dB` | Minimum S11 in dB |
| `fractional_bw` | Width divided by the band middle, as a fraction (not a percentage) |
| `bandwidth_MHz` | Band width in MHz |
| `edge_lo`, `edge_hi` | `true` when that edge touches the simulated range, otherwise `false` |

For an open band, `edge_lo=true` means the low edge is an upper bound (≤), and
`edge_hi=true` means the high edge is a lower bound (≥). Either flag makes bandwidth and
fractional bandwidth lower bounds, matching the tables. The center is an upper bound when only
the low edge is open, a lower bound when only the high edge is open, and has no directional
bound when both edges are open. All frequency and bandwidth cells stay numeric.

The Summary tab's CSV export and copied TSV use the same definitions in their per-band columns:
`Band low (GHz)`, `Band high (GHz)`, `Band center (GHz)`, `Band best match (GHz)`,
`Band bandwidth (MHz)`, `Band fractional BW`, `Band edge low` and `Band edge high`.
The edge flags are numeric `1` (open) or `0` (closed); missing bands leave empty cells.
With multiple bands, each group is numbered (`Band 1 low (GHz)`, and so on).
The headline `Bandwidth (%)` is 100 times the deepest band's fractional bandwidth.

**Compatibility:** `f_center_GHz` previously held the frequency of minimum |S11|; consumers
that need that value must now read `f_best_GHz`. The bundle JSON still uses `f_center` for
best match and its stored `fractional_bw` divides by that frequency ([BUNDLE.md](BUNDLE.md#results)).

## Fabrication export (preview)

*Fabrication files* in the export package adds a `fab/` folder for printed designs (patch antennas, the microstrip line, the Wilkinson divider, the branch-line coupler, the low-pass filter, the 2×1 and 4×1 arrays):

- **Gerber X2** (RS-274X with X2 attributes, mm, format 4.6): one file per copper layer (`<id>-F_Cu.gbr`, `<id>-B_Cu.gbr`, inner layers if the stack has them), copper drawn as regions, and a board profile (`<id>-Edge_Cuts.gbr`, the substrate footprint). Overlapping primitives of a layer are merged into clean outlines (exact for rectilinear shapes; overlapping slanted shapes stay separate overlapping regions, which a Gerber viewer shows as their union).
- **Excellon drill** (`<id>-PTH.drl`) with a tool table. A probe feed becomes a 1.3 mm plated hole with a 4.2 mm anti-pad in the ground (sized for an SMA; both are defaults in `src/fab/layers.ts`). Edge ports get no drill: `README.txt` lists them as edge-connector positions, and lumped parts (the Wilkinson isolation resistor) as placement notes.
- **DXF R12** per layer (closed polylines on named layers, anti-pads and drills as circles) for mechanical CAD or laser/milling workflows.
- **`fab/README.txt`**: stack-up (εr, tan δ, thickness), board size, copper per layer, drills, connectors, notes.

Designs that are not printed boards (the dipole in free space, the Sierpinski monopole over an infinite PEC ground) have no fabrication export; the dialog says why. A design simulated over an infinite PEC ground exports no bottom copper, with a note.

Honest limits: the simulation used zero-thickness perfect conductors, so the 35 µm copper in the README is an assumption, not a simulated quantity. No solder mask, silkscreen or paste layers are written. Clearances, minimum track and gap, tolerances and the connector footprint are yours to check against your fab's rules. Open every file in a Gerber viewer such as KiCad's GerbView before ordering. `npm run check:fab` (part of `check:exports`) parses selected Gerber, drill and DXF fixtures back, compares copper areas, bounding boxes and drill positions with the bundle geometry within 1 µm, and writes [examples/fab/](../examples/fab/) for the patch antenna and the Wilkinson divider, each with a `render.svg` drawn from the parsed files.
