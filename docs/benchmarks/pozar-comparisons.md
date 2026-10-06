# Focused Pozar comparisons

This record supports the multiport and waveguide validation work. Example numbers
identify the motivating applications; all model parameters, equations and numerical records below
are our own. No textbook text, figures, tables, solution steps or PDF excerpts are reproduced.
Raw solver outputs and generated bundles are local working files, not distributed artifacts.

## Accepted scope

The WR-90 comparison associated with Example 3.9 establishes agreement and mesh stability of
complex S21 over 8.2-11.8 GHz and of its phase at 10 GHz, within the tolerances below. It does not
validate the full example: group velocity failed its separate convergence criterion. The ten
original coarse campaign examples remain unvalidated. Other geometries, higher modes, losses,
antenna quantities and measurements are outside this record's scope.

## Fixed model and reference

Source: `python/examples/waveguide_thru.py` at commit
`1db0b2f2f0d337bdc5557a5a3b5bdb01c594beef`. No model changes or pending code PRs are needed.
The guide has a = 22.86 mm, b = 10.16 mm, PEC side walls, vacuum filling and TE10 ports at both
ends. Each port is driven separately; Fairbeam assembles the full S matrix with `B A^-1` and the
frequency-dependent TE10 reference impedance. The axial boundaries use PML_8.

Let c = 299792458 m/s, f_c = c/(2a), and beta(f) = sqrt((2 pi f/c)^2 - (pi/a)^2).
The ideal transmission between the measurement planes is S21(f) = exp(-j beta(f) L_ref), with
L_ref = 5 c/(12 GHz) = 124.913524166667 mm. Reflection is zero for this ideal uniform guide.

The existing model's probe offset is six axial cells beyond each nominal length endpoint. For
every cpw, set its `length` parameter to (5 - 12/cpw) c/(12 GHz), expressed in mm. This keeps both
measurement planes at +/- L_ref/2 while the mesh is refined. Using a constant nominal `length`
instead would change the measured propagation distance with cpw.

| cpw at 12 GHz | `length` parameter (mm) | Mesh cells (intervals) | Engine cells (nodes) |
| --- | --- | --- | --- |
| 30 | 114.920442233333 | 64,792 | 72,674 |
| 40 | 117.418712716667 | 143,412 | 156,636 |
| 50 | 118.917675006667 | 268,548 | 288,486 |

## Solver and acceptance protocol

Measured on October 3, 2026 with the bundled openEMS 0.37.0rc3 / CSXCAD 0.7.0rc3 runtime, Python
3.13.15 and a Windows AMD Ryzen AI 9 365 CPU. The CPU engine used one thread, serial port runs,
the default Gaussian-derivative pulse, exact -60 dB energy stopping, a 60,000 timestep cap and
1,601 frequency samples from 8 to 12 GHz. Comparisons exclude the band edges and use 8.2-11.8 GHz.

These tolerances were fixed before the first run. They apply at every mesh level and to both
consecutive pairs, not just the last pair:

| Check | Target tolerance | Mesh-step tolerance |
| --- | --- | --- |
| max complex \|S21 - exp(-j beta L_ref)\| over the comparison band | <= 0.025 | max \|S21_new - S21_old\| <= 0.012 |
| max absolute transmission magnitude in dB (ideal 0 dB) | <= 0.02 dB | covered by the complex S21 comparison |
| S21 phase error at 10 GHz, wrapped to [-180, 180) | <= 1 degree | wrapped change <= 0.5 degree |
| max \|S11\| and \|S22\| (reflection guard) | <= 0.01 | covered by the guard at every level |
| Energy stop at both driven ports | required at every level | no timestep-limit exit accepted |

All six port runs stopped before the timestep cap. Fairbeam records `converged: true` and an
inferred `final_energy_bound_db: -60` for each run. The final energy is not directly sampled in
the console log; the bound follows from stopping through the exact energy criterion.

## Accepted numerical results

Errors in the first two columns are maxima over the comparison band. The reflection column is
the worst of the two driven-port reflections. Wall time includes both runs and post-processing.

