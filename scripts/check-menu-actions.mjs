import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMenuActionRouter, isMenuActionId, MENU_ACTION_IDS } from "../src/lib/menuActions.ts";

const expected = ["file-new","file-import-cst","file-import-pcb","file-open","file-save","file-save-as","export-cst","export-python","export-touchstone","export-package","file-close","settings","edit-undo","edit-redo","edit-delete","view-start","view-design","view-examples","view-tree","view-dock","view-properties","view-ribbon","view-iso","view-top","view-front","view-right","view-bottom","view-back","view-left","view-zoom-in","view-zoom-out","view-zoom-reset","help-shortcuts","about"];
assert.deepEqual([...MENU_ACTION_IDS], expected, "exact native menu action allowlist");
assert.equal(isMenuActionId("file-open-recent:patch_antenna"), true);
assert.equal(isMenuActionId("file-open-recent:models%2Fpatch.json"), false);
assert.equal(isMenuActionId("file-open-recent:%ZZ"), false);
assert.equal(isMenuActionId("file-save:evil"), false);
let invoked = 0, opened = "", reported = "", editAction = "";
const route = createMenuActionRouter({ "file-save": () => invoked++, "edit-undo": () => editAction = "edit-undo", "edit-redo": () => editAction = "edit-redo", "file-open-recent:": (id) => { opened = decodeURIComponent(id.slice("file-open-recent:".length)); } }, (m) => reported = m);
assert.equal(route(JSON.stringify("file-save")), true); assert.equal(invoked, 1);
assert.equal(route("file-save"), true); assert.equal(invoked, 2);
assert.equal(route("edit-undo"), true); assert.equal(editAction, "edit-undo");
assert.equal(route(JSON.stringify("edit-redo")), true); assert.equal(editAction, "edit-redo");
assert.equal(route(JSON.stringify("file-open-recent:patch_antenna")), true); assert.equal(opened, "patch_antenna");
assert.equal(route(JSON.stringify("not-allowed")), false); assert.match(reported, /not available/);
assert.equal(route("not json"), false);
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
// the menu texts, in English and Turkish (the viewer's language, src-tauri/src/i18n.rs)
const shellText = readFileSync(new URL("../src-tauri/src/i18n.rs", import.meta.url), "utf8");
const closeHost = readFileSync(new URL("../src/designer/CloseProject.tsx", import.meta.url), "utf8");
for (const id of MENU_ACTION_IDS) assert.ok(shell.includes(`"${id}"`), `native menu entry ${id}`);
assert.match(shell, /file-open-recent:\{id\}/);
assert.match(shell, /remember_recent_design/);
assert.match(app, /fairbeamMenuAction\s*=\s*menuAction/);
assert.match(app, /"edit-undo": \(\) => editHistory\("undo"\)/);
assert.match(app, /"edit-redo": \(\) => editHistory\("redo"\)/);
assert.match(app, /if \(action === "undo"\) undoDesign\(\); else redoDesign\(\)/);
const nativeAvailability = shell.match(/const CONTEXTUAL_MENU_IDS: &\[&str\] = &\[([\s\S]*?)\];/);
assert.ok(nativeAvailability, "native contextual menu IDs are an explicit allowlist");
const nativeAvailabilityIds = [...nativeAvailability[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
const appAvailability = app.match(/const availability: Record<string, boolean> = \{([\s\S]*?)\n    \};/);
assert.ok(appAvailability, "the viewer sends a complete native menu availability snapshot");
const appAvailabilityIds = [...appAvailability[1].matchAll(/^\s*"([a-z-]+)":/gm)].map((m) => m[1]);
assert.deepEqual([...appAvailabilityIds].sort(), [...nativeAvailabilityIds].sort(), "viewer availability keys match the native allowlist");
assert.ok(nativeAvailabilityIds.every((id) => MENU_ACTION_IDS.includes(id)), "contextual native IDs remain in the stable menu action allowlist");
assert.match(app, /const hasViewport = !!currentBundle && viewportPresent\(\) && \(mode === "design" \|\| mode === "results"\)/, "camera and zoom actions require a loaded viewport in Design or Results");
assert.match(shell, /fn sync_native_menu_availability\([\s\S]*?availability: HashMap<String, bool>/, "native availability accepts typed booleans");
assert.match(shell, /MenuItem::with_id\(handle, id, label, action_enabled\(handle, id\), None::<&str>\)/, "native menu rebuilds use the stored enabled state");
assert.match(app, /native\.invoke\("sync_native_menu_availability", \{ availability \}\)/, "the viewer synchronizes contextual menu state");
// ⌘Z on a dialog button is not prevented by the page: the menu must not undo the design behind it
assert.match(app, /document\.querySelector\("\.scrim, dialog\[open\]"\)\) return;\s*if \(action === "undo"\) undoDesign/);
assert.match(app, /document\.execCommand\(action\)/);
assert.match(app, /removeEventListener\("fairbeam:menu-action"/);
assert.match(shell, /"close-window"[\s\S]*?Some\("CmdOrCtrl\+W"\)/);
assert.doesNotMatch(closeHost.slice(closeHost.indexOf("export default function CloseProjectHost")), /addEventListener\("keydown"/, "native menu owns Ctrl+W");
// The webview sees designer keydown first; its preventDefault avoids a duplicate menu undo.
// Menu accelerators also keep macOS text-field keyboard equivalents active.
assert.match(shell, /MenuItem::with_id\(handle, "edit-undo", tx\("undo"\), true, Some\("CmdOrCtrl\+Z"\)\)/);
assert.match(shell, /MenuItem::with_id\(\s*handle,\s*"edit-redo",\s*tx\("redo"\),\s*true,\s*Some\("CmdOrCtrl\+Shift\+Z"\),?\s*\)/);
assert.match(shellText, /\("undo", "Undo", "Geri [Aa]l"\)/i);
assert.match(shellText, /\("redo", "Redo", "Yinele"\)/i);
assert.doesNotMatch(shell, /PredefinedMenuItem::(?:undo|redo)\(handle/, "no competing native Undo/Redo menu accelerators");
for (const item of ["cut", "copy", "paste", "select_all"]) assert.match(shell, new RegExp(`PredefinedMenuItem::${item}\\(handle`), `predefined Edit > ${item}`);
const keys = readFileSync(new URL("../src/designer/DesignWorkspace.tsx", import.meta.url), "utf8");
assert.match(keys, /matchesShortcut\("undo", e\) \|\| matchesShortcut\("redo", e\)\) \{ e\.preventDefault\(\);[\s\S]*?undo\(\)/, "keyboard designer undo prevents native duplicate");
// macOS app menu: Settings… ⌘, and our Quit (asks the viewer) replace the predefined ones
assert.match(shell, /MenuItem::with_id\(\s*handle,\s*"settings",\s*tx\("settings"\),\s*true,\s*Some\("CmdOrCtrl\+,"\),?\s*\)/);
assert.match(shellText, /\("settings", "Settings…", "Ayarlar…"\)/i);
assert.match(shell, /"quit",[\s\S]*?Some\("CmdOrCtrl\+Q"\)/);
// external links: the page names a key, the URL comes from the shell's own table
assert.match(shell, /fn open_external_link\(link: String\)/);
assert.doesNotMatch(shell, /fn open_external_link\(url/);
const about = readFileSync(new URL("../src/components/AboutDialog.tsx", import.meta.url), "utf8");
assert.doesNotMatch(about, /invoke\("open_external_link", \{ url/);
assert.doesNotMatch(about, /@[a-z0-9-]+\.[a-z]/i, "no e-mail address in About");
// Help › Getting Started Guide and Report a Problem…, and About, open only fixed public places: the
// website's guide, the fairbeam-releases repository (installers, issue forms) and the source repository
assert.match(shell, /\("help-docs", tx\("help-docs"\)\)/);
assert.match(shell, /\("help-issues", tx\("help-issues"\)\)/);
assert.match(shellText, /\("help-docs", "Getting Started Guide", "Başlangıç Kılavuzu"\)/i);
assert.match(shellText, /\("help-issues", "Report a Problem…", "Sorun Bildir…"\)/i);
// the menus follow the viewer's language: set_language saves it and rebuilds them
assert.match(shell, /fn set_language\(app: AppHandle, lang: String\)[\s\S]*?app\.set_menu\(app_menu\(&app\)/);
assert.match(shell, /"docs" => "https:\/\/fairbeam\.org\/guide\.html"/);
assert.match(shell, /"issues" => "https:\/\/github\.com\/ismailakdag\/fairbeam-releases\/issues\/new\/choose"/);
assert.match(shell, /"source" => "https:\/\/github\.com\/ismailakdag\/fairbeam",/);
assert.match(about, /link\("source", t\("about\.sourceLink"\)\)/, "About links the public source repository");
assert.match(about, /link\("docs", t\("about\.guide"\)\)/, "About links the getting-started guide");
// About names no trademark holder (NOTICE.md carries the notice)
assert.doesNotMatch(about, /about\.(formerly|trademark)/);
console.log("menu action allowlist, dispatch, rejection, recent-file decoding and lifecycle: ok");
