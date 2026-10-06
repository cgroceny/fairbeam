# Writing models

## Model files

A model is a plain Python file that defines three things:

- `MODEL`: a dict with `id`, `name`, `description` and optionally `reference`.
- `PARAMS`: a list of `fairbeam.Param(key, default, label, unit, description, minimum, maximum)`. The type of `default` sets how `--set` values are parsed (int, float or str).
- `build(p: dict) -> Simulation`: receives the resolved parameter values and returns a fully configured `fairbeam.Simulation` with geometry, ports, mesh and (optionally) an NF2FF box.

**Meshing**: call `sim.auto_mesh()` after the geometry and ports (and before `add_nf2ff_box`) to generate the whole mesh from the geometry: thirds rule at metal edges, fine cells across narrow strips, dielectric layers resolved, graded air and λ/4 padding. It matches the converged hand-tuned meshes to 0.1 % (see [MESHING.md](MESHING.md)). The editor templates use it.

`Simulation` wraps the usual openEMS/CSXCAD objects (`sim.fdtd`, `sim.csx`, `sim.mesh`). You can use the normal CSXCAD calls. The helpers `metal`, `dielectric`, `lumped_port`, `waveguide_port`, `lumped_resistor` (and `lumped_element`, `lumped_inductor`, `lumped_capacitor` for ideal R/L/C, see [BUNDLE.md](BUNDLE.md#lumped_elements)), `add_nf2ff_box`, `smooth_mesh` and `set_focus` also record the metadata the viewer and the VBA macro exporter need (loss tangent, port definitions, phase center, default framing). `sim.metal(name)` is a perfect conductor; `sim.metal(name, conductivity=5.8e7, thickness=0.035)` (S/m, mm) is a lossy metal: sheets become openEMS conducting sheets of that thickness and volumes a material of that conductivity.

A model can also be a designer file (`<id>.design.json`, see [DESIGNER.md](DESIGNER.md#files)): `fairbeam run`, `params`, `geometry`, `sweep`, `converge` and `optimize` take it in place of a `.py` file, and `examples/designs/` holds ready-made ones. The Start screen creates new designs from starters (empty project, half-wave dipole, quarter-wave monopole, open-ended waveguide, patch, printed sleeve dipole, microstrip line).

```python
# minimal strip dipole (the shipped python/models/dipole.py adds PML, thirds-rule edges and a finer
# mesh around the strip; this bare version resonates ~8 % low, see docs/VALIDATION.md)
from fairbeam import Param, Simulation

MODEL = {"id": "dipole", "name": "Half-wave dipole",
         "description": "Thin-strip dipole with a centre lumped feed."}

PARAMS = [
    Param("length", 58.0, "Total length", "mm", minimum=5),
    Param("width", 1.0, "Strip width", "mm", minimum=0.1),
    Param("gap", 1.0, "Feed gap", "mm", minimum=0.2),
    Param("f_min", 1.5, "Band start", "GHz", minimum=0.1),
    Param("f_max", 3.5, "Band stop", "GHz", minimum=0.2),
]


def build(p: dict) -> Simulation:
    sim = Simulation(p["f_min"] * 1e9, p["f_max"] * 1e9)      # MUR boundaries, DC-free pulse
    L, w, g = p["length"], p["width"], p["gap"]
    arm = sim.metal("dipole", label="Dipole arms")
    arm.AddBox(priority=10, start=[-w / 2, 0, g / 2], stop=[w / 2, 0, L / 2])
    arm.AddBox(priority=10, start=[-w / 2, 0, -L / 2], stop=[w / 2, 0, -g / 2])
    sim.lumped_port(1, 73, [-w / 2, 0, -g / 2], [w / 2, 0, g / 2], "z")

    sim.mesh.AddLine("x", [-80, -w / 2, w / 2, 80])
    sim.mesh.AddLine("y", [-80, 0, 80])
    sim.mesh.AddLine("z", [-100, -L / 2, -g / 2, g / 2, L / 2, 100])
    sim.smooth_mesh()                                           # λ/20 at f_max
    sim.set_focus([-10, -10, -L / 2 - 5], [10, 10, L / 2 + 5])
    sim.add_nf2ff_box(center=[0, 0, 0])
    return sim
```

```bash
fairbeam params python/models/dipole.py
fairbeam run python/models/dipole.py --set length=60
```

Keep at least λ/4 at `f_min` of free space between the structure and absorbing boundaries (PML_8 inside that margin; MUR needs about λ/2). The included models (`python/models/patch_antenna.py`, `python/models/sierpinski_monopole.py`) show edge meshing, dielectrics, PEC ground boundaries and fractal geometry.

## Included models

Every model in `python/models/` has a simulated bundle in `public/projects/` and a validation
section in [VALIDATION.md](VALIDATION.md).

| Model | What it is | Shows | Validation |
| --- | --- | --- | --- |
| `dipole.py` | Half-wave strip dipole, 2.4 GHz | thirds-rule edges, PML, mesh study | §1 |
| `patch_antenna.py` | Rectangular patch, RO4003C, probe feed | dielectric meshing, `--set mesh=auto` | §2 |
| `inset_patch.py` | Inset-fed patch on FR4 | microstrip feed, notches | §2b |
| `minkowski_patch.py` | Minkowski fractal patch | polygon geometry | §2c |
| `sierpinski_monopole.py` | Sierpinski gasket over PEC ground | half space, fractal iterations | §3 |
| `microstrip_line.py` | 50 Ω through line | two-port S-matrix | §7 |
| `wilkinson_divider.py` | Wilkinson divider with isolation resistor | lumped resistor, three ports | §8 |
| `patch_array_2x1.py`, `patch_array_4x1.py` | Patch arrays | embedded element patterns, steering | §9, [ARRAYS.md](ARRAYS.md) |
| `branchline_coupler.py` | 90° hybrid | four ports, `auto_mesh` | §11 |
| `lowpass_stepped.py` | 5th-order stepped-impedance low-pass | narrow lines, `auto_mesh` | §12 |
| `pyramidal_horn.py` | Optimum 16 dBi horn, WR-90, 10 GHz | polyhedron walls, **waveguide port**, NF2FF with a skipped face | §13 |
| `helix_axial.py` | Kraus axial-mode helix, 2.4 GHz | thin-wire `Curve`, **circular-polarisation outputs** | §14 |

## Non-planar geometry, waveguide ports and circular polarisation

- **Slanted solids**: build them as a CSXCAD `Polyhedron` with triangular faces (CSXCAD rasterises
  only triangles correctly; see `slab()` in `pyramidal_horn.py`). The bundle, the viewer and the
  drawing reproduce polyhedra exactly; `auto_mesh` puts lines at every vertex coordinate. Rotated
  primitives (`AddTransform`) simulate fine but are exported only as their bounding box.
- **Thin wires**: a CSXCAD `Curve` (a list of points, no radius) is put on the nearest mesh edges;
  `auto_mesh` covers its extent with half-size cells. Its effective radius is a fraction of a cell,
  so the input impedance depends on the mesh (see §14). A `Wire` (with radius) is rasterised as a
  volume and needs cells smaller than the radius.
- **Waveguide ports**: `sim.waveguide_port(n, start, stop, "z", a, b, "TE10")` spans the guide
  cross-section; the excitation is in the `start` plane and the probes in the `stop` plane. Run the
  guide into a PML behind the port (`auto_mesh(pad=[q, q, q, q, 0, q])` leaves that face on the
  structure) and skip the NF2FF face it crosses (`add_nf2ff_box(directions=[1, 1, 1, 1, 0, 1])`).
  S11 is referred to the TE wave impedance ([BUNDLE.md](BUNDLE.md#ports)). For a guide filled
  across its whole cross-section with one homogeneous, nondispersive material, pass the same values
  to the port (`eps_r=2.08`, `mu_r=1.0`, Python models only): the reference then uses the filled
  guide's β and Z_TE. These keywords only set the reference; draw the material as usual. Without
  them the port keeps the air reference (`python/examples/rectangular_guide_loss.py` uses them).
- **Circular polarisation**: `sim.cp_outputs = True` adds RHCP/LHCP directivity and axial-ratio
  grids to every far field.
- **Pattern frequencies**: `sim.pattern_freqs = [...]` (Hz) replaces the default (band centers), e.g.
  band edges and design frequency for broadband antennas.

## Material library

`fairbeam.materials` holds nominal values of common antenna materials with their source; the
designer's **Material library** dialog (ribbon Modeling tab, Materials group, **Library**) shows the same list
(`src/designer/materials.ts`) and copies an entry's values into the design, so a design file stays
self-contained. In a Python model: `ro = fairbeam.materials.get("ro4003c")`, then
`sim.dielectric("sub", ro["eps_r"], tan_d=ro["tan_d"], tan_d_freq=ro["tan_d_freq"] * 1e9)`.
Laminates vary by batch, thickness and frequency: for a design that matters, use the datasheet of
the laminate you buy. openEMS models loss as a constant conductivity, so tan δ is exact at the
frequency given (empty: the band center). The library's PEC entry is a perfect conductor; to model conductor loss, give a design's metal material a `conductivity` (S/m, empty = PEC) and, for sheets, a `thickness` (mm; default 0.035).

| Material | Kind | εr | tan δ | at | Source and caveats |
| --- | --- | --- | --- | --- | --- |
| PEC (copper) | metal | | | | Perfect electric conductor (openEMS metal). Copper's finite conductivity (5.8e7 S/m) and surface roughness are not modeled; the conductor loss of printed antennas is small. |
| FR4 | dielectric | 4.3 | 0.02 | 1 GHz | Generic glass-epoxy laminate. εr 4.2–4.7 and tan δ 0.015–0.025 vary with the resin content, the supplier and the frequency: use your laminate's datasheet. |
| Rogers RO4003C | dielectric | 3.38 | 0.0027 | 10 GHz | Rogers RO4003C datasheet: process εr 3.38 ± 0.05 and tan δ 0.0027 at 10 GHz, 23 °C (Rogers recommends the design εr 3.55 for circuit design). |
| Rogers RO4350B | dielectric | 3.48 | 0.0037 | 10 GHz | Rogers RO4350B datasheet: process εr 3.48 ± 0.05 and tan δ 0.0037 at 10 GHz, 23 °C (design εr 3.66). |
| Rogers RT/duroid 5880 | dielectric | 2.2 | 0.0009 | 10 GHz | Rogers RT/duroid 5880 datasheet: εr 2.20 ± 0.02 and tan δ 0.0009 at 10 GHz. |
| Taconic TLY-5 | dielectric | 2.2 | 0.0009 | 10 GHz | Taconic (AGC) TLY-5 datasheet: εr 2.20 ± 0.02 and tan δ 0.0009 at 10 GHz. |
| Alumina 99.5 % | dielectric | 9.8 | 0.0001 | 10 GHz | Typical of 99.5 % alumina thin-film substrates (εr 9.7–9.9, tan δ about 0.0001 at microwave frequencies); check the supplier's value. |
| PTFE (Teflon) | dielectric | 2.1 | 0.0002 | 10 GHz | Bulk PTFE, typical: εr 2.0–2.1, tan δ 0.0001–0.0003 from 1 to 10 GHz. |
| Air / vacuum | dielectric | 1 | 0 |  | Free space. The background is vacuum already; use it with a higher priority to cut an air gap or a hole out of another dielectric. |

The designer also has a personal list next to this built-in one, **My materials** (saved from a design's
materials, stored in the workspace's `materials.json`; see [DESIGNER.md](DESIGNER.md#materials-and-parts)).
`fairbeam.usermaterials` validates that file; Python models do not read it, and a design never refers to it.

## Writing models in the app

With `fairbeam serve` running (the desktop app starts it), a Python model opened from Start › Python models has a Run panel with a **Model code** tab: the model file in a code editor (CodeMirror, Python highlighting, search with ⌘F / Ctrl+F). **New** in the Run panel opens the New model dialog, where *Python model* creates the file from a template and *Visual design* creates a `.design.json`.

From Start, **New Python model…** creates the source file, converts its geometry into an editable
Design without running the solver, and opens the Design's Python panel with the saved source code.
Each existing Python model row keeps its Run action and also has **Open as Design**; it reopens the
linked Design when one already exists. If conversion fails, the Python source stays saved and can be
opened in the Run panel's code editor. Editing the source file after conversion is reported in the
Design Python panel, where the code can be reviewed and applied again.

- **New model** (*Python model*) creates `<id>.py` in the models folder (`python/models/` in a checkout, `~/Documents/Fairbeam/models/` in the desktop app) from a template in `python/templates/`:

  | Template | What it shows |
  | --- | --- |
  | `blank.py` | A metal post on a finite ground plane with a lumped port; every section (identity, parameters, solver, geometry, port, mesh, framing) is explained |
  | `dipole.py` | Thin-strip half-wave dipole with a center feed |
  | `monopole_on_ground.py` | Quarter-wave monopole over an infinite ground (PEC half-space boundary) |
  | `patch_probe_fed.py` | Substrate, ground and patch with a probe (lumped) feed |
  | `microstrip_line.py` | A line with lumped ports at both ends. Port 2 is declared `excite=False`, but `fairbeam run` drives every port of a model with up to four (`--excite`, see [MULTIPORT.md](MULTIPORT.md)), so the run gives the two-port S-matrix including S21 |

  The id is the file name (`^[a-z][a-z0-9_]{1,40}$`); an existing file is never overwritten.
- **Save** with ⌘S / Ctrl+S (or "Save and preview"). The server writes the file, loads and builds it (geometry only, like `fairbeam geometry`) and reports the result: the parameter form updates to the new `PARAMS` and the 3D view shows the new geometry. A syntax error or an exception in `build()` is marked at its line in the editor, with the message, the source line and the traceback below.
- **History.** Every save keeps the previous version under `.sim/model-history/<id>/`; the last 20 are listed and can be loaded back into the editor (save to restore).
- **Conflicts.** If the file changed on disk (another editor) since it was opened, saving is refused with "Reload from disk" or "Save anyway".
- The bundled models (every file in the table of included models above) are read-only here; **Duplicate** makes an editable copy.

Model files are plain Python, so you can keep editing them in any editor as well; the app picks up changes when you reselect the model.

Automatic meshing (`sim.auto_mesh()`), its options, rules and validation are described in
[MESHING.md](MESHING.md).
