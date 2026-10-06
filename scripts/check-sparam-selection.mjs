// The S-parameter selection never ends up empty, the designer's S-parameters tab always has the
// picker, and the CST import entries say "file" (0.6.2: the maintainer's one-port design showed
// "choose in the picker" with no picker in sight).
//
//   node scripts/check-sparam-selection.mjs
//
// 1. createSParamSelection: an unset, emptied or stale selection (another view mode, a re-run, a
//    design with other ports) falls back to the driven port's column, S11 for a one-port design.
// 2. A picked pair that is still in the matrix stays; a pair that left it is dropped.
// 3. The Results tab keeps the picker for one-port designs; the empty-state text names the real
//    control; the last shown pair cannot be switched off.
// 4. The CST import entries (Start, ribbon, dialog, native File menu, docs) say "CST file" in EN and TR.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const read = (p) => readFileSync(`${root}${p}`, "utf8");
const built = await build({
  root, configFile: false, logLevel: "silent", resolve: { conditions: ["browser"] },
  plugins: [{
    name: "sparam-selection-entry",
    resolveId(id) { if (id.endsWith("sparam-selection-entry")) return "\0sparam-selection-entry"; },
    load(id) {
      if (id !== "\0sparam-selection-entry") return;
      return `export { createSParamSelection } from ${JSON.stringify(`${root}src/components/SParamView.tsx`)};
export { createRoot, createSignal } from "solid-js";`;
    },
  }],
  build: { write: false, minify: false, lib: { entry: "sparam-selection-entry", formats: ["es"] } },
});
const code = (Array.isArray(built) ? built[0] : built).output[0].code;
const { createSParamSelection, createRoot, createSignal } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const matrix = (ports, excited = [ports[0]]) => {
  const pairs = ports.flatMap((i) => ports.map((j) => [i, j]));
  const c = { re: [0.1, 0.2], im: [0, 0] };
  return { f: [1e9, 2e9], ports, zRef: ports.map(() => 50), excited, pairs, get: () => c, reciprocity: null, passivity: null, legacy: false };
};
const keys = (sel) => sel.selectedPairs().map((p) => p.join(","));

createRoot((dispose) => {
  const [m, setM] = createSignal(matrix([1]));
  const sel = createSParamSelection(m);

  // 1. one-port: S11 whatever the stored selection is
  assert.deepEqual(keys(sel), ["1,1"], "one-port default is S11");
  sel.setSel([]);
  assert.deepEqual(keys(sel), ["1,1"], "an emptied selection falls back to S11");
  sel.setSel(["2,1", "9,9"]);
  assert.deepEqual(keys(sel), ["1,1"], "stale keys fall back to S11");
  sel.setSel(null);

  // a two-port design: the driven port's column; picks stay while they exist
  setM(matrix([1, 2]));
  assert.deepEqual(keys(sel), ["1,1", "2,1"], "two-port default is the driven column");
  sel.setSel(["2,2", "1,2"]);
  assert.deepEqual(keys(sel), ["2,2", "1,2"], "picked pairs stay");
  sel.setSel([]);
  assert.deepEqual(keys(sel), ["1,1", "2,1"], "an emptied two-port selection falls back to the driven column");
  sel.setSel(["2,2"]);
  // a re-run or another design with one port: the stored 2,2 left the matrix
  setM(matrix([1]));
  assert.deepEqual(keys(sel), ["1,1"], "a pick that left the matrix is dropped, S11 shows");
  setM(matrix([1, 2], [2]));
  sel.setSel(null);
  assert.deepEqual(keys(sel), ["1,2", "2,2"], "the default follows the excited port");
  setM(null);
  assert.deepEqual(keys(sel), [], "no matrix, nothing selected");
  dispose();
});

// 3. the picker is wired for one-port designs, and cannot be emptied
const views = read("src/designer/ResultViews.tsx");
assert.match(views, /const mp = \(\) => \(S\(\)\?\.pairs\.length \?\? 0\) >= 1;/, "ResultSParams shows the picker for one-port designs");
const tools = read("src/components/SParamView.tsx");
assert.match(tools, /cur\.length > 1\) store\.setSel/, "the last shown pair cannot be toggled off");
const en = JSON.parse(read("src/i18n/en.json")), tr = JSON.parse(read("src/i18n/tr.json"));
for (const k of ["sparams.chooseOne", "sparams.keepOne"]) { assert.ok(en[k] && tr[k], `${k} in EN and TR`); }
assert.ok(!/in the picker/i.test(en["sparams.chooseOne"]) && /button/.test(en["sparams.chooseOne"]), "the empty-state text names the real control");

// 4. Import wording: macro files only (.bas, .mcs, .txt)
for (const [lang, d] of [["en", en], ["tr", tr]]) {
  for (const k of ["home.importCst.button", "cstImport.title", "cstImport.choose", "ribbon.home.importCstTitle", "home.importCst.note", "app.notice.cstImportDesktop", "cstImport.intro"]) {
    assert.ok(d[k] && !/\.cst\b|CST Studio Suite/i.test(d[k]), `${lang} ${k} offers macro files only: ${d[k]}`);
  }
  assert.match(d["home.importCst.note"], /\.bas, \.mcs, \.txt/);
}
assert.equal(en["home.importCst.button"], "Import VBA macro…");
assert.equal(tr["home.importCst.button"], "VBA makrosunu içe aktar…");
assert.match(read("src-tauri/src/i18n.rs"), /"file-import-cst", "Import VBA macro…", "VBA makrosunu içe aktar…"/);
for (const f of ["docs/GETTING-STARTED.md", "docs/DESIGNER.md", "docs/DESKTOP.md", "docs/DESKTOP-CHECKLIST.md"]) {
  assert.ok(!/Import CST [Ff]ile/.test(read(f)), `${f} still says Import CST file`);
}

// the Start page's rename never fails silently
const actions = read("src/home/DesignActions.tsx");
assert.match(actions, /setSaveFirst\(id\)/, "a design with unsaved edits opens the Save and rename question");
assert.ok(!/blocked\(id\)\) \{ setNote/.test(actions), "no silent note for a blocked rename");
for (const k of ["home.designs.renameUnsaved", "home.designs.saveAndRename", "home.designs.renameSaveFailed", "home.designs.renameAria", "home.designs.renameTitle"]) assert.ok(en[k] && tr[k], `${k} in EN and TR`);
console.log("S-parameter selection and wording checks passed");
