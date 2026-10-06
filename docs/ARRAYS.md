# Arrays: embedded element patterns and beam steering

This page covers the data side of Fairbeam's phased-array support: what a multi-port antenna run
stores, how array patterns are formed from it, and what the numbers mean. The viewer's
beam-steering controls read the same data through `src/lib/sparams.ts` and `src/lib/array.ts`.

## One simulation per port

For a model with N ports, `fairbeam run` builds and runs the model once per excited port (default:
all ports when N ≤ 4, otherwise port 1; `--excite all|1,3` overrides). In each run one port is
driven and every other port stays in place, terminated in its resistance. Each run records:

- the power waves at every port, which give one column of the S-matrix (`results.sparams`, see
  [BUNDLE.md](BUNDLE.md#sparams))
- the far field of that run (`results.farfield` entries tagged with `port`)
- the complex **embedded element pattern** E_θ, E_φ on the θ/φ grid (`results.element_patterns`)

The patterns are *embedded* because the other elements are present and loaded while one port is
driven. They therefore include mutual coupling, scattering by the neighbors and the finite ground
plane. This is the standard basis for array analysis (Mailloux, *Phased Array Antenna Handbook*,
ch. 6; Hansen, *Phased Array Antennas*, ch. 7).

## Normalization

Each stored pattern is the far-field phasor E (V/m, peak) at `radius_m` (1 m) produced by a **unit
incident power wave** at its port, `a = U_inc / sqrt(Z_ref) = 1 sqrt(W)`. Every port uses the same
phase center (`phase_center`, the model's NF2FF center), so the patterns can be superposed directly.

For complex excitation weights w_j (the incident waves at the ports, in sqrt(W)):

| Quantity | Definition |
| --- | --- |
| Array field | E(θ, φ) = Σ_j w_j E_j(θ, φ) |
| Radiation intensity | U = r² (\|E_θ\|² + \|E_φ\|²) / (2 η0) |
| Incident power | P_inc = ½ Σ_j \|w_j\|² |
| Radiated power | P_rad = ∮ U dΩ over the physical space (the image space is divided by 2^mirror_planes) |
| Directivity | D = 4π U / P_rad |
| Realized gain | G_r = 4π U / P_inc. It includes mismatch, coupling into the other ports and loss |
| Total efficiency | P_rad / P_inc |
| Active reflection coefficient | Γ_active,i = Σ_j S_ij w_j / w_i. It is what port i sees with all ports driven |

Consistency check on the 2×1 patch array: driving port 1 alone through `combine` gives
D_max = 6.27 dBi and realized gain 6.019 dBi. The bundle's own single-port far field has pattern
D_max 6.27 dBi and realized gain 6.019 dBi. The superposition therefore reproduces openEMS'
normalization exactly.

## Python API (`fairbeam.array`)

```python
import json
from fairbeam import array

b = json.load(open("public/projects/patch-array-2x1.json"))
r = array.combine(b, {1: 1, 2: 1})                   # broadside: equal amplitude and phase
print(r["dmax_dbi"], r["peak_theta"], r["peak_phi"], r["realized_gain_max_dbi"])
print(r["gamma_active_at_f"])                         # {port: complex}

w = array.steering_weights(b, theta0=20, phi0=90)     # textbook progressive phase
r = array.combine(b, w)
theta, d_dbi = array.cut(r, phi_deg=90)               # elevation cut through the scan plane

array.combine(b, {1: (1.0, 0), 2: (0.5, -60)})        # amplitude and phase in degrees also accepted
```

- `combine(bundle, weights, f=None)` works at the stored element-pattern frequency nearest `f`.
  It returns the directivity grid `[theta][phi]` in dBi, `dmax_dbi`, `peak_theta` and `peak_phi`,
  the realized gain grid and its maximum, `p_inc_w`, `p_rad_w` and `total_efficiency`. When the
  S-matrix is complete it also returns `gamma_active` per port over `results.frequency` and
  `gamma_active_at_f`.
- `steering_weights(bundle, theta0, phi0, f=None, amplitudes=None)` returns
  w_n = A_n exp(−j k r̂0 · r_n), with the **port centers** as element positions.
- Weights may be a dict `{port: complex}`, a dict `{port: (amplitude, phase_deg)}`, or a sequence
  in port order. Ports without a weight are terminated, not driven.

## Demonstration: `python/models/patch_array_2x1.py`

The model has two copies of the probe-fed patch from `patch_antenna.py` (32 × 40 mm, ε_r 3.38,
1.524 mm) on one substrate. They are 61.2 mm apart (λ0/2 at 2.45 GHz) along y, which is the
H-plane. It has MUR boundaries and mesh_div 20. Two GPU runs took 2.8 s in total.

| Quantity | Value |
| --- | --- |
| Resonance (S11 min), each port | 2.4345 GHz, −25.3 dB |
| Coupling S21 at resonance | **−17.3 dB** (H-plane, λ/2). Typical measured values are −17 to −20 dB |
| Reciprocity \|S21 − S12\| | < 1e-6 (the mesh is mirror-symmetric) |
| Single element | D_max 6.27 dBi (pattern), realized gain 6.02 dBi, radiation efficiency 0.93 |

Excitations evaluated from the same two runs:

| Weights | D_max | Beam peak (θ, φ) | Realized gain | \|Γ_active\| port 1 / 2 |
| --- | --- | --- | --- | --- |
| Port 1 only | 6.27 dBi | (9°, 265°) | 6.02 dBi | −25.3 dB / – |
| Broadside, 1 : 1 | 9.19 dBi | (0°, –) | 9.01 dBi | −21.7 dB / −21.7 dB |
| Textbook taper for θ0 = 20° (61.2° progressive phase) | 9.14 dBi | (15°, 90°) | 8.93 dBi | −18.8 dB / −18.0 dB |
| Textbook taper for θ0 = 30° (89.5° progressive phase) | 8.99 dBi | (21°, 90°) | 8.74 dBi | −17.0 dB / −16.4 dB |

- **Array gain**: broadside D_max is 2.9 dB above the single embedded element, against the ideal
  3.01 dB for two elements. The rest is coupling and the elements' asymmetric embedded patterns.
- **The beam lands short of the textbook angle** (15° for a 20° taper, 21° for 30°). With only two
  elements the array factor is broad, and multiplying it by the element pattern, which falls off
  away from broadside, pulls the peak back toward θ = 0. Getting exactly 20° needs more phase or
  more elements. `combine` reports the actual peak.
- **Scan changes the match**: the active reflection rises from −21.7 dB (broadside) to −17 dB at
  the 30° taper, because the coupled wave adds to the reflection with a scan-dependent phase. This
  is the effect behind scan blindness in large arrays. Here it is mild.
- The directivity differs by 0.1 dB between openEMS' own value (6.37 dBi, NF2FF-surface power) and
  the pattern integral (6.27 dBi). This comes from the MUR boundaries (see VALIDATION.md,
  section 1c). `combine` always uses the pattern integral.

## 4×1 patch array: `python/models/patch_array_4x1.py`

This model has four copies of the same patch, 61.2 mm apart (λ0/2 at 2.45 GHz, d/λ = 0.501 at
the 2.4525 GHz resonance) along y. It uses PML boundaries and the automatic mesh
([MESHING.md](MESHING.md)): 433 k cells, four GPU runs in 18 s in total. The bundle is 0.64 MB,
with element patterns on the full 3° × 5° grid (no decimation needed).

**S-matrix at 2.4525 GHz** (reciprocity 2.2e-3, largest column power 0.995):

| | Port 1 (edge) | Port 2 (inner) |
| --- | --- | --- |
| Reflection | S11 −23.5 dB | S22 −17.0 dB |
| 1st neighbor | S21 −15.7 dB | S32 −14.3 dB |
| 2nd neighbor | S31 −24.7 dB | S42 −24.5 dB |
| 3rd neighbor | S41 −33.3 dB | – |

The patches are tuned alone. Embedded in the array, the inner elements see more coupling, and
their own match degrades from −23.5 dB (edge) to −17 dB. Neighbor coupling here (−14 to
−16 dB) is 1.5-3 dB stronger than in the 2×1 model. The two models differ in mesh (automatic vs
manual) and boundaries (PML vs MUR); these results are the more trustworthy of the two.

**Embedded element patterns.** The edge element has D_max 6.66 dBi, peaking 6° off broadside
toward the array's outer side, with realized gain 6.26 dBi. The inner element has D_max 6.60 dBi,
broader and tilted, peaking at θ = 30° in the array plane, with realized gain 5.93 dBi: its
radiation efficiency is 0.87, against 0.92 for the edge element, because more of its power couples
into the terminated neighbors.

**Scanning** in the array plane (φ = 90°) with the textbook progressive phase
(`array.steering_weights(b, θ0, 90)`):

| θ0 | Phase step | D_max | Beam peak | HPBW | Peak sidelobe (front) | Realized gain | η_total | \|Γ_active\| ports 1 / 2 / 3 / 4 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0° | 0° | 11.95 dBi | 0° | 24° | −14.2 dB (at −42°) | 11.77 dBi | 0.959 | −24.1 / −15.0 / −15.0 / −24.1 dB |
| 15° | 46.5° | 11.84 dBi | 15° | 24° | −12.3 dB (at −27°) | 11.66 dBi | 0.959 | −21.3 / −17.4 / −16.7 / −21.9 dB |
| 30° | 90° | 11.69 dBi | 27° | 24° | −11.1 dB (at −12°) | 11.43 dBi | 0.942 | −17.0 / −20.0 / −19.1 / −16.6 dB |
| 45° | 127° | 11.35 dBi | 39° | 27° | −9.0 dB (at 0°) | 10.59 dBi | 0.840 | −12.7 / −9.5 / −9.0 / −12.3 dB |

- **Array gain**: broadside D_max is 5.3-5.35 dB above the embedded element (ideal 6.02 dB for four
  elements). The shortfall is the non-identical embedded patterns and the coupling.
- **Scan loss** is 0.6 dB in directivity and 1.2 dB in realized gain at 45°. The extra loss in
  realized gain is the active mismatch: |Γ_active| of the inner elements rises from −15 dB at
  broadside to −9 dB at 45°, and the total efficiency drops from 0.96 to 0.84. That is the
  behavior a phased array designer has to budget for. It is only visible with embedded patterns
  and the full S-matrix.
- **Beam pointing**: the peak lags the commanded angle at large scan (27° for 30°, 39° for 45°),
  because the element pattern falls off away from broadside (see the 2×1 discussion above).
- **Grating lobes**: `array.grating_lobes(b, 45, 90)` gives d/λ = 0.501 against the limit
  1/(1 + sin 45°) = 0.586, so there are none in visible space. At 45° scan they would appear above
  f = 0.586/0.501 × 2.4525 ≈ 2.87 GHz, outside the patch bandwidth. The 45° pattern's largest
  sidelobe (−9 dB, near broadside) is an ordinary sidelobe of a 4-element array, not a grating lobe.
- **Bandwidth**: the patches are narrowband. At 30° scan, |Γ_active| is −14 to −22 dB at 2.45 GHz
  but only −3 to −5 dB at 2.40 and 2.50 GHz.

## Storage

`results.element_patterns` stores 4 arrays of n_θ · n_φ values per port and frequency as base64
little-endian int16 with one scale factor per port and frequency (`"i16le-base64-scaled"`; the
quantisation step is about −90 dB below the peak, so synthesized patterns change by at most 0.01 dB
within 50 dB of the peak). On the 3° × 5° grid that is about 47 kB per port and frequency. The 2×1
bundle with one frequency is 283 kB in total (118 kB gzipped), the 4×1 bundle 636 kB (260 kB
gzipped). Older bundles use float32 (`"f32le-base64"`, twice the size) and are still read. If the
section would exceed about 2.5 MB (counted at float32 size), the θ/φ grid is decimated by an
integer factor (recorded in `decimation`), keeping θ = 180° so the sphere integral stays closed.
The exact layout is in [BUNDLE.md](BUNDLE.md#element-pattern-encodings).

## Limitations

- **Frequencies**: patterns exist only at the stored far-field frequencies. These are the band
  centers of the first excited port unless `--pattern` sets them. Γ_active is available over the
  whole band, but uses frequency-independent weights.
- **Element positions** for steering are the port centers, which is fine for identical elements
  fed at the same relative point. For other layouts, pass explicit weights.
- **Grating lobes** are computed by `array.grating_lobes` (uniform linear arrays; element positions
  are port centers) but not yet flagged automatically in the viewer. There are no warnings for scan
  blindness or truncated patterns near the grid edge. Nor are there beam-pointing optimizers or Taylor or
  Chebyshev tapers; weights are whatever you pass.
- **Directivity** is integrated on the stored grid (3° × 5° by default). Very narrow beams from
  large arrays need a finer `theta_step` / `phi_step` in `Simulation.evaluate`.
- **Cost**: one run per port (N runs for N ports). For large arrays, simulate a small subarray, or
  excite only a few ports and use symmetry. Only fully excited arrays have a complete S-matrix and
  Γ_active.
- **Half-space models** (PEC ground boundary): `combine` handles the image correction through
  `mirror_planes`, but this path has not been validated on a simulated array yet.
