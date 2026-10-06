# Multi-port structures and arrays

## Multi-port runs

Models may define several lumped ports, for example a filter, a power divider or an array.
`fairbeam run` then runs openEMS once per driven port, with all other ports present and terminated in
their resistance, and assembles the S-matrix from the power waves (`S = B A^-1`, per-port reference
impedance). The bundle gets:

- `results.sparams`: every S_ij plus QA figures. Reciprocity is max |S_ij − S_ji|; passivity is
  the column power Σ_i |S_ij|², which must be ≤ 1.
- `results.element_patterns` for antennas: complex embedded element patterns, so any excitation or
  beam-steering state can be evaluated afterwards with `fairbeam.array.combine`, including mutual
  coupling and the active reflection coefficients.

```bash
fairbeam run python/models/microstrip_line.py --engine gpu       # 2-port through line
fairbeam run python/models/wilkinson_divider.py --engine gpu     # 3-port Wilkinson divider (2.4 GHz)
fairbeam run python/models/patch_array_2x1.py --engine gpu       # 2-element patch array
fairbeam run python/models/patch_array_4x1.py --engine gpu       # 4-element patch array (PML, automesh)
fairbeam run python/models/branchline_coupler.py --engine gpu    # 4-port 90 degree hybrid (2.4 GHz)
fairbeam run python/models/lowpass_stepped.py --engine gpu       # 5th-order stepped-impedance low-pass
fairbeam run python/examples/waveguide_thru.py --engine gpu      # WR-90 guide between two TE10 waveguide ports
fairbeam run python/models/wilkinson_divider.py --excite 1       # only port 1 driven (first column)
fairbeam touchstone public/projects/wilkinson-divider.json       # -> wilkinson-divider.s3p
```

In a designer file, ports (lumped or TE10 waveguide) and lumped resistors are added from the Simulation ribbon tab (Ports group), and `fairbeam run <design.json>` follows the same `--excite` rule; the microstrip line starter is a two-port design. `Simulation.lumped_resistor(name, R, start, stop, direction)` adds a non-port resistor, such as a
Wilkinson isolation resistor; it is exported to the VBA macro as a lumped element. Definitions are in
[BUNDLE.md](BUNDLE.md#multi-port-runs), array maths and the 2×1 demonstration in
[ARRAYS.md](ARRAYS.md), and the microstrip and Wilkinson validation in
[VALIDATION.md](VALIDATION.md#7-microstrip-line-two-port-reference).

For offline comparisons, `fairbeam.network` (NumPy only, imported explicitly; no run, bundle or
designer change) gives ideal circuit references: `network_s` for lossless TEM lines and lumped
admittances/impedances between nodes, and the ideal `wilkinson_s` and `branchline_s`. It also
extracts a uniform line's propagation constant from two matched straight-line controls
(`two_line_calibration`) and moves reference planes by given distances (`shift_reference_planes`);
the model and its limits (not a full TRL calibration) are in
[python/README.md](../python/README.md#offline-planar-feed-calibration).

## In the viewer

In the designer, a multi-port run's S-parameters tab (ribbon Post-processing › S-parameters, or the run in the navigation tree) has the same S_ij picker (up to three pairs, dB or phase) and Smith port choice; the description below is the Examples viewer's dock, which also has the Array tab.

- **Multi-port and arrays.** Bundles with two or more ports show an *S-parameters* tab instead of *Reflection*: pick up to three S_ij (the table lists every stored pair), dB or phase, and a Smith chart per port. While projects are compared the picked S_ij of every project are overlaid (the project's color, one dash per pair; a pair a project does not store is left out for it) and the Smith chart shows the picked port of each. Copy data and CSV follow the picked pairs, dB or phase, and the Smith port. Bundles with embedded element patterns get an *Array* tab: per-port amplitude and phase with a feed phasor per port, a live scan-angle slider in the xz or yz plane (progressive phases from the port centers; the plane defaults to the array axis), main beam, HPBW, Dmax and the active reflection of each port. While the array pattern is shown, the 3D port labels carry each port's feed (`P2 · 0.0 dB ∠ −90°`). An *Array / Element Pn* switch picks what the 3D view shows: the array with the current feed, or the embedded element pattern of the port selected in the far-field chips. The Pattern tab overlays the array and that element in one cut plane (φ 0° or 90°, following the scan plane). The package and PDF report include the array pattern with the current weights. Field mapping lives in `src/lib/sparams.ts`, the maths in `src/lib/array.ts`; `npm run check:array` tests them against analytic cases with the synthetic bundle `examples/synthetic/array2x1.json` (test data, not a simulation; open it with *Open* or drag and drop).

The array maths, normalization and the 2×1 and 4×1 demonstrations are in [ARRAYS.md](ARRAYS.md).
