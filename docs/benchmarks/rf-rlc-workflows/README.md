# RF workflow numerical validation — 2026-10-02

Native API/schema/build/export/readback checks pass. **Series RLC ideal-circuit equivalence
is not validated by this fixture.** Parallel RLC and the R-only control meet the declared
10% maximum relative complex-impedance error across 4–6 GHz in the final electrically small
fixture. Energy decay and circuit agreement are separate requirements.

| Final case | Maximum complex-Z error | Energy convergence | 10% criterion |
| --- | ---: | --- | --- |
| R-only control, 100 Ω | 3.21% | yes | pass |
| Series 100 Ω + 2 nH + 1 pF | 21.69% | yes, −51.95 dB | **fail** |
| Parallel 100 Ω / 2 nH / 1 pF | 3.64% | yes | pass |

These are the retained energy/error observations, not proof that the excitation had finished.
A subsequent live-provenance qualification of the identical R-only baseline reproduced
3.21267194% error and −78.80 dB energy in 45,160 steps (27.01 solver seconds), but the
existing Gaussian-derivative completion definition requires 56,111 steps. It therefore
failed the separately frozen post-excitation acceptance gate. The comparison stopped after
that first baseline; no precision-candidate solve ran and no accuracy or speed improvement
was established. Earlier R/parallel error passes must not be presented as full post-pulse
validation. Historical measurements and thresholds are retained unchanged.

This later run saved the actual native XML and loaded DLL paths/hashes inside solver
process 57328, before `Run`, under an external evidence directory that is not distributed with
the repository. The separate candidate binary is not part of the application. Further
experiments must declare their stopping rule before solving and preserve this rejected baseline.

The initial 41³-grid, 1 mm-unit fixture had 20.95–32.02% circuit errors. Reducing all
physical dimensions tenfold with the same grid and a 60k cap stopped before the excitation
ended: those results are invalid. The final repeat keeps the reduced physical geometry,
uses a 15³ grid and max 300k steps, 4 CPU threads, with the same components/excitation/band.
The tolerance was fixed before the repeat; no further solves were used to tune a passing case.

`results.json` retains the frequency grid, complex measured/analytic impedances, per-sample
errors, convergence metadata and SHA-256 hashes of externally retained raw signals/fields.
The R-only initial attempt's solver metadata was lost after its output was reused following
an evaluation-method typo; its convergence is explicitly unknown, so it is not a pass.
`native-series.xml` was reconstructed using the same final model builder after the solves;
it is a build artifact rather than an archived solver-input file from the running process.

The source port is at x = −0.04 mm, the passive load at x ≈ +0.04 mm, both bridging common
PEC plates at z = 0 and 0.02 mm. The voltage probe spans the source gap; the current probe
is a transverse surface at its mid-gap. There is no overlapping source/load property.
Native XML records R=100 Ω, L=2e−9 H, C=1e−12 F, LEtype=1, Caps=1 and Direction=2.
The installed CSXCAD header explicitly defines PARALLEL=0 and SERIES=1.

The optimized native source reads SI L/C directly and distributes R/L/C across mesh cells.
Its series ADE uses natural grid capacitance; Caps creates PEC terminal edges afterward.
Caps does not change the recorded R/L/C or topology, though terminals can influence the
field coupling. The observed series discrepancy has no established cause; neither terminal
parasitics nor a solver-precision defect has been proved. No native-engine changes were made.

A subsequent [source-derived numerical replay](conditioning/README.md), checked separately,
found float32 coefficient sensitivity.
Its double-precision control passes below 0.34%, while the float32 replay differs by about 16%.
It does **not** reproduce the measured failure within the frozen 3 Ω diagnostic criterion;
this is a demonstrated vulnerability, not an established cause or a validated solver fix.
The replay does not execute openEMS or change any of the native results above.

`runtime.json` observes modules from a fresh process with the same interpreter/environment,
after these runs. The Python extensions reside in the openEMS GPU virtual environment used for
the benchmark; **loaded openEMS.dll and CSXCAD.dll are the requested optimized benchmark
runtime**, with hashes recorded. This is a post-run reproduction of loading, not a live
module capture from the completed solvers.

To reproduce, configure PYTHONPATH to this checkout's python directory and set
OPENEMS_INSTALL_PATH and CSXCAD_INSTALL_PATH to the chosen native bin directory. Run the
configured Python with `validate_native_rlc.py <fresh-output-directory> 1e-4`.
`--build-only` writes XML without solving. Run simulations serially with an externally
supervised three-minute wall bound per case. The generator does not enforce a wall timeout.
Do not reuse an output folder for a new solver configuration.

API references: [native RLC properties](https://docs.openems.de/en/latest/concepts/properties.html),
[CSXCAD property implementation](https://github.com/thliebig/CSXCAD/blob/master/src/CSPropLumpedElement.cpp),
[openEMS series/parallel operator](https://github.com/thliebig/openEMS/blob/master/FDTD/extensions/operator_ext_lumpedRLC.cpp).
