// Parameter edits must not be lost: the Parameters dock applies every keystroke to the
// draft at once, so Enter, Escape and leaving a cell decide what Escape can still undo
// (src/designer/rowEdit.ts). Escape reverts only the typing since the last commit; Enter and moving
// on commit. Run in a browser too: the dock's key handler is in ParametersDock.tsx (asserted below).
//
//   node --experimental-strip-types scripts/check-parameter-edit.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRowEdit } from "../src/designer/rowEdit.ts";

// a row as the dock drives it: `row` is the live draft, the session decides what Escape restores
function dock(initial) {
  const s = createRowEdit();
  const row = { ...initial };
  const snap = () => ({ ...row });
  return {
    row,
    focus() { s.begin(snap()); },
    type(key, value) { row[key] = value; s.typed(); },
    enter() { s.commit(snap()); },
    escape() { const back = s.cancel(); if (back) Object.assign(row, back); return !!back; },
    leave() { s.end(); },
  };
}

// the reported case: type 0.466, Enter, Escape must keep 0.466
{
  const d = dock({ key: "k", default: 0.48 });
  d.focus(); d.type("default", 0.466); d.enter();
  assert.equal(d.escape(), false, "nothing uncommitted after Enter");
  assert.equal(d.row.default, 0.466, "the committed value survives Escape");
}
// Escape without Enter undoes the typing, and only that
{
  const d = dock({ key: "k", default: 0.48 });
  d.focus(); d.type("default", 0.4); d.type("default", 0.46);
  assert.equal(d.escape(), true);
  assert.equal(d.row.default, 0.48, "Escape restores the value at focus-in");
}
// Enter, more typing, Escape: back to the committed value, not to the focus-in value
{
  const d = dock({ key: "k", default: 0.48 });
  d.focus(); d.type("default", 0.5); d.enter(); d.type("default", 0.9);
  d.escape();
  assert.equal(d.row.default, 0.5);
}
// blur commits: typing, moving to another cell (focus-in of the next cell), Escape there
{
  const d = dock({ key: "k", default: 0.48, unit: "" });
  d.focus(); d.type("default", 0.466);
  d.focus();                                  // Tab into the unit cell: the first cell is committed
  d.type("unit", "mm"); d.escape();
  assert.equal(d.row.unit, "", "typing in the second cell is still undoable");
  assert.equal(d.row.default, 0.466, "and the first cell's value is kept");
}
// leaving the row and coming back starts a new session (nothing stale to restore)
{
  const d = dock({ key: "k", default: 0.48 });
  d.focus(); d.type("default", 0.7); d.leave();
  d.focus();
  assert.equal(d.escape(), false);
  assert.equal(d.row.default, 0.7);
}
// a second Escape does nothing
{
  const d = dock({ key: "k", default: 0.48 });
  d.focus(); d.type("default", 0.3); d.escape();
  assert.equal(d.escape(), false);
  assert.equal(d.row.default, 0.48);
}

// the dock wires it: Enter in a cell commits and goes to the next row, Escape asks the session
const src = readFileSync(new URL("../src/designer/ParametersDock.tsx", import.meta.url), "utf8");
assert.ok(/createRowEdit<DesignParam>\(\)/.test(src), "the dock keeps one editing session per row");
assert.ok(/rowEdit\.begin\(snapshot\(\)\)/.test(src), "focusing a cell commits the row so far");
assert.ok(/onInput=\{\(\) => rowEdit\.typed\(\)\}/.test(src), "typing marks the row as uncommitted");
assert.ok(/e\.key === "Enter" && e\.target instanceof HTMLInputElement[\s\S]{0,300}rowEdit\.commit\(snapshot\(\)\)/.test(src), "Enter in a cell commits");
assert.ok(/nextElementSibling as HTMLTableRowElement/.test(src), "Enter moves to the next row");
assert.ok(/const saved = rowEdit\.cancel\(\)/.test(src), "Escape restores only uncommitted typing");
assert.ok(!/let before: DesignParam/.test(src), "no row snapshot taken once at focus-in and kept");

