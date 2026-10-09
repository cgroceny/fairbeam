# Experimental dielectric cavity qualification

`fairbeam.fem_qualification` is an opt-in, four-case benchmark for the experimental structured
Elmer mesh exporter and the native Maxwell eigenmode solver. It uses a 100 mm × 50 mm × 200 mm
rectangular cavity filled uniformly with a lossless dielectric and bounded by PEC walls. This
isolates material assignment and eigenmode behavior from ports, radiation boundaries, and antenna
geometry. It does not add a solver to Fairbeam's normal runtime, translate arbitrary designs, or
qualify driven ports, S-parameters, or antenna analysis.

## Independent reference and acceptance

For a homogeneous, isotropic filling material, the lowest TE101 frequency is

```text
f = c0 / (2 sqrt(eps_r mu_r)) * sqrt(1/a^2 + 1/d^2)
```

where `a = 0.1 m`, `d = 0.2 m`, and `mu_r = 1`. The normalized eigenfrequency stored by this Elmer
input is in `1/m`; multiplying it by `c0` gives hertz. Changing `eps_r` from 1 to 4 therefore halves
the exact frequency. The comparison uses `eps_r = 1` and `4` on the same 25 mm and 12.5 mm meshes.
Those sizes yield 64 and 512 hexahedra, respectively.

The complete study passes only when all four cases satisfy the analytic TE101 reference and the
complex electric-field correlation is greater than 0.98; the coarse frequency error is below 3%,
the fine error is below 1%, and the fine error is smaller than the coarse error for both materials.
At each mesh size, the observed `eps_r = 4` to `eps_r = 1` frequency ratio must be within a
relative error of `1e-6` from 0.5. Passing this bounded check does not establish precision
convergence or general dielectric-interface accuracy.

The native Windows study on October 9, 2026 passed all four cases. The same-mesh
dielectric/vacuum frequency ratio was 0.5 at 25 mm and 0.5000000000000889 at 12.5 mm.
For both materials, the TE101 analytic frequency error decreased from 2.2004% to
0.5473%, with complex field correlation above 0.999999999999999. The first input
attempt failed because its SIF section numbering started at 2; the corrected explicit
mapping described below passed. The [measured record](benchmarks/fem-dielectric-windows-20261009.json)
retains the successful results, source/solver/output hashes, and the failed control.

## Input mapping and execution

The benchmark builds each mesh through `fairbeam.fem_geometry`. All active hexahedra retain mesh
body ID 2. The SIF maps that body explicitly from a contiguous `Body 1` section with
`Target Bodies(1) = 2`, `Equation = 1`, and `Material = 1`; the material block assigns the selected
permittivity. The exporter also reports the unused background vacuum region as material ID 1, but
there are no vacuum cells in this fully filled benchmark. This mapping uses Elmer's SIF body syntax
shown in the official [EMWaveBoxHexasEigen test](https://github.com/ElmerCSC/elmerfem/tree/devel/fem/tests/EMWaveBoxHexasEigen)
and the official [body-target example](https://github.com/ElmerCSC/elmerfem/blob/devel/fem/tests/mgdyn2D_compute_bodycurrent/sif/6801.sif).

Run commands from the repository's `python` directory. Replace the sample paths with the repository
checkout, Python interpreter, Elmer package, and fresh output directories on your machine. A
prepare-only invocation writes mesh and SIF inputs without finding or launching Elmer; use a
different fresh output directory for a later run because output paths are never overwritten:

```powershell
$repoPython = 'C:/path/to/fairbeam/python'
$pythonExe = 'C:/path/to/venv/Scripts/python.exe'
$elmerRoot = 'C:/path/to/ElmerFEM-nogui-nompi-Windows-AMD64'
Set-Location $repoPython
& $pythonExe -m fairbeam.fem_qualification capabilities --root $elmerRoot
& $pythonExe -m fairbeam.fem_qualification prepare --out C:/research/dielectric-inputs
& $pythonExe -m fairbeam.fem_qualification run --experimental --root $elmerRoot --out C:/research/dielectric-study
```

`run` requires `--experimental` and runs the four cases sequentially. Each case gets at most 55
seconds, one OpenMP/BLAS thread, and an 8 MiB solver log. A timeout or log-limit breach terminates
the launched solver process and retains its partial log. Mesh sizes and output parsing are capped;
non-finite, unordered, truncated, compressed, or otherwise unsupported eigen/VTU outputs fail
validation. No binaries are installed or launched by `capabilities` or `prepare`.

Execution records distinguish a requested launch from a successfully created solver
process. A parsed mode must cover every prepared mesh node exactly once; native node
reordering is accepted, but coordinates must match within `1e-12 m` per axis. Missing,
duplicated or shifted nodes fail before the frequency and field-shape checks.

The study directory contains a top-level `manifest.json` and `result.json`. Each case under
`inputs/` contains `case.sif`, the native mesh files and mesh metadata, `solver.log`, raw eigen and
VTU output, a case `manifest.json`, and `result.json`. Manifests record timestamps, host and Python
versions, the base Git revision and dirty-state hash, SHA-256 hashes for the Fairbeam Python source
files, solver executable, inputs, logs, raw outputs, and results. Failed and interrupted cases keep
their logs and manifests for inspection.

## Tests

The solver-free tests exercise analytic scaling, explicit mesh-body/material mapping, frequency and
field checks, output parsing, duplicate/missing study cases, timeout cancellation, and retained
logs:

```powershell
python -m unittest discover -s tests -p test_fem_qualification.py -v
```

These tests do not launch Elmer. A native run is a separate research action requiring the explicit
`run --experimental` flag.
