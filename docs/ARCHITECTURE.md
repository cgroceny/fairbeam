# Architecture

Fairbeam has two halves joined by one file format:

- A **Python side** that builds and runs openEMS simulations and post-processes them.
- A **browser side** that displays the results and exports them to other tools.

The two halves never talk to each other directly. The contract between them is the project bundle (`fairbeam.project/1`, see [BUNDLE.md](BUNDLE.md)).

## Data flow

```
python/models/<model>.py                       MODEL, PARAMS, build(p)
        │  fairbeam run <model> --set k=v
        ▼
fairbeam.model.load_model / resolve_params     parse --set against PARAMS (type, min, max)
        │
        ▼
build(p) -> fairbeam.Simulation                openEMS + CSXCAD setup, plus recorded metadata:
        │                                      materials (tan δ, color), ports, excitation,
        │                                      boundaries, NF2FF phase center, focus box
        ▼
Simulation.run(sim_path, threads)              openEMS FDTD in .sim/<slug>/
        │                                      C++ stdout/stderr captured via fd redirect,
        │                                      parsed into run stats (grid, timesteps, speed,
        │                                      energy trace, convergence)
        ▼
Simulation.evaluate(n_freq, pattern_freqs)     port quantities -> S11, Zin, bands (< -10 dB)
        │                                      NF2FF -> directivity grid, Prad, Dmax with
        │                                      PEC/PMC mirror correction, efficiency, gain,
        │                                      realized gain; downsampled port time signals
        ▼
Simulation.to_bundle(MODEL, params)            geometry.read_structure: exact primitives
        │                                      (box, polygon, linpoly, cylinder) + mesh lines
        ▼
public/projects/<slug>.json  +  index.json     atomic write (.json.tmp -> rename), index rebuilt
        │
        ├──► viewer (src/)                     fetch /projects/index.json, then the bundle;
        │                                      three.js scene, charts, tables, spec sheet
        │
        └──► macro exporter (src/export/cst.ts)    CST-compatible VBA macro with AddToHistory
                                               blocks: units,
                                               materials, bricks/polygons/cylinders, ports,
                                               boundaries, far-field monitors, solver range
```

### Python side (`python/fairbeam/`)

- `model.py` defines `Param` and loads model files by path. A model file is ordinary Python, so it can compute geometry however it likes. The Sierpinski model, for example, generates its triangles recursively and clips its contact bridges.
- `simulation.py` holds `Simulation`. It adds no abstraction over openEMS: `sim.fdtd`, `sim.csx` and `sim.mesh` are the native objects. It only records what openEMS does not keep in a form we can export later:
  - dielectric loss as tan δ rather than conductivity
  - port definitions
  - the excitation formula
  - boundaries
  - the NF2FF phase center
