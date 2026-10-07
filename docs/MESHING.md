# Automatic meshing

Writing the FDTD mesh by hand (`mesh.AddLine(...)` + `smooth_mesh()`) is the step where most new
models go wrong: an edge on a mesh line, a strip one cell wide, too little air, a sliver that halves
the timestep. `Simulation.auto_mesh()` builds the mesh from the geometry instead:

```python
sim = Simulation(f_min, f_max, boundaries=["PML_8"] * 6)
... sim.metal(...).AddBox(...), sim.dielectric(...), sim.lumped_port(...) ...
sim.auto_mesh()                       # after geometry and ports
sim.add_nf2ff_box(center=[0, 0, 0])   # after the mesh: the NF2FF box is placed on the grid
```

All editor templates (`python/templates/*.py`) use it. The dipole and patch models accept
`--set mesh=auto` to compare with their hand-tuned meshes.

## Options

`sim.auto_mesh(**kw)` forwards to `fairbeam.automesh.generate(sim, ...)`:

| Option | Default | Meaning |
| --- | --- | --- |
| `f_max` | the simulation's | Frequency that sets the wavelength |
| `cells_per_wavelength` | 20 | Feature and dielectric resolution: λ(f_max) / cells, divided by sqrt(ε_r) inside dielectrics |
| `air_cells_per_wavelength` | same as `cells_per_wavelength` | Optional coarser maximum cell in outer air. Metal edge placement and dielectric resolution still use `cells_per_wavelength`. Must be positive and no greater than it |
| `edge_rule` | `"thirds"` | `"thirds"`: lines 1/3 inside and 2/3 outside free metal edges; `"edge"`: a line on the edge |
| `edge_res` | half the local max cell | Edge cell d for the thirds rule, and the fill of slanted polygons |
| `metal_cells` | 6 | Minimum cells across narrow metal (a strip, arm or post no wider than 2 local cells) |
| `dielectric_cells` | 4 | Cells across a thin dielectric layer |
| `max_ratio` | 1.4 | Largest ratio between neighboring cells in the graded fill |
| `min_cell` | 0.45 × the finest requested cell | Lines closer than this are merged (see below). An explicit value also limits how fine the new local feature-size requests may be |
| `pad` | λ(f_min) / 4 | Air between the structure and absorbing boundaries (PML cells are added on top). A number, or six values (x-, x+, y-, y+, z-, z+); 0 leaves that face on the structure with no PML cells added, for a feed waveguide that runs into the PML (`pyramidal_horn.py`) |
| `refine_features` | `False` | Locally refine the mesh across fine features (narrow gaps, notches, thin or slanted strips). Off by default; see below. Design JSON without `mesh.refine_features` also uses `false` |
| `keep_existing` | `True` | Lines already on the grid (added by the model) are kept as fixed lines |
| `verbose` | `False` | Print the report |

In a design file the Simulation › Mesh settings dialog has the mode *Auto* (`mesh.mode: "design"`, described below) and *Automatic (legacy)* (`"auto"`, also what a design without `mode` uses); a design with `"manual"` lines shows *Manual lines*. Design JSON in the legacy `auto` mode can set `mesh.edge_rule`, `mesh.max_ratio`, and `mesh.air_cells_per_wavelength`
alongside the existing cells-per-wavelength and padding fields. Omitting them uses the default
settings. Fine-feature refinement is controlled separately by `mesh.refine_features`. The designer's cell and time estimates use the returned mesh lines and timestep,
so they include the selected options after preview generation.

**Refine fine features** in Simulation settings › Mesh controls the design-level boolean
`mesh.refine_features` in both automatic modes. **It is off by default**, for new designs
(`"refine_features": false`), for saved designs without the field and in the Python API
(`refine_features=False`). Opening or exporting a design never turns it on, so an update keeps
its mesh. Manual mesh lines are never refined. Generated Python from a design always writes the
design's effective value explicitly.

When to turn it on: the design has thin gaps, notches, feed gaps or slanted thin strips that the
automatic mesh covers with fewer than three cells (one cell for a slanted strip). With the
setting off, the mesh does not change, but the Checks list still reports such features as
`mesh-fine-feature` (an info, with the count and the worst widths) and suggests turning the
setting on. After turning it on, rebuild the preview and compare the cell count and the checks.

