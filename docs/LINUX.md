# Fairbeam on Linux from source

This setup runs the CPU openEMS solver, the Python run server and the built Fairbeam viewer in a
local browser. It is a source/development setup, with a user-owned runtime prefix. It does not
produce a native Tauri app, `.deb`, AppImage, updater package or public release.

## Native desktop readiness

The source workflow below was tested on Debian 13 x86_64. That does not establish a supported Linux
desktop release: no native Tauri package or first-run Linux desktop flow has been tested. The
current gaps are:

| Area | Implemented today | Missing for a Linux desktop release |
| --- | --- | --- |
| Tauri shell and package | Shared Unix process-group shutdown code; the shell can look for `~/opt/openEMS/venv/bin/python`. | No Linux-specific Tauri bundle config or native Linux CI job. The base bundle config names macOS `app`/`dmg` targets; Windows overrides it with NSIS. |
| First-run runtime | `scripts/install-openems-linux.sh` builds a CPU openEMS/CSXCAD environment from source for development. | `runtime/pins.json` has no `linux-x86_64` uv/openEMS entries; `runtime/setup-runtime.sh` accepts macOS arm64 only. The Linux source installer is not a packaged, relocatable managed runtime. |
| Updates | The Tauri updater plugin is installed. Upstream documents Linux AppImage updater artifacts. | `scripts/publish-release.mjs` accepts only `windows-x86_64` and `darwin-aarch64`; no Linux package/signature is published in the feed. |
| Optional sign-in | Guest mode is the default. | The opt-in accounts build uses Apple/Windows keyring backends; the Linux fallback is in-memory and does not persist sign-in ([ACCOUNTS.md](ACCOUNTS.md)). |

