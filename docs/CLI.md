# CLI reference

Run the CLI with the Python environment that can import both `openEMS` and `CSXCAD`. The platform
setup guides create or configure that environment: [macOS from source](FROM-SOURCE.md),
[Windows](WINDOWS.md), and [Linux from source](LINUX.md). The examples below start in the repository
root.

## Quick start

On macOS and Linux, the source installers put the `fairbeam` entry point in the openEMS venv:

```bash
CLI="$HOME/opt/openEMS/venv/bin/fairbeam"
"$CLI" params python/models/patch_antenna.py
"$CLI" geometry python/models/patch_antenna.py --out public/projects
"$CLI" run python/models/patch_antenna.py --set patch_l=39 --threads 4 --engine cpu
```

On Windows, use the repository venv created by [the Windows setup](WINDOWS.md):

```powershell
$env:OPENEMS_INSTALL_PATH = 'C:\opt\openEMS'  # folder containing openEMS.exe and the DLLs
$env:CSXCAD_INSTALL_PATH = $env:OPENEMS_INSTALL_PATH
$Python = '.\.venv\Scripts\python.exe'
& $Python -m fairbeam params .\python\models\patch_antenna.py
& $Python -m fairbeam geometry .\python\models\patch_antenna.py --out .\public\projects
& $Python -m fairbeam run .\python\models\patch_antenna.py --set patch_l=39 --threads 4 --engine cpu
```

`params` prints the model's parameters and defaults. `geometry` builds the model and mesh and writes a
geometry-only bundle; it does not start a solver. `run` simulates and writes a result bundle. All
three commands accept a Python model (`.py`) or a designer file (`.design.json`). Use
`--set key=value` with `run` or `geometry` to override a parameter; the CLI checks its name and
declared bounds.

## Runs the app shows (`--server`)

`fairbeam run` solves in its own process: the open app does not list it, the app's queue does not wait
for it (the preflight and the Run panel only say that a terminal run uses the CPU), and the bundle goes
to `--out`. To start a run that the app shows, queues behind its other runs and writes into its
workspace, submit it to the app's run server instead:

```bash
fairbeam run patch_antenna --server                   # the desktop app's server (found from its record)
fairbeam run patch_antenna --set patch_l=39 --server http://127.0.0.1:5320 --label "Patch 39 mm"
fairbeam run patch_antenna --server 5320 --detach     # return once it is queued
```

`MODEL` is a model of the server's models folder: its name (the file name without `.py` or
`.design.json`) or the file itself. `--set`, `--threads`, `--engine`, `--end-db`, `--points`,
`--label`/`--name` are passed on; the options that choose local folders or outputs (`--out`,
`--sim-root`, `--pattern`, `--fields`, ...) are refused. The command prints the run's log until it ends
(exit code 0 when it is done, 1 otherwise); Ctrl+C stops following, the run goes on in the server. Stop
it in the app (Recent runs, the designer dock's Queue tab) or with `POST /api/runs/<id>/cancel`.

Scripts and agents can call the same API directly:

```bash
curl -s -H 'Content-Type: application/json' -d '{"model":"patch_antenna","params":{"patch_l":39},"threads":"auto"}' http://127.0.0.1:5320/api/runs
# -> the job: {"id": ..., "status": "queued", ...}
curl -s http://127.0.0.1:5320/api/runs                              # the history, newest first
curl -s -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:5320/api/runs/<id>/cancel
curl -s -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:5320/api/queue/clear
```

**Default folders.** In a source checkout `--out` and `--sim-root` default to `public/projects` and
`.sim`, as always. The packaged app's runtime imports `fairbeam` from inside the runtime folder, so those
defaults would point there, where the app shows nothing. A server the desktop app started therefore
records its address and workspace folders in `server.json` in the app's data folder (Windows
`%LOCALAPPDATA%\org.fairbeam.desktop`, macOS `~/Library/Application Support/org.fairbeam.desktop`, Linux
`~/.local/share/org.fairbeam.desktop`; `FAIRBEAM_STATE_DIR` overrides it). Outside a checkout the CLI
defaults to that workspace's `projects` and `.sim` and says so; without a record it warns that the
result stays inside the runtime. `--server` alone uses the same record to find the app's server. A
debug `tauri dev` shell runs the checkout's server on the repository's folders; its record says so
(`"checkout": true`) and the packaged CLI does not take those folders for its defaults.