The cost and the accuracy caveat: refinement adds cells and timesteps: up to about 2× the cells in the bundled examples, and
7.5× the cells × timesteps cost for the blade (see the tables below). It also changes the grid around the feed, which
shifts the input impedance of wire antennas: the coarse helix check below moved the input
resistance by +27.7 %. Geometric resolution is not electromagnetic convergence, so compare a run
with and without the setting, or run the [convergence study](#convergence-study), before you
trust the impedance. The bundled UAV blade antenna example (`blade_867`) ships with the setting on.

The adaptive *Auto* mode uses `mesh: {"mode":"design", "overrides": {...}}`. It selects about
30 cells/λ and exact sheet edges for thin patterned sheet metal, otherwise 24 cells/λ and thirds;
air resolution decreases with primitive count (bounded to 8..feature resolution), dielectric
layers receive at least five subdivisions when present, and grading is 1.4. Padding is λ(f_min)/8 without far-field
calculation and λ(f_min)/4 with it. The NF2FF box is made from mesh lines and openEMS adds no
minimum clearance requirement in `Simulation.add_nf2ff_box`; the larger quarter-wave pad is the
conservative radiation-boundary choice. Per-field values can be fixed under `overrides`; those
values are reported literally and their notes identify the manual override. Adaptive values are resolved at
build time, so they are not written back into design JSON. Missing mode and `mode: auto` retain
the legacy choices.

A GPU comparison on the patch, dipole and microstrip designs kept this mode opt-in for existing
files. Against a 45 cells/λ openEMS reference with exact edges, the adaptive S11 MAE was slightly
higher than the legacy mesh on the patch (0.724 vs 0.696 dB), dipole (2.864 vs 2.852 dB), and
microstrip (2.823 vs 2.596 dB). These are single runs and the finer reference is a numerical
comparison, not a guaranteed converged solution. Inspect the reported choices and use per-field
overrides for the design at hand.

## Rules

The mesher reads every CSXCAD primitive (box, polygon, linpoly, cylinder, cylindrical shell,
sphere, polyhedron, curve, wire; other types and transformed primitives by their bounding box), the port and lumped-element
records of the `Simulation`, and the boundary conditions. Per axis:

1. **Fixed lines**: planes of zero-thickness sheets and polygons, dielectric faces, both ends of
   every port/lumped-element gap along its direction and its flat axis, the domain limits, and user
   lines.
2. **Metal edges**, the *thirds rule*: for each free metal edge parallel to an axis, one line d/3
   inside the metal and one 2d/3 outside, never on the edge. An edge on a mesh line looks about half a
   cell longer (VALIDATION.md, section 1c: a dipole resonates 8 % low that way at λ/20). An edge
   gets a line exactly on it instead when another feature is closer than d, for example the
   opposite edge of a narrow strip, a slot, a port plane or a coincident dielectric face. Collinear
   edges of separate shapes (the patches of an array) count as one edge line, not as neighbors. Where two
   metal shapes meet (one box continuing another) there is no edge and no line. Slanted polygon
   edges get lines at their vertex coordinates and a uniform cover of cell d over the polygon.
   A **polyhedron** gets lines at all its vertex coordinates (its faces are oblique, so no thirds
   rule). A **curve or wire** gets a uniform cover of half the local cell over its extent: FDTD
   puts a thin wire on the nearest mesh edges, and the finer cover keeps that staircase close to
   the curve (the helix, VALIDATION.md section 14). Cylinders and spheres get lines at their
   extent; a **tube** (cylindrical shell) also at its inner faces, with at least two cells across
   a wall thinner than two local cells.
3. **Narrow metal**: a strip, arm or post no wider than two local cells gets at least `metal_cells`
   cells across (exact edge lines, no thirds). If it is a zero-thickness sheet, it also gets two
   cells of that size on each side normal to the sheet. Without them a strip in a coarse normal mesh
   behaves like a much fatter conductor; the dipole resonated 2 % low that way. In a design, metal bricks far thinner than the mesh (PCB copper) are built as zero-thickness sheets by default (`mesh.thin_metal`, [DESIGNER.md](DESIGNER.md#simulation-settings)).
   Further rules keep a coarse mesh from changing a conductor's electrical size:
   - **Free tips.** The end of a thin arm (a cylinder or box at most two local cells wide and at
     least twice as long as wide, with no metal beyond its end) gets cells as wide as the arm,
     graded up from there at `max_ratio`. A half-wave dipole of two 1 mm radius wires (156 mm
     long, 900 MHz) resonated at 0.844 GHz at 20 cells/λ and 0.884 GHz at 80 when the cell beyond
     each tip was 14 mm. With tip cells it is 0.888 GHz at 20, 30, 40 and 60 cells/λ (Re Zin 70.6 Ω).
   - **Sheets.** Next to every other zero-thickness sheet (a blade, a ground plane, a wide patch)
     the cells normal to it are half the local maximum cell, except inside a dielectric, whose
     layers set them. The UAV blade antenna had cells of λ/20 straddling its sheet and resonated
     at 0.843 GHz at 20 cells/λ, converging (0.908 GHz) only from 50; now it is 0.904 GHz at 20.
   - **Fine gaps, notches and slanted strips.** Automatic meshes first check narrow features against
     the mesh produced by the rules above. Parallel sheet edges with finite overlap identify strip
     widths, notches and gaps; lumped feed gaps are checked along their excitation direction. A
     detected gap, notch or feed gap with fewer than three cells across receives a local size
     limit. Slanted strips use a 1.1-cell projected target (at least one projected cell in the
     resolution check) for connectivity, typically yielding about 1–1.5 cells. For a slanted strip, both axes in its plane are refined using the edge-normal projections, so its
     perpendicular width, rather than its much larger bounding box, sets the cell size. The local
     limit allows for the fill rule's 10 % margin. Sheet-normal cells are also limited near the
     feature, and grading returns to the normal mesh size at `max_ratio`. Only windows where
     the refined cap is smaller than the normal mesh's realized cell size are refilled, with
     a grading fringe. Geometric fixed lines remain; optional cover lines can move inside
     the window so rows of closely spaced cover lines do not spread refinement. Baseline
     lines outside the window are retained exactly. Bounding-box prefilters skip distant
     edge pairs and conductors before the geometric tests.

     Refinement changes only automatic meshes with a detected under-resolved feature. Manual
     lines are kept as supplied. The detector covers parallel edges with finite overlap; it does
     not guarantee resolution of arbitrary curves, nonparallel details or every transformed
     shape. Inspect the mesh preview, particularly conductor connectivity, before running.
     An explicitly supplied `min_cell` can prevent the three-cell target; the preview then
     reports the remaining under-resolved feature instead of treating it as resolved.
     If refinement would exceed the configured cell limit, the largest estimated Cartesian
     refinements are dropped first until the remaining set fits. The preview reports counts
     of dropped and retained requests. It retains the exact baseline if none fit. A single
     `mesh-fine-feature` warning summarizes the unresolved count and the three worst widths,
     measured cells and targets; it does not emit a separate warning for every edge pair.
4. **Dielectrics**: `dielectric_cells` cells across a layer thinner than that many local cells.
   Inside a dielectric's extent along an axis, the maximum cell is λ/(cells · sqrt(ε_r)).
5. **Domain**: the bounding box of all geometry and ports, plus `pad` (λ(f_min)/4) toward
   absorbing boundaries, plus 8 cells for `PML_8` (the PML lives inside the domain). Nothing is
   added toward PEC/PMC boundaries: those are the symmetry or ground plane the structure touches.
6. **Slivers**: fixed lines within 10⁻⁶ (relative) are one line: CSXCAD returns polyhedron
   vertices in single precision, so a vertex at 11.4300003 next to a box edge at 11.43 would
   otherwise leave a 3·10⁻⁷ gap. An optional line (fills, sheet-normal refinement) closer than 0.4 of its own spacing
   to a fixed line is dropped. Of two fixed lines closer than `min_cell`, the lower-priority one is
   dropped (priorities: domain > hard geometry > metal edge > thirds > port side). Two hard lines
   that close are both kept and reported, since moving either would change the geometry.
7. **Grading**: each line j gets a local size h_j (the smaller neighboring gap, capped at the
   local max cell). The size field s(x) = min_j (h_j + g·|x − x_j|), capped, grows linearly away from
   every feature, which is a geometric cell sequence with ratio ≈ 1 + g (g = 0.85 · (max_ratio − 1)).
   Each gap gets n = ceil(∫dx/s) cells at equal steps of that integral. Cells follow the size
   field and land exactly on the fixed lines. Splitting a gap into n cells makes the cell next to
   its end line smaller than h_j, so the gaps are filled again (to a fixed point) with each gap
   grading from the cell actually placed on the far side of its end lines, and a gap at most 10 %
   over the local size stays one cell (otherwise two half-size slivers appear and spread into the
   neighboring gaps). Cells can therefore exceed the cap by up to 10 % in such a gap. CSXCAD's `SmoothMeshLines` is
   not used, because it leaves an isolated small cell (a feed gap) next to λ/20 cells (ratio 3.7 in
   the hand-meshed dipole).

## Report

`auto_mesh` returns a report, kept in `sim.mesh_report` and written to the bundle as `mesh.auto`:

| Field | Meaning |
| --- | --- |
| `settings` | The options used |
| `cells`, `total_cells` | Cells per axis and in total |
| `min_cell`, `max_cell` | Smallest and largest cell (drawing units) |
| `max_neighbour_ratio` | Largest ratio of neighboring cells (fixed-line clusters can exceed `max_ratio` slightly) |
| `res_air`, `res_dielectric` | Max cell in air and in the densest dielectric |
| `timestep_s`, `timesteps_per_ns` | CFL timestep estimate from the smallest cells |
| `memory_mb_estimate` | About 90 bytes per cell (fields plus operator) |
| `warnings` | For example two hard lines closer than `min_cell` |
| `fine_features` | Detected fine features: kind, width, affected axes and bounds, required cells (1 for slanted strips, otherwise 3), measured `cells_across`, and `resolved` |
| `fine_feature_refinement` | Cell-count impact: `baseline_cells` before local refinement, final `total_cells`, `added_cells`, and final/baseline `ratio`. A limit guard also reports `skipped_cell_limit`, `cell_limit`, `required_cells_lower_bound`, `dropped_features` and `retained_features`; `enabled` records the switch |

The fine-feature cells-across value is conservative: the feature width divided by the sum of
the largest intersecting cell width on each axis, projected onto the feature's width direction.
It measures geometric resolution,
not electromagnetic convergence. The features are measured with the setting off too. After
preview generation, the design checks report `mesh-fine-feature` if a reported feature falls below
its required resolution: an info that suggests turning on the setting when it is off, and a warning
when it is on and the cell limit left a feature under-resolved. The report
and cell-count comparison use the in-process mesh preview; they do not run the solver. A manual
mesh or an older preview without this report has no fine-feature resolution assessment.
When refinement adds cells, the Checks list shows the baseline and refined totals, the added
cells and their ratio. Refinement is local along each coordinate axis; Cartesian mesh lines
extend through the domain, so refining a long slanted strip can still add many cells.

## Fine-feature mesh regression

The reproducible in-process comparison uses main revision
`63e3550cbb5f07b92dd3c18dd22833ab6366251d` and the revised refinement algorithm. Every saved
example is explicitly opted in for the comparison, although the setting is off by default and
only the blade example ships with it on. Full values are in
`python/tests/fixtures/automesh_fine_features_comparison.json`. These are mesh measurements,
not electrical convergence measurements.

The synthetic blade fixture has three 1 mm notches, a 0.4 mm slanted strip and a 1.35 mm feed.

| Measurement | Main | Revised refinement |
| --- | --- | --- |
| Cells (x × y × z) | 106 × 28 × 72 | 206 × 50 × 263 |
| Total cells | 213,696 | 2,708,900 |
| Minimum cell (mm) | 0.19635 | 0.1788 |
| Maximum neighbor ratio | 1.4 | 1.398 |
| Cells across each 1 mm notch | 1.0, 1.0, 1.0 | 5.0, 5.0, 5.0 |
| Cells across the feed | 1.0 | 4.0 |
| Projected cells across the strip | 0.12023 | 1.21603 |
| Strip midpoint staircase components | 9 | 1 |
| Cells × timesteps/ns (billions) | 0.337 | 7.002 |

Connectivity joins nodes when their electric-edge midpoint lies inside the strip. It is a
geometric staircase check. The revised fixture is below 3 M cells (the earlier three-cell
strip target produced 14,250,600). All three notches and the feed retain at least three cells.

For the 21 bundled variants, the cost column is **cells × estimated timesteps per ns**, in
billions, followed by its after/before ratio. It compares equal simulated physical durations
using the CFL estimate, not wall time or a prediction of convergence. Ten meshes remain
identical. Helix z lines above 25 mm remain exactly the same as the baseline; the feed's small
cells no longer spread along the whole 200 mm wire. Existing baseline grading violations can
remain in untouched regions; none of these examples has a worse maximum neighbor ratio.

| Example | Cells, main → refined | Minimum cell (mm), main → refined | Cost (billions), main → refined; ratio |
| --- | --- | --- | --- |
| `branchline-coupler` | 81,090 → 81,090 | 0.14417 → 0.14417 | 0.205 → 0.205; 1.00× |
| `dipole` | 240,120 → 295,200 | 0.16667 → 0.16667 | 0.615 → 0.830; 1.35× |
| `helix-axial` | 1,360,800 → 1,535,960 | 1.33449 → 0.75000 | 0.463 → 0.984; 2.12× |
| `inset-patch` | 240,786 → 304,668 | 0.31144 → 0.25000 | 0.290 → 0.495; 1.71× |
| `lowpass-stepped` | 133,000 → 133,000 | 0.07811 → 0.07811 | 0.724 → 0.724; 1.00× |
| `microstrip-line` | 3,106,880 → 3,106,880 | 0.13797 → 0.13797 | 7.398 → 7.398; 1.00× |
| `minkowski-patch` | 143,640 → 143,640 | 0.32354 → 0.32354 | 0.157 → 0.157; 1.00× |
| `patch-antenna` | 167,040 → 167,040 | 0.33969 → 0.33969 | 0.157 → 0.157; 1.00× |
| `patch-array-2x1` | 115,872 → 115,872 | 0.33967 → 0.33967 | 0.109 → 0.109; 1.00× |
| `patch-array-4x1` | 451,200 → 451,200 | 0.33963 → 0.33963 | 0.424 → 0.424; 1.00× |
| `pyramidal-horn` | 1,103,856 → 1,103,856 | 0.20819 → 0.20819 | 2.121 → 2.121; 1.00× |
| `sierpinski-monopole--iterations-0` | 9,687,972 → 9,900,352 | 0.18543 → 0.18543 | 22.963 → 24.070; 1.05× |
| `sierpinski-monopole--iterations-3` | 28,387,072 → 28,908,000 | 0.03289 → 0.03289 | 334.632 → 340.773; 1.02× |
| `wilkinson-divider` | 756,276 → 756,276 | 0.13046 → 0.13046 | 2.754 → 2.754; 1.00× |
| `blade-867` | 136,500 → 269,040 | 1.40492 → 0.43767 | 0.038 → 0.283; 7.53× |
| `collinear-867` | 3,516,544 → 3,713,820 | 0.08953 → 0.08953 | 13.352 → 14.120; 1.06× |
| `meander-dipole-867` | 976,472 → 1,073,856 | 0.25599 → 0.25599 | 1.782 → 1.960; 1.10× |
| `sleeve-dipole-867` | 442,800 → 509,733 | 0.26078 → 0.23791 | 0.758 → 0.918; 1.21× |
| `ux-inset-patch-2-4-ghz` | 123,420 → 166,870 | 0.40000 → 0.25000 | 0.131 → 0.274; 2.09× |
| `wideband-dipole-867` | 830,576 → 1,112,832 | 0.40000 → 0.40000 | 0.855 → 1.263; 1.48× |
| `yagi-867` | 714,840 → 714,840 | 0.36511 → 0.36511 | 0.845 → 0.845; 1.00× |

The synthetic dense PCB has 20 mm long, 0.4 mm wide coplanar traces with 0.2 mm gaps,
a 1–3 GHz band, MUR boundaries and 20 cells/λ. All adjacent gaps meet the three-cell target.
The counts include the Cartesian cost of refining through the whole domain.

| Traces | Cells, main → refined | Minimum cell (mm), main → refined | Cost (billions), main → refined; ratio |
| --- | --- | --- | --- |
| 20 | 692,496 → 876,960 | 0.06200 → 0.04660 | 4.602 → 7.238; 1.57× |
| 60 | 1,781,136 → 2,306,080 | 0.06200 → 0.04994 | 11.837 → 18.270; 1.54× |
| 120 | 3,414,096 → 4,449,760 | 0.06200 → 0.04660 | 22.689 → 36.725; 1.62× |

Detector timing uses 20 segmented rectangular trace outlines, 100 mm long, with the same
width and gap; `max_width=0.25 mm`. This isolates detection from meshing. The prior detector
is revision `efbbcfa`. Single-run timings are workload-specific, not general performance guarantees.

| Edges | Before prefilter (s) | With prefilter (s) | Features, both versions |
| --- | --- | --- | --- |
| 3,200 | 3.062 | 0.185 | 1,501 |
| 10,000 | 27.611 | 0.661 | 4,731 |

Reproduce from `python/` with an openEMS Python environment:

```bash
nice -n 15 python -m tests.mesh_feature_measurements --examples --dense-pcb --detection
nice -n 15 python -m tests.mesh_feature_measurements --examples --dense-pcb --reference-revision 63e3550cbb5f07b92dd3c18dd22833ab6366251d
nice -n 15 python -m tests.mesh_feature_measurements --detection --detector-revision efbbcfa
```

Dipole and patch select their automatic option; manual-only examples are remeshed from
geometry with automatic defaults. This intentionally measures the same inputs on both sides.

### Coarse helix field sanity check

Because the helix mesh changes, it was also run sequentially on the CPU with four threads,
20 cells/λ, a −30 dB stopping criterion and a 60,000-step cap. Both reached the stopping
criterion. Patterns used 5° theta and 10° phi steps at 2.4 GHz. Temporary solver output was
removed after each run. The comparison script reports only measurements and run settings.

| At 2.4 GHz | Main | Refined | Difference |
| --- | --- | --- | --- |
| Dmax | 12.100 | 11.996 | -0.104 dB |
| Boresight axial ratio | 1.120 | 0.834 | -0.286 dB |
| Input resistance | 156.344 | 199.676 | +43.332 Ω |

The input-resistance change is substantial (about +27.7%); this is why the setting is off by
default. It is a remaining convergence question, not evidence of electrical equivalence. A thin wire's effective radius depends on
its staircase mesh, and feed refinement changes that mesh locally. Dmax and axial ratio are
close in this coarse check. The main run also reported 100.2% raw radiation efficiency,
consistent with a small numerical power-balance error. These runs do not validate other
changed examples or establish converged impedance.

```bash
nice -n 10 env OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=1 python -m tests.helix_mesh_sanity --reference-revision 63e3550cbb5f07b92dd3c18dd22833ab6366251d
```

## Validation

The field results in this section predate local fine-feature refinement. They are historical
validation results. The coarse helix check above is the only new field comparison in this
revision; the remaining mesh table does not establish field accuracy. A mesh-only resolution check does not establish electromagnetic convergence.

GPU engine, −60 dB end criterion. Compare with the converged hand-tuned results in VALIDATION.md:

| Model | Mesh | Cells | Resonance | vs converged | Dmax (dBi) |
| --- | --- | --- | --- | --- | --- |
| Dipole (PML) | hand, mesh_div 40 (converged) | 810 k | 2.4198 GHz (X = 0) | | 2.133 |
| Dipole (PML) | hand, mesh_div 20 (old default) | 166 k | 2.4147 GHz | −0.21 % | 2.163 |
| Dipole (PML) | **auto, 20 cells/λ** | 219 k | **2.4182 GHz** | **−0.07 %** | 2.159 |
| Patch (MUR) | hand, mesh_div 40 (converged) | 536 k | 2.4550 GHz (S11 min) | | 6.786 |
| Patch (MUR) | hand, mesh_div 30 (default) | 264 k | 2.4525 GHz | −0.10 % | 6.788 |
| Patch (MUR) | **auto, 20 cells/λ** | 153 k | **2.4525 GHz** | **−0.10 %** | 6.886 |
| Patch (MUR) | auto, 30 cells/λ | 390 k | 2.4525 GHz | −0.10 % | 6.869 |

- Resonances are within 0.1 % of the converged values. Cell counts are similar to the hand
  meshes, and lower than the hand mesh of the same accuracy for the patch (153 k vs 264 k), because
  the fine cells go where the rules put them rather than everywhere.
- Patch Dmax reads 0.1 dB above the hand mesh with automesh at 20 and 30 cells/λ alike, and also
  with a larger air pad (6.876 dBi with λ/4 at 0.75 GHz). This is the same size of difference as
  the MUR-boundary sensitivity in VALIDATION.md, section 1c: the automesh domain has λ/20 cells at
  the MUR walls, the hand mesh λ/30. Use PML boundaries when Dmax matters to 0.1 dB.
- The monopole template (PEC ground boundary, the domain starts at z = 0) runs with the automatic
  mesh: 180 k cells, resonance 2.66 GHz (X = 0) for a 25 mm wire.

## Convergence study

Whether a mesh is fine enough is answered by refining it until the results stop changing. For a
design file this is one command (or the designer's Mesh convergence… dialog,
[DESIGNER.md](DESIGNER.md#mesh-convergence)):

```bash
fairbeam converge my.design.json --densities 15,20,30,40 --max-runs 4 --engine gpu
```

It runs the design at each `cells_per_wavelength` in turn (the Auto mode's override, or
`mesh.cells_per_wavelength` in the legacy mode; an explicit air density scales with it) and stops
at the first step where the resonance moved less than 0.5 %, |S11| there less than 1 dB and Dmax
less than 0.2 dB ("converged at" the coarser density of that step). Manual mesh lines are refused. Each run of the study is `fairbeam run --mesh-density CELLS` on the design.
The patch starter design (`template: patch`, 2.45 GHz, MUR, −60 dB), GPU engine, 2026-09-28:

| Cells/λ | Cells | Resonance | Δf | \|S11\| | Δ\|S11\| | Dmax | Zin | Wall time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 15 | 55 k | 2.4495 GHz | | −42.35 dB | | 6.76 dBi | 49.7 − j0.4 Ω | 1.1 s |
| 20 | 101 k | 2.4538 GHz | +0.173 % | −41.34 dB | +1.02 dB | 6.75 dBi | 49.8 − j0.5 Ω | 1.2 s |
| 30 | 251 k | 2.4559 GHz | +0.088 % | −40.68 dB | +0.66 dB | 6.75 dBi | 49.3 − j0.1 Ω | 1.9 s |

Verdict: converged at 20 cells/λ (20 → 30 is within every tolerance; 15 → 20 missed the |S11|
tolerance by 0.02 dB). A match this deep (−40 dB) makes |S11| in dB very sensitive: 1 dB there is
a change of the reflection coefficient of about 0.001. Loosen `--tol-s11` for such designs, or
judge the resonance and Dmax.

## Limitations

- Lines are global (FDTD): a fine feature refines its whole row and column. The size field keeps
  that local in the other two directions, but many small features spread over a large board still
  cost cells.
- Slanted and curved edges are staircased. Vertex lines plus the d-cover help, but are no substitute
  for convergence checks ([Convergence study](#convergence-study) for a design;
  `fairbeam converge ... --param auto_cpw=15,20,30` or your own mesh parameter for a Python model).
- Rotated or transformed primitives are meshed by their bounding box.
- The grading next to split gaps (rule 7) has been fixed. Before, the gap across such a line graded
  from the unsplit gap, so the branch-line coupler, the low-pass filter, the microstrip template and
  the helix had neighbor ratios up to 2.1. Their meshes change (branch-line 69 k → 76 k cells,
  low-pass 100 k → 126 k); the dipole, patch, arrays and the other templates are unchanged. The
  branch-line and low-pass bundles were re-run with the fix on 2026-09-25: the branch-line center
  moved from 2.406 to 2.414 GHz and the low-pass −3 dB point from 2.349 to 2.356 GHz
  (VALIDATION.md section 10), which is the mesh sensitivity of those results.
- Dielectric maxima use the extent of each dielectric along each axis (1-D projection), so a
  substrate also refines the air above and beside it in the directions it spans.
