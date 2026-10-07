# Run server and the Run panel

## Run simulations from the UI

The viewer can edit a model's parameters, preview the geometry live and run openEMS itself when the local run server is running next to it:

```bash
npm run serve        # fairbeam serve on http://127.0.0.1:5320 (uses ~/opt/openEMS/venv/bin/python)
npm run dev          # the viewer; /api is proxied to the run server
npm run app          # or: build the viewer and serve it and the API on one free port (fairbeam app)
```

The desktop app starts the server itself. A **designer file** runs from the ribbon: Simulation › **Run** (or the header's **Run** button) opens the Run dialog (engine, threads, S-parameter sample points, an optional result name). It saves the design first and refuses to start while the Checks list has errors. The dock shows the progress (Run tab), the design's earlier runs (Runs tab) and the log (Log tab); the ribbon's Optimize tab has **Parameter sweep** and **Optimizer** (the designer's sweep dialog takes up to 500 grid cells and named sequences). A **Python model** (Start › Python models) runs from the Run panel described next, which replaces the spec sheet on the right; the bundled examples are read-only and have no Run panel. The Run panel:

- **Model and parameters.** The form is generated from the model's `PARAMS` (label, unit, min/max). When the open project was made from that model, its values are filled in. Changed fields are marked and can be reset one by one.
- **Live geometry preview.** About 0.4 s after an edit the server builds the model (like `fairbeam geometry`, nothing is written) and the 3D view shows it with a "Preview (not simulated)" badge. "Back to project" or closing the panel restores the project.
- **Run name** (optional): the project file is named after it (`Dipole 60 mm` → `dipole-60-mm.json`); without it the file is named from the model and the changed parameters.
- **Sweep.** Switch the Run section to *Sweep*, pick one or two numeric parameters and give a range (start, stop, steps) or a list of values. The panel shows the number of runs (at most 25) and an estimated total time from the last run of that model. The server expands the sweep into individual jobs tagged with a shared sweep id.
- **Start simulation** queues an `fairbeam run` job (one job at a time, threads default to Auto: physical cores minus one, at most 4 on small grids; see docs/BENCHMARKS.md, "Threads: what Auto does"). The progress card shows the phase, timestep, throughput, field energy against the end criterion, elapsed time and an estimated remaining time, a live convergence chart and the log. openEMS reports the energy only about every 4 s, so short runs show one sample or none. Cancel stops the whole process group.
- **Recent runs** lists earlier jobs with their status, duration and parameters; click a finished run to open its bundle, or a running one to follow it. Sweeps are grouped: expand one for a sortable table (parameter values → first band best match, min |S11|, Dmax, efficiency; for multi-port models |S21|, worst |Sii| and isolation at the first band center or a frequency you type), **Compare** (opens up to eight of its runs as overlaid traces) or **Cancel sweep**. Filter by model and status. The bin icon removes a run from the history; its project file is only deleted if you tick "Also delete the project file" (and only files inside the projects folder). History and logs are kept in `.sim/jobs/<id>/` and survive server restarts. Each job's raw openEMS output goes to `.sim/runs/<id>/` and is removed when the run is deleted from the history; `fairbeam clean-sim` removes old raw folders of runs still listed (see [CLI.md](CLI.md#raw-simulation-data-sim)).

### Runs started elsewhere, and the queue

The queue belongs to the server, not to the window: a run submitted by a script, a coding agent or
another window (`POST /api/runs`, or `fairbeam run --server` from a terminal, see
[CLI.md](CLI.md#runs-the-app-shows---server)) waits in the same queue and shows in the open app within
seconds. The app looks at `/api/health` every 5 s while it is visible (a 2 ms request), and at once when its window
comes back to the front; the health's `queue` (`running`, `queued`, a `version` counter bumped on every
change, and `external`: `fairbeam run` processes outside the server) changing makes it fetch the run
list again, and the results index when a run ended. A run that keeps the server busy changes **Start
simulation** to **Queue simulation** and says which run is in front; the designer follows a run of the
open design that another client started, and its status bar shows the server's other runs.

- **Recent runs**: a waiting row has **Remove from queue** (×), the running row **Stop** (■); **Clear
  queue** takes every waiting run out (`POST /api/queue/clear`), the running one goes on.
- **Designer**: the dock's **Queue** tab lists every queued or running run of the server (also other
  models' and other clients'), each with **Follow**, **Stop** or **Remove from queue**, and **Clear
  queue**. The dock's **Cancel run** stops the run the dock shows, else the run the window follows, else
  the server's running run.