Start with **Ubuntu 24.04 LTS x86_64** as the first Linux desktop support lane. Ubuntu lists standard
support through 2029 ([release cycle](https://ubuntu.com/about/release-cycle)). Tauri's current
Linux build prerequisites include WebKitGTK 4.1 and system development libraries
([Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)); openEMS has a separate native
dependency set ([openEMS requirements](https://docs.openems.de/en/latest/install/requirements.html)).
Confirm both sets on the Ubuntu CI runner. If publishing an AppImage for systems older than 24.04,
build it on the oldest claimed baseline: Tauri warns that newer build hosts can raise the glibc
minimum ([AppImage guidance](https://v2.tauri.app/distribute/appimage/)).

Resource protections are partly portable already. Linux CPU availability uses
`sched_getaffinity`; automatic thread selection is bounded by the process's allowed logical CPUs.
The physical-core estimate currently reads all of `/proc/cpuinfo`, and it does not account for
cgroup CPU quotas. The solver caps meshes at 40 million cells by default and estimates about 90
bytes per cell; its memory preflight warns above 60% and refuses above 90% of host
`MemAvailable`. These are estimates. Before claiming support in a memory-limited container or
sandbox, make CPU/core detection honor the allowed CPU set and account for cgroup v2 CPU and memory
limits. Keep default runs unpinned; affinity should be observed, not changed by the app.

A proposed change would add cgroup-aware
resource detection and removal of unused NF2FF recording for S11-only optimization. Its reported
Linux CPU measurements are separate from this Windows preview's validation. Reassess these
resource gaps after review and integration; native Linux desktop packaging remains separate.

Recommended implementation order:

1. Add an Ubuntu 24.04 x86_64 Tauri build/smoke runner and a Linux bundle configuration. Keep a
   second Ubuntu LTS lane for compatibility checks after the first target works.
2. Add hash-pinned Linux uv and CPU openEMS artifacts, plus a Linux first-run/repair script. Build
   or assemble a relocatable openEMS/CSXCAD package with matching Python wheels and required shared
   libraries; the installed app should not compile native code or invoke `sudo`.
3. Choose the initial package format and wire its release/signature path. AppImage is the smallest
   fit for the existing self-update flow: Tauri documents `.AppImage` and `.AppImage.sig` as the
   Linux updater artifacts ([updater guide](https://v2.tauri.app/plugin/updater/)). Extend the
   release script for `linux-x86_64`; treat a `.deb` as a separate package-manager delivery path.
4. On a real Ubuntu desktop, verify a fresh install and runtime download, viewer startup, native
   file dialogs, a coarse CPU dipole run, cancel/quit process cleanup, and a signed update while
   confirming that the user's workspace survives. Keep the smoke run in a fresh temporary folder,
   use `--engine cpu --threads 1` or `2`, and leave the default mesh guard enabled.

The generic shell, runtime verifier, release-feed UI and resource preflight can be shared with Mac
work. Linux still needs a Linux-native build runner, distribution-specific dependency checks,
Linux runtime artifacts, bundle config and a Linux update target before it can be called supported.

## Requirements

- Linux with a C/C++ compiler and development libraries (Debian 13 x86_64 was tested)
- Python 3.10+ with development headers and `venv`; Python 3.12.14 was tested
- Node.js 22.6+ and npm for the viewer and repository checks; Node 24.19.0/npm 11.9.0 were tested
- Git, CMake, make, network access to the official GitHub sources and Python/npm registries
- A modern browser with WebGL for the viewer

On Debian/Ubuntu, review and run these system-package commands yourself:

```bash
sudo apt-get update
sudo apt-get install build-essential git cmake pkg-config python3-dev python3-venv \
  libhdf5-dev libtinyxml-dev libboost-all-dev libcgal-dev libvtk9-dev
```

The installer never invokes `sudo`, `apt`, or an upstream system-package installer. VTK's
package can bring additional dependencies; Qt/AppCSXCAD is not built by this setup. Other
Linux distributions need equivalent development packages; consult the
[upstream requirements](https://docs.openems.de/en/latest/install/requirements.html).

## Install and launch

From the repository root:

```bash
# Native CPU libraries and Python bindings, then this checkout's fairbeam package
scripts/install-openems-linux.sh

# Built viewer
npm ci
npm run build

# Viewer and Python API together; opens the local browser on an available port
scripts/run-linux.sh
```

The launcher uses the existing `fairbeam app` command, binds to `127.0.0.1`, and keeps the server
in the foreground. Stop it with Ctrl+C. Run `npm run build` again after frontend edits. Python
is installed editable from this checkout, so Python edits do not require a reinstall.

For a headless machine or a fixed port:

```bash
scripts/run-linux.sh --no-browser --port 5320
# Open http://127.0.0.1:5320 on the same machine
scripts/run-linux.sh --help
```

All arguments are forwarded to `fairbeam app`, including `--models`, `--projects`, `--jobs`,
`--sim-root`, and `--ui`. The default model/project directories are in this checkout; raw solver
output and job history use its `.sim` directory. See [RUN-SERVER.md](RUN-SERVER.md) for details.
The server runs your Python models with your account's permissions; it is not a Python sandbox.

### Custom paths and an existing installation

```bash
PREFIX="$HOME/opt/fairbeam Linux" SRC="$HOME/opt/openems Linux sources" JOBS=2 \
  scripts/install-openems-linux.sh
PREFIX="$HOME/opt/fairbeam Linux" scripts/run-linux.sh

# Or select an existing interpreter with working openEMS, CSXCAD and fairbeam imports
PREFIX="/path/to/openEMS" FAIRBEAM_PYTHON="/path/to/venv/bin/python" \
  scripts/run-linux.sh --no-browser
```

Installer settings:

- `PREFIX`: native libraries and `venv/`; default `~/opt/openEMS`
- `SRC`: cached upstream checkout and build directories; default `~/opt/openems-src-linux`
- `PYTHON`: interpreter used when creating a new venv; default `python3`
- `JOBS`: native compile parallelism; default 2, or use 1 for a low-memory machine
- `CC`/`CXX`: compilers; default `gcc`/`g++`

An existing importable `PREFIX/venv` is reused without rebuilding or upgrading openEMS/CSXCAD.
A normal installer run still installs Fairbeam from the current checkout. An invalid existing
venv is rejected before native files are written. If the venv is valid but the native bindings
cannot import, the installer rebuilds the native components and may replace their installed
files; choose a new `PREFIX` and `SRC` to preserve an older installation.

A source checkout at a different upstream revision, one with tracked changes, or a CMake cache
for another install prefix is left alone and rejected; choose another `SRC`. Reusing build
caches across prefixes can retain the older library paths. For a clean rebuild, choose both
a new `PREFIX` and a new `SRC`.

The installer builds fparser, CSXCAD and openEMS individually, then their Python bindings. New
builds use the pinned upstream revisions below; Python dependencies come from the configured pip
registry and are not locked. Both scripts add `PREFIX/lib` and `PREFIX/lib64` to
`LD_LIBRARY_PATH`, preserving any existing value. When running the Python CLI directly with a
custom native prefix, use the same library path if imports cannot locate the shared libraries.

## Minimal verification

The first check is read-only and does not download, install, simulate or launch a server:

```bash
scripts/install-openems-linux.sh --check

# Set PREFIX here if the installation is not in the default directory
export PREFIX="${PREFIX:-$HOME/opt/openEMS}"
export LD_LIBRARY_PATH="$PREFIX/lib:$PREFIX/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# The suite expects the default mesh limit, not a user-provided override
env -u FAIRBEAM_MAX_CELLS "$PREFIX/venv/bin/python" -m unittest discover -s python/tests -q

# One small CPU simulation; writes only into a fresh temporary folder
smoke_dir="$(mktemp -d)"
"$PREFIX/venv/bin/python" -m fairbeam run python/models/dipole.py \
  --set mesh_div=10 --points 101 --end-db=-30 --threads 2 --engine cpu \
  --name linux-smoke --out "$smoke_dir/projects" --sim-root "$smoke_dir/sim"
printf 'Smoke results: %s\n' "$smoke_dir"
```

Run simulations one at a time. This deliberately coarse dipole is a runtime smoke test, not a
mesh-converged accuracy benchmark. Repository frontend checks are described in
[FROM-SOURCE.md](FROM-SOURCE.md#tests).

## Tested configuration and limits

Tested on September 30, 2026 using Fairbeam source commit
`d3de9af23b6d8c31295387b346e395d46707d6e6` and the following official upstream sources:

| Component | Tested revision/version |
| --- | --- |
| Linux | Debian GNU/Linux 13 (trixie), x86_64 |
| Python | 3.12.14 |
| Compiler / CMake | GCC/G++ 14.2.0 / CMake 3.31.6 |
| openEMS-Project | `9f5cdd4d71cae312633ab0b2c1db64867f8c782b` |
| openEMS | `5b1ecb1244e6bd192d83efdf2bc84e5f83c96047` (`v0.37.0-rc3-16-g5b1ecb1`) |
| CSXCAD | `bd2c133392d93251b640da1f8e2367163f00b7f5` (`v0.7.0-rc3-1-gbd2c133`) |
| fparser | `4b9c845b449b520c4b8c5f23c74cd04820084f81` |
| Native dependencies | Boost 1.83, HDF5 1.14.5, VTK 9.3.0, TinyXML 2.6.2, CGAL 6.0.1 |
| Python dependencies | NumPy 2.5.3, h5py 3.16.0, Cython 3.3.0, setuptools 84.0.0 |
| Frontend tools | Node 24.19.0, npm 11.9.0 |

The test environment did not permit system-package installation. Debian development/runtime
packages were extracted into a workspace-local directory, with their paths supplied through
`CMAKE_PREFIX_PATH`, a test-only `CMAKE_TOOLCHAIN_FILE`, compiler flags and `LD_LIBRARY_PATH`.
The final installer completed an end-to-end build in initially empty source and runtime
directories, both containing spaces, in 177.4 seconds. This included cloning the pinned
upstream sources, compiling all three native libraries and both Python bindings, creating a
venv, installing Fairbeam and checking imports. The ordinary apt-installed dependency layout
on another host has not been tested separately.

The installer's reuse path also passed, including bootstrapping missing `pip` with venv-local
`ensurepip`. Five regression tests verify read-only checks and rejection of invalid venvs or
build caches for another prefix before native files are written. Launcher path/argument
handling, including a relative venv interpreter, passed. The launcher served the built viewer
and answered local health/API checks, then stopped cleanly.

The 100,842-cell CPU dipole smoke run converged after 7,200 timesteps with two threads. It took
13.8 seconds wall time and about 101 MiB peak process RSS, with S11 about −37.6 dB at 2.4 GHz,
maximum directivity 2.19 dBi and radiation efficiency 98.17%. These figures describe that run,
not a performance guarantee.

The final freshly installed runtime repeated the same smoke in 14.9 seconds, converged at
7,200 timesteps, and matched the original S11/impedance arrays within relative tolerance
`1e-8` and absolute tolerance `1e-10`. Its launcher also passed health, UI-file and result-bundle
HTTP checks and shut down cleanly.

`npm run build` (including TypeScript checking), `npm run check:designer`, and
`npm run check:exports` passed. The build reported an oversized main-chunk warning and
mixed static/dynamic import warnings.

Direct imports and geometry export also passed. A full Python suite rerun with the default
mesh limit completed 799 tests in 146.3 seconds: 778 passed, 20 skipped and one failed. The
analytic dipole `DipoleTest.test_moment_method_reference` predicts a resonance near 2.53 GHz,
outside the expected 2.42–2.47 GHz interval. Its MoM matrix is numerically rank-deficient
(99 of 100 at 2.44 GHz); this separate analytic reference remains unresolved. The openEMS
solver and the test's expected range were not changed. An earlier mesh-limit
failure was caused by the test environment's `FAIRBEAM_MAX_CELLS` override and disappeared
when the override was removed.

The manual browser fixture and `npm run check:scenarios -- --skip-run` both stopped during
browser setup: the sandbox blocked Chromium's process-singleton socket. The separate cloud
browser denied access to the localhost preview. No app browser assertions were reached, and no graphical
interaction or WebGL rendering pass is claimed. Native Tauri packaging, GPU acceleration,
other Linux distributions/architectures and distributable Linux installers are also unverified.
