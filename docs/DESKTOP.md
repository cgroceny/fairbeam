# Desktop app (Tauri) and the managed runtime

The desktop app is the web viewer plus the local run server (`fairbeam serve`) in one installable
program for Windows x64 and macOS arm64. It needs no repository checkout, no system Python and no
admin rights. On first start it installs its own runtime (Python, the Python packages, openEMS)
into a per-user folder. This page is the contract between the Tauri shell (`src-tauri/`), the
runtime installer (`runtime/`) and the platform packaging.

How to use the app's designer (modeling, simulation settings, running from the model) is in
[DESIGNER.md](DESIGNER.md).

**File › Close Design** (desktop only) returns to the Start screen, asking Save / Don't save /
Cancel for an edited design. It keeps the app and run server open. Ctrl+W on Windows and Cmd+W on
macOS belong to the Close Window menu item, which does the same while a design is open and closes
the window when no design is open.

Closing the window itself (the title-bar X or Alt+F4 on Windows, the red button on macOS) and
quitting (File › Exit on Windows, Fairbeam › Quit Fairbeam or Cmd+Q on macOS) ask the same Save / Don't
save / Cancel question while a design has unsaved changes or a save is still running. Cancel keeps
the window and the draft; the app only goes after a clean save or Don't save. The shell holds
the close and asks the viewer (`window.fairbeamWindowClose`, see `src/designer/windowClose.ts`
and `request_leave` in `src-tauri/src/main.rs`); a viewer that does not answer cannot keep the app
open against a second close. Quitting from the macOS Dock or at logout goes past this question
(Tauri cannot hold `terminate:`); the local draft backup covers those.

Status: 0.7.0 is the first release.

Verified on macOS arm64:
- The app builds: `Fairbeam.app` is 21 MB, the `.dmg` 7.5 MB.
- An existing `~/opt/openEMS` install is picked up.
- With a local pack, the managed runtime installs from the app in about 20 s (664 MB on disk).
- A coarse dipole run through the app completes.
- Quitting stops the server in about 1 s with no process left.

Verified on Windows 11 x64, with the NSIS installer:
- The installer is 6.2 MB. It installs per user without a UAC
  prompt in about 1.5 s: 22 MB in `%LOCALAPPDATA%\Fairbeam`, with Start menu and desktop shortcuts.
- On first start the setup screen appears. "Install the runtime" downloads and installs it with
  progress (about 17.5 s). The viewer is up 19.8 s after the click, and `Documents\Fairbeam` is
  seeded.
- A coarse dipole run through the app completes, and canceling a run leaves no process. Later
  starts reach the viewer in 1.7 s without reinstalling.
- Quitting stops the server in 1.7 s with no process left, also during a run. Killing
  `fairbeam.exe` (Task Manager) leaves none within 0.7 s, through the job object.
- "Use an existing Python" works with a repository venv (`OPENEMS_INSTALL_PATH` set as in
  [WINDOWS.md](WINDOWS.md)).
- Uninstalling removes the install folder and the shortcuts. The app data (runtime, logs, WebView2
  data, about 560 MB) and `settings.json` stay unless you select "Delete the application data".
  The workspace stays in either case.

The published installer was checked as a first-time user would use it, downloaded from the
website with Edge:
- The file matches `SHA256SUMS.txt` and `docs/RELEASES.md`.
- The unsigned file carries the Mark of the Web, and SmartScreen shows "Windows protected your PC".
  "More info → Run anyway", as the website says, starts the installer. Afterwards the file has no
  `Zone.Identifier` any more.
- Installing to another folder works.
- The first start without `FAIRBEAM_AUTO_INSTALL` reaches the viewer 27 s after "Install", and a
  coarse run completes.
- The update check stays quiet: no dialog and no error.
- The GUI uninstaller with "Delete the application data" ticked removes the install folder,
  `%LOCALAPPDATA%\org.fairbeam.desktop` and `%APPDATA%\org.fairbeam.desktop`. `Documents\Fairbeam`
  stays.