- A run started from a terminal without the server (`fairbeam run` writing into the same sim root) is
  not queued: the preflight and the Run panel say it is using the CPU.

New designer jobs retain the checked `.design.json` submitted to the server. Editing that
source afterward does not change an already admitted run, sweep, optimization or convergence
study. Missing or altered job-local copies fail before launch. Python models, imported modules
and legacy jobs still use their original paths. See [admitted inputs](QUEUED-DESIGN-INPUTS.md)
for provenance and the separate client-preflight limitation.

## Explicit run setup

In the designer's Simulation settings, **Run setup** offers Quick exploration (10 cells per
wavelength, -40 dB), Balanced (20, -40 dB), and Refinement check (30, -60 dB). Selecting a setup
does not edit the design: **Apply setup** changes automatic mesh resolution and the energy
stopping criterion as one undoable edit. **Cancel** restores the draft and its history from when
the dialog opened. Geometry, frequency band, boundaries, monitor settings, and the timestep
limit are preserved. A manual mesh is never replaced by these setups. A refinement setup is a
starting point for convergence checks, not a validation of antenna performance.

The Run dock distinguishes an early projection from a range of recent projections. That range
is a bounded display envelope, not a statistical confidence interval. Worsening projections are
shown immediately; improving ones are smoothed with a small bounded lag. Raw estimates, basis,
confidence, sample count, current-port and whole-job projections remain in the technical detail.
The time to the timestep cap is separate from convergence time. Postprocessing and export show
their own phase instead of retaining an old solver ETA.

Memory admission is refreshed after the mesh is built, immediately before each solver starts,
including queued runs, sweeps, and optimizer evaluations. It uses current free memory rather
than only the earlier preview. CUDA VRAM availability remains unknown; the estimate is not a
thermal or power limit. Windows CPU availability respects the process affinity mask on ordinary
single-group hosts, with a portable fallback when it cannot be read.

## Python script to design

`POST /api/design/from-python` with `{source, model?}` builds a Python model script (`MODEL`, `PARAMS`, `build`) into a design without saving it or running the solver; the designer's Python panel calls it on **Apply**. It answers `{design, python, normalized, output}`: the design (`fairbeam.design/1`), the script written again from it (`design.to_python`, headed by `model`: the name, id and description of the open design), whether that script builds a different design than the one sent (the panel then shows it), and what the script printed (the last 4000 characters). A failure is a 422 with `{error, line?, timeout?}`, where `line` is the 1-based line of the script the exception came from (a syntax error has it too).

The script is converted by `python/fairbeam/python_design.py`, which uses the example converter (`example_design.convert_example`): the script runs in a child process (`python -m fairbeam.python_design`, the same Python as the server) that builds it at the parameter defaults, reads the CSXCAD geometry back and fits the expressions. `openEMS` is replaced by a subclass whose `Run` raises and `Simulation.run` raises, so the solver never starts. Limits: 20 s (the child and anything it started is killed, `timeout: true`), 512 KB of source, one script at a time (429 while another is applied). This is not a sandbox: the script is the user's own Python and runs with the server's rights.

## My materials

`GET /api/materials/user` answers `{materials, skipped, file}`: the designer's personal material library
(**My materials**) from `<workspace>/materials.json`, the parent folder of `models/` (`~/Documents/Fairbeam`
on the desktop), so it survives a reinstall. A missing file is an empty list; a damaged one is ignored and
reported in `skipped`. `PUT /api/materials/user` with `{materials: [...]}` validates the list and writes the
file atomically; it answers like the GET, with the entries that were kept, and `skipped` lists one line for
every entry that was dropped (`422` if `materials` is not a list). An entry is `{id, name, kind, eps_r?,
tan_d?, tan_d_freq?, conductivity?, thickness?, color?}`: `kind` is `metal` or `dielectric`, numbers are plain
numbers (`tan_d_freq` in GHz, `conductivity` in S/m, `thickness` in mm), `color` is `#rrggbb`, and ids and
names are unique. Designs never refer to the file: the designer copies an entry into the design. Without a
run server, the designer keeps the list in the browser's localStorage. Implementation:
`python/fairbeam/usermaterials.py`.

