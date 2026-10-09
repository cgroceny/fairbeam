# Experimental periodic CPU study

This is an opt-in development harness, not a new production solver selection. It tests a native
openEMS patch for zero-phase x/y periodic boundaries at normal incidence. It does not modify
Fairbeam's installed runtime, project format, ordinary run command, desktop installer or viewer.
Use a separate build and output folder. Do not overwrite your working openEMS installation.

## What is implemented

- Scalar Cartesian CPU updates with paired periodic x/y faces and z PML.
- Axis-aligned boxes containing passive, isotropic, spatially constant, nondispersive material,
  and PEC boxes/sheets. Geometry crossing a periodic face must be explicitly wrapped and clipped
  into the cell. The harness does this for the translated L-shaped sample.
- Inclusive box membership tolerant only to floating-point roundoff at material faces; this fixes
  a mesh-aligned translation defect without shifting the physical geometry.
- A required native capability handshake: stock openEMS must never silently substitute another
  boundary condition. A conservative explicit timestep (80% vacuum CFL in these fixtures) is used
  identically in the sample and its empty reference.
- Uniform Cartesian mesh and PML16 in the qualification fixtures. The earlier graded-z/PML8
  control exceeded the empty-reference reflection limit; increasing PML alone did not resolve it.

This is **not full Floquet support**: there is no nonzero Bloch phase, oblique incidence, Floquet
modal-port decomposition, cross-polar S matrix, dispersion, GPU/SIMD periodic implementation,
automatic timestep qualification or general CAD geometry support. Results contain only the
co-polar fundamental S11/S21 at the sample faces. Their power sum is not a complete multimode
passivity check. Structured cells still need independent full-wave validation before general use.

## Build the native candidate

The patch targets the openEMS fork at
`https://github.com/SeanMollet/openEMS.git`, revision
`08e15ff532a7f4cfd1d4e7164ec262f5187bf30e`. It has not been ported to a different upstream revision.
Create two clean checkouts at that revision. Leave the baseline untouched; apply
`openems-periodic.patch` only to the candidate:

```sh
git checkout 08e15ff532a7f4cfd1d4e7164ec262f5187bf30e
git apply --check /path/to/fairbeam/scripts/experimental-periodic/openems-periodic.patch
git apply /path/to/fairbeam/scripts/experimental-periodic/openems-periodic.patch
```

Build both with the same compiler, flags and dependencies using the fork's native CMake build.
Use different build and install prefixes; `ENABLE_CUDA=OFF`, Release, and at most two build jobs.
Windows validation used MSVC 14.42, `/MD /O2 /Ob2 /DNDEBUG /fp:precise`, CSXCAD
`v0.7.0-rc2-6-g1ceb60b`, VTK 9.3.20231030, HDF5 2.2.0, Boost 1.91 and TinyXML 2.6.2.
CSXCAD/fparser and the dependency development packages must already be available to CMake;
this directory is not a dependency downloader or installer. Keep each executable with its matching
DLLs. The source patch remains GPL-3.0-or-later, like the modified openEMS files. No native binaries
are included or redistributed here.

The candidate must return JSON for:

```sh
/path/to/candidate/openEMS --fairbeam-periodic-capabilities
```

Windows uses `openEMS.exe`. Native macOS and Linux builds have not been qualified by this study.
No WSL is used. A stock executable is deliberately refused by the harness.

## Run the research gate

Use a Python environment with the CSXCAD/openEMS bindings and NumPy. The scripts load Fairbeam
from this checkout, and serialize models with full-precision box coordinates; native simulation
runs exclusively in the explicitly supplied executable. From the repository root:

```sh
python scripts/experimental-periodic/qualify.py --candidate /path/to/candidate/openEMS --baseline /path/to/baseline/openEMS --output /path/to/new-study
python -m unittest discover -s scripts/experimental-periodic -p "test_*.py" -v
```

The output directory must not exist. Solves are sequential, scalar CPU, each with a 120-second
timeout and an 80,000-timestep cap. This is a small validation study, not a performance benchmark.
The two source trees must have the same base commit; executable and DLL hashes identify the
actual binaries used but do not alone prove their source provenance.

The gate checks three mesh levels (20/30/40 cells per wavelength): analytic dielectric slab,
PEC sheet, translation of asymmetric dielectric and PEC patterns across the periodic seam, and unchanged raw
PEC/PMC probes against the same-commit baseline. Twelve invalid configurations must fail before
simulation with the expected reason. The numerical thresholds are in `study-contract.json` and
are unchanged from the initial failed study. `qualification.json` reports each gate separately
and the process exits nonzero when any gate fails.

The [measured Windows snapshot](measured-results.json) records the tested binary/patch hashes and
40 completed native solves. At the finest slab mesh the maximum absolute complex S error was
0.00153264 and independent empty-reference reflection was 0.00007823. Both translation tests stayed
below 7e-16; all 24 ordinary-boundary raw probe files were numerically unchanged. These are bounded
fixture results, not a general accuracy guarantee. The snapshot also records unrelated existing
application-test failures encountered during the full repository checks.

Each pair preserves reference and sample XML, native logs, input/binary/probe hashes, timing,
complex NPZ and CSV values and an independent two-plane empty-reference reflection estimate.
Energy termination (normal completion below the timestep cap) and mesh convergence are distinct;
short runs may have no printed final energy sample. A zero S11 from dividing an empty cell by
itself is not used as an accuracy claim.

To investigate one case family, run `validate.py --help`. `pilot`, `slabs`, `translation`, `pml`
and `offset-diagnostic` retain earlier controls; only `qualify.py` evaluates the complete gate.
Passing these research checks permits further integration work, not a claim that arbitrary
metamaterials, lossy/dispersive resonators or antenna projects are validated.

## Before product integration

1. Independent patterned-cell reference and cross-polar fundamental power accounting.
2. Material/shape expansion with negative-input tests and convergence evidence for each addition.
3. Native macOS build and the same numerical gates.
4. Separate, capability-gated API/UI with explicit normal-incidence restrictions and preserved
   existing projects; a compatible binary distribution and license inventory.
5. Full Floquet/Bloch support only after separate phase, mode and oblique-incidence verification.

AI disclosure: Codex generated the experimental patch and harness; results above describe the
tests to run, not an independent review of the underlying numerical method.
