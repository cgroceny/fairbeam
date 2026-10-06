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
| `min_cell` | 0.45 × the finest requested cell | Lines closer than this are merged (see below) |
| `pad` | λ(f_min) / 4 | Air between the structure and absorbing boundaries (PML cells are added on top). A number, or six values (x-, x+, y-, y+, z-, z+); 0 leaves that face on the structure with no PML cells added, for a feed waveguide that runs into the PML (`pyramidal_horn.py`) |
| `keep_existing` | `True` | Lines already on the grid (added by the model) are kept as fixed lines |
| `verbose` | `False` | Print the report |

In a design file the Simulation › Mesh settings dialog has the mode *Auto* (`mesh.mode: "design"`, described below) and *Automatic (legacy)* (`"auto"`, also what a design without `mode` uses); a design with `"manual"` lines shows *Manual lines*. Design JSON in the legacy `auto` mode can set `mesh.edge_rule`, `mesh.max_ratio`, and `mesh.air_cells_per_wavelength`
alongside the existing cells-per-wavelength and padding fields. Omitting them preserves the
previous mesh. The designer's cell and time estimates use the returned mesh lines and timestep,
so they include the selected options after preview generation.

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
   Two more rules keep a coarse mesh from changing a conductor's electrical size:
   - **Free tips.** The end of a thin arm (a cylinder or box at most two local cells wide and at
     least twice as long as wide, with no metal beyond its end) gets cells as wide as the arm,
     graded up from there at `max_ratio`. A half-wave dipole of two 1 mm radius wires (156 mm
     long, 900 MHz) resonated at 0.844 GHz at 20 cells/λ and 0.884 GHz at 80 when the cell beyond
     each tip was 14 mm. With tip cells it is 0.888 GHz at 20, 30, 40 and 60 cells/λ (Re Zin 70.6 Ω).
   - **Sheets.** Next to every other zero-thickness sheet (a blade, a ground plane, a wide patch)
     the cells normal to it are half the local maximum cell, except inside a dielectric, whose
     layers set them. The UAV blade antenna had cells of λ/20 straddling its sheet and resonated
     at 0.843 GHz at 20 cells/λ, converging (0.908 GHz) only from 50; now it is 0.904 GHz at 20.
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

## Validation

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
