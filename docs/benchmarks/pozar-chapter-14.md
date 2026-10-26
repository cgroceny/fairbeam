# Chapter 14: qualified finite-strip pattern scope

This record identifies Example 14.2, p. 664, and reports our own finite PEC-strip realization, parameters, equations and measurements. The physical realization is an extension of a prescribed-pattern calculation. No textbook text, figures, tables, solution steps or PDF excerpts are included. Fields were acquired with Fairbeam and bundled openEMS 0.37.0rc3 on Windows, serially with four FDTD threads and four NF2FF threads. Raw face fields and original process logs remain outside Git; reduced measured samples and source/receipt/native-input manifests are published below.

Only sampled normalized power pattern, independently integrated angular directivity and half-power beamwidth are qualified. Every point bound, both successive spatial-mesh changes, four independent controls and all seven two-surface comparisons pass the limits fixed before the fields. This finite sampled qualification establishes neither an asymptotic convergence order nor input impedance, complete antenna performance, calibrated absolute power or native-D convergence.

## Own physical model and independent reference

The center-fed zero-thickness PEC strip has length 15 mm, width 0.6 mm and a 0.4 mm feed gap. Its differentiated-Gaussian excitation spans 0.8 to 1.2 GHz. The port reference is 50 ohms. Each mesh preserves the physical sheet/feed planes and closed NF2FF surfaces at +/-30 and +/-45 mm. The ordinary free-space boundary is +/-100 mm, followed by eight fixed 8 mm PML cells per side. The strip/feed geometry and reference equations are not adjusted to fit the sampled results.

Our short-dipole reference is normalized power p(theta)=sin(theta)^2. Independent solid-angle integration gives D=4*pi/integral(p*dOmega)=1.5 (1.760913 dBi), peak direction 90 degrees and half-power beamwidth 90 degrees. Comparisons sample 0.9 / 1.0 / 1.1 GHz, theta=0..180 degrees in 2-degree increments and phi=0..350 degrees in 10-degree increments. Periodic azimuth and sin(theta)-weighted polar quadrature are independent of native Dmax.

## Sampled agreement and mesh changes

| Mesh | Native cells | dt (ps) | Max normalized-power error | Max angular-D error | Max HPBW error (degrees) | Max power imbalance (%) |
|---|---:|---:|---:|---:|---:|---:|
| n1 | 214,434 | 0.312563757 | 0.000446393 | 0.000328788 | 0.022056306 | 0.657345 |
| n2 | 329,550 | 0.170989823 | 0.000714051 | 0.000942038 | 0.079658024 | 0.968506 |
| n3 | 599,136 | 0.114869558 | 0.000926367 | 0.001137662 | 0.105982461 | 0.584957 |

Point limits are 0.01 for normalized power and angular D, 1 degree for beamwidth and peak direction, and 0.001 for cross-polar power. The native-D point bound is separately 0.02; it does not establish native-D mesh convergence. The native Prad/accepted-power closure limit is 5%, using one common raw Fourier normalization. Target errors are nonmonotonic.

| Change from ordinary n2 unless listed otherwise | Max normalized-power change | Angular-D change | HPBW change (degrees) | Power-balance change |
|---|---:|---:|---:|---:|
| n1 to n2 | 0.000749861695 | 0.000864359973 | 0.0859340282 | 0.0156379434 |
| n2 to n3 | 0.000458085219 | 0.000521649927 | 0.0523332675 | 0.00689975361 |
| n2 to n2_time | 0 | 0 | 0 | 0 |
| n2 to n2_dt | 3.13880222e-07 | 1.64004685e-07 | 1.2663619e-05 | 0.00391259158 |
| n2 to n2_domain | 6.87423367e-06 | 8.04572086e-06 | 0.000770082509 | 0.00445027172 |
| n2 to n2_feed | 3.21748615e-07 | 1.24697363e-07 | 1.1109157e-05 | 0.00628097082 |

All six changes pass 0.002 / 0.003 / 0.2 degrees / 0.02 respectively. Each source also passes the same two-surface comparison. Maxima across the seven surface comparisons are 0.000299337704 / 0.00033401081 / 0.0295290433 degrees / 0.0107409168.

## Independent controls and native admission

