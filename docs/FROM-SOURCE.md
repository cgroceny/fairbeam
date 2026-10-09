# Running Fairbeam from source

This guide builds openEMS, installs Fairbeam from the repository, runs a first model and opens the
viewer: the developer setup. To try the desktop app instead, see [Getting started](GETTING-STARTED.md).
For the command reference see [CLI.md](CLI.md); for running simulations from the viewer see
[RUN-SERVER.md](RUN-SERVER.md).

For Linux, use [Linux from source](LINUX.md), including the CPU runtime installer and local-browser
launcher. The installation commands below cover macOS.

## Install and first run

Requirements: macOS with Homebrew, Xcode command line tools, Python 3.10+ (the python.org build is recommended) and Node.js 22.12+.

```bash
# 1. Build openEMS + CSXCAD from source into ~/opt/openEMS and install fairbeam into its venv
#    (about 5-10 minutes; the VTK step heats the CPU)
scripts/install-openems-macos.sh

# 2. Run a model. This writes public/projects/<slug>.json and updates public/projects/index.json
~/opt/openEMS/venv/bin/fairbeam run python/models/patch_antenna.py
~/opt/openEMS/venv/bin/fairbeam run python/models/sierpinski_monopole.py --set iterations=3 --threads 6

# 3. Start the viewer on http://127.0.0.1:5310
npm install
npm run dev
```

You can change the install script's defaults with environment variables: `PREFIX` (default `~/opt/openEMS`), `SRC` (default `~/opt/openems-src`), `JOBS` (default: half the cores) and `FORCE=1` (rebuild steps that are already done). If you already have openEMS, install the package into its venv with `<venv>/bin/pip install -e python`.

## Tests

The Python tests use only the standard library's `unittest` (no pytest) and do not run openEMS: the post-processing is driven by stub port and NF2FF objects. They need the openEMS venv because `fairbeam` imports the CSXCAD and openEMS bindings. No `npm` step is involved.

```bash
PYTHONPATH=python ~/opt/openEMS/venv/bin/python -m unittest discover -s python/tests      # ~1 s
PYTHONPATH=python ~/opt/openEMS/venv/bin/python -m unittest discover -s python/tests -p test_bands.py -v   # one module
```

