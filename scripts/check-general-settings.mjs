import assert from "node:assert/strict";
import { AUTO_THREADS, GENERAL_DEFAULTS, readGeneralSettings, THREADS_MIGRATED_KEY, writeGeneralSettings } from "../src/lib/generalSettings.ts";
import { applyFonts, APPEARANCE_DEFAULTS } from "../src/lib/appearance.ts";
import { errorText } from "../src/lib/errorText.ts";

class MemoryStorage {
  data = new Map();
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}
const store = new MemoryStorage();
assert.deepEqual(readGeneralSettings(store), GENERAL_DEFAULTS);
store.setItem("fairbeam.theme", "dark"); store.setItem("fairbeam.threads", "12"); store.setItem("fairbeam.mesh.mode", "auto");
assert.deepEqual(readGeneralSettings(store), { ...GENERAL_DEFAULTS, theme: "dark", threads: 12, meshMode: "auto" });
const changed = { ...GENERAL_DEFAULTS, theme: "light", engine: "gpu", threads: 3, meshMode: "auto", confirmShapes: false, units: "compact", language: "tr" };
writeGeneralSettings(changed, store);
assert.deepEqual(readGeneralSettings(store), changed);
assert.equal(store.getItem("fairbeam.designer.draw"), JSON.stringify({ confirm: false }));
store.setItem("fairbeam.generalSettings", JSON.stringify({ threads: -8, engine: "weird" }));
assert.deepEqual(readGeneralSettings(store), { ...GENERAL_DEFAULTS, theme: "light", engine: "gpu", threads: 3, meshMode: "auto", confirmShapes: false });
assert.throws(() => writeGeneralSettings({ ...GENERAL_DEFAULTS, threads: -1 }, store), /Invalid general settings/);
assert.throws(() => writeGeneralSettings({ ...GENERAL_DEFAULTS, language: "de" }, store), /Invalid general settings/);
// Auto is the default for new installs
assert.equal(GENERAL_DEFAULTS.threads, AUTO_THREADS);
assert.equal(readGeneralSettings(new MemoryStorage()).threads, AUTO_THREADS);
// the old untouched default (4, saved by any settings change) becomes Auto once; other numbers stay
const old = new MemoryStorage();
old.setItem("fairbeam.generalSettings", JSON.stringify({ ...GENERAL_DEFAULTS, threads: 4, theme: "dark" }));
old.setItem("fairbeam.threads", "4");
let migrated = readGeneralSettings(old);
assert.equal(migrated.threads, AUTO_THREADS); assert.equal(migrated.theme, "dark");
assert.equal(old.getItem(THREADS_MIGRATED_KEY), "1");
assert.equal(JSON.parse(old.getItem("fairbeam.generalSettings")).threads, AUTO_THREADS, "the stored value itself is migrated");
writeGeneralSettings({ ...migrated, threads: 4 }, old);  // choosing 4 again afterwards is a real choice
assert.equal(readGeneralSettings(old).threads, 4, "migration runs once");
const kept = new MemoryStorage();
kept.setItem("fairbeam.generalSettings", JSON.stringify({ ...GENERAL_DEFAULTS, threads: 6 }));
assert.equal(readGeneralSettings(kept).threads, 6, "a manual non-default choice is preserved");
const legacy = new MemoryStorage(); legacy.setItem("fairbeam.threads", "4");
assert.equal(readGeneralSettings(legacy).threads, AUTO_THREADS, "legacy key with the old default");
const auto = new MemoryStorage(); auto.setItem(THREADS_MIGRATED_KEY, "1");
writeGeneralSettings({ ...GENERAL_DEFAULTS }, auto);
assert.equal(readGeneralSettings(auto).threads, AUTO_THREADS, "Auto persists (0 is not treated as unset)");
assert.equal(await Promise.reject("workspace_not_writable").catch((reason) => errorText(reason)), "workspace_not_writable", "plain-string Tauri rejection codes stay readable");
assert.equal(errorText(new Error("could not open folder")), "could not open folder");
console.log("general settings persistence, validation and command error mapping passed");

// Existing installs get the exact Plex pair without rewriting other saved preferences.
const appearance = new MemoryStorage();
appearance.setItem(THREADS_MIGRATED_KEY, "1");
appearance.setItem("fairbeam.generalSettings", JSON.stringify({ theme: "dark", threads: 6, language: "tr" }));
assert.deepEqual(readGeneralSettings(appearance), { ...GENERAL_DEFAULTS, theme: "dark", threads: 6, language: "tr" });
const fonts = { ...readGeneralSettings(appearance), uiFont: "arial", monoFont: "consolas" };
writeGeneralSettings(fonts, appearance);
assert.deepEqual(readGeneralSettings(appearance), fonts, "font pair survives reload");
const overrides = new Map();
const root = { style: { setProperty: (key, value) => overrides.set(key, value), removeProperty: key => overrides.delete(key) } };
applyFonts(fonts, root);
assert.match(overrides.get("--al-font-sans"), /^Arial/);
assert.match(overrides.get("--al-font-mono"), /^Consolas/);
applyFonts(APPEARANCE_DEFAULTS, root);
assert.equal(overrides.size, 0, "default leaves the exact incumbent font tokens authoritative");
writeGeneralSettings({ ...fonts, ...APPEARANCE_DEFAULTS }, appearance);
assert.equal(readGeneralSettings(appearance).threads, 6, "appearance reset leaves solver settings intact");
assert.equal(readGeneralSettings(appearance).language, "tr", "appearance reset leaves language intact");
appearance.setItem("fairbeam.generalSettings", JSON.stringify({ ...fonts, uiFont: "missing-font", monoFont: 17 }));
assert.deepEqual(readGeneralSettings(appearance), { ...fonts, uiFont: "plex", monoFont: "plex" }, "invalid fonts recover independently");
assert.throws(() => writeGeneralSettings({ ...fonts, uiFont: "missing-font" }, appearance), /Invalid general settings/);
appearance.setItem("fairbeam.generalSettings", JSON.stringify({ ...fonts, theme: "invalid" }));
assert.equal(readGeneralSettings(appearance).language, "tr", "invalid appearance does not discard unrelated preferences");
console.log("appearance migration, fallback, independent font application and reset passed");

// The settings dialog has a tab row between its head and its body. The shared .dialog grid has one
// shrinkable track (head, body, foot), so the dialog declares its own rows: the tab row keeps its
// height and only the body scrolls (otherwise the tabs shrink under the body and cannot be clicked).
{
  const { readFileSync } = await import("node:fs");
  const tsx = readFileSync(new URL("../src/components/GeneralSettings.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles/general-settings.css", import.meta.url), "utf8");
  const dialog = tsx.match(/<div class="([^"]*\bdialog\b[^"]*)"[^>]*aria-labelledby="gs-title"/);
  assert.ok(dialog, "the settings dialog element is found");
  assert.match(dialog[1], /\bgs-dialog\b/, "the settings dialog carries the gs-dialog layout class");
  const rows = css.match(/\.gs-dialog\s*\{[^}]*grid-template-rows:\s*([^;]+);/);
  assert.ok(rows, ".gs-dialog declares its grid rows");
  assert.equal(rows[1].trim().split(/\s+(?![^(]*\))/).length, 3, "head, tab row and body each get a track");
  assert.match(rows[1], /^auto auto minmax\(0, 1fr\)$/, "only the body track shrinks");
  assert.match(css, /\.gs-dialog > \.gs-body\s*\{[^}]*min-height:\s*0/, "the body can shrink below its content and scroll");
  console.log("settings dialog layout: the tab row keeps its height and the body scrolls");
}
