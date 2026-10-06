# Releases and updates

Source stays in the public repository [ismailakdag/fairbeam](https://github.com/ismailakdag/fairbeam).
Release files go to a second public repository,
[ismailakdag/fairbeam-releases](https://github.com/ismailakdag/fairbeam-releases): the desktop
installers, the updater feed and the runtime components the app downloads, such as the macOS openEMS
pack. It holds release files and the issue tracker for app users, and no source.

## Updater

- The desktop app uses `tauri-plugin-updater`. After the viewer has loaded, it reads
  `https://github.com/ismailakdag/fairbeam-releases/releases/latest/download/latest.json` and, when
  a newer version exists, offers it in a native dialog (`src-tauri/src/updater.rs`). Installing stops
  the server and restarts the app. Debug builds and `FAIRBEAM_NO_UPDATE_CHECK=1` skip the check.
- The dialog appears only when there is an update; every check leaves a line in
  `<app data>/logs/shell.log` (skipped, up to date, offered and the answer, install failed, check
  failed with the error). See "Shell" in [DESKTOP.md](DESKTOP.md).
- Every updater artifact referenced by `latest.json` is signed with the Fairbeam updater key. The
  public key is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).
- The **private key** is `~/.tauri/fairbeam-updater.key` on the machine that builds the release.
  It was made once with `npx tauri signer generate -w ~/.tauri/fairbeam-updater.key`. It has no
  password, is outside the repository, and must never be committed, printed, logged or pasted
  anywhere. It goes only into the environment of the build shell. **Back it up**, for example in a
  password manager. Without it, the installed apps can no longer be updated.
- Windows installs updates in passive mode, with a small progress window and no questions.
- The dialog shows `latest.json`'s `notes`: a short plain-text summary (`publish-release.mjs
  --summary "..."`, else the notes' first paragraph without Markdown) and a link to the release page,
  which has the full notes. A native message box cannot scroll, so the app also strips Markdown and
  caps the text at 480 characters (`updater.rs` `dialog_notes`).

### Updates on macOS

- **Not in Applications:** macOS runs an app opened from Downloads or a disk image without moving
  it from a temporary, read-only copy (App Translocation). Such an app cannot replace itself.
  Before anything is downloaded, the app says so: "Move Fairbeam to Applications". The dialog
  names the user's own copy and offers Show in Finder.
- **Read-only volume:** a disk image or a read-only disk gets the same advice.
- **Another writable volume** (an external disk): `tauri-plugin-updater` moves the running app
  into the system temp folder, and that move fails across file systems ("Cross-device link (os
  error 18)"). The shell therefore installs the verified archive beside the app instead
  (`src-tauri/src/macos_update.rs`). It unpacks on the same volume and swaps the bundles
  atomically (`renamex_np` with `RENAME_SWAP`). It never deletes the only copy of the app.
- **After a failed install:** the startup check does not offer the same update again in that
  session.

## Publishing a version

Build only from a tag on `main` of the source repository (`git tag v<version>`), after the checks in
[CONTRIBUTING.md](../CONTRIBUTING.md) pass.

1. Bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and
   `python/fairbeam/_meta.py`. The runtime refreshes its copy of the Python package when the bundled
   version changes.
2. Build each platform on its own machine with `npm run desktop:release` and the key in the
   environment. The release build adds `src-tauri/tauri.release.conf.json`
   (`createUpdaterArtifacts`), so it writes the updater artifact and its `.sig` next to the
   installer. `npm run desktop:build` stays a plain build that needs no key:

   ```bash
   # macOS (arm64)
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/fairbeam-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
   npm run desktop:release
   #   -> bundle/macos/Fairbeam.app.tar.gz (+ .sig)   updater artifact
   #   -> bundle/dmg/Fairbeam_<v>_aarch64.dmg         manual download
   ```

   ```powershell
   # Windows (x64): the same key file, copied securely to %USERPROFILE%\.tauri\fairbeam-updater.key
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$env:USERPROFILE\.tauri\fairbeam-updater.key"
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
   npm run desktop:release
   #   -> bundle/nsis/Fairbeam_<v>_x64-setup.exe (+ .sig)   installer and updater artifact
   ```

   On macOS the release is also signed with a Developer ID and notarized. The build reads the
   identity and an App Store Connect API key from the environment, never from the repository:

   ```bash
   export APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<team id>)"   # in the keychain
   export APPLE_API_KEY=<key id> APPLE_API_ISSUER=<issuer id>
   export APPLE_API_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_<key id>.p8  # chmod 600
   npm run desktop:release   # signs, notarizes and staples the .app
   xcrun notarytool submit bundle/dmg/Fairbeam_<v>_aarch64.dmg --key "$APPLE_API_KEY_PATH" \
     --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
   xcrun stapler staple bundle/dmg/Fairbeam_<v>_aarch64.dmg
   spctl --assess --type execute -v bundle/macos/Fairbeam.app   # "source=Notarized Developer ID"
   ```

   Without the key, `desktop:release` stops once it has built the bundle. Everything is built,
   but no updater artifact is written. You can sign a file afterwards with
   `npx tauri signer sign -f ~/.tauri/fairbeam-updater.key -p "" <file>`.
3. Publish from each machine. The script creates or updates the `v<version>` release in
   `ismailakdag/fairbeam-releases`, uploads the files, and merges `latest.json` and
   `SHA256SUMS.txt`. Entries of platforms already published are kept. Publish with
   `--latest=false` first:

   ```bash
   node scripts/publish-release.mjs --version <version> --notes-file notes.md --latest=false \
     --asset darwin-aarch64=src-tauri/target/release/bundle/macos/Fairbeam.app.tar.gz \
     --file "src-tauri/target/release/bundle/dmg/Fairbeam_<version>_aarch64.dmg=fairbeam_<version>_macos-arm64.dmg"
   node scripts/publish-release.mjs --version <version> --latest=false \
     --asset windows-x86_64=src-tauri/target/release/bundle/nsis/Fairbeam_<version>_x64-setup.exe
   ```

   `--dry-run` shows what would be uploaded. The published files are named `fairbeam_<v>_...`.
   The updater looks at the release that is marked as the latest one. With `--latest=false` the
   release is created without that mark, so no installed app is offered it yet. Check the real
   assets first: download the DMG and the installer, open them, and check the update feed
   (`latest.json`, its signatures and `SHA256SUMS.txt`). Then mark the release:

   ```bash
   gh release edit v<version> -R ismailakdag/fairbeam-releases --latest
   ```

   The mark is a property of the release, so a later publish to the same version leaves it as it
   is. Never mark an older release as the latest again: the updater does not downgrade.
4. Update the download links on the website (`landing/index.html`, section `#download`: file
   names, sizes and minimum OS versions) and push. Vercel deploys the site from `main`.

