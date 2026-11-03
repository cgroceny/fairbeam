# Chapter 6: qualified resonator comparison scopes

This record identifies examples by number and page and reports our own models, equations and measured results. No textbook text, figures, tables, solution steps or PDF excerpts are included. The accepted cohorts below used Fairbeam with unchanged bundled openEMS 0.37.0rc3 on Windows, run serially with each fixture's declared fixed thread count: four for 6.3; one for 6.1, 6.4 and 6.6. The separate radial-PMC calibration uses the isolated study SDK specified in its section. Frozen inputs, source snapshots and raw records remain outside Git.

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

## Separate radial-PMC calibration for 6.5

[PR #364](https://github.com/ismailakdag/fairbeam/pull/364), associated with Example 6.5 / p. 297, prescribes a radial magnetic wall at R=4.13 mm. This is a separate boundary problem from the original radiating open resonator: radiation and side fringing are excluded by construction. The measurements below establish finite mesh/reference agreement for that calibration only; they do not add the open example to the accepted scopes above.

Our dielectric length is L=8.255 mm, epsilon_r=95 and constant sigma=0.016644528496575457 S/m. The physical PMC is the Yee H plane midway between the final two primary radial lines, rather than the last primary line. Four sectors close the full azimuth; axial vacuum clearance is 30 mm with 24 mm / 16-cell PMLs. The reference solves `beta*tan(beta*L/2)=alpha`, with `beta^2=(epsilon_r*omega^2-j*sigma*omega/epsilon0)/c^2-kr^2`, `alpha^2=kr^2-omega^2/c^2` and `kr=first_zero(J0)/R`. For `exp(+j*omega*t)`, positive Im(omega) decays and `Q=Re(omega)/(2*Im(omega))`. This gives **3.149337750796 GHz / Q=1000.599994699**, an analytical calculation without a fitted frequency correction.

The prospective fine family fixes dt=0.285 ps, the source/material/probes, a 1 us cap and a -80 dB natural stop while refining both core and air grids. Each field runs serially with one native thread. The n12 point reuses the completed smaller-time-step control through its original reader and exact physical-input identity; it is not a new acquisition or a relabeled source epoch.

| Fine family | Native cells | f (GHz) | Q | Absolute f error / % | Absolute Q error / % | Owned field wall / min |
|---|---:|---:|---:|---:|---:|---:|
| n12, reused time control | 8,970 | 3.145137235458 | 995.257848836 | 0.13337773 | 0.53389425 | 14.033 |
| n16 | 12,954 | 3.147102736761 | 995.855985335 | 0.07096775 | 0.47411647 | 22.713 |
| n20 | 17,514 | 3.147975834653 | 996.114925661 | 0.04324452 | 0.44823796 | 27.108 |

Successive frequency changes are 0.06249334% / 0.02774291%; Q changes are 0.06009865% / 0.02600178%. Both shrink and pass the unchanged 0.2% frequency / 2% Q mesh limits. Each row also passes the unchanged 0.2% / 2% absolute-reference limits. This is finite sampled agreement; no asymptotic convergence order is claimed.

Separate n12 independence controls retain the same physical wall, material, source and probes. Each passes the unchanged 0.1% frequency / 2% Q difference limits and its 0.2% / 2% absolute-reference limits:

| Independent change | Comparison | Relative f change / % | Relative Q change / % |
|---|---|---:|---:|
| dt: 0.380 -> 0.285 ps | Smaller step vs original n12 | 0.00010253 | 0.52094036 |
| Azimuth: 4 -> 8 sectors | Against the time control at the same 0.285 ps step | 0.00000023 | 0.00253036 |
| Axial clearance: 30 -> 40 mm | Against original n12 at 0.380 ps | 0.00000019 | 0.00007257 |

The tail control preserves dielectric and near-field air lines through abs(z)=33.221154756 mm and the PML width/cell count. Moving PML regrades the old terminal air interval; this is a tail-extent diagnostic, not full-domain mesh convergence. The original n8/12/16 family at 0.380 ps remains separate: its n8 absolute frequency error is 0.328051%, above 0.2%. That failed cohort and a refused zero-field angular CFL setup remain retained and excluded. The fine-family pass does not erase them. Research flags remain `qualified=false` and `open_example_qualified=false`.

Acquisition sources are `4b67bbcd2233ead0c3db4d41f786e3345630a96e` (original cohort), `cffb5c0b65cb206197442902918c155ed5ece280` (independence controls) and `e818565a52cc1273900b0ff048858e9b88f0208e` (new fine fields), recorded in #364. The later Windows temporary-path assertion correction changes only a unittest; the recorded capture identities stay at those commits. Independent replay verifies raw/NPZ equality, input/source/runtime hashes, actual loaded DLL observations, actual grid/probe clocks, natural stopping, signed field-pole fits at two probes and three late windows, and owned closing receipts. The native energy check is a cache-based proxy, not a physical stored-energy volume integral.

Runtime: Windows 11, Python 3.13.15, NumPy 2.5.3, openEMS 0.37.0rc3 and CSXCAD 0.7.0rc3. The isolated SDK is built from native source `67d378488ee40de815eed00f8aaa808f0a9e3c6d` with [#353](https://github.com/ismailakdag/fairbeam/pull/353)'s default-off cylindrical-metric patch composed; its metric option is omitted in every PMC capture. Actual loaded SHA256 values are `d1b5dfd9a2544dff6681b1b357136587868144abb1e494443df4cfa07c4e14ea` (openEMS.dll) and `9e2ed9ecae8f3de6e1a132cb403834096672abedc2b4de2c73a0f1392ce2abd1` (CSXCAD.dll). The installed application runtime was not changed. This protocol requires fixed-Nyquist `--exact-endcriteria` and time-domain sampling at Nyquist/4, confirmed by the native header and probe clock; a version label or passing unittest alone does not establish these capabilities.

For read-only replay, use an isolated checkout at the recorded fine source `e818565` with its matching SDK and completed external cohorts. Its earlier fixture/reader files are byte-identical to the control source; replay does not rewrite or relabel data. From python/:

```powershell
python -m tests.test_dielectric_pmc_controls --compare --baseline C:/study/pmc/n12 --out C:/study/pmc-controls
python -m tests.test_dielectric_pmc_fine --compare --baseline C:/study/pmc-controls/time --out C:/study/pmc-fine
```

Fresh acquisitions follow #364's explicit opt-in setup/pilot/full commands, with a new path for every epoch and host-specific conservative throughput forecasts. These PMC full fields enforce a 2700-second owned wall deadline including suspend, separately from the older 1800-second fixtures below. The completed fine fields took 22.713 / 27.108 minutes; no old deferred campaign was resumed to create this record. Parameters, reference values and gates were frozen before acquisition.

## Exclusions and deferred work

- 6.2 / 283: open microstrip and boxed controls remain unqualified. The three approved long boxed refinements are now complete: all four boxed meshes/controls reach their -70 dB stop, and both successive mesh comparisons and the independent air-clearance control pass their frozen limits. The fine result is 4.949102662 GHz / Q=2837.276121; its 1.017947% frequency error exceeds the unchanged 1% target. Passing acquisition and mesh controls does not qualify target agreement. See [PR #81](https://github.com/ismailakdag/fairbeam/pull/81) for the complete before/after table, fixed extraction windows and separate late-window diagnostic.
- 6.5 / 297: the original open dielectric-resonator cohort has small core-mesh/azimuth changes but clearance/PML Q changes of 4.878555%/6.610318%, beyond its 2% limit. Subsequent opt-in air-grid diagnostics do not establish full-domain convergence; independent boundary-Q controls still fail. Fixed-thickness PML subdivision also changes the native default grading profile, so it does not isolate fixed-profile mesh error. A unique PML/air-grid cause is not established, and an exact open-reference or radiation/dielectric-Q partition remains unqualified. See [PR #86](https://github.com/ismailakdag/fairbeam/pull/86), [PR #336](https://github.com/ismailakdag/fairbeam/pull/336) and [PR #348](https://github.com/ismailakdag/fairbeam/pull/348).
- Bulk-copper loss, conducting-sheet accuracy and external/radiation/unloaded-Q partitions beyond the listed dielectric scopes remain unqualified. Some full-decay forecasts exceed 30 minutes; no cap or approximate sheet result substitutes for qualification.
- 6.7 / 308 and 6.8 / 311 are symbolic perturbation/calculation examples without a specified numerical geometry; no new FDTD is required.
- Physical microstrip coupling, substrate/gap fringing, practical feeds and arbitrary Designer measurements are outside 6.6's declared circuit scope.

## Reproduction and provenance

Check out each linked fixture PR until merged. This documentation PR does not depend on unmerged code being present on main. For the accepted scopes, from python/ use a Fairbeam environment with the bundled native bindings, fresh output directories outside Git and the linked PR's complete serial acquisition commands. The separate PMC calibration instead requires the matching source/SDK specified above. The following analysis commands reread the accepted cohorts without launching FDTD:

```powershell
python -m tests.test_coax_resonator --analyse --cases ptfe_dielectric --out C:\Temp\coax-dielectric
python -m tests.test_rectangular_cavity --study --mode 1 --out C:\Temp\rect-m1-d
python -m tests.test_rectangular_cavity --study --mode 2 --out C:\Temp\rect-m2-d
python -m tests.test_cylindrical_cavity --study --case dielectric --out C:\Temp\cyl-d
foreach ($kind in @('bare', 'approx', 'critical')) {
  python -m tests.test_coupled_resonator --study --time-control --cell-map --meshes 4 5 6 --case $kind --out C:\Temp\coupled-final
}
```

Each linked fixture also provides --preflight, explicitly opt-in --fdtd, pure unittest and individual-record analysis commands. Ordinary added unittest discovery launches no native acquisition. Measure conservative throughput on a new host; ordinary fixture acquisition commands forecast each case and enforce an 1800-second deadline including suspend. The separately authorized extended 6.2 controls used the longer per-worker budgets documented in [#81](https://github.com/ismailakdag/fairbeam/pull/81); they remain outside the accepted scopes. Missing controls, incomplete sources/stops, stale identities, incorrect clocks/geometry and failed numerical gates cannot qualify. No generated bundle, gallery model or book file changes.