// ---------------------------------------------------------------- renaming a parameter
// A rename rewrites every expression that names the key, as a whole name token (the expression
// tokenizer, not a text search), in every expression field of the file format (paramRefs.ts).
const { renameInExpr } = await import("../src/designer/expr.ts");
const { mapExpressions, parameterUses, pathOwner, renameParameter } = await import("../src/designer/paramRefs.ts");
assert.equal(renameInExpr("fw/2 + fw_gap", "fw", "feed_w"), "feed_w/2 + fw_gap", "a longer name that starts with the key stays");
assert.equal(renameInExpr("-(fw/2+inset_g)", "fw", "feed_w"), "-(feed_w/2+inset_g)", "spacing and parentheses are kept as written");
assert.equal(renameInExpr("max(fw, 2*fw)", "fw", "w2"), "max(w2, 2*w2)");
assert.equal(renameInExpr("sqrt(fw)", "sqrt", "root"), "sqrt(fw)", "a function call is not a parameter");
assert.equal(renameInExpr("fw $ 2", "fw", "x"), "fw $ 2", "an expression the tokenizer refuses stays as it is");
assert.equal(renameInExpr("W", "W", "Wp"), "Wp");
assert.equal(renameInExpr("Wide + W", "W", "Wp"), "Wide + Wp");

const sample = () => ({
  schema: "fairbeam.design/1", model: { id: "s", name: "fw" },
  params: [{ key: "fw", default: 3, label: "fw width" }, { key: "half", expr: "fw / 2" }, { key: "L", default: 20 }],
  simulation: { f_min: 1, f_max: "fw + 2", boundaries: "MUR" },
  materials: [{ name: "fw", kind: "dielectric", eps_r: "fw", tan_d: 0.01, tan_d_freq: "fw" }],
  parts: [
    { name: "fw", label: "fw", component: "fw", material: "fw", primitives: [{ kind: "box", start: ["-fw/2", 0, 0], stop: ["fw/2", "L", 0], label: "fw" }],
      transforms: [{ type: "translate", copies: "fw", step: ["fw", 0, 0] }], cuts: [{ kind: "circle", center: ["fw", 0], radius: "fw/4" }],
      booleanHistory: { operation: "subtract", live: true, A: { name: "a", material: "fw", primitives: [{ kind: "box", start: [0, 0, 0], stop: ["fw", 1, 0] }] },
        B: { name: "b", material: "fw", primitives: [{ kind: "box", start: ["-(fw/2+1)", 0, 0], stop: [1, 1, 0] }] } } },
  ],
  ports: [{ type: "lumped", number: 1, R: "fw*10", start: ["fw", 0, 0], stop: ["fw", 0, 1], direction: "z",
    reference_impedance: { real: "fw", imag: 0 }, group: { connection: "parallel", members: [{ start: ["-fw", 0, 0], stop: ["-fw", 0, 1], direction: "z" }] } }],
  resistors: [{ name: "fw", R: "fw", start: [0, 0, 0], stop: [0, 0, "fw"], direction: "z" }],
  mesh: { mode: "manual", lines: { x: ["-fw", "fw"], y: [0, 1], z: [0, 1] }, overrides: { edge_rule: "fw", cells_per_wavelength: "fw" } },
  far_field: { enabled: true, frequencies: ["fw"], phase_center: [0, 0, "fw"] },
  monitors: { field_planes: [{ quantity: "E", normal: "z", position: "fw", frequencies: ["fw"] }] },
  wcs: { normal: "z", origin: [0, 0, "fw"], angle: 0 },
  parameter_sweep: { schema: "fairbeam.parameter-sweep/1", sequences: [{ name: "s", axes: [{ key: "fw", kind: "range", start: "fw", stop: "2*fw", steps: "3" }] }] },
});
{
  const d = sample();
  const uses = parameterUses(d, "fw");
  assert.equal(uses.length, 31, `every expression field that names fw is found (${uses.length}: ${uses.join(", ")})`);
  assert.ok(uses.includes("parts[0].booleanHistory.B.primitives[0].start[0]"), "the operand copies a Boolean history keeps count");
  assert.ok(uses.includes("parameter_sweep.sequences[0].axes[0].key"), "a sweep over the parameter counts");
  assert.ok(!uses.some((p) => /\.(name|label|component|material|edge_rule|quantity)$/.test(p)), "names, labels and words are never expressions");
  assert.deepEqual(parameterUses(d, "L"), ["parts[0].primitives[0].stop[1]"]);
  assert.deepEqual(parameterUses(d, "half"), [], "an unused derived parameter");
  assert.deepEqual(pathOwner("parts[0].booleanHistory.B.primitives[0].start[0]"), { kind: "part", index: 0 }, "an operand belongs to its result");
  assert.deepEqual(pathOwner("ports[0].group.members[0].start[0]"), { kind: "port", index: 0 });
  assert.deepEqual(pathOwner("mesh.lines.x[0]"), { kind: "mesh" });
  renameParameter(d, "fw", "feed_w");
  assert.deepEqual(parameterUses(d, "fw"), [], "after the rename nothing names fw");
  assert.equal(parameterUses(d, "feed_w").length, 31, "and every one of those fields names feed_w");
  assert.equal(d.params[0].key, "feed_w");
  assert.equal(d.params[1].expr, "feed_w / 2");
  assert.equal(d.parts[0].booleanHistory.B.primitives[0].start[0], "-(feed_w/2+1)");
  assert.equal(d.parameter_sweep.sequences[0].axes[0].key, "feed_w");
  // what is not an expression keeps the old word, even when it reads "fw"
  assert.deepEqual([d.model.name, d.params[0].label, d.materials[0].name, d.parts[0].name, d.parts[0].label, d.parts[0].component, d.parts[0].material,
    d.parts[0].primitives[0].label, d.resistors[0].name, d.mesh.overrides.edge_rule], ["fw", "fw width", "fw", "fw", "fw", "fw", "fw", "fw", "fw", "fw"]);
  let count = 0;
  mapExpressions(sample(), () => { count++; });
  assert.ok(count >= 31, "mapExpressions visits every string expression");
}