## Issues and feedback

The public repository's issue tracker takes the reports of app users. The app's **Send feedback**
links open its issue forms; "Report a problem" fills in the version and the OS through query
parameters named by the form's field ids (`version`, `os`). The forms are kept here in
`release-repo/.github/ISSUE_TEMPLATE/` (`bug.yml`, `feature.yml`, and `config.yml` without blank
issues); copy that folder to the public repository's `.github/ISSUE_TEMPLATE/`. Keep the ids when
editing them, or the prefill stops working.

## Runtime components

- **Windows openEMS:** the official MSVC build. It is pinned by URL and SHA-256 in
  `runtime/pins.json`, and nothing of it is republished.
- **macOS openEMS pack:** built with `scripts/build-openems-macos-pack.py` (docs/DESKTOP.md), then
  released under its own tag. The pack contains its license texts and `NOTICE.md`, and the NOTICE is
  also a separate asset. Create it with `--latest=false` so that it never becomes the latest
  release, which is where the updater feed lives:

  ```bash
  gh release create openems-macos-arm64-<version> <pack>.tar.gz NOTICE.md \
    -R ismailakdag/fairbeam-releases --latest=false --title "openEMS pack for macOS arm64 (...)" --notes-file notes.md
  ```

  Then pin its URL, SHA-256, size and `macos_min` in `runtime/pins.json`.

  The pack ships the native CPU patches ([CPU-OPTIMIZATION.md](CPU-OPTIMIZATION.md#macos-shipped-and-on-by-default)):
  `scripts/install-openems-macos.sh` applies them to openEMS `12cd91de2` (`NATIVE_CPU=0` skips them),
  the pack script records them in `openems-pack.json` and `NOTICE.md` and names the pack
  `...-ncpu1`. Check before publishing that the build printed `native CPU patches: yes`.

## Licensing of what is published

- openEMS is GPL-3.0-or-later; CSXCAD and fparser are LGPL-3.0-or-later. The macOS pack ships
  their license texts and a NOTICE that points to the exact source commits, together with a written
  offer of the complete corresponding source.
- Fairbeam declares GPL-3.0-or-later (`python/pyproject.toml`, `src-tauri/Cargo.toml`) and loads
  openEMS in the same process. Distributing the app therefore means offering Fairbeam's
  corresponding source to its recipients. The source of every version is the tag `v<version>` of the
  public source repository, and [NOTICE.md](../NOTICE.md) carries the written offer, which goes
  through the issues of the release repository. Tag the source before you publish its release.

## Changelog

One entry per release, newest first. The installers are on the
[release page](https://github.com/ismailakdag/fairbeam-releases/releases) of each version.

### 0.7.0 — first release of Fairbeam, 2026-10-06

Fairbeam is a desktop app for macOS (Apple silicon) and Windows x64 that designs, simulates and
documents antennas on the open-source openEMS FDTD solver. It installs its own runtime on first
start and needs no admin rights.

- **Designer.** A ribbon-based 3D designer: parametric solids and sheets, Boolean operations,
  ports and lumped elements, materials and an automatic mesh, with checks that explain what to fix.
  English and Turkish interface.
- **Simulation.** Runs on the CPU or, when the GPU runtime is installed, on the GPU
  engine. Parameter sweeps, an optimizer, mesh convergence studies, multi-port structures and
  arrays, and dispersive materials.
- **Results.** S-parameters, impedance, matched bands, far field (directivity, gain, realized gain,
  efficiency), E and H field planes, summary tables and run comparison overlays.
- **Python models.** Models written as small Python files, run from the app or with the `fairbeam`
  command. The run server and the Run panel start from the same files.
- **Files and export.** Self-describing project bundles, Touchstone, CSV, STL, glTF, Blender
  scenes and rendered images, Gerber and Excellon fabrication output, and PCB artwork import.
- **Coming from the previous app.** Fairbeam is a separate app. On its first start it can import your
  settings, workspace and Python models and then help remove the old app; files the old app wrote
  still open ([MIGRATING-FROM-ANTENLAB.md](MIGRATING-FROM-ANTENLAB.md)).
- **Updates.** The app checks for new versions on start and installs them in place; the download,
  install and restart steps show their progress.
- Optional sign-in ([ACCOUNTS.md](ACCOUNTS.md)) and anonymous usage counts
  ([TELEMETRY.md](TELEMETRY.md)) are built but switched off in this release.