- `excitation.py` builds the DC-free Gaussian-derivative pulse. It is the default because openEMS' modulated Gaussian leaves static charge on wideband runs, and those runs then never reach the energy end criterion.
- `geometry.py` walks the CSXCAD structure and writes every primitive exactly. Nothing is tessellated. Unknown primitive types fall back to a bounding box marked `exact: false`.
- `design.py` (with `design_checks.py`, `automesh.py`, `materials.py`, `starters.py`, `example_design.py`) handles designer files: a model described as data (`<id>.design.json`) instead of Python, built into the same `Simulation`. `cst_import.py` turns a CST-compatible VBA macro into such a design.
- `cli.py` provides `run`, `geometry` (export without solving), `params`, `import-cst`, `index`, `serve`, `app` and `clean-sim`. `study.py` adds `sweep`, `converge` and `touchstone`, and `optimize.py` adds `optimize`.
- `server.py`, `jobs.py`, `progress.py` and `preview.py` make up the local run server (see [Run server](#run-server-fairbeam-serve)). Usage counting is confined to the desktop shell, with no run-server counters (see [TELEMETRY.md](TELEMETRY.md)).

### Browser side (`src/`)

- A static Vite + SolidJS + TypeScript application. `designer/` is the visual designer (ribbon, navigation tree, main-area tabs for the 3D view and the result plots, dock); `home/` is the Start screen. Viewing needs no server component: `npm run dev` or any static file server that serves `public/` is enough. The optional run server adds editing and running (`src/runner/`, `components/RunPanel.tsx`); the dev server proxies `/api` to it.
- `types.ts` mirrors the bundle schema. When the Python bundle changes, this file changes in the same commit.
- `scene/` rebuilds the geometry from primitives and draws it. The primitives are boxes, polygons in any axis-normal plane, extruded polygons and cylinders. The scene also shows ports, the PEC half-space ground, the mesh plane, the domain, the NF2FF box and the 3D directivity surface. It renders on demand only.
- `charts/` draws |S11|, Zin, the Smith chart, polar pattern cuts and port time signals. Every chart has a table view.
- `export/cst.ts` generates a CST-compatible VBA macro from the bundle (and, for a parametric export, the design it was built from).

### Why a bundle file

- **Reproducible.** A bundle contains the parameters, solver settings, mesh and results of one run, plus the generator versions. It is enough to review a result without the model file or openEMS.
- **Decoupled.** The viewer and the exporters depend only on the schema. Any tool can produce bundles if it writes the schema; a different solver backend would only have to do the same.
- **Portable.** Bundles are plain JSON and can be shared, versioned or opened on a machine without openEMS.

## Run server (`fairbeam serve`)

A stdlib `ThreadingHTTPServer` bound to 127.0.0.1. It orchestrates the Phase 1 CLI and never imports model files itself: models are arbitrary Python and CSXCAD is C++, so a broken model must not take the server down.

```
viewer (src/runner)  ──/api (Vite proxy)──►  server.py
                                               ├─ GET  /api/health          versions, CPUs, engines, folders
                                               ├─ GET  /api/models          preview.py describe (child, cached by mtime)
                                               ├─ POST /api/preview         preview.py worker (persistent child):
                                               │                            build(p) + to_bundle, returned inline
                                               ├─ POST /api/runs            validate -> jobs.JobManager.submit
                                               ├─ POST /api/sweeps          expand (≤ 25 runs) -> one job per point
                                               ├─ POST /api/sweeps/{id}/cancel
                                               ├─ POST /api/runs/{id}/delete  history entry (+ bundle on request)
                                               ├─ GET  /api/runs[/{id}]     history (newest first)
                                               ├─ GET  /api/runs/{id}/events  SSE: replay, then live
                                               ├─ GET  /api/runs/{id}/log   plain text
                                               └─ POST /api/runs/{id}/cancel
(more endpoints: designs, VBA macro import, examples, templates, model source and history,
 convergence studies, optimizations, shutdown: see the docstring of server.py and RUN-SERVER.md)
jobs.JobManager: queue, concurrency 1
  └─ child: python -m fairbeam run <model> --set k=v --threads N --out public/projects
       own process group, PYTHONUNBUFFERED=1, PYTHONPATH = this package
       stdout/stderr lines ─► progress.ProgressParser ─► events ─► .sim/jobs/<id>/events.jsonl
       exit ─► status event; public/projects/index.json rebuilt (cli.rebuild_index) first
```

- **Validation.** Parameter values are checked against `PARAMS` (type, whole numbers, min/max, unknown keys); errors come back as HTTP 422 with a message per field. Only values that differ from the default become `--set` overrides, so bundle names match the CLI's.
- **Job model.** Status `queued → running → done | failed | cancelled | interrupted`. Phases `queued, building, setup (mesh + operator), running (FDTD), postprocessing, exporting`, then the final status. Cancel sends SIGTERM to the process group and SIGKILL after 5 s. `.sim/jobs/<id>/` holds `job.json`, `log.txt` and `events.jsonl`; jobs that were queued or running when the server stopped are marked `interrupted` on the next start, and a job process that outlived a crashed server is stopped then, but only when its pid, start time and command line match `job.json`. Raw openEMS output goes to `.sim/runs/<id>/` and is removed with the job. Finished jobs keep only their last 500 events (plus the summary kinds) in memory; older ones are served from `events.jsonl`.
- **Events.** Every event has `seq` (1, 2, … — also the SSE `id`, so `Last-Event-ID` resumes), `at` (Unix time), `t` (s since start) and `type` (the SSE `event` name): `status`, `phase`, `log` (`stream`, `line`), `info` (label, end criterion, max timesteps, engine, grid, cells, timestep, threads), `progress` (timestep, MC/s, s/TS, energy dB, fractions, `eta`), `stats` (timesteps, solver time, speed, converged, hit_timestep_limit, bands, far field), `result` (bundle file) and `error`. Heartbeat comments every 15 s.
- **Progress and ETA.** `fairbeam run` prints `fairbeam: end criterion <dB> dB, max timesteps <N>, engine <e>` before openEMS starts; the parser uses the same openEMS line formats as `simulation._parse_log`. The ETA fits energy (dB) against timestep over the last four samples and extrapolates to the end criterion, capped by the timestep limit. It needs two samples; openEMS prints one about every 4 s of wall time. A run that stops at the limit is detected by `timesteps >= max timesteps`.
- **Sweeps.** `POST /api/sweeps {model, params, sweep: [{key, values} | {key, start, stop, steps}], threads, name?}` validates every value like a parameter, expands the cartesian product (first axis slowest, at most 2 axes and 25 runs; a `sequences` list instead of `sweep` allows up to 100 sequences, 6 axes each and 500 runs in all) and submits one job per point. Each job carries `sweep: {id, name, index, total, values, axes}`; with a name, the bundle files are `<slug>--<key>-<value>…`. The viewer groups the history by sweep id and reads per-run results from the jobs' `stats` (bands and far field with efficiency, parsed from the run output). For sweeps whose runs drove several ports (`info.port_total > 1`), `src/runner/SweepSummaryMulti.tsx` instead fetches the member bundles and shows |S21|, the worst |S_ii| and the worst output-to-output coupling from `results.sparams`, at each run's first band center or at a typed frequency.
- **Names and deletion.** `name` on a run is free text (≤ 80 characters, stored as `label`); its slug becomes `--name`, the bundle file name. `POST /api/runs/{id}/delete {delete_bundle}` removes a finished job's folder; the bundle is deleted only on request and only if it is a `*.json` directly inside the projects folder.
- **Previews** are geometry-only bundles with `"preview": true`, built by the same code path as `fairbeam geometry` in a persistent worker process (a few ms per build once warm).
- **Model files (editor).** `modelfiles.py` does the file work, the preview worker the Python work:

  | Endpoint | Body / result |
  | --- | --- |
  | `GET /api/templates` | `{templates: [{key, file, model, params, doc}]}` from `python/templates/*.py` |
  | `POST /api/models` | `{id, name?, template}` or `{id, name?, from: <model id>}` → `201 {id, file, source, hash, readonly, validation}`; the template's `MODEL["id"]` / `["name"]` literals are rewritten via the AST; `422` bad id (`^[a-z][a-z0-9_]{1,40}$`), `409` exists (created with `O_EXCL`) |
  | `GET /api/models/{id}/source` | `{id, file, source, hash, readonly}`; `hash` is the SHA-256 of the file |
  | `PUT /api/models/{id}/source` | `{source, base_hash}` → `{hash, backup, validation}`; `409 {current_hash}` if the file changed since `base_hash`, `403` for the bundled examples, `422` above 256 KB; atomic write (temp file + rename) after copying the previous version to `.sim/model-history/<id>/<YYYYMMDD-HHMMSS>.py` (50 kept) |
  | `GET /api/models/{id}/history[/{version}]` | last 20 versions `{version, saved, bytes, lines, hash}` / one version's source |

  `validation` is `{valid, model: {params, …}}` or `{valid: false, error: {message, stage: "load" | "build", location: {line, column?, text?, function?}, traceback}}`. The line comes from the `SyntaxError` position or from the innermost traceback frame whose file is the model file. `GET /api/models` entries carry `readonly`; a converted Design also exposes `python_source_model` so the Start screen can reopen the linked Design without duplicating it.
- **Optimizations.** `POST /api/optimizations {model, params, vary: [{key, min, max, start?}] (1–3), goals: [{kind: f0|s11_max|bw_min|dmax_min|sij_max|sij_min|match_all, target, at?, weight?, ports?: [i, j]}] (1–4), max_evals ≤ 40, method: auto|secant|nelder-mead, excite: auto|all|"1,3", engine, threads, name?}` queues a job of kind `optimize`. Multi-port goals read `results.sparams`; `excite: auto` drives only the ports the goals need (one openEMS run each, see [OPTIMIZE.md](OPTIMIZE.md#multi-port-goals-and-driven-ports)). The job runs `fairbeam optimize` in one child process (`optimize.py`, see [OPTIMIZE.md](OPTIMIZE.md)); its `fairbeam: optimize start|eval|done {json}` lines become `opt_start`, `opt_eval` (params, metrics, cost, best so far) and `opt_done` (reason, best, start) events, and the job's `stats` keep the best point. Members are written under `projects/optimizations/<name>/`, outside the project index. Cancel works as for runs.
- **Multi-port progress.** `fairbeam run` on a multi-port model prints `fairbeam: run k/n: port p excited` before each openEMS run. The parser then returns to the setup phase, resets the energy trace and rate estimate, tags `progress` events with `port_run`/`port_total`/`port`, and adds `eta.job_eta_s` = this port's remaining time + remaining ports × (mean of finished ports, else this port's projected total). Stats, bands and the result are printed once at the end.
- **Engines.** `engines` in `/api/health` lists `gpu` when the openEMS binary next to the job python's venv (`<prefix>/venv/bin/python` → `<prefix>/bin/openEMS`) offers a `gpu` engine; `POST /api/runs {"engine": "gpu"}` then adds `--engine gpu` to the run. `--python` / `FAIRBEAM_PYTHON` selects that python.

## Roadmap

### Phase 1: CLI and static viewer (done)

- Parametric Python models, CLI runner, project bundles and index.
- Viewer with exact geometry, far-field surface, charts, tables and spec sheet.
- CST-compatible VBA macro export.
- macOS install script. openEMS itself also ships Windows builds and Linux packages.

### Phase 2: desktop workbench (in progress)

Phase 2 is the desktop workbench. It uses a Tauri 2 desktop shell, a SolidJS UI, and a Python environment. The items below run on top of the local run server (`fairbeam serve`), in the browser or in the desktop shell.

- **Desktop shell** (released, `src-tauri/`, see [DESKTOP.md](DESKTOP.md)). A Tauri 2 app that installs a managed runtime (Python, packages, openEMS) on first start or uses an existing openEMS install (the GPU build first when it has one), seeds a workspace in `Documents/Fairbeam`, starts `fairbeam serve --ui <bundled dist> --exit-with-parent` on a free port in its own process group (Windows: a job object), shows a splash/setup page while `/api/health` comes up, then loads the viewer from `http://127.0.0.1:<port>/` (same origin as the API, so the Host/Origin checks apply unchanged; the served page can call only the fixed list of shell commands in `capabilities/viewer.json`). Quit sends `POST /api/shutdown` with a per-start token, and forces the stop after 8 s. Updates come from the release feed. macOS builds are signed with a Developer ID and notarized by Apple; the Windows installer is not code-signed (see [WINDOWS.md](WINDOWS.md#known-limitations)).
- **Same-origin serving** (implemented). `fairbeam serve --ui <dir>` serves the built viewer (`static.py`: MIME types, SPA fallback, immutable caching of hashed assets, traversal-safe, no listings) and `/projects/*.json` from the live projects folder; `fairbeam app` does this on a free port and opens the browser.

- **Local job runner** (implemented, `fairbeam serve`). Launch model builds and runs from the UI; the server spawns `fairbeam run` with the configured python (`--python`).
- **Generated parameter forms** (implemented). Input forms from `PARAMS`: label, unit, default, min/max and description, with per-field reset and server-side validation. Parameter edits update a live geometry preview.
- **Live progress** (implemented). openEMS output is parsed while it runs, using the same patterns as `_parse_log`: phase, timestep, speed, the energy trace against the end criterion, and an estimated time remaining.
- **Run queue and history** (implemented: queue with concurrency 1, cancel, persistent history with logs, run names, deletion, filters by model and status). Queue runs, and browse and re-open earlier bundles.
- **Optimization loop** (implemented: `fairbeam optimize` and the Run panel's Optimize mode, secant and bounded Nelder–Mead without scipy, goals f0 / |S11| at f / bandwidth / Dmax and the multi-port |S_ij| at most / at least and all |S_ii| at most, driving only the ports the goals need).
- **Parameter sweeps and comparison** (implemented for one or two parameters, up to 25 runs; overlays of up to eight projects or design runs in S-parameters, Impedance, Smith and Pattern, `src/compare/`). Run parameters over a range and overlay S11, Zin and patterns side by side.
- **Geometry export.** Export STEP and STL from the exact primitives (not built).

The bundle stays the contract in Phase 2. The desktop shell adds orchestration on top of the Phase 1 CLI and viewer, not a second data model.

## Project layout

```
fairbeam/
├── python/
│   ├── fairbeam/            Python package (installed editable into the openEMS venv)
│   │   ├── simulation.py    Simulation: setup recording, run + stdout capture, evaluate, bundle export
│   │   ├── geometry.py      CSXCAD structure -> exact JSON primitives
│   │   ├── excitation.py    DC-free Gaussian-derivative pulse
│   │   ├── mesh.py          mesh helpers (sliver-free line merging)
│   │   ├── model.py         Param, model loading, parameter resolution
│   │   ├── design.py        designer files (<id>.design.json), their checks, meshing and Python export
│   │   ├── cst_import.py    CST-compatible VBA macro -> design
│   │   ├── server.py        fairbeam serve: local HTTP API (models, designs, preview, runs, SSE)
│   │   ├── jobs.py          job queue: child processes, cancel, history in .sim/jobs
│   │   ├── progress.py      live parsing of run output: phases, progress, ETA
│   │   ├── preview.py       model description and geometry preview in child processes
│   │   ├── analytic.py      closed-form references (patch TL model, microstrip, dipole EMF + MoM)
│   │   ├── study.py         sweep / converge / touchstone commands, study files
│   │   ├── optimize.py      fairbeam optimize: bounded parameter search towards goals
│   │   ├── multiport.py     one run per driven port, S-matrix assembly, QA, element patterns
│   │   ├── array.py         array patterns from embedded element patterns, steering, active reflection
│   │   ├── touchstone.py    Touchstone .s1p/.sNp writer/reader
│   │   ├── network.py       opt-in ideal circuit references (TEM lines, lumped elements), matched-feed plane shifts
│   │   ├── telemetry.py     opt-in usage counts of the run server (off in every build so far)
│   │   └── cli.py           fairbeam run | params | geometry | import-cst | index | serve | app | clean-sim | sweep | converge | touchstone | optimize
│   ├── models/              models (dipole, patch_antenna, inset_patch, sierpinski_monopole, microstrip_line,
│   │                        wilkinson_divider, patch_array_2x1/4x1, branchline_coupler, lowpass_stepped,
│   │                        pyramidal_horn, helix_axial, minkowski_patch, ...)
│   ├── tests/               unittest suite (no openEMS runs)
│   ├── templates/           starting points for new models (blank, dipole, monopole_on_ground, patch_probe_fed, microstrip_line)
│   └── pyproject.toml
├── src/                     viewer: SolidJS + TypeScript + three.js (Vite)
│   ├── scene/               3D viewport, primitive builders, far-field surface
│   ├── charts/              line, Smith and polar charts
│   ├── components/          header, model panel, spec panel, dock, export dialog, run panel, general settings
│   ├── designer/            the visual designer: ribbon, navigation tree, main-area tabs, dock, dialogs
│   ├── home/                Start screen
│   ├── runner/              run workflow: API client, state, parameter form, progress, history
│   ├── export/cst.ts        CST-compatible VBA macro generator (also csv, Touchstone, PDF report, package)
│   ├── import/              Touchstone and CSV reference importers (the VBA macro import calls the run server)
│   ├── drawing/, editor/, compare/, lib/   technical drawings, code editor, overlays, shared helpers
│   ├── fab/                 fabrication export: layer extraction, Gerber X2, Excellon, DXF R12
│   └── types.ts             TypeScript mirror of the bundle schema
├── src-tauri/               desktop shell (Tauri 2, Rust): runtime, server lifetime, menus, updates
├── runtime/                 managed-runtime installer: pins.json, setup scripts, install.py
├── api/                     Vercel serverless function for the (off) usage statistics
├── landing/, landing-src/   the public site (landing page, guide, privacy page, scroll story)
├── examples/                VBA macro examples, drawings, example designs and fixtures
├── design-system/tokens.css design tokens (single source of truth for color, type, space)
├── public/projects/         bundles (<slug>.json) + index.json, served to the viewer
├── scripts/                 install scripts (install-openems-macos.sh, install-openems-gpu-*), release
│                            and site builders, and the check-*.mjs scripts behind `npm run check:*`
├── docs/                    guides and reference, indexed in docs/README.md
└── .sim/                    raw openEMS output (git-ignored; `fairbeam clean-sim` prunes it)
```