## Optimize

The Run section's **Optimize** mode tunes one to three parameters towards goals: tune the resonance to a frequency, match (|S11| at a frequency), a minimum bandwidth or directivity, and for multi-port models match all ports, isolation / coupling at most (|S_ij|) or transmission at least. A multi-port evaluation runs openEMS once per driven port; by default only the ports the goals need are driven, and the time estimate counts them. Each evaluation is a full simulation (on the GPU engine when the server's python has it, about 1–3 s for the small models). The card shows the cost of every evaluation on a log scale, a sortable table of evaluations with the best one highlighted, and, when it finishes, **Open best** and **Compare best vs start**. The same optimizer runs from the command line (`fairbeam optimize`); see [OPTIMIZE.md](OPTIMIZE.md) for the goals, algorithms and measured examples (dipole f0 to 2.40 GHz in 2 evaluations; patch f0 = 2.45 GHz with |S11| < −25 dB in 15; Wilkinson isolation resistor to 73 Ω, S23 −37.9 dB, in 4 single-port evaluations).

Multi-port models run openEMS once per driven port; the progress card then labels the solver phase "FDTD · port 2/3", draws the current port's energy trace and estimates the time for the whole job.

For S-parameter and resonance goals that do not need a far field, optimizer evaluations remove
their unused NF2FF E/H recording properties before solving. This avoids unnecessary field-file
writes as well as the later transform. A requested far field, a directivity goal or an efficiency
monitor keeps the recordings. Other field monitors, the mesh and stopping criteria are unchanged.
Older CSXCAD bindings without property deletion retain the recording overhead and report that
compatibility limitation. This applies on every platform; it does not change the default thread
count or promise a fixed speed-up.

## Compare projects

In the Examples viewer, **Compare** in the dock bar pins up to seven other projects next to the open one (this works without the run server). In the designer, Ctrl/⌘-click runs in the navigation tree (or pick them in the dock's Runs tab) to compare up to eight runs. Reflection, Impedance (Re or Im) and Pattern (φ = 0° or 90° cut, at each project's far-field frequency nearest to the selected one) then show one trace per project in the fixed series colors, with a legend, direct labels and a tooltip that lists every project at the hovered frequency. Projects with different frequency grids are interpolated onto a common grid. The matched-band shading and far-field markers stay with the open project. The Table view shows one column group per project.

The server binds to 127.0.0.1 only, accepts only local `Host`/`Origin` headers and JSON POST bodies, and has no side effects on GET. Options: `--port` (or `FAIRBEAM_API_PORT`, default 5320), `--projects`, `--models`, `--jobs`, `--sim-root` (raw openEMS output, default `.sim`), `--python` (or `FAIRBEAM_PYTHON`) for the python that runs jobs and previews, `--ui DIR` (also serve a built viewer, `dist/`, at `/`) and `--exit-with-parent` (stop when the launching process exits). The endpoints are listed at the top of `python/fairbeam/server.py`. If the viewer runs against a server on another port, start it with `FAIRBEAM_API=http://127.0.0.1:<port> npm run dev`. Without the server the viewer works as before and the Run panel only shows how to start it.

**If the server is killed** (SIGKILL, a crash) while a job runs, the job's process group keeps running. On the next start the job is marked `interrupted`, and if its recorded pid is still alive *and* still the same process (the start time and command line saved in `job.json` match) the whole process group is stopped (SIGTERM, SIGKILL after a grace period) before any new job can start; a note is written to the job's log. A pid that cannot be matched this way is never touched. (Windows: jobs run inside a job object that takes the whole tree with it when the server dies, so this is a fallback there; the match uses the process creation time and command line, and a matching tree is stopped with `taskkill /T /F`. See [WINDOWS.md](WINDOWS.md).)

**Memory.** A running job keeps all its events in memory; a finished one keeps its last 500 events plus the status, phase, info, stats, result and optimization events. `events.jsonl` always stays complete, and an SSE client that asks for older events (`Last-Event-ID` or `?after=`) gets them read back from it.
