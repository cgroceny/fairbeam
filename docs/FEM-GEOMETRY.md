# Experimental FEM geometry export

`fairbeam.fem_geometry` is an opt-in, export-only foundation for preparing a small subset of a
Fairbeam design as an Elmer native mesh. It does not dispatch jobs, create a solver input file, run
Elmer, or claim a simulated result. The ordinary openEMS workflow is unchanged.

The converter evaluates a Fairbeam `.design.json` with its parameter overrides before inspecting its
geometry. It accepts non-overlapping, axis-aligned, three-dimensional box volumes with constant,
lossless, isotropic dielectric properties or PEC. It refuses non-box geometry, zero-thickness sheets,
cuts, Boolean history, transforms, overlapping volumes, ports, resistors, lumped elements,
excitations, lossy or dispersive materials, and unsupported material fields. Adjacent boxes may
share a face. Their shared mesh nodes make the interface conforming.

PEC boxes are represented as excluded conductor volumes. The mesher emits no bulk hexahedra inside
them; faces between PEC and the active vacuum/dielectric mesh receive an explicit named boundary tag
such as `PEC_INTERFACE_copper`. This keeps PEC distinct from an ordinary volume dielectric. The
six outer-domain face tags always use IDs 1 through 6 in this order: `x_min`, `x_max`, `y_min`,
`y_max`, `z_min`, `z_max`. Their mesh tags carry identity only; no boundary condition is applied.

## Python API

```python
from fairbeam.fem_geometry import mesh_design, write_elmer_mesh

mesh = mesh_design(
    "project/models/example.design.json",
    overrides={"substrate_mm": 1.6},
    domain_mm=(-40, -40, -2, 40, 40, 10),
    max_cell_mm=1.0,
)
summary = mesh.summary()  # compact JSON-safe counts, units, materials and boundary tags
metadata = write_elmer_mesh(mesh, "runs/fem-geometry/mesh")
```

`design` may be a Fairbeam design dictionary, a `.design.json` path, or `None`. A `None` design
creates vacuum only and requires an explicit `domain_mm`. Without `domain_mm`, a design mesh uses
the bounds of its supported boxes. An explicit domain must contain every box. `domain_mm` is
`[xmin, ymin, zmin, xmax, ymax, zmax]` in millimetres. `max_cell_mm` is also in millimetres.
Every box face is a grid plane, and each intervening interval is divided so no edge exceeds that
maximum. Lengths become metres once at the Elmer output boundary.

The function returns a `StructuredMesh` containing SI node coordinates, one-based node connectivity,
material body IDs, boundary face IDs and compact provenance. `summary()` does not include the full
node or element arrays. `write_elmer_mesh` creates a **new** output directory and refuses to replace
an existing path. It writes the four native files, optional `mesh.names`, and `mesh.metadata.json`
with per-file SHA-256 hashes. The metadata reports element counts, material IDs and properties,
PEC interface tags, units, domain, cell size, and the fact that no solver was executed.

The structured grid is limited to 100,000 cells, 250,000 nodes, 500 resolved boxes and 128 material
regions. The cell limit is checked before the mesh coordinate arrays are allocated. The output uses
Elmer element code 808 for linear hexahedra and 404 for linear quadrilateral boundary faces. It
checks positive Jacobians, node connectivity, exact material coverage, and exterior/interface tags
before writing. It does not generate material-interface boundary faces between two active
dielectrics; their bulk elements share nodes and retain distinct material IDs.

## Reproducible cavity control

The retained PEC cavity reference has a 100 mm × 50 mm × 200 mm vacuum domain. It can be prepared
without a design object or ports:

```python
mesh = mesh_design(None, domain_mm=(0, 0, 0, 100, 50, 200), max_cell_mm=25)
```

The 25 mm mesh has `4 × 2 × 8` hexahedra, 135 nodes, 64 bulk elements, and 112 exterior quads. The
12.5 mm refinement has `8 × 4 × 16` hexahedra, 765 nodes, 512 bulk elements, and 448 exterior
quads. Those counts and dimensions reproduce the original ElmerGrid-generated cavity mesh used as
the native format and topology control. The control itself is vacuum; it contains no conductor
geometry because the existing cavity SIF applies PEC on its six tagged outer faces.

The exported meshes were run with native Windows ElmerSolver 26.2 on October 9, 2026,
using that same cavity SIF. Both computed frequencies at each mesh density matched the
retained ElmerGrid control exactly in the recorded output (maximum difference: 0 Hz).
The TE101 frequency error against the analytic solution decreased from 2.2004% at 64
hexahedra to 0.5473% at 512 hexahedra. This validates this cavity's exported topology and
units; it does not qualify dielectric-interface scattering or arbitrary antenna designs.
Solver/source hashes and measured results are in the
[qualification record](benchmarks/fem-mesh-foundation-windows-20261009.json).

The separate [dielectric cavity qualification](FEM-QUALIFICATION.md) tests a fully
filled lossless dielectric through this exporter and the native solver, including
explicit mesh-body to SIF-material mapping at both mesh sizes.

## Native format and scope

The text files follow the serial mesh layout in Appendix A of the [official ElmerSolver
Manual](https://www.nic.funet.fi/index/elmer/doc/ElmerSolverManual.pdf): the header records counts
by element type, nodes carry SI coordinates, bulk elements carry a body ID, and boundary quads carry
a boundary ID plus a parent element. The node order and 808 element code follow the manual's
hexahedron definition. This format was also checked against the retained native ElmerGrid meshes
from the Fairbeam feasibility run.

This module is geometry/mesh-input preparation only. It does not support arbitrary CAD, unstructured
tetrahedra, imported meshes, thin metal sheets, losses, dispersive or tensor materials, ports,
waveguide modes, radiation boundaries, S-parameters, or antenna analysis. A prepared mesh is not a
solver run, and a successful export is not a FEM result.