| Module | Covers |
| --- | --- |
| `test_excitation.py` | Gaussian-derivative pulse: zero DC, spectral peak location, -20 dB at `f_max`, analytic level vs FFT |
| `test_mesh.py` | `merge_lines`: required lines kept, no slivers narrower than `tol`, bounded widening |
| `test_bands.py` | band detection: none, single, multiple, touching either range edge, whole range, single sample |
| `test_model.py` | `Param` parsing and bounds, `resolve_params`, `load_model`, metadata of every shipped model |
| `test_geometry.py` | polygon in-plane order round trip for all three normals (checked against CSXCAD's 3D bbox), linpoly, box sheets, NF2FF box |
| `test_evaluate.py` | `Simulation.evaluate` with stubs: S11/Zin, efficiency, gain, PEC/PMC mirror correction for 0-3 planes |
| `test_bundles.py` | committed bundles in `public/projects`: required keys, array lengths, directivity grid shape `len(theta) x len(phi)`, index consistency |
| `test_parse_log.py` | run statistics from the openEMS log: converged/limit detection for fast runs and the custom excitation |
| `test_analytic.py` | patch TL model and microstrip formulas vs Balanis examples, dipole induced EMF and MoM references |
| `test_study.py` | sweep axes, resonance/Zin metrics, convergence report |
| `test_touchstone.py` | `.s1p` writer: 50 ohm renormalisation, round trip, committed patch bundle |
| `test_multiport.py` | S-matrix assembly from synthetic waves (leaky terminations, partial excitation), reciprocity/passivity QA, renormalisation, N-port Touchstone round trip and line wrapping |
| `test_network.py` | ideal circuit references: matched lines at quarter/half/full wave, unequal references vs ABCD, series shorts, Butterworth ladder, Wilkinson even/odd modes, branch-line hybrid, input refusals |
| `test_planar_calibration.py` | two-line propagation extraction and reference-plane shifts vs independent lossy ABCD cascades and nodal networks, branch ties, refused controls and unsafe corrections |
| `test_array.py` | array combination against the analytic array factor, steering, realized gain normalization, active reflection; geometry-only builds of the multi-port models |
| `test_nrw.py` | material extraction: NRW (lossless, lossy, magnetic, Debye; group-delay branch on a thick sample; half-wave mask), NIST iterative (whole band, noise at the resonance), result-file fields, `Simulation.dielectric(mu_r=...)` |
| `test_dispersion.py` | dispersive materials: Debye / Lorentz / Drude against openEMS' own formulas, CSXCAD properties, the pole rules (no magnetic Debye, Debye poles realized as Lorentz poles), Djordjevic-Sarkar, pole resolution, `Simulation.dispersive` and its bundle record, frequency-dependent analytic layers |
| `test_debye_fit.py` | pole fitting: NNLS against brute force, Djordjevic-Sarkar FR4 over the band, the timestep bound on the poles, Debye poles next to kept Lorentz / Drude poles, fits to pole models, noisy and conductive data, CSV and `.cell.json` input, the `debye-fit` command |
| `test_dispersion_validation.py` | regression cases: NRW above an initially opaque band, all-opaque and isolated samples, a false non-magnetic declaration (above an opaque band, and a thick magnetic sample in a narrow band), NaN/infinite material constants, poles and fit controls, ε′ = 0 at the band centre |
| `test_material_cell.py` | plane-wave material cell: transfer-matrix slab vs the closed-form Fresnel slab (lossy, magnetic, cascaded), S11/S21 from synthetic probe voltages, cell boundaries, mesh, source and probes, the empty reference cell, both runs at one timestep (read back from the probe file) |
| `test_waveguide_fixture.py` | waveguide material fixture: guided slab vs the closed form, guided NRW/NIST recovery (with a numerical β0), de-embedding, cut-offs and band check, fixture mesh and ports, the runner with timestep matching and its result-file fields, a dispersive (Debye) sample; the air gap: resonance and capacitor corrections (TN 1355-R C.1 and C.23-C.24), the modes a gap excites, the graded transverse mesh, moved reference planes, corrected values in the result |

The table lists the core modules. `python/tests/` has more, for example designs and their checks (`test_design.py`, `test_design_checks.py`, `test_example_designs.py`), the run server and job queue (`test_server.py`, `test_jobs.py`), the optimizer, the VBA macro importer and telemetry.

### Opt-in guided-wave fixtures

Three test modules also carry a manual openEMS study. Test discovery checks only their analytical references and analysis code; the solver runs only with an explicit `--fdtd`. Each case runs in its own process (30-minute limit, at most four solver threads) and writes raw modal spectra, `report.json` and, after a mesh study, `comparison.json` to the `--out` folder. Use a new folder outside the repository: these are research records, not bundles. A scope counts as validated only with three meshes, energy stops on all of them and two consecutive mesh comparisons within the stated limits.

| Module | Structure | Compared with |
| --- | --- | --- |
| `test_circular_guide_loss.py` (`circular_guide_fixture.py`) | dielectric-filled circular guide, TE11 (Pozar Example 3.2 parameters) | β and dielectric/conductor attenuation from the closed form; the gold wall is a resistive-sheet surrogate with a known discrepancy (about 8 %), so it is not validated |
| `test_coax_cutoff.py` (`coax_cutoff_fixture.py`) | coaxial (annular) guide, TE11 cut-off (Example 3.3 parameters) | the exact Bessel eigenvalue; the approximate textbook value is a different target |
| `test_surface_wave.py` (`surface_wave_fixture.py`) | grounded dielectric sheet, TM0/TE1/TM1 (Example 3.4 parameters) | β from the interface equations at twelve mode/thickness points |

```bash
cd python
python -m tests.test_circular_guide_loss --fdtd --mesh 8 --loss none --out <new folder>   # one coarse case
python -m tests.test_circular_guide_loss --fdtd --out <new folder>                        # the full mesh study
python -m tests.test_circular_guide_loss --analyse-only --out <that folder>
```

The viewer has its own checks: `npm run typecheck` (`tsc --noEmit`), `npm run build`, `npm run check:cst`, and the groups `npm run check:exports` and `npm run check:designer`; every `check:*` script is listed in `package.json`. The desktop shell has Rust unit tests: `cd src-tauri && cargo test`.

To try the desktop shell from the checkout, run `npm run desktop` (Vite on port 5315 and the API on port 5325 in a native window; needs Rust, see [DESKTOP.md](DESKTOP.md#building-and-developing)). `npm run app` builds the viewer and serves it with the API on a free port in the browser.

## Cross-platform

The viewer runs in any modern browser. The Python package is portable. openEMS ships Windows builds and Linux distribution packages, and Fairbeam works with any openEMS installation whose Python bindings import. The platform specific parts are the macOS and Linux install scripts, the capture of openEMS' C++ stdout (`dup2` plus `fflush` of libc, or of the Universal CRT on Windows) and the run server's process handling. Windows is verified with the official openEMS build: see [WINDOWS.md](WINDOWS.md). The tested Linux CPU/source setup and its validation limits are in [LINUX.md](LINUX.md).
