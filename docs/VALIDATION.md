# Validation

This page compares Fairbeam/openEMS results with closed-form theory (analytical results). It also records the mesh and solver settings needed to reach
converged numbers. Every run listed here can be reproduced with the commands shown. The study files
(`fairbeam.study/1`, see [STUDIES.md](STUDIES.md)) and their member bundles for the gallery studies
are committed in `public/projects/studies/`. The focused comparison in section 18 has a separate
numerical record; its raw simulation outputs are not committed to the repository.

Validation applies to the specific models, settings and quantities documented here; it does not
guarantee correct results for every design. Results may contain errors. Check mesh convergence and
verify critical results against suitable independent references or measurements before relying on
them. Fairbeam is provided without warranties, with liability limited as described in
[LICENSE](../LICENSE), sections 15–17, to the extent permitted by applicable law.

**Summary**

| Check | Result |
| --- | --- |
| Half-wave dipole resonance vs the induced-EMF method | FDTD 1.3-1.4 % below the closed-form resonance at three lengths (the method's resonant length is good to ~1-2 %) |
| Dipole input resistance at resonance | 72.2-73.1 Ω (the textbook 73 Ω is the infinitely thin λ/2 value) |
| Dipole Dmax | 2.13-2.17 dBi (theory 2.11 dBi for L = 0.47 λ, 2.15 dBi for λ/2) |
| Dipole radiation efficiency (PEC, lossless) | 0.998-0.9996 at converged mesh |
| Patch resonance vs transmission-line model | converged FDTD 2.455 GHz, model 2.513 GHz (−2.3 %) |
| Patch Dmax | 6.79-6.81 dBi, typical 6-8 dBi |
| Patch efficiency (tan δ = 0.001) | 0.95-0.965, consistent with 1 − Q/Q_d ≈ 0.953 |
| Half-space mirror correction | radiation efficiency 0.985-0.995 on the Sierpinski model; without the correction it would read ~1.99 |
| 50 Ω microstrip line (two-port) | Z0 48.3 Ω at the default mesh, converging to ≈ 49.3 Ω (Hammerstad: 50.0 Ω); ε_eff 2.75 vs 2.68 (+2.7 %); \|S11\| ≤ −22 dB to 6 GHz; dielectric loss matches the constant-conductivity model |
| Wilkinson divider, 2.4 GHz | S21 = S31 = −3.09 dB, S11 −24 dB, S23 −22 dB with the textbook 100 Ω resistor, but S22 = S33 only −18.4 dB. With a 70 Ω resistor all reflections and the isolation are below −25 dB. Resistor fixtures agree within 0.1% in the tested range (simulated directly at the element); the cause is not yet known (see section 8) |
| openEMS lumped resistor | within 0.1% in the real part from 0.5 to 6 GHz, simulated at the element for tested values, meshes and caps ([openems-lumped-resistor.md](openems-lumped-resistor.md)) |
| Array superposition | a single driven element through `fairbeam.array.combine` reproduces openEMS' realized gain (6.019 dBi) and pattern Dmax exactly; 2×1 patch coupling S21 −17.3 dB |
| Automatic mesh | dipole −0.07 % and patch −0.10 % from the converged hand-meshed resonances, with similar or fewer cells ([MESHING.md](MESHING.md)) |
| Branch-line coupler, 2.4 GHz | S21 −3.21 / S31 −2.99 dB, 90.0°, S11 −34 dB, S41 −35 dB at 2.4 GHz (branches trimmed 3.5 %; textbook lengths center 3.8 % high) |
| Stepped-impedance low-pass | Chebyshev passband (0.42 dB ripple) reproduced; −3 dB cutoff 2.36 GHz vs 2.49 GHz ideal-line and 2.65 GHz lumped prototype (step discontinuities and βl up to 1 rad) |
| Waveguide port (WR-90 through guide) | \|S11\| < −40 dB, \|S21\| = 0 ± 0.004 dB, β within 0.2 % of theory over 8-12 GHz |
| Focused WR-90 transmission comparison | On 30/40/50 cells/λ meshes, complex S21 and its 10 GHz phase meet the declared target and both mesh-step tolerances; finest max \|ΔS21\| 0.00632 over 8.2-11.8 GHz and phase error −0.137°. Scope and reproduction are in section 18. |
| Pyramidal horn, 10 GHz, WR-90 port | D = 14.73 / 15.52 / 15.70 dBi at 8 / 10 / 12 GHz vs 14.38 / 15.39 / 15.85 dBi from the aperture model with phase error (Balanis eq. 13-54); E/H-plane HPBW within 1.2° / 1.8° of the same model; S11 ≤ −16.6 dB over 8-12 GHz |
| Axial-mode helix, 2.4 GHz | RHCP, D = 11.6 dBi (Kraus 13.85 dBi, known to be high), AR 0.9 dB at boresight (Kraus 0.6 dB), HPBW 42-45° (Kraus 41°), R_in 164 Ω mean over 2.0-2.9 GHz (Kraus 140 Ω; mesh-dependent for a thin wire) |
| Plane-wave material cell, dielectric slab (ε_r 4, 10 mm, 1-10 GHz) | complex S11 and S21 within 0.006 / 0.009 of the transfer-matrix slab at 20 cells/λ (0.005 / 0.003 at 40), \|S21\| within 0.03 dB and 0.5°; lossless power balance within 0.7 %; the same with tan δ = 0.05 |
| Dispersive slabs (Debye, Lorentz, Drude, Djordjevic-Sarkar FR4) | S11, S21 within 0.007-0.031 of the frequency-dependent analytic slab at 20 cells/λ, falling with the mesh; at 40 cells/λ NRW/NIST recover ε(f) within 1 % (Debye), 5 % (Lorentz), 8 % (Drude, where ε′ crosses zero) and 0.3 % (NIST, FR4 laminate, tan δ 0.019-0.023 across 1-10 GHz); openEMS 0.37.0rc3's DebyeMaterial diverges above ΣΔε/ε∞ ≈ 0.6 in 1D and ≈ 0.3 in 3D (also without PML), so Debye poles and laminates run as fitted Lorentz poles |
| Material extraction from the slab cell (NRW, NIST) | NIST: εr′ within 0.4 % and tan δ within 0.0023 over the whole band (tan δ 0.0508 at f_ref for the given 0.05); NRW: εr′, μr′ within about 1 % on its reliable frequencies, μr 2 of a magnetic slab recovered; NRW tan δ within 0.02 (20 cells/λ) away from the half-wave resonance |
| Waveguide material fixture, WR-90 (8.2-12.4 GHz, 10 mm sample) | S11 and S21 within 0.011 / 0.009 of the guided transfer-matrix slab at 20 cells/λ (0.005 / 0.005 at 30) for εr 4; empty guide \|S11\| ≤ −42.8 dB; NIST εr′ within 0.48 % (0.24 %), tan δ 0.0206 (0.0204) for the given 0.02; NRW εr′, μr′ within 1.4 % (0.7 %), μr 2 recovered |
| Air gap in the WR-90 fixture (εr 4, tan δ 0.02) | a broad-wall gap of 0.025 / 0.2 mm per side lowers the apparent εr′ by 1.3 / 8.9 %; the transverse-resonance correction (TN 1355-R C.1) brings it to +0.15 / +0.44 % (30 cells/λ; the quasi-static capacitor model: +0.18 / +2.2 %); narrow-wall gaps up to 0.5 mm change it by under 0.1 % |

The biggest effects on accuracy are not the global cell size. They are how metal edges and
zero-thickness sheets are meshed, the absorbing boundary, and the energy end criterion. Section 5
has the recommended settings.

## Solver settings used

Unless noted otherwise, the validation runs use the end criterion **−60 dB** evaluated exactly (every
Nyquist period: `--end-db -60 --exact`, openEMS `--exact-endcriteria`), 4 threads, 801 frequency
points, and the DC-free Gaussian-derivative excitation. By default openEMS checks the end
criterion only when it prints progress, about every 4 s of wall time. Short runs therefore
overshoot the criterion by a machine-dependent amount, and their wall time is a multiple of ~4 s.

### End criterion (patch, measured by the integrator)

`python/models/patch_antenna.py` at mesh_div 20. The results were identical on the CPU with exact
end criteria and on a Metal GPU build of openEMS:

| End criterion | Timesteps | S11 min | Dmax (dBi) | Radiation efficiency |
| --- | --- | --- | --- | --- |
| −40 dB | 8162 | −24.0 dB @ 2.435 GHz | 6.804 | 0.856 |
| −50 dB | 10626 | −30.9 dB @ 2.4325 GHz | 6.807 | 0.925 |
| −60 dB | 13860 | −37.3 dB @ 2.4325 GHz | 6.809 | 0.955 |
| −70 dB | 16170 | −38.9 dB @ 2.4325 GHz | 6.809 | 0.961 |

The resonance frequency and Dmax are already converged at −40 dB. S11 depth and radiation
efficiency are not. Efficiency is Prad / P_acc, and ring-down energy that has not yet radiated
corrupts P_acc. Use **≤ −60 dB** for S11 depth, efficiency and gain. The shipped `patch_antenna.py`,
`dipole.py` and the new models set `end_criteria_db=-60`. The low-Q dipole is insensitive to the end
criterion: −40 dB (non-exact) and −60 dB (exact) gave the same resonance to 0.01 %.

## 1. Half-wave dipole

Model: `python/models/dipole.py`. A 1 mm wide, zero-thickness PEC strip in the y = 0 plane, 58 mm
long, with a 1 mm center gap and a 73 Ω lumped port. It is in free space with PML_8 boundaries and,
by default, at least λ(f_min)/4 of free space inside the PML. A flat strip of width w is
electrically equivalent to a round wire of radius a = w/4 = 0.25 mm (Balanis, *Antenna Theory*,
sec. 9.7).

References, both in `fairbeam/analytic.py`:

- **Induced-EMF method** (`dipole_impedance`, Balanis eqs. 8-60a/8-61a). It assumes a sinusoidal
  current. It is exact in the thin limit (73.08 + j42.51 Ω at λ/2, unit-tested) but underestimates R
  near resonance for a finite radius, and its resonant length is good to ~1-2 %.
- **Directivity** of a sinusoidal-current dipole of the same electrical length (`dipole_directivity`).

### 1a. Resonance vs length

`fairbeam sweep python/models/dipole.py --param length=50,58,66 --set f_min=1.4 --set f_max=3.8 --end-db -60 --exact --threads 4`
(mesh_div 20 relative to 3.8 GHz, max cell 3.9 mm). "Resonance" means X_in = 0 rising, which does not
depend on the port impedance.

| L (mm) | FDTD f_r (GHz) | L/λ | FDTD R_in (Ω) | Induced EMF f_r (GHz), R (Ω) | FDTD vs induced EMF |
| --- | --- | --- | --- | --- | --- |
| 50 | 2.7934 | 0.4659 | 73.1 | 2.8345, 62.2 | −1.4 % |
| 58 | 2.4153 | 0.4673 | 72.8 | 2.4485, 62.6 | −1.4 % |
| 66 | 2.1278 | 0.4684 | 72.6 | 2.1552, 62.8 | −1.3 % |

| L (mm) | Dmax openEMS (dBi) | Dmax from pattern (dBi) | Theory (dBi) | Radiation efficiency |
| --- | --- | --- | --- | --- |
| 50 | 2.131 | 2.134 | 2.106 | 0.9985 |
| 58 | 2.145 | 2.138 | 2.108 | 0.9989 |
| 66 | 2.153 | 2.144 | 2.109 | 0.9991 |

The FDTD resonance scales with 1/L as it should (f_r·L is constant to 0.6 %). It sits 1.3-1.4 %
below the induced-EMF value, within that method's stated 1-2 % accuracy for the resonant length (it
assumes a sinusoidal current and does not model a strip with a real 1 mm gap). The FDTD input
resistance (72.6-73.1 Ω) is close to the textbook 73 Ω of the thin λ/2 dipole, while the induced-EMF
method underestimates R near resonance for a finite radius. Dmax is 0.02-0.05 dB above the
sinusoidal-current value, which is the expected direction for a finite-radius dipole. Efficiency is
1 within 0.2 %.

### 1b. Mesh convergence

`fairbeam converge python/models/dipole.py --set pad=80 --param mesh_div=10,15,20,30,40 --end-db -60 --exact --threads 4`
(max cell = λ(3.5 GHz) / mesh_div).

