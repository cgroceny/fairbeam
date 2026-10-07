# Optimizer

`fairbeam optimize` tunes bounded continuous parameters of a Python model or a `.design.json` design towards goals, script-driven: each evaluation is a normal `fairbeam run` (same model file, engine, threads and end criterion), and the search is plain Python (stdlib and numpy, no scipy) in `python/fairbeam/optimize.py`.

```bash
fairbeam optimize python/models/dipole.py --vary length=50:66 --goal f0=2.40 --engine gpu
fairbeam optimize python/models/patch_antenna.py \
    --vary patch_w=30:34:33.5 --vary feed_x=-12:-2:-3 \
    --goal f0=2.45 --goal "s11_max=-25@2.45" --engine gpu --max-evals 15
fairbeam optimize python/models/wilkinson_divider.py --vary r_iso=40:160:100 \
    --goal "match_all=-20@2.4" --goal "sij_max=-25@2.4:2,3" --engine gpu
```

In the designer, use the **Optimize** ribbon tab › **Optimizer** (or **Optimize…** in the Run dialog), which opens the *Optimize design* dialog; for a Python model, use the **Optimize** mode of the Run panel. Both have the same inputs (up to four goals, a method, an evaluation budget), a live cost chart, a table of evaluations, and buttons to open the best result or compare it with the starting point. For multi-port models they also offer the S-matrix goals and show which ports each evaluation drives.

## Parameters

`--vary KEY=MIN:MAX[:START[:RESOLUTION]]`, repeatable (each parameter once).

- The bounds must lie inside the parameter's own `minimum`/`maximum`.
- START defaults to the model's value, clipped to the bounds. The app uses the current parameter value.
- Values are rounded to RESOLUTION. The default is a power of ten about 1/1000 of the range, and integer parameters round to 1. The rounded tuple is the cache key, so a point is never simulated twice.

## Goals

Goals combine additively. A weight is written `*w`, for example `s11_max=-25@2.45*2`.

| Goal | Syntax | Metric | Cost (dimensionless) | Met when |
| --- | --- | --- | --- | --- |
| Resonance | `f0=<GHz>` | first resonance: center of the first −10 dB band; otherwise the first upward zero of Im(Zin); otherwise the \|S11\| minimum | (100 · Δf/f / 1 %)² | \|Δf/f\| ≤ `--f0-tol` (default 0.25 %) |
| Match | `s11_max=<dB>@<GHz>` | \|S11\| at the frequency | (excess / 3 dB)² | \|S11\| ≤ target |
| Bandwidth | `bw_min=<MHz>` | −10 dB bandwidth of the band around f0 (else the first band) | (shortfall / 10 %)² | ≥ target |
| Directivity | `dmax_min=<dBi>@<GHz>` | Dmax at the frequency (nearest far-field sample) | (shortfall / 0.5 dB)² | ≥ target |
| Isolation / coupling | `sij_max=<dB>@<GHz>:<i>,<j>` | \|S_ij\| at the frequency (port i receiving, port j driven) | (excess / 3 dB)² | ≤ target |
| Transmission | `sij_min=<dB>@<GHz>:<i>,<j>` | \|S_ij\| at the frequency | (shortfall / 0.5 dB)² | ≥ target |
| Match all ports | `match_all=<dB>@<GHz>` | the worst \|S_ii\| over all ports | (excess / 3 dB)² | ≤ target |

A goal that cannot be evaluated costs 10⁴, for example when no resonance lies in the simulated band. The run stops as soon as every goal is met, when `--max-evals` is used up, or when the search converges.

### Candidates the design checks refuse