The ordinary allocation is 13.5 ns, with an exact -90 dB native energy stop. The time control raises the allocation to 20.25 ns. The dt control uses 0.75 times the ordinary timestep. The domain control moves the free-space boundary to +/-140 mm while preserving the full inner grid through +/-45 mm and dt. The feed control changes only the port reference to 100 ohms.

| Control | Native cells | dt (ps) | Actual source worker wall (s) | Actual wall guard (s) |
|---|---:|---:|---:|---:|
| n2_time | 329,550 | 0.170989823 | 591.458 | 1800 |
| n2_dt | 329,550 | 0.128242368 | 709.138 | 2700 |
| n2_domain | 495,000 | 0.170989823 | 833.304 | 1800 |
| n2_feed | 329,550 | 0.170989823 | 540.588 | 1800 |

Every admitted source completes its waveform and reaches the unchanged native stop before its cap. Terminal probe tails span -144.385 to -138.254 dB, below the separate -70 dB bound. Source/runtime/native-input/data identities, operator/CFL/primitive use, primary/dual probe indices, E/H clocks, complete allocated source waveform, independent port DFT, all raw face pairs and stored far-field arrays are replayed before comparison. No stopping waiver or analytical field substitution is used.

Explicit per-box E/H recording oversampling is 8. A diagnostic Nyquist-only configuration previously produced power-ratio errors despite a plausible normalized pattern; independent time-domain Fourier fields isolated that fixture configuration. The rejected FD1 and standby-interrupted records are retained outside Git and excluded. [PR #328](https://github.com/ismailakdag/fairbeam/pull/328) gives the measured before/after values and reproduction commands; production code and the native runtime were unchanged.

## Provenance and reproduction

### Offline review evidence

The committed [audit and manifests](pozar-chapter-14-evidence.json) retain the original full-precision final report, all seven acquisition source identities, runtime fingerprints, receipt summaries, native mesh/clock/operator/admission metadata and original file hashes. Installation directories and the original command's capture path are omitted from the published extraction; the original receipt/report hashes identify the unmodified local originals. All 56 source-file hashes were checked against their respective public acquisition commits. Rebuilding the seven planned native inputs with the preserved reader reproduces their original XML hashes.

The [reduced measured samples](pozar-chapter-14-samples.npz) contain normalized power on the complete sampled angular grid, measured peak and cross-polar power, voltage/current Fourier values, native radiated power and native directivity. They contain no raw face fields, native input file, Designer bundle or textbook asset. Sample-array SHA-256: `a7950b77c82c242dba8755318c2f10635525db67ee6169169502ff17431a6b60`.

From the repository root, with NumPy 2 installed, run the [offline replay](pozar-chapter-14-replay.py):

```powershell
python docs/benchmarks/pozar-chapter-14-replay.py
```

It imports neither Fairbeam nor openEMS and launches no native process. It checks the sample-file hash, recomputes 42 point rows, all six mesh/control comparisons and seven two-surface comparisons, then checks the 13 printed table rows at their stated precision. Reported admission metadata is checked separately. A missing or altered sample file, inconsistent report, failed numerical bound or changed printed value fails the replay.

The contributor also replayed all seven original captures with source `3d3c7250b46995df717cc3d53d59f51c34ab1435`; the strict result matches the original final audit without changed values or thresholds. Offline recomputation from the reduced samples is not an independent replay of unavailable raw face fields, probe traces or process logs. The maintainer has not replayed those captures. Hashes alone do not prove the contents of the original raw files. No new FDTD propagation was performed to publish this evidence.

### Native acquisition

Six sources retain their original source `2647318c915550c0af617e6c5e054dad6c0dc87b` and actual 1,800-second guards. The final dt control uses `3d3c7250b46995df717cc3d53d59f51c34ab1435` with its explicitly approved, actual 2,700-second guard. The newer test-only wall option defaults to 1,800 seconds. All seven regenerated native XML inputs are byte-identical to their frozen physical plans; the old records and their receipts are not rewritten as new acquisitions. The newer reader admits exactly the pinned prior source only with unchanged shared dependencies, its original 1,800-second receipt and a matching rebuilt native input.

The original fixture is merged as PR #328. [The test-driver follow-up, PR #332](https://github.com/ismailakdag/fairbeam/pull/332), preserves the exact historical acquisition commit in its public ancestry and reports the completed dt control; this documentation PR does not copy its code or require its merge. From an existing Fairbeam checkout and the openEMS-enabled Python environment documented there, choose unused output directories:

```powershell
git fetch https://github.com/ismailakdag/fairbeam.git pull/332/head
git worktree add --detach C:/study/dipole-reference 3d3c7250b46995df717cc3d53d59f51c34ab1435
cd C:/study/dipole-reference/python
python -m unittest tests.test_small_dipole_pattern -q
python -m tests.test_small_dipole_pattern --prepare --mesh 2 --control dt --out C:/study/dipole-plan-fresh
```

For n1/n2/n3 and n2_time/n2_dt/n2_domain/n2_feed, use the serial loop below with fresh paths. Measure each workload first, retain 80% of the slower pilot/completed rate and its conservative forecast, and defer workloads above the selected guard. Only the approved dt source uses `--max-wall-seconds 2700`; the other sources keep the default. The bounded driver owns native processes and preserves rejected prefixes. Run the serial study:

```powershell
$root = Join-Path $env:TEMP ('fairbeam-dipole-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null
foreach ($n in 1, 2, 3) {
  python -m tests.test_small_dipole_pattern --fdtd --mesh $n --pilot-seconds 5e-10 --rate-mcps 20 --out "$root/pilot_n$n" > "$root/pilot_n$n.log"
  if ($LASTEXITCODE -ne 0) { throw 'Pilot rejected' }
  $pilot = Get-Content -Raw "$root/pilot_n$n/progress.json" | ConvertFrom-Json
  $rate = (0.8 * $pilot.rate_measured_mcps).ToString('R', [Globalization.CultureInfo]::InvariantCulture)
  python -m tests.test_small_dipole_pattern --fdtd --mesh $n --rate-mcps $rate --out "$root/n$n" > "$root/n$n.log"
  if ($LASTEXITCODE -ne 0) { throw 'Native source rejected' }
}
$base = Get-Content -Raw "$root/n2/capture/report.json" | ConvertFrom-Json
$baseRate = $base.native.cells * $base.native.timesteps / $base.native.iteration_wall_s / 1e6
foreach ($control in @('time', 'dt', 'domain', 'feed')) {
  python -m tests.test_small_dipole_pattern --fdtd --mesh 2 --control $control --pilot-seconds 5e-10 --rate-mcps 20 --out "$root/pilot_n2_$control" > "$root/pilot_n2_$control.log"
  if ($LASTEXITCODE -ne 0) { throw 'Control pilot rejected' }
  $pilot = Get-Content -Raw "$root/pilot_n2_$control/progress.json" | ConvertFrom-Json
  $rate = (0.8 * [Math]::Min($pilot.rate_measured_mcps, $baseRate)).ToString('R', [Globalization.CultureInfo]::InvariantCulture)
  $wall = if ($control -eq 'dt') { 2700 } else { 1800 }
  python -m tests.test_small_dipole_pattern --fdtd --mesh 2 --control $control --rate-mcps $rate --max-wall-seconds $wall --out "$root/n2_$control" > "$root/n2_$control.log"
  if ($LASTEXITCODE -ne 0) { throw 'Control source rejected' }
  $done = Get-Content -Raw "$root/n2_$control/capture/report.json" | ConvertFrom-Json
  $measured = $done.native.cells * $done.native.timesteps / $done.native.iteration_wall_s / 1e6
  $baseRate = [Math]::Min($baseRate, $measured)
}
python -m tests.test_small_dipole_pattern --compare --out "$root/n3"
python -m tests.test_small_dipole_pattern --study --out $root > "$root/strict-study.json"
```

For any repeated same-workload pilot, also retain the slower completed measurement when it lowers the rate; do not select a faster repeat to admit an over-budget forecast. A successful process is not numerical qualification. Fresh runs must independently satisfy every target, mesh, control, power and provenance gate. Software checks and hosted CI are distinct from these numerical gates.

## Exclusions

Input reactance changes about 4.15% and then 1.85% across the ordinary meshes, so input impedance remains unqualified; an ideal short-wire radiation-resistance approximation does not certify this finite strip/feed. Native D has only its stated point check. No fabrication, finite conductivity, arbitrary Designer antenna or absolute-power calibration is covered.

The requested scopes of 14.1 and 14.3–14.8 are calculation/system examples with supplied far-field or system data; this campaign records them as calculation-only and skips native fields. It does not invent missing antenna or radar-target geometries. No gallery model, generated bundle or book asset changes.
