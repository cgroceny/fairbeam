// "Import PCB artwork…": the dialog is registered at every entry point that opens the CST import (Start page, Home
// ribbon, File menu, the desktop shell's native menu), its limits and options agree with the server
// (python/fairbeam/server.py, pcb_import.py), and the layer-role logic (src/lib/pcbLayers.ts) does what the dialog
// relies on. Run: node --experimental-strip-types scripts/check-pcb-import.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  admitFiles, buildOptions, designNameFromFiles, fieldValue, guessedRoles, isChosen, layerKey, noteKey, PCB_DEFAULTS, PCB_LIMITS, PCB_RANGES,
  PCB_ROLES, pruneMap, reasonKey, roleChoices, roleValue, toBase64, withoutRole, withRole,
} from "../src/lib/pcbLayers.ts";
import { MENU_ACTION_IDS } from "../src/lib/menuActions.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const app = read("src/App.tsx"), home = read("src/home/Home.tsx"), ribbon = read("src/designer/DesignWorkspace.tsx");
const dialog = read("src/components/PcbImportDialog.tsx");
const server = read("python/fairbeam/server.py"), importer = read("python/fairbeam/pcb_import.py");
const en = JSON.parse(read("src/i18n/en.json")), tr = JSON.parse(read("src/i18n/tr.json"));

// ---- registration
assert.match(read("src/lib/pcbImport.ts"), /export const \[pcbImportOpen, setPcbImportOpen\] = createSignal\(false\)/);
assert.match(app, /const PcbImportDialog = lazy\(\(\) => import\("\.\/components\/PcbImportDialog"\)\)/, "the dialog is loaded on first use");
assert.match(app, /<Show when=\{!DEMO && pcbImportOpen\(\)\}><PcbImportDialog \/><\/Show>/, "the dialog is mounted");
assert.match(app, /"file-import-pcb": \(\) => \{ if \(DEMO\) notice\(t\("app\.notice\.pcbImportDesktop"\)\); else setPcbImportOpen\(true\); \}/, "File menu action");
assert.ok(MENU_ACTION_IDS.includes("file-import-pcb"), "the menu action is on the allowlist");
assert.equal(MENU_ACTION_IDS.indexOf("file-import-pcb"), MENU_ACTION_IDS.indexOf("file-import-cst") + 1, "next to the CST import");
assert.match(home, /onClick=\{\(\) => setPcbImportOpen\(true\)\}/, "Start page button");
assert.match(home, /t\("home\.importPcb\.button"\)/);
assert.match(ribbon, /onClick=\{\(\) => setPcbImportOpen\(true\)\}/, "Home ribbon > Project button");
assert.match(ribbon, /t\("ribbon\.home\.importPcb"\)/);
const shell = read("src-tauri/src/main.rs"), shellText = read("src-tauri/src/i18n.rs");
assert.match(shell, /action_item\(handle, "file-import-pcb", &tx\("file-import-pcb"\)\)\?/, "native File menu entry");
assert.ok(shell.indexOf('"file-import-pcb"') > shell.indexOf('"file-import-cst"') && shell.indexOf('"file-import-pcb"') < shell.indexOf('"file-open"'), "native entry follows the CST import");
assert.match(shellText, /\("file-import-pcb", "Import PCB artwork…", "PCB çizimini içe aktar…"\)/, "native menu text, sentence case in en and tr");
for (const key of ["app.notice.pcbImportDesktop", "home.importPcb.button", "home.importPcb.note", "home.importPcb.title", "ribbon.home.importPcb", "ribbon.home.importPcbTitle"]) {
  assert.ok(key in en && key in tr, `${key} in both languages`);
}
// every visible string of the dialog goes through t(): no JSX text of its own
let jsx = dialog.slice(dialog.indexOf('    <div class="scrim"'));
for (let before = ""; before !== jsx;) { before = jsx; jsx = jsx.replace(/\{[^{}]*\}/g, ""); }   // expressions, innermost first
const jsxText = jsx.replace(/<[^<>]*>/g, "\n").split("\n").map((s) => s.trim()).filter((s) => /[A-Za-zÇĞİÖŞÜçğıöşü]{2}/.test(s) && !/^(mm|GHz)$/.test(s));   // units stay as they are
assert.deepEqual(jsxText, [], "no untranslated text in the dialog's markup");
assert.doesNotMatch(dialog, /type="number"/, "number entries are NumberField");
assert.match(dialog, /<NumberField /);
assert.match(dialog, /e\.stopPropagation\(\);[\s\S]{0,200}carriesFiles/, "a drop on the dialog is not the app's project drop");

