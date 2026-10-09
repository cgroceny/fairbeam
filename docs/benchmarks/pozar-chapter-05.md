# Chapter 5: qualified ideal TEM comparison scopes

This record identifies examples by number and page and reports our own models, equations and measured results. No textbook text, figures, tables, solution steps or PDF excerpts are included. Acquisitions used Fairbeam 0.7.2 and bundled openEMS 0.37.0rc3 on Windows on October 8, 2026 (UTC). Source snapshots, frozen native inputs and raw records remain outside Git.

Acceptance requires the declared independent target, both consecutive mesh-change limits, an independent boundary control, complete excitation and a confirmed exact energy stop. Uniform-line controls, reciprocity, power balance and independent probe contours must also pass. Tapers additionally require two successive profile refinements. These are sampled numerical-agreement scopes, not proof of asymptotic error order, arbitrary geometry, PCB performance or complete textbook designs.

## Accepted scopes

| Example / page | Our physical model and qualified quantity | Final result | Reproduction source |
|---|---|---|---|
| 5.3 / 238 | Air PEC/PMC TEM series open stub, ideal PMC open end, 50 Ω reference; two-port S and input Z with an explicitly ideal external 100 Ω / 6.366197724 nH termination | At 2 GHz, 50.514608+0.496278j Ω vs 50 Ω; max full-band complex Z error 3.192119% | [PR #62](https://github.com/ismailakdag/fairbeam/pull/62) |
| 5.5 / 249 | Air PEC/PMC TEM quarter-wave transformer, 50 Ω to 10 Ω, 3 GHz center; S, terminated Z and SWR≤1.5 bandwidth | At 3 GHz, 49.997618-0.412254j Ω vs 50 Ω; fractional bandwidth 29.223007% | [PR #64](https://github.com/ismailakdag/fairbeam/pull/64) |
| 5.6 / 255 | N=1–5 binomial profiles, 100 Ω to 50 Ω, 10 GHz center; fixed-width positive-scalar-dielectric PEC/PMC TEM realization, exact piecewise-line reference | All five orders meet target, mesh and boundary gates; N3 fractional bandwidth 69.807010% | [PR #65](https://github.com/ismailakdag/fairbeam/pull/65) |
| 5.7 / 259 | N=1–4 Chebyshev profiles, 50 Ω to 100 Ω, 10 GHz center, nominal Γm=0.05; same ideal scalar TEM realization | Numerical agreement passes for all four orders; N3 outer fractional bandwidth 100.037420%; strict Γ≤0.05 compliance is excluded | [PR #67](https://github.com/ismailakdag/fairbeam/pull/67) |
| 5.8 / 265 | Exponential, triangular and Klopfenstein 100 Ω to 50 Ω transitions in normalized travel time; own τ=0.1 ns and scalar TEM geometry | All three profiles meet exact-slice and continuous-line targets, two mesh pairs, two profile pairs and independent boundary gates; strict Klopfenstein Γ≤0.02 is excluded | [PR #68](https://github.com/ismailakdag/fairbeam/pull/68) |

Series-stub dimensions are h=0.2 mm, W=1.506921254 mm, feed length 69.457897938 mm and open-stub length 15.344677580 mm. Its sampled band is 1–3 GHz (101 points). The physical fixture does not contain a packaged R/L component. Limits are complex S/Γ error 0.03, relative complex Z error 5%, successive S/Γ mesh changes 0.01 and boundary changes 0.005. Measured S changes are 0.002049702 and 0.000726517; boundary change is 0.000210307. Both through and stub controls pass. Sixteen source-complete -90 dB columns used n=4/6/8 and a separate n6 enclosure.

The quarter-wave transformer uses fixed W=3.767303135 mm and plate heights 0.5/0.223606798/0.1 mm to set its three impedances. Physical height-step fringing remains. Both uniform controls and the transformer pass the frozen gates over 1.5–4.5 GHz. Its successive complex S changes are 0.002314179 and 0.001660887, and boundary change is 0.000185562. Twenty-four columns completed their source and -90 dB stops. The exact-line SWR≤1.5 bandwidth is 29.315922%; finite-grid measurements remain distinct.

## Multisection lines: exact spectra and design limits

Our multisection fixtures use fixed H=0.75 mm, W=2.825477351 mm and positive scalar epsilon_r=(100/Z)² to set each impedance. Each quarter-wave section has its own declared physical length. Binomial results use N=1–5; Chebyshev results use N=1–4. Both cover f/f0=1/3..5/3, with analytic band edges and ripple extrema included explicitly. Each order has its own uniform endpoint controls and both independent excitation columns at n=8/12/16 plus an expanded n12 enclosure. Respectively 120 and 96 native columns completed their sources and exact -90 dB stops.

| Design | Measured fractional bandwidth / % | Fine max complex S error | Fine max relative complex Z error / % | Sampled Chebyshev peak and strict Γ≤0.05 status |
|---|---:|---:|---:|---|
| Binomial N1 | 18.090550 | 0.000070141 | 0.004519 | — |
| Binomial N2 | 49.119549 | 0.000108084 | 0.005050 | — |
| Binomial N3 | 69.807010 | 0.000173881 | 0.006729 | — |
| Binomial N4 | 84.083344 | 0.000226661 | 0.007221 | — |
| Binomial N5 | 94.585045 | 0.000279004 | 0.008114 | — |
| Chebyshev N1 | 18.089913 | 0.000070141 | 0.006828 | 0.050001492; strict flag False |
| Chebyshev N2 | 66.382524 | 0.000105468 | 0.005734 | 0.050003966; strict flag False |
| Chebyshev N3 | 100.037420 | 0.000169073 | 0.005438 | 0.050003439; strict flag False |
| Chebyshev N4 | 121.400210 | 0.000230338 | 0.005241 | 0.050018971; strict flag False |

The reference is the exact cascade of the declared lines, independently checked with the network API; approximate small-reflection synthesis is recorded separately. For N3 binomial, exact and approximate bandwidths are 69.808882% and 70.295359%; for N3 Chebyshev, 100.037948% and 100.606025%. Matching exact-line spectra does not certify the strict ripple specification. All four fine Chebyshev strict-limit flags are false, including the small measured overshoots shown above. Outer Chebyshev band edges do not certify its entire interior passband.

## Tapers: spatial mesh and profile slicing are separate

Our profile coordinate u is normalized travel time, not physical distance. A midpoint impedance Zi is represented by a scalar dielectric slice of length c·τ·Zi/(100·M), so each slice has delay τ/M. The plate geometry is H=0.75 mm, W=2.825477351 mm. Electrical length θ=2πfτ spans 0.5..4π on 412 declared frequencies. This mapping is explicit and is not a constant-dielectric PCB realization.

Exact cascades are compared with an independently integrated continuous nonuniform line and with small-reflection approximations. RK4 step doubling from 2048 to 4096 changes complex S by less than 1.4e-10; a closed exponential-line solution and independent nodal network calculations check the references. For Klopfenstein, Γ0=ln(1/2)/2 and A=acosh(abs(Γ0)/0.02)=3.544676496; the 98.019867331 Ω and 51.010067001 Ω endpoint steps are retained. No length, impedance or frequency is fitted to the measured output.

| Profile | Fine max S error vs physical slices | Fine max S error vs continuous line | Fine max Z error vs continuous line / % | Sampled peak for θ≥A |
|---|---:|---:|---:|---:|
| Exponential | 0.000301456 | 0.000316275 | 0.016115 | 0.075039638 |
| Triangular | 0.000354159 | 0.000374657 | 0.005883 | 0.108400711 |
| Klopfenstein | 0.000351164 | 0.000366104 | 0.013063 | 0.021722829 |

| Profile | ΔS n8→n12 | ΔS n12→n16 | Boundary ΔS | Profile ΔS 64→128 | Profile ΔS 128→256 |
|---|---:|---:|---:|---:|---:|
| Exponential | 0.000507041 | 0.000240789 | 0.000020499 | 0.000221801 | 0.000137173 |
| Triangular | 0.000388431 | 0.000255632 | 0.000025250 | 0.000111622 | 0.000101946 |
| Klopfenstein | 0.000487994 | 0.000187615 | 0.000022202 | 0.000121340 | 0.000123489 |

All spatial-mesh controls use 128 slices; separate profile controls use n12 at 64/128/256 slices. Uniform 100 Ω and 50 Ω lines calibrate each combination independently. Frozen continuous-line S/Γ/Z error limits are 0.002/0.001/0.005, successive spatial-mesh limits 0.003/0.002/0.005, boundary limits 0.001/0.001/0.002, and successive profile limits 0.001/0.0005/0.002. Relative Z uses max(abs(reference Z),100 Ω). All 108 columns completed their sources and exact -110 dB stops before the fixed 4 ns cap, serially on one thread. Each owned worker has a suspend-inclusive 1800 s deadline.

The continuous Klopfenstein line already peaks at about 0.021726667 for θ≥A, above the small-reflection design target of 0.02. Its measured strict sampled-limit flag is false. That model/approximation difference is excluded from validation; numerical agreement with the exact declared line is the accepted scope.

Earlier cohorts are retained separately. A 32-slice exponential profile missed the continuous-line target. Tightening energy alone did not fix a low-frequency calibration spread. The final fixture extracts modal gamma from the transfer eigenvalue ratio while retaining raw determinant/symmetry acceptance gates; the synthetic excessive-gain control still fails. All 108 intermediate/final native inputs and 37 overlapping raw V/I spectra are bit-identical, isolating that analysis correction. Old records are not relabeled.

## Excluded applications and deferred refinements

- 5.1 / 231: the sampled lumped-matching fixture has incomplete energy stops and independent-boundary changes beyond its declared limits. No quantity is upgraded here. See [PR #60](https://github.com/ismailakdag/fairbeam/pull/60).
- 5.2 / 235: the coarse shunt-stub cohort completes its source but misses the energy stop; its load/junction controls do not isolate a product defect. Finer estimates exceed the 30-minute case budget. See [PR #61](https://github.com/ismailakdag/fairbeam/pull/61).
- 5.4 / 243: the double-stub cohort misses its energy stop and exact ideal-junction target. An unretuned open-tip correction worsened the discrepancy; independent tee/end effects support a model difference but do not establish convergence or a unique cause. Long refinements are deferred. See [PR #63](https://github.com/ismailakdag/fairbeam/pull/63).
- 5.7 and 5.8: strict design-ripple compliance, practical launches, PCB geometry, conductor/dielectric loss and arbitrary Designer measurements are outside the accepted scopes.

## Reproduction and provenance

Check out each linked fixture PR until it is merged; these independent documentation changes do not depend on its code being present on main. Use a Fairbeam Python environment with bundled native bindings, and a fresh output directory outside Git. From python/, the matching study/analysis pairs are:

```powershell
python -m tests.test_series_stub --study --out C:/Temp/pozar-c5/series
python -m tests.test_series_stub --compare --out C:/Temp/pozar-c5/series
python -m tests.test_quarterwave --study --out C:/Temp/pozar-c5/quarterwave
python -m tests.test_quarterwave --compare --out C:/Temp/pozar-c5/quarterwave
python -m tests.test_binomial --study --out C:/Temp/pozar-c5/binomial
python -m tests.test_binomial --compare --out C:/Temp/pozar-c5/binomial
python -m tests.test_chebyshev --study --out C:/Temp/pozar-c5/chebyshev
python -m tests.test_chebyshev --compare --out C:/Temp/pozar-c5/chebyshev
python -m tests.test_taper --study --out C:/Temp/pozar-c5/taper
python -m tests.test_taper --compare --out C:/Temp/pozar-c5/taper
```

Use --preflight before acquisition and the linked PR's pure unittest command. Ordinary discovery does not start native acquisition in these added modules. Default studies require the full declared families; --coarse-only produces partial data that cannot qualify convergence. Readers reject missing inputs, stale source identities, incomplete sources, unconfirmed energy stops, over-budget records and failed numerical gates. Original source snapshots, inputs, actual engine/version/thread/grid/step records and raw spectra are retained privately. No gallery model, generated bundle or book file changes.
