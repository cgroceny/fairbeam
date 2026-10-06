# Migrating from antenlab

Fairbeam is the new name of antenlab. It is a separate app with its own identifier, settings, data
folders, runtime and update channel. It installs beside antenlab and never replaces it, and
antenlab does not update to it. The first time Fairbeam starts, it finds what antenlab left on the
computer and offers to import it. This page says what that does, what it leaves out, and how to do
the same or to remove antenlab by hand.

## What changed in the names

| | antenlab | Fairbeam |
|---|---|---|
| App | `antenlab.app`, `antenlab.exe` | `Fairbeam.app`, `fairbeam.exe` |
| Command and Python module | `antenlab` | `fairbeam` (`import fairbeam`) |
| Environment variables | `ANTENLAB_*` | `FAIRBEAM_*` (same ending, for example `FAIRBEAM_PYTHON`) |
| Settings and app data | `dev.antenlab.desktop` | `org.fairbeam.desktop` |
| Workspace | `Documents/antenlab` | `Documents/Fairbeam` |
| File formats | `antenlab.design/1`, `antenlab.project/1`, ... | `fairbeam.design/1`, `fairbeam.project/1`, ... |
| Releases | the `antenlab-releases` repository | [`fairbeam-releases`](https://github.com/ismailakdag/fairbeam-releases) |

## The import on the first start

The import asks once, in the language that antenlab was set to. It runs only when Fairbeam finds
something of antenlab and has not been used on this computer before. Choose **Import** to run it or
**Start fresh** to skip it.

If antenlab is open, Fairbeam asks you to quit it first (Try again or Later). Later asks again on the
next start. Fairbeam starts normally in the meantime and fills `Documents/Fairbeam` with its bundled
examples; the import still takes over your workspace the next time, because a folder that holds
nothing but those bundled copies (and empty folders) counts as empty.

What it imports:

- **Settings.** The language, the update check, the GPU choice and the list of recent designs. If
  you had pointed antenlab at your own Python (an external runtime), that choice is kept when the
  Python lives outside antenlab's own folders.
- **Your workspace.** If you used the default workspace, `Documents/antenlab` is renamed to
  `Documents/Fairbeam` on the same disk, so even large simulation folders move at once. The paths
  stored in the job records (`jobs/*/job.json`) are rewritten to the new folder, so re-runs and
  clean-up of old runs keep working. Where the rename cannot be done, Fairbeam keeps using the old
  folder and says so:
  - `Documents/Fairbeam` already has files of your own in it (anything other than the bundled
    examples, models and templates Fairbeam put there itself, such as a run in `jobs/`, a new
    design or an edited model);
  - a program holds files open (you are asked to close it and try again);
  - on macOS, the Documents permission prompt was refused.

  A workspace you had placed in a folder of your own stays where it is. A developer checkout of the
  source is never moved.
- **Your Python models.** In every `.py` file of the workspace, `import antenlab` becomes
  `import fairbeam` (also `from antenlab... import`, `antenlab.Simulation(` and the
  `ANTENLAB_ORGANIZATION` attribute of generated models). The originals are copied first; see
  "The backup" below. Names such as `antenlab_utils` and plain text in comments stay.
- **Appearance and viewer preferences, if antenlab 0.6.9 ran first.** antenlab keeps its theme and
  general settings in the app's web storage, which Fairbeam cannot read. The last antenlab release
  (0.6.9) saves them in a small file when it starts. If you started 0.6.9 once before installing
  Fairbeam, the theme, general settings, your own materials, favorites and sorting on the start
  screen, render options and the ribbon and panel sizes come over. Otherwise they are not imported,
  and Fairbeam starts with its defaults.

The `.design.json` files are not changed by the import. See "Old files still open" below.

What it does not import:

- **Unsaved drafts.** Save your designs in antenlab before you import.
- **GitHub sign-in** (and any other account). Sign in again in Fairbeam where that is offered.
- **The simulation runtime.** Fairbeam downloads and installs its own runtime again on its first
  start (the setup screen does it). That is on purpose: the two apps never share one.
- **The server port** and other settings that belong to the old installation.

When it finishes, a short summary says what was done. If a step failed, the summary names it, Fairbeam
starts anyway, and no removal is offered. The details are in `shell.log` (lines that start with
`import:`; paths and counts only, never file contents), and a full report is written next to the
settings file as `antenlab-import.json`. The settings antenlab had are also copied to `imported/` in
that folder. These folders are listed in [DESKTOP.md](DESKTOP.md#folders).

### The backup

Before the import changes a file, it copies the original to

```
<workspace>/.fairbeam-import-backup/<timestamp>/<path of the file inside the workspace>
```

The timestamp is UTC (`yyyymmdd-hhmmss`). The backup holds every Python model and job record that
was rewritten, with its original text. Nothing in it is used by the app, so you can delete the
folder when you are happy with the result. To undo a change, copy the file back over the new one.
Running the import again changes nothing that is already converted.

### Switches

- `FAIRBEAM_NO_IMPORT=1` turns the import off. Fairbeam then starts as if antenlab were not there,
  and nothing is moved, rewritten or offered.
- `FAIRBEAM_IMPORT_DRY_RUN=1` shows what the import would do and changes nothing of antenlab's or
  in your workspace. The plan goes to `shell.log` (`<app data>/logs/shell.log`, see
  [DESKTOP.md](DESKTOP.md#folders)). Fairbeam starts as usual, so it creates its own settings file
  and the bundled examples in `Documents/Fairbeam`; a first dry run marks that settings file
  (`legacy_import.state` is `dry-run`), so the next normal start still offers the import.

Set them in the environment of the program. On macOS, start it from a terminal:
`FAIRBEAM_IMPORT_DRY_RUN=1 /Applications/Fairbeam.app/Contents/MacOS/fairbeam`. On Windows, run
`$env:FAIRBEAM_IMPORT_DRY_RUN = 1` in PowerShell and start `fairbeam.exe` from the same window.

If you chose **Start fresh** and change your mind, nothing is lost: antenlab and its workspace are
still there. Rename or copy your workspace yourself (or choose it in Settings › General), and
change `import antenlab` to `import fairbeam` in your own models.

## Removing antenlab

After a successful import, Fairbeam asks whether to remove antenlab now. If you answer **Keep for
now**, or if you start fresh, you can do it later from **Help › Remove antenlab…**. The item is
visible while anything of antenlab is still on the computer. It is hidden when there is nothing
left to remove.

- **macOS:** antenlab is quit first. Then `antenlab.app` and antenlab's data folders go to the
  Trash, so you can put them back until you empty it. A copy of the app in another folder (for
  example in Downloads) is offered too. If the app cannot be moved (for example a standard user in
  /Applications), Fairbeam shows it in Finder so that you can drag it to the Trash yourself.
- **Windows:** antenlab's own uninstaller runs silently, and its data folders, registry entries and
  shortcuts are removed with it.

Your workspace and the backup folder are never touched. The removal does not delete the stored
sign-in tokens of antenlab (a Keychain item on macOS, a Credential Manager entry on Windows); the
steps below say how to delete them.

### Removing antenlab by hand

Quit antenlab first. Do not delete your workspace until you have checked that Fairbeam shows your
projects (the workspace is `Documents/Fairbeam` after an import, and still `Documents/antenlab`
if it was not moved).

**macOS.** Move these to the Trash. Items that do not exist can be skipped:

| Path | What it is |
|---|---|
| `/Applications/antenlab.app` (or `~/Applications/antenlab.app`) | the app |
| `~/Library/Application Support/dev.antenlab.desktop` | settings, the runtime and the logs (the runtime is the large part) |
| `~/Library/Caches/dev.antenlab.desktop` | caches |
| `~/Library/Logs/dev.antenlab.desktop` | logs |
| `~/Library/WebKit/dev.antenlab.desktop` | web storage (theme, drafts) |
| `~/Library/HTTPStorages/dev.antenlab.desktop` | network storage |
| `~/Library/Saved Application State/dev.antenlab.desktop.savedState` | window state |
| `~/Library/Preferences/dev.antenlab.desktop.plist` | preferences |

The sign-in tokens, if you used sign-in, are Keychain items named `dev.antenlab.desktop`. Open
Keychain Access, search for that name and delete the items.

**Windows.** Open Settings › Apps › Installed apps, choose antenlab and Uninstall, and tick
"Delete the application data". If anything is left, delete these folders (paste the path into
File Explorer's address bar):

| Path | What it is |
|---|---|
| `%LOCALAPPDATA%\antenlab` | the install folder (if you installed to another folder, that one) |
| `%APPDATA%\dev.antenlab.desktop` | settings |
| `%LOCALAPPDATA%\dev.antenlab.desktop` | the runtime, the logs and the web data (the runtime is the large part) |

The registry key `HKEY_CURRENT_USER\Software\antenlab` and the shortcut `antenlab.lnk` in the Start
menu or on the desktop can be deleted too. Neither does any harm if it stays. The sign-in tokens, if
you used sign-in, are entries named `dev.antenlab.desktop` in Credential Manager (Windows
Credentials); remove them there.

In both cases, the workspace folder is yours: keep it, or delete `Documents/antenlab` only if
Fairbeam has not been told to use it and you do not need what it holds.

## Old files still open

You do not have to convert anything.

- **Designs and projects.** A `.design.json` or project file that antenlab wrote (its schema
  starts with `antenlab.`) opens in Fairbeam as it is. The next save writes the Fairbeam id
  (`fairbeam.design/1`, `fairbeam.project/1`). Studies and optimization results are read the same
  way.
- **Result bundles** of old runs open and display as before.
- **CST-compatible VBA macro files** that antenlab exported still import. Macros that Fairbeam exports
  carry Fairbeam's own markers.
- **Python models and scripts** are the one exception: `import antenlab` does not work, because
  Fairbeam's package is `fairbeam` and there is no alias. The import rewrites the models in your
  workspace. Models elsewhere need the same one-word change, and scripts that call the `antenlab`
  command or set `ANTENLAB_*` variables must use `fairbeam` and `FAIRBEAM_*`.
- **Names reserved by the program.** A part of a design may not start with `antenlab_` or
  `fairbeam_`, because both prefixes were used for the program's own helper objects.