// ---- the limits and options are the server's
const num = (name) => Number(new RegExp(`^${name} = ([\\d_]+)`, "m").exec(server)?.[1].replaceAll("_", ""));
assert.deepEqual(PCB_LIMITS, { files: num("MAX_PCB_FILES"), file: num("MAX_PCB_FILE"), total: num("MAX_PCB_TOTAL") }, "limits agree with server.py");
for (const [field, [lo, hi, open]] of Object.entries(PCB_RANGES)) {
  const key = { epsR: "eps_r", tanD: "tan_d", chordTol: "chord_tol" }[field] ?? field;
  const lit = (v) => (v === 1e-4 ? "1e-4" : String(v));   // the literal as server.py writes it
  const py = new RegExp(`\\("${key}", ${lit(lo)}, ${lit(hi)}, ${open ? "True" : "False"},`);
  assert.match(server, py, `range of ${key} agrees with server.py`);
}
assert.deepEqual([...PCB_ROLES], [...importer.match(/^ROLES = \(([^)]*)\)/m)[1].matchAll(/"(\w+)"/g)].map((m) => m[1]), "roles agree with pcb_import.py ROLES");
const sig = importer.slice(importer.indexOf("def import_pcb("), importer.indexOf("):\n", importer.indexOf("def import_pcb(")));
const dflt = (name) => sig.match(new RegExp(`${name}(?::[^=,]+)? = ([\\w."]+)`))?.[1].replaceAll('"', "");
assert.equal(Number(dflt("thickness")), Number(PCB_DEFAULTS.thickness), "default thickness");
assert.equal(Number(dflt("chord_tol")), Number(PCB_DEFAULTS.chordTol), "default chord tolerance");
assert.equal(Number(dflt("margin")), Number(PCB_DEFAULTS.margin), "default margin");
assert.equal(Number(dflt("f0")), Number(PCB_DEFAULTS.f0), "default f0");
assert.equal(dflt("origin"), PCB_DEFAULTS.origin);
assert.equal(dflt("units"), PCB_DEFAULTS.units);

// ---- every reason the importer gives has a text
for (const why of ["layer name", "Gerber file function", "Excellon file", "the only layer with outlines", "no hint in the layer name"]) {
  assert.ok(importer.includes(`"${why}"`), `pcb_import.py still says "${why}"`);
  const r = reasonKey(why);
  assert.ok(r && r.key in en && r.key in tr, `text for "${why}"`);
}
assert.deepEqual(reasonKey("layer map F.Cu"), { key: "pcbImport.why.map", params: { key: "F.Cu" } });
assert.equal(reasonKey("something new"), null, "an unknown reason is shown as the server wrote it");

// ---- layer keys and roles
const dxf = { kind: "dxf", layer: "F.Cu", source: "board.dxf" }, gbr = { kind: "gerber", layer: "top", source: "top.gtl" }, drill = { kind: "drill", layer: "pth", source: "pth.drl" };
assert.equal(layerKey(dxf), "F.Cu", "a DXF layer is keyed by its layer");
assert.equal(layerKey(gbr), "top.gtl", "a Gerber file by its file");
// fnmatch: [ * ? become one-character classes (python/tests/test_pcb_import.py PcbApi checks the server side of this)
assert.equal(layerKey({ ...dxf, layer: "Cu[1]*?" }), "Cu[[]1][*][?]", "pattern characters match only themselves");
const ALL = ["top_copper", "bottom_copper", "outline", "ignore", "top_clearance", "bottom_clearance"];
assert.deepEqual(roleChoices({ kind: "dxf", role: "top_copper" }), ALL);
assert.deepEqual(roleChoices({ kind: "dxf", role: null }), ["", ...ALL], "an unclear layer can stay unclear");
assert.deepEqual(roleChoices({ kind: "gerber", role: "outline" }), ALL);
for (const r of ALL) assert.ok(`pcbImport.role.${r}` in en && `pcbImport.role.${r}` in tr, `role ${r} has a label`);
assert.deepEqual(roleChoices({ kind: "drill", role: "drill" }), ["drill", "ignore"], "a drill file is drills or ignored");
assert.equal(roleValue({ role: null }), "");
const first = Object.freeze({});
const m1 = withRole(first, dxf, "bottom_copper");
assert.deepEqual(m1, { "F.Cu": "bottom_copper" });
assert.deepEqual(first, {}, "the map is not changed in place");
assert.deepEqual(withRole(m1, dxf, "outline"), { "F.Cu": "outline" });
assert.deepEqual(withRole(m1, dxf, ""), {}, "the empty choice drops the entry");
assert.deepEqual(withRole(m1, gbr, "top_copper"), { "F.Cu": "bottom_copper", "top.gtl": "top_copper" });
assert.deepEqual(withRole({}, drill, "drill"), {}, "a drill file's own role is no entry");
assert.deepEqual(withRole({}, drill, "ignore"), { "pth.drl": "ignore" });
assert.deepEqual(withRole({}, dxf, "not-a-role"), {}, "an unknown role is not sent");
assert.deepEqual(withoutRole(m1, dxf), {});
assert.deepEqual(pruneMap({ "F.Cu": "top_copper", "gone.gtl": "ignore" }, [dxf, gbr]), { "F.Cu": "top_copper" }, "a removed file's entry goes");
assert.equal(isChosen({ because: "layer map F.Cu" }), true);
assert.equal(isChosen({ because: "layer name" }), false);

