# Chapter 6: qualified resonator comparison scopes

This record identifies examples by number and page and reports our own models, equations and measured results. No textbook text, figures, tables, solution steps or PDF excerpts are included. Acquisitions used Fairbeam with unchanged bundled openEMS 0.37.0rc3 on Windows, serially with one fixed native thread. Frozen inputs, source snapshots and raw records remain outside Git.

Qualification is limited to the quantities and physical assumptions below. Each accepted cohort passes its independent target, both successive mesh-change limits, independent controls, excitation completion, confirmed native stopping criterion, probe quality and source/runtime/input/data identities. These are finite sampled agreement scopes; no asymptotic order, complete practical design or unmeasured loss partition is asserted.

## Accepted scopes

| Example / page | Declared model and accepted quantity | Final result | Reproduction source |
|---|---|---|---|
| 6.1 / 280 | Ideal axisymmetric half-wave PTFE-filled TEM, opaque PEC backing, PMC open ends; dielectric-loss frequency and unloaded Q | 4.999940440 GHz / Q=2506.838519 | [PR #76](https://github.com/ismailakdag/fairbeam/pull/76), [PR #77](https://github.com/ismailakdag/fairbeam/pull/77) |
| 6.3 / 287 | Closed homogeneous PEC rectangular cavity, TE101 and TE102; dielectric-loss frequency and unloaded Q | 4.997516601 / 4.997517431 GHz; Q=2502.413526 / 2505.063655 | [PR #82](https://github.com/ismailakdag/fairbeam/pull/82) |
| 6.4 / 292 | Closed axisymmetric PEC cylindrical TE011 cavity; dielectric-loss frequency and unloaded Q | 4.997385661 GHz / Q=2481.651487 | [PR #83](https://github.com/ismailakdag/fairbeam/pull/83) |
| 6.6 / 302 | Our homogeneous PEC/PMC conductive-TEM circuit dual, mapped shunt L; complex reflection, loaded resonance and Q | Critical coupling: 4.920224440 GHz / Qloaded=310.525508 | [PR #87](https://github.com/ismailakdag/fairbeam/pull/87) |

## Dielectric-loss resonators

For 6.1 our inner and outer radii are 1 mm and 4 mm, epsilon_r=2.08, nominal loss tangent 0.0004 and f0=5 GHz. Length is c/(2*f0*sqrt(epsilon_r)); the independent frequency reference is c/(2*l*sqrt(epsilon_r)). The nominal dielectric Q target is 2500. Constant electric conductivity is used rather than a frequency-independent loss tangent.

For 6.3 our a=47.55 mm, b=22.15 mm, epsilon_r=2.25 and nominal loss tangent 0.0004. Mode lengths are d=m*pi/sqrt(k0^2-(pi/a)^2), m=1,2, with k0=2*pi*f0*sqrt(epsilon_r)/c and f0=5 GHz. The reference is f=c/(2*sqrt(epsilon_r))*sqrt((1/a)^2+(m/d)^2).

For 6.4 our epsilon_r=2.08, nominal loss tangent 0.0004, radius 27.400801720 mm and length 54.801603439 mm. With xprime01=3.8317059702 (the first nonzero J1 root), f=c/(2*pi*sqrt(epsilon_r))*sqrt((xprime01/R)^2+(pi/l)^2). The mesh includes r=0 and a closed full azimuth; multigrid is not used.

The 6.3/6.4 Q reference accounts for the constant conductivity at measured frequency: Qd=2*pi*f*epsilon/kappa=f/(5 GHz*0.0004). All three fixtures extract a free signed field pole from two probes and three post-source windows. An independently fitted native FAST ENERGY envelope checks damping; it supplies no analytic Q to the field fit. Growing or zero-damping controls do not produce a physical finite loss Q.

| Example / mode | Mesh | f (GHz) | Q |
|---|---|---:|---:|
| 6.1 TEM | radial 8, azimuth 4 | 4.999708286 | 2503.488881 |
| 6.1 TEM | radial 12, azimuth 4 | 4.999886803 | 2503.618972 |
| 6.1 TEM | radial 16, azimuth 4 | 4.999940440 | 2506.838519 |
| 6.3 TE101 | 18 | 4.994812893 | 2497.638081 |
| 6.3 TE101 | 22 | 4.996529975 | 2496.623516 |
| 6.3 TE101 | 26 | 4.997516601 | 2502.413526 |
| 6.3 TE102 | 18 | 4.994823275 | 2493.176906 |
| 6.3 TE102 | 22 | 4.996535408 | 2497.082921 |
| 6.3 TE102 | 26 | 4.997517431 | 2505.063655 |
| 6.4 TE011 | radial 24, azimuth 8 | 4.995352741 | 2514.092625 |
| 6.4 TE011 | radial 28, azimuth 8 | 4.996585414 | 2486.892960 |
| 6.4 TE011 | radial 32, azimuth 8 | 4.997385661 | 2481.651487 |

| Scope | Successive frequency changes / % | Successive Q changes / % | Independent control changes |
|---|---|---|---|
| 6.1 TEM | 0.003570 / 0.001073 | 0.005196 / 0.128596 | Doubled azimuth and increased PEC backing: field pole unchanged within stored precision |
| 6.3 TE101 | 0.034342 / 0.019733 | 0.040621 / 0.231914 | Doubled backing: 0 / 0% |
| 6.3 TE102 | 0.034243 / 0.019640 | 0.156668 / 0.319602 | Doubled backing: 0 / 0% |
| 6.4 TE011 | 0.024653 / 0.016005 | 1.081888 / 0.210764 | Doubled backing and azimuth: 0 / 0% |

Frozen target frequency/Q limits are 0.2%/3%, both successive mesh limits 0.05%/2%, and independent-control limits 0.02%/1%. The 6.1 Q mesh change grows at the final refinement; qualification uses both declared finite limits, not a claimed convergence order. Native requested stops are -80 dB for 6.1 and -70 dB for 6.3/6.4. The native FAST ENERGY proxy is EPS0*sum(V^2)+MU0*sum(I^2), not a physical stored-energy volume integral. All source, sampling, pole-window, proxy residual/uncertainty/span/agreement and native-header checks must pass.

## Coupled circuit: spatial and temporal controls

The fixed line is l=21.75 mm, effective epsilon_r=1.9, Z0=50 ohm and attenuation 0.01 dB/cm. Our homogeneous TEM geometry has h=0.5 mm and W=2.733088951 mm. The constant-Z0 circuit reference is Z=Z0*coth(gamma*l)+1/(j*omega*C). A shorted line with shunt L=C*Z0^2 is its circuit dual: Zoriginal=Z0^2/Zdual, Gamma_original=-Gamma_dual. Approximate and critical physical capacitances are 31.857959731 and 32.454416820 fF, respectively.

Native spectra are compared to the separately declared conductive TEM reference: gamma=sqrt(j*omega*Lprime*(Gprime+j*omega*Cprime)) and Zc=sqrt(j*omega*Lprime/(Gprime+j*omega*Cprime)), with Lprime=mu*h/W, Cprime=epsilon*W/h and Gprime=kappa*W/h. The impedance inversion is exact for constant Z0; an electric-loss original series-C line is not identical to this conductive shunt-L dual. No substrate, physical microstrip gap, packaged component or Designer port is qualified.

The opt-in geometry-only node-density map supplies Lnative=Lphysical*N/(N+1), where N is the transverse physical-cell count. Physical C/L, geometry, targets and gates remain fixed; both L values are stored. It is not a general production lumped-element correction. At mesh 3, unmapped/mapped critical max complex-Gamma errors are 0.719008093/0.013738269; one passing mapped pilot alone does not qualify convergence.

| Coupled case | Mesh | f (GHz) | Qloaded | Max complex Gamma target error |
|---|---:|---:|---:|---:|
| approx | 4 | 4.921619261 | 316.235559 | 0.008256064 |
| approx | 5 | 4.921640198 | 316.212258 | 0.005751780 |
| approx | 6 | 4.921651693 | 316.199405 | 0.004373325 |
| critical | 4 | 4.920191959 | 310.507070 | 0.008194654 |
| critical | 5 | 4.920212934 | 310.520446 | 0.005659324 |
| critical | 6 | 4.920224440 | 310.525508 | 0.004290668 |

| Case | Mesh Gamma changes | Feed / backing Gamma changes | Stricter-time Gamma / Q change |
|---|---|---|---|
| bare | 0.000032628 / 0.000094148 | 0.000028574 / 0.000000000 | 0.000000000 / not a loaded-Q case |
| approx | 0.002592070 / 0.001422644 | 0.000746168 / 0.000000000 | 0.001141237 / 0.042994% |
| critical | 0.002586696 / 0.001425332 | 0.000733428 / 0.000000000 | 0.001120512 / 0.028253% |

Both current contours and both independently de-embedded feed planes pass <=0.003 complex-Gamma disagreement. Frozen target Gamma/f/Q limits are 0.03/0.2%/5%; both mesh limits are 0.005/0.05%/3%, and feed/backing/time limits are 0.003/0.05%/2%. All three families pass with meshes 4/5/6, doubled feed, doubled metal backing and an independent mesh-5 -100 dB stop against the -90 dB main cohort. The clock is fixed at 0.1 ps; main/time caps are 150/200 ns. Loaded Q comes from interpolated half-maximum accepted-power bandwidth, not a native energy proxy or unloaded-Q partition.

Earlier -70 dB data fail a mesh-Gamma gate (0.005117706 > 0.005). Common time prefixes are diagnostics only. Every accepted record was reacquired with stricter stopping; the frozen gates were not relaxed. Original zero-source, enclosure and time-tail failures remain rejected.

## Exclusions and deferred work

- 6.2 / 283: open microstrip and boxed controls remain unqualified. The three approved long boxed refinements are now complete: all four boxed meshes/controls reach their -70 dB stop, and both successive mesh comparisons and the independent air-clearance control pass their frozen limits. The fine result is 4.949102662 GHz / Q=2837.276121; its 1.017947% frequency error exceeds the unchanged 1% target. Passing acquisition and mesh controls does not qualify target agreement. See [PR #81](https://github.com/ismailakdag/fairbeam/pull/81) for the complete before/after table, fixed extraction windows and separate late-window diagnostic.
- 6.5 / 297: the open dielectric resonator has small core-mesh/azimuth changes but clearance/PML Q changes of 4.878555%/6.610318%, beyond its 2% limit. The far-air grid is not independently refined, and a unique PML/dispersion cause is not established. See [PR #86](https://github.com/ismailakdag/fairbeam/pull/86).
- Bulk-copper loss, conducting-sheet accuracy and external/radiation/unloaded-Q partitions beyond the listed dielectric scopes remain unqualified. Some full-decay forecasts exceed 30 minutes; no cap or approximate sheet result substitutes for qualification.
- 6.7 / 308 and 6.8 / 311 are symbolic perturbation/calculation examples without a specified numerical geometry; no new FDTD is required.
- Physical microstrip coupling, substrate/gap fringing, practical feeds and arbitrary Designer measurements are outside 6.6's declared circuit scope.

## Reproduction and provenance

Check out each linked fixture PR until merged. This documentation PR does not depend on unmerged code being present on main. From python/ use a Fairbeam environment with the bundled native bindings, fresh output directories outside Git and the linked PR's complete serial acquisition commands. The following analysis commands reread those completed cohorts without launching FDTD:

```powershell
python -m tests.test_coax_resonator --analyse --cases ptfe_dielectric --out C:\Temp\coax-dielectric
python -m tests.test_rectangular_cavity --study --mode 1 --out C:\Temp\rect-m1-d
python -m tests.test_rectangular_cavity --study --mode 2 --out C:\Temp\rect-m2-d
python -m tests.test_cylindrical_cavity --study --case dielectric --out C:\Temp\cyl-d
foreach ($kind in @('bare', 'approx', 'critical')) {
  python -m tests.test_coupled_resonator --study --time-control --cell-map --meshes 4 5 6 --case $kind --out C:\Temp\coupled-final
}
```

Each linked fixture also provides --preflight, explicitly opt-in --fdtd, pure unittest and individual-record analysis commands. Ordinary added unittest discovery launches no native acquisition. Measure conservative throughput on a new host; every case is forecast before launch and bounded to 1800 seconds including suspend. Missing controls, incomplete sources/stops, stale identities, incorrect clocks/geometry and failed numerical gates cannot qualify. No generated bundle, gallery model or book file changes.
