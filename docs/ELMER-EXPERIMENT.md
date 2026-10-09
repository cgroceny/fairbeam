# Experimental external Elmer cavity benchmark

Fairbeam includes a separate, opt-in `fairbeam-elmer` research command. It discovers an existing native Elmer package and runs one fixed, lossless, perfectly conducting rectangular cavity. This standalone command does not import `fairbeam`, openEMS or CSXCAD. The same bounded benchmark is available through the [experimental research panel](RESEARCH-SOLVERS.md), without translating arbitrary designer geometry. Normal Fairbeam projects, runtime setup and simulation engine selection are unchanged. No solver binaries are included or automatically installed.

## Run

Use Python 3.10+ from the repository, or install the Python package to obtain the separate `fairbeam-elmer` entry point:

```powershell
python python/fairbeam_elmer.py --root E:/external/Elmer capabilities
python python/fairbeam_elmer.py --root E:/external/Elmer cavity --experimental --mesh-size 0.025 --out E:/research/cavity-coarse
python python/fairbeam_elmer.py --root E:/external/Elmer cavity --experimental --mesh-size 0.0125 --out E:/research/cavity-fine
```

`--root` is the package containing `bin/ElmerSolver` and `bin/ElmerGrid`, or their binary directory. `FAIRBEAM_ELMER_ROOT` also selects that package. Otherwise, discovery checks PATH and requires both programs in the same binary directory. `capabilities` does not launch either executable: availability means the files were found, not that all required libraries work. Execution records the actual solver version and binary hashes.

`--experimental` is required for execution. Output must be a new directory; existing cases are never overwritten. Only mesh targets 0.025 and 0.0125 metres and the fixed cavity geometry are supported. Every subprocess has a 55 second timeout and one OpenMP/BLAS thread. This standalone serial command is outside the run-server queue; run it only when another solver is not running. The command does not launch MPI, WSL, containers or installer processes. It retains failed or interrupted manifests and logs; a successful exit with solver errors is rejected.

## Physical reference and actual native Windows observations

The cavity has dimensions a=0.1 m, b=0.05 m, d=0.2 m. Tangential electric field is zero on all six walls. Its fundamental mode is TE101 with TE defined relative to z: E_y is proportional to sin(pi*x/a)*sin(pi*z/d), and E_x=E_z=0. Its exact vacuum frequency is c0/2*sqrt(1/a^2+1/d^2)=1.675890788 GHz.

The input follows Elmer's [EMWaveBoxHexasEigen example](https://github.com/ElmerCSC/elmerfem/tree/devel/fem/tests/EMWaveBoxHexasEigen), using the Maxwell edge-element EMWaveSolver, UMFPACK and ARPACK. It uses normalized epsilon0=mu0=1. The eigenvalue is therefore k^2, and the raw frequency-like scalar sqrt(k^2)/(2*pi) has units 1/m, despite the upstream raw metadata naming the column Hz. The adapter multiplies that value by c0=299792458 m/s to report physical vacuum frequency. This convention is recorded in the manifest.

Native Windows Elmer 26.2-unknown, Release compiled 2026-08-05, produced:

| Mesh target | Nodes / hexahedra | TE101 frequency | Relative exact-frequency error |
|---|---|---|---|
| 0.025 m | 135 / 64 | 1.712767517 GHz | 2.2004% |
| 0.0125 m | 765 / 512 | 1.685063153 GHz | 0.5473% |

Both saved nodal E fields matched the analytical TE101 shape with absolute normalized correlation 1.0. The error fell about fourfold on refinement. Acceptance requires error <3% and correlation >0.98; `precision_converged` remains false because this is a coarse feasibility benchmark, not a precision-convergence certification. The second eigenfrequency is retained but its mode family is not validated. No antenna S parameters, driven port normalization, radiation boundaries, far field, lossy Q, dispersive materials or arbitrary project translation are supported.

Raw `.grd`, `.sif`, mesh, eigenfrequency and VTU outputs, process logs, `manifest.json` and `result.json` remain in each run directory. Manifests contain executable/input/generator SHA-256 and actual version strings. The bounded VTU parser supports only the uncompressed little-endian raw-appended Float64 layout exercised by this fixture; unsupported output layouts fail instead of guessing. Machine-readable results are separate research files, not viewer antenna bundles.

## Native platforms and distribution evidence

The official Elmer [Windows build mirror](https://www.nic.funet.fi/pub/sci/physics/elmer/bin/windows/) provides a portable `ElmerFEM-nogui-nompi-Windows-AMD64.zip`. The package used for the observations above has SHA-256 `e9072fe8db3c15ae3bef36e3f6d5ac59241376002b1d78eb171c9242756b1fc8`. The upstream example was inspected at devel HEAD `61a3d3d9b971923555bb56a800ebec8df9482acd`; this is not the executable's source revision. The generated SIF is a small benchmark adaptation, not an unmodified upstream regression test.

Elmer documents a [native macOS source-build route](https://github.com/ElmerCSC/elmerfem/blob/devel/compilation_instructions/macOS.md) with an outdated-instructions warning. No Mac executable was tested here. Apple Silicon and Intel dependencies, numerical fixtures, rpaths and signing/notarization need qualification before a Mac runtime is offered.

No license is changed by this contribution. The observed external ZIP includes Elmer GPL-2.0-or-later notices, GPL/LGPL texts, old METIS/AMD/UMFPACK/LAPACK notices and GCC runtime license/exception texts. It also contains OpenBLAS, ARPACK, GMP, MinGW/GCC runtime, compression/image libraries and a stripped compiler toolchain. Current upstream component terms include OpenBLAS/ARPACK BSD notices, Brotli/libdeflate MIT and double-conversion/WebP BSD notices, but their exact bundled versions and linked static dependencies are not established by filenames. Before any binary redistribution, obtain a versioned dependency inventory and build/source provenance, preserve exact component notices and establish the corresponding-source distribution plan. These are evidence gaps, not a legal compatibility conclusion. Fairbeam remains GPL-3.0-or-later; this feature uses only an external executable and ships no third-party binaries.

## Tests

```powershell
python -m unittest discover -s python/tests -p test_elmer_benchmark.py -v
```

These solver-free tests exercise missing binaries, explicit opt-in, unsupported inputs, finite ordered frequencies, mode-shape/reference failures, raw-field parser refusals, preserved process failure/timeout logs and import isolation. Real native runs are separate and explicitly authorized with `--experimental`.