**No result is replaced in the app's workspace.** There, a file of the CLI's name (the model id and
the `--set` values, for example `sierpinski-monopole--iterations-3.json`) is often an example the app
copied into the workspace, or the app's own first run of the same model and parameters (the run
server names a run's bundle the same way). So `fairbeam run` and `fairbeam geometry` without `--name`
write beside it, under the run server's naming: `<name>-<date>-<time>.json` (then `-2`, `-3`, ...), and
say so. They do the same for the name of a run the app's server is running (it writes its bundle
under that name when it ends). `--name` picks the file name and replaces a file of that name, as in a
checkout, where the same command still replaces its own earlier result.

`fairbeam clean-sim` without `--sim-root` cleans the same workspace's `.sim` there, so it also removes
the raw folders of the app's own runs (`.sim/runs/<job id>/`) that are older than `--older-than` days
(see [Raw simulation data](#raw-simulation-data-sim)); the runs' bundles and history stay.

## CPU and GPU engines

CPU is the default engine unless `FAIRBEAM_ENGINE` selects another value. Pass `--engine cpu` to
choose CPU explicitly. `--engine gpu` requires a GPU-enabled openEMS build and the Python environment
installed with that build. The optional supported installs are [Metal on Apple silicon](GPU.md#gpu-engine-optional-apple-silicon-nvidia-on-windows)
and [CUDA on Windows](GPU.md#windows-with-an-nvidia-gpu-cuda); this repository does not provide a
Linux GPU installer.

On macOS the CPU engine runs with the native CPU patches of the openEMS pack, on by default
(bitwise identical results, 1.3 to 1.7 times faster; [CPU-OPTIMIZATION.md](CPU-OPTIMIZATION.md#macos-shipped-and-on-by-default)).
`FAIRBEAM_NATIVE_CPU=0` turns that off. Windows and Linux are not affected.

```bash
# macOS, after installing the optional GPU build
"$HOME/opt/openEMS-gpu/venv/bin/fairbeam" run python/models/patch_antenna.py --engine gpu
```

```powershell
# Windows, after installing the optional CUDA build
$env:OPENEMS_INSTALL_PATH = 'C:\opt\openEMS-gpu'
$env:CSXCAD_INSTALL_PATH = $env:OPENEMS_INSTALL_PATH
& 'C:\opt\openEMS-gpu\venv\Scripts\python.exe' -m fairbeam run .\python\models\patch_antenna.py --engine gpu
```

`--threads auto` uses the host and built mesh to choose a bounded thread count; `--threads N` fixes
the count, while `--threads 0` delegates tuning to openEMS. A GPU build that cannot provide its GPU
engine may fall back to CPU, so check the run log or the bundle's `run.engine` when recording results.
See [GPU.md](GPU.md) for installation and engine-specific limits.

## Importing existing geometry

Convert a CST-compatible VBA macro or history list into a designer file:

Use a text `.bas`, `.mcs` or `.txt` export (see [DESIGNER.md](DESIGNER.md#importing-a-vba-macro)).

```text
fairbeam import-cst legacy-model.bas --out imported.design.json
```

Convert PCB artwork from DXF, Gerber copper/outline layers, and optional Excellon drill files:

```text
fairbeam import-pcb top.gtl bottom.gbl board.gko holes.drl --layer-map "TOP=top_copper,BOT=bottom_copper,EDGE=outline" --substrate FR4 --thickness 1.6 --units mm --out board.design.json
```

Both commands print an import report. Review the layer mapping and report, then open the generated
`.design.json` in the designer or pass it to `params`, `geometry`, or `run`. See
[VBA macro import](DESIGNER.md#importing-a-vba-macro) and [PCB artwork import](DESIGNER.md#importing-pcb-artwork-dxfgerber)
for supported inputs and conversion details.

| Command | Purpose |
| --- | --- |
| `fairbeam run <model.py or design.json>` | Simulate a Python model or a designer file (`*.design.json`, e.g. `examples/designs/`) and export a bundle |
| `fairbeam params <model.py or design.json>` | List the model's parameters and defaults |
| `fairbeam geometry <model.py or design.json>` | Export geometry and mesh without simulating (`<slug>--geometry.json`) |
| `fairbeam index [folder]` | Rebuild `index.json` for a bundle folder |
| `fairbeam serve` | Local run server (127.0.0.1 only) that the app uses to run simulations; options in [RUN-SERVER.md](RUN-SERVER.md) |
| `fairbeam app [--port N] [--ui DIR] [--no-browser]` | Serve the built viewer (`dist/`, from `npm run build`) and the run server on one port (default: a free one) and open the browser |
| `fairbeam sweep <model.py> --param k=v1,v2 [--param ...]` | Cartesian parameter sweep; one bundle per point plus a study file in `public/projects/studies/` ([STUDIES.md](STUDIES.md)) |
| `fairbeam converge <design.json> [--densities 15,20,30,40] [--tol-f 0.5] [--tol-s11 1] [--tol-dmax 0.2] [--max-runs 4]` | Mesh convergence study of a design: runs it at increasing automatic-mesh densities and stops when the resonance, \|S11\| there and Dmax change less than the tolerances (see below, [STUDIES.md](STUDIES.md#fairbeam-converge)) |
| `fairbeam converge <model.py> --param mesh_div=10,20,30` | Refinement study of a model parameter; reports the change of the first resonance and Dmax and flags convergence (< 0.5 % / < 0.1 dB) |
| `fairbeam optimize <model.py or design.json> --vary k=min:max --goal f0=2.45` | Tune bounded parameters towards goals (f0, \|S11\| at f, bandwidth, Dmax; multi-port \|S_ij\| at most / at least, all \|S_ii\| at most); `--method` auto (secant for one parameter and an f0 goal, else Nelder–Mead), bayesian, cma-es, particle-swarm, genetic or trust-region; results in `public/projects/optimizations/` ([OPTIMIZE.md](OPTIMIZE.md)) |
| `fairbeam clean-sim [--older-than DAYS] [--dry-run]` | Remove raw openEMS run folders under `.sim/` not written to for DAYS days (default 7) and print the space freed (see below) |
| `fairbeam import-cst <macro.bas> [--out F] [--id ID] [--name N]` | Convert a CST-compatible VBA macro or history list (`.bas`, `.mcs`, `.txt`) into a design file and print the import report ([DESIGNER.md](DESIGNER.md#importing-a-vba-macro)) |
| `fairbeam import-pcb <files...> [--out F] [--layer-map TOP=top_copper,BOT=bottom_copper] [--substrate FR4 --thickness 1.6 --eps-r 4.3 --tan-d 0.02] [--units auto\|mm\|inch] [--chord-tol 0.02] [--margin 2] [--f0 2.45] [--origin center\|keep] [--id ID] [--name N]` | Convert PCB artwork (DXF, Gerber RS-274X, Excellon drill) into a design file: each copper layer becomes a part of polygon sheets, on a substrate box over the board outline; prints the import report; adds no port ([DESIGNER.md](DESIGNER.md#importing-pcb-artwork-dxfgerber)) |
| `fairbeam touchstone <bundle.json> [-o FILE] [--port N] [--ref OHM]` | Write the S-parameters as Touchstone v1 (`.s1p`, `.s2p`, `.s3p`, ...; `# GHz S RI R 50`) ([STUDIES.md](STUDIES.md#fairbeam-touchstone)) |
| `fairbeam material-cell <model.py> [--set K=V] [--out DIR] [--tol DS]` | Normal-incidence plane-wave cell or TE10 waveguide fixture: runs the empty cell and the sample cell and writes S11, S21, \|R\|², \|T\|² and the absorption to `<slug>.cell.json` (see below) |
| `fairbeam debye-fit <cell.json\|csv> \| --datasheet F:EPS:TAN --f-min F --f-max F [-o FILE]` | Fit a pole model to εr(f) (a datasheet's Djordjevic-Sarkar laminate, a measured or an NRW-extracted permittivity) for `Simulation.dispersive` (see below) |

Options for `run` (`geometry` accepts the first three):

| Option | Default | Meaning |
| --- | --- | --- |
| `--set KEY=VALUE` | | Override a model parameter (repeatable, checked against min/max) |
| `--name NAME` | derived from model id and overrides | Bundle file name without `.json` |
| `--out DIR` | `public/projects` | Bundle output folder |
| `--threads N` or `--threads auto` | `auto` (host and built mesh) | FDTD threads. Auto uses the same physical-core and grid-size policy as the run server. A positive number fixes the count. `0` passes openEMS' native automatic tuning, which starts at one thread and adjusts at progress intervals. |
| `--sim-root DIR` | `.sim` | Raw openEMS output |
| `--points N` | `801` | Frequency points |
| `--pattern "3.3,6.2"` | band centers | Far-field frequencies in GHz |
| `--quiet` | | Do not echo openEMS output |
| `--engine cpu\|gpu` | `cpu` (or `FAIRBEAM_ENGINE`) | FDTD engine; GPU requires the separate optional build and its matching venv (see [GPU.md](GPU.md)) |
| `--end-db DB` | the model's (-60 unless it sets another) | Energy end criterion in dB |
| `--no-exact` | | Check the end criterion every ~4 s of wall time instead of every Nyquist period (the default) |
| `--excite all\|1,3` | all ports if <= 4, else 1 | Ports to drive, one openEMS run each (see [Multi-port structures](MULTIPORT.md)) |
| `--element-patterns on\|off` | on for several driven ports | Store complex embedded element patterns (antenna arrays) |
| `--fields [GHz,...]` | off | Record surface-current maps on every metal sheet plane (at these frequencies, else `--pattern`, else the nearest of a ~0.5 % grid to each far-field frequency). Shown by the viewer's "Surface current" layer; see [BUNDLE.md](BUNDLE.md#fields) |
| `--field-plane Q NORMAL MM GHZ[,GHZ...]` | off (repeatable) | Record an E- or H-field map on a cut plane: `Q` is `E` or `H` (magnitude of all three components) or one component (`Ex`, `Hz`, ...), `NORMAL` is `x`, `y` or `z`, `MM` the plane position (snapped to the nearest mesh line; a position outside the domain is recorded at its edge, with a warning), `GHZ` the frequencies. E.g. `--field-plane E z 2.5 2.45 --field-plane H y 0 2.45`. The map covers the whole domain in the plane; values are peak phasor amplitudes for 1 W incident power at the driven port. A design's `monitors.field_planes` does the same without the flag; the flags replace them. See [BUNDLE.md](BUNDLE.md#field_planes) |
| `--efficiency [N]` | off (`N` = 21 when given without a number) | Radiation efficiency Prad / Pacc at N frequencies (3 to 201) evenly spaced from `f_min` to `f_max`, one entry per driven port in `results.efficiency` ([BUNDLE.md](BUNDLE.md#efficiency)). The NF2FF box records time-domain dumps, so this is post-processing after the run (well under a second for 21 frequencies on the patch example), not solver time. Adds the NF2FF box to a model that has none. A design's `monitors.efficiency` does the same without the flag; the flag overrides its N. Off-resonance values need a low end criterion (−50 dB or below) |
| `--mesh-density CELLS` | the design's | Design files: run at this automatic mesh density (cells per wavelength at f max; the Auto mode's override). Manual mesh lines are refused. The run server passes it for each run of a mesh convergence study |

Options for `converge` with a design file (it also takes the `sweep` options `--set`, `--name`,
`--out`, `--sim-root`, `--threads` (default 4), `--points`, `--pattern`, `--excite`, `--end-db`, `--no-exact`, `--engine`, `--verbose`):

| Option | Default | Meaning |
| --- | --- | --- |
| `--densities C1,C2,...` | `15,20,30,40` | Automatic mesh densities in cells per wavelength, increasing (2 to 12 of them, 4 to 200) |
| `--tol-f PCT` | `0.5` | Resonance tolerance in % |
| `--tol-s11 DB` | `1` | Tolerance of \|S11\| at the resonance in dB |
| `--tol-dmax DB` | `0.2` | Dmax tolerance in dB (ignored without a far field). `--tol-d` is the same option; with `--param` its default stays 0.1 |
| `--max-runs N` | `4` | Stop after N runs |
| `--max-density C` | | Leave out densities above C |

A step converges when every change is strictly below its tolerance; the study stops at the first
such step and prints the table and the verdict ("converged at 30 cells/λ", the coarser density of
that step, or "not converged: refine further or check the model"). The exit code is 0 for either
verdict and 1 when a run failed.

Optional network criteria work with both design densities and `--param` studies. They are added
to the existing resonance/Dmax checks (and the design path's S11 check); leaving them out preserves
the existing behavior. These options affect the CLI study, not the Designer's convergence dialog.

| Option | Default | Meaning |
| --- | --- | --- |
| `--network-frequency GHZ` | off | Fixed comparison frequency, required with `--network-metric`; must lie inside every run's sampled band |
| `--network-metric KIND:PORTS:TOL` | off | Repeatable criterion; positive tolerance in dB, or degrees for phase. Port numbers are physical IDs |

Kinds and port order: `coupling:OUT,IN:TOL` and `isolation:OUT,IN:TOL` compare
−20 log10|Sout,in|; `directivity:COUPLED,ISOLATED,IN:TOL` compares
20 log10|Scoupled,in / Sisolated,in|. `phase:OUT,IN:TOL` compares the transmission phase;
`phase:OUT1,OUT2,IN:TOL` compares the relative phase of two outputs. `s11:PORT:TOL` compares
20 log10|Sport,port| at the fixed frequency (also available to `--param`). Phase changes use
the shortest circular distance, so crossing ±180° alone does not imply a large change.

```sh
fairbeam converge python/models/branchline_coupler.py --param cpw=12,20,30 --excite all \
  --network-frequency 2.4 --network-metric coupling:3,1:0.2 \
  --network-metric directivity:3,4,1:0.5 --network-metric isolation:4,1:0.5 \
  --network-metric phase:2,3,1:1
```

Every selected change must be strictly below tolerance, and both runs must meet their energy
end criteria. Complex S-parameters are interpolated at the fixed frequency; extrapolation is
refused. Missing ports/columns, nonfinite samples, or responses at/below 1e-4 amplitude are
unavailable and prevent convergence. This conservative guard against five-decimal storage is not a
measured isolation limit. Select appropriate driven ports with `--excite`.
The study JSON adds `network_criteria`, per-run `network` values and per-step `network` checks
only when opted in; project bundles and design schemas gain no fields. The text table lists each
criterion's change and tolerance. Numerical convergence alone does not establish analytical
agreement, and the existing exit-code contract remains unchanged.

## `fairbeam material-cell`

Characterizes a material sample or a surface at normal incidence. The model's
`build(p)` creates an `fairbeam.material_cell.PlaneWaveCell` around the sample: a TEM cell with
PMC walls in x (normal to H), PEC walls in y (normal to E) and PML in z, a soft E_y sheet as the
source and a voltage probe on a reference plane on each side. The sample must fill the cross-section
or be symmetric with respect to the walls. The command runs the empty cell (same mesh, source and
probes) and the sample cell, both at one timestep: it reads each run's own step from an openEMS
setup and runs both at the smaller one (a dispersive sample, e.g. a Drude eps' < 1, can need a
shorter step than vacuum). It refuses to run when that step does not resolve the poles of a
dispersive sample (`fairbeam.dispersion.resolution_problems`). It refers S11 and S21 to the sample
faces with the vacuum wave impedance as the reference. If the model also defines
`analytic_layers(p)` (a list of `{thickness, eps_r, tan_d, tan_d_freq, mu_r}`, or
`{thickness, dispersion}` for a frequency-dependent layer, front to back), it prints the
deviation from the transfer-matrix slab (`fairbeam.analytic.slab_s`).
`python/examples/slab_cell.py` (constant materials) and `python/examples/dispersive_cell.py`
(Debye, Lorentz, Drude, Djordjevic-Sarkar FR4) are the examples;
[VALIDATION.md](VALIDATION.md#15-plane-wave-material-cell-homogeneous-slab) has their results.

| Option | Default | Meaning |
| --- | --- | --- |
| `--set`, `--name`, `--threads`, `--sim-root`, `--quiet`, `--engine`, `--end-db`, `--no-exact` | as for `run` | |
| `--out DIR` | current folder | Folder for `<slug>.cell.json` |
| `--points N` | `401` | Frequency points from `f_min` to `f_max` |
| `--tol DS` | | Exit with status 1 when the complex S11 or S21 differs from the analytic slab by more than DS |
| `--nist` | off | Declare the sample non-magnetic: also extract εr(f) with the NIST iterative method (μr = 1), and let NRW take the unit-μ branch where it resolves (needed above an opaque band) |
| `--nrw-floor S` | `0.3` | NRW reliability criterion: frequencies beyond the first half wave with \|sin(β′d)\| < S are marked unreliable |
| `--tol-material REL` | | Exit with status 1 when an extracted εr′ or μr′ differs from the model's single analytic layer by more than REL (relative) or a loss tangent by more than REL (absolute) |

The result file (`"kind": "fairbeam.material-cell"`) is not a project bundle and the viewer does
not open it yet. It holds `frequency`, `s11` and `s21` (`{re, im}`), `R2`, `T2`, `absorption`, the
cell geometry (`cell`: faces, reference planes, source plane, boundaries, the cut-offs of the
cell's higher-order modes `f_higher_mode` and `warnings`), both runs' `run_stats`
and, with `analytic_layers`, the analytic `s11`, `s21` and the `deviation`. The raw data of the two
runs go to `<sim-root>/<slug>/reference/` and `.../sample/`.

The command warns when `f_max` reaches a higher-order mode of the cell, where the reference
planes no longer see the plane wave alone: above c / (2 max(a, b)) for a sample that is not
mirror-symmetric about the cell's centre planes, above c / max(a, b) for any structured sample. A
homogeneous slab excites no such mode.

### Material parameters

For a sample of positive thickness d (`back - front` of the cell) the command extracts the
material parameters from S11 and S21 (`fairbeam.nrw`) and writes them to the result's `material`
section. A sheet (`front == back`) gets none.

- **NRW** (Nicolson-Ross-Weir, always): εr(f), μr(f), the dielectric and magnetic loss tangents
  and the refractive index. The logarithm of the transmission term is multivalued. The branch is
  the one whose phase index matches the group index c·τ_g/d (Weir). It is chosen per stretch of the
  band between opaque frequencies (\|S21\| < −60 dB, e.g. a Lorentz absorption line or a Drude
  metal), at the stretch's low or high end, whichever is less dispersive (`nrw.segments`). The
  phase turned inside an opaque band is lost. So a stretch that does not start at the band's
  lowest frequency (one above an opaque band, or after an initially opaque one) is marked
  unreliable unless the sample is declared non-magnetic (`--nist`) and the unit-μ branch
  resolves: exactly one branch keeps the complex μr within 0.1 of 1 over the stretch. With
  `--nist` the first stretch also checks that branch: if it resolves it must agree with the
  group-delay branch, or the stretch is unreliable (over a narrow band a thick magnetic sample
  has a wrong branch with μr ≈ 1); if it does not resolve (a magnetic sample), the stretch keeps
  the group-delay branch. Opaque and isolated frequencies get no values, and a
  sample that is opaque everywhere gets no material parameters (the command says so).
  NRW is ill-conditioned where the sample is a multiple of half a wavelength thick (β′d = mπ):
  S11 vanishes there for a low-loss sample, and the S-parameter errors enter εr and μr as about
  1/\|sin β′d\|. Those frequencies are marked `reliable: false` too (`--nrw-floor`). The branch and
  the comparison with the analytic layer use the reliable ones only.
- **NIST** (`--nist`; Baker-Jarvis et al., 1990): εr(f) for a non-magnetic sample. At each
  frequency it finds the ε whose closed-form slab S11 and S21 fit the simulated ones best
  (least squares). It starts at the lowest reliable NRW value and continues from each solution to
  the next frequency. It has no half-wave instability, so it gives the loss tangent of a low-loss
  sample far better than NRW. It assumes μr = 1, so for a magnetic sample its result is wrong;
  the command warns when the NRW median μr′ is more than 5 % from 1.

With e^{+jωt}, ε = ε′ − jε″ and tan δ = ε″/ε′. A sample built with `Simulation.dielectric` has a
constant conductivity, so its loss tangent falls as 1/f and equals `tan_d` only at `tan_d_freq`.
The extraction reproduces that curve, and the comparison uses the same model
(`fairbeam.analytic.layer_constants`). The `material` section holds:

- `thickness`;
- `nrw`: `eps_r` and `mu_r` (`{re, im}`), `tan_d`, `tan_d_mu`, `group_index`, `branch` (of the
  first stretch, `null` when there is none), `segments` (each stretch's `f_min`, `f_max`,
  `branch`, `misfit`, `after_opaque`, `method` and `branch_resolved`), `reliable` and `criterion`;
- with `--nist`, `nist`: `eps_r`, `tan_d`, `iterations`, `converged` and `residual`;
- with a single analytic layer, `expected` and `deviation`. For a frequency-dependent layer, use
  the complex relative errors `max_rel_eps` and `max_rel_mu`: where ε′ crosses zero (Lorentz,
  Drude), the relative ε′ error and the loss tangent are not meaningful. `--tol-material` uses only
  these two in that case.

### Waveguide fixture

A model whose `build(p)` creates an `fairbeam.waveguide_fixture.WaveguideFixture` instead runs the
rectangular-waveguide transmission/reflection setup: the sample fills the a × b
cross-section (default WR-90) between two TE10 waveguide ports, PEC walls in x and y, PML behind
both ports. Use `Simulation(..., excitation="gauss")`: the default Gaussian-derivative pulse
reaches down to DC, and the part of its energy between the filled and the empty guide's TE10
cut-off stays trapped in a sample with εr·μr > 1 (the fixture warns). The command then:

- reads each run's own timestep from an openEMS setup and runs the empty guide and the sample at the
  smaller one, and checks afterwards from the port probes' time axis that both used it (as for the
  plane-wave cell, a step that does not resolve a dispersive sample's poles is refused);
- takes S11 and S21 from the port waves (reference: the TE10 wave impedance η0·k0/β0) and refers
  them to the sample faces with β0 simulated in the empty run between the two reference planes;
- compares with `analytic_layers(p)` through the guided transfer-matrix slab
  (`slab_s(..., kc=π/a)`);
- extracts εr and μr with the guided NRW and NIST forms (β_s = j·ln T / d, μr = z·β_s/β0,
  εr·μr = (β_s² + kc²)/(β0² + kc²)), using the simulated β0.

The band must start above the empty guide's TE10 cut-off c/(2a) (an error otherwise), and the
command warns when `f_max` reaches its TE20 or TE01 cut-off. The filled section's cut-offs (divided
by √(εr·μr)) are only reported: a homogeneous sample filling the cross-section does not couple
TE10 to them. The result file adds `"setup": "waveguide"` (the plane-wave cell writes
`"plane-wave"`), `z_ref` per frequency, `beta0` (`measured`, `analytic`, `max_rel_difference`),
the empty run's `s11` and face-referred `s21` under `empty`, and the fixture geometry and cut-offs
(`cutoffs_empty`, `cutoffs_filled`) under `cell`. `python/examples/wr90_fixture.py` is the
example; [VALIDATION.md](VALIDATION.md#17-waveguide-material-fixture-wr-90) has its results.

**Air gap.** A real sample rarely fills the guide. `WaveguideFixture(..., gap_x=, gap_y=)` leaves
an air gap between the sample and each narrow wall (`gap_x`) and each broad wall (`gap_y`), the
same on both sides (default 0: the sample fills the guide). Build the sample over
`fixture.sample_span(z0, z1)`. The example takes them as `--set gap_x=` / `--set gap_y=` (mm).

- **Mesh.** At least two cells cross each gap, graded to the air resolution. The timestep follows
  the smallest cell, so a 0.025 mm gap takes 41 times the timesteps of the filled guide at
  20 cells/λ (27 at 30).
- **Higher modes.** A symmetric gap excites TE30 (narrow walls) and TE12 / TM12 (broad walls). The
  fixture checks that they decay by 40 dB at f_max before the reference planes, and moves the
  planes out (with a warning) when they would not. The cut-offs and decays are in
  `cell.air_gap.higher_modes`.
- **Correction.** The extracted εr is then the apparent one. The command also gives εr corrected
  for the gap (`fairbeam.waveguide_fixture.gap_correction`, after NIST TN 1355-R, Appendix C):
  - at the broad walls, where E crosses the gap, by default the transverse resonance across the
    guide height, solved at each frequency (`model="resonance"`, TN 1355-R C.1.1). The quasi-static
    series-capacitor model (`model="capacitor"`, C.2.2) is its low-frequency limit and
    over-corrects larger gaps (+2.2 % at 0.2 mm per side in WR-90, against +0.44 % for the
    resonance model);
  - at the narrow walls, in both models, a TE10-weighted parallel-layer model (first order).

  The resonance-corrected values are in `material.gap_correction` (`nrw`, `nist`, and with an
  analytic layer their `deviation`), the capacitor ones under `material.gap_correction.capacitor`;
  the `nrw` / `nist` sections keep the apparent ones. With a gap, `--tol-material` checks the
  resonance-corrected deviations. The analytic slab comparison is still the sample filling the
  guide, so it shows the gap's effect.

## `fairbeam debye-fit`

Fits a pole model to εr(f) for `Simulation.dispersive` (`fairbeam.debye_fit`). The model is
ε∞ + Σ overdamped Lorentz poles, each one a Debye-like relaxation. It is written as a
`LorentzMaterial` because openEMS 0.37.0rc3's DebyeMaterial diverges above ΣΔε/ε∞ ≈ 0.3 in 3D (0.6 in 1D)
([VALIDATION.md §15c](VALIDATION.md#15c-dispersive-materials-debye-lorentz-drude-djordjevic-sarkar)).
`Simulation.dispersive` uses the same fit for Debye poles; Lorentz and Drude poles of the same
material are kept as they are (overdamped poles cannot represent a resonance or ε′ < 1). The relaxation frequencies are
log-spaced over the fit range, and the strengths come from non-negative least squares on the real
and imaginary parts. The result is therefore passive and causal, and openEMS simulates exactly the
fitted function. Every pole is bounded by the FDTD timestep: dt/τ ≤ 0.5 and ω·dt ≤ 0.5 for the
pole and plasma frequencies (`fairbeam.dispersion.resolution_problems`). This caps the highest
relaxation frequency at about 0.08/dt.

```bash
fairbeam debye-fit --datasheet 1e9:4.4:0.02 --f-min 1e9 --f-max 10e9 -o fr4.dispersion.json
fairbeam debye-fit result.cell.json --method nist -o measured.dispersion.json
fairbeam debye-fit measured.csv --kappa --dt 1e-12
```

| Option | Default | Meaning |
| --- | --- | --- |
| `INPUT` | | A `.cell.json` (`material.nist` or `material.nrw`) or a CSV with a header: `f` (Hz) and `eps_re`, `eps_im` (ε′ − jε″, so `eps_im` ≤ 0 for a lossy sample), or `f`, `eps_r`, `tan_d`. Only valid measurements are fitted (see below) |
| `--datasheet F:EPS:TAN` | | Instead of an input: datasheet values (repeatable) for a Djordjevic-Sarkar laminate, ε(ω) = ε∞ + Δε/(m2 − m1)·log10((ω2 + jω)/(ω1 + jω)). One point is matched exactly, several by least squares. The laminate is fitted from f_min/10 to 10·f_max |
| `--m1`, `--m2` | `4`, `12` | Djordjevic-Sarkar corner frequencies ω1 = 10^m1, ω2 = 10^m2 rad/s |
| `--f-min`, `--f-max` | the data range | Fit range in Hz (with `--datasheet`, the simulation band; required) |
| `--method auto\|nist\|nrw` | `auto` | Which extraction of a `.cell.json` to fit (NIST when present) |
| `--poles N` | 4 per decade, at least 5 | Candidate poles; those NNLS does not need are dropped |
| `--dt S` | the CFL step of a 20 cells/λ cube mesh at f_max in the material | The timestep the poles must be resolved by. Pass the real one when it is known |
| `--kappa` | off | Also fit a static conductivity (measured data with DC loss) |
| `-o FILE` | `<input>.dispersion.json` | Output (`"kind": "fairbeam.dispersion"`); `fairbeam.dispersion.Dispersion.load(path)` reads it |

From a `.cell.json` the command leaves out every frequency that is not a valid measurement:
- non-finite values;
- frequencies where \|S21\| is below −60 dB (an opaque sample, whose phase is not measurable);
- for NIST, those where the iteration did not converge (`nist.converged`);
- for NRW, those its `reliable` mask rejects: half-wave resonances, and stretches above an opaque
  band without a clear branch.

From a CSV it leaves out the non-finite rows. A saved mask whose length or type does not match
the frequencies is an error. The command prints how many frequencies it used and left out, and
why, and records this in the output's `source.samples`. If fewer valid frequencies are left than
the fit has unknowns (ε∞, the candidate poles, and κ with `--kappa`), it stops with an error
instead of fitting an underdetermined model. Lower `--poles` in that case.

The command prints the fit's largest εr′ (relative) and tan δ (absolute) errors and warns about
any pole the timestep does not resolve. `Simulation.dispersive(name, DjordjevicSarkar(...))` does
the same fit at build time, bounded by the mesh's CFL step (`Simulation.cfl_timestep`), so build
the mesh first. A run checks the poles against its real timestep (`run_stats["dispersion_problems"]`).

A model written as JSON (`to_dict()`, a `.dispersion.json`, a bundle's `material.dispersion` or its
`source`) is read back with `fairbeam.dispersion.model_from_dict`. It returns a `DjordjevicSarkar`
or a `Dispersion` by the dictionary's `model` and refuses any other model rather than drop its
frequency dependence. `Simulation.dispersive` and `analytic.slab_s` layers take such a dictionary
directly. A Design file has no dispersive dielectric yet, so opening a Python model
that uses one as a Design stops with an error instead of writing its band-centre values.

## Raw simulation data (`.sim/`)

Every openEMS run writes a folder of raw output (probe time series, NF2FF and field dumps; often
hundreds of MB) under `--sim-root` (default `.sim/`). The bundle is the product: the raw folder is
only needed until the bundle is written. What removes it:

- **Run server jobs** write to `.sim/runs/<job id>/`; deleting a run in the Recent runs list removes
  that folder too (only if it lies inside the sim root, symlinks resolved).
- **Optimizations** remove each evaluation's raw folder right after its bundle is written. Keep them
  with `fairbeam optimize --keep-sim` or `FAIRBEAM_KEEP_SIM=1`.
- **`fairbeam clean-sim`** removes run folders (folders holding openEMS output such as `et`,
  `port_ut*`, `nf2ff*.h5`) whose newest file is older than `--older-than` days (default 7, `0` for
  all), prunes the folders left empty and prints the bytes freed; `--dry-run` only lists them. It
  never touches `.sim/jobs/` (run history), `.sim/model-history/`, anything outside the sim root or
  symlinked into it, a folder a run is still using (a `.<name>.fairbeam-running` marker with a live
  pid next to it, written by `fairbeam run`, sweeps and optimizations), or one written to in the last
  10 minutes.
