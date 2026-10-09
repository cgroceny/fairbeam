# Chapter 3: qualified electromagnetic comparison scopes

This record identifies worked examples by number and page and describes our own fixtures, equations and measurements. No textbook text, figures, tables, solution steps or PDF excerpts are included. Native measurements use the bundled openEMS 0.37.0rc3 runtime. Example 3.1 now uses a fresh Fairbeam source-completion study acquired on October 8, 2026. The other qualified multi-mesh cohorts below were retained from the pre-migration repository; their original acquisition identities and metadata remain unchanged. Fresh Fairbeam migration controls for 3.6 and 3.7 agree exactly with their corresponding retained coarse records. This is not a claim that every cohort was rerun after migration. Solver output remains outside Git.

A qualified scope requires an independent numerical target, the declared target-error limit, both consecutive mesh-change limits, a completed excitation pulse and a confirmed time-domain energy stop. Where used, independent phase/probe consistency and boundary controls must also pass. Passing finite mesh-change limits does not establish an asymptotic order. Qualification applies to the listed quantity and geometry; it does not validate an entire example, an untested mode or a gallery bundle.

## Matching, mesh-qualified results

| Example / page | Own fixture and qualified scope | Final measurement / independent reference | Mesh evidence | Reproduction source |
|---|---|---|---|---|
| 3.1 / 116 | 10.7 x 4.3 mm rectangular TE10 guide, epsilon_r=2.08; PEC phase and dielectric attenuation at 15 GHz | alpha_d=0.119033561 / 0.119001313 Np/m | Fresh 20/30/40 study, 30/90 mm lengths; all 60 port columns complete their source and exact -80 dB stop. Full-band alpha target error 0.027661%, mesh changes 0.236510% / 0.274126%; PEC beta error 0.060968%, changes 0.142952% / 0.046974% | [Source-completion PR #58](https://github.com/ismailakdag/fairbeam/pull/58) and [TE10 fixture](../../python/tests/test_guide_loss_example.py) |
| 3.2 / 127 | Radius 5 mm circular TE11 guide, epsilon_r=2.08; PEC phase and dielectric attenuation at 14 GHz | beta=208.410395 / 208.513397 rad/m; alpha_d=0.171119 / 0.171765 Np/m | n8/n12/n16; two independent phase triplets, successful -70 dB stops; phase and dielectric gates pass | [Circular fixture](../../python/tests/test_circular_guide_loss.py) |
| 3.3 / 132 | PEC annular TE11 guide, a=0.81915 mm, b=2.7305 mm, epsilon_r=2.2; physical cutoff | fc=18.626295 / 18.638526 GHz | n8/n12/n16; cutoff target error 0.0791%, successive changes 0.1731% / 0.0594%, successful -70 dB stops | [Annular fixture](../../python/tests/test_coax_cutoff.py) |
| 3.4 / 139 | Grounded isotropic epsilon_r=2.55 slab; phase at twelve sampled TM0/TE1/TM1 thickness points around 10 GHz | Finest maximum beta target error 0.05422% | n8/n12/n16, 36 successful -70 dB stops; successive beta changes at most 0.122925% / 0.042716%; separate air-boundary controls | [Surface-wave fixture](../../python/tests/test_surface_wave.py) |
| 3.5 / 143 | Finite-thickness PEC stripline: plate separation 3.2 mm, epsilon_r=2.2, strip width 2.655477763 mm, thickness 10 um; Z, phase and dielectric attenuation at 10 GHz | Global-fine Z=49.329632 / 49.550484 ohm; alpha_d=0.156705 / 0.155432 Np/m | n8/n12/n16 plus independent outer-field grading 1.3/1.2/1.1; both families pass; global Z changes 0.1610% / 0.1572%, dielectric changes 0.3634% / 0.6390%; successful -70 dB stops | [Stripline fixture](../../python/tests/test_stripline_fixture.py) and [grading helper PR #32](https://github.com/ismailakdag/fairbeam/pull/32) |
| 3.6 / 146 | Zero-thickness PEC stripline, plate separation 3.2 mm, epsilon_r=2.55; TEM phase and Z at five fixed w/b values, 1 GHz | See width table below; maximum full-band Z target error 0.1844% | Two independent 15-case families: n8/n12/n16 and global grading 1.3/1.2/1.1; all successful -70 dB stops; worst global Z changes 0.2390% / 0.2981% | [Capacitance helper PR #32](https://github.com/ismailakdag/fairbeam/pull/32) |
| 3.7 / 149 | Zero-thickness PEC microstrip, h=0.5 mm, w=0.483 mm, epsilon_r=9.9; phase over 9.9–10.1 GHz | beta(10 GHz)=549.198787 rad/m; quasi-static reference 541.070721 rad/m | n6/n8/n10; worst fine phase target error 1.52885%, successive changes 0.07000% / 0.03273%, triplet spread 0.00354%, exact -70 dB; separate air-boundary control | [Microstrip fixture PR #33](https://github.com/ismailakdag/fairbeam/pull/33) |

Example 3.1 also passes the unchanged attenuation gates for its one-sided wall surrogate and combined dielectric/surrogate loss. At 15 GHz, the fine results are 0.049969269 / 0.049914706 Np/m and 0.168998583 / 0.168916019 Np/m, respectively. Full-band target errors are 1.004323% / 0.315901%; successive mesh changes are 1.534110% / 0.186108% and 0.542158% / 0.181780%. The limits remain 3% for attenuation target error, 2% for both attenuation mesh changes, 0.5% for PEC phase target error and 0.25% for both PEC phase changes. The dielectric changes are nonmonotonic, so this is bounded agreement at the declared gates, not an asymptotic-order or tighter-accuracy claim.

The historical 3.1 study stopped 20 port columns before the native Gaussian signal ended, including 16 columns in otherwise eligible scopes. Its original records are retained, not retroactively qualified. For short PEC guides, source lengths at meshes 20/30/40 are 4589/6780/8940 steps; historical -70 dB stops were 4600/6764/8900 and fresh -80 dB stops are 4725/6954/9200. The source-completion reader rejects even perfectly matching spectra when one contributing column is incomplete. A separate audit found complete sources in the other retained Chapter 3 cohorts; that audit does not convert them into fresh acquisitions.

Example 3.6 final global-grading results use an exact elliptic-integral TEM reference, independently cross-checked by a Green-function calculation. A uniform trial-charge approximation is not an exact reference.

| w/b | Final Z / ohm | Independent exact Z / ohm |
|---:|---:|---:|
| 0.25 | 87.459945 | 87.619486 |
| 0.5 | 62.804700 | 62.893240 |
| 1 | 40.888182 | 40.926028 |
| 2 | 24.145903 | 24.159309 |
| 5 | 10.836602 | 10.839272 |

## Scope limits

- 3.1 has a separately qualified **resistive one-sided attenuation surrogate**. A native two-sided conducting sheet and resolved opaque bulk copper are different physical models. The fresh sheet diagnostic has a 50.694381% full-band discrepancy against the one-sided target and remains excluded. Neither sheet behavior nor the surrogate's reactive response establishes a bulk-metal solution.
- 3.2 conductor attenuation and combined loss do not pass the declared independent target. They are not included as validated scopes. See the circular fixture for the signed measurements, controls and unresolved model limitation.
- 3.3 agrees with the exact annular Maxwell boundary root. It does not reproduce a separate approximate cutoff target; see the annular fixture for the discrepancy and independent radial checks.
- 3.4 establishes phase at the sampled points, not a continuous dispersion curve, a near-cutoff limit, finite-width behavior, attenuation or Q.
- 3.5 copper and combined loss do not qualify. The finite-thickness and zero-thickness stripline fixtures must not be combined into one mesh sequence.
- 3.6 qualifies the sampled PEC/TEM geometry, not arbitrary frequency, conductor loss or all trial-charge approximations.
- 3.7 qualifies only approximate PEC phase. Complex V/I impedance misses its target by 3.34067%. Dielectric attenuation passes numeric gates, but the final mesh change grows from 0.16550% to 1.98678%; asymptotic convergence is not established. Neither quantity is included as validated.
- 3.8 is excluded from the qualified table; its opt-in phase fixture and measured limits are in [PR #37](https://github.com/ismailakdag/fairbeam/pull/37). Its three-level phase protocol requires n=6/8/10 and an independent air-boundary control; the n=10 acquisition is deferred by the campaign's 30-minute case budget. The observed n6-to-n8 phase change of 0.308779% also exceeds its predeclared 0.3% limit. A partial cohort cannot qualify, even when its reference error and boundary control are small.
- 3.9 is a calculation-only phase/group velocity relation for an ideal uniform guide; no new FDTD case is required. The related existing [WR-90 transmission record](pozar-comparisons.md) retains its limited complex-S21/phase scope. Its separately measured group velocity remains unqualified.

## Reproduction and provenance

The linked fixtures define the model parameters and analytical references. PRs #32, #33 and #37 are merged into main. The new source-completion surface for 3.1 is in [PR #58](https://github.com/ismailakdag/fairbeam/pull/58); check out that PR until it is merged before using the 3.1 command below. Use a Fairbeam Python environment with the native runtime bindings and a fresh output directory outside the repository. Original source snapshots and raw reports are retained privately; current commands generate fresh records with current source identities. Native studies are serial and use at most four threads.

Different source revisions or geometry/mesh families remain distinct. No interrupted acquisition is accepted. Default replays and input-identity controls are recorded in the relevant PR; no solver data or book files are committed here.

From `python/`, use Python with the native bindings configured and a fresh external root. These commands explicitly request native acquisitions; ordinary unittest discovery does not:

```powershell
$env:PYTHONUTF8='1'
python examples/guide_loss_compare.py --out C:\Temp\pozar-c3\rectangular --meshes 20,30,40 --end-criteria-db -80
python -m tests.test_circular_guide_loss --fdtd --out C:\Temp\pozar-c3\circular
python -m tests.test_coax_cutoff --fdtd --out C:\Temp\pozar-c3\annular
python -m tests.test_surface_wave --fdtd --out C:\Temp\pozar-c3\surface
python -m tests.test_stripline_fixture --fdtd --out C:\Temp\pozar-c3\stripline
```

The stripline default study also records the failed conductor and combined-loss cases; their presence does not qualify them. The 3.6 width/grading commands are in [PR #32](https://github.com/ismailakdag/fairbeam/pull/32); the 3.7 propagation, loss and launch controls are in [PR #33](https://github.com/ismailakdag/fairbeam/pull/33). Follow each fixture's analysis command and acceptance gates rather than selecting one matching frequency.

The independent finite-thickness 3.5 grading control uses the same mesh helper as 3.6, now available on main through PR #32. Repeat the two calls below for growth 1.3, 1.2 and 1.1, with a new path each time. Each call is a separate native process; retained cases took 45–125 s on the campaign host. Keep acquisitions serial and within the local case budget.

```powershell
$control = @'
import hashlib, json, sys
from pathlib import Path
from unittest.mock import patch
from tests import stripline_fixture as f
from tests.test_stripline_capacitance import mesh_control
growth, kind, out = float(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
with patch.multiple(f, F0=f.F0, FREQUENCIES=f.FREQUENCIES, **mesh_control(growth)):
    meta = f.acquire(out, 8, kind)
meta.update(kind=kind+"-grading-control", grading_ratio=growth,
    mesh_helper_sha256=hashlib.sha256(Path(sys.modules[mesh_control.__module__].__file__).read_bytes()).hexdigest())
(out/"report.json").write_text(json.dumps(meta, indent=2)+"\n", encoding="utf-8")
'@
python -c $control 1.1 pec C:\Temp\pozar-c3\global-pec-1p1
python -c $control 1.1 dielectric C:\Temp\pozar-c3\global-dielectric-1p1
```

Keep this family separate from the n=8/12/16 family. Compare all complex spectra against the unchanged `f.targets()` and `f.LIMITS`; dielectric attenuation subtracts its same-growth signed PEC gamma. The custom record identity prevents these controls from silently entering the default n-family comparison.

## Deferred refinements

The 3.7 n=12 PEC/dielectric pair (967680 input cells each, setup-only dt=0.0144672 ps; updated forecast 38–44 minutes per case) is needed to examine the non-monotone dielectric attenuation sequence. The 3.8 n=10 phase case (695520 input cells, setup-only dt=0.0133037 ps; forecast 45–52 minutes) exceeds the campaign's 30-minute budget. Neither deferred case is represented by an extrapolated or passing result. These open scopes do not change the qualified quantities listed above.
