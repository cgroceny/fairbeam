# Chapter 4: qualified waveguide comparison scopes

This record identifies examples by number and page and gives our own geometries, equations and numerical measurements. No textbook text, figures, tables, solution steps or PDF excerpts are included. Acquisition used Fairbeam 0.7.0 with bundled openEMS 0.37.0rc3 on October 7, 2026. The original records and frozen source identities remain outside Git; rebasing the test fixtures onto Fairbeam 0.7.2 did not change their physical models.

Qualification requires the declared independent target, both consecutive mesh-change limits, a separate boundary-distance control and confirmed exact -70 dB energy stops. Each case is serial, uses four CPU threads and has a 30-minute suspend-inclusive deadline. Acceptance applies only to the quantities and geometries below; it is not a claim that an entire example or gallery bundle is validated.

## 4.2 / page 171: a uniform dielectric interface

Our PEC guide has cross-section a=22.86 mm, b=10.16 mm. Its filling changes uniformly from epsilon_r=1 to 2.54 at z=0, with mu_r=1. Measurement planes stay at z=+-20 mm. Two independently excited port columns recover the complete complex TE10 power-wave S matrix over 41 frequencies from 9.8 to 10.2 GHz, including residual incident waves: S=B A^-1.

Tangential E/H continuity gives rho=(Z2-Z1)/(Z2+Z1) and tau=2 sqrt(Z1 Z2)/(Z1+Z2), with Z_i=eta0 k0/beta_i and beta_i=sqrt(epsilon_i k0^2-(pi/a)^2). Phase factors propagate this interface matrix to the fixed planes. Other modes can propagate in the filled half, but the uniform interface preserves the TE10 transverse profile; orthogonality prevents their excitation in this particular geometry.

Limits are maximum absolute complex-S error 0.01, both consecutive mesh changes 0.003, separate boundary change 0.002, reciprocity error 0.002 and column-power error 0.01. The boundary control must pass its own target, reciprocity and power gates as well.

| Cells per wavelength | Input cells | dt / ps | Max complex-S target error | Consecutive mesh change |
|---:|---:|---:|---:|---:|
| 40 | 144000 | 0.855462 | 0.004709528 | — |
| 50 | 246512 | 0.703007 | 0.002970700 | 0.001768488 |
| 60 | 423776 | 0.579418 | 0.002074543 | 0.000915100 |

Eight acquisitions, including two middle-mesh boundary-control columns, reached their exact energy stops in 35.11–104.69 seconds each. The boundary change is 0.000000509351. Across the normal meshes, reciprocity error is at most 0.000020143 and column-power error 0.000182559. The separate control also passes: target error 0.002970710, reciprocity 0.000002264 and power error 0.000172396.

The earlier 20/30/40 sequence failed both mesh-change gates and is not the qualified cohort. The final 40/50/60 protocol kept geometry, planes and acceptance limits unchanged. A discrete Yee-dispersion check explains the earlier phase error but is not substituted for the continuum acceptance target. Qualification is restricted to this TE10 S matrix, band and measurement planes; it does not establish a general mode-conversion or conductor-loss result.

## 4.8 / page 214: an ideal uniform-current probe

Our air-filled PEC guide has the same cross-section. A zero-width y-directed source at x=z=0 spans the full height. Outward voltage planes at 20/25/30/35 mm form two overlapping triplets on each side. Each triplet extracts propagation and separates outgoing and reflected TE10 waves before extrapolating amplitude to the source plane.

Independent modal overlap and Poynting power give electric amplitude A/I_J=-Z_TE/a and real input resistance R=b Z_TE/a. Here I_J is the impressed-plus-resistor filament current. The native H contour contains local displacement current; the fixture reconstructs I_J=I_H+j omega_Yee epsilon0 area V/b, where V=-integral(E_y dy), omega_Yee=2 sin(omega dt/2)/dt and area is the actual dual source-cell area. This coefficient comes from the geometry and time step, not a measured fit. Raw contour current and impedance are retained; product port-current definitions are unchanged.

Limits are complex amplitude and R target error 2%, both consecutive mesh changes 0.5%, separate boundary change 0.2%, beta target error 0.5%, triplet and left/right differences 0.2%, height-current nonuniformity 0.1% and power-balance error 1%.

| Cells per free-space wavelength | Input cells | dt / ps | Max amplitude target error / % | Max R target error / % | Consecutive mesh change / % |
|---:|---:|---:|---:|---:|---:|
| 40 | 70784 | 1.382870 | 0.120103 | 0.046340 | — |
| 60 | 242880 | 0.893479 | 0.167599 | 0.120568 | 0.155157 |
| 80 | 508928 | 0.691437 | 0.180076 | 0.143566 | 0.033874 |

Four acquisitions, including the separate middle-mesh boundary control, reached exact energy stops in 14.60–78.19 seconds each. Boundary change is 0.145149%, triplet difference at most 0.112135% and power-balance error at most 0.184903%. Left/right amplitude differences and height-current nonuniformity are zero at stored precision. At 10 GHz, finest R=221.530026 ohm versus the independent 221.766389 ohm target.

Target errors do not decrease monotonically, and boundary/triplet sensitivities exceed the final mesh difference. The result establishes agreement within the declared tolerances; asymptotic error order or tighter accuracy is not established. Filament reactance grows with refinement and is excluded: a zero-diameter filament has no finite-wire reactance target. This does not qualify a practical coaxial feed, finite conductor or broadband probe design.

## Calculation-only examples

No new FDTD is required for 4.1 / 169 (equivalent modal V/I normalization), 4.3 / 177 (symbolic Z parameters), 4.4 / 179 (ideal attenuator circuit), 4.5 / 183 (analysis of given S parameters), 4.6 / 190 (symbolic ABCD parameters) or 4.7 / 197 (signal-flow relations). These are calculation classifications, not additional validated electromagnetic cases.

## Reproduction and provenance

The 4.2 fixture is in [PR #39](https://github.com/ismailakdag/fairbeam/pull/39), with the independent-control guard tightened in [PR #56](https://github.com/ismailakdag/fairbeam/pull/56). The 4.8 fixture is in [PR #55](https://github.com/ismailakdag/fairbeam/pull/55). Check out the corresponding PR when its fixture is not yet on main. These reproduction recipes are independent of this documentation change.

From python/, use a Fairbeam environment with the bundled native bindings and fresh external output directories:

    python -m unittest tests.test_waveguide_step -v
    python -m tests.test_waveguide_step --preflight
    python -m tests.test_waveguide_step --study --out C:\Temp\pozar-c4\interface
    python -m tests.test_waveguide_step --compare --out C:\Temp\pozar-c4\interface

    python -m unittest tests.test_waveguide_probe -v
    python -m tests.test_waveguide_probe --preflight
    python -m tests.test_waveguide_probe --study --out C:\Temp\pozar-c4\probe
    python -m tests.test_waveguide_probe --compare --out C:\Temp\pozar-c4\probe

Ordinary test discovery runs pure controls, not these native acquisitions. Both readers reject incomplete cohorts, stale identities, failed stops and over-budget records. Existing raw cohorts were kept under their original identities. The tighter 4.2 reader was separately audited against unchanged acquisition functions and original record hashes; its original results remain qualified. For 4.8, a fresh frozen cohort after guard tightening reproduced every stored frequency, voltage and current value exactly. No simulation bundles or book files are committed.