// ---- the summary names the roles the importer guessed (never "everything was imported" over a guess)
const detected = [
  { kind: "dxf", layer: "B_Cu", source: "x-B_Cu.dxf", role: "bottom_copper", because: "layer name" },
  { kind: "dxf", layer: "B_Cu_Antipad", source: "x-B_Cu.dxf", role: "bottom_clearance", because: "layer name" },
  { kind: "dxf", layer: "Drill", source: "x-B_Cu.dxf", role: "ignore", because: "layer name" },
  { kind: "dxf", layer: "F_Cu", source: "x-F_Cu.dxf", role: "top_copper", because: "layer map F_Cu" },
  { kind: "gerber", layer: "x-B_Cu", source: "x-B_Cu.gbr", role: "bottom_copper", because: "Gerber file function" },
  { kind: "drill", layer: "x-PTH", source: "x-PTH.drl", role: "drill", because: "Excellon file" },
];
assert.deepEqual(guessedRoles(detected), [{ layer: "B_Cu", role: "bottom_copper" }, { layer: "B_Cu_Antipad", role: "bottom_clearance" }],
  "guessed from the name: the copper and its clearance; not an ignored layer, the viewer's choice, a file function or a drill file");
assert.ok("pcbImport.guessed" in en && en["pcbImport.guessed"].includes("{list}"));
assert.match(dialog, /fallback=\{<Show when=\{!guessed\(\)\}><span>\{t\("pcbImport\.allImported"\)\}<\/span><\/Show>\}/, "\"everything was imported\" only when no role is a guess");

// ---- the proposed design name: the stem the files share, without the layer part of each name
assert.equal(designNameFromFiles(["export_patch-F_Cu.dxf", "export_patch-B_Cu.dxf", "export_patch-Edge_Cuts.dxf"]), "export_patch");
assert.equal(designNameFromFiles(["export-patch-F_Cu.gbr", "export-patch-B_Cu.gbr", "export-patch-Edge_Cuts.gbr", "export-patch-PTH.drl"]), "export-patch");
assert.equal(designNameFromFiles(["x-B_Cu_Antipad.dxf"]), "x");
assert.equal(designNameFromFiles(["patch_top.GTL", "patch_bottom.GBL", "patch.GKO"]), "patch");
assert.equal(designNameFromFiles(["board.dxf"]), "board");
assert.equal(designNameFromFiles(["F_Cu.dxf"]), "F_Cu", "a name that is only a layer stays");
assert.equal(designNameFromFiles(["a-F_Cu.dxf", "b-B_Cu.dxf", "b-Edge_Cuts.dxf"]), "b", "the stem most files share");
assert.match(dialog, /setName\(freeName\(designNameFromFiles\(entries\(\)\.map\(\(e\) => e\.name\)\)\)\)/, "the dialog proposes it");

