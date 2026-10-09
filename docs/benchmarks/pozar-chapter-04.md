# Chapter 4: qualified waveguide comparison scopes

This record identifies examples by number and page and gives our own geometries, equations and numerical measurements. No textbook text, figures, tables, solution steps or PDF excerpts are included. The accepted acquisition used Fairbeam 0.7.2 with bundled openEMS 0.37.0rc3 on October 8, 2026. Raw records and frozen source identities remain outside Git.

Qualification requires the declared independent target, both consecutive mesh-change limits, a separate boundary-distance control, a completed source signal and confirmed exact -90 dB energy stops. Each case is serial, uses four CPU threads and has a 30-minute suspend-inclusive deadline. Acceptance applies only to the quantities and geometries below; it is not a claim that an entire example or gallery bundle is validated. Earlier -70 dB cohorts stopped before the native Gaussian signal ended and are retained as historical measurements, not post-excitation validation.

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

## Application excluded from qualification

4.2 / page 171 remains unqualified. Its fresh dielectric-interface cohort failed the exact -90 dB stop in the filled-side enlarged-boundary control: one of eight columns hit its timestep limit after late energy growth. Its cause is not isolated. Passing target and mesh-change gates in the historical, source-incomplete cohort does not override this failure. See [PR #56](https://github.com/ismailakdag/fairbeam/pull/56) for the acceptance guard, retained failure and reproduction.

## Reproduction and provenance

The accepted 4.8 fixture and completed-source guard are in [PR #55](https://github.com/ismailakdag/fairbeam/pull/55). Check out that PR until merged. This reproduction recipe is independent of the documentation change.

From python/, use a Fairbeam environment with the bundled native bindings and fresh external output directories:

    python -m unittest tests.test_waveguide_probe -v
    python -m tests.test_waveguide_probe --preflight
    python -m tests.test_waveguide_probe --study --out C:\Temp\pozar-c4\probe
    python -m tests.test_waveguide_probe --compare --out C:\Temp\pozar-c4\probe

Ordinary test discovery runs pure controls, not these native acquisitions. The reader rejects incomplete cohorts, stale identities, unfinished sources, failed stops and over-budget records. The native Gaussian signal length is ceil(9/(pi fc dt)), fc=0.2 GHz ([implementation](https://github.com/thliebig/openEMS/blob/master/FDTD/excitation.cpp)); it is checked against the cached signal and completed timesteps. Historical records retain their original identities and are not relabeled as the accepted v3 cohort. No simulation bundles or book files are committed.
