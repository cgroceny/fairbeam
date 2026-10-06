# Desktop checklist (about 5 minutes)

What a browser cannot test. `npm run check:scenarios` covers the rest of the UI in Chrome, in English
and Turkish (see [DESIGNER.md](DESIGNER.md)); this list is for the packaged desktop app, on macOS
(WKWebView) and on Windows (WebView2). Run it before a release, on both platforms, with a fresh
build. Tick each line; write down anything that differs from what is described.

1. **Launch and window fit.** The window opens fully on screen (also on a small laptop screen and with
   the Dock or taskbar in the way), the splash page goes away, the Start screen shows "Server online"
   in the design's status bar within a few seconds.
2. **Native menus, English.** Every menu (File, Edit, View, Simulation, Help; on macOS also the Fairbeam
   menu) opens; New, Open, Save and Import entries act on the design that is open; the shortcuts shown
   next to the entries work (Cmd on macOS, Ctrl on Windows).
3. **Native menus, Turkish.** General settings › Language › Türkçe: the menu titles and entries turn
   Turkish at once, without a restart; switch back to English and they follow.
4. **Open and Save dialogs.** File › Open a result file… opens the system file dialog; choose a bundle
   `.json` and the results open. Export something (CSV from a result tab, Export package) and check
   the system save dialog: the suggested file name is right, the file lands where you chose, and
   "Show in folder" opens it.
5. **Import dialogs.** Start › Import VBA macro… and Import PCB artwork… choose files with the system
   dialog (`examples/cst/patch-antenna.bas`; `python/tests/fixtures/pcb/patch_top.gtl`), the report
   appears and the new design opens.
6. **Native color picker.** Right-click a solid › Color…: the color input opens the system picker
   (WKWebView and WebView2 draw different ones); picking a color recolors the solid live, Default
   resets it, Escape closes the popover.
7. **3D view.** The design shows in the 3D view (no black or blank canvas), orbit, pan and zoom follow
   the mouse and trackpad, Save screenshot writes a PNG through the system dialog.
8. **GPU engine choice.** On a machine with the GPU build of openEMS: General settings › "Start with
   the GPU build" is offered, the Run dialog lists both engines, and a run on the chosen engine
   finishes. Without one, only the CPU engine is offered and no GPU option appears.
9. **One run.** Open the empty design's patch starter, Run with the default settings: the dock shows
   progress, the run finishes, Post-processing › Summary shows a resonance, and closing the window
   while a run is going asks before stopping it.
10. **Updater.** Help › Check for updates: the dialog reports "up to date" or the newer version with
    its release notes; Later closes it, and the download starts only after you confirm.
11. **Help links.** Help › Documentation, Report a problem and Suggest a feature open the default
    browser at the right pages, not inside the app window; the About dialog shows the version, the
    openEMS version and the licenses.
12. **Close and reopen.** Close with unsaved changes: the app asks to save; quit; reopen: the same
    design is open again with its window size and position, and the run server has stopped (no stray
    `python` process in Activity Monitor or Task Manager).
