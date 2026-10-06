// Apply in the Python panel (src/designer/pythonApply.ts): a script that the server accepts replaces the
// design's content in ONE edit (one undo step), keeping the model's identity; an error (with its line, or a
// timeout) leaves the design and the undo history untouched; a design closed meanwhile is not touched.
//
//   node --experimental-strip-types scripts/check-python-apply.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyPythonScript, replaceDesignContent } from "../src/designer/pythonApply.ts";

const design = (w, extra = {}) => ({
  schema: "fairbeam.design/1", model: { id: "keep-me", name: "Kept", description: "d" },
  params: [{ key: "W", default: w }], simulation: { f_min: "1", f_max: "2", boundaries: "MUR" },
  materials: [], parts: [{ name: `part ${w}`, material: "metal", primitives: [] }], ports: [], resistors: [],
  mesh: { mode: "auto" }, far_field: { enabled: false }, ...extra,
});

// a stand-in of the store's edit(): an undo stack of snapshots, one push per edit
function store(initial) {
  let draft = JSON.parse(JSON.stringify(initial));
  const undo = [];
  return {
    get draft() { return draft; },
    undo,
    edit(fn) { undo.push(JSON.stringify(draft)); fn(draft); },
    undoOnce() { draft = JSON.parse(undo.pop()); },
  };
}

const ok = (w) => async () => ({ design: { ...design(w), model: { id: "python-edit", name: "Python design" } }, python: "# regenerated", normalized: false, output: "hi" });
const fails = (message, data) => async () => { throw Object.assign(new Error(message), { data }); };

// success: one undo step, model kept, everything else from the script (the old sweep is gone)
{
  const s = store(design(32, { parameter_sweep: { axes: [] } }));
  const before = JSON.stringify(s.draft);
  const r = await applyPythonScript("src", { convert: ok(40), current: () => true, replace: (next) => s.edit((d) => replaceDesignContent(d, next)) });
  assert.equal(r.ok, true);
  assert.equal(s.undo.length, 1, "Apply is one undo step");
  assert.equal(s.draft.params[0].default, 40, "the parameters come from the script");
  assert.equal(s.draft.parts[0].name, "part 40", "the parts come from the script");
  assert.deepEqual(s.draft.model, { id: "keep-me", name: "Kept", description: "d" }, "the design keeps its own name and id");
  assert.equal("parameter_sweep" in s.draft, false, "what the script does not define is dropped");
  s.undoOnce();
  assert.equal(JSON.stringify(s.draft), before, "one Undo brings the previous design back");
}

// an error keeps the design: the line and the timeout flag come through, nothing is edited
for (const [data, line, timeout] of [[{ line: 7 }, 7, false], [{ timeout: true }, undefined, true], [{}, undefined, false], [{ line: 0 }, undefined, false]]) {
  const s = store(design(32));
  const before = JSON.stringify(s.draft);
  let replaced = 0;
  const r = await applyPythonScript("src", { convert: fails("ValueError: boom", data), current: () => true, replace: () => { replaced++; } });
  assert.deepEqual([r.ok, r.line, r.timeout, r.message], [false, line, timeout, "ValueError: boom"]);
  assert.equal(replaced, 0, "the design is not touched on an error");
  assert.equal(JSON.stringify(s.draft), before);
  assert.equal(s.undo.length, 0, "no undo step on an error");
}

// the design was closed while the server worked: nothing is applied
{
  let replaced = 0;
  const r = await applyPythonScript("src", { convert: ok(1), current: () => false, replace: () => { replaced++; } });
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.equal(replaced, 0);
}

// the wiring: the store applies through one edit, the panel offers Edit only with a server, and the
// dirty state guards leaving Edit
const storeSrc = readFileSync(new URL("../src/designer/store.ts", import.meta.url), "utf8");
const panel = readFileSync(new URL("../src/designer/PythonPanel.tsx", import.meta.url), "utf8");
assert.match(storeSrc, /edit\(\(d\) => replaceDesignContent\(d, next\), "", t\("history.applyPython"\)\)/, "Apply is one edit() call");
assert.match(panel, /serverState\(\) !== "online"/, "Edit needs the connected run server");
assert.match(panel, /disabled=\{source\(\) === null \|\| offline\(\)\}/, "the Edit button is disabled without a server");
assert.match(panel, /unapplied\(\) && !\(await confirmDraftDiscard/, "leaving Edit with unapplied changes asks first");
assert.match(readFileSync(new URL("../src/editor/PythonSourceEditor.tsx", import.meta.url), "utf8"), /Mod-Enter/, "Ctrl/Cmd+Enter applies");

console.log("Python apply checks passed: one undo step, model identity kept, errors keep the design, closed design untouched, server-only edit, dirty guard.");

// Folder organization travels with converted Python content and one undo restores it.
{
  const before = design(32, { components: ["Old/Empty"] });
  const next = design(40, { components: ["Assembly/Feed", "Empty/Folder"] });
  next.parts[0].component = "Assembly/Feed";
  const state = store(before);
  state.edit(d => replaceDesignContent(d, next));
  assert.deepEqual(state.draft.components, next.components);
  assert.equal(state.draft.parts[0].component, "Assembly/Feed");
  state.undoOnce();
  assert.deepEqual(state.draft.components, before.components);
}