| cpw | max complex S21 error | max absolute S21 magnitude (dB) | Phase error at 10 GHz (deg) | max reflection magnitude | Total wall time (s) |
| --- | --- | --- | --- | --- | --- |
| 30 | 0.01724303 | 0.00844610 | -0.498358 | 0.00531048 | 25.57 |
| 40 | 0.00979467 | 0.01035960 | -0.252997 | 0.00353971 | 55.78 |
| 50 | 0.00631689 | 0.01107635 | -0.137066 | 0.00269268 | 107.75 |

| Mesh pair | max complex \|delta S21\| | Absolute phase change at 10 GHz (deg) |
| --- | --- | --- |
| 30 -> 40 | 0.00820578 | 0.245361 |
| 40 -> 50 | 0.00473979 | 0.115931 |

The 19 energy, target, reflection and mesh checks for this transmission/phase scope pass. The
coarse-to-fine complex error falls from 0.01724 to 0.00632 and the phase error from -0.498 to
-0.137 degrees. Magnitude error remains within tolerance; its small increase is not described
as an improvement. These finite-mesh tolerances are not a proof of the continuum limit.

## Reproduce with existing commands

Use the Python environment described in [CLI.md](../CLI.md). From the repository root, run the
following PowerShell commands. Output and raw data go outside the checkout. All runs are serial;
no book files are required.

```powershell
$Runtime = Join-Path $env:LOCALAPPDATA 'org.fairbeam.desktop\runtime'
$Python = Join-Path $Runtime 'venv\Scripts\python.exe'
$env:OPENEMS_INSTALL_PATH = Join-Path $Runtime 'openEMS'
$env:PYTHONPATH = (Resolve-Path .\python).Path
$Output = Join-Path $env:TEMP 'fairbeam-pozar-transmission'
$Cases = @(@(30, '114.92044223333334'), @(40, '117.41871271666668'), @(50, '118.91767500666668'))
foreach ($Case in $Cases) {
    & $Python -m fairbeam run python/examples/waveguide_thru.py `
        --set "cpw=$($Case[0])" --set "length=$($Case[1])" --name guide `
        --threads 1 --engine cpu --end-db -60 --exact --points 1601 `
        --element-patterns off --quiet --out (Join-Path $Output "$($Case[0])") `
        --sim-root (Join-Path $Output "raw-$($Case[0])")
    if ($LASTEXITCODE -ne 0) { throw 'A waveguide run failed' }
}
```

Apply the following check in the same Python environment. It reads the generated bundles; it
does not run FDTD. The table used the assembled S matrix before five-decimal bundle encoding.
The encoded matrix also passes every check below, with small last-digit differences.

```python
import json, os
from pathlib import Path
import numpy as np
from fairbeam.multiport import s_from_section

root = Path(os.environ["TEMP"]) / "fairbeam-pozar-transmission"
c, a = 299792458.0, 0.02286
length = 5*c/12e9
previous = None
for cpw in (30, 40, 50):
    bundle = json.loads((root / str(cpw) / "guide.json").read_text())
    run = bundle["run"]
    assert run["converged"] and run["exact_endcriteria"]
    assert all(r["converged"] and r["timesteps"] < 60000 for r in run["port_runs"])
    planes = [p["stop"][2] for p in bundle["ports"]]
    assert abs(abs(planes[1]-planes[0])*1e-3-length) < 1e-10
    f = np.asarray(bundle["results"]["frequency"])
    s = s_from_section(bundle["results"]["sparams"])
    band = (f >= 8.2e9) & (f <= 11.8e9)
    ideal = np.exp(-1j*np.sqrt((2*np.pi*f/c)**2-(np.pi/a)**2)*length)
    at10 = int(np.argmin(abs(f-10e9)))
    phase = float(np.angle(s[at10, 1, 0] / ideal[at10], deg=True))
    assert np.max(abs(s[band, 1, 0]-ideal[band])) <= 0.025
    assert np.max(abs(20*np.log10(abs(s[band, 1, 0])))) <= 0.02
    assert np.max(abs(np.diagonal(s[band], axis1=1, axis2=2))) <= 0.01
    assert abs(phase) <= 1
    if previous is not None:
        old_f, old_s, old_phase = previous
        assert np.array_equal(f, old_f)
        assert np.max(abs(s[band, 1, 0]-old_s[band, 1, 0])) <= 0.012
        assert abs((phase-old_phase+180)%360-180) <= 0.5
    previous = f, s, phase
print("WR-90 transmission/phase checks passed; no group-velocity verdict")
```