The macOS pack (26.8 MB) is published in
[fairbeam-releases](https://github.com/ismailakdag/fairbeam-releases/releases) and pinned in
`runtime/pins.json`. A fresh install that downloads it takes about 17 s.

## Folders

| Folder | macOS | Windows | Contents |
|---|---|---|---|
| resources (read-only, inside the app) | `Fairbeam.app/Contents/Resources` | install dir, next to `fairbeam.exe` | `ui/` (built viewer), `python/fairbeam/` (the package source), `models/`, `templates/`, `projects/` (example bundles and `index.json`), `runtime/` (see below) |
| app data | `~/Library/Application Support/org.fairbeam.desktop` | `%LOCALAPPDATA%\org.fairbeam.desktop` | `runtime/`, `logs/` (`server.log`, `shell.log`, `runtime-<time>.log`; Tauri's app local data dir) |
| settings | `~/Library/Application Support/org.fairbeam.desktop/settings.json` | `%APPDATA%\org.fairbeam.desktop\settings.json` | `runtime` (`managed` / `external`), `python`, `workspace`, `prefer_gpu`, `check_updates_on_start`, `recent_designs` (the eight File › Open Recent entries) and, in a build with sign-in, `account` (Tauri's app config dir) |
| runtime | `<app data>/runtime` | `<app data>\runtime` | `uv/`, `python/` (uv-managed CPython), `venv/`, `openEMS/`, `app/fairbeam/` (copied package), `downloads/`, `cache/`, `manifest.json` |
| workspace (visible to the user) | `~/Documents/Fairbeam` | `%USERPROFILE%\Documents\Fairbeam` | `projects/`, `models/`, `templates/`, `jobs/`, `model-history/`, `.sim/` |

The workspace is seeded on first start: example projects, models and templates are copied from the
resources, each folder only while it does not exist or is empty, so the user's files are never
touched. General settings can choose a workspace for the next app start. This changes the
active folder; it does not move or delete existing projects. The current and next-start paths
are shown separately so an active server keeps using its original workspace until restart.

## Runtime installer

`runtime/pins.json` pins every download with a URL and SHA-256: uv, the CPython minor version, and
openEMS per platform. `runtime/requirements.txt` (made with `uv pip compile --universal
--generate-hashes`) pins the Python packages.

**Stage 1** is platform specific and needs no Python:

- macOS: `runtime/setup-runtime.sh --runtime-root <abs>/runtime --resources <res> [--repair] [--openems-archive FILE]`
- Windows: `runtime/setup-runtime.ps1 -RuntimeRoot <abs>\runtime -Resources <res> [-Repair] [-OpenemsArchive FILE]`
  (run with `powershell -NoProfile -ExecutionPolicy Bypass -File ...`). Verified on Windows 11 with
  Windows PowerShell 5.1, see [Windows notes](#windows-notes).

It downloads uv and checks its hash, runs `uv python install <pins.python>` into `runtime/python`
and `uv venv runtime/venv --managed-python`, then execs stage 2 with the venv's Python.

**Stage 2** is `runtime/install.py`, shared by both platforms and standard library only:

1. It downloads the pinned openEMS build and checks its hash. Windows uses the official MSVC zip;
   macOS uses a relocatable pack built for Fairbeam.
2. It unpacks the build to `runtime/openEMS`, with the binaries directly in that folder.
3. It installs `requirements.txt` (hashes required) and the build's `cp313` CSXCAD/openEMS wheels
   with `uv pip install --python runtime/venv/...`.
4. It copies `resources/python/fairbeam` to `runtime/app/fairbeam` and writes `fairbeam.pth` into
   the venv's site-packages.
5. It checks that `import CSXCAD, openEMS, fairbeam` works, with `OPENEMS_INSTALL_PATH=runtime/openEMS`
   set, and writes `runtime/manifest.json`.

`install.py --app-only` only refreshes `runtime/app` after an app update. Downloads stay cached in
`runtime/downloads`, so a failed install can be retried. A cached file whose hash no longer matches
is downloaded again. A re-run keeps what is already in place (uv, the CPython, a working venv, and
`runtime/openEMS` when its `.fairbeam-openems.json` names the same archive) and takes about a second.
`--repair` downloads and unpacks openEMS again and recreates the CPython and the venv.
`runtime/manifest.json` is removed when a full install starts and only written again after `verify`
has passed, so an interrupted install never looks usable.

**Progress protocol:** both stages print lines `FAIRBEAM-PROGRESS {"step", "fraction"?, "message"}` on
stdout. The steps are `download-uv`, `install-python`, `create-venv`, `download-openems`,
`unpack-openems`, `install-packages`, `install-openems-wheels`, `install-app`, `verify` and `done`.
Errors go to stderr (`Fairbeam runtime: error: ...`) with a non-zero exit code. The shell shows the
steps on the splash page and keeps the full output in `<app data>/logs/runtime-<time>.log`.
The JSON is ASCII (non-ASCII characters of a path as `\uXXXX`), numbers use a decimal point in
every locale, and every step ends with a line with `"fraction": 1`. On Windows the lines end with
CRLF.

### Windows notes

- Nothing outside the runtime root is changed: uv installs CPython with `--no-bin --no-registry`.
  Without those flags it adds `~\.local\bin\python3.13.exe` and a PEP 514 registry entry that
  `py -0p` lists. Inherited `UV_*`, `PYTHONPATH`, `PYTHONHOME` and `VIRTUAL_ENV` variables are
  ignored, so the user's own uv or Python setup cannot change the runtime.
- Stage 1 runs under Windows PowerShell 5.1 (`powershell.exe`, part of every Windows 10/11). It
  avoids the cmdlets that live in script modules (`Get-FileHash`, `Expand-Archive`), because they
  fail when `PSModulePath` is inherited from PowerShell 7. That happens when the app is started from
  a pwsh terminal. It starts stage 2 directly, so stage 2's output reaches the shell unchanged.
- Errors that were checked: no network or a dead proxy (`could not download <url>: ... Check the
  internet connection (or proxy) and retry.`), an unreachable host, uv failing to download CPython
  (uv's own cause lines follow), a SHA-256 mismatch of a download or of `-OpenemsArchive`, and files
  in use during `-Repair` (quit the app, then retry).
- Paths with spaces and non-ASCII characters (`...\tëst dir ş\runtime`) work for the runtime, the
  resources and the simulation folders (openEMS/HDF5 included). This was checked under the tr-TR
  locale.
- Size on disk after an install: about 540 MB (`openEMS` 149 MB, `cache` 107 MB, `venv` 105 MB,
  `downloads` 79 MB, `python` 60 MB, `uv` 40 MB). A fresh install takes 12 to 15 s on a fast
  connection; a re-run takes 1 s.
- A group policy that forces the execution policy (`MachinePolicy`/`UserPolicy` set to AllSigned)
  overrides `-ExecutionPolicy Bypass`. Stage 1 then does not start until the script is signed.

### macOS openEMS pack

There is no official openEMS binary for macOS, and none on PyPI or conda-forge.
`scripts/build-openems-macos-pack.py` turns a local source build (`scripts/install-openems-macos.sh`)
into a relocatable `openems-macos-arm64-<version>.tar.gz`. The pack contains the CSXCAD and openEMS
cp313 wheels, every non-system dylib they load (install names rewritten to `@loader_path` /
`@rpath`), `openems-pack.json`, the license texts and a `NOTICE.md`. The notice lists every
component with its version or commit, its license and where its corresponding source is.
Releases go to the public repository `ismailakdag/fairbeam-releases`, which holds release files
only; `pins.json` pins the URL and SHA-256. `setup-runtime.sh` refuses to install on a macOS older
than the pack's `macos_min`, which is the major version it was built on (27 for the pinned pack).

In practice the pack holds three wheels: CSXCAD, openEMS, and a libs wheel (`fairbeam_openems_libs`)
with 66 dylibs (CSXCAD, openEMS, nf2ff, fparser, tinyxml, HDF5, Boost, GMP/MPFR and the VTK subset).
Both packages load the dylibs from the libs wheel's folder in `site-packages` through
`@loader_path`, so there is a single `libCSXCAD`. The binaries are thinned to arm64 and ad-hoc signed. Because
Homebrew's libraries target the macOS they were built on, the wheels are tagged with that macOS
major version (`macosx_<N>_0_arm64`). Nothing is compiled.

To test a pack before it is published, point the macOS entry in a copy of `pins.json` at a
`file://` URL: `urllib` downloads it like any other URL.

## Shell

On start, the shell opens its window at 1440 × 900 points, centered, or maximized when that
does not fit the screen's work area (a laptop screen once the menu bar and Dock, or the taskbar,
are taken off). This is decided from the primary monitor before the window is created, and the
window is built maximized. On Windows the maximized state of a still-hidden window is lost (the
resize to the monitor's scale factor clears it), so the window is maximized once more right after
it is shown. Then it:

1. Reads `settings.json`: the runtime choice (`managed`, the default, or `external` with a Python
   path, for an existing openEMS install such as `~/opt/openEMS/venv`), the workspace folder, and
   the preference for the GPU build (`prefer_gpu`, on by default; the setup screen's "Prefer the
   GPU build" and General settings › "Start with the GPU build of openEMS", which applies at the
   next start). Settings written by earlier versions keep the value they have. General settings ›
   "Check for updates on start" is `check_updates_on_start` (on by default).
2. Unless a Python was chosen (`external`), a preferred GPU build at its default prefix,
   `~/opt/openEMS-gpu/venv/bin/python` (Windows: `C:\opt\openEMS-gpu\venv\Scripts\python.exe`,
   else the same path on the first other fixed drive that has it, such as `D:\opt\openEMS-gpu`), is
   used before the managed runtime when it lists the gpu engine and imports `fairbeam`. It has the
   CPU engine too, so the viewer offers both engines. A build without the gpu engine, or a broken
   one, falls through to the managed runtime. The drive lookup only checks that the file exists,
   and skips network, removable and optical drives.
3. For a managed runtime, checks `runtime/manifest.json`. The marker and platform must match, and
   the `fairbeam` package version must match the app, otherwise it runs `install.py --app-only`. When no
   runtime is chosen yet and the managed one is missing, it tries existing installs first:
   - with `prefer_gpu`, the GPU build found as in step 2, if it lists the gpu engine;
   - then, on macOS and Linux only, `~/opt/openEMS/venv/bin/python`.

   On Windows, setup and General settings also offer installation of the optional managed
   NVIDIA build in `<app data>/gpu-runtime`; its preparation leaves the current server and
   CPU runtime intact. See [GPU.md](GPU.md#one-app-installation-with-optional-managed-gpu-support).
   The external-build preference is offered when a supported GPU Python exists.
   When a chosen (`external`) Python's openEMS lists the gpu engine, General settings shows that
   Python's folder as the GPU build instead of the switch (the chosen Python comes first, so the
   switch would change nothing). A missing or broken
   runtime shows the setup screen: install, repair, or choose an existing Python. Stage 1 runs with
   its progress lines.
4. Seeds the workspace if needed, then starts:

   ```
   <python> -m fairbeam serve --port <free> --ui <res>/ui --projects <ws>/projects --models <ws>/models
            --jobs <ws>/jobs --sim-root <ws>/.sim --python <python> --exit-with-parent
   ```

   The environment has `OPENEMS_INSTALL_PATH=<runtime>/openEMS` (managed runtime) and
   `PYTHONIOENCODING=utf-8`. An external Python also gets `PYTHONPATH=<res>/python`. When it sits
   in an openEMS folder (`<prefix>\venv\Scripts\python.exe` next to `<prefix>\openEMS.exe`, the
   Windows CUDA install; [GPU.md](GPU.md)), it also gets `OPENEMS_INSTALL_PATH=<prefix>`. The server
   runs in its own process group (Windows: a job object, so it dies with the shell). On Windows it
   starts suspended, is put into the job, and only then resumes. Everything it starts is therefore
   in the job, including the real interpreter that the venv's `python.exe` launcher starts at once.
   A failed resume kills the process.
5. Shows the splash page while polling `/api/health`, then navigates the window to the server.
6. On quit, stops the server gracefully. It sends `POST /api/shutdown` with the per-start token it
   passed in `FAIRBEAM_SHUTDOWN_TOKEN`; the server cancels its runs and exits. No signal is
   involved: SIGINT can be ignored, and the Windows app has no console for CTRL_BREAK. After 8 s
   the shell forces the stop: SIGTERM and then SIGKILL to the process group on POSIX, the job
   object on Windows. The shell reads the whole answer before it closes the connection (to the
   end, at most 64 KiB within 3 s; the same for the health poll): closing with unread data makes
   the OS reset the connection. The server also starts its stop when writing the 202 answer fails.
   Before these fixes, about one quit in four on Windows waited for the 8 s grace period.
7. Checks for updates once the viewer is up (release builds; [RELEASES.md](RELEASES.md)), unless
   "Check for updates on start" is off in General settings. Help › Check for updates runs the same
   check on demand. General settings also has a manual check with a visible outcome; turning off
   the startup check does not disable manual checks.

Menus (`app_menu` in `src-tauri/src/main.rs`; the viewer answers each action through
`window.fairbeamMenuAction`, `src/lib/menuActions.ts`):

- **File**: New Design…, Import VBA macro…, Import PCB Artwork…, Open…, Open Recent (the last eight designs), Save
  (Cmd/Ctrl+S), Save As…, Export (VBA macro…, Python…, Touchstone of current result…, Package…),
  Close Design, then Close Window on macOS, or Settings… and Exit on Windows. On macOS Settings…
  (Cmd+,) is in the Fairbeam menu.
- **Edit**: Undo, Redo, Cut, Copy, Paste, Select All, Delete.
- **View**: Start, Design, Examples, Toggle tree / dock / properties, Minimize ribbon, the standard
  views (Isometric, Top, Front, Right, Bottom, Back, Left) and Zoom in / out / Reset zoom.
- **Window**: Minimize, Maximize, Full screen, Close Window.
- **Help**: Keyboard Shortcuts, About Fairbeam, Getting Started Guide, Report a Problem…, Check
  for updates.

External links: the viewer page has a loopback-only Tauri capability
(`src-tauri/capabilities/viewer.json`) for a fixed list of shell commands: showing and saving its
own downloads, the General settings values (updates, GPU build, opening the workspace folder),
opening one of a fixed set of links by key (the page never supplies a URL), the recent designs and
the usage statistics commands. The webview opens no new windows. For the "Send
feedback" links ([DESIGNER.md](DESIGNER.md#feedback)) `/api/health` reports `"desktop": true` (the
server was started with `FAIRBEAM_SHUTDOWN_TOKEN`), and the viewer asks the server to open the
link in the system browser (`POST /api/open-feedback`; only the issue forms of fairbeam-releases
are accepted).

The shell writes its own events to `<app data>/logs/shell.log`: one line per update check, with a
UTC timestamp (`update check: skipped (FAIRBEAM_NO_UPDATE_CHECK=1)`, `update check: up to date
(0.7.0)`, `update check: 0.7.1 offered (running 0.7.0)` followed by `update: Later` or `update:
Install and restart (0.7.1)`, `update: 0.7.1 installed, restarting`, `update: install failed: …`,
`update check: failed: …`, `update check: skipped (disabled in settings)`). The file is
append only; past 1 MB it moves to `shell.log.1`. `server.log` is the server's own output, and the
shell never writes into it.

For unattended checks, `FAIRBEAM_AUTO_INSTALL=1` presses "Install" on the setup screen, once per
process.

## Packaging

| | macOS | Windows |
|---|---|---|
| Bundle | `Fairbeam.app` in a `.dmg` | NSIS installer `.exe`, per-user, no admin |
| WebView | WKWebView (system) | WebView2 (bootstrapper included) |
| Build | `npm run desktop:build` on a Mac | `npm run desktop:build` on Windows (Rust MSVC toolchain) |
| Signing | Developer ID, notarized and stapled (a plain `npm run desktop:build` is only ad-hoc signed; [RELEASES.md](RELEASES.md)) | none: the installer is not code-signed (SmartScreen warns; More info › Run anyway) |

On Windows, `src-tauri/tauri.windows.conf.json` is merged over `tauri.conf.json` (JSON
merge patch: arrays are replaced). It sets the `nsis` target, the icons without `.icns`, WebView2
through the embedded bootstrapper (`embedBootstrapper`, silent; skipped when WebView2 is present,
as on every Windows 11), and an NSIS installer for the current user (`installMode: currentUser`,
installs to `%LOCALAPPDATA%\Fairbeam`, no UAC prompt) with lzma compression. It sets no signing
yet. The NSIS uninstaller removes the app; its "delete the application data" checkbox also removes
`%LOCALAPPDATA%\org.fairbeam.desktop` and `%APPDATA%\org.fairbeam.desktop` (settings, logs,
runtime, WebView2 data). The silent uninstall (`uninstall.exe /S`) leaves them. The workspace in
`Documents\Fairbeam` always stays. The uninstaller Tauri generates removes only the files of its
own version, so nothing may write into the install folder, and `src-tauri/windows/installer-hooks.nsh`
takes care of what older versions left: the viewer's bundles have hashed names, so each update used
to leave the previous `ui\assets` behind and the uninstall kept the folder.
- A marker in the install folder says what belongs to the app. `.fairbeam-resources` means that
  `ui`, `python`, `models`, `templates`, `projects` and `runtime` are the app's own. They are removed
  before an update copies the new ones, and removed on uninstall, after which the empty folder goes.
- The installer lets the user pick any folder and reuses it next time. A first install into a folder
  that already has one of those subfolders writes `.fairbeam-shared` instead: nothing there is ever
  removed as a whole.

An external Python runs with `PYTHONDONTWRITEBYTECODE=1`, so that nothing writes into the install
folder: it imports the bundled `python\fairbeam`. The bundle copies `python/fairbeam`,
`models` and `templates` as they are, so build from a tree without `__pycache__` folders.

Both platforms are built locally.
Releases are published to the public repository
[ismailakdag/fairbeam-releases](https://github.com/ismailakdag/fairbeam-releases), and the desktop
app's updater checks it (`src-tauri/src/updater.rs`). How a release is built, signed and published:
[RELEASES.md](RELEASES.md).

## Building and developing

```bash
npm run desktop:build      # release bundle in src-tauri/target/release/bundle/
npm run desktop            # development: Vite (port 5315) + the API (port 5325) in a native window
```

Building needs Rust (`rustup`). On macOS it also needs the Xcode command line tools; on Windows,
the MSVC build tools and WebView2. The first build compiles the Tauri crates. `CARGO_BUILD_JOBS=4`
keeps a laptop cool.

The logs are in `<app data>/logs/`: `server.log` (the server's output, new on every start),
`shell.log` (the shell's events, such as the update checks) and `runtime-<time>.log` (runtime
installs).

Without the desktop shell, `npm run app` (or `fairbeam app` after `npm run build`) serves the built
viewer and the API on a free port and opens the browser. `fairbeam serve --ui dist` does the same
on a fixed port.

## Importing from an earlier app

Fairbeam installs as a separate app with its own data. On its first start it offers to import what
you had in an earlier app. See the [migration guide](MIGRATING-FROM-ANTENLAB.md) for what moves over
and how to remove the old app by hand.
