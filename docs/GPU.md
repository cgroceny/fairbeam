# GPU engine (optional: Apple silicon, NVIDIA on Windows)

[SeanMollet/openEMS](https://github.com/SeanMollet/openEMS) (GPL-3.0) adds a GPU engine to openEMS: Metal on Apple silicon (macOS 15+), CUDA elsewhere. `scripts/install-openems-gpu-macos.sh` builds it from source next to the regular install (`~/opt/openEMS-gpu`, own venv; nothing in `~/opt/openEMS` changes). Then:

```bash
~/opt/openEMS-gpu/venv/bin/fairbeam run python/models/patch_antenna.py --engine gpu
npm run serve:gpu          # run server using the GPU build; the Run panel and the designer's Run dialog then offer an Engine picker
```

The desktop app uses `~/opt/openEMS-gpu/venv` by itself when its openEMS lists the gpu engine (General settings › Start with the GPU build of openEMS, on by default; [DESKTOP.md](DESKTOP.md#shell)).

Solver timings on an Apple M5 Pro. In documented same-timestep Windows CPU / macOS Metal
comparisons, S-parameter magnitudes above −30 dB agree within 0.1 dB and Dmax within 0.004 dB; see
[BENCHMARKS.md](BENCHMARKS.md) for the tested models and limits:

| Model | Cells | CPU (4 threads) | Metal GPU |
| --- | --- | --- | --- |
| Patch antenna, −60 dB | 0.26 M | 10.6 s¹ | 1.6 s |
| Patch antenna, −40 dB | 0.1 M | 8.0 s | 0.72 s |
| Sierpinski monopole, iteration 3 | 2.0 M | 12.0 s | 2.7 s (2650 MCells/s) |

¹ Re-measured on 2026-09-25 with the current model (12628 timesteps; best of two runs, 10.59 and 10.75 s).
The committed `public/projects/patch-antenna.json` says 16.06 s: it predates the fixed end-criterion
schedule and ran 18468 timesteps.

The same models on a Windows desktop (Ryzen 9 7900X, CPU engine), and how its results compare with
the Apple M5 Pro (Metal) bundles: [BENCHMARKS.md](BENCHMARKS.md).

The engine actually used is read back from the openEMS log and stored in the bundle (`run.engine`); asking for `--engine gpu` on a build without it prints a warning and runs on the CPU. The fork does not support `--exact-endcriteria`; Fairbeam then falls back to the fork's own (on-device, fine-grained) energy check. The fork is a beta by a single developer: keep using the CPU build for reference results until you have compared the two on your structures.

## Windows with an NVIDIA GPU (CUDA)

The fork's release of the same tag, `v0.37.0-beta1+gpu`, includes a Windows package built by its
CI: MSVC 2022, CUDA 12.8.1, for sm_60 to sm_120. The CUDA runtime is linked statically, so it
needs an NVIDIA driver compatible with CUDA 12, not a CUDA toolkit. Fairbeam's managed Windows
setup uses the Windows minor-compatibility floor of 528.33 and checks compute capability 6.0–12.0
against this pinned package. See NVIDIA's
[CUDA 12.8.1 release notes](https://docs.nvidia.com/cuda/archive/12.8.1/cuda-toolkit-release-notes/index.html).
Without a
supported GPU, the fork falls back to a reference backend on the CPU, which is slower than the
regular build.

`scripts\install-openems-gpu-windows.ps1` downloads that package (pinned by URL and SHA-256),
unpacks it next to the regular install and gives it its own venv with the package's wheels and
`fairbeam`. It then checks that `openEMS.exe --help` lists the gpu engine. The regular install and
the user's `OPENEMS_INSTALL_PATH` are not changed.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-openems-gpu-windows.ps1 -Prefix C:\opt\openEMS-gpu
$env:OPENEMS_INSTALL_PATH = "C:\opt\openEMS-gpu"     # this venv loads its DLLs from there
C:\opt\openEMS-gpu\venv\Scripts\python.exe -m fairbeam run python\models\patch_antenna.py --engine gpu
```

Set `OPENEMS_INSTALL_PATH` to the GPU folder whenever you use its venv. The wheels load their DLLs
from that variable, and it usually points at the CPU build. The log names the backend:
`Create FDTD engine (GPU, backend: CUDA (NVIDIA GeForce RTX 3060))`.

Measured on a Ryzen 9 7900X with an NVIDIA GeForce RTX 3060 (12 GB, driver 591.74), against the
same machine's CPU engine with 4 threads. The times are the solver times summed over all port runs:

| Model | Cells | CPU, 4 threads | RTX 3060, CUDA | Speed-up | MCells/s (CUDA) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Patch antenna | 276,138 | 52.9 s (median of 3) | 2.56 s (median of 3) | 21 × | 1376 |
| 4 × 1 patch array (4 runs) | 452,270 | 873.8 s | 25.1 s | 35 × | 1424 |
| Pyramidal horn | 1,136,520 | 224.6 s | 6.3 s | 36 × | 1948 |
| Sierpinski monopole, iteration 3 | 2,012,304 | 61.1 s | 3.4 s | 18 × | 3052 |
| Wilkinson divider (3 runs) | 113,103 | 41.1 s | 4.4 s | 9 × | 825 |

The results were compared with `scripts/bench_compare.py`:
- **Against the CPU engine on the same machine.** Where both stop at the same timestep (patch
  antenna, 4 × 1 array, Wilkinson), every value agrees to 0.000 dB. The horn and the Sierpinski
  monopole stop 50 to 480 timesteps apart, because the fork checks the end criterion on the
  device. Dmax still agrees within 0.009 dB and |S11| within 0.1 dB.
- **Against the Apple M5 Pro Metal bundles** (horn, 4 × 1 array and Wilkinson, all stopping at
  the same timestep): within 0.1 dB in every S-parameter above −30 dB and 0.005 dB in Dmax.

All numbers are in [BENCHMARKS.md](BENCHMARKS.md).

### The CUDA engine in the viewer

The designer's Run dialog and the Run panel show an **Engine** picker (CPU / GPU) when the run
server's Python has an openEMS build with the gpu engine. General settings › **Default engine**
sets the one they start with (GPU falls back to CPU when it is unavailable). `/api/health` then lists `"engines": ["cpu", "gpu"]`. On Windows, the
server looks for `openEMS.exe` in `OPENEMS_INSTALL_PATH`, so that variable has to name the GPU
folder.

**From the repository** (the counterpart of `npm run serve:gpu` on macOS):

1. In a new PowerShell, point the variable at the GPU build for this terminal only:
   `$env:OPENEMS_INSTALL_PATH = "C:\opt\openEMS-gpu"`.
2. Start the run server with the GPU venv's Python, in `python\`:

   ```powershell
   $py = "C:\opt\openEMS-gpu\venv\Scripts\python.exe"
   & $py -m fairbeam serve --python $py
   ```

   The start-up line ends with `(engines: cpu, gpu)`. The runs it starts inherit the variable.
   Without it, the venv cannot import CSXCAD, or, when the variable names the CPU build, it loads
   that build's DLLs, and runs fail with NaN results.
3. Start the viewer as usual (`npm run dev`, or `--ui dist` after `npm run build`). In the Run
   panel choose **GPU** under Engine. The job log shows
   `Create FDTD engine (GPU, backend: CUDA (NVIDIA GeForce RTX 3060))`, and the bundle has
   `run.engine: "gpu"`.

**In the desktop app** (no managed runtime needed):

1. With the install script's default prefix (`C:\opt\openEMS-gpu`), or `\opt\openEMS-gpu` on
   another fixed drive (for example `D:\opt\openEMS-gpu`; C: is looked at first, then the other
   fixed drives in order), the app takes the GPU venv by itself (General settings › **Start with
   the GPU build of openEMS**, on by default). The setup screen's **Prefer the GPU build** names
   the folder it found. Only the existence of
   `<drive>:\opt\openEMS-gpu\venv\Scripts\python.exe` is checked, and network, removable and
   optical drives are skipped. At another prefix, choose "Use an existing Python…" and pick
   `<prefix>\venv\Scripts\python.exe`, or edit `python` in
   `%APPDATA%\org.fairbeam.desktop\settings.json`, with `"runtime": "external"`. When that Python's
   openEMS lists the gpu engine, General settings shows it as the GPU build (its folder, and a note
   that runs offer both engines) instead of the switch, because a chosen Python comes first.
2. Nothing else is needed. For an external Python at `<prefix>\venv\Scripts\python.exe` with
   `<prefix>\openEMS.exe` next to it, which is the layout the install script creates, the app sets
   `OPENEMS_INSTALL_PATH=<prefix>` for the server and its runs. The user's own variable can keep
   pointing at the CPU build. Any other external Python still uses the user's
   `OPENEMS_INSTALL_PATH`.
3. The Run dialog and the Run panel then show the Engine picker. The server log
   (`%LOCALAPPDATA%\org.fairbeam.desktop\logs\server.log`) shows
   `openEMS 0.37.0b1+gpu` and `(engines: cpu, gpu)`.

### One app installation with optional managed GPU support

The desktop app installs its CPU runtime normally. On Windows, setup and General settings can
also prepare the pinned NVIDIA GPU package in the app's own per-user `gpu-runtime` folder. The
CPU runtime remains in its sibling `runtime` folder. Users do not need a separate Fairbeam
installer, a system Python or a CUDA toolkit.

General settings reports hardware readiness and installation progress. A prepared GPU runtime
is an explicit startup choice, applied when the app is next opened; preparing it does not stop
the current server or a running simulation. A supported existing GPU installation can be used
without downloading another copy. A missing, unsupported or broken GPU runtime leaves the CPU
path available. The Run dialog offers CPU and GPU only when the active runtime advertises both.

The optional GPU build remains upstream beta software. Managed GPU installation is currently
available on Windows only; on macOS and Linux the existing external-runtime flows are unchanged.
