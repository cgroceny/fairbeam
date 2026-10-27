# Chapter 4: waveguide comparison scopes

This record identifies examples by number and page and gives our own geometries, equations and numerical measurements. No textbook text, figures, tables, solution steps or PDF excerpts are included. The 4.8 acquisition used Fairbeam 0.7.2 with bundled openEMS 0.37.0rc3 on October 8, 2026. The contributor reports the separate 4.2 MUR acquisition with the same openEMS version on October 27, 2026, at the source commit identified below. The 4.2 evidence here consists of reduced measurements, recorded hashes and an offline arithmetic replay; the contributor's private raw fields and worker logs were not independently replayed for this documentation. Raw records and frozen acquisition worktrees remain outside Git.

Qualification requires the declared independent target, both consecutive mesh-change limits, a separate boundary-distance control, a completed source signal and confirmed exact -90 dB energy stops. Each case is serial, uses four CPU threads and has a 30-minute suspend-inclusive deadline. Acceptance applies only to the quantities and geometries below; it is not a claim that an entire example or gallery bundle is validated. Earlier -70 dB cohorts stopped before the native Gaussian signal ended and are retained as historical measurements, not post-excitation validation.

For 4.2 MUR, every primary stop also needs a separate, complete 60 ns observation with the same source cache, grid and native time step. Its -150 dB criterion keeps the run observing; reaching that criterion is not claimed. The checks concern the sampled late-time trace and port spectra within this fixed window, not stability for arbitrary durations.

## 4.2 / page 171: a uniform TE10 dielectric interface with MUR controls

Our PEC guide has a=22.86 mm, b=10.16 mm, an interface at z=0, air on the left and epsilon_r=2.54, mu_r=1 on the right. Measurement planes are z=-20 and +20 mm. The Gaussian source is centered at 10 GHz with fc=0.2 GHz; comparison uses 41 frequencies over 9.8-10.2 GHz. The uniform cross-section and transverse TE10 source preserve modal symmetry. Higher propagating channels in the filled guide do not make this a general multimode-discontinuity test.

For our modal reference, beta_i=sqrt(epsilon_ri (omega/c)^2-(pi/a)^2), Z_i=eta0 (omega/c)/beta_i, rho=(Z_2-Z_1)/(Z_2+Z_1), and tau=2 sqrt(Z_1 Z_2)/(Z_1+Z_2). On planes d=20 mm from the interface, the power-wave matrix has S11=rho exp(-2j beta_1 d), S22=-rho exp(-2j beta_2 d) and S12=S21=tau exp(-j (beta_1+beta_2) d). Two independent excitations provide both incident and outgoing columns; solving that matrix separates the interface response from reflected waves at the guide ends.

The acquisition protocol declares these limits: maximum complex-S target error 0.01, each adjacent mesh change 0.003, independent boundary change 0.002, reciprocity error 0.002 and power-balance error 0.01. Each enlarged-boundary control must pass its own target and QA checks. The three meshes use padding 16; an independent middle-mesh control uses padding 24. The following values are transcribed from the contributor-reported reduced record.

| Mesh / padding | Native cells | Native dt / ps | Max complex-S target error | Adjacent mesh change |
|---|---:|---:|---:|---:|
| 40 / 16 | 154275 | 0.855462094 | 0.004774207 | — |
| 50 / 16 | 261261 | 0.703006603 | 0.003005359 | 0.001769302 |
| 60 / 16 | 444675 | 0.579418464 | 0.002092513 | 0.000913259 |
| Independent 50 / 24 | 290493 | 0.703006603 | 0.003006873 | Boundary delta 0.000007405 |

That record reports all four grids meeting the target and QA gates, with both successive mesh changes and the independent boundary change passing. Maximum reciprocity error is 5.484e-6 and power-balance error is 1.2834344e-5. At 10 GHz, the finest comparison is:

| Quantity | Independent modal reference | Finest measured value |
|---|---:|---:|
| Interface rho | -0.315992892 + j0 | -0.315951831 - j0.000097331 |
| Plane-to-plane magnitude of S21 | 0.948761557 | 0.948775370 |
| Plane-to-plane phase of S21 / degrees | -170.192399 | -170.312098 |

The retained metadata reports eight primary acquisitions that finish the native source and stop naturally at the exact -90 dB criterion, and eight separate continuations that complete their allocated 60 ns windows. Each recorded continuation contains at least three samples after its primary stop, all at or below -90 dB, and changes normalized incident and outgoing waves by at most 0.002. The worst sampled late energy is -101.62 dB and the largest wave change is 8.677e-6. The longest recorded enclosing acquisition takes 308.159 seconds; every recorded guard is 1800 seconds. Later primary forecasts use twice the longest completed physical stopping time at a lower-only measured speed; full-allocation forecasts are retained separately. Continuations forecast their entire window. A forecast alone cannot establish run completion.

