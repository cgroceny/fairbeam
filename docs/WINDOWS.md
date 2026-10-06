# Fairbeam on Windows


The viewer runs in any browser, so the public demo (`https://fairbeam.org/app/`) works on
Windows as it is. This page covers running simulations locally on Windows 10/11 (x64): openEMS,
the Python package, the local run server and the viewer.

**Status:** verified on Windows 11 Pro 25H2 (build 26200), AMD Ryzen 9 7900X (12 cores / 24
threads, 32 GB), Python 3.13.15, openEMS v0.37.0-rc3 / CSXCAD v0.7.0-rc3 (official MSVC build),
Node.js 22.11.0. Every check in [Verifying a Windows install](#verifying-a-windows-install)
passed.

## What is platform specific

| Part | macOS / Linux | Windows |
|---|---|---|
| openEMS | built from source (`scripts/install-openems-macos.sh`) | official MSVC build: `openEMS_x64_<version>_msvc.zip` from the [openEMS-Project releases](https://github.com/thliebig/openEMS-Project/releases), with Python wheels (cp313/cp314) inside |
| DLL lookup | rpath | Python 3.8+ ignores `PATH` for extension DLLs: `fairbeam` registers `OPENEMS_INSTALL_PATH` (else `CSXCAD_INSTALL_PATH`, else `C:\opt\openEMS`) with `os.add_dll_directory` on import; the wheels themselves honor the same two variables |
| openEMS output capture (run statistics, energy trace, progress) | `dup2` of fds 1/2 plus `fflush` of libc | the same `dup2`, plus `fflush` of the Universal CRT (`ucrtbase`) that CPython and MSVC builds share |
| Run-server child processes | new session, SIGTERM/SIGKILL to the group | `CREATE_NEW_PROCESS_GROUP` inside a job object (`fairbeam/procutil.py`): CTRL_BREAK_EVENT to the group, then the job object is terminated, which also stops processes the CTRL_BREAK missed; the job object kills the whole tree when the server dies, even when it is killed outright |
| Stopping a run | SIGTERM (Ctrl+C in a terminal: openEMS aborts gracefully, `fairbeam run` exits 130 without a bundle) | CTRL_BREAK: openEMS' own handler aborts gracefully, `fairbeam run` exits 130 without a bundle |
| Orphans after a server crash | matched by `ps -o lstart` and command line, SIGTERM/SIGKILL to the group | matched by the process creation time and command line (ctypes: `GetProcessTimes`, `NtQueryInformationProcess`), `taskkill /T /F` |
| GPU engine | Metal fork (macOS) | optional: the fork's CUDA package for NVIDIA GPUs (`scripts\install-openems-gpu-windows.ps1`, [GPU.md](GPU.md)); the official build is CPU only |

Two Windows details that shape the code:

- The `python.exe` in a venv's `Scripts\` is a launcher that runs the real interpreter as a child
  process, so every Python child of the run server is a tree of (at least) two processes. That is
  why whole trees are stopped (job object, `taskkill /T`), never a single pid.
- `os.kill(pid, 0)` does not probe a process on Windows, it terminates it (`TerminateProcess`).
  `procutil.pid_alive` uses `OpenProcess`/`GetExitCodeProcess` instead.

## Form suggestions

The desktop window disables WebView2 general autofill so its "Saved info" popup does not cover
CAD fields. Text, numeric and expression inputs also set `autocomplete="off"` for the browser
viewer. WebView2 can ignore that HTML hint, so the native window setting is required; see
[Microsoft's settings reference](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2settings4).
This takes effect when starting the updated desktop executable. Reloading an older executable's
page does not change its native window settings. Existing designs and profile data are retained;
Fairbeam's own parameter and component suggestions still work.

## Install

Use PowerShell. Python must match the wheels in the openEMS archive (3.13 or 3.14 for
v0.37.0-rc3). The paths below use `C:\opt\openEMS` and `C:\code\fairbeam`; any other folder or
drive works the same way (the verified install used `E:\opt\openEMS` and `E:\code\fairbeam`):
only `OPENEMS_INSTALL_PATH` has to point at the folder that contains `openEMS.exe`.

1. **Tools** (skip what is installed):

   ```powershell
   winget install --id Git.Git -e
   winget install --id GitHub.cli -e
   winget install --id Python.Python.3.13 -e
   winget install --id OpenJS.NodeJS.LTS -e
   ```

   Open a new PowerShell afterwards so `PATH` is refreshed, then check `py -3.13 --version`. To put
   Python on another drive without changing the default `python`:
   `winget install --id Python.Python.3.13 -e --scope user --override "/quiet InstallAllUsers=0 TargetDir=E:\Python313 PrependPath=0 Include_launcher=0"`
   (`py -3.13` still finds it).

2. **The repository**, with LF line endings (the export checks compare files byte for byte; the
   repository's `.gitattributes` enforces LF):

   ```powershell
   git config --global core.autocrlf false
   gh repo clone ismailakdag/fairbeam C:\code\fairbeam
   cd C:\code\fairbeam
   ```

3. **openEMS**: the archive has a top-level `openEMS\` folder, so extracting it into `C:\opt` gives
   `C:\opt\openEMS\openEMS.exe` directly (its `README.txt` assumes `C:\openEMS`; any folder works).

   ```powershell
   gh release download v0.37.0-rc3 -R thliebig/openEMS-Project -p "openEMS_x64_*_msvc.zip" -D $env:TEMP
   Expand-Archive "$env:TEMP\openEMS_x64_v0.37.0-rc3_msvc.zip" -DestinationPath C:\opt
   C:\opt\openEMS\openEMS.exe --help        # prints the openEMS v0.37.0-rc3 banner
   [Environment]::SetEnvironmentVariable("OPENEMS_INSTALL_PATH", "C:\opt\openEMS", "User")
   $env:OPENEMS_INSTALL_PATH = "C:\opt\openEMS"
   ```

   The variable is read when a process starts: terminals (and editors) opened before this step
   do not see it until they are restarted.

4. **A virtual environment with the openEMS wheels and the `fairbeam` package**, in the repository folder:

   ```powershell
   py -3.13 -m venv .venv
   .\.venv\Scripts\Activate.ps1
   python -m pip install --upgrade pip
   python -m pip install numpy h5py (Get-ChildItem C:\opt\openEMS -Recurse -Filter "*cp313*win_amd64.whl").FullName
   python -m pip install -e python
   python -c "import fairbeam, CSXCAD, openEMS; print('ok', fairbeam.__version__)"
   ```

   The CSXCAD wheel also pulls in matplotlib from PyPI. The openEMS README's variant,
   `pip install --no-index --find-links C:\opt\openEMS\python openEMS`, only works after
   `pip install numpy h5py matplotlib`, because `--no-index` keeps pip from fetching them.
   `ImportError: DLL load failed while importing CSXCAD` means `OPENEMS_INSTALL_PATH` is not set in
   this terminal or does not point at the folder with `CSXCAD.dll`.

5. **Node.js 22 LTS** for the viewer, then `npm ci` in the repository folder.

## Run

```powershell
# one simulation (coarse, about 30 s)
cd python
python -m fairbeam run models/dipole.py --set mesh_div=10 --points 201 --end-db -30 --threads 4

# the viewer with the local run server (two terminals)
python -m fairbeam serve   # in python\, http://127.0.0.1:5320/api
npm run dev                # in the repository folder, http://localhost:5310
```

## Verifying a Windows install

These are the checks that decide whether Windows works; run them in order and keep the output.

1. `python -m unittest discover -s tests -v` in `python\` (uses a fake openEMS for the server
   tests). Verified: 312 tests OK, 1 skipped (the GPU engine detection, which needs a shell script
   standing in for openEMS).
2. The coarse dipole run above with `--name win-dipole`, then
   `python ..\scripts\ci-check-bundle.py ..\public\projects\win-dipole.json`. It fails when the
   openEMS output could not be captured (no timesteps or energy trace). Verified: 100842 cells,
   7200 timesteps in about 28 s, 6 energy points, min S11 -37.6 dB at 2.400 GHz, `ok`. Delete the bundle afterwards and
   `git restore public/projects/index.json`: generated bundles are never committed.
3. `npm ci`, `npx tsc --noEmit`, `npm run -s build`, `npm run -s check:cst`,
   `npm run -s check:exports`.
4. In the viewer with `fairbeam serve` running: open the Run panel, start a run, watch the
   progress, open the result; cancel a second run: its process tree must disappear
   (`Get-Process python, openEMS`) and no bundle may be written for it.
5. Stop `fairbeam serve` with Ctrl+C while a run is going: no `openEMS` / `python` process may be
   left behind, and the job is listed as interrupted.
6. `python -m fairbeam clean-sim --dry-run` lists only raw run folders under `.sim\` (never
   `jobs\` or anything written in the last 10 minutes).

The same install, smoke run and Python tests run in `.github/workflows/ci.yml` (manual trigger)
on a GitHub Windows runner.

## Desktop app

The desktop app installs its own runtime and needs none of the manual installation steps above.
See [RELEASES.md](RELEASES.md) for version-specific validation.
See [DESKTOP.md](DESKTOP.md) for the contract. On Windows:

- Installer: NSIS `.exe`, per user (`installMode: currentUser`, no admin rights), WebView2 through
  the embedded bootstrapper (`src-tauri/tauri.windows.conf.json`). Windows 11 already has WebView2.
  Updates are offered in the app and install in passive mode (`plugins.updater.windows.installMode`
  in `src-tauri/tauri.conf.json`).
- Runtime: `%LOCALAPPDATA%\org.fairbeam.desktop\runtime`, created on first start by
  `runtime\setup-runtime.ps1` (Windows PowerShell 5.1) and `runtime\install.py`. Verified: fresh
  install, re-run, `-Repair`, `--app-only`, damaged downloads, no network, paths with spaces and
  non-ASCII characters. The server started from that runtime passes the same checks as step 4 and
  5 above (run, cancel, Ctrl+C with nothing left running).
- The installed app (the 0.2 shell) was verified end to end: first-start install, run, cancel, quit, kill,
  second start, an existing Python and uninstall. See the Windows list in [DESKTOP.md](DESKTOP.md).
- An existing Python (the venv from the install steps above) needs `OPENEMS_INSTALL_PATH` in the
  user environment, as set in step 3. Without it the app shows "The chosen Python cannot run
  Fairbeam ... DLL load failed while importing CSXCAD". The CUDA install's venv is the exception:
  the app sets the variable for it ([GPU.md](GPU.md)).
- Building needs Rust (`rustup`, `stable-x86_64-pc-windows-msvc`) and the Visual Studio 2022 C++
  build tools.

## Known limitations

- The official openEMS build is CPU only. Fairbeam's setup and General settings can install the
  optional NVIDIA build into a separate managed `gpu-runtime` folder, keeping the CPU runtime
  available. The selected runtime takes effect on the next app start; the Run dialog offers
  CPU and GPU when that runtime advertises both. No separate Fairbeam installer or CUDA toolkit
  is needed. Existing external GPU installations remain supported. See [GPU.md](GPU.md).
- Symbolic links need developer mode or admin rights. The run server does not depend on them (it
  copies a model file where it would link it); the one test that checks that `clean-sim` does not
  follow a link skips that part without them.
- A run server started without any console (a detached GUI process) cannot deliver CTRL_BREAK to
  its jobs; canceling then terminates the job object after the grace period (5 s), so openEMS
  stops without its graceful abort. The result is the same: no bundle, no processes left. (Not
  tried: every verified setup ran the server from a console.)
- The installer is not signed yet: SmartScreen warns on the first run of the downloaded `.exe`.
  (The macOS build has been signed and notarized since 0.4.4; Windows signing is still open.)
