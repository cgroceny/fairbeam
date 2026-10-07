// Design file names (src/lib/designId.ts) and Save As: the id rules, a bundled example's id (the
// server refuses it, python/fairbeam/modelfiles.py BUNDLED) picked free up front with a suffix, and
// the Save As entry points (desktop menu, Home ribbon, header ⋯ menu, Shift+Ctrl+S).
//
//   node --experimental-strip-types scripts/check-save-as.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BUNDLED_EXAMPLE_IDS, designFileHint, designIdError, freeDesignId, isReservedDesignId, suggestDesignId } from "../src/lib/designId.ts";
import { matchesShortcut, shortcutTable } from "../src/designer/shortcuts.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

assert.equal(suggestDesignId("  Déjà Vu Copy!"), "deja_vu_copy");
assert.equal(designIdError("x", []), "use at least two letters or digits, starting with a letter");
assert.equal(designIdError("con", []), "a name Windows reserves for devices; add a word");
assert.equal(designIdError("antenna_copy", ["antenna_copy"]), "a model with this name exists");
assert.equal(designIdError("antenna_copy", []), "");
assert.equal(designIdError("patch_antenna", []), "the name of a bundled example; add a word");

// the mirror of modelfiles.BUNDLED: the same ids (python/tests/test_modelfiles.py compares them too)
const python = await read("python/fairbeam/modelfiles.py");
const pySet = (name) => new Set([...python.match(new RegExp(`${name} = frozenset\\(\\{([^}]*)\\}\\)`))[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]));
assert.deepEqual(new Set(BUNDLED_EXAMPLE_IDS), new Set([...pySet("BUNDLED_MODELS"), ...pySet("BUNDLED_DESIGNS")]), "BUNDLED_EXAMPLE_IDS mirrors modelfiles.BUNDLED");
for (const id of ["patch_antenna", "yagi_867", "con"]) assert.ok(isReservedDesignId(id), `${id} is reserved`);
assert.ok(!isReservedDesignId("patch_antenna_2"));

// Start › Patch antenna starter named "Patch antenna": a free id up front, said under the field
assert.deepEqual(freeDesignId("Patch antenna", []), { id: "patch_antenna_2", reserved: "patch_antenna" });
assert.deepEqual(freeDesignId("Patch antenna", ["patch_antenna_2"]), { id: "patch_antenna_3", reserved: "patch_antenna" });
assert.deepEqual(freeDesignId("UAV yagi 867", []), { id: "uav_yagi_867", reserved: null });
assert.deepEqual(freeDesignId("Yagi 867", []), { id: "yagi_867_2", reserved: "yagi_867" });
assert.deepEqual(freeDesignId("My patch", ["my_patch"]), { id: "my_patch", reserved: null }, "an id in use is left to designIdError");
assert.deepEqual(freeDesignId("con", []), { id: "con", reserved: null }, "a device name keeps its own message");
assert.equal(designFileHint("Patch antenna", []), "File: patch_antenna_2.design.json (patch_antenna is a bundled example's name)");
assert.equal(designFileHint("My patch", []), "File: my_patch.design.json");
assert.equal(freeDesignId("x".repeat(60), []).id.length, 41);

const app = await read("src/App.tsx");
const dialog = await read("src/designer/SaveAsDialog.tsx");
const home = await read("src/home/Home.tsx");
const header = await read("src/components/Header.tsx");
const ribbon = await read("src/designer/DesignWorkspace.tsx");
const newModel = await read("src/editor/NewModelDialog.tsx");
const copy = await read("src/runner/ExampleCopyDialog.tsx");
assert.ok(app.includes('"file-save-as": () => { if (appMode() === "design" && designFile()) openSaveAs(); }'), "the desktop menu opens Save As");
assert.ok(app.includes('"file-save-as": canSaveAs()') && app.includes("<Show when={saveAsOpen() && canSaveAs()}>"), "one host and one availability rule");
assert.ok(!app.includes("window.prompt") && !dialog.includes("window.prompt"));
assert.ok(home.includes("freeDesignId(name(), modelKeys()).id") && home.includes("designFileHint(name(), modelKeys())") && home.includes("designIdError"),
  "Start picks a free id and names the file under the field");
assert.ok(dialog.includes("freeDesignId(name(), keys()).id") && dialog.includes("designFileHint(name(), keys())"), "Save As picks a free id too");
assert.ok(dialog.includes("useModal(() => box, close, () => nameInput)"));
assert.ok(dialog.includes("if (dirty() && !(await saveBeforeLeaving()))"));
assert.ok(dialog.includes('createDesign({ id: id(), name: name().trim(), from: props.source.id })'));
assert.ok(dialog.includes('<form class="dialog-body nm-body" onSubmit={submit}>') && dialog.includes('type="submit"'), "Enter saves (form submit)");
assert.ok(/export const canSaveAs = \(\) => appMode\(\) === "design" && !!file\(\);/.test(dialog));
// the web UI's entry points
assert.ok(/<RButton icon=\{SaveAll\} label=\{t\("ribbon\.home\.saveAs"\)\}[^\n]*onClick=\{openSaveAs\}/.test(ribbon), "Home ribbon › Project has Save as…");
assert.ok(ribbon.includes('if (matchesShortcut("saveAs", e)) { e.preventDefault();') && ribbon.indexOf('matchesShortcut("saveAs", e)') < ribbon.indexOf("const inField ="),
  "Shift+Ctrl+S opens Save As from a field too, like Save");
assert.ok(/disabled=\{!canSaveAs\(\)\}[\s\S]{0,200}onClick=\{\(\) => runMoreAction\(openSaveAs\)\}/.test(header) && header.includes('t("header.saveAs.label")'), "the header ⋯ menu has Save as…");
for (const mac of [true, false]) {
  const s = (k, mods) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  const mod = mac ? { metaKey: true } : { ctrlKey: true };
  assert.equal(matchesShortcut("saveAs", s("S", { ...mod, shiftKey: true }), mac), true);
  assert.equal(matchesShortcut("saveAs", s("s", mod), mac), false, "Ctrl+S stays Save");
  assert.equal(matchesShortcut("save", s("S", { ...mod, shiftKey: true }), mac), false, "Shift+Ctrl+S is not Save");
}
assert.equal(shortcutTable(false).saveAs.key, "Shift+Ctrl+S");
assert.equal(shortcutTable(true).saveAs.key, "⇧⌘S");
// the other dialogs that name a new file refuse the bundled ids as well
assert.ok(newModel.includes('if (bundledIds.has(v)) return t("designId.bundled");') && newModel.includes("freeDesignId(e.currentTarget.value"), "New model");
assert.ok(copy.includes("keys.has(candidate) || isReservedDesignId(candidate)") && copy.includes("isReservedDesignId(base)"), "Open as new design");
console.log("Save As and design id checks passed: reserved ids picked free up front, the TS mirror of BUNDLED, the ribbon, menu and keyboard entry points.");
