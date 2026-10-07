# Sweeps, convergence studies and Touchstone export

Three CLI commands build on `fairbeam run`: `sweep`, `converge` and `touchstone`. The code is in
`python/fairbeam/study.py` and `python/fairbeam/touchstone.py`.

## `fairbeam sweep`

```bash
fairbeam sweep python/models/dipole.py --param length=50,58,66 --threads 4
fairbeam sweep python/models/inset_patch.py --param inset=6,8,10 --param feed_w=2.6,3.0 --set f_max=3.5
```

- Each `--param KEY=V1,V2,...` adds an axis. Several axes form a **cartesian** grid, iterated with
  the last axis fastest.
- `--set KEY=VALUE` fixes other parameters for every point.
- Every point is validated against the model's `PARAMS` (type, min, max) **before** any solver time
  is spent.
- Points run **sequentially**, one openEMS process at a time. `--threads` defaults to 4.
- Each point is a normal bundle, written to `<out>/studies/<name>/<slug>.json`.
- The study summary is written to `<out>/studies/<name>.json`. `<out>` defaults to `public/projects`,
  and `<name>` defaults to `<model-id>--sweep--<axes>`.
- Member bundles are **not** added to the gallery index (`public/projects/index.json`), so a
  20-point sweep does not flood it. Open a member directly, or load the study file.

| Option | Default | Meaning |
| --- | --- | --- |
| `--param KEY=V1,V2,...` | required | Sweep axis (repeatable) |
| `--set KEY=VALUE` | | Fixed override (repeatable) |
| `--name NAME` | derived | Study name |
| `--out DIR` | `public/projects` | Projects folder; the study goes to `DIR/studies` |
| `--sim-root DIR` | `.sim` | Raw openEMS output (`.sim/<study>/<slug>`) |
| `--threads N` | `4` | FDTD threads |
| `--points N` | `801` | Frequency points |
| `--pattern "2.4,5.8"` | band centers | Far-field frequencies in GHz |
| `--end-db DB` | model default | Energy end criterion, for example `-60` |
| `--no-exact` | off | Check the end criterion every ~4 s of wall time instead of every Nyquist period. The exact check (machine-independent stop; openEMS `--exact-endcriteria`) is the default; the old `--exact` flag is still accepted and does nothing |
| `--engine cpu\|gpu` | `cpu` (or `$FAIRBEAM_ENGINE`) | FDTD engine |
| `--excite all\|1,3` | all ports if <= 4, else 1 | Ports driven per point (one run each) for multi-port models |
| `--verbose` | off | Echo openEMS output |

### RunHistory sweep CSV

In the Run panel, expand a parameter sweep and choose **Compare all**, then **Export CSV**
or **Copy data**. Both use the same long table, with one row per job, including unfinished and
failed jobs. The columns are `run_index`, `sequence_index`, `sequence_name`, `status`, the sweep
parameter keys, `band_lo_ghz`, `band_hi_ghz`, `band_center_ghz`, `band_best_ghz`, `s11_min_db`,
`dmax_dbi`, and `radiation_efficiency_pct`. Band values describe the first matched band; far-field
values describe the first far-field frequency. Unavailable values are blank.

`band_center_ghz` is the middle of the band edges, `(band_lo_ghz + band_hi_ghz) / 2`;
`band_best_ghz` is the frequency of minimum |S11|. Previously, `band_center_ghz` held that minimum.
Older job stats without both edges leave the center blank while retaining the best-match frequency.
The RunHistory table labels its minimum-frequency column **Best match**. These CSV columns are
separate from the CLI study JSON format below, whose `f_center` remains the minimum frequency.

## `fairbeam converge`

### A design: mesh density

```bash
fairbeam converge python/models/my_patch.design.json --densities 15,20,30,40 --max-runs 4 --engine gpu
```

With a `.design.json` and no `--param`, the design runs at each automatic-mesh density in turn
(`mesh.cells_per_wavelength`; in the Auto mode its `cells_per_wavelength` override). After each run
it compares the resonance (S11 minimum), |S11| there, Dmax (with a far field) and the input
impedance with the previous run, and stops at the first step whose changes are all strictly below
`--tol-f` (0.5 %), `--tol-s11` (1 dB) and `--tol-dmax` (0.2 dB), or after `--max-runs` (4) runs. The
code is in `python/fairbeam/convergence.py`; the options are in [CLI.md](CLI.md). Output:

```
 cells/λ      cells   f_res GHz     df %   S11 dB    dS11  Dmax dBi   dD dB           Zin ohm   time s  ok
      15      55104      2.4495        -   -42.35       -      6.76       -         49.7-0.4j      1.1
      20     101088      2.4538    0.173   -41.34    1.02      6.75  -0.003         49.8-0.5j      1.2  no
      30     250800      2.4559    0.088   -40.68    0.66      6.75  -0.002         49.3-0.1j      1.9  yes
tolerances: |df| < 0.5 %, |dS11| < 1 dB, |dDmax| < 0.2 dB
converged at 20 cells/λ
```

The designer's Mesh convergence… dialog runs the same study through the run server
(`POST /api/convergence`, one run job per density, the next one queued only when the rule says to
continue; `GET /api/convergence/{id}` returns the study file below, `POST /api/sweeps/{id}/cancel`
stops it). See [DESIGNER.md](DESIGNER.md#mesh-convergence).

The study file has `kind: "mesh-convergence"`; `axes` lists the densities that ran, and
`convergence` holds the rule's state:

```json
{
  "schema": "fairbeam.study/1", "kind": "mesh-convergence", "id": "cv-20260928-101500-ab12",
  "name": "Patch · mesh convergence",
  "axes": [{"key": "mesh.cells_per_wavelength", "values": [15, 20, 30]}],
  "members": [
    {"density": 15, "status": "done", "file": "patch--mesh-15.json",
     "metrics": {"f_res": 2.4495e9, "s11_db": -42.35, "dmax_dbi": 6.756, "zin_re": 49.7, "zin_im": -0.4,
                 "matched": true, "cells": 55104, "timesteps": 14016, "wall_time_s": 1.1}, "summary": {"...": "..."}}
  ],
  "convergence": {
    "tolerances": {"f_pct": 0.5, "s11_db": 1.0, "dmax_db": 0.2}, "densities": [15, 20, 30], "max_runs": 3,
    "steps": [{"from": 15, "to": 20, "df_pct": 0.173, "ds11_db": 1.02, "ddmax_db": -0.003, "dzin_ohm": 0.14,
               "ok": {"f": true, "s11": false, "dmax": true}, "converged": false}],
    "converged": true, "converged_at": 20, "done": true, "reason": "converged",
    "verdict": "converged at 20 cells/λ", "next": null
  }
}
```

- `converged_at` is the coarser density of the first converged step; the finer run confirms it.
- `reason` is `converged`, `exhausted` (no density left: "not converged: refine further or check
  the model"), `failed`, `cancelled` or `running` (then `next` is the density queued next).
- `ok.dmax` is `null` when a run has no far field; Dmax then does not count.
- The resonance is refined between frequency samples (a parabola through the S11 minimum and its
  neighbors in dB), so the grid spacing does not dominate a 0.5 % tolerance.

### A Python model: a mesh parameter

```bash
fairbeam converge python/models/dipole.py --param mesh_div=10,15,20,30 --end-db -60
fairbeam converge python/models/sierpinski_monopole.py --set iterations=2 --param cell=0.8,0.6,0.45
```

This is a thin wrapper around `sweep` with exactly one axis, which you list **from coarse to fine**.
Between successive refinements it reports:

- the change of the **first resonance**: the center (S11 minimum) of the first band below −10 dB,
  or the global S11 minimum if nothing is matched
- the change of **Dmax** at the far-field frequency closest to that resonance

A step counts as converged when |Δf| < `--tol-f` (default 0.5 %) and |ΔDmax| < `--tol-d` (default
0.1 dB). The study is converged when its **last** step is. Output:

```
  mesh_div      cells   f_res GHz      df %  Dmax dBi    dD dB  ok
        15      50544      2.4100         -      6.80        -
        20      97152      2.4325     0.934      6.81    0.010  no
        30     263568      2.4525     0.822      6.79   -0.021  no
        40     535920      2.4550     0.102      6.79   -0.002  yes
converged (last step |df| < 0.5 %, |dD| < 0.1 dB): YES
```

Refine the parameter that controls the mesh on the metal (`mesh_div`, `cell`, ...), not only the
global cell size. See [VALIDATION.md](VALIDATION.md#5-recommended-settings).

## Study file: `fairbeam.study/1`

```json
{
  "schema": "fairbeam.study/1",
  "kind": "sweep | convergence | mesh-convergence",
  "name": "patch-mesh-convergence",
  "created": "2026-09-24T23:20:11+0300",
  "model": {"id": "patch-antenna", "name": "Rectangular patch antenna", "file": "patch_antenna.py"},
  "axes": [{"key": "mesh_div", "values": [15, 20, 30, 40]}],
  "fixed": {},
  "threads": 4, "end_criteria_db": -60, "exact_endcriteria": true, "wall_time_s": 43.0,
  "members": [
    {"file": "studies/patch-mesh-convergence/patch-antenna--mesh_div-15.json",
     "params": {"mesh_div": "15"},
     "summary": {
       "bands": [{"f_lo": 2.39e9, "f_hi": 2.43e9, "f_center": 2.41e9, "s11_min_db": -37.2, "edge_lo": false, "edge_hi": false}],
       "first_resonance": {"f": 2.41e9, "s11_db": -37.2, "matched": true},
       "reactance_zeros": [{"f": 2.53e9, "r": 2.36}],
       "farfield": [{"f": 2.41e9, "dmax_dbi": 6.799, "dmax_pattern_dbi": 6.812, "rad_efficiency": 0.948, "gain_dbi": 6.57, "realized_gain_dbi": 6.57}],
       "dmax_dbi": 6.799, "rad_efficiency": 0.948,
       "cells": 50544, "min_cell": 0.38, "max_cell": 6.66, "timesteps": 12750, "wall_time_s": 6.4, "converged": true}}
  ],
  "convergence": {"tol_f_pct": 0.5, "tol_d_db": 0.1, "converged": true,
                  "steps": [{"df_pct": 0.934, "d_dmax_db": 0.01, "converged": false}]}
}
```

- `members[].file` is relative to the projects folder, so the viewer can fetch `/projects/<file>`.
- `members[].params` holds the swept values as given on the command line (strings).
- Frequencies are in Hz.
- `summary.converged` is the **solver** end-criterion status of that run. `convergence` is the mesh
  study result.
- `sparams` (multi-port models only) is `{f, db: {"i,j": |S_ij| in dB}, reciprocity_max, passive}` at
  the first resonance frequency, or `null`.
- `reactance_zeros` lists the frequencies where Im(Zin) crosses zero upward (series resonances),
  with Re(Zin) there. They do not depend on the port reference impedance, which makes them the
  best numbers to compare with other solvers.
- `convergence` is present for `kind: "convergence"` (a `--param` refinement) and, with a different
  layout (see above), for `kind: "mesh-convergence"`. It has one step per consecutive pair of members.
- Only with the opt-in `--network-metric` / `--network-frequency` criteria (see [CLI.md](CLI.md)):
  the study has `network_criteria`, each member's `summary.network` (`--param`) or
  `metrics.network` (design) holds the fixed-frequency values, and every convergence step has a
  `network` object whose verdict is ANDed into its `converged`. Without the options these fields are
  absent and the verdicts are unchanged.

## `fairbeam touchstone`

```bash
fairbeam touchstone public/projects/patch-antenna.json              # -> public/projects/patch-antenna.s1p
fairbeam touchstone public/projects/dipole.json -o dipole.s1p --ref 0   # keep the 73 ohm port reference
```

For a one-port bundle, or with `--port N`, this writes a Touchstone v1 `.s1p` file with the header
`# GHz S RI R 50`. For a multi-port bundle it writes the full matrix as `.s<N>p`, which needs every
port to have been excited (`--excite all`, the default for up to 4 ports). The 2-port file is
column-wise on one line per frequency (S11 S21 S12 S22), as the v1 format requires; N ≥ 3 is written
row by row with at most four complex pairs per line. Ports with different reference impedances are
renormalised exactly to `--ref`. openEMS measures S11
against the lumped port's own resistance. For a one-port the reflection coefficient is renormalised
**exactly** to any reference through the input impedance, `S' = (Zin − Z) / (Zin + Z)`. The default
is 50 Ω, so the file imports into ADS or scikit-rf without surprises.
`--ref 0` keeps the port's native reference. `--port N` selects a port; the default is the excited
port.

To read Touchstone files in Python, use `fairbeam.touchstone.read_snp(path)` (returns `(f_hz, S, z0)`)
or `read_touchstone(path)`, which also returns the warnings. It reads v1 and v2 files. Y/Z data
are converted to S, per-port v2 references are renormalised to one impedance, and noise blocks
are skipped. It uses the same rules as the viewer's importer.
