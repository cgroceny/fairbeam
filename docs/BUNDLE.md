# Project bundle: `fairbeam.project/1`

A bundle is one JSON file that describes one simulation: the model and its parameter values, the solver setup, the exact geometry, the mesh, the run statistics and the post-processed results. It is written by `Simulation.to_bundle()` (`python/fairbeam/simulation.py`) and read by the viewer (typed in `src/types.ts`) and the VBA macro exporter (`src/export/cst.ts`).

Files live in `public/projects/<slug>.json`. Each write also rebuilds `public/projects/index.json` (see [Index file](#index-file)).

## Conventions

| Quantity | Unit |
| --- | --- |
| Lengths and coordinates | drawing units, given by `units.length` / `units.length_m`. The default is **mm** (`length_m = 0.001`) |
| Frequencies | **Hz** everywhere in the bundle. The index file uses GHz |
| Angles (`theta`, `phi`) | degrees. θ is measured from +z, φ from +x toward +y |
| Directivity and gain | dBi |
| Power | W |
| Impedance and resistance | Ω |
| Time | `time_ns` in ns, `dt_s` in s |
| Conductivity (`kappa`) | S/m |

- Coordinates are `[x, y, z]` triples (`Vec3`). Axis indices are `0 = x`, `1 = y`, `2 = z`.
- Bounding boxes are `[[xmin, ymin, zmin], [xmax, ymax, zmax]]`.
- The JSON is written compactly with `allow_nan=False`, so it never contains `NaN` or `Infinity`.
- Files are written atomically: the writer creates `<slug>.json.tmp` and then renames it.
- Rounding: mesh lines have 4 decimals, geometry 6, S11 5, Zin 3, far-field angles and directivity 2.

## Top level

| Field | Type | Description |
| --- | --- | --- |
| `schema` | string | Always `"fairbeam.project/1"`. Readers should check the `fairbeam.project/` prefix |
| `generator` | object | See [generator](#generator) |
| `created` | string | Local time as `%Y-%m-%dT%H:%M:%S%z`, for example `2026-09-24T22:24:15+0300` (the offset has no colon) |
| `name` | string | Display name: the model name plus overrides, for example `Sierpinski gasket monopole · iterations=3`. `fairbeam geometry` appends ` (geometry only)` |
| `model` | object | See [model](#model) |
| `units` | object | See [units](#units) |
| `solver` | object | See [solver](#solver) |
| `parts` | Part[] | Physical structure. See [parts](#parts) |
| `ports` | Port[] | See [ports](#ports) |
| `lumped_elements` | LumpedElement[]? | Lumped circuit elements that are not ports (e.g. an isolation resistor). Absent when there are none. See [lumped_elements](#lumped_elements) |
| `half_space` | object \| null | Infinite PEC ground from a boundary. See [Half space and mirror planes](#half-space-and-mirror-planes) |
| `mesh` | object | See [mesh](#mesh) |
| `domain` | `{min: Vec3, max: Vec3}` | Simulation domain: the first and last mesh line on each axis |
| `nf2ff_box` | `{min, max, faces?}` \| null | Bounding box of the `DumpBox` helper primitives that are the NF2FF recording surfaces (Fairbeam's own field dumps, surface currents `fairbeam_J_*` and field planes `fairbeam_F_*`, are excluded). `null` if there are none. `faces` (6 booleans, x-, x+, y-, y+, z-, z+) is present when the model skipped faces with `add_nf2ff_box(directions=…)`, e.g. the face a feed waveguide crosses; `false` = not recorded |
| `nf2ff_center` | Vec3 \| null | Phase center used for the NF2FF transform. It is the value passed to `add_nf2ff_box(center=…)`, else the center of `focus`, else the origin. `null` when the model has no NF2FF box |
| `focus` | `{min, max}` \| null | Region the viewer frames by default (`Simulation.set_focus`) |
| `run` | object \| null | Solver statistics. `null` for geometry-only bundles. See [run](#run) |
| `results` | object \| null | Post-processed results. `null` for geometry-only bundles. See [results](#results) |
| `fields` | object? | Optional surface-current maps (`fairbeam run --fields`). See [fields](#fields) |
| `field_planes` | FieldPlaneMap[]? | Optional E/H field maps on cut planes (`fairbeam run --field-plane`, a design's `monitors.field_planes`). See [field_planes](#field_planes) |

### generator

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | `"fairbeam"` |
| `version` | string | Fairbeam package version |
| `openems` | string \| null | `openEMS.__version__` |
| `csxcad` | string \| null | `CSXCAD.__version__`, if the module exposes it |
| `python` | string | Python version |

### model

This is the model file's `MODEL` dict (`id`, `name`, `description`, and optionally `reference`) spread into the object, plus:

| Field | Type | Description |
| --- | --- | --- |
| `params` | Param[] | One entry per `PARAMS` item, in declaration order |

Each Param is `dataclasses.asdict(Param)` plus the resolved value:

| Field | Type | Description |
| --- | --- | --- |
| `key` | string | Parameter key used by `--set` |
| `default` | number \| string | Default value |
| `value` | number \| string | Value used for this run |
| `label` | string | Human-readable label |
| `unit` | string | Display unit, for example `"mm"` or `"GHz"`, or `""`. This is the model's own unit, not the bundle's |
| `description` | string | Longer description (may be empty) |
| `minimum`, `maximum` | number \| null | Allowed range |

### units

| Field | Type | Description |
| --- | --- | --- |
| `length` | string | `"mm"` when the drawing unit is 1e-3 m, otherwise `"<unit> m"` (for example `"0.0001 m"`) |
| `length_m` | number | Drawing unit in meters |
| `frequency` | string | Always `"Hz"` |

### solver

| Field | Type | Description |
| --- | --- | --- |
| `engine` | string | `"openEMS"` |
| `method` | string | `"FDTD (Yee, staircase)"` |
| `excitation` | object | See below |
| `boundaries` | object | Keys `x-`, `x+`, `y-`, `y+`, `z-`, `z+`. Values are openEMS boundary names: `"MUR"`, `"PEC"`, `"PMC"`, `"PML_8"`, … |
| `end_criteria_db` | number | Energy end criterion in dB, for example `-40` |
| `max_timesteps` | number | Timestep limit |

`excitation` has one of two shapes:

- **Default** `{"type": "gaussian-derivative", "f_min", "f_max", "expression", "dc_free": true}`. `expression` is the fparser formula in `t` (seconds) passed to openEMS' custom excitation. The pulse has unit peak and is -20 dB at `f_max`.
- **openEMS Gaussian** `{"type": "gaussian", "f0", "fc", "f_min", "f_max", "dc_free": false}`, where `f0 = (f_min + f_max) / 2` and `fc = (f_max - f_min) / 2`.

## parts

Physical CSXCAD properties with their primitives, in order of first appearance. Helper properties (`DumpBox`, `ProbeBox`, `Excitation`) and the `LumpedElement` properties created by ports are excluded. Ports are listed in `ports` instead.

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | CSXCAD property name (unique) |
| `label` | string? | Display label from `sim.metal(..., label=)` or `sim.dielectric(..., label=)` |
| `type` | string | CSXCAD property type: `"Metal"`, `"Material"`, `"ConductingSheet"`, … |
| `color` | string? | Optional color recorded by the model |
| `material` | object? | Present only for `type == "Material"`. See below |
| `conductor` | object? | A metal of finite conductivity (a design material's `conductivity`, `sim.metal(..., conductivity=)`): `conductivity` in S/m and `thickness`, the modeled sheet thickness in mm of a `"ConductingSheet"` (openEMS `AddConductingSheet`), `null` for a volume, which is a `"Material"` of that conductivity and is still a metal. Absent for perfect conductors |
| `void` | boolean? | `true` for a vacuum carver (a Boolean Subtract's cut-out): it erases lower-priority material inside it; viewers should draw it as a ghost or hide it; absent otherwise; older readers show it as an ordinary `eps_r` 1 part |
| `primitives` | Primitive[] | Geometry, see below |
| `bbox` | [Vec3, Vec3] | Union of the primitives' bounding boxes |

`material`:

| Field | Type | Description |
| --- | --- | --- |
| `eps_r` | number | Relative permittivity (x component if anisotropic) |
| `mu_r` | number | Relative permeability |
| `kappa` | number | Electric conductivity in S/m. openEMS models dielectric loss as a constant conductivity |
| `tan_d` | number \| null | Loss tangent requested by the model (`null` if the property was created directly through CSXCAD) |
| `tan_d_freq` | number \| null | Frequency in Hz at which `kappa` reproduces `tan_d` exactly (`kappa = tan_d · 2π f · ε0 · eps_r`). Defaults to the band center |
| `isotropic` | boolean | `false` if epsilon or kappa differ between axes |
| `dispersion` | object? | **Optional.** A frequency-dependent dielectric (`Simulation.dispersive`, `fairbeam.dispersion`). The CSXCAD property is then a `LorentzMaterial`, exported with `type: "Material"` so that viewers and exporters treat it as a dielectric. `eps_r`, `mu_r` and `tan_d` are its values at `tan_d_freq`, the band center, and `kappa` is the conductivity that gives its whole loss there (`kappa = tan_d · 2π f · ε0 · eps_r`, as for a constant material), so that a consumer that takes the loss as a conductivity keeps the band-center loss; the static conductivity is `dispersion.kappa`. Absent for constant materials, so existing bundles are unchanged |

`material.dispersion` is the model as simulated, with frequencies in Hz and times in s, in openEMS'
conventions (e^{+jωt}):

| Field | Type | Description |
| --- | --- | --- |
| `model` | string | `"lorentz"`: ε∞·[1 − Σ ωp²/(ω² − ωL² − jω/τ)], where Drude is ωL = 0. openEMS 0.37.0rc3's DebyeMaterial diverges above ΣΔε/ε∞ ≈ 0.3 in 3D (0.6 in 1D), so Debye poles and laminates are simulated as fitted Lorentz poles, and the bundle records those. `"debye"` (ε∞ + Σ Δε/(1 + jωτ)) appears only inside `source`, or for a DebyeMaterial a model created directly through CSXCAD |
| `eps_inf` | number | ε∞ |
| `kappa` | number | Static conductivity in S/m (adds −jκ/(ωε0)) |
| `eps_poles` | object[] | `{"type": "lorentz", "f_plasma", "f_pole", "tau"}` (in `source` also `{"type": "debye", "delta", "tau"}`) |
| `mu_inf`, `mu_poles` | number, object[] | Magnetic Lorentz/Drude dispersion. Present only when μ∞ ≠ 1 or there are poles |
| `source` | object? | The model the poles were fitted to, with the fit. For a Djordjevic-Sarkar laminate: `{"model": "djordjevic-sarkar", eps_inf, delta, m1, m2, fit: {f_min, f_max, span}, report: {...}}`. For Debye poles: the requested Dispersion (`"model": "debye"`, its poles), with `fit` and `report`. The report holds the fit errors in the band and the timestep `dt` the poles were bounded by |

### Primitives

Every primitive has these fields:

| Field | Type | Description |
| --- | --- | --- |
| `kind` | string | `"box"`, `"polygon"`, `"linpoly"`, `"cylinder"`, `"cylindricalshell"`, `"sphere"`, `"rotpoly"`, `"curve"`, `"wire"`, `"polyhedron"`, `"transformed"` or `"bbox"` |
| `priority` | number | CSXCAD priority. Where primitives overlap, the higher priority wins |
| `bbox` | [Vec3, Vec3] | Bounding box |
| `exact` | boolean | `true` if the shape is reproduced exactly, `false` for the bounding-box fallback |

The remaining fields depend on `kind`:

- **`box`**: `start`, `stop` (Vec3), which are opposite corners. A box with zero extent on one axis is a sheet, for example a patch or a ground plane.
- **`polygon`**: a planar polygon (zero thickness).
  - `normal` is the normal axis index `n` (0, 1 or 2).
  - `elevation` is the plane's coordinate along axis `n`.
  - `points` is a list of `[a, b]` pairs in the plane.
- **`linpoly`**: the same fields as `polygon`, plus `length`. The polygon is extruded along the normal from `elevation` to `elevation + length` (`length` may be negative).
- **`cylinder`**: `start`, `stop` (Vec3) are the axis end points, and `radius` is the radius.
- **`cylindricalshell`**: a tube (CSXCAD `CylindricalShell`). `start`, `stop` as for `cylinder`; `radius` is the radius of the middle of the wall and `shell_width` the wall thickness, so the tube spans `radius - shell_width / 2` to `radius + shell_width / 2`.
- **`sphere`**: `center` (Vec3) and `radius` (CSXCAD `Sphere`).
- **`rotpoly`**: a solid of revolution (CSXCAD `RotPoly` turned a full circle; the designer's cone and torus). `points` are `[radial, axial]` pairs of a closed outline, turned about the line through `origin` (Vec3) along axis index `axis` (0, 1 or 2): a point is inside when its distance from that line and its coordinate along it, minus `origin`, lie in the outline. Radial values are never negative. The exporter computes `bbox` itself (CSXCAD's ignores the rotation) and writes full turns in the plane through the axis; an additional native affine transform is represented by a `transformed` wrapper.
- **`curve`**: a thin wire along a polyline (CSXCAD `Curve`). `points` is a list of Vec3. It has no radius: openEMS puts it on the nearest mesh edges, so its effective radius is a fraction of a cell. Viewers draw it as a tube of a nominal radius.
- **`wire`**: the same with a `radius` (CSXCAD `Wire`), rasterised as a volume.
- **`polyhedron`**: a closed solid (CSXCAD `Polyhedron`). `vertices` is a list of Vec3 and `faces` a list of vertex-index lists (triangles; CSXCAD only rasterises triangular faces correctly). Faces are oriented outward in Fairbeam's models, but readers should not rely on it.
- **`transformed`**: an exact affine instance of a supported primitive. `primitive` contains that exact local shape, `matrix` is a row-major 4×4 homogeneous matrix mapping column vectors from local to world coordinates, and `bbox` is the world-space axis-aligned bound. It is a separate kind so older readers cannot mistake local coordinates for world geometry. Readers that do not support the wrapper should use `bbox` as an explicitly approximate fallback.
- **`bbox`**: fallback for CSXCAD primitive types Fairbeam does not export exactly. `source_kind` holds the CSXCAD type name, and only `bbox` describes the shape. When the native type is understood but its exact local geometry is not, the bound is transformed into world coordinates and `transformed: true` is set.

Added later (additive): `curve`, `wire` and `polyhedron`. Older readers treat the new kinds as
unknown and should fall back to `bbox`. The drawing shows polyhedra by their hull and feature edges
and wires as polylines.

Added with exact arbitrary-angle designer transforms (additive): `transformed`. Older readers treat
the wrapper as unknown and should fall back to its world-space `bbox`. Native simulation keeps the
local CSXCAD primitive and applies its affine matrix. Zero-thickness metal sheets must remain
parallel to the solver coordinate planes; lossy sheets must also retain their local normal because
openEMS selects tangential loss from the local CSXCAD bounds. The VBA macro exporter skips transformed
geometry with a warning.

Added with the designer's cylinder-shell and sphere shapes (additive): `cylindricalshell` and `sphere`. The viewer,
the drawing and the VBA macro exporter (a Cylinder with an inner radius, a Sphere) rebuild them exactly;
the fabrication export treats a vertical tube through the substrate as a plated via of its outer
diameter and skips spheres with a warning.

Added with the designer's cones and tori (additive): `rotpoly`. The viewer turns the outline
exactly (a lathe), the drawing shows a circle along the axis and the silhouette from the side, the
VBA macro exporter writes a Cone (or a Cylinder for equal radii) or a Torus when the outline is one, and
skips other outlines with a warning; the fabrication export skips it with a warning.

**In-plane coordinate convention (polygon and linpoly).** This follows CSXCAD. For normal axis `n`:

- the first coordinate of each point lies along axis `(n + 1) % 3`
- the second coordinate lies along axis `(n + 2) % 3`

| normal | `points[i][0]` | `points[i][1]` |
| --- | --- | --- |
| 0 (x) | y | z |
| 1 (y) | z | x |
| 2 (z) | x | y |

Note the y-normal case: points are `(z, x)`, not `(x, z)`. The 3D position of point `[a, b]` is:

```
p[n] = elevation;  p[(n+1)%3] = a;  p[(n+2)%3] = b
```

## ports

| Field | Type | Description |
| --- | --- | --- |
| `number` | number | Port number. It is also the key into `results.ports` (as a string) |
| `type` | string | `"lumped"` (openEMS `LumpedPort`) or `"waveguide"` (openEMS `RectWGPort`) |
| `R` | number | Port (reference) resistance in Ω. Waveguide ports: the TE wave impedance at the band center (see below) |
| `direction` | string | `"x"`, `"y"` or `"z"`: the direction of the feed current and voltage (waveguide: of propagation into the structure) |
| `start`, `stop` | Vec3 | Port box corners. Waveguide ports: opposite corners of the guide cross-section; the excitation plane is at `start`, the mode probes at `stop` along `direction` |
| `mode`, `a`, `b`, `f_cutoff` | string, number, number, number | Waveguide ports only: the mode (`"TE10"`), broad wall `a` along axis (n+1)%3 and narrow wall `b` along (n+2)%3 in drawing units, and the mode cutoff in Hz |
| `eps_r`, `mu_r` | number? | Waveguide ports with a filled reference only (a Python model's `waveguide_port(..., eps_r=, mu_r=)`, see below); absent for the air reference |
| `excite` | boolean | Whether this port is driven, as declared by the model. Multi-port runs rebuild the model once per excited port and override this (see [Multi-port runs](#multi-port-runs)); the bundle records the first run's setup |
| `group` | object, optional | Lumped ports only: `connection` (`"parallel"` or `"series"`), `members` (1–15 additional `{start, stop, direction, polarity?}` feeds), optional nonnegative integer `priority` (default 5). Member polarity is +1 (default) or −1; the main port is the first positive feed |

**Grouped ports.** This additive field preserves one logical port with N physical resistive feeds.
`R` and the result key refer to the logical mode. For signed member signals sᵢUᵢ, sᵢIᵢ,
Parallel reports U = ΣsᵢUᵢ/N and I = ΣsᵢIᵢ, with member resistance N·R; Series reports
U = ΣsᵢUᵢ and I = ΣsᵢIᵢ/N, with member resistance R/N. Sources excite all members of the
selected port, with signs and gap-length normalization. The existing incident/reflected-wave
and S-matrix fields use these modal signals. Orthogonal modes are excluded from modal power;
the physical power sum can differ when members are imbalanced. Absence of `group` keeps the
ordinary port behavior. Malformed groups are refused on reopen instead of losing members.

**Waveguide ports.** The port excites one TE_mn mode with its analytic field profile and measures
the mode voltage and current by projecting E and H in the probe plane onto the mode functions. The
reference impedance is the frequency-dependent TE wave impedance Z_TE = η0 k / β = η0 / √(1 − (f_c/f)²),
so `u_inc`, `u_ref` split the probe signals into forward and backward waves and S11 = u_ref / u_inc is
the ratio of reflected to incident mode amplitude.
`results.ports[k].z_ref` is Z_TE at the band center and `z_ref_f` holds it per frequency; there are
no time `signals` (they need a scalar reference). Terminate the guide behind the port in a PML (run
it through the boundary, `auto_mesh(pad=[…, 0, …])`) so the backward wave is absorbed.
`python/examples/waveguide_thru.py` checks the implementation (docs/VALIDATION.md section 13).
A Python model of a guide homogeneously filled with a real, nondispersive ε_r, μ_r can pass them to
`Simulation.waveguide_port(..., eps_r=, mu_r=)`. The port then uses β = √(k0² ε_r μ_r − k_c²) and
Z_TE = η0 μ_r k0 / β, `R`, `f_cutoff`, `z_ref` and `z_ref_f` are those of the filled guide, and the
port entry records `eps_r` and `mu_r` (both absent for the air reference). Designs always use the
air reference.

**Waveguide port power.** openEMS' mode-matching probes read the power of the mode low, by an
amount set by the size of the mesh cells next to the guide walls (first order in that size: 4.3 %
for the horn's WR-90 feed at 20 cells/λ, 8.6 % at 30, the same at every frequency): the template is
normalized over the full node areas, but a node on a PEC wall carries half the air field.
`Simulation.evaluate` computes the deficit from the mesh lines (`fairbeam.wgport`, the probe
projection applied to the ideal mode on the Yee lattice) and multiplies the port's U and I by the
square root of the factor, so `pacc_w`, the incident and reflected power and the efficiency are
the mode's power. S11, Z_in and the S-parameters (ratios) do not change, except that in a
multi-port run the amplitudes of ports with different wall cells now carry their own factors.
The factor is stored as `results.ports[k].probe_power_factor`; `sim.wg_probe_correction = False`
switches it off. Verified for TE10 against the exact flux through the guide; it is not applied
when the probe box does not describe a closed guide (factor outside 0.9-1.3).

**Guides sharing a wall.** Where two guides are separated only by a zero-thickness PEC sheet
(e.g. a branch-guide coupler), the probe nodes on that sheet interpolate the fields of both guides,
so the neighbouring guide leaks into the port's U and I. `fairbeam.wgport.inset_mode_probes(port,
cells=1)` (opt-in, rectangular TE10 ports on a Cartesian mesh) moves only the E/H probe boxes
`cells` mesh intervals in from both broad walls; the excitation, mode origin, port corners and
measurement plane stay where they are, and the power factor above is computed for the inset
probes (TE10 is uniform along b). Call it on every port of the S-matrix after the mesh is final.
Without it the probes span the full guide, as before.

## lumped_elements

Written by `Simulation.lumped_element(...)` and its shortcuts `lumped_resistor(...)`,
`lumped_inductor(...)` and `lumped_capacitor(...)` (a Design's resistors/RLC loads use the same
call). The element is an openEMS `LumpedElement` spread over the box `start`..`stop`, with current
along `direction`. It is not a part (it is excluded from `parts`) and not a port.

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | CSXCAD property name |
| `label` | string | Display label |
| `type` | string | `"resistor"` (R alone) or `"rlc"` (any element with L or C, including a single L or C) |
| `R`, `L`, `C` | number? | Resistance in Ω, inductance in H, capacitance in F; only the given branches are present |
| `topology` | string | `"parallel"` (native LEtype 0) or `"series"` (LEtype 1); `lumped_resistor`, `lumped_inductor` and `lumped_capacitor` write `"parallel"` |
| `direction` | string | `"x"`, `"y"` or `"z"` |
| `start`, `stop` | Vec3 | Box corners (usually a sheet bridging a gap) |

The combined native series element has not passed its ideal-circuit check
([rf-rlc-workflows](benchmarks/rf-rlc-workflows/README.md)); a series LC built from a separate
`lumped_inductor` and `lumped_capacitor` connected geometrically in series is the alternative.

## Half space and mirror planes

**`half_space`.** When the `z-` boundary is PEC, the bundle carries:

```json
{"axis": "z", "side": "min", "position": <first z mesh line>, "kind": "PEC"}
```

This means the physical problem is the half space `z ≥ position` above an **infinite** PEC ground plane (image theory). The ground is not a part in `parts`. The viewer draws it as a ground plane. The far-field surface and polar cuts show only θ ≤ 90°, because directions below the ground do not exist physically. For any other boundary setup, `half_space` is `null`. Only the `z-` PEC case is currently encoded here.

**`mirror_planes`** (per far-field entry) is the number of PEC or PMC boundaries, on any face. openEMS mirrors the NF2FF recording surface at such boundaries and integrates the image as well. The raw `Prad` therefore covers the full image space, and the `Dmax` derived from it is too low by the same factor. Fairbeam corrects both by `2^mirror_planes`:

```
prad_w   = Prad_openEMS / 2^m
Dmax     = Dmax_openEMS · 2^m
```

so directivity, efficiency and gain refer to the physical half space (or quarter space when m = 2, and so on).

## mesh

| Field | Type | Description |
| --- | --- | --- |
| `x`, `y`, `z` | number[] | Mesh line coordinates, sorted, in drawing units |
| `cells` | [nx, ny, nz] | Cells per axis (lines − 1) |
| `total_cells` | number | nx · ny · nz |
| `min_cell`, `max_cell` | number | Smallest and largest cell width over all axes. The smallest cell sets the FDTD timestep |
| `auto` | object? | Present when the model used `Simulation.auto_mesh()`: the settings and report (cells, min/max cell, neighbor ratio, timestep and memory estimates, warnings). See [MESHING.md](MESHING.md#report) |

## run

Statistics parsed from openEMS' captured stdout/stderr. `null` if the model was not simulated. Fields marked `?` are absent if the pattern was not found in the log.

| Field | Type | Description |
| --- | --- | --- |
| `grid` | Vec3? | FDTD grid size reported by openEMS |
| `timesteps` | number? | Timesteps run |
| `solver_time_s` | number? | Solver time reported by openEMS, in s |
| `timestep_s` | number? | FDTD timestep reported by openEMS, in s |
| `excitation_timesteps` | number? | Timesteps the custom (Gaussian-derivative) excitation pulse lasts: a run cannot converge before it has ended |
| `wall_time_s` | number | Wall time of `Simulation.run`, including setup |
| `speed_mcells_s` | number? | Throughput in MCells/s |
| `energy_trace` | `{timestep, db}[]` | Field energy relative to its maximum, in dB (≤ 0), as printed during the run |
| `final_energy_db` | number? | Last value of `energy_trace`, when that sample is the final energy (logged at the last timestep, at or below the criterion, or the run hit the timestep limit) |
| `final_energy_bound_db` | number? | Present instead of `final_energy_db` for a converged run whose last energy line (if any) predates the stop: openEMS prints one only every ~4 s of wall time (the GPU engine every few thousand timesteps), and a run that stopped before `max_timesteps` stopped because the energy reached the end criterion. The final energy is at most this value, the criterion. Bundles written before Fairbeam handled this may carry the stale sample as `final_energy_db`; the viewer recognizes it (`energy_trace` ends before `timesteps` above the criterion) |
| `hit_timestep_limit` | boolean | `timesteps ≥ max_timesteps` (or openEMS printed its limit warning, which it only does for its own Gaussian excitation) |
| `converged` | boolean | `timesteps < max_timesteps`: a run can only stop early through the energy end criterion |
| `threads` | number | Requested thread count (0 = all cores) |
| `engine`, `engine_requested` | `"cpu"` \| `"gpu"` | The engine that ran and the one asked for (`--engine`). They differ when the openEMS build has no GPU engine. Absent in older bundles, which ran on the CPU |
| `engine_warning` | string? | Present when the GPU engine was requested but the run used the CPU |
| `exact_endcriteria` | boolean? | Whether the end criterion was checked every Nyquist period (the default) rather than every ~4 s of wall time (`--no-exact`) |
| `host` | `{os, machine, cpu}` | Platform info. `cpu` may be `null` |
| `log_tail` | string[] | Last 12 lines of the openEMS log |
| `port_runs` | PortRun[]? | Multi-port runs only: one entry `{port, timesteps, solver_time_s, wall_time_s, final_energy_db, converged, engine}` (plus `final_energy_bound_db` when set) per excited port. The other `run` fields describe the first run; `converged` is true only if every run converged |
| `wall_time_total_s` | number? | Wall time of all runs of a multi-port simulation, in s |
| `efficiency_time_s` | number? | Post-processing time of the efficiency over the band (first run), in s. Present only with `results.efficiency` |

## results

`null` if the model was not simulated.

| Field | Type | Description |
| --- | --- | --- |
| `frequency` | number[] | `--points` frequencies (default 801), linear from `f_min` to `f_max`, in Hz |
| `ports` | object | Keyed by port number as a string (`"1"`). See below |
| `bands` | Band[] | Matched bands of the excited port |
| `farfield` | FarField[] | One entry per pattern frequency |
| `signals` | object | Time signals of the excited port, or `{}` |
| `sparams` | object? | N-port S-matrix. See [sparams](#sparams) |
| `element_patterns` | object? | Complex embedded element patterns of multi-port antennas. See [element_patterns](#element_patterns) |
| `efficiency` | EfficiencySweep[]? | Radiation efficiency over the band (`fairbeam run --efficiency`, a design's `monitors.efficiency`). See [efficiency](#efficiency) |

If no port is excited, `bands` and `farfield` are empty and `signals` is `{}`. For multi-port runs,
`ports`, `bands` and `signals` refer to the first excited port. `ports` holds only driven ports,
each with its own reflection from the run in which it was driven.

**`ports[k]`.** All arrays are aligned with `frequency`.

| Field | Type | Description |
| --- | --- | --- |
| `s11_re`, `s11_im` | number[] | Reflection coefficient `u_ref / u_inc` (complex, linear) |
| `zin_re`, `zin_im` | number[] | Input impedance `u_tot / i_tot` in Ω |
| `z_ref` | number | Reference impedance in Ω (waveguide ports: Z_TE at the band center) |
| `z_ref_f` | number[]? | Waveguide ports only: the frequency-dependent reference impedance S11 refers to, in Ω |
| `probe_power_factor` | number? | Waveguide ports only: the factor the port's incident, reflected and accepted power were multiplied by ([Waveguide port power](#ports)); absent when it was not applied |

**Band.** A band is a contiguous run of frequency samples with 20·log10|S11| < -10 dB.

| Field | Type | Description |
| --- | --- | --- |
| `f_lo`, `f_hi` | number | First and last sample below the threshold, in Hz |
| `f_center` | number | Frequency of minimum S11 within the band, in Hz. The app shows it as the band's "Best match"; its band "Center" is (f_lo + f_hi) / 2 ([RESULTS.md](RESULTS.md)) |
| `s11_min_db` | number | Minimum S11 in dB |
| `fractional_bw` | number | `(f_hi − f_lo) / f_center` |
| `edge_lo`, `edge_hi` | boolean | The band touches the start or end of the simulated range, so its true edge lies outside it |

The JSON band fields retain their original meanings. In the [CSV export](EXPORTS.md#matched-band-csv-columns),
`f_center_GHz` is the middle of the edges, `f_best_GHz` is the JSON `f_center`, and
`fractional_bw` divides by the middle; `edge_lo` and `edge_hi` retain the open-edge flags.

**FarField.** The pattern frequencies are the bands' `f_center` values, the frequency of minimum S11 in each band (at most 4). If there are no bands, the frequency of minimum S11 is used. A model can choose its own (`sim.pattern_freqs`, e.g. the band edges and center of a broadband horn). `--pattern` overrides all of these.

| Field | Type | Description |
| --- | --- | --- |
| `f` | number | Frequency in Hz |
| `theta` | number[] | θ in degrees: 0 to 180 in 3° steps (61 values) |
| `phi` | number[] | φ in degrees: 0 to 355 in 5° steps (72 values; 360 is not repeated) |
| `directivity_dbi` | number[][] | Directivity in dBi, indexed **`[theta][phi]`** (shape `len(theta) × len(phi)`). Floored at `dmax_dbi − 60` |
| `dmax_dbi` | number | Maximum directivity in dBi, mirror-corrected |
| `dmax_pattern_dbi` | number? | Maximum directivity from the pattern alone, `4π·U_max / ∮U dΩ` over the θ/φ grid, mirror-corrected. openEMS' `dmax_dbi` divides by the power flowing through the NF2FF box instead. The two should agree within ~0.1 dB; a larger gap points at boundary reflections (MUR too close) or a coarse NF2FF surface. Absent in older bundles |
| `prad_w` | number | Radiated power in W, mirror-corrected |
| `pacc_w` | number | Power accepted at the port, `½·Re(u·i*)` interpolated at `f`, in W |
| `rad_efficiency` | number \| null | `prad_w / pacc_w`. `null` if `pacc_w ≤ 0`. Above 1 is unphysical for a passive antenna (the two powers come from independent numerical measurements); the value is kept and flagged in `qa_warnings`. For a model marked lossless (see below) 1 while `prad_w / pacc_w` is within 5 % of 1 |
| `rad_efficiency_raw` | number \| null? | Lossless models only: the measured `prad_w / pacc_w`, the power balance of the two numerical measurements |
| `qa_warnings` | string[]? | Exporter QA notes for this entry, e.g. a radiation efficiency above 100 % (gain then exceeds Dmax by the same factor), or a lossless model's power balance |
| `gain_dbi` | number? | `10·log10(efficiency · Dmax)`. Present only if efficiency > 0 |
| `realized_gain_dbi` | number? | `10·log10(efficiency · Dmax · (1 − \|S11\|²))`. Present only if efficiency > 0 |
| `mirror_planes` | number | Number of PEC/PMC boundaries used for the correction. See above |
| `port` | number? | Port that was driven for this entry (bundles since multi-port support). Multi-port runs have one entry per excited port and pattern frequency, all at the same frequencies |
| `cp` | object? | Circular polarisation, for models that set `sim.cp_outputs = True`. See below |

**cp.** With the IEEE convention and openEMS' e^{jωt} phasors, the right- and left-hand circular
components of the far field are E_R = (E_θ + jE_φ)/√2 and E_L = (E_θ − jE_φ)/√2 (for a wave along +z,
RHCP rotates from x to y). Grids are indexed `[theta][phi]` like `directivity_dbi`.

| Field | Type | Description |
| --- | --- | --- |
| `rhcp_dbi`, `lhcp_dbi` | number[][] | Partial directivities D·\|E_R\|²/\|E\|² and D·\|E_L\|²/\|E\|² in dBi (they add up to `directivity_dbi` in linear units), floored at `dmax_dbi − 60` |
| `axial_ratio_db` | number[][] | Axial ratio (\|E_R\| + \|E_L\|) / \|\|E_R\| − \|E_L\|\| in dB: 0 = circular, capped at 60 dB (linear) |
| `peak` | object | `{theta, phi, rhcp_dbi, lhcp_dbi, axial_ratio_db}` at the directivity maximum |
| `boresight` | object | `{theta: 0, rhcp_dbi, lhcp_dbi, axial_ratio_db}` at θ = 0 |

The pattern CSV export adds `rhcp_dBi`, `lhcp_dBi` and `axial_ratio_dB` columns and the far-field
CSV the boresight values.

`prad_w` and `pacc_w` are absolute values for the unit-amplitude excitation. They are typically very small numbers, and only their ratio is meaningful.

**Lossless models.** A model with no loss mechanism at all (PEC metals, loss-free materials, no
resistors) radiates everything it accepts, so its radiation efficiency is 1 and `prad_w / pacc_w`
only measures how well the two numerical powers agree. A Python model says so with
`sim.lossless = True` (the pyramidal horn does); `evaluate()` checks the claim (a lossy material or
a resistor voids it, with a warning) and then reports `rad_efficiency` 1, gain = directivity, while
the measured ratio is within 5 % of 1, keeping it in `rad_efficiency_raw` and a note; beyond 5 %
the measured value is reported with a warning. `prad_w` and `pacc_w` are never altered. The horn
read Prad / Pacc 1.037 at cpw 20 and 1.08 at cpw 30. The NF2FF box was not the cause: an
exact Poynting flux (raw E and H on the Yee lattice) through the feed guide, the five-face box and
planes across the horn agree to 0.1-0.4 %, whereas the waveguide port's mode-matching probes read
the guide power 4.3 % (cpw 20) and 8.6 % (cpw 30) low. The earlier "box +2.4 % / +5.8 % against the
feed flux" compared with a node-interpolated flux, which has the same deficit at the metal walls.
`Simulation.evaluate` now calibrates the waveguide port (below, `probe_power_factor`); the horn's
Prad / Pacc is 0.992-0.995 (cpw 20) and 0.995-0.998 (cpw 30), and the 5 % rule above is kept as a
guard. The diagnosis also found a mesh bug: polyhedron vertices, which CSXCAD stores in single
precision, put a mesh line at y = 5.0799999 instead of the wall at 5.08, so the edges on it were not
metal and the guide was a cell too tall (E_z at 6 % of E_y in the guide; fairbeam.automesh now
snaps such coordinates back).

### efficiency

**EfficiencySweep.** Optional (absent unless requested): the radiation efficiency as a 1D result
over frequency. The NF2FF box records time-domain dumps, so after the
run openEMS transforms them at `N` frequencies spread evenly from `f_min` to `f_max` (default 21,
3 to 201). Only the powers are kept, no patterns. One entry per driven port, with `port` set as for
`farfield[].port` (a 1-port run has one entry).

| Field | Type | Description |
| --- | --- | --- |
| `port` | number? | Port that was driven |
| `f` | number[] | Frequencies in Hz, `linspace(f_min, f_max, N)` |
| `prad_w` | number[] | Radiated power in W, mirror-corrected as for `farfield` (divided by 2^`mirror_planes`) |
| `pacc_w` | number[] | Power accepted at the port, `½·Re(u·i*)` interpolated at each `f`, in W |
| `rad_efficiency` | (number \| null)[] | `prad_w / pacc_w`, 4 decimals; `null` where `pacc_w ≤ 0`. Values above 1 are kept, as for `farfield`; a lossless model reports 1 within 5 %, as there |
| `rad_efficiency_raw` | (number \| null)[]? | Lossless models only: the measured `prad_w / pacc_w` |
| `pacc_error` | (number \| null)[]? | Estimated relative error of `pacc_w` from where the run stopped (below). `null` where `pacc_w ≤ 0` |
| `reliable` | boolean[]? | `false` where `pacc_error` exceeds 0.1 (10 %) or `pacc_w ≤ 0`: the value is kept, but it is not trustworthy. The viewer leaves these out of the curves and draws them as flagged points. Absent in older bundles (every value counts as reliable) |
| `mirror_planes` | number | PEC/PMC boundaries used for the correction |
| `theta_step`, `phi_step` | number | Angular grid of the transform in degrees (90 and 180: θ 0/90/180, φ 0/180). openEMS' Prad is the Poynting flux through the NF2FF box surface and does not depend on this grid (bit-identical from 3°/5° to 90°/180° on the patch example, and at all 11 frequencies across the patch starter's band), so the coarsest grid is used; it only sets the cost |
| `qa_warnings` | string[]? | Summary notes: the frequencies marked unreliable, and reliable ones whose efficiency exceeds 1 |

Total efficiency is `rad_efficiency · (1 − |S11|²)` with S11 from `ports[port]` at `f` (interpolated
on `frequency`). At a pattern frequency the sweep's Prad equals `farfield[].prad_w`.

**Reliability.** Away from the match the port reflects almost all of the incident power, and
`pacc_w` = P_inc (1 − |S11|²) is a small difference of two large numbers. Stopping the run at the end
criterion truncates the ring-down of the port signals, which leaves an error of about the same
absolute size at every frequency; relative to a small `pacc_w` it is large, and the ratio zig-zags.
`pacc_error` estimates it as the change of ½·Re(U·I*) when the last tenth of the ring-down (after the
excitation pulse) is left out of the DFT; while the signals decay, what the run did not record is of
that order or smaller. Measured on the patch starter (11 frequencies, 1.47–3.19 GHz, GPU):

| End criterion | Radiation efficiency over the band | Reliable |
| --- | --- | --- |
| −50 dB | 15, 33, 44, 52, 68, 62, 69, 61, **85, 53, 69** % | 7 of 11 (the last 4 not) |
| −60 dB | 17, 32, 46, 56, 63, 66, 68, 70, **71, 70, 68** % | 8 of 11 |
| −70 dB | 17, 31, 44, 55, 61, 66, 67, 66, 67, 65, 63 % | 11 of 11 |

Prad moved by at most a few % between the three runs, `pacc_w` by up to 33 % above resonance (where
1 − |S11|² is 3 to 4 % and the excitation spectrum is weakest). The estimate was 2–51 % at −50 dB
against 0.4–24 % actual and 0.2–20 % at −60 dB against 0.1–7 % (the actual taken against the −70 dB
run), so it errs on the safe side. The NF2FF angular grid (90°/180° against 5°/10°: identical Prad)
and the dump sampling (every Nyquist/4 = 37 timesteps, 8 samples per period at `f_max`, as for the
port probes) are not the cause. The truncation error of Prad (a few %) is not included.

**signals.** Port time signals, downsampled by a constant stride to at most about 1500 points.

| Field | Type | Description |
| --- | --- | --- |
| `time_ns` | number[] | Time in ns |
| `u_inc`, `u_ref`, `u_tot` | number[] | Incident, reflected and total port voltage in V |
| `i_tot_scaled` | number[] | Total port current multiplied by `z_ref`, in V, so it can share the voltage axis |
| `dt_s` | number \| null | Timestep of the **original** (not downsampled) signal, in s |
| `samples` | number | Sample count of the original signal |

## Multi-port runs

`fairbeam run` (and `sweep`/`converge`) build the model once per excited port inside
`fairbeam.simulation.excite_only(n)`. That run drives port n and leaves every other port in place,
terminated in its resistance. Default: all ports for models with up to 4 ports, otherwise port 1.
`--excite all|1,3` overrides. A 1-port model runs exactly as before, but its bundle also gets a
1 × 1 `sparams`.

### sparams

| Field | Type | Description |
| --- | --- | --- |
| `ports` | number[] | Matrix indices 1..N, in matrix order (model port order) |
| `z_ref` | number[] | Reference impedance of each port in Ω (the lumped port resistance) |
| `excited` | number[] | Indices of the driven ports, which are the known columns |
| `complete` | boolean | Every port was excited, so the full matrix is known |
| `method` | string | `"B A^-1"` (complete) or `"b_i / a_j"` (partial) |
| `s` | object | Keys `"i,j"` = S_ij: wave out of port i per wave into port j. Each value is `{re: number[], im: number[]}` aligned with `frequency`, rounded to 5 decimals. Only columns j in `excited` are present |
| `qa` | object | See below |
| `port_numbers` | number[]? | Present only when the model's port numbers are not 1..N; index k refers to port `port_numbers[k-1]` |

**Definition.** For port i with real reference Z_i, U_i and I_i are the frequency-domain port
voltage and current (current flowing into the structure). The power waves are
`a_i = (U_i + Z_i I_i) / (2 sqrt(Z_i))` and `b_i = (U_i − Z_i I_i) / (2 sqrt(Z_i))`, which are
openEMS' `uf_inc` and `uf_ref` divided by sqrt(Z_i). With the waves of the run that drives port j as
column j of the matrices A and B, the complete matrix is `S = B A^-1` at every frequency. This is
exact even though a terminated FDTD port has a small nonzero incident wave. With a partial
excitation, the known columns are `S_ij = b_i / a_j`. For equal Z_i these are the usual
S-parameters; otherwise they are power-wave S-parameters referenced to each port's own Z_i.
`results.ports[k].s11_*` equals `S_kk` for every driven port k.

**`qa`.**

| Field | Type | Description |
| --- | --- | --- |
| `reciprocity_max` | number \| null | max over frequency and pairs of \|S_ij − S_ji\| (both columns known), linear. FDTD typically gives 1e-4..1e-2 |
| `reciprocity_pairs` | object | The same per pair, keys `"i,j"` with i < j |
| `column_power_max`, `column_power_min` | object | Per driven port j (key `"j"`): max / min over frequency of Σ_i \|S_ij\|². 1 − column power is the fraction dissipated or radiated |
| `passivity_max` | number \| null | Largest column power. It must be ≤ 1 for a passive structure |
| `passive` | boolean | `passivity_max ≤ 1 + passive_tol` |
| `passive_tol` | number | Tolerance, 0.01 |

### element_patterns

Present for antennas (models with an NF2FF box) when several ports are driven, or when
`--element-patterns on` is given. It holds the complex far field of each driven port per unit
incident wave, with all other ports terminated, so mutual coupling is included. See
[ARRAYS.md](ARRAYS.md) for how to combine them.

| Field | Type | Description |
| --- | --- | --- |
| `normalization` | string | Human-readable normalization note |
| `radius_m` | number | Far-field radius of the stored E values, in m (1) |
| `encoding` | string | `"i16le-base64-scaled"` (written since this change) or `"f32le-base64"` (older bundles). Readers accept both; see [Encodings](#element-pattern-encodings) |
| `shape` | [number, number] | `[n_theta, n_phi]` |
| `theta`, `phi` | number[] | Grid in degrees (the far-field grid, possibly decimated) |
| `frequencies` | number[] | Frequencies in Hz, the same as the far-field entries |
| `decimation` | number | Angular decimation factor (1 = full far-field grid). θ = 180° is always kept |
| `mirror_planes` | number | PEC/PMC boundaries. The fields cover the image space; divide sphere integrals by 2^m |
| `phase_center` | Vec3 | Common phase center of all ports (drawing units) |
| `ports` | object[] | One per driven port: `{port, position, fields}`. `position` is the port center (drawing units), used as the element position for steering. `fields` is one `{f, scale, e_theta_re, e_theta_im, e_phi_re, e_phi_im}` per frequency (`scale` only with `"i16le-base64-scaled"`) |

Units: E in V/m (peak phasor) at `radius_m`, for an incident power wave a = U_inc / sqrt(Z_ref) =
1 sqrt(W). Radiation intensity is `U = r² (|E_θ|² + |E_φ|²) / (2 η0)` and incident power is
`½ |a|²`. The array field for weights w_j is `Σ w_j E_j`.

#### Element-pattern encodings

Each of `e_theta_re`, `e_theta_im`, `e_phi_re`, `e_phi_im` is a base64 string of n_θ · n_φ
little-endian values, row-major `[theta][phi]`.

- `"i16le-base64-scaled"` (the writer's default, `python/fairbeam/multiport.py`): signed int16
  q = round(v / `scale` · 32767), and v = q · `scale` / 32767. `scale` is a number in each `fields`
  entry: the largest |value| over that entry's four arrays (one scale per port and frequency, so
  E_θ and E_φ share it; `scale` 0 means all zeros). The quantisation step is 1/32767 of the peak
  component, about −90 dB. On the 2×1 and 4×1 patch arrays this changes synthesized directivity by
  at most 0.01 dB where D > Dmax − 50 dB, for uniform, steered (0°, 30°, 60°) and tapered weights,
  with the same beam direction and HPBW within 0.003°.
- `"f32le-base64"` (bundles written before): float32, no `scale`. Twice the size; float32 noise
  hardly compresses, so gzip gains almost nothing on either form.

The viewer (`src/lib/sparams.ts`) and `fairbeam.array` read both. Non-finite far fields are
written as `"f32le-base64"`. `fairbeam.multiport.reencode_element_patterns(bundle)` converts an
older bundle in place without touching anything else.

## fields

Optional; present only for runs with `fairbeam run --fields` (`python/fairbeam/fields.py`). For every plane
that holds zero-thickness metal (a box sheet or a polygon; at most 4 planes, smallest first), openEMS
records a frequency-domain **rot(H)** dump exactly on the sheet's mesh plane. On a PEC sheet the in-plane
components equal the surface current density divided by the constant normal dual-cell width, so the stored
map is the **surface current magnitude |J_s|**, up to one
constant per plane. It is resampled from the FDTD mesh onto a regular grid and normalized per plane and
frequency.

| Field | Type | Description |
| --- | --- | --- |
| `quantity` | string | `"surface_current"` |
| `definition` | string | Human-readable definition |
| `units` | string | Normalization note: 1000 = maximum over the metal of the plane at that frequency, -1 = no metal |
| `phase_version` | number | `1` identifies the optional signed-int8 complex-current payload format described below. Older readers may ignore the additional `phasors` field; bundles without `phase_version` retain their original magnitude-only meaning |
| `port` | number? | Number of the port driven in the run that recorded the maps. The maps come from **one** excitation: a multi-port run (one openEMS run per excited port) records them in the first excited port's run only, with the other ports terminated; there are no per-port maps. Absent when no single driven port is known and in bundles written before it was added. The viewer then falls back to the one port flagged `excite` in `ports` (that list comes from the same build that recorded the maps) and otherwise shows the excitation as unknown, never as port 1 |
| `planes` | FieldPlane[] | See below |

**FieldPlane**

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Dump name (`fairbeam_J_<axis><i>`) |
| `parts` | string[] | Metal parts with sheets in this plane |
| `axis`, `position` | number | Normal axis index and plane coordinate (drawing units) |
| `u_axis`, `v_axis` | number | In-plane axes, `(axis + 1) % 3` and `(axis + 2) % 3` (same convention as polygons) |
| `u_range`, `v_range` | [number, number] | Extent of the metal in the plane; the first and last samples lie on these values |
| `nu`, `nv` | number | Samples along u and v (at most 100 along the longer side) |
| `frequencies` | FieldFrequency[] | One entry per far-field frequency |

**FieldFrequency**

| Field | Type | Description |
| --- | --- | --- |
| `f` | number | Frequency actually dumped (Hz). Without explicit `--fields` frequencies a grid with ~0.5 % steps is dumped and the nearest sample is used |
| `f_target` | number | Far-field frequency this map belongs to (Hz) |
| `values` | number[] | `nv · nu` integers, row-major with v as the row index (`values[j * nu + i]` is at `u_range[0] + i·Δu`, `v_range[0] + j·Δv`). 0..1000 = \|J_s\| / max (linear, phasor magnitude); -1 = outside the metal (exact primitives, not the staircase) |
| `phasors` | string | With `phase_version: 1`, base64 bytes of signed int8 samples, four per pixel in `[Ju.re, Ju.im, Jv.re, Jv.im]` order. Pixels use the same v-row/u-column order and in-plane axes as `values`. Each component is bilinearly resampled as a real or imaginary scalar before quantisation. For each frequency, `peak` is the same maximum over metal of the resampled vector magnitude used by `values`; each component is `round(127 · component / peak)`, clipped to [-128, 127]. All four bytes are zero outside the exact metal mask. The stored values are relative to `peak`, which is not retained as an absolute current density. The phase convention is `Re{J exp(+j phase)} = re cos(phase) - im sin(phase)`, so at +90° the real current is `-im`. This field is additive: magnitude-only consumers can continue using `values` and ignore `phasors` |

The peak value sits at the metal edges, where the current is singular and only as resolved as the mesh;
compare shapes and relative levels, not the absolute peak.

## field_planes

Optional; present only for runs with field planes (`fairbeam run --field-plane`, a design's
`monitors.field_planes`; `python/fairbeam/field_planes.py`). One entry per plane and frequency.
For each plane openEMS records a frequency-domain **E** (dump type 10) or **H** (type 11) dump with
node interpolation on the mesh line nearest the requested position, across the whole simulation
domain in the plane. The stored map is the phasor magnitude, resampled bilinearly from the FDTD mesh
onto a regular grid (the step of the finest mesh cell in the plane, at most 200 samples along the
longer side) and rounded to 3 significant digits. The complex components are stored beside it as an
optional 8-bit `phasor`.

**Normalization.** openEMS' frequency-domain dumps are the single-sided Fourier transform
`2 Δt Σ f(t) e^(−jωt)`, the same transform as its port voltages. Scaled by `sqrt(1 W / P_inc(f))`,
with `P_inc = |u_inc|² / (2 Re Z_ref)` of the driven port, they become the **peak phasor amplitude
for 1 W incident (stimulated) power** at the driven port. Without a single driven port they stay the
raw transform (`unit: "arb."`, `normalization: "none"`). The maps come from one excitation, as for
[fields](#fields): a multi-port run records them in the first excited port's run only.

**FieldPlaneMap**

| Field | Type | Description |
| --- | --- | --- |
| `quantity` | string | `"E"` or `"H"` |
| `component` | string | `"abs"`: sqrt(\|Fx\|² + \|Fy\|² + \|Fz\|²); `"x"`, `"y"`, `"z"`: the magnitude of that component |
| `normal`, `axis` | string, number | Plane normal (`"x"`, `"y"`, `"z"`) and its axis index |
| `u_axis`, `v_axis` | number | In-plane axes, `(axis + 1) % 3` and `(axis + 2) % 3` (as for [fields](#fields)) |
| `position_mm` | number | Coordinate of the mesh line the map was recorded on (drawing units) |
| `requested_mm` | number | Position asked for; outside the domain it is recorded at the domain's edge |
| `f` | number | Frequency (Hz) |
| `u_range`, `v_range` | [number, number] | Extent (the domain in the plane); the first and last samples lie on these values |
| `nu`, `nv` | number | Samples along u and v |
| `unit` | string | `"V/m"` (E) or `"A/m"` (H) when normalized, else `"arb."` |
| `normalization` | string | Human-readable normalization, `"none"` without a driven port |
| `max` | number | Largest value of the map (4 significant digits) |
| `magnitude` | number[][] | `nv` rows of `nu` values: `magnitude[j][i]` is at `u_range[0] + i·Δu`, `v_range[0] + j·Δv` |
| `port` | number? | Number of the driven port (absent when unknown) |
| `phasor` | FieldPlanePhasor? | The complex components behind the map, for its phase and the field over one period. Absent in bundles written before it existed, or when the field is zero: viewers then show the magnitude only |

**FieldPlanePhasor** (optional). The complex components of the same resampled `nu × nv` grid, so a
viewer can show the phase and the instantaneous field `Re{F e^(jωt)}` over one period (the designer's
2D field map tab and the 3D view animate it).

| Field | Type | Description |
| --- | --- | --- |
| `components` | string[] | `["x","y","z"]` for `component: "abs"`, else the one stored component, e.g. `["z"]` |
| `peak` | number | Largest magnitude of any stored component (4 significant digits), in the map's `unit`; the int8 full scale |
| `data` | string | Base64 of signed 8-bit integers, row-major with v as the row: `[v][u][component][re, im]`, `nv · nu · len(components) · 2` bytes. Value = `int / 127 · peak`, so the resolution is `peak / 127` (0.8 % of the peak), coarser than `magnitude`; phase is only meaningful where the magnitude is well above that step |

The values are scaled like `magnitude` (1 W incident power) and, with a driven port, turned by the
phase of its incident voltage wave (`× conj(u_inc) / |u_inc|`): phase 0 is that wave at `t = 0`, not
the arbitrary time origin of the excitation pulse. Without a driven port (`normalization: "none"`)
the phase is that of the raw transform and has no physical reference. The time convention is
`e^(+jωt)`: the field at phase `φ` is `Re{F e^(jφ)}`.

Size: about 80 kB of JSON per 106 × 106 map, about 150 kB at the 200-sample cap; with the design
limits (4 planes × 4 frequencies) at most about 2.5 MB. The phasor adds 6 bytes per pixel for `abs`
maps (2 for a single component) as base64: about 90 kB at 106 × 106 (`abs`), 320 kB at 200 × 200,
so at most about 5 MB more for 16 full-size `abs` maps. Caveats: with node interpolation the
normal E component right at a metal sheet or a dielectric interface is averaged over the two
neighboring cells, so put the plane a cell away for clean fringing fields; the outer cells of a PML
boundary hold absorbed, non-physical fields.

## Index file

`public/projects/index.json` is rebuilt after every write, or by `fairbeam index [folder]`. It covers every `*.json` in the folder (except itself) whose `schema` starts with `fairbeam.project/`. Entries are sorted by model id, then name.

```json
{
  "projects": [
    {"file": "patch-antenna.json", "name": "Rectangular patch antenna", "model": "patch-antenna",
     "created": "2026-09-24T22:24:15+0300", "simulated": true, "bands": [2.433], "cells": 97152}
  ],
  "updated": "2026-09-24T22:25:42+0300"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `file` | string | Bundle file name, relative to the index |
| `name`, `model`, `created` | string | Copied from the bundle (`model` is `model.id`) |
| `simulated` | boolean | `results` is present |
| `bands` | number[] | Each band's `f_center` (the frequency of minimum S11) in **GHz**, 3 decimals |
| `band_ranges` | object[]? | Each band's edges in **GHz** (4 decimals) and whether it touches the simulated range: `{lo, hi, edge_lo, edge_hi}`. The example picker shows a band by the middle of its edges, or by its range when it touches the simulated range. Absent when there are no bands, and in older indexes (the picker then shows `bands`) |
| `cells` | number | `mesh.total_cells` |
| `engine` | string? | `"CPU"`, `"Metal"`, `"CUDA"` or `"GPU"`: what ran the simulation (from `run.engine` and the log). Absent without a run |
| `params` | object? | The model parameters set to something other than their default, `{key: value}`. Absent when there are none |

## Versioning

Adding optional fields does not change the schema id: `lumped_elements`, `results.sparams`,
`results.element_patterns`, `farfield[].port`, `run.port_runs`, `fields.port`, `results.efficiency`, `run.efficiency_time_s`, `run.engine` / `engine_requested` / `exact_endcriteria`, `field_planes`, `efficiency[].pacc_error` / `reliable`, `rad_efficiency_raw` and `parts[].conductor` and `parts[].void` were added this way. Removing or renaming fields, or changing units or indexing, bumps it to `fairbeam.project/2`. When the schema changes, `src/types.ts` changes in the same commit.
