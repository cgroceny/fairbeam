# How results are computed

- **Excitation.** By default this is a DC-free Gaussian-derivative pulse, -20 dB at `f_max`. openEMS' modulated Gaussian carries a DC component when `f_min/f_max` is small (for example 0.5-8 GHz). The static field it leaves behind keeps the energy above the end criterion, so the run continues to the timestep limit. S-parameters are unaffected, but the run takes about 10x longer. On the Sierpinski model the derivative pulse took the run from about 150 s (not converged) to about 13 s (converged at -47 to -61 dB). `Simulation(..., excitation="gauss")` restores openEMS' pulse.
- **End criterion.** A run stops when the field energy has decayed to the end criterion, **−60 dB by default**, evaluated every Nyquist period (`exact_endcriteria`, so the stopping point does not depend on machine speed; `--no-exact` restores openEMS' ~4 s wall-clock check). Resonance frequency and Dmax are already settled at −40 dB, but S11 depth and radiation efficiency of high-Q structures are not: on the patch, −40 dB gives |S11| −24 dB and η 0.86, −60 dB gives −37 dB and 0.95, −70 dB gives −39 dB and 0.96 (un-radiated ring-down energy corrupts P_acc). Override per run with `--end-db`.
- **S11 and Zin** come from the excited lumped port: S11 = u_ref / u_inc and Zin = u_tot / i_tot, evaluated at `--points` frequencies between `f_min` and `f_max`.
- **Bands** are contiguous frequency ranges with |S11| < -10 dB. Each band reports its edges, the frequency of minimum S11 (`f_center` in the bundle), fractional bandwidth, and whether it touches the edge of the simulated range. The app's band tables (Summary, the S-parameter side panel, the Examples panel) name two frequencies: the **Center** is the middle of the edges, (f_lo + f_hi) / 2, and the **Best match** is the frequency of minimum S11. The fractional bandwidth they show, and the Summary's Bandwidth (%), is the width divided by that center; the bundle's `fractional_bw` divides by `f_center`. CSV/TSV exports use the tables' definitions: `f_center_GHz` is the band middle, `f_best_GHz` is best match, and exported `fractional_bw` divides by the middle ([CSV columns and open-band flags](EXPORTS.md#matched-band-csv-columns)). A band that touches the edge of the simulated range continues past it: its open edge is marked ≤ or ≥, its width is a lower bound, and the example picker names it by its range ("≥ 8–12 GHz") instead of a single frequency.
- **Far field.** openEMS records the fields on a near-field box and applies the NF2FF transform at the band centers (or at `--pattern`). The default grid is θ 0-180° in 3° steps and φ 0-360° in 5° steps, with the phase center at `nf2ff_center`. Designs can change both steps in **Simulation settings → Monitors** (0.25-90°); Python models can set `sim.pattern_steps = (theta_step, phi_step)`. Both θ poles are retained and the duplicate φ=360° seam is excluded; the final interval may be shorter than requested. Smaller steps sample narrower features but do not establish mesh or solver convergence. Array synthesis uses the stored element-pattern grid, which may be reduced for the storage budget and is then flagged in the run log and Array tab. With PEC or PMC boundaries, openEMS mirrors the recording surface and integrates over the image as well. Fairbeam therefore divides Prad by 2^m and multiplies Dmax by 2^m, where m is the number of PEC/PMC boundaries. Directivity then refers to the physical half space, for example a monopole over an infinite ground plane.
- **Radiation efficiency** = Prad / P_acc. P_acc = ½·Re(u·i*) is the power accepted at the port. It is stored at the far-field frequencies and, with `--efficiency [N]` (a design's `monitors.efficiency`), at N frequencies across the band, with a reliability flag per frequency ([BUNDLE.md](BUNDLE.md#efficiency)). A model declared lossless (`sim.lossless = True`) reports 1 while Prad / P_acc is within 5 % of 1 ([BUNDLE.md](BUNDLE.md#results)).
- **Gain** = efficiency · Dmax. **Realized gain** = gain · (1 − |S11|²).

## Pattern cut analyzer

The **Pattern** tab in Designs and Examples offers principal planes (φ 0°/90°), an arbitrary fixed-φ elevation plane, and an azimuth/conical cut at fixed θ. The **Azimuth θ 90°** button selects the equatorial plane. Elevation plots use signed θ (negative angles are the opposite φ half-plane); conical plots use signed φ around the chosen θ ring. Polar and Cartesian views use the same samples. Comparison uses one selected cut per run and names each run's actual nearest stored far-field frequency; Array overlays apply the cut to both the synthesized array and selected element.

Unsampled cuts interpolate only adjacent finite samples in dB, using the actual periodic φ seam interval. No theta extrapolation or half-space mirroring is performed. Missing samples remain gaps, including a missing zenith between elevation half-planes; incomplete polar cuts are not closed. The displayed spacing is the actual plotted min/max angular interval, including a shorter seam. Interpolation does not recover angular resolution or establish EM convergence.

- **Cut peak** is a sampled estimate; flat patterns or equal competing maxima have no unique peak.
- **HPBW** is the separation of the nearest −3 dB crossings on either side of that peak, linearly estimated between adjacent finite samples. A gap or unresolved crossing produces N/A. A gap elsewhere does not erase a locally resolved width.
- **SLL** is the highest resolved sampled local maximum outside the main lobe, bounded by its first local minima. It requires a complete, finite circular cut and uses an explicit detection floor of peak −40 dB. No resolved sidelobe, sidelobes below that floor, incomplete coverage and gaps are different N/A reasons; none becomes zero dB.
- **Peak / antipode (F/B)** compares the selected cut's sampled peak with its true 3D antipode, `(180° − θ, φ + 180°)`. For a non-equatorial conical cut the back direction lies on another θ ring, outside the plotted cut. Both directions require stored angular coverage and finite adjacent values. Half-space data or an unavailable antipode give N/A.

Directivity, gain, realized gain and available RHCP/LHCP partial directivities use the same extraction and metric rules. Quantity availability still applies, and each trace names the quantity actually shown. The analyzer does not change solver data, the Array steering weights, or the 3D view. CSV/copied pattern data from the active result include the selected cut coordinates, quantity, metric estimates/statuses and interpolation/spacing metadata; standard report data without a cut selection retain the complete stored grid.

The Examples publication-figure menu uses the selected cut, quantity and projection for the active stored run. Its SVG/PDF source includes visible estimate readouts and qualifications, with detailed numerical metrics in SVG description metadata. On-screen figure export preserves the visible chart. Standard generated report packages retain their explicit principal-plane defaults; they do not silently inherit interactive UI state. All cut controls are verified against deterministic synthetic analytic fields, not a new solver or measurement result.

## Ludwig-3 polarization

With optional complex far-field storage enabled before a run, the Pattern panel offers
**Ludwig-3 co-polar**, **Ludwig-3 cross-polar** and **Cross-polar discrimination (XPD)**.
The fixed linear reference angle α is measured in the global xy plane from +x toward +y:
0° means x and 90° means y, periodic modulo 180°. The same session preference drives the
3D pattern, cut analyzer, sampled peak/+z readouts and explicit-angle exports. It does not
follow the beam or force cross polarization to zero at beam center. Circular polarization,
for example, has equal co/cross powers for every linear reference.

Writing δ = φ − α, the [Ludwig third definition](https://orbit.dtu.dk/en/publications/the-definition-of-cross-polarization/)
(IEEE TAP 21(1), 116–119, 1973, DOI 10.1109/TAP.1973.1140406) is:

```
Eco    = Etheta cos(delta) - Ephi sin(delta)
Ecross = Etheta sin(delta) + Ephi cos(delta)
```

The full complex fields are rotated before taking squared magnitudes. Co/cross partial
directivity is `Dmax_dBi + 10 log10(Pcomponent / power_peak)`, using the retained native
normalization in common-scale units. Dmax already contains the physical-space mirror
correction; it is not applied again. The common int16 codec preserves relative phase to
quantization precision. These values are partial **directivity (dBi)**, not realized gain.

XPD is `10 log10(Pco/Pcross)` in **dB**, displayed on a signed −60…+60 scale. It is missing
where total field power is below the retained peak minus 20 dB. Values at ±60 dB are bounds,
shown as ≥60/≤−60 in readouts. Co/cross are floored at Dmax−60 dB; that floor does not mean
finite power was measured at an exact null. Zero stored fields (including values quantized
to zero) and θ=180° are missing: the fixed transverse reference is singular at the −z pole.
The +z readout uses the stored θ=0 sample; it is unavailable if that sample is absent.

Co/cross use the cut analyzer's existing grid-limited lobe estimates. XPD is a power ratio:
polar radius is not radiation strength, and HPBW, SLL and front/back metrics do not apply.
Unsampled cuts interpolate adjacent finite values in dB and preserve gaps. CSV/copy and
selected-cut SVG/PDF exports record the actual normalized reference angle, units, mask,
floor, saturation and normalization convention; missing derived CSV values are empty.
Package pattern/far-field CSVs also carry these derived values when fields are present,
using the angle explicitly supplied by the export action (pure APIs default to 0°).
Standard report figures retain their explicit directivity/principal-plane defaults.

Old bundles without valid complex samples retain scalar quantities and show why Ludwig-3
choices are unavailable. The tests for rotation, phase, quantization, port identity and
exports are synthetic controls; they do not establish mesh/time convergence or measured
cross-polarization accuracy for an antenna.

## Designer array synthesis

For a run with at least two stored element-port patterns, the Designer's **Array**
tab synthesizes directivity from their complex fields at a stored frequency. Its
amplitude, phase and steering controls also supply the open Pattern tab and 3D
pattern for that run. Pattern data and figure exports follow the synthesized cut;
comparisons retain stored results. Feed settings reset when their run or frequency
changes and are separate from the Examples viewer. Package export uses weights only
for the exact selected run and captures its selected stored frequency: the weights CSV's
active reflection and synthesized package/report array figures use that frequency only.
A selected set with fewer than two elements cannot synthesize or export a Designer feed.
See [Array feeds in the Designer](DESIGNER.md#array-feeds-in-the-designer)
for the lifecycle and export rules, and [ARRAYS.md](ARRAYS.md) for the calculation.
This reuses stored samples without a solver run; it establishes neither new gain or
efficiency accuracy nor mesh or angular-grid convergence.

## Unwrapped phase and group delay

In the S-parameters result view or the Examples reflection view, choose **Unwrapped phase**
or **Group delay** from the data-format selector. Both use the selected complex S-parameters;
magnitude-only reference imports cannot supply phase. Group delay is
`τg = −dφ/df / 360` in ns when phase is in degrees and frequency is in GHz.
The **Aperture** control selects a local least-squares linear phase fit over 3, 5, 11 or 21
samples. Wider apertures suppress noise but also smooth narrow dispersive features. At an
endpoint the fit uses a one-sided window; a short valid segment uses all its available samples
(at least two). Changing the aperture does not alter the unwrapped phase or stored results.

Each original frequency grid must be finite, nonnegative and strictly increasing; invalid
grids are rejected rather than sorted or deduplicated. Zero complex amplitude, nonfinite
samples and an exactly ambiguous 180° step leave gaps. Neither interpolation nor the
derivative crosses a gap. Unwrapping starts independently after each gap, so the absolute
phase branch is arbitrary by whole turns. The warning for an observed phase wrap or 180°
step is not proof of aliasing: recovering the true delay assumes adjacent true phase
increments below 180°. Extra complete turns are indistinguishable from the sampled complex
data. Refine the frequency sampling when this assumption is uncertain. Delay near deep
reflection nulls may be noisy even when the complex amplitude is nonzero.

Comparisons unwrap each run on its original grid, interpolate continuous phase onto the
shared frequency grid, then fit the derivative there. The aperture therefore counts samples
on the displayed comparison grid, not on each original grid; adding a valid comparison can
change the smoothing bandwidth. No values are extrapolated beyond a run's range, and
invalid frequency grids and magnitude-only runs do not contribute grid points. Copy data and CSV use the
same grid, units, aperture and unsampled numeric values as the plot; missing values are empty
cells. The Examples data table uses those values too (long tables may be visually sampled).
Exports that request phase from a magnitude-only reference are explicitly rejected.
The existing **All** format remains the magnitude, wrapped phase and real/imaginary views.
These formats are display analysis only; they do not add TDR/time-domain results.

## Ideal matching estimate

The Designer's single-run **Impedance** and **Smith** views offer an opt-in ideal
matching circuit. Pick an existing frequency sample and one of the admissible
L-sections (series or shunt at the source, with either algebraic sign). Reactive
loads can admit four solutions. Values are positive inductances in nH or
capacitances in pF; zero elements are omitted. The displayed order is from source
to load. A purely resistive load also admits a lossless 90-degree transformer,
with `Zt = sqrt(Rload * Zref)`. Its electrical length varies linearly with frequency;
no substrate, dispersion or physical line length is inferred.

The original and ideal matched |S11| curves use the stored load impedance at every
frequency, with constant ideal component values. Smith also overlays the ideal
reflection locus. This is a circuit what-if, **not** a re-simulated or measured
matched antenna: losses, parasitics and layout are absent. The original bundle,
model and exported CSV/Touchstone data are unchanged. The estimate resets when
changing result or view. Matching uses the existing stored reference plane; it
does not de-embed a feed or insert elements into the Design.

Any session port-postprocessing projection disables this estimate, including a
real-reference change or ideal feed removal. Choose **Show original result** in
**Port postprocessing** first; the matching tool never silently returns to a
different plane. Unwrapped phase and group-delay plots and CSV instead follow
the active processed matrix and retain its port-processing provenance.

Only one-port complex data with a constant positive real reference is supported.
Magnitude-only references, complex or frequency-varying references and multiport
or run-comparison matching are unavailable. Missing/nonpassive load samples stay
gaps. Synthesis uses the selected stored sample without interpolating an unknown
load or extrapolating outside the recorded band. Analytic circuit controls check
the equations; they do not establish electromagnetic or manufacturing accuracy.

## Accuracy notes

- openEMS uses a staircase (Yee) FDTD mesh. Slanted and curved edges snap to mesh lines, and zero-thickness sheets sit on grid planes. Expect resonances to shift by a few percent unless the openEMS mesh is fine on the metal edges.
- Check mesh convergence before trusting a number. For a designer file: `fairbeam converge <design.json>` (or Simulation › Mesh convergence… in the designer) reruns it at 15, 20, 30, 40 cells per wavelength and stops when the resonance, |S11| and Dmax settle ([STUDIES.md](STUDIES.md#fairbeam-converge)). For a Python model: `fairbeam converge <model> --param mesh_div=15,20,30` (or `cell=0.8,0.6,0.45` on the Sierpinski model); confirm that band centers move by less than your tolerance. How metal edges and zero-thickness sheets are meshed matters more than the global cell size: see [VALIDATION.md](VALIDATION.md). The smallest cell sets the timestep for the whole domain, so avoid slivers (`fairbeam.mesh.merge_lines`).
- Conductor loss: metals are perfect conductors unless a design metal has a `conductivity` (S/m) or a model uses `sim.metal(..., conductivity=)`; then sheets are openEMS conducting sheets of the given thickness (default 0.035 mm) and the efficiency includes the copper loss ([MODELS.md](MODELS.md)).
- Literature check, Sierpinski monopole, iteration 3, 48 mm: simulated bands at 3.303 and 6.219 GHz. Puente et al. (1998) measured an 89 mm gasket; scaled to 48 mm, their bands fall at 3.226 and 6.508 GHz. The deviations are +2.4 % and −4.4 %, which is plausible given the staircase mesh, the contact bridges and the idealised infinite ground.
- Patch antenna: the converged resonance is 2.455 GHz (mesh_div 30-40). The transmission-line model (`fairbeam.analytic.patch_resonance`: Hammerstad ε_eff and ΔL) gives 2.513 GHz (-2.3 %). The simplified formula ignores the finite ground and the probe, so this agreement is within its expected accuracy.
- Half-wave dipole: resonance 1.3-1.4 % below the closed-form induced-EMF resonance, R_in 72-73 Ω, Dmax 2.13-2.15 dBi, efficiency 0.999. Full tables, the end-criterion study and recommended settings are in [VALIDATION.md](VALIDATION.md).

The [RunHistory sweep CSV](STUDIES.md#runhistory-sweep-csv) follows the same band definitions with lowercase column names: `band_lo_ghz` and `band_hi_ghz` are the edges, `band_center_ghz` is their middle, and `band_best_ghz` is the |S11| minimum frequency. It uses the first band of each job; missing edges leave the center blank. RunHistory labels the minimum frequency **Best match**.


## Designer port postprocessing

In a Designer result's S-parameters, impedance, VSWR, Smith, table or summary tab,
open **Port postprocessing**. Choose one common reference `R + jX` in ohms (`R > 0`) and
a signed, one-way delay in picoseconds for each **physical** port. The matrix index
is shown beside the physical ID. Apply changes explicitly; **Show original result**
resets only that loaded result. Settings are held in memory by loaded result identity,
not a filename, and are never saved into the bundle, design or optimizer inputs.

The operation removes an ideal matched lossless feed at each original port reference
first, then renormalizes the full power-wave matrix. With the exp(+jωt) convention,
`S'_ij = S_ij exp(+j 2π f (τ_i + τ_j))` before renormalization. Positive delay moves
toward the device; negative delay adds line. The feed must be matched to the original
reference; reflection receives twice its one-way phase. No material, propagation
velocity, length, loss or dispersion is inferred. Phase arguments exceeding 1,000,000
radians at any port are refused to bound floating-point phase precision.

The persistent **Postprocessed** label identifies this result view. S, Z,
the matched bands and summary, Copy/CSV, Touchstone and exported plot titles use the
same projection. Comparison retains each run's own settings and identifies processed
traces/rows. CSV includes processing provenance; Touchstone includes source references,
physical IDs, delay signs/units and the transform order in comments. The matched bands
are contiguous stored samples below the result's threshold (default −10 dB), without
invented crossing frequencies; a band ending at missing data is a lower bound. A missing
or singular coupled matrix sample stays a gap, with a displayed count. Touchstone refuses
gaps rather than inventing complex values. Smith and VSWR use the same projection when
the target reference is real. For complex targets, these two views and Touchstone are
unavailable, with an explanation; CSV retains the complex samples and provenance.

Complex targets use Kurokawa power waves:
`a = (V + Zref I)/(2 sqrt(Re Zref))`, `b = (V - conj(Zref) I)/(2 sqrt(Re Zref))`.
Consequently `Gamma = (Zin - conj(Zref))/(Zin + Zref)` and
`Zin = Re(Zref) (1 + Gamma)/(1 - Gamma) - j Im(Zref)`; the other ports are terminated
in `Zref`. A conjugately matched load has zero power reflection; a short at complex
reference does **not** generally have Gamma = −1. Standard Smith impedance circles and
the traveling-wave standing-wave ratio do not describe these complex-reference power
waves. No non-passive value is clipped, and an exact open retains S = 1 with undefined
finite impedance. See the [scikit-rf complex-reference discussion](https://scikit-rf.readthedocs.io/en/latest/examples/networktheory/Working%20with%20Complex%20Characteristic%20Impedances.html).

For mixed mode, enter disjoint ordered pairs of **physical** port IDs, such as `7,19; 2,5`.
The first number is positive polarity. The complete wave basis contains every differential
channel, every common channel, then the unpaired single-ended channels. With equal target
references, `aD = (ap-an)/sqrt(2)` and `aC = (ap+an)/sqrt(2)` (and likewise for b), so
`Smodal = T S T^T`. References are `2Z` for differential, `Z/2` for common and `Z` for
unpaired channels. Labels retain both mode and physical IDs; reversing a pair changes
its differential coupling signs. Bands, the impedance/table view and summary refer to
the **first differential pair**, explicitly labelled Sdd11; the S/Smith selectors expose
other channels. Comparing different reference/plane/modal settings suppresses network
metric improvement deltas. Radiation remains the original physical-port evidence.

Real-reference modal Touchstone uses **Touchstone 2.0**, extension `.ts`, explicit
`[Mixed-Mode Order]`, Full matrix data, and `[Two-Port Data Order] 12_21` for two channels.
The D/C/S descriptors use canonical original single-ended indices, not physical IDs;
comments retain the index-to-physical-ID mapping. `[Reference]` lists the underlying
single-ended resistances, not `2R` and `R/2`. Complex-reference Touchstone is refused
because its reference field cannot encode these complex power-wave references. This
export does not add mixed-mode import support; Fairbeam's importer still refuses that
format. The [ratified Touchstone 2.0 specification](https://www.ibis.org/touchstone_ver2.0/)
defines the modal ordering and reference convention.

Far-field, efficiency, power, solver, run-list and optimizer evidence remain at the
original reference. Port analysis does not recompute radiated/accepted power or the
original solver's passivity/reciprocity QA. Those matrix QA values are unavailable on
the projection, rather than copied as new measurements. In a summary, a far-field sample
chosen near a newly located match still contains the original radiation measurement.

The **original** complete matrix must have known phase and explicit, constant, positive
real references (including a single-port legacy result with a valid reference). Invalid
port mapping, incomplete multiport data, native complex or waveguide/per-frequency
references and invalid frequency grids are refused. Complex target chip references and
mixed mode are supported; this is not launch-discontinuity removal, a TRL calibration,
or a dispersive feed model. The standalone Examples viewer continues to
show original data; this control is scoped to Designer result tabs.

## Small-antenna estimates

The Designer's **Impedance** and **Summary** views share **Small-antenna estimates**.
They analyze the selected saved result, not the current draft or an ideal matching
network. Choose a natural reactance zero crossing, a VSWR limit (default 2), and the
result parts that define the enclosing geometry. Multiple crossings require an explicit
choice. Selection survives switching between these views; changing result, document or
port processing resets it. Comparisons evaluate each run independently, using the focused
run's selection and explicit defaults for other runs. Open a run to customize its selection.

Only original single-port complex data with an ordered, finite frequency grid and a
constant positive real reference is admitted. Port projections, magnitude-only data and
multiport results explain why the estimate is unavailable. An S11 minimum is not
automatically a reactance zero crossing; **Q resonance** is separate from Summary's
existing best-match frequency.

At a resolved natural crossing, the input-impedance estimate is
`Q_Z = f0 * sqrt((dR/df)^2 + (dX/df)^2) / (2 R0)`, with frequency in Hz.
The derivative includes resistance as well as reactance. It uses local nonuniform-grid
polynomial estimates from three and five contiguous samples. The estimates must agree
within 5%, and the crossing estimates within one quarter of the bracketing interval.
Gaps, nonpositive resistance, endpoints, flat zeros and unresolved derivatives leave an
unavailable result. This is an impedance diagnostic, not a stored-field energy integral.

For VSWR `s > 1`, predicted fractional bandwidth is `(s - 1) / (sqrt(s) * Q_Z)`.
It assumes an ideal real match to **R0 at this resonance**, which need not equal the
stored reference impedance. The companion sample-derived width uses that same hypothetical
match. Both threshold edges must be bracketed without gaps or another resonance. The
predicted span must be no more than 10%; local Q variation and predicted-versus-sampled
width disagreement must each be no more than 10%. These are software screening choices,
not accuracy guarantees. A local Q can remain available when bandwidth is unresolved; a bracketed sample-derived width can also remain available when the predicted width fails its consistency screen.
Neither width replaces the stored-reference VSWR or existing −10 dB band table.

The radius is half the diagonal of the selected parts' union bounding box, converted
to meters. This conservative enclosing sphere is not a minimum sphere. All non-void
parts are included initially, including finite ground, substrate and feed structures;
excluded parts are recorded. The **PEC image enclosure** reflects the selected bounds
through the recorded z-min PEC plane before taking their union. It does not simply
double a radius. Electrical size uses free-space `ka = 2π f0 a / 299792458`.

For `0 < ka < 1`, the named **single-mode Chu/McLean reference** is
`1/(ka)^3 + 1/ka`. Its Q_Z/reference ratio is a qualified diagnostic for a complete
finite free-space enclosure. It is withheld for excluded parts, uncertain boundary
provenance and PEC image enclosures. Loss and modal assumptions matter: this is not a
universal bound verdict or an optimality percentage. The combined electric/magnetic-mode
reference is a different expression. Radiation efficiency is shown separately only with
matching physical-port/frequency and reliable power/convergence evidence; no nearest
frequency or total-efficiency substitution is used. Model-normalized efficiency and
the raw power ratio have separate labels. The saved four-decimal efficiency fields are checked against the unrounded powers with their serialization rounding accounted for. Convergence requires an explicit recorded energy value or upper bound; any stored trace must be valid. Exports distinguish a sample and its actual timestep from a stop-derived bound, including valid fast runs with no trace samples. No efficiency correction is applied to the ratio.

Copy data and CSV preserve full precision, units, selection, source/port identity,
assumptions and unavailable reasons. New **Small antenna** columns in Summary leave
existing metrics unchanged. In Impedance exports these scalar columns repeat alongside
each original frequency/impedance row; they are one selected-resonance analysis, not
independent estimates at every row. Changing the selection during an asynchronous
comparison load cancels that export rather than mixing states. None of these operations
changes the saved result or Design, runs a solver, or establishes mesh convergence.

The equations follow [Yaghjian and Best (2005)](https://doi.org/10.1109/TAP.2005.844443),
the [versioned bandwidth derivation](https://arxiv.org/html/2501.03146v5), and
[McLean (1996)](https://doi.org/10.1109/8.496253). Independent analytic circuit and geometry
controls verify the software calculation; numerical antenna qualification remains separate.

## MIMO diversity from stored results

Open **MIMO diversity** for a complete run with 2–64 physical ports. Every S-matrix column, explicit positive real power-wave reference, and physical port identity must be present. Partial runs, magnitude-only imports and transformed port-coordinate views are unavailable. Choose a physical port pair; enter the real and imaginary incident power-wave weight for each port to inspect a specified simultaneous excitation. All weights initially equal 1+j0. This view and its CSV do not modify the run or start simulations.

For a passive complete matrix, let R = I − SᴴS. The S-parameter envelope-correlation estimate is ECC_S(i,j) = |Rᵢⱼ|²/(RᵢᵢRⱼⱼ). A full Hermitian positive-semidefinite check is used; checking each column's power alone is insufficient. A singular or numerically unresolved determinant makes CCL unavailable; a zero normalization makes ECC unavailable. The 1e−10 algebra tolerance is for floating-point roundoff, not a physical accuracy target.

ECC_field is the squared magnitude of the full-sphere complex-vector inner product of the two matched embedded patterns, divided by their separate power integrals. Both Eθ and Eφ contribute, using angular-cell solid-angle weights. Only exact stored frequencies appear as points. Missing samples, incompatible basis, corrupt payloads and mirrored/half-space patterns are not interpolated or guessed. The phase center and power-wave basis must be common to both fields. Angular discretization and quantization remain limitations; the calculation does not establish pattern convergence.

S-based radiation/receive estimates assume a reciprocal antenna with negligible dissipative loss, matched unused ports, and isotropic unpolarized multipath. Known radiation efficiency below 0.9 raises a loss warning; unknown exact-sample efficiency is also identified. An absolute S/field ECC difference above 0.05 raises a comparison warning. These are interpretation hints, not design acceptance or mesh-convergence thresholds.

The separately labeled DG proxy uses the explicit convention 10√(1−ECC²) dB for either correlation method; it is not measured outage diversity gain. TARC = ‖S a‖/‖a‖ is a linear reflected-wave ratio for the recorded physical-port excitation. It excludes dissipative loss and is not a worst-case or random-phase result. CCL = −log₂ det(R), in bits/s/Hz, is a high-SNR antenna-only approximation, not measured channel capacity. MEG_S = Rᵢᵢ/2 is a linear isotropic equally polarized lossless reciprocal estimate.

Exported CSV records physical ports, exact frequencies, actual complex excitation, metric units, unavailable reasons, warnings, and assumptions. Numerical estimates alone do not establish EM accuracy, field convergence or communication-channel performance.

Primary definitions: [Blanch, Romeu and Corbella, *Exact representation of antenna system diversity performance from input parameter description* (2003)](https://upcommons.upc.edu/handle/2117/10272), [complex field/S-parameter ECC and explicitly chosen DG convention](https://www.nature.com/articles/s41598-023-41302-2), and [Lynch, *A Modal Description of Multiport Antennas* (2011)](https://onlinelibrary.wiley.com/doi/10.1155/2011/438437). These references motivate the stated idealized definitions; the implementation's synthetic tests are not independent antenna measurements.

Bundle ZIP/README/PDF reports summarize the selected run without session excitation weights, so TARC stays unavailable there. The MIMO view’s CSV preserves the explicitly entered excitation. Missing or malformed weights are exported as an empty snapshot with an unavailable reason, never fabricated numeric values.

## Requirements belong to the saved run
The Summary, result-tree subtitle and exported report/package evaluate the list captured with the original run's saved input. Editing the current Design does not relabel historical results. Results without a snapshot remain unknown. Each new Designer result records a SHA256 identity derived from the exact saved input bytes and resolved parameters; the separate snapshot/source links must agree. This is recorded provenance, not a digital signature.

Numeric limits, energy convergence, mesh qualification and the overall qualified verdict are separate. Missing/invalid samples, unresolved source identity, a missing matching field and an unverified mesh study stay unknown. Mesh convergence is never inferred from energy decay, a filename, or a stored pass flag. Existing saved mesh-study records lack the immutable input membership needed here, so they are not automatically treated as mesh qualification. A failed numeric limit remains visible even when the qualified verdict is unknown.

S-parameter bands include both edges and all stored interior samples. S11 interpolates dB; Sij/all-port match interpolate magnitude then convert to dB, following optimizer conventions. No extrapolation or gaps are filled. Bandwidth is based on contiguous stored samples below -10 dB; an open edge gives a lower bound. These checks do not prove continuous-band behavior or physical accuracy between samples.

The original single-run dB chart draws a dashed segment only within a requested band and a point for a single-frequency limit. Masks are matched to physical ports, not matrix ordinals. They do not participate in data extrema or marker searches. Comparison views and session port projections do not inherit these original driven-wave masks. Report and package exports retain exact target values, source IDs, reasons and separate qualifications; data/requirements.csv uses the package's LF CSV convention.

## Additional far-field frequencies

A completed local run can retain its raw E/H recording and calculate additional far-field frequencies as a separate result. Enable retention in the Run dialog before the original run. The Pattern panel checks the source job and workspace; an imported file alone cannot grant access to raw data. See [retained far-field postprocessing](NF2FF-POSTPROCESS.md) for storage, frequency, runtime and provenance constraints.