// ---------------------------------------------------------------- the store: rename, delete, duplicate, add
{
  const { build } = await import("vite");
  const solid = (await import("vite-plugin-solid")).default;
  const root = new URL("../", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
  const built = await build({
    root, configFile: false, logLevel: "silent", resolve: { conditions: ["browser"] }, css: { postcss: {} },
    plugins: [solid(), {
      name: "parameter-edit-entry",
      resolveId(id) { if (id.endsWith("parameter-edit-entry")) return "\0parameter-edit-entry"; },
      load(id) { if (id === "\0parameter-edit-entry") return `export * as store from ${JSON.stringify(`${root}src/designer/store.ts`)};`; },
    }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry: "parameter-edit-entry", formats: ["es"] } },
  });
  const chunk = (Array.isArray(built) ? built[0] : built).output.find((o) => o.type === "chunk");
  const stub = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, querySelector: () => null, getElementById: () => null };
  globalThis.window = { ...stub, document: stub };
  globalThis.document = stub;
  globalThis.requestAnimationFrame = () => 1;
  const { store } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`);
  const design = {
    schema: "fairbeam.design/1", model: { id: "p", name: "P" },
    params: [{ key: "W", default: 30 }, { key: "h", default: 1.5 }, { key: "unused", default: 1 }, { key: "f0", default: 2.4 }],
    simulation: { f_min: "f0*0.8", f_max: "f0*1.2", boundaries: "MUR" },
    materials: [{ name: "copper", kind: "metal" }],
    parts: [{ name: "patch", label: "Patch", material: "copper", primitives: [{ kind: "box", start: ["-W/2", -10, "h"], stop: ["W/2", 10, "h"] }] },
      { name: "feed", label: "Feed", material: "copper", primitives: [{ kind: "box", start: [-1, -20, "h"], stop: [1, "-W/3", "h"] }] }],
    ports: [{ type: "lumped", number: 1, R: 50, start: [0, 0, 0], stop: [0, 0, "h"], direction: "z" }],
    resistors: [], mesh: { mode: "auto" }, far_field: { enabled: false },
  };
  const open = () => { store.setDraft(structuredClone(design)); store.setFile({ id: "p", file: "p", hash: "1", design }); store.setSelection({ type: "design" }); store.setMessage(null); };
  open();
  // an invalid or taken key is not applied and says why
  assert.match(store.renameParam(0, "2W"), /letters, digits/, "an invalid key is refused");
  assert.equal(store.renameParam(0, "h"), store.paramKeyProblem(0, "h"), "a taken key is refused");
  assert.equal(store.draft.params[0].key, "W", "nothing changed");
  assert.equal(store.canUndo(), false, "and no undo step was made");
  assert.equal(store.renameParam(0, " Wp "), null, "a valid key is applied (trimmed)");
  assert.deepEqual([store.draft.params[0].key, store.draft.parts[0].primitives[0].start[0], store.draft.parts[1].primitives[0].stop[1]], ["Wp", "-Wp/2", "-Wp/3"]);
  store.undo();
  assert.deepEqual([store.draft.params[0].key, store.draft.parts[0].primitives[0].start[0]], ["W", "-W/2"], "one undo step takes the whole rename back");
  // a parameter in use is not deleted; the message names the places
  store.setSelection({ type: "param", i: 0 });
  store.removeSelected();
  assert.equal(store.draft.params.length, 4, "W is still there");
  assert.equal(store.message().text, "W is used by 3 fields (Patch, Feed); change those first.");
  assert.equal(store.message().tone, "warn");
  assert.equal(store.removeParam(1), false, "the trash button goes through the same guard");
  assert.equal(store.message().text, "h is used by 5 fields (Patch, Feed, Port 1); change those first.");
  assert.equal(store.removeParam(2), true, "an unused parameter is deleted as before");
  assert.deepEqual(store.draft.params.map((p) => p.key), ["W", "h", "f0"]);
  // Delete and Duplicate agree for every kind of selection
  for (const s of [{ type: "param", i: 0 }, { type: "material", i: 0 }, { type: "part", i: 0 }, { type: "primitive", i: 0, j: 0 }, { type: "port", i: 0 }, { type: "design" }, { type: "simulation" }, { type: "optimization", id: "x" }]) {
    store.setSelection(s);
    assert.equal(store.canDuplicate(), store.canRemove(), `Delete and Duplicate agree for ${s.type}`);
  }
  store.setSelection({ type: "param", i: 0 });
  store.duplicateSelected();
  assert.deepEqual(store.draft.params.map((p) => p.key), ["W", "W_2", "h", "f0"], "Duplicate copies a parameter as W_2, below it");
  assert.deepEqual(store.selection(), { type: "param", i: 1 }, "and selects the copy");
  // a new parameter: p1, p2, … and no unit
  store.addParam(); store.addParam();
  assert.deepEqual(store.draft.params.slice(-2).map((p) => [p.key, p.unit]), [["p1", undefined], ["p2", undefined]]);
}

// ---------------------------------------------------------------- the dock's key cell
assert.ok(/const \[keyText, setKeyText\] = createSignal<string \| null>\(null\)/.test(src), "the key cell keeps the typed key until it is committed");
assert.ok(/onInput=\{\(e\) => setKeyText\(e\.currentTarget\.value\)\} onBlur=\{\(\) => commitKey\(\)\}/.test(src), "typing changes nothing; leaving the cell commits");
assert.ok(/e\.key === "Enter" && !e\.isComposing && !commitKey\(\)\) e\.preventDefault\(\)/.test(src), "Enter commits; a refused key keeps the focus");
assert.ok(/renameParam\(i\(\), typed\)/.test(src), "the commit renames through the store (every use, one undo step)");
assert.ok(!/q\[key\] = key === "key"/.test(src), "no keystroke writes the key");
assert.ok(/if \(!removeParam\(at\)\) return;/.test(src), "the trash button is guarded");
const doc = readFileSync(new URL("../docs/DESIGNER.md", import.meta.url), "utf8");
assert.ok(/a new key applies on \*\*Enter\*\* or when the cell is left, and renames the parameter\s+everywhere/.test(doc), "DESIGNER.md describes the rename");

console.log("parameter edit: Enter commits, Escape undoes only uncommitted typing, blur commits (6 sequences, dock wiring); renames reach every expression (tokens, Boolean operands, sweep), one undo step; a parameter in use is not deleted; Delete and Duplicate agree; new parameters p1, p2 without a unit");