The contributor's qualification verdict is restricted to the complex TE10 matrix for this geometry, band, planes, three meshes, independent boundary control and sampled 60 ns MUR observations. Recomputing reduced arithmetic and retaining hashes do not independently authenticate the underlying private captures. Native energy is the solver's relative internal proxy, not a measurement in joules. A matched earlier diagnostic records final logged energy -73.78 dB with PML_8 and -119.48 dB with MUR; those one-column controls are not full-S qualification. End reflections also change, so the unique cause of the PML behavior remains unresolved in [issue #340](https://github.com/ismailakdag/fairbeam/issues/340). This MUR record neither fixes PML nor supports closing that issue.

### 4.2 reproduction and provenance

[PR #343](https://github.com/ismailakdag/fairbeam/pull/343) contains the opt-in research control. The reported native acquisition commit is [ca016827](https://github.com/ismailakdag/fairbeam/commit/ca01682730b4dab35dd25252dd80c2fbdb9c7ebd); the later [e2c6696](https://github.com/ismailakdag/fairbeam/commit/e2c6696d9f38b7d344a54b9e5bb353f4dfb6eebb) adds reduced evidence and its offline replay without changing the seven captured source files. Historical raw readback requires the acquisition-pinned reader and runtime, not the moving PR head or a later guard implementation. Keep those original captures, source hashes, worker-log hashes and measured values unchanged.

The [reduced JSON record](https://github.com/ismailakdag/fairbeam/blob/e2c6696d9f38b7d344a54b9e5bb353f4dfb6eebb/python/tests/fixtures/waveguide_step_mur_evidence.json) is 134561 bytes, SHA256 9bcf368bed60202167fafdeb774dc94983263f3064542c849004d3161449ca3f. Its [NPZ samples](https://github.com/ismailakdag/fairbeam/blob/e2c6696d9f38b7d344a54b9e5bb353f4dfb6eebb/python/tests/fixtures/waveguide_step_mur_samples.npz) are 83378 bytes, SHA256 96493145771183ecf158b9ed0781cfa803fcf1fe9ee25c0bf53daf8a3d49fc13. The NumPy-only replay reconstructs power waves from V/I/Z, solves both S columns and recalculates reference, mesh, boundary and sampled continuation checks. It checks contributor-reported arithmetic and metadata; it is not an independent replay of the private raw fields.

To reproduce the original reduced arithmetic, use `python/` in a checkout pinned to `e2c6696d9f38b7d344a54b9e5bb353f4dfb6eebb`:

    python -X utf8 -m tests.test_waveguide_step_mur_evidence

That historical reader predates the stricter completed-log admission contract. New raw records use `te10-mur-control-v2` and the `fairbeam-te10-mur-native-log-v1` frame contract. The current reader requires a finished owned-worker log bound to a parent receipt finalized after process exit and stream closure, exactly one ordered native-output marker pair, and agreement between that bounded log and the reported trace, grid, clock and stop. The report binds the finalized receipt hash. Trace admission requires finite energies and finite, positive, strictly increasing integer timesteps within the completed run, including at least three distinct observations after the primary stop.

These are software admission controls; they do not retroactively qualify the old captures. The current raw reader rejects the historical v1 format; missing new fields or markers are not silently bypassed. The reduced `fairbeam-te10-mur-measured-evidence-v1` fixtures remain unchanged. An independent review of original private logs would need a separate attestation identifying both the acquisition and verifier sources, without relabeling the acquisition or claiming new propagation.

For current software controls and a separately planned fresh acquisition, record the current source commit and use `python/` in that checkout. The first two commands require no native propagation; the reduced replay still checks the historical numerical record and needs NumPy only:

    python -X utf8 -m unittest tests.test_waveguide_step tests.test_waveguide_step_mur_evidence -q
    python -X utf8 -m tests.test_waveguide_step_mur_evidence
    python -X utf8 -m tests.test_waveguide_step --preflight --termination MUR
    python -X utf8 -m tests.test_waveguide_step --study --termination MUR --out C:\Temp\pozar-c4-mur
    python -X utf8 -m tests.test_waveguide_step --compare --termination MUR --out C:\Temp\pozar-c4-mur

Forecast actual native cell-step work before running the study, use fresh external outputs, and respect the per-acquisition deadline. Each source and continuation owns a separate four-thread worker. The current reader reconstructs physical inputs and verifies source/runtime, raw-probe, cache, statistics, spectrum, completed-log and worker-receipt identities before replaying raw port spectra bitwise. Passing its synthetic corruption controls or the reduced arithmetic replay is not a fresh native acquisition or independent raw-data qualification. Earlier PML, RF and clock diagnostics retain their original source identities and are not relabeled as these MUR captures.

## 4.8 / page 214: an ideal uniform-current probe

Our air-filled PEC guide has cross-section a=22.86 mm, b=10.16 mm. A zero-width y-directed source at x=z=0 spans the full height. Only TE10 propagates over the 41-point 9.8–10.2 GHz band. Outward voltage planes at 20/25/30/35 mm form two overlapping triplets on each side. Each triplet extracts propagation and separates outgoing and reflected TE10 waves before extrapolating amplitude to the source plane.

Independent modal overlap and Poynting power give electric amplitude A/I_J=-Z_TE/a and real input resistance R=b Z_TE/a, with Z_TE=eta0 k0/beta and beta=sqrt(k0^2-(pi/a)^2). Here I_J is the impressed-plus-resistor filament current. The native H contour contains local displacement current; the fixture reconstructs I_J=I_H+j omega_Yee epsilon0 area V/b, where V=-integral(E_y dy), omega_Yee=2 sin(omega dt/2)/dt and area is the actual dual source-cell area. This coefficient comes from the geometry and time step, not a measured fit. Raw contour current and impedance are retained; product port-current definitions are unchanged.

Limits are complex amplitude and R target error 2%, both consecutive mesh changes 0.5%, separate boundary change 0.2%, beta target error 0.5%, triplet and left/right differences 0.2%, height-current nonuniformity 0.1% and power-balance error 1%.

| Cells per free-space wavelength | Input cells | dt / ps | Max amplitude target error / % | Max R target error / % | Consecutive mesh change / % |
|---:|---:|---:|---:|---:|---:|
| 40 | 70784 | 1.382870 | 0.120357 | 0.046382 | — |
| 60 | 242880 | 0.893479 | 0.168113 | 0.120844 | 0.156854 |
| 80 | 508928 | 0.691437 | 0.180032 | 0.141372 | 0.034942 |

Four acquisitions, including the separate middle-mesh boundary control, completed the source and reached exact energy stops in 10.54–58.80 seconds each. Their declared signal lengths are 10359/16032/20717/16032 steps; their completed steps are 10605/16470/21280/16632. Boundary change is 0.145470%, triplet difference at most 0.112522% and power-balance error at most 0.180443%. The independent control passes its own target and QA gates. Left/right amplitude differences and height-current nonuniformity are zero at stored precision. At 10 GHz, finest R=221.529568 ohm versus the independent 221.766389 ohm target.

Target errors do not decrease monotonically, and boundary/triplet sensitivities exceed the final mesh difference. The result establishes agreement within the declared tolerances; asymptotic error order or tighter accuracy is not established. Filament reactance grows with refinement and is excluded: a zero-diameter filament has no finite-wire reactance target. This does not qualify a practical coaxial feed, finite conductor or broadband probe design.

## Calculation-only examples

No new FDTD is required for 4.1 / 169 (equivalent modal V/I normalization), 4.3 / 177 (symbolic Z parameters), 4.4 / 179 (ideal attenuator circuit), 4.5 / 183 (analysis of given S parameters), 4.6 / 190 (symbolic ABCD parameters) or 4.7 / 197 (signal-flow relations). These are calculation classifications, not additional validated electromagnetic cases.

## PML application excluded from qualification

The default PML_8 realization of 4.2 / page 171 remains unqualified. Its completed-source dielectric-interface cohort failed the exact -90 dB stop in the filled-side enlarged-boundary control: one of eight columns hit its timestep limit after late energy growth. Its cause is not isolated. Passing target and mesh-change gates in the historical, source-incomplete cohort, or passing the separate MUR scope above, does not override this failure. See [PR #56](https://github.com/ismailakdag/fairbeam/pull/56) for the acceptance guard, retained failure and reproduction. The [clock controls in #341](https://github.com/ismailakdag/fairbeam/pull/341) also remain diagnostic; an early threshold crossing followed by late growth is insufficient.

## Reproduction and provenance

The accepted 4.8 fixture and completed-source guard were added in [PR #55](https://github.com/ismailakdag/fairbeam/pull/55). Its October 8 acquisition identities and numerical values are unchanged here. Replaying historical raw records requires their frozen source identities; the following fresh-acquisition recipe is independent of this documentation change.

From python/, use a Fairbeam environment with the bundled native bindings and fresh external output directories:

    python -m unittest tests.test_waveguide_probe -v
    python -m tests.test_waveguide_probe --preflight
    python -m tests.test_waveguide_probe --study --out C:\Temp\pozar-c4\probe
    python -m tests.test_waveguide_probe --compare --out C:\Temp\pozar-c4\probe

Ordinary test discovery runs pure controls, not these native acquisitions. The reader rejects incomplete cohorts, stale identities, unfinished sources, failed stops and over-budget records. The native Gaussian signal length is ceil(9/(pi fc dt)), fc=0.2 GHz ([implementation](https://github.com/thliebig/openEMS/blob/master/FDTD/excitation.cpp)); it is checked against the cached signal and completed timesteps. Historical records retain their original identities and are not relabeled as the accepted v3 cohort. No simulation bundles or book files are committed.