// ---- rows that name a command-line flag are worded by the app: every key pcb_import.py gives has a text in both
// languages, whose parameters are the row's or the dialog's own
const injected = new Set(["units", "origin", "keep", "table", "outline", "bottom"]);
const keyed = [...importer.matchAll(/key="([\w-]+)"(?:, params=\{(.*?)\}\))?/g)].map((m) => ({ key: m[1], params: [...(m[2] ?? "").matchAll(/"(\w+)":/g)].map((p) => p[1]) }));
const dynamic = [...importer.matchAll(/note = \("([\w-]+)"/g)].map((m) => m[1]);
assert.ok(keyed.length >= 6 && dynamic.length === 3, `keyed rows found (${keyed.length}, ${dynamic.length})`);
for (const key of [...keyed.map((k) => k.key), ...dynamic]) {
  const id = `pcbImport.note.${key}`;
  assert.ok(id in en && id in tr, `${id} in both languages`);
  assert.doesNotMatch(en[id], /--\w/, `${id}: the app's text names no command-line flag`);
}
for (const { key, params } of keyed) {
  for (const p of en[`pcbImport.note.${key}`].matchAll(/\{(\w+)\}/g)) assert.ok(params.includes(p[1]) || injected.has(p[1]), `${key}: {${p[1]}} is given`);
}
assert.deepEqual(noteKey({ key: "origin-centered", params: { x: "1", y: "2" } }, (k) => k in en), { key: "pcbImport.note.origin-centered", params: { x: "1", y: "2" } });
assert.equal(noteKey({ key: "new-row" }, (k) => k in en), null, "a row an older app has no text for is shown as the server wrote it");
assert.equal(noteKey({}, (k) => k in en), null);

// ---- files
const kb = (n) => n * 1000;
assert.deepEqual(admitFiles([], [{ name: "a.dxf", size: kb(10) }]), { accepted: [{ name: "a.dxf", size: kb(10) }], problems: [] });
const dup = admitFiles([{ name: "A.dxf", size: 5 }], [{ name: "a.DXF", size: 5 }]);
assert.equal(dup.accepted.length, 0); assert.equal(dup.problems[0].key, "pcbImport.err.duplicate");
assert.equal(admitFiles([], [{ name: "e.dxf", size: 0 }]).problems[0].key, "pcbImport.err.empty");
assert.equal(admitFiles([], [{ name: "big.dxf", size: PCB_LIMITS.file + 1 }]).problems[0].key, "pcbImport.err.fileTooLarge");
assert.equal(admitFiles([], [{ name: "ok.dxf", size: PCB_LIMITS.file }]).accepted.length, 1, "exactly the limit is fine");
const many = Array.from({ length: PCB_LIMITS.files + 3 }, (_, i) => ({ name: `f${i}.gbr`, size: 10 }));
const capped = admitFiles([], many);
assert.equal(capped.accepted.length, PCB_LIMITS.files);
assert.equal(capped.problems.at(-1).key, "pcbImport.err.tooMany");
const heavy = admitFiles([{ name: "a", size: PCB_LIMITS.file }, { name: "b", size: PCB_LIMITS.file }], [{ name: "c", size: 10 }, { name: "d", size: 1 }]);
assert.deepEqual(heavy.problems.map((p) => p.key), ["pcbImport.err.total", "pcbImport.err.total"], "over the total");
assert.equal(heavy.accepted.length, 0);
assert.equal(toBase64(new Uint8Array([104, 105])), "aGk=");
assert.equal(toBase64(new Uint8Array(100_000)).length, Math.ceil(100_000 / 3) * 4, "a large file does not overflow the stack");

// ---- options: a decimal point in the request whatever was typed
const ok = buildOptions(PCB_DEFAULTS, {});
assert.deepEqual(ok.errors, {});
assert.deepEqual(ok.options, { substrate: "fr4", thickness: 1.6, eps_r: 4.3, tan_d: 0.02, f0: 2.45, units: "auto", chord_tol: 0.02, margin: 2, origin: "center" });
const typed = buildOptions({ ...PCB_DEFAULTS, substrate: "custom", thickness: "0,8", epsR: " 2,2 ", tanD: "9e-4", f0: "5.8" }, { "F.Cu": "bottom_copper" });
assert.deepEqual(typed.errors, {});
assert.equal(typed.options.thickness, 0.8); assert.equal(typed.options.eps_r, 2.2); assert.equal(typed.options.tan_d, 0.0009); assert.equal(typed.options.f0, 5.8);
assert.equal(typed.options.substrate, "substrate"); assert.deepEqual(typed.options.layer_map, { "F.Cu": "bottom_copper" });
assert.equal(buildOptions(PCB_DEFAULTS, {}).options.layer_map, undefined, "no map, no key");
for (const [field, text] of [["thickness", ""], ["thickness", "0"], ["thickness", "abc"], ["thickness", "1,2,3"], ["thickness", "101"], ["epsR", "0.9"], ["tanD", "-0.1"], ["tanD", "1.1"], ["f0", "0"], ["chordTol", "0"], ["margin", "-1"]]) {
  assert.ok("error" in fieldValue(field, text), `${field}=${JSON.stringify(text)} is refused`);
  assert.ok(buildOptions({ ...PCB_DEFAULTS, [field]: text }, {}).errors[field], `${field} error in the options`);
}
assert.equal(fieldValue("tanD", "0").value, 0, "tan d may be zero");
assert.equal(fieldValue("margin", "0").value, 0, "the margin may be zero");
assert.equal(fieldValue("thickness", "100").value, 100);
for (const key of ["pcbImport.field.number", "pcbImport.field.above", "pcbImport.field.range"]) assert.ok(key in en && key in tr);

console.log("PCB import dialog: entry points, server limits and options, layer roles, files and options: ok");