For a design (`.design.json`), every candidate goes through the design checks ([DESIGNER.md](DESIGNER.md#checks)) before openEMS runs. A candidate is **skipped**, not simulated, when:

- it has check errors (for example a brick whose minimum ends up above its maximum), or
- its values make metal overhang its substrate or float in the air (`metal-overhang`, `metal-floating`), unless the design at its own values already has that same warning (a part drawn that way on purpose).

A skipped candidate counts as an evaluation, like a failed one. Its entry carries `"skipped": "<reason>"` and an `error` starting with `skipped:`, the log line and the evaluations table say why (Status **Skipped**, for example "'patch' overhangs 'substrate' by 1.2 mm (x+)"), and it costs 10⁴ for a check error. Misplaced metal costs 10⁴ plus 10 % per mm of overhang or gap (at most 10⁵), so a search that starts among such points is led back to feasible ones. The search then goes on. `--no-precheck` simulates every candidate. Python models are not checked, and sweeps run every point as it is.

The near-to-far-field transform runs only when a Dmax goal needs it (or with `--farfield`), which saves most of the post-processing time of each evaluation.

Each evaluation's raw openEMS folder (`<sim-root>/optimizations/<name>/<slug>/`) is removed as soon as its bundle is written; pass `--keep-sim` (or set `FAIRBEAM_KEEP_SIM=1`) to keep them.

### Multi-port goals and driven ports

The last three goals read the S-matrix in `results.sparams` (the same `multiport.s_from_section` used by `fairbeam run`). Port numbers are the model's own. Examples for the Wilkinson divider: `sij_max=-25@2.4:2,3` (isolation S23 ≤ −25 dB), `sij_min=-3.2@2.4:2,1` (|S21| ≥ −3.2 dB), `match_all=-20@2.4` (S11, S22 and S33 all ≤ −20 dB). |S_ij| is interpolated on the magnitude between the two nearest frequency points.

openEMS runs once per driven port, so the cost of an evaluation is the number of driven ports times the time of one run. `--excite` sets which ports are driven:

- `auto` (the default) drives only the ports the goals need.
  - A column S_·j is known when port j is driven.
  - S_ij is also known from column i, because the network is reciprocal (S_ij = S_ji).
  - `match_all` needs every S_ii, so every port.
  - Antenna goals (`f0`, `s11_max`, ...) use the first port.
  - Examples on a 3-port: S21 with S11 drives port 1 only; S23 drives port 3 only; S21 with S23 drives ports 1 and 3; `match_all` drives all three.
- `all` drives every port.
- An explicit list such as `1,3` drives those ports.

A goal whose entry was not computed (its column was not driven) costs 10⁴ and is never met.

**Driving fewer ports changes the S-matrix method.** With every port driven, Fairbeam computes the complete S = B A⁻¹ from the power waves. With only some ports driven it can only compute S_ij = b_i / a_j, which assumes the other ports are perfectly matched terminations. For the Wilkinson divider the two differ by up to about 2 dB (see the demonstration below). This is good enough for screening, but confirm the final point with all ports driven, for example with a single `fairbeam run`.

The app mirrors this rule. **Driven ports** offers *Needed* or *All*, and the panel shows the resulting ports and runs per evaluation. The time estimate is evaluations × driven ports × the time per port of the model's last finished run (its duration divided by the number of ports it drove). The start button counts openEMS runs, not evaluations.

## Algorithms

`--method` chooses the search (`auto` is the default); the app has the same **Method** list. `--seed` (default 0) seeds the stochastic methods and `--max-evals` (default 12; 1 to 200 on the command line, up to 40 in the app) sets the budget.

- **secant** is the default (`auto`) for one parameter with an f0 goal only.
  - The second point assumes f0 ∝ 1/x, which holds for resonant lengths.
  - It then runs a secant on f0(x) − target, switching to Illinois false position once the target is bracketed.
  - It stops when the target is outside the bounds or the resolution is reached.
  - After three steps without progress it hands over to Nelder–Mead.
- **nelder-mead** is the default for everything else.
  - It works on parameters scaled to [0, 1]. Points outside the box are clipped, and the starting simplex steps 15 % of each range.
  - It restarts around the best point with half the step when the simplex stagnates (twice).
- **bayesian** (Gaussian-process expected improvement), **cma-es**, **particle-swarm** and **genetic** (population searches) and **trust-region** (bounded finite-difference local search) are also available with `--method`. They work on the same [0, 1]-scaled box; the simulated examples below use only secant and Nelder–Mead.

## Output

- Every evaluation is written as a bundle to `public/projects/optimizations/<name>/<model>--<k>-<v>.json`. These bundles stay out of the main project index.
- The run itself is recorded in `public/projects/optimizations/<name>.json`, schema `fairbeam.optimization/1`. It contains the model, varied parameters, goals, fixed parameters, engine, every evaluation (parameters, metrics, per-goal cost and met flag, bundle file, wall time), the best point, the start point, the stop reason and the total wall time.
- The file is rewritten after every evaluation, so a canceled run keeps its history.
- Progress goes to stdout as `fairbeam: optimize start|eval|done {json}` lines. The run server (`POST /api/optimizations`) turns these into live events.

## Demonstration (GPU engine)

Both runs used the Metal GPU build (`~/opt/openEMS-gpu/venv/bin/python`, `--engine gpu --threads 2`) on an Apple M5 Pro, with the models' default meshes. Wall times include building, solving, post-processing and writing each bundle.

### Dipole: first band center to 2.40 GHz (1 parameter)

`fairbeam optimize python/models/dipole.py --vary length=50:66 --goal f0=2.40 --engine gpu --threads 2 --max-evals 10`

| # | length (mm) | f0 (GHz) | \|S11\|(f0) (dB) | cost | solver run |
| --- | --- | --- | --- | --- | --- |
| 1 | 58.00 (start) | 2.4150 | −56.9 | 0.39 | 0.95 s |
| 2 | 58.36 | 2.4000 | −55.4 | 0 (goal met) | 1.01 s |

Method: secant. The second point came from f0 ∝ 1/L: 58 × 2.415 / 2.40 = 58.36 mm. The goal was met after **2 evaluations in 2.0 s**.

The f0 resolution is the frequency grid: 801 points over 1.5–3.5 GHz gives 2.5 MHz, about 0.1 %.

### Patch: f0 = 2.45 GHz and |S11| < −25 dB at 2.45 GHz (2 parameters)

`fairbeam optimize python/models/patch_antenna.py --vary patch_w=30:34:33.5 --vary feed_x=-12:-2:-3 --goal f0=2.45 --goal "s11_max=-25@2.45" --engine gpu --threads 2 --max-evals 15`

The model's defaults (patch_w 32 mm, feed_x −6 mm) already resonate at 2.4525 GHz with −36 dB. A run from the defaults therefore met both goals on its first evaluation (1.8 s). The run shown here starts from a deliberately detuned point instead.

| # | patch_w (mm) | feed_x (mm) | f0 (GHz) | \|S11\| @ 2.45 GHz (dB) | cost |
| --- | --- | --- | --- | --- | --- |
| 1 | 33.500 (start) | −3.000 (start) | 2.3400 | −0.3 | 88.0 |
| 5 | 32.600 | −5.250 | 2.4050 | −3.3 | 55.7 |
| 8 | 31.700 | −6.000 | 2.4725 | −8.9 | 29.5 |
| 12 | 31.924 | −7.315 | 2.4600 | −13.4 | 15.1 |
| 15 | **32.018** | **−5.860** | **2.4500** | **−32.4** | 0 (goals met) |

Method: Nelder–Mead. Both goals were met at **evaluation 15 of 15, in 28.7 s** (1.3–2.6 s per evaluation). The result is f0 = 2.4500 GHz with |S11| = −32.4 dB at 2.45 GHz.

The cost landscape is rough, which limits how fast the search can go:

- |S11| at a fixed frequency changes by tens of dB for sub-millimeter changes of patch_w.
- feed_x = −9.1 mm lost the first band altogether: the first resonance jumped to 2.67 GHz (evaluation 13).

So the 15-evaluation budget was just enough here. Tighter bounds around the expected solution, or tuning f0 first and then the match, converge in fewer evaluations.

### Wilkinson divider: isolation resistor for matched, isolated outputs (multi-port goals)

`python/models/wilkinson_divider.py` with the textbook R = 100 Ω (parameter `r_iso`) stalls at S22 = −18.4 dB and S23 = −22.0 dB at 2.4 GHz ([VALIDATION.md §8](VALIDATION.md#8-wilkinson-power-divider)). The optimizer was given the task from that section: all ports matched to −20 dB and isolation ≤ −25 dB at 2.4 GHz.

`fairbeam optimize python/models/wilkinson_divider.py --vary r_iso=40:160:100 --goal "match_all=-20@2.4" --goal "sij_max=-25@2.4:2,3" --engine gpu --threads 2 --max-evals 5`

`match_all` needs every S_ii, so each evaluation drove all three ports (complete S = B A⁻¹, 3 openEMS runs, about 2.5 s):

| # | r_iso (Ω) | S11 | S22 | S33 | max \|S_ii\| | S23 | cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 100 (start) | −24.27 | −18.40 | −18.38 | −18.38 | −22.03 | 1.27 |
| 2 | 118 | −24.27 | −16.09 | −16.09 | −16.09 | −18.59 | 6.27 |
| 3 | **82** | −24.27 | −22.14 | −22.14 | **−22.14** | **−29.93** | 0 (goals met) |

All values are in dB at 2.4 GHz. Method: Nelder–Mead. Both goals were met after **3 evaluations (9 openEMS runs) in 7.6 s**. S11 does not depend on the resistor, since no current flows through it when port 1 is driven.

The optimizer stops at the first point that meets every goal, so 82 Ω only says that the goals are feasible. To find the best resistor, the isolation goal was tightened to −35 dB with S22 ≤ −20 dB, starting from 82 Ω:

`fairbeam optimize python/models/wilkinson_divider.py --vary r_iso=40:160:82 --goal "sij_max=-20@2.4:2,2" --goal "sij_max=-35@2.4:2,3" --engine gpu --threads 2 --max-evals 5`

Both goals are in column 2 (S22 directly, S23 through reciprocity), so `--excite auto` drove port 2 only. That is 1 run per evaluation, about 0.9 s. S33 = S22 by symmetry.

| # | r_iso (Ω) | S22 | S23 | cost |
| --- | --- | --- | --- | --- |
| 1 | 82 (start) | −21.24 | −33.54 | 0.24 |
| 2 | 100 | −17.72 | −23.39 | 15.5 |
| 3 | 64 | −26.64 | −27.26 | 6.66 |
| 4 | **73** | −23.89 | **−37.89** | 0 (goals met) |

These values come from partial excitation (b_i / a_j). The search converged on **73 Ω after 4 evaluations in 3.6 s**.

**Comparison with the resistor sweep in VALIDATION §8.** That sweep found the best isolation at 70 Ω: S23 = −37.3 dB at 2.4 GHz, and −41.9 dB at 2.444 GHz, with S22 = −25.6 dB. The optimizer landed within 3 Ω of it, using 4 single-port evaluations instead of a four-point sweep with all ports driven. The Run panel confirmed the result with a sweep of r_iso = 73 and 100 Ω, all ports driven, using the multi-port sweep summary:

| r_iso | \|S21\| | S11 | S22 | S33 | S23 |
| --- | --- | --- | --- | --- | --- |
| 73 Ω (complete) | −3.09 | −24.27 | −24.78 | −24.82 | −39.92 |
| 100 Ω (complete) | −3.09 | −24.27 | −18.40 | −18.38 | −22.03 |

With all ports driven, 73 Ω meets `match_all ≤ −20 dB` (the worst port is S11, at −24.3 dB) and gives S23 = −39.9 dB. The partial-excitation values in the second run were within 0.9 dB of these for S22 and 2.0 dB for S23. The 100 Ω row matches VALIDATION §8 to 0.03 dB.

The arm impedance (width) was not optimized. The resistor alone already met both goals, and a second parameter would have tripled the number of runs. The odd-mode behavior described in VALIDATION §8 means the best resistor for this layout is about 70 Ω, not the textbook 2·Z0 = 100 Ω.

## Limitations and next steps

- **Partial excitation.** Driving only the needed ports is cheap but uses b_i / a_j (other ports assumed matched). It can differ from the complete matrix by about 2 dB near deep nulls. Use `--excite all` for the final evaluation, or confirm with a run.
- **First feasible point.** The search stops once every goal is met. To find the optimum rather than a feasible point, tighten the targets.
- **Nelder–Mead is local.** A different start point can reach a different match. The other `--method` choices (bayesian, cma-es, particle-swarm, genetic, trust-region) are not evaluated in this document.
- **Coarse metrics.** Metrics come from 801 frequency points, and f0 cannot be resolved finer than that grid.