| mesh_div | Max cell (mm) | Cells/λ at f_r | Cells | f_r at X = 0 (GHz) | Δ vs finest | R_in (Ω) | Dmax / pattern Dmax (dBi) | η_rad | Wall time (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 8.57 | 14.5 | 71 632 | 2.3934 | −1.09 % | 74.7 | 2.169 / 2.154 | 0.991 | 10.7 |
| 15 | 5.71 | 21.8 | 95 220 | 2.4096 | −0.42 % | 73.3 | 2.167 / 2.151 | 0.997 | 9.7 |
| 20 | 4.28 | 29.0 | 166 212 | 2.4147 | −0.21 % | 72.7 | 2.163 / 2.144 | 0.999 | 13.6 |
| 30 | 2.86 | 43.3 | 406 700 | 2.4186 | −0.05 % | 72.4 | 2.135 / 2.134 | 0.9995 | 20.3 |
| 40 | 2.14 | 57.9 | 809 776 | 2.4198 | 0 | 72.2 | 2.133 / 2.135 | 0.9996 | 35.1 |

The mesh near the strip is finer than the max cell: 0.25 mm across the strip, the same normal to
it, and λ/40 at the arm ends. The default (mesh_div 20) is within 0.2 % of the finest mesh.

### 1c. What matters: meshing technique (mesh_div 20)

These runs used −40 dB non-exact stopping, which is harmless for this low-Q antenna.

| Setup | f_r at X = 0 (GHz) | Δ vs converged 2.420 | Dmax openEMS / pattern (dBi) |
| --- | --- | --- | --- |
| MUR, 50 mm margin, mesh line on the arm ends, coarse mesh normal to the strip | 2.2252 | −8.0 % | 2.10 / 2.14 |
| + thirds rule at the arm ends | 2.3257 | −3.9 % | 2.01 / 2.14 |
| + PML_8 instead of MUR (60 mm) | 2.3655 | −2.2 % | 2.135 / 2.142 |
| + fine mesh normal to the strip (default model) | 2.4184 | −0.1 % | 2.14 / 2.143 |

- **Metal edges on a mesh line** make a sheet look about half a cell longer (field singularity).
  The first row is 8 % low at the default cell size and converges only slowly (2.105 / 2.225 /
  2.306 GHz at mesh_div 10 / 20 / 40). The openEMS "thirds rule" puts lines 1/3 inside and 2/3
  outside each edge and removes most of this bias.
- **A zero-thickness sheet needs a fine mesh normal to it.** With y cells of 4.3 mm around a 1 mm
  strip, the strip behaves like a much fatter conductor and resonates ~2 % low at any in-plane
  resolution.
- **MUR boundaries at ~λ/2 reflect enough to move the resonance by 1-1.5 % and Dmax by ±0.15 dB.**
  With margins of 50 / 100 / 150 mm the resonance was 2.3257 / 2.3522 / 2.3687 GHz and openEMS'
  Dmax was 2.01 / 2.27 / 2.13 dBi. With PML_8 at 60 / 100 mm: 2.3657 / 2.3630 GHz and
  2.136 / 2.128 dBi. The pattern-integrated Dmax (`dmax_pattern_dbi`) stayed within 2.14-2.18 dBi
  in all cases. A gap between the two Dmax values is a useful reflection alarm.

## 2. Rectangular patch

Model: `python/models/patch_antenna.py`, adapted from the openEMS "Simple Patch Antenna" tutorial.
The patch is 32 mm (resonant, x) × 40 mm (y) on a 60 × 60 mm, 1.524 mm substrate with ε_r 3.38 and
tan δ 0.001. It is probe-fed at x = −6 mm with a 50 Ω lumped port and uses MUR boundaries about
0.7 λ away.

**Transmission-line model** (`analytic.patch_resonance`, Balanis sec. 14.2; Hammerstad):

- ε_eff = (ε_r + 1)/2 + (ε_r − 1)/2 · (1 + 12 h/W)^(−1/2) = **3.176**
- ΔL = 0.412 h (ε_eff + 0.3)(W/h + 0.264) / ((ε_eff − 0.258)(W/h + 0.8)) = **0.733 mm** per edge
- f_r = c0 / (2 (L + 2ΔL) √ε_eff) = **2.513 GHz**. The ideal cavity without fringing, c0 / (2L√ε_r), gives 2.548 GHz.

Assumptions: infinite ground and substrate, quasi-static ε_eff, h ≪ λ, and no probe loading or
surface waves. Typical accuracy is 1-3 %.

`fairbeam converge python/models/patch_antenna.py --param mesh_div=15,20,30,40 --end-db -60 --exact --threads 4`
(max cell λ(3 GHz)/mesh_div; `AddEdges2Grid` puts thirds-rule lines at the patch edges with half
that cell size; 4 cells across the substrate; frequency step 2.5 MHz = 0.1 %):

| mesh_div | Max cell (mm) | Cells | f_r at S11 min (GHz) | Δ vs TL model | S11 min (dB) | Dmax / pattern Dmax (dBi) | η_rad | Wall time (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 15 | 6.66 | 50 544 | 2.4100 | −4.1 % | −37.2 | 6.799 / 6.812 | 0.948 | 6.4 |
| 20 | 5.00 | 97 152 | 2.4325 | −3.2 % | −37.3 | 6.809 / 6.827 | 0.955 | 7.5 |
| 30 | 3.33 | 263 568 | 2.4525 | −2.4 % | −36.0 | 6.788 / 6.813 | 0.949 | 11.1 |
| 40 | 2.50 | 535 920 | 2.4550 | −2.3 % | −34.5 | 6.786 / 6.814 | 0.953 | 13.2 |

At mesh_div 30, 8 instead of 4 substrate cells gave the same resonance (2.4525 GHz) and Dmax
(6.786 dBi). Only the S11 depth changed, to −41.2 dB.

These are global-mesh observations, not a converged feed-impedance certificate. In a separate
fixed-domain local-feed refinement with −60 dB energy completion and 50 kHz frequency sampling,
the final step moved the S11 minimum by only 0.055% but its depth by 3.59 dB. The default ideal
line source therefore needs a separate port-resolution check; frequency stability alone is
insufficient. The optional finite-footprint model and reproducible controls are described in
[STUDIES.md](STUDIES.md#separate-feed-refinement-from-the-global-mesh).

- The resonance converges to **2.455 GHz, 2.3 % below the transmission-line estimate**. That is
  within the model's stated accuracy, and in the usual direction: the simple model ignores the
  probe inductance, the finite 60 mm ground, and dispersion. The old default (mesh_div 20) read
  0.9 % low. The model default is now mesh_div 30 (0.1 % from mesh_div 40, 11 s).
- The edge cell at mesh_div 30 is 1.7 mm, about the substrate height. For microstrip, keep the cell
  at the radiating edges ≲ h.
- **Dmax 6.79-6.81 dBi** is in the usual 6-8 dBi range for a patch on a thin, low-ε substrate.
- **Radiation efficiency 0.95-0.965** is consistent with dielectric loss alone (PEC metal). The −10 dB
  bandwidth (2.433-2.470 GHz, 1.5 %) implies Q ≈ 1/(√2 · 0.015) ≈ 47, and
  η ≈ 1 − Q/Q_d = 1 − 47 · tan δ ≈ 0.953.

### 2b. Inset-fed patch on FR4 (`python/models/inset_patch.py`)

The design is the textbook one for 2.40 GHz on 1.6 mm FR4 (ε_r 4.4, tan δ 0.02), computed by
`fairbeam.analytic`: W = 38.0 mm and L = 29.4 mm (transmission-line model). The inset is
y0 = 9.0 mm (Ramesh & Yip FR4 fit; the cos² formula with Balanis' slot conductances,
`inset_depth`, gives 10.9 mm). The 50 Ω line is 3.08 mm wide (`microstrip_width`), with 1 mm slots.
A lumped port sits at the line end on the board edge, with PML_8 boundaries.

| Setup | f at S11 min (GHz) | S11 min (dB) | Dmax (dBi) | η_rad | Wall time (s) |
| --- | --- | --- | --- | --- | --- |
| Default: mesh_div 20, 1 cell per slot, 3 substrate cells | 2.401 | −15.6 | 6.63 | 0.465 | 9.6 |
| Fine: mesh_div 30, 2 cells per slot, 4 substrate cells | 2.396 | −21.3 | 6.61 | 0.469 | 27.2 |
| TL model | 2.400 | | | | |

- The resonance lands within 0.2 % of the design frequency, and within 0.2 % between the two
  meshes. Unlike the probe-fed patch, no length correction was needed. The inset notch and the feed
  line shift the resonance up by about as much as the FDTD offset seen in section 2 shifts it down.
  Do not read this as the TL model being exact.
- **The match depth depends on how the inset slots are resolved** (−15.6 vs −21.3 dB). Resolve the
  slots with ≥ 2 cells (`--set slot_cells=2`) when the match matters.
- η ≈ 0.47 is what FR4 does to a thin patch. With Q ≈ 1/(√2 · 0.028) ≈ 25 from the −10 dB
  bandwidth, 1 − Q·tan δ ≈ 0.5. Gain is therefore ≈ 3.3 dBi.

### 2c. Minkowski fractal patch (`python/models/minkowski_patch.py`)

The patch is 30 mm square (outer size) with depth ratio 0.5, on a 1.524 mm ε_r 3.38 substrate,
probe-fed at x = −5 mm, with PML_8. Study: `fairbeam sweep python/models/minkowski_patch.py --param iterations=0,1,2 --exact --set boundary=PML_8`
(`public/projects/studies/minkowski-iterations.json`; run before the MUR default and the
feed_x = −3.5 mm default were introduced).

| Iterations | Perimeter (mm) | Area (mm²) | f at S11 min (GHz) | Shift vs square | Dmax (dBi) | η_rad |
| --- | --- | --- | --- | --- | --- | --- |
| 0 (square) | 120 | 900 | 2.558 | | 6.85 | 0.876 |
| 1 | 160 | 700 | 2.326 | −9.1 % | 6.64 | 0.794 |
| 2 | 213 | 622 | 2.278 | −10.9 % | 6.60 | 0.772 |

- Most of the shift comes from the first iteration, and the second adds little. Directivity and efficiency drop slightly as
  the patch gets electrically smaller.
- The square (iteration 0) resonates **5.0 % below** its TL estimate (2.694 GHz). That is twice the
  probe-fed patch offset, because this model puts mesh lines **on** the metal edges (no thirds
  rule; the indentations are too close for it). As in section 1c, such edges read electrically
  about half a cell (0.6 mm) longer at each end. Run `fairbeam converge ... --param cell=1.25,0.9,0.6`
  before quoting absolute frequencies. The relative shift between iterations is less sensitive.
- The shipped default uses MUR boundaries (16 s instead of 46 s). Against PML_8, iteration 1 moved
  by 0.1 % in frequency and 0.12 dB in Dmax. Use `--set boundary=PML_8` for reference results.

## 3. Sierpinski gasket monopole (committed results, not re-run)

Bundle `public/projects/sierpinski-monopole--iterations-3.json`. It has 3 iterations, is 48 mm tall
with a 60° flare, and sits over an infinite PEC ground (PEC boundary, image theory). The cell on the
gasket is 0.8 mm (1.96 M cells). The run used −40 dB non-exact stopping; it overshot to −52.9 dB.
The model is a free-standing PEC sheet with 1.2 mm contact bridges where the sub-triangles touch,
which a staircase mesh needs.

- The mirror correction checks out. Radiation efficiency at the three pattern frequencies is 0.994 / 0.985 / 0.988 with the 2^m
  correction (m = 1); without it, it would be ~1.98. openEMS' Dmax and the pattern-integrated Dmax
  agree within 0.07 dB (9.26 / 9.33, 11.14 / 11.15, 13.38 / 13.36 dBi).
- Not re-run at a finer mesh (the run is already 1.96 M cells), so no band positions are claimed here.

## 3b. Surface current (qualitative check)

Command: `fairbeam run python/models/patch_antenna.py --fields`. The committed `patch-antenna.json`
carries the maps at 2.457 GHz, the nearest dump to the 2.453 GHz resonance. The recorded quantity is
|J_s| from an openEMS rot(H) dump on the sheet plane. See [BUNDLE.md](BUNDLE.md#fields) for the
definition. The map has the expected TM10 shape:

- Along the resonant dimension (x) the current is a half sine. It is 0.06 of the peak at the x = −16
  mm radiating edge, 0.69 at the center and 0.055 at x = +16 mm, with a flattened section around the
  probe (x ≈ −8 to −5 mm).
- Across the patch (y) it is nearly uniform (0.69-0.72). It rises to 0.76-1.0 within the outermost
  cell of the non-radiating edges y = ±20 mm, which is the edge singularity, smeared over one cell.
  The global maximum sits at y = −19.2 mm.
- On the ground plane the image current is concentrated under the patch and falls to < 0.05 at the
  board edges.

The comparison is qualitative only: the edge peak depends on the mesh. The maps show the shape of
the current distribution, not absolute A/m.

## 4. Mesh-convergence summary

| Antenna | Resonance at default mesh vs converged | Dmax spread over all meshes | Default |
| --- | --- | --- | --- |
| Dipole (strip, PML) | −0.2 % (mesh_div 20) | 0.04 dB | mesh_div 20, thirds rule, fine normal mesh |
| Patch (probe-fed) | −0.1 % (mesh_div 30) | 0.02 dB | mesh_div 30 (was 20: −0.9 %) |

Directivity converges much faster than the resonance frequency. Both converge from below: a coarse
staircase mesh makes metal look electrically larger.

## 5. Recommended settings

1. **Max cell**: λ/20 at f_max in the densest dielectric (patch: λ0/30 with ε_r 3.38). **Cells at
   metal edges** should be at most the substrate height, with the thirds rule
   (`AddEdges2Grid(..., metal_edge_res=...)` or explicit lines 1/3 inside and 2/3 outside).
2. **Zero-thickness sheets**: refine the mesh normal to the sheet to the scale of its narrowest
   feature (strip width, slot width) near the sheet.
3. **Boundaries**: use PML_8 with ≥ λ(f_min)/4 free space inside the PML for anything where the
   far field matters. MUR needs ≥ λ/2 and still biases Dmax by ±0.15 dB.
   Keep PEC/PMC boundaries for true symmetry and ground planes.
4. **End criterion**: −60 dB with exact end-criteria evaluation for S11 depth, efficiency and gain.
   −40 dB is enough for resonance frequency and pattern shape only.
5. **Always run a refinement**: `fairbeam converge <model> --param <mesh param>=coarse,...,fine`.
   Accept when the last step changes the first resonance by < 0.5 % and Dmax by < 0.1 dB.
6. **Check `dmax_dbi` against `dmax_pattern_dbi`**. More than ~0.1 dB apart points at boundary
   reflections or a truncated or coarse NF2FF surface.

## 6. Notes on reading the results

- **S-parameters**: S11 is reported against the port impedance, typically 50 Ω. The dipole model
  uses a 73 Ω port. `fairbeam touchstone <bundle>` writes a 50 Ω `.s1p` (renormalised exactly
  through Zin). Compare **resonance (X_in = 0) and Zin**, which do not depend on the port reference.
- **Directivity**: `dmax_pattern_dbi` is the directivity from integrating the far-field pattern.
  IEEE gain corresponds to `gain_dbi`, and realized gain to `realized_gain_dbi`.
- **Loss**: openEMS models tan δ as a constant conductivity, exact only at `tan_d_freq` (band
  center). The difference from a constant loss tangent is small near the center but grows toward
  the band edges.
- **Ports**: Fairbeam uses lumped ports across the feed gap. A waveguide port on a microstrip line
  is not equivalent to a lumped port at the line end.
- **Multi-port**: `fairbeam touchstone <bundle>` writes `.s2p`/`.s3p` files (v1, 50 Ω).
- **Waveguide ports** (horn, section 13): S11 is normalized to the mode's wave impedance;
  `fairbeam touchstone` does not renormalise waveguide ports.
- **Circular polarisation** (helix, section 14): the pattern CSV carries RHCP/LHCP directivity and
  axial ratio (IEEE convention). The helix wire is a zero-radius curve in openEMS, so R_in depends
  on the wire radius (section 14).

## 7. Microstrip line (two-port reference)

Model: `python/models/microstrip_line.py`. A 40 mm line on 0.813 mm, ε_r 3.38, tan δ 0.0027 with a
Hammerstad 50 Ω width of 1.898 mm. It has vertical 50 Ω lumped ports at both board edges and MUR
boundaries. There are two runs, one per port, on the GPU engine at −60 dB; each takes under a second.

Extraction (`fairbeam.analytic`):

- `line_from_s2p`: the ABCD matrix of the two-port gives Z0 = sqrt(B/C); the unwrapped phase of S21
  gives ε_eff.
- `line_z0_estimate` takes the median of Z0 over the quarter-wave points of the line. Near
  half-wave points B and C vanish and the port transition parasitics dominate sqrt(B/C).

`fairbeam run python/models/microstrip_line.py --engine gpu --set strip_cells=N --set sub_cells=N`:

| Cells across strip and substrate | Cells | Z0 (Ω) | ε_eff (1-2 GHz) | max \|S11\| 0.5-6 GHz | Reciprocity |
| --- | --- | --- | --- | --- | --- |
| 2 | 15 360 | 43.7 | 2.772 | −16.2 dB | 1.2e-3 |
| 4 | 26 400 | 46.6 | 2.756 | −20.0 dB | 9.4e-4 |
| **8 (default)** | 49 600 | **48.3** | **2.750** | **−22.4 dB** | 7.9e-4 |
| 12 | 69 920 | 48.8 | 2.749 | −22.8 dB | 7.5e-4 |
| Hammerstad (quasi-static) | | 50.0 | 2.670 | | |
| Hammerstad-Jensen 1980 | | 49.8 | 2.677 | | |

- Z0 converges from below. The steps (2.9, 1.6, 0.5 Ω) extrapolate to about 49.3 Ω, within 1.5 % of
  the closed-form value. A coarsely meshed strip looks wider (lower Z0), which is the same edge bias
  as for the dipole.
- ε_eff settles 2.7 % above the quasi-static formula. Dispersion adds only ~0.5 % at 1-2 GHz for
  h = 0.8 mm, so about 2 % is staircase/mesh bias in the substrate. The phase velocity is therefore
  about 1.3 % slow. That is the sign that also puts the patch resonance 2.3 % below its estimate.
- |S21| = −0.054 dB at 1 GHz and −0.067 dB at 2.4 GHz (reciprocity 8e-4). openEMS models tan δ as a
  constant conductivity set at the band center (3.25 GHz). At 1 GHz that is 3.25 × the nominal loss
  tangent, and the closed-form dielectric loss of a microstrip (Pozar, *Microwave Engineering*, sec. 3.8) is then 0.046 dB for 40 mm, against
  0.048 dB simulated. Above ~3 GHz the column power falls below 1 by more than dielectric loss alone
  predicts (0.978 at 6 GHz); the lumped-port transitions at the open board edges radiate a little.
- The residual |S11| (−22 dB) comes from the 3.5 % Z0 offset and the port transitions. Keep it in
  mind as the floor for the Wilkinson results below, which use the same kind of port.

## 8. Wilkinson power divider

Model: `python/models/wilkinson_divider.py`, 2.4 GHz, on the same substrate. It has two 70.7 Ω arms
(1.035 mm) a quarter wave long along the centerline, a 100 Ω lumped resistor across a 1.9 mm gap at
the arm ends, and three 50 Ω lumped ports on 10 mm feed lines. All edges are axis-aligned. Default
mesh: 6 cells across a 50 Ω strip and 6 across the substrate, 106 k cells, three runs in 2.6 s on
the GPU.

Ideal theory (Pozar sec. 7.3): S21 = S31 = −3.01 dB and S11 = S22 = S33 = S23 = 0 at f0.

| f (GHz) | S11 | S21 = S31 | S22 = S33 | S23 (isolation) |
| --- | --- | --- | --- | --- |
| 2.2 | −17.2 | −3.15 | −19.0 | −20.4 |
| 2.3 | −20.2 | −3.11 | −18.8 | −21.5 |
| **2.4** | **−24.2** | **−3.09** | **−18.4** | **−22.0** |
| 2.5 | −27.1 | −3.08 | −17.7 | −21.8 |

- **Power split**: S21 = S31 = −3.09 dB, 0.08 dB below ideal. That is dielectric loss plus a little
  radiation: 1.4 % of the power is missing from column 1, and the split is exactly symmetric.
  Reciprocity is 1.5e-3.
- **Input match**: S11 is below −20 dB from 2.3 to 2.6 GHz, with its minimum (−27 dB) at 2.49 GHz.
  The arm length (quarter wave along the centerline, from the edge of the input line to the output
  stub) reproduces the design frequency to 4 %.
- **Output match and isolation are the weak point.** Write them as even and odd modes:
  S22 = (Γe + Γo)/2 and S23 = (Γe − Γo)/2. At 2.4 GHz the odd-mode impedance seen at the outputs is
  about 34 Ω, not 50 Ω, and across a resistor sweep it scales as 1/R (Z_odd ≈ 1700 Ω² / (R/2)).
  With the textbook R = 100 Ω, S22 therefore stalls at −18 dB and S23 at −22 dB.
- **Investigation (four extra runs).** Result: the odd-mode impedance at the resistor node is
  about 62-66 Ω of nearly pure resistance, not R/2 = 50 Ω.
  - The output path from the node to each port (feed line, jog and stub) is 21 mm, about λg/4 at
    2.4 GHz. That explains the 1/R law: Z_seen = Z_line² / Z_node. With the 47.5 Ω line of this
    mesh (section 7), Z_node = 47.5² / 34 ≈ 66 Ω.
  - Lengthening every feed by another λg/4 (`--set feed_len=29`) makes the port see the node
    directly: Z_odd = 61.4 − j2.4 Ω. S22 improves to −24.8 dB only because the transformation changed.
  - The odd-mode arm stub is open at 2.4 GHz (|X| > 2 kΩ), so it cannot supply the missing
    conductance.
  - **The resistor is not the cause (this corrects an earlier reading).** Simulated directly at the
    element (−U/I of a passive lumped port), an openEMS lumped resistor agrees within 0.1% in its
    real part from 0.5 to 6 GHz, for 30-300 Ω, 1-8 cells along or across, with or without `caps`.
    A lossy-material block behaves identically ([openems-lumped-resistor.md](openems-lumped-resistor.md)).
    The earlier "+10 % at 2.4 GHz" reading came from de-embedding a microstrip test line
    against a differently meshed reference line, and was wrong. Replacing the Wilkinson's lumped
    resistor with a lossy-material resistor body of the same 100 Ω gives the same odd-mode
    impedance: 34.2 + j3 Ω, against 34.1 + j3 Ω.
  - Not the cause either: the resistor gap (0.5 mm gives Z_odd = 32.5 + j10 Ω, the same as 1.9 or
    2 mm), the mesh density (10 cells per strip, mesh_div 30), the output-jog clearance (1-8 mm), or
    the side-by-side output stubs.
  - **Still unexplained.** The odd-mode node impedance of this layout is about 1.25-1.3 × R/2. A
    70 Ω resistor brings it to about 50 Ω (−42 dB isolation). The tested resistor fixtures agree within 0.1%; possible explanations include a layout
    effect at the node or a staircase-FDTD effect. Further investigation is needed.
  - **The model keeps the physical 100 Ω.** The cause remains unresolved.
- **Resistor sweep** (`fairbeam sweep python/models/wilkinson_divider.py --param r_iso=60,70,85,100 --engine gpu`,
  `public/projects/studies/wilkinson-resistor-sweep.json`):

| R_iso | S22 at 2.4 GHz | S23 at 2.4 GHz | best S23 | all four of S11, S22, S33, S23 < −20 dB |
| --- | --- | --- | --- | --- |
| 60 Ω | −26.2 dB | −26.4 dB | −26.8 dB at 2.455 GHz | 2.30-2.67 GHz |
| **70 Ω** | −25.6 dB | **−37.3 dB** | **−41.9 dB** at 2.444 GHz | 2.30-2.67 GHz |
| 85 Ω | −21.4 dB | −27.9 dB | −28.0 dB at 2.425 GHz | 2.30-2.56 GHz |
| 100 Ω (textbook, default) | −18.4 dB | −22.0 dB | −22.0 dB at 2.414 GHz | none |

  S11, S21 and S31 do not depend on R, as theory says: the even mode carries no resistor current.
  The model keeps the textbook 100 Ω default so that the comparison with theory stays visible.
  `--set r_iso=70` is the tuned design.

## 9. Arrays

The 2×1 patch array (`python/models/patch_array_2x1.py`) and the combination of embedded element
patterns are described in [ARRAYS.md](ARRAYS.md). The validation points:

- One driven element through `fairbeam.array.combine` gives the same realized gain (6.019 dBi) and
  pattern Dmax (6.27 dBi) as the bundle's own single-port far field, so the normalization per unit
  incident wave is right.
- Uniform excitation adds 2.9 dB of directivity (ideal 3.01 dB for two elements). The H-plane
  coupling at λ/2 is S21 = −17.3 dB.
- The viewer's TypeScript combination (`src/lib/array.ts`) reproduces the Python numbers on the
  committed bundle (`npm run check:array`): uniform 9.18 dBi, beam at θ = 15° for the 20° taper,
  Γ_active −21.7 dB.

## 10. Automatic mesh

`Simulation.auto_mesh()` ([MESHING.md](MESHING.md)) against the converged hand-tuned meshes,
GPU engine, −60 dB: the dipole (`--set mesh=auto`, 219 k cells) resonates at 2.4182 GHz
(converged 2.4198 GHz, −0.07 %) with R_in 72.5 Ω and Dmax 2.16 dBi. The patch (`--set mesh=auto`,
153 k cells) resonates at 2.4525 GHz (converged 2.4550 GHz, −0.10 %; hand default mesh_div 30:
2.4525 GHz with 264 k cells), with Dmax 6.89 dBi (0.1 dB above the hand mesh, attributed to the MUR
walls meeting λ/20 instead of λ/30 cells).

A fix to the grading next to split gaps ([MESHING.md](MESHING.md), rule 7) changes the
meshes of the branch-line coupler (69 k → 76 k cells) and the low-pass filter (100 k → 126 k); the
dipole, patch and array meshes are identical. The bundles of sections 11 and 12 were re-run with the
fixed mesher on 2026-09-25 (GPU engine) and the sections below give the new numbers: branch-line
minimum S11 at 2.414 GHz (was 2.406), at 2.4 GHz S11 −33.7 dB (was −29.1), S41 −35.4 dB (−30.9),
S21 −3.21 dB (−3.05), S31 −2.99 dB (−3.17), still 90.0°; low-pass −3 dB at 2.356 GHz (was 2.349),
−20 dB at 3.346 GHz (3.360), ripple 0.42 dB (0.45). The through paths move by ≤ 0.2 dB and the
center frequencies by 0.3 %, which is the mesh sensitivity of those numbers.

## 11. Branch-line (90°) coupler

Model: `python/models/branchline_coupler.py`, 2.4 GHz, on 0.813 mm, ε_r 3.38. It has 35.4 Ω
(3.16 mm) series branches and 50 Ω (1.90 mm) shunt branches, each a quarter wave along the center
lines between junction centers, and four 50 Ω lumped ports on 10 mm feeds. Mesh from
`auto_mesh`: 76 k cells, four runs in 3.0 s on the GPU. Theory (Pozar sec. 7.5): S21 = −j/√2 and
S31 = −1/√2 (−3.01 dB each, 90° apart), with S11 = S41 = 0 at f0.

| Branch scale | f at min S11 | at 2.40 GHz: S11 | S41 | S21 | S31 | ∠S21 − ∠S31 |
| --- | --- | --- | --- | --- | --- | --- |
| 1.000 (textbook)¹ | 2.493 GHz (+3.8 %) | −21.6 dB | −21.8 dB | −3.27 dB | −3.05 dB | 90.2° |
| **1.035 (default)** | 2.414 GHz | **−33.7 dB** | **−35.4 dB** | **−3.21 dB** | **−2.99 dB** | **90.0°** |

¹ Made with the mesh before the split-gap grading fix (section 10), not re-run.

- With the textbook lengths the coupler centers 3.8 % high. The junction squares shorten the
  electrical length of the branches, which is the usual T-junction correction. Even so, it already
  meets |S11|, |S41| < −20 dB, a ±0.2 dB split and 90° ± 0.2° at 2.4 GHz.
- Scaling the branches by 1.035 centers it. S11 and S41 are then below −20 dB from 2.30 to
  2.53 GHz (9.7 %), the phase difference stays within 90° ± 5° from 2.08 to 2.92 GHz, and the
  amplitude imbalance is 0.22 dB at f0.
- The column power is 0.980: 2 % dielectric loss and radiation, matching the Wilkinson on the same
  substrate. The layout and mesh are symmetric, so the matrix is exactly reciprocal and symmetric
  (S11 = S22 = S33 = S44).

## 12. Stepped-impedance low-pass filter

Model: `python/models/lowpass_stepped.py`, a 5th-order Chebyshev with 0.5 dB ripple and
fc = 2.5 GHz. It alternates 20 Ω (6.58 mm) and 110 Ω (0.375 mm) lines on 0.813 mm ε_r 3.38 and
starts with a shunt capacitor. Section lengths are 7.59 / 6.84 / 11.30 / 6.84 / 7.59 mm. Design
equations (Pozar sec. 8.6, `fairbeam.analytic.stepped_impedance_lowpass`): βl = g_k Z_low / Z0 for
capacitors and βl = g_k Z0 / Z_high for inductors, at fc, with the Hammerstad width and ε_eff of each
line. Mesh from `auto_mesh`: 126 k cells, including 4 cells across the 0.375 mm line. Two runs took
4.2 s on the GPU.

| Response | f at −3 dB | f at −20 dB | \|S21\| at 2.5 GHz | 3.0 GHz | 4.0 GHz | 6.0 GHz |
| --- | --- | --- | --- | --- | --- | --- |
| Lumped prototype (`lowpass_prototype_s21`) | 2.648 GHz | 3.362 GHz | −0.5 dB | −12.2 dB | −30.3 dB | −50.9 dB |
| Ideal TL cascade (`cascade_lines_s`, no step discontinuities) | 2.485 GHz | 3.519 GHz | −3.3 dB | −12.9 dB | −24.4 dB | −28.1 dB |
| **openEMS** | **2.356 GHz** | **3.346 GHz** | −6.0 dB | −15.5 dB | −25.5 dB | −22.4 dB |

- **Passband**: up to 2 GHz the ripple is 0.42 dB (|S21| ≥ −0.42 dB including loss) and
  |S11| ≤ −11.4 dB. The ideal 0.5 dB equal-ripple response has |S11| ≤ −9.6 dB, so the passband
  shape is the Chebyshev one.
- **Cutoff shift**: the −3 dB point is 5.2 % below the ideal line cascade and 11 % below the lumped
  prototype. The prototype-to-cascade part (−6 %) is the short-line approximation: βl is up to
  1.0 rad for the middle capacitor, well past the π/4 guideline. The remaining −5.2 % is the step
  discontinuities. Each 20 Ω / 110 Ω step adds fringing capacitance and the wide sections look
  electrically longer, plus the ~1.3 % slow phase of the FDTD microstrip (section 7).
- **Edge sensitivity**: an earlier mesher version put lines exactly on the collinear edges of the three
  20 Ω sections instead of applying the thirds rule; that was an automesh bug, since fixed.
  That run gave −3 dB at 2.243 GHz, 4.8 % lower. This is the edge bias of section 1c again: wide
  low-impedance sections with edges on mesh lines look wider, so they carry more capacitance. Pozar notes
  the same downward shift for this filter type. A design meant to hit 2.5 GHz exactly would
  shorten the low-Z sections, or be tuned with `fairbeam sweep ... --param fc=...`.
- **Stopband**: the distributed filter falls more slowly than the lumped prototype and comes back
  above ~5 GHz (−24 dB at 6 GHz), because the sections approach λ/4 there. The ideal cascade shows
  the same re-entry (−28 dB). This is the known limitation of stepped-impedance filters, not a
  numerical artifact.
- Reciprocity is 1e-6. Column power in the passband is 0.989, i.e. 1 % dielectric loss.

## 13. Pyramidal horn with a waveguide port

Model: `python/models/pyramidal_horn.py`, an optimum-gain horn for G0 = 16 dBi at 10 GHz on WR-90
(22.86 × 10.16 mm). The Balanis design equations (sec. 13.4.3, `fairbeam.analytic.pyramidal_horn_design`)
give an aperture A × B = 86.2 × 64.5 mm and 51.8 mm from throat to aperture. The walls are 2 mm
triangulated polyhedra. The feed is an openEMS `RectWGPort` (TE10) in a 30 mm guide that runs into
the z− PML, so S11 contains only the reflection of the throat and the aperture. PML on all faces,
λ/4 at 8 GHz of air, and an NF2FF box without its z− face (see below). Mesh from `auto_mesh`
(20 cells/λ at 12 GHz): 1.10 M cells, 5.6 s on the GPU.

**Choice of feed.** A waveguide port rather than a coax probe: it separates the horn from the feed
transition. Fairbeam's `evaluate()` needed only small changes: the
port type is recorded in `ports[]`, S11 = u_ref / u_inc from the mode-matched probes, and the
reference impedance is the frequency-dependent TE10 wave impedance Z_TE = η0 / √(1 − (f_c/f)²)
(`results.ports[k].z_ref_f`).

**Port check** (`python/examples/waveguide_thru.py`: a straight WR-90 guide, PEC walls as domain
boundaries, two TE10 ports 75 mm apart, 0.4 s): |S11| < −40 dB over 8-12 GHz (−46 dB at 10 GHz),
|S21| = 0 ± 0.004 dB, and the phase of S21 within 0.5-1.5° of β·L (the FDTD β is 0.1-0.17 % high,
the usual numerical dispersion at 20 cells/λ). Reciprocal to 1e-6, column power 1.002.

**Results** (published bundle):

| f | D (openEMS) | D (aperture model) | D (G0 formula, ε_ap 0.51) | HPBW E-plane | model | uniform | HPBW H-plane | model | cosine |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 GHz | **14.73 dBi** | 14.38 dBi | 14.05 dBi | **30.3°** | 30.4° | 29.5° | **32.4°** | 32.7° | 29.9° |
| 10 GHz | **15.52 dBi** | 15.39 dBi | 15.99 dBi | **24.1°** | 25.3° | 23.6° | **27.1°** | 28.4° | 23.9° |
| 12 GHz | **15.70 dBi** | 15.85 dBi | 17.57 dBi | **21.7°** | 22.2° | 19.7° | **24.9°** | 26.7° | 19.9° |

- *Aperture model* (`fairbeam.analytic.horn_aperture`): the aperture field cos(πx/A) with the
  quadratic phase errors of the flare, exp(−jk(x²/2ρ2 + y²/2ρ1)), where ρ1 = 61.5 mm and ρ2 = 70.5 mm
  are the apex-to-aperture distances along the axis of this geometry. Its directivity equals
  Balanis eq. 13-54 (the Fresnel-integral formula) and its beamwidths include the phase error and
  the Huygens obliquity factor. openEMS is within +0.35 / +0.13 / −0.15 dB and the beamwidths within
  1.2° (E) and 1.8° (H), openEMS slightly narrower. The remaining difference is the edge diffraction and wall currents the
  aperture model leaves out.
- *G0 formula*: 10 log10(0.51 · 4πAB/λ²) with a fixed aperture efficiency. At 10 GHz openEMS is
  0.47 dB below the 16 dBi design target. The design equations take the slant lengths ρe, ρh for the
  axial distances ρ1, ρ2 (Balanis' approximation), so the built horn has more phase error than the
  "optimum" and an aperture efficiency of 0.46 (openEMS) / 0.445 (aperture model) instead of 0.51.
  Above f0 the fixed-efficiency formula is wrong in principle: the phase error grows with frequency,
  so the gain of a fixed horn flattens (12 GHz: ε_ap 0.33).
- *Beamwidths vs the textbook uniform (50.8° λ/B) and cosine (68.8° λ/A) apertures*: those are the
  no-phase-error limits. The quadratic phase error of an optimum horn broadens both, by 2-10 % in
  the E-plane and 8-25 % in the H-plane here, as the aperture model reproduces.
- *S11*: ≤ −16.6 dB over 8-12 GHz (minimum −28.7 dB at 11.2 GHz), the typical ripple of a throat plus
  aperture reflection.
- **PML distance**: λ/2 of air instead of λ/4 (at 8 GHz) changes D by ≤ 0.01 dB, the beamwidths by
  ≤ 0.1° and S11 by ≤ 0.1 dB. λ/4 is enough.
- **Mesh**: 30 cells/λ (2.4 M cells, 14 s) raises D by 0.09 / 0.24 / 0.04 dB and moves the S11
  maximum from −16.6 to −17.9 dB. The beamwidths change by ≤ 0.3°, 0.8° in the E-plane at 12 GHz.
- **NF2FF box without the z− face**: the feed guide crosses the bottom face. With all six faces the
  guided TE10 power inside the guide is counted as radiation: D drops to 12.4 dBi and Prad/Pacc
  reads 2.3. Skipping that face (`add_nf2ff_box(directions=[1, 1, 1, 1, 0, 1])`) leaves out only the
  horn's back radiation below the throat plane, which is small for a horn.
- **Power balance.** A PEC horn has an efficiency of 1, but Prad/Pacc read 1.037 (1.08 at 30
  cells/λ). The NF2FF box was right and the port's accepted power was low: an exact Yee-lattice
  Poynting flux (raw E and H at their staggered positions, H interpolated to the plane) through the
  feed guide, the five-face NF2FF box and planes across the horn agree to 0.1-0.4 % (closed
  balance 1.001), the box is independent of its distance to the horn (0-7.5 mm) and to the frequency-
  domain or time-domain recording, and the far-field integral reproduces the box power. openEMS'
  mode-matching probes read the guide power 4.3 % low at 20 cells/λ and 8.6 % at 30, a constant
  over 8-12 GHz: they project node-interpolated fields on templates normalized over the full node
  areas, and at a PEC wall the node holds half the air value (E: the metal-side edge is zero) while
  its area includes the metal-side half cell. The error is first order in the wall-adjacent cell
  size (5 % for 0.5 mm cells with the walls on mesh lines, 2.6 % for 0.25 mm), so it follows the
  mesh, not the density: the automatic mesh puts 0.38 mm cells next to the broad walls at 20 cells/λ
  and 0.77 mm at 30. `fairbeam.wgport` computes it from the mesh lines (the same projection on the
  ideal mode) and `evaluate()` scales the port's U and I by its square root: Prad/Pacc is now
  0.995 / 0.993 / 0.992 at 8 / 10 / 12 GHz (20 cells/λ) and 0.998 / 0.997 / 0.995 (30 cells/λ).
  The correction is checked against field data for TE10 only.

## 14. Axial-mode helix and circular polarisation

Model: `python/models/helix_axial.py`, a Kraus axial-mode helix at 2.4 GHz: circumference C = λ
(radius 19.9 mm), pitch angle 13° (spacing S = 28.8 mm), N = 7 turns (1.6 λ long), right-hand
wound, over a 100 mm square ground plane (0.8 λ). The helix is a thin PEC wire, a CSXCAD `Curve`
with 36 points per turn, fed by a 120 Ω lumped port over the 3 mm gap between the ground and the
start of the wire. PML boundaries, λ/4 at 1.8 GHz. `sim.cp_outputs = True` adds the circular
components to the far field. Mesh from `auto_mesh` at 30 cells/λ (1.66 mm in air, 0.83 mm cover
over the helix): 1.35 M cells, 10 s on the GPU.

**Geometry primitive.** A `Curve` is what openEMS meshes robustly for a wire (its own Helical_Antenna
tutorial uses one): FDTD puts it on the nearest mesh edges. A `Wire` with a real radius or a swept
strip would need cells smaller than the wire. The bundle stores the curve's points exactly (new
primitive kind `curve`, BUNDLE.md); the viewer draws a tube along it.

**Circular polarisation.** E_R = (E_θ + jE_φ)/√2 and E_L = (E_θ − jE_φ)/√2 (IEEE, e^{jωt}); the partial
directivities are D·|E_R|²/|E|² and D·|E_L|²/|E|², and AR = (|E_R| + |E_L|)/||E_R| − |E_L||. A
right-hand helix radiating along +z must come out RHCP, which checks the sign convention end to end.

| f | C/λ | D | RHCP (θ = 0) | LHCP (θ = 0) | AR (θ = 0) | HPBW | Kraus D | Kraus HPBW | Kraus AR | Kraus R_in |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2.1 GHz | 0.875 | 10.14 dBi | 10.12 dBi | −13.5 dBi | 1.14 dB | 54° | 12.11 dBi | 50.0° | 0.60 dB | 123 Ω |
| 2.4 GHz | 1.000 | **11.58 dBi** | **11.57 dBi** | **−14.2 dBi** | **0.89 dB** | 42-45° | 13.85 dBi | 40.9° | 0.60 dB | 140 Ω |
| 2.7 GHz | 1.125 | 11.71 dBi | 11.60 dBi | −4.3 dBi | 2.82 dB | 33° | 15.38 dBi | 34.3° | 0.60 dB | 158 Ω |

Kraus' estimates (Kraus & Marhefka, *Antennas*, 3rd ed., ch. 8; `fairbeam.analytic.helix_axial_mode`):
D = 15 C²NS/λ³, i.e. 10.8 + 10 log10(C²NS/λ³) dBi, HPBW = 52 λ^{3/2}/(C√(NS)), AR = (2N + 1)/2N and
R_in = 140 C/λ Ω.

- **Directivity**: 2.3 dB below Kraus at 2.4 GHz. Kraus' formula is known to overestimate: it assumes
  the increased-phase-velocity condition and ignores the feed and the finite ground plane.
  The simulated beamwidth matches Kraus within 1-4° at 2.4 and 2.7 GHz, so the pattern shape is right.
  The formula's growth with frequency (C²) is not reproduced above C = λ: D stays at 11.7 dBi while
  the axial ratio rises. With 7 turns the helix is short, and the Hansen-Woodyard phasing it needs
  holds only over part of the Kraus band.
- **Polarisation**: RHCP, as it must be for a right-hand winding. At 2.4 GHz the LHCP level on axis is
  25.8 dB below RHCP and AR = 0.89 dB (Kraus: 0.60 dB for N = 7). At the three pattern frequencies
  the boresight AR is 1.1 / 0.9 / 2.8 dB.
- **Input impedance**: mostly resistive. Over 2.0-2.9 GHz R = 81-254 Ω (mean 164 Ω) and X = −117 to
  +54 Ω (mean −35 Ω); at 2.4 GHz Z_in = 165 − j18 Ω. S11 against 120 Ω is below −10 dB from 1.8 to
  2.74 GHz. Kraus' 140 C/λ is within the spread, but see the mesh study.
- **Mesh (thin-wire effect)**: 20 / 30 / 40 cells/λ (0.54 / 1.35 / 2.70 M cells) give D(2.4 GHz) = 12.11 / 11.58 / 11.38 dBi,
  AR = 1.10 / 0.89 / 0.88 dB and mean R_in = 138 / 164 / 181 Ω. The pattern and the axial ratio
  converge (0.2 dB between 30 and 40); the input resistance keeps rising because the effective
  radius of an FDTD thin wire is a fixed fraction of a cell, so a finer mesh is a thinner wire, and a
  thinner helix has a higher impedance. Compare R_in for a wire of stated radius, not with the FDTD
  number at one mesh.
- **Boundaries**: with MUR boundaries this model went unstable (the energy grew after about
  20 000 timesteps on the GPU engine); PML_8 is stable and converges to −60 dB. Radiation
  efficiency 0.997 (PEC).

## 15. Plane-wave material cell (homogeneous slab)

Model: `python/examples/slab_cell.py`, a dielectric slab (10 mm, ε_r 4, optionally lossy) at
normal incidence, 1-10 GHz, built with `fairbeam.material_cell.PlaneWaveCell`. The
cell is 5 × 5 mm with PMC walls normal to H (x) and PEC walls normal to E (y), so the TEM wave
sees a laterally infinite slab; both ends run into PML_8. A soft E_y sheet over the whole
cross-section launches the wave, and voltage probes from the y− to the y+ wall sit on reference
planes λ/4 at f_max (7.5 mm) in front of and behind the slab. `fairbeam material-cell` runs the
empty cell and then the slab cell on the same mesh, takes S11 = (V1 − V1,inc) / V1,inc and S21 =
V2 / V2,inc, and refers both to the slab faces with the vacuum phase. Reference:
`fairbeam.analytic.slab_s`, the transfer-matrix slab with the same constant-conductivity loss as
`Simulation.dielectric` (the unit tests check it against the closed-form Fresnel slab). 4 × 4 × 54
cells, under a second for both runs.

```bash
cd python
python -m fairbeam material-cell examples/slab_cell.py --set cpw=20 --threads 4 --out <folder> --sim-root <folder>
python -m fairbeam material-cell examples/slab_cell.py --set cpw=20 --set tan_d=0.05 --threads 4 --out <folder> --sim-root <folder>
```

| tan δ | cells/λ (in the slab) | max \|ΔS11\| | max \|ΔS21\| | \|S21\| error | S21 phase error | 1 − \|S11\|² − \|S21\|² |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 10 | 0.048 | 0.031 | 0.11 dB | 1.8° | −0.001 to 0.004 |
| 0 | 20 | 0.006 | 0.009 | 0.03 dB | 0.5° | 0.000 to 0.007 |
| 0 | 40 | 0.005 | 0.003 | 0.01 dB | 0.2° | −0.001 to 0.004 |
| 0.05 | 10 | 0.042 | 0.028 | 0.10 dB | 1.7° | 0.087 to 0.167 |
| 0.05 | 20 | 0.006 | 0.008 | 0.04 dB | 0.5° | 0.084 to 0.168 |
| 0.05 | 40 | 0.004 | 0.003 | 0.01 dB | 0.2° | 0.083 to 0.168 |

ΔS is the complex difference over 401 frequencies. The S11 null of the half-wave slab at 7.5 GHz
comes out at −47 dB (20 cells/λ). The phase error of S21 halves from 20 to 40 cells/λ, as
numerical dispersion should. The lossless slab's power balance closes to 0.7 %; the lossy slab
absorbs 8-17 % across the band.

- **Equal timesteps.** openEMS picks the timestep from the mesh *and* the materials, so the slab
  cell runs at a longer step than the empty cell (2.29 vs 1.83 ps here). A soft source adds its
  amplitude once per timestep, so the wave it launches scales with 1/dt: run at their own steps,
  |S21| came out a constant 0.81 times the analytic value and the lossless slab "absorbed" up to
  48 %. The error shrank with smaller transverse cells only because these pull both steps towards
  the same transverse limit. The runner therefore reads both runs' own steps from an openEMS setup
  (`setup_only`, no timesteps), runs both at the smaller one (`openEMS.SetTimeStep`), and stops if
  the two runs then report different steps. For ε_r, μ_r ≥ 1 that is the empty cell's step. A
  dispersive sample can need a shorter one (a Drude ε′ < 1; section 15c). With this, the result
  does not depend on the transverse cell count (2, 4 and 16 cells across: max |ΔS21| 0.008-0.009).
- **Excitation.** openEMS' TF/SF plane wave (excitation type 10) must not intersect any material,
  and its box would have to reach through the PEC/PMC walls and the far PML. The soft E_y sheet
  (type 0, as in openEMS' `Metamaterial_PlaneWave_Drude` example) is uniform over the cross-section,
  which is the TEM mode of a PEC/PMC cell. Its backward wave runs into the z− PML.
- **Scope.** Normal incidence only: openEMS has no periodic (Floquet) boundaries. A structured
  sample (FSS, metamaterial cell) must be symmetric with respect to the PEC and PMC walls. Above
  f = c / (2 max(a, b)) in the densest material the cell guides higher modes; this example stays
  far below that (30 GHz in air, 15 GHz in the slab). At the reference planes (vacuum) a sample
  that is not mirror-symmetric about the cell's centre planes can excite the first of them above
  c / (2 max(a, b)), a centred one above c / max(a, b); `PlaneWaveCell` records both in the result
  (`cell.f_higher_mode`) and warns when `f_max` reaches them.

### 15b. Material parameters from S11 and S21 (NRW, NIST)

The same runs, with the material extraction of `fairbeam.nrw` (CLI.md, "Material parameters"):
NRW for εr, μr and the loss tangents, and with `--nist` the iterative εr-only method. The
reference is the slab's own material, εr(1 − j tan δ · f_ref/f) with f_ref = 5.5 GHz (the
constant-conductivity loss of `Simulation.dielectric`), and μr. The magnetic case is εr 3, μr 2
(`Simulation.dielectric(..., mu_r=2)`), not εr = μr: such a slab is matched to vacuum, S11
vanishes and NRW has nothing to invert.

```bash
cd python
python -m fairbeam material-cell examples/slab_cell.py --set cpw=20 --nist --threads 4 --out <folder> --sim-root <folder>
python -m fairbeam material-cell examples/slab_cell.py --set cpw=20 --set tan_d=0.05 --nist ...
python -m fairbeam material-cell examples/slab_cell.py --set cpw=20 --set eps_r=3 --set mu_r=2 --set tan_d=0.02 --nist ...
```

Largest deviations over 1-10 GHz (401 frequencies; NRW over its reliable ones, 336-349 of them at
the default `--nrw-floor 0.3`):

| Slab | cells/λ | NRW εr′ | NRW μr′ | NRW tan δ | NRW tan δ_μ | NIST εr′ | NIST tan δ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| εr 4, lossless | 20 | 0.37 % | 0.75 % | 0.020 | 0.022 | 0.42 % | 0.0022 |
| εr 4, lossless | 40 | 0.89 % | 1.14 % | 0.003 | 0.004 | 0.17 % | 0.0021 |
| εr 4, tan δ 0.05 | 20 | 0.91 % | 1.39 % | 0.020 | 0.022 | 0.41 % | 0.0023 |
| εr 4, tan δ 0.05 | 40 | 0.76 % | 0.97 % | 0.004 | 0.005 | 0.16 % | 0.0020 |
| εr 3, μr 2, tan δ 0.02 | 20 | 0.57 % | 1.17 % | 0.005 | 0.006 | (μr = 1 assumed) | |
| εr 3, μr 2, tan δ 0.02 | 40 | 0.73 % | 0.77 % | 0.003 | 0.003 | (μr = 1 assumed) | |

Tan δ errors are absolute.

- **Given εr and tan δ recovered.** NIST gives εr′ = 4.00-4.02 over the band and tan δ(5.5 GHz) =
  0.0508 (20 cells/λ) and 0.04996 (40 cells/λ) for the given 0.05. For the lossless slab it gives
  0.0010 and 0.00001. NRW recovers εr′ and μr′ within about 1 % on its reliable frequencies,
  including μr′ = 2.00-2.02 of the magnetic slab.
- **Half-wave resonance.** At β′d = π (7.5 GHz for the εr 4 slab) the S-parameter error, about
  0.006 at 20 cells/λ (section 15), is amplified as 1/\|sin β′d\|. The largest NRW tan δ error over
  the points left in is 0.036 at `--nrw-floor 0.15`, 0.020 at 0.3 (the default) and 0.011 at 0.5
  (lossless slab, 20 cells/λ). NIST has no such
  amplification: its tan δ is within 0.0023 everywhere, the resonance included. For low-loss
  dielectrics, use NIST for tan δ.
- **NIST on a magnetic sample** fits a non-magnetic slab to a magnetic one (εr′ comes out 3-9),
  as it must. The command warns because NRW finds μr′ ≈ 2.
- **Unit tests** (`python/tests/test_nrw.py`, synthetic S-parameters from `slab_s`):
  - Both methods recover lossless, lossy, magnetic and Debye-dispersive samples to 1e-9.
  - On a 50 mm εr 9 slab from 5 GHz the phase wraps 2.5 turns at the lowest frequency, and the
    group delay picks the right branch.
  - With 1e-3 noise on S11 and S21, NIST keeps εr′ within 1 %, while unmasked NRW is more than ten
    times worse at the resonance.

### 15c. Dispersive materials (Debye, Lorentz, Drude, Djordjevic-Sarkar)

Model: `python/examples/dispersive_cell.py`, a 10 mm slab in the 5 × 5 mm cell over 1-10 GHz,
built with `Simulation.dispersive` (`fairbeam.dispersion`). It comes in four materials:

- `debye`: ε∞ 3, one Debye pole Δε = 2 at 3 GHz, given to openEMS as fitted Lorentz poles (below);
- `lorentz`: ε∞ 2, a Lorentz pole at 6 GHz, f_p 3 GHz, damping 0.6 GHz;
- `drude`: ε∞ 2, f_p 3 GHz, damping 0.5 GHz, so ε′ < 0 below about 2.1 GHz;
- `fr4`: a Djordjevic-Sarkar FR4 with εr 4.4 and tan δ 0.02 at 1 GHz, fitted to Lorentz poles.

`analytic_layers` gives the same ε(f) to `slab_s`, which takes frequency-dependent layers.

```bash
cd python
python -m fairbeam material-cell examples/dispersive_cell.py --set model=lorentz --set cpw=20 --nist --threads 4 --out <folder> --sim-root <folder>
```

**openEMS conventions (step 0).** The engine has one Drude/Lorentz extension, which also runs
Debye. Short single-slab runs (20 cells/λ), compared with the analytic slab for each reading of
the documentation, fix the conventions. Frequencies are in Hz, and the Lorentz/Drude terms are
scaled by ε∞, as in openEMS' matlab `CalcLorentzMaterial` / `CalcDebyeMaterial` (formulas in
`fairbeam.dispersion`):

| Material | Reading | max \|ΔS11\| | max \|ΔS21\| |
| --- | --- | --- | --- |
| Drude (1 pole) | Hz, ε∞-scaled | **0.013** | **0.014** |
| | plasma frequency in rad/s | 0.73 | 0.74 |
| Lorentz (1 pole at 6 GHz) | Hz, ε∞-scaled | **0.018** | **0.020** |
| | as Drude (pole ignored) | 0.73 | 0.87 |
| | rad/s | 0.38 | 0.80 |
| Debye (1 pole) | ε∞ + Δε/(1 + jωτ) | **0.031** | **0.042** |
| | Δε scaled by ε∞ / τ without 2π / conjugate / non-dispersive | 0.22-0.52 | 0.31-0.84 |

**openEMS 0.37.0rc3's DebyeMaterial diverges once ΣΔε/ε∞ exceeds about 0.6 in 1D (about 0.3 in 3D, below).** The cause is the
total Δε relative to ε∞, not the number of poles. The probe goes to 10¹⁰-10³¹, then NaN. A
standalone column, the same 10 mm slab in a 1D channel with openEMS only and its own timestep,
shows where the limit lies:

| ΣΔε/ε∞ | 0.08-0.50 | 0.55 | 0.60 | 0.62 | 0.64 | 0.67 |
| --- | --- | --- | --- | --- | --- | --- |
| uniform 1 mm z cells | stable | stable | stable | stable | grows | grows |
| uniform 0.5 mm z cells | stable | stable | grows | grows | grows | grows |

- The same holds at 0.25 mm, with one pole or two (the sum counts), with ε∞ 3 or 10, and with τ at
  2 or 8 GHz.
- A much shorter forced step (0.5 ps instead of 1.45 ps) keeps 0.67 stable.
- On the graded plane-wave cell mesh, one pole at 0.67 happened to be stable, while two and three
  poles with ΣΔε = ε∞ grew.
- openEMS' own test (`python/Tests/Dispersive_Materials.py` on master) notes instability "for
  d_eps >~ eps_inf"; the limit is about half of that. Physical Debye media exceed it by far
  (water: Δε/ε∞ ≈ 15).
- **Lorentz-based materials** are stable in every one of these configurations at openEMS' own
  step: two Drude poles, two Lorentz poles, overdamped Lorentz poles (a fitted Debye pole, a fitted
  FR4 laminate) and a Lorentz pole in the band. The two Lorentz and the three overdamped Lorentz
  poles are within max |ΔS| 0.006-0.016 of the analytic slab.

So `fairbeam.dispersion` never gives openEMS a DebyeMaterial. `Simulation.dispersive` realizes
Debye poles, like a Djordjevic-Sarkar laminate, as a fit of overdamped Lorentz poles over the
band ±1 decade (`fairbeam.debye_fit.fit_model`). These are passive, causal and Debye-like below
their damping rate, whatever Δε/ε∞ is.

**In 3D the limit is lower, and it is not the PML.** A closed PEC cavity (30 mm, no PML at all) with
a 10 mm Debye cube, soft E_z point source, uniform cells and 20 000 timesteps
(`debye_3d_nopml.py` for openEMS #229) behaves as follows:

| Cells | Stable up to ΣΔε/ε∞ | Grows from |
| --- | --- | --- |
| 1 mm | 0.28 | 0.29-0.30 |
| 0.5 mm | 0.29 | 0.30-0.33 |

So the 3D limit is about 0.25-0.33, half the 1D channel's. Within 20 000 timesteps a slower
growth below it cannot be excluded. A Djordjevic-Sarkar FR4 laminate (Δε/ε∞ ≈ 0.25) is therefore
at the 3D limit, not safely under it. That is one more reason to give it to openEMS as Lorentz
poles. The openEMS-Project discussions
[140](https://github.com/thliebig/openEMS-Project/discussions/140) and
[157](https://github.com/thliebig/openEMS-Project/discussions/157) report a Lorentz fit of a
laminate diverging. There the plasma frequencies were
near 900 GHz. Here every pole frequency is capped by the timestep (ω·dt ≤ 0.5, about 50 GHz at
1.6 ps).

The instability is reported as [openEMS #229](https://github.com/thliebig/openEMS/issues/229),
with a standalone reproduction (openEMS and CSXCAD only). It gives identical results on 0.37.0rc3
(Windows) and on the master of that time (openEMS 6970767, CSXCAD 0306a9f, built on Ubuntu 24.04).
It has since been fixed upstream (openEMS 624fa1d, "DebyeMaterial: integrate the pole capacitor,
not the loop equation"). The packaged 0.37.0rc3 runtime does not have the fix, so Debye poles
still go to openEMS as fitted Lorentz poles.

**Results** (largest deviations over 1-10 GHz, 401 frequencies; NRW over its reliable
frequencies; ε as the complex relative error |Δε|/|ε|, because ε′ of the Lorentz and Drude slabs
crosses zero):

| Material | cells/λ | \|ΔS11\| | \|ΔS21\| | NRW \|Δε\|/\|ε\| | NIST \|Δε\|/\|ε\| |
| --- | --- | --- | --- | --- | --- |
| Debye (fitted, 4 Lorentz poles) | 20 | 0.008 | 0.013 | 1.6 % | 1.3 % |
| Debye (fitted, 4 Lorentz poles) | 40 | 0.006 | 0.006 | 1.1 % | 0.87 % |
| Lorentz | 20 | 0.028 | 0.031 | 8.7 % | 9.5 % |
| Lorentz | 40 | 0.016 | 0.016 | 4.4 % | 4.9 % |
| Drude | 20 | 0.014 | 0.015 | 15.1 % | 15.1 % |
| Drude | 40 | 0.008 | 0.008 | 8.0 % | 8.0 % |
| FR4 (DS, 7 / 9 poles) | 20 | 0.007 | 0.010 | 1.8 % | 0.56 % |
| FR4 (DS, 7 / 9 poles) | 40 | 0.005 | 0.005 | 0.85 % | 0.28 % |

- **Convergence.** The deviations fall with the cell size (to about half from 20 to 40 cells/λ for
  the Lorentz, Drude and FR4 slabs), so they are FDTD discretisation, not a model mismatch. NRW
  and NIST agree, so the S-parameter error, not the inversion, sets the extraction error.
- **Debye.** The comparison is with the simulated (fitted) poles. Against the Debye pole itself,
  the fit adds εr′ 0.10 % and tan δ 0.0009 (20 cells/λ, 1.78 ps), or 0.03 % and 0.0002
  (40 cells/λ). The fitted material is more accurate than openEMS' native one-pole Debye was in
  the plane-wave cell, where that pole happened to be stable (step 0: max |ΔS| 0.031 / 0.042 at
  20 cells/λ, 0.018 / 0.021 at 40).
- **Where.** For the Lorentz slab, NRW recovers ε within 1 % outside 5-8 GHz. Around the pole the
  strong dispersion amplifies the S error (up to 9 % at 20 cells/λ). For the Drude slab, the 15 %
  is at 2-4 GHz, where ε′ crosses zero; from 5 GHz on it is within 2 %.
- **Timestep.** Each run's own step is read at setup and both run at the smaller one. Here the
  sample's own step is the longer one (Lorentz 2.03 vs 1.63 ps, Drude 1.54 vs 1.18 ps, ε∞ ≥ 1). The
  unit tests cover a sample with the shorter step. The poles are checked against the step before
  the run: the FR4 fit at a 1.38 ps estimate was refused in a cell whose real step is 1.85 ps
  (`dt / τ` 0.67). Since then, `Simulation.dispersive` bounds the fit by the built mesh's CFL step,
  which equals the empty cell's step here.

**NRW branch for dispersive samples.** On synthetic slabs (Debye, Drude and four Lorentz cases,
5-60 mm, 801 points), a single branch taken from the band median failed for thick Lorentz slabs,
and a branch from the low end of the band alone still failed above an absorption line. NRW now takes the branch
per stretch between opaque frequencies (|S21| < −60 dB) at the less dispersive end. A stretch
that does not start at the band's lowest frequency is unreliable unless the sample is declared
non-magnetic (`--nist`) and exactly one branch keeps μr within 0.1 of 1 over it. With this, none
of the 24 cases has a wrong value among its reliable frequencies. Without `--nist`, 77 % of the
frequencies are reliable; with it, 86 %.

The first version got three cases wrong:

- A Drude slab (ε∞ 2, f_p 6 GHz, τ 1 ns, 1-10 GHz, 101 points) that is opaque from the bottom of
  the band was taken as known from its first visible frequency. At 60 mm it had 47 reliable
  values with up to 341 % error.
- An opaque slab (εr 4 − 10j, 300 mm, max |S21| 7·10⁻⁶) fell back to "all finite values" and had
  23 reliable ones.
- Alternating isolated visible samples raised an IndexError.

Now the Drude slab has no reliable value without `--nist`, and 55 (60 mm) / 45 (100 mm) with it,
within 2·10⁻¹⁴ of the model. The opaque slab and the isolated samples get no NRW values (the
command reports no material parameters). These cases and invalid material inputs (NaN or infinite constants,
poles and fit controls; ε′ = 0 at the band centre, whose tan δ is then not recorded) are unit
tests in `python/tests/test_dispersion_validation.py`. Re-extracting the stored FDTD results of
sections 15b, 15c and 17 with these rules leaves every number in their tables unchanged.

**Djordjevic-Sarkar FR4.** From εr 4.4 and tan δ 0.02 at 1 GHz (m1 = 4, m2 = 12), the laminate
has εr′ 4.40 → 4.27 and tan δ 0.0199-0.0201 over 1-10 GHz. A constant conductivity with
tan δ 0.02 at 5.5 GHz would give 0.11 → 0.011 instead.

- **The fit.** `Simulation.dispersive` fits the laminate from 0.1 to 100 GHz with the
  relaxations bounded by the mesh's timestep. The fit errors over the band are:
  - at 1.85 ps (20 cells/λ): εr′ 0.04 %, tan δ 0.0006, 7 poles;
  - at 0.97 ps (40 cells/λ): εr′ 0.03 %, tan δ 0.0004, 9 poles.
- **Timestep and fit error.** A coarser timestep caps the relaxations lower (about 0.08/dt) and
  leaves out the ones above. At 2.9 ps, the cap is 27 GHz and the tan δ error is 0.0013 at
  10 GHz.
- **FDTD and NIST.** The slab's NIST tan δ stays at 0.019-0.023 across the band (model
  0.0199-0.0201). The deviation, within 0.003, is the cell's S-parameter error (0.005-0.01)
  entering ε″. It is about the same at −80 and −100 dB end criteria. εr′ is within 0.56 % at
  20 cells/λ and 0.28 % at 40.

## 17. Waveguide material fixture (WR-90)

Model: `python/examples/wr90_fixture.py`, a homogeneous sample 10 mm thick filling a WR-90 guide
(22.86 × 10.16 mm) over its band, 8.2-12.4 GHz. It is built with
`fairbeam.waveguide_fixture.WaveguideFixture`. PEC walls in x and y; at each end a
TE10 waveguide port (`Simulation.waveguide_port`) with its probes one guide width (22.86 mm) from
the sample face and its excitation plane two cells further out, then PML_8. Port 1 is driven and
port 2 is terminated.

`fairbeam material-cell` runs the empty guide and the sample at one timestep. It takes S11 and
S21 from the port waves (reference: the TE10 wave impedance) and refers them to the sample faces
with β0 simulated in the empty run. The reference is the guided transfer-matrix slab,
`fairbeam.analytic.slab_s(..., kc=π/a)`; the unit tests check it against the closed-form guided
slab. With εr = 1 the model is the empty-guide check. The mesh is 20 × 10 × 86 lines at 20 cells/λ
(in the sample) and 30 × 14 × 112 at 30. Both runs together take 1.5-4 s on 4 threads.

```bash
cd python
python -m fairbeam material-cell examples/wr90_fixture.py --set eps_r=1 --nist --threads 4 --out <folder> --sim-root <folder>
python -m fairbeam material-cell examples/wr90_fixture.py --nist --threads 4 --out <folder> --sim-root <folder>
python -m fairbeam material-cell examples/wr90_fixture.py --set tan_d=0.02 --nist --threads 4 --out <folder> --sim-root <folder>
python -m fairbeam material-cell examples/wr90_fixture.py --set eps_r=3 --set mu_r=2 --set tan_d=0.02 --nist --threads 4 --out <folder> --sim-root <folder>
```

Add `--set cpw=30` for the finer mesh. The defaults are εr 4, tan δ 0, μr 1 and cpw 20. The
results below are from openEMS 0.37.0rc3 on Windows 11, CPU engine, 4 threads.

S-parameters against the guided slab (401 frequencies; ΔS is the complex difference):

| Sample | cells/λ | max \|ΔS11\| | max \|ΔS21\| | \|S21\| error | S21 phase error | 1 − \|S11\|² − \|S21\|² |
| --- | --- | --- | --- | --- | --- | --- |
| empty guide | 20 | 0.0073 | 0.0036 | 0.000 dB | 0.20° | −0.0001 to 0.0000 |
| empty guide | 30 | 0.0037 | 0.0015 | 0.000 dB | 0.09° | 0.0000 |
| εr 4, lossless | 20 | 0.011 | 0.009 | 0.024 dB | 0.68° | −0.0004 to 0.0017 |
| εr 4, lossless | 30 | 0.005 | 0.005 | 0.013 dB | 0.36° | −0.0008 to 0.0016 |
| εr 4, tan δ 0.02 | 20 | 0.010 | 0.009 | 0.025 dB | 0.69° | 0.063 to 0.141 |
| εr 4, tan δ 0.02 | 30 | 0.005 | 0.005 | 0.011 dB | 0.36° | 0.063 to 0.140 |
| εr 3, μr 2, tan δ 0.02 | 20 | 0.015 | 0.024 | 0.024 dB | 1.44° | 0.094 to 0.109 |
| εr 3, μr 2, tan δ 0.02 | 30 | 0.006 | 0.011 | 0.011 dB | 0.67° | 0.094 to 0.108 |

Material parameters (NRW over its reliable frequencies, 339-356 of 401 for the filled samples and
all 401 for the empty guide; tan δ errors are absolute):

| Sample | cells/λ | NRW εr′ | NRW μr′ | NRW tan δ | NIST εr′ | NIST tan δ | NIST tan δ at 10.3 GHz |
| --- | --- | --- | --- | --- | --- | --- | --- |
| empty guide | 20 | 0.79 % | 0.79 % | 0.006 | 0.19 % | 0.0010 | 0.0010 (0) |
| empty guide | 30 | 0.36 % | 0.36 % | 0.003 | 0.08 % | 0.0007 | 0.0006 (0) |
| εr 4, lossless | 20 | 0.90 % | 1.38 % | 0.010 | 0.48 % | 0.0005 | 0.0005 (0) |
| εr 4, lossless | 30 | 0.47 % | 0.66 % | 0.007 | 0.24 % | 0.0004 | 0.0004 (0) |
| εr 4, tan δ 0.02 | 20 | 0.90 % | 1.36 % | 0.012 | 0.48 % | 0.0006 | 0.0206 (0.0200) |
| εr 4, tan δ 0.02 | 30 | 0.40 % | 0.65 % | 0.008 | 0.24 % | 0.0004 | 0.0204 (0.0200) |
| εr 3, μr 2, tan δ 0.02 | 20 | 0.60 % | 0.81 % | 0.016 | (μr = 1 assumed) | | |
| εr 3, μr 2, tan δ 0.02 | 30 | 0.40 % | 0.36 % | 0.007 | (μr = 1 assumed) | | |

- **Given εr and tan δ recovered.** NIST gives εr′ = 4.00-4.02 (20 cells/λ) and 4.00-4.01 (30) over
  the band. The lossy sample's tan δ is 0.0206 and 0.0204 at 10.3 GHz for the given 0.02. NRW
  recovers μr′ = 1.99-2.02 of the magnetic sample. The errors roughly halve from 20 to 30 cells/λ.
  The guided form has no new error source compared with the plane-wave cell (section 15b): it is
  the same discretisation error, with the port's own mismatch on top (|S11| of the empty guide at
  most −42.8 dB at 20 cells/λ, −48.6 dB at 30).
- **Simulated β0.** The empty guide's β0, simulated between the reference planes, is 0.16-0.22 %
  (20 cells/λ) and 0.07-0.10 % (30) off the analytic √(k0² − (π/a)²): numerical dispersion. The
  runner uses the measured value for the de-embedding and in NRW and NIST, and reports the
  analytic one for comparison. With the analytic β0 instead, NIST εr′ is off by 0.66 % rather than
  0.48 % (εr 4, 20 cells/λ) and 0.33 % rather than 0.24 % (30). NRW εr′ is unchanged within
  0.06 percentage points, and its μr′ error grows by up to 0.17 points (1.52 % rather than 1.38 %
  for εr 4, 0.98 % rather than 0.81 % for the magnetic sample, 20 cells/λ). The comparison with the analytic slab above uses the analytic β0, as the closed form
  must, so its phase errors include this dispersion.
- **Equal timesteps.** The filled guide's own step is about 28 % longer than the empty one (2.04 vs
  1.60 ps at 20 cells/λ). The runner reads both from an openEMS setup (`setup_only`), runs both at
  the smaller one and checks afterwards that both runs used it. The check reads the port probes'
  time axis: openEMS' progress line leaves its console in fixed notation with two decimals, so
  after any run long enough to print progress, the next run in the same process logs its
  timestep as "0.00 s" (first seen here, with the waveguide ports, but not specific to them;
  [reported upstream](https://github.com/thliebig/openEMS/issues/229#issuecomment-5970656429)).
  The plane-wave cell uses the same helper
  (`fairbeam.material_cell.run_at_one_timestep`, with its voltage probe), including the refusal
  of a step that does not resolve a dispersive sample's poles (section 15c).
- **Excitation.** The example uses the band-limited Gaussian (`excitation="gauss"`). With the
  default Gaussian-derivative pulse, which reaches down to DC, the εr 4 run did not finish: between
  the filled section's TE10 cut-off (3.28 GHz) and the empty guide's (6.56 GHz) the energy
  propagates in the sample but not in the air beside it, so it stays trapped and the end
  criterion is not reached. The fixture warns about this combination.
- **Band.** The band must start above the empty guide's TE10 cut-off c/(2a) = 6.56 GHz. The
  command warns when `f_max` reaches its TE20 (13.1 GHz) or TE01 (14.8 GHz) cut-off. The filled
  section's cut-offs (TE20 at 6.56 GHz for εr 4) lie inside the band and are only reported: a
  homogeneous sample that fills the cross-section does not couple TE10 to TE20 or TE01.
- **Scope.** The sample fills the guide wall to wall. A real sample has an air gap to the walls,
  which lowers the apparent εr; section 17b models it. A dispersive sample
  (`Simulation.dispersive`, section 15c) works in the guide too: a Debye sample (ε∞ 3, Δε 1.5,
  relaxation at 10 GHz, fitted to Lorentz poles) gave max |ΔS11| / |ΔS21| 0.018 / 0.018 against the
  guided slab of its simulated poles and NIST |Δε|/|ε| 1.3 % at 20 cells/λ, as in the plane-wave cell.
- **Unit tests** (`python/tests/test_waveguide_fixture.py`):
  - The guided slab matches the closed form; with kc = 0 it is the free-space slab.
  - The guided NRW and NIST recover lossless, lossy and magnetic samples to 1e-9 from synthetic
    S-parameters; the lossy one also with a 0.5 % slow numerical β0. The runner recovers a Debye
    sample's ε(f) from the guided S-parameters and refuses unresolved poles as the cell does.
  - The de-embedding recovers the face-referred S-parameters exactly.
  - The fixture's mesh, ports, empty reference, cut-offs and band check, and the runner's timestep
    matching and result fields, are checked without an FDTD run.

### 17b. Air gap between the sample and the guide walls

The same fixture with an air gap between the sample and each broad wall (`gap_y`, where TE10's
E field crosses the gap) or each narrow wall (`gap_x`, where the field is near zero), the same
on both sides. Sample: εr 4, tan δ 0.02 at 10.3 GHz, 10 mm. `fairbeam
material-cell` extracts the apparent εr (the one a full sample would need for the measured
propagation constant) and corrects it with `fairbeam.waveguide_fixture.gap_correction`. Its two
models follow NIST Technical Note 1355-R (Baker-Jarvis et al., 1993), Appendix C; the formulas are
written out in the code from the models, not copied:

- **`resonance`** (default; C.1.1, eqs. C.1-C.4): the transverse resonance across the guide
  height, solved at each frequency. With equal gaps the centre plane is a plane of symmetry, so
  the half guide holds a sample of height b/2 − gap_y and a gap gap_y. Multiplied out to have no
  poles: k1 sin(k1 d) − ε κ tanh(κ gap_y) cos(k1 d) = 0, with k1 = k0 √(ε − ε_app),
  κ = k0 √(ε_app − 1) and d = b/2 − gap_y. It is solved for ε by complex Newton, started at the
  capacitor value; the result is the fundamental root, and the equation is even in k1 and κ, so the
  square roots' branches do not matter.
- **`capacitor`** (C.2.2, eqs. C.23-C.24, written there for a total gap b − d, i.e. 2 gap_y here):
  the sample and the two gaps in series, b / ε_app = (b − 2 gap_y) / ε + 2 gap_y. It is the
  frequency-independent (quasi-static) limit of the resonance model (TN 1355-R notes that C.1
  reduces to Westphal's equation at low frequency).
- **Narrow walls** (both models; not in TN 1355-R, derived here): the gaps and the sample side by
  side, weighted by TE10's field energy sin²(πx/a): ε_app = w + (1 − w) ε, with
  w = 2 gap_x / a − sin(2π gap_x / a) / π; first order in the gap.

```bash
cd python
python -m fairbeam material-cell examples/wr90_fixture.py --set tan_d=0.02 --set gap_y=0.1 --nist --threads 4 --out <folder> --sim-root <folder>
python -m fairbeam material-cell examples/wr90_fixture.py --set tan_d=0.02 --set gap_x=0.5 --nist --threads 4 --out <folder> --sim-root <folder>
```

Use `--set gap_y=` 0.025, 0.05, 0.1 or 0.2 and `--set gap_x=` 0.1 or 0.5 for the rows below, and
`--set cpw=30` for the finer mesh. The result file holds the apparent values in `material.nrw` /
`material.nist`, the resonance-corrected ones in `material.gap_correction` and the capacitor ones
in `material.gap_correction.capacitor`. NIST εr′ error against the sample's εr′ 4: the band mean
over 8.2-12.4 GHz (401 frequencies), with its largest value over the band in brackets:

| Gap (each side) | cells/λ | apparent | corrected, capacitor | corrected, resonance | tan δ at 10.3 GHz: apparent / capacitor / resonance | timesteps | cells |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none | 20 | +0.21 % (0.48) | +0.21 % (0.48) | +0.21 % (0.48) | 0.0206 / 0.0206 / 0.0206 | 1 025 | 14 535 |
| none | 30 | +0.11 % (0.24) | +0.11 % (0.24) | +0.11 % (0.24) | 0.0204 / 0.0204 / 0.0204 | 1 517 | 41 847 |
| gap_y 0.025 mm | 20 | −1.17 % (1.32) | +0.30 % (0.54) | +0.26 % (0.51) | 0.0202 / 0.0206 / 0.0206 | 42 517 | 62 985 |
| gap_y 0.025 mm | 30 | −1.28 % (1.36) | +0.18 % (0.30) | +0.15 % (0.26) | 0.0200 / 0.0204 / 0.0204 | 41 480 | 128 760 |
| gap_y 0.05 mm | 20 | −2.45 % (2.60) | +0.45 % (0.69) | +0.32 % (0.54) | 0.0199 / 0.0207 / 0.0206 | 21 238 | 54 910 |
| gap_y 0.05 mm | 30 | −2.57 % (2.64) | +0.32 % (0.43) | +0.19 % (0.27) | 0.0197 / 0.0205 / 0.0204 | 20 760 | 112 665 |
| gap_y 0.1 mm | 20 | −4.77 % (4.92) | +0.92 % (1.15) | +0.42 % (0.60) | 0.0194 / 0.0209 / 0.0206 | 10 660 | 46 835 |
| gap_y 0.1 mm | 30 | −4.90 % (5.00) | +0.77 % (0.88) | +0.27 % (0.46) | 0.0192 / 0.0207 / 0.0204 | 10 179 | 96 570 |
| gap_y 0.2 mm | 20 | −8.73 % (8.90) | +2.39 % (2.65) | +0.62 % (1.15) | 0.0185 / 0.0216 / 0.0204 | 5 240 | 38 760 |
| gap_y 0.2 mm | 30 | −8.88 % (8.99) | +2.19 % (2.40) | +0.44 % (0.94) | 0.0183 / 0.0214 / 0.0202 | 5 320 | 80 475 |
| gap_x 0.1 mm | 20 | +0.28 % (0.51) | +0.28 % (0.51) | +0.28 % (0.51) | 0.0206 / 0.0206 / 0.0206 | 10 660 | 29 835 |
| gap_x 0.1 mm | 30 | +0.13 % (0.24) | +0.13 % (0.24) | +0.13 % (0.24) | 0.0204 / 0.0204 / 0.0204 | 10 701 | 66 378 |
| gap_x 0.5 mm | 20 | +0.25 % (0.49) | +0.26 % (0.50) | +0.26 % (0.50) | 0.0206 / 0.0206 / 0.0206 | 2 310 | 21 420 |
| gap_x 0.5 mm | 30 | +0.12 % (0.23) | +0.13 % (0.24) | +0.13 % (0.24) | 0.0204 / 0.0204 / 0.0204 | 2 460 | 50 505 |

- **Broad-wall gaps lower the apparent εr′ a lot.** A gap of 0.025 mm on each side (0.5 % of
  the guide height) costs 1.2-1.3 %; 0.2 mm costs 8.8 %. The apparent tan δ drops with it
  (0.0183 for 0.02 at 0.2 mm). Both meshes agree within 0.15 percentage points, so this is the
  gap, not the discretisation.
- **The drop follows the resonance model.** Simulated in the gap-free result (30 cells/λ), the
  simulation gives −1.39, −2.68, −5.01 and −8.99 % for 0.025-0.2 mm; the resonance model's band
  means are −1.42, −2.75, −5.15 and −9.24 %, the capacitor model's −1.45, −2.87, −5.58 and −10.56 %.
- **The capacitor correction over-corrects because it is quasi-static.** Its corrected εr′ lands
  0.07, 0.21, 0.65 and 2.08 percentage points above the gap-free result (+2.2 % at 0.2 mm), and
  its tan δ comes out high (0.0214 for 0.0204). The main reason is that it does not depend on
  frequency: it is the low-frequency limit of the transverse resonance, and the gap's effect
  falls with frequency (for 0.2 mm, from −9.7 % at 8.2 GHz to −8.7 % at 12.4 GHz in the resonance
  model).
- **The resonance correction leaves 0.04-0.32 percentage points** (30 cells/λ; 0.05-0.41 at
  20), and its tan δ is the gap-free one within 0.0002. The remainder grows with the gap and
  shrinks with the mesh (0.41 → 0.32 at 0.2 mm), so part of it is the FDTD's resolution of the
  gap with two cells; the resonance model's own approximations (no field bending at the corners,
  the narrow-wall weighting) are the rest, which this study does not separate.
- **Narrow-wall gaps hardly matter.** TE10's field is close to zero at the narrow walls: the
  model gives −0.01 % for 0.5 mm, and the simulation cannot tell it from the gap-free result
  (within 0.07 percentage points, about what the finer transverse mesh alone changes).
- **Higher modes.** By symmetry a gap at the narrow walls excites TE30 (cut-off 19.7 GHz) and one
  at the broad walls TE12 / TM12 (30.2 GHz); TE11 / TM11 (16.2 GHz) would need an asymmetric gap.
  Over the 22.86 mm to the reference planes they decay by 64 dB and 115 dB at 12.4 GHz (TE11 / TM11
  would by 43 dB), so the fixture keeps its planes. A check with the planes at 45.72 mm moves the
  results as much without a gap as with one (|ΔS11| ≤ 0.015, NIST εr′ by 0.7 % at single
  frequencies, the band mean by 0.03 %): that is the fixture's own spread, and the higher modes
  leave nothing measurable. The fixture moves the planes out (with a warning) when an air gap's
  modes would decay by less than 40 dB at f_max.
- **Cost.** Two or more cells across the gap set the timestep: a 0.025 mm gap takes 41 times the
  timesteps of the filled guide at 20 cells/λ (27 at 30) and 75-100 s for both runs on 4 threads,
  against 2-3.5 s without a gap. In practice: measure the gap, then either simulate with
  `gap_x` / `gap_y` or apply `gap_correction` to the measured data.
- **Unit tests** (`python/tests/test_waveguide_fixture.py`, `AirGap` and the runner):
  - the capacitor model against TN 1355-R eqs. C.23-C.24 (real and imaginary parts, total gap
    b − d = 2 gap_y) and as the resonance model's low-frequency limit;
  - the resonance correction inverting its forward model for lossless and lossy samples, on the
    fundamental root, independent of the square roots' branches, and its WR-90 band means;
  - the narrow-wall weight against the integral of TE10's field energy;
  - the gap's modes and their decay, the graded transverse mesh (sample edges on lines, at least
    two cells in a gap, grading ≤ 1.3, no change without a gap), the moved reference planes;
  - both corrections in the result file, with `--tol-material` checking the resonance one.

## 18. Focused WR-90 transmission comparison

[Pozar comparison record](benchmarks/pozar-comparisons.md) documents a limited WR-90 transmission
check associated with Example 3.9. It uses the existing `python/examples/waveguide_thru.py`, fixed
measurement planes and three meshes with the bundled openEMS 0.37.0rc3 runtime on Windows.

The accepted quantities are complex S21 over 8.2-11.8 GHz and its phase at 10 GHz, subject to the
recorded reflection guard and energy stops. Every target check and both consecutive mesh comparisons
pass at the tolerances declared before the runs. The full Example 3.9 remains unvalidated because
the separately measured group velocity did not meet its convergence criterion. No other example is upgraded to validated by this limited comparison.

The record contains our model parameters, equations and numerical results, and adds no gallery bundles.

## 19. Chapter 3 comparison scopes

The [Chapter 3 record](benchmarks/pozar-chapter-03.md) collects matching, mesh-qualified
quantities for Examples 3.1–3.7, with reproduction commands and explicit model limits.
Example 3.1 uses a fresh source-completed 20/30/40 study with exact -80 dB stops;
the historical prematurely stopped columns remain excluded. Other retained cohorts
and migration controls keep their original provenance. The record states finite
mesh-change limits and nonmonotonicity explicitly; qualification applies only to
each listed quantity and geometry, not an asymptotic order.

It excludes conductor-loss discrepancies, the unqualified microstrip impedance/loss
results, the incomplete 3.8 mesh sequence and the separate group-velocity limitation
noted above. No gallery model or generated bundle is changed.

## 20. Chapter 4 comparison scopes

The [Chapter 4 record](benchmarks/pozar-chapter-04.md) collects the matching,
mesh-qualified ideal-current modal amplitude and input resistance for 4.8. It passes
two consecutive mesh-change gates, an independent boundary control and its own
target/QA limits after source completion and exact -90 dB energy stops. The 4.2
interface remains excluded because its new boundary control failed its energy stop.

Filament reactance, practical launches and general mode conversion are excluded.
The probe's target errors are nonmonotone; boundary/triplet sensitivity limits the
accuracy claim to the declared tolerances. Six calculation-only examples require
no new FDTD. No gallery model or generated bundle is changed.

## 21. Chapter 5 comparison scopes

The [Chapter 5 record](benchmarks/pozar-chapter-05.md) collects the sampled ideal TEM
scopes that meet the declared target, successive mesh and independent-boundary limits
for Examples 5.3 and 5.5–5.8. Tapers also meet two profile-refinement limits.
It links each independent fixture PR and its reproduction commands.

Examples 5.1, 5.2 and 5.4 remain excluded because their stopping or numerical gates
fail. Strict Chebyshev/Klopfenstein ripple compliance, practical PCB layouts and
arbitrary Designer measurements are outside the accepted scopes.

## 22. Chapter 6 comparison scopes

The [Chapter 6 record](benchmarks/pozar-chapter-06.md) collects the sampled
dielectric-loss frequency and unloaded-Q scopes for the ideal coaxial resonator
(6.1), rectangular TE101/TE102 cavities (6.3) and closed cylindrical TE011 cavity
(6.4). It also records complex reflection, resonance and loaded Q for an explicitly
declared mapped TEM circuit dual (6.6), including an independent stricter-time
control. Both successive mesh comparisons and each declared independent control
pass their frozen limits; no asymptotic convergence order is claimed.

Open microstrip and dielectric-resonator Q, bulk-copper loss, practical coupling
gaps and unmeasured external/radiation-Q partitions remain excluded. Examples
6.7/6.8 are calculation-only. The record links the fixture PRs and reproduction
commands; no gallery model, generated bundle or textbook content is added.

The three approved long boxed-microstrip refinements for 6.2 are complete.
Their stopping, successive mesh and air-clearance controls pass, but the fine
frequency error is 1.017947%, above the unchanged 1% target. This scope remains
excluded; the chapter record links the full measurements in PR #81.
