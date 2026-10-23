# How results are computed

- **Excitation.** By default this is a DC-free Gaussian-derivative pulse, -20 dB at `f_max`. openEMS' modulated Gaussian carries a DC component when `f_min/f_max` is small (for example 0.5-8 GHz). The static field it leaves behind keeps the energy above the end criterion, so the run continues to the timestep limit. S-parameters are unaffected, but the run takes about 10x longer. On the Sierpinski model the derivative pulse took the run from about 150 s (not converged) to about 13 s (converged at -47 to -61 dB). `Simulation(..., excitation="gauss")` restores openEMS' pulse.
- **End criterion.** A run stops when the field energy has decayed to the end criterion, **−60 dB by default**, evaluated every Nyquist period (`exact_endcriteria`, so the stopping point does not depend on machine speed; `--no-exact` restores openEMS' ~4 s wall-clock check). Resonance frequency and Dmax are already settled at −40 dB, but S11 depth and radiation efficiency of high-Q structures are not: on the patch, −40 dB gives |S11| −24 dB and η 0.86, −60 dB gives −37 dB and 0.95, −70 dB gives −39 dB and 0.96 (un-radiated ring-down energy corrupts P_acc). Override per run with `--end-db`.
- **S11 and Zin** come from the excited lumped port: S11 = u_ref / u_inc and Zin = u_tot / i_tot, evaluated at `--points` frequencies between `f_min` and `f_max`.
- **Bands** are contiguous frequency ranges with |S11| < -10 dB. Each band reports its edges, the frequency of minimum S11 (`f_center` in the bundle), fractional bandwidth, and whether it touches the edge of the simulated range. The app's band tables (Summary, the S-parameter side panel, the Examples panel) name two frequencies: the **Center** is the middle of the edges, (f_lo + f_hi) / 2, and the **Best match** is the frequency of minimum S11. The fractional bandwidth they show, and the Summary's Bandwidth (%), is the width divided by that center; the bundle's `fractional_bw` divides by `f_center`. CSV/TSV exports use the tables' definitions: `f_center_GHz` is the band middle, `f_best_GHz` is best match, and exported `fractional_bw` divides by the middle ([CSV columns and open-band flags](EXPORTS.md#matched-band-csv-columns)). A band that touches the edge of the simulated range continues past it: its open edge is marked ≤ or ≥, its width is a lower bound, and the example picker names it by its range ("≥ 8–12 GHz") instead of a single frequency.
- **Far field.** openEMS records the fields on a near-field box and applies the NF2FF transform at the band centers (or at `--pattern`). The grid is θ 0-180° in 3° steps and φ 0-360° in 5° steps, with the phase center at `nf2ff_center`. With PEC or PMC boundaries, openEMS mirrors the recording surface and integrates over the image as well. Fairbeam therefore divides Prad by 2^m and multiplies Dmax by 2^m, where m is the number of PEC/PMC boundaries. Directivity then refers to the physical half space, for example a monopole over an infinite ground plane.
- **Radiation efficiency** = Prad / P_acc. P_acc = ½·Re(u·i*) is the power accepted at the port. It is stored at the far-field frequencies and, with `--efficiency [N]` (a design's `monitors.efficiency`), at N frequencies across the band, with a reliability flag per frequency ([BUNDLE.md](BUNDLE.md#efficiency)). A model declared lossless (`sim.lossless = True`) reports 1 while Prad / P_acc is within 5 % of 1 ([BUNDLE.md](BUNDLE.md#results)).
- **Gain** = efficiency · Dmax. **Realized gain** = gain · (1 − |S11|²).

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

## Accuracy notes

- openEMS uses a staircase (Yee) FDTD mesh. Slanted and curved edges snap to mesh lines, and zero-thickness sheets sit on grid planes. Expect resonances to shift by a few percent unless the openEMS mesh is fine on the metal edges.
- Check mesh convergence before trusting a number. For a designer file: `fairbeam converge <design.json>` (or Simulation › Mesh convergence… in the designer) reruns it at 15, 20, 30, 40 cells per wavelength and stops when the resonance, |S11| and Dmax settle ([STUDIES.md](STUDIES.md#fairbeam-converge)). For a Python model: `fairbeam converge <model> --param mesh_div=15,20,30` (or `cell=0.8,0.6,0.45` on the Sierpinski model); confirm that band centers move by less than your tolerance. How metal edges and zero-thickness sheets are meshed matters more than the global cell size: see [VALIDATION.md](VALIDATION.md). The smallest cell sets the timestep for the whole domain, so avoid slivers (`fairbeam.mesh.merge_lines`).
- Conductor loss: metals are perfect conductors unless a design metal has a `conductivity` (S/m) or a model uses `sim.metal(..., conductivity=)`; then sheets are openEMS conducting sheets of the given thickness (default 0.035 mm) and the efficiency includes the copper loss ([MODELS.md](MODELS.md)).
- Literature check, Sierpinski monopole, iteration 3, 48 mm: simulated bands at 3.303 and 6.219 GHz. Puente et al. (1998) measured an 89 mm gasket; scaled to 48 mm, their bands fall at 3.226 and 6.508 GHz. The deviations are +2.4 % and −4.4 %, which is plausible given the staircase mesh, the contact bridges and the idealised infinite ground.
- Patch antenna: the converged resonance is 2.455 GHz (mesh_div 30-40). The transmission-line model (`fairbeam.analytic.patch_resonance`: Hammerstad ε_eff and ΔL) gives 2.513 GHz (-2.3 %). The simplified formula ignores the finite ground and the probe, so this agreement is within its expected accuracy.
- Half-wave dipole: resonance 1.3-1.4 % below the closed-form induced-EMF resonance, R_in 72-73 Ω, Dmax 2.13-2.15 dBi, efficiency 0.999. Full tables, the end-criterion study and recommended settings are in [VALIDATION.md](VALIDATION.md).

The [RunHistory sweep CSV](STUDIES.md#runhistory-sweep-csv) follows the same band definitions with lowercase column names: `band_lo_ghz` and `band_hi_ghz` are the edges, `band_center_ghz` is their middle, and `band_best_ghz` is the |S11| minimum frequency. It uses the first band of each job; missing edges leave the center blank. RunHistory labels the minimum frequency **Best match**.
