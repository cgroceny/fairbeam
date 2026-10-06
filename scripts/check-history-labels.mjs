// Named undo steps, typing merged into one step, and F6 pane cycling. The label and merge rules and
// the pane order run for real (no DOM, no build); the wiring is checked in the sources.
//
//   node --experimental-strip-types scripts/check-history-labels.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inferLabel, mergesWithPrevious, MERGE_WINDOW_MS } from "../src/designer/historyLabels.ts";
import { nextPane, PANES } from "../src/designer/panes.ts";
import { matchesShortcut, shortcutTable } from "../src/designer/shortcuts.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8").replaceAll("\r\n", "\n");
const box = { kind: "box", start: [0, 0, 0], stop: [1, 1, 1] };
const part = (name, extra = {}) => ({ name, material: "copper", primitives: [{ ...box }], ...extra });
const design = (over = {}) => ({ parts: [part("Patch"), part("Substrate")], ports: [], resistors: [], materials: [{ name: "copper", kind: "metal" }], params: [], ...over });
const clone = (d) => JSON.parse(JSON.stringify(d));

// ---- labels
{
  const a = design(), b = clone(a);
  b.parts[0].primitives[0].length = 5;
  assert.equal(inferLabel(a, b, "parts[0].primitives[0].length"), "Change length");
  const c = clone(a); c.parts[0].transforms = [{ type: "move", offset: [1, 0, 0] }];
  assert.equal(inferLabel(a, c, ""), "Move Patch");
  assert.equal(inferLabel(a, c, "parts[0].transforms[0].offset"), "Move Patch");
  const d = clone(a); d.parts[0].cuts = [{ start: [0, 0, 0], stop: [1, 1, 0] }];
  assert.equal(inferLabel(a, d, ""), "Subtract Slot from Patch");
  const e = clone(a); e.parts[1].color = "#ff0000";
  assert.equal(inferLabel(a, e, "parts[1].color"), "Set color of Substrate");
  assert.equal(inferLabel(a, e, ""), "Set color of Substrate");
  const f = clone(a); f.ports.push({ type: "lumped", number: 1, R: 50, start: [0, 0, 0], stop: [0, 0, 1], direction: "z" });
  assert.equal(inferLabel(a, f, ""), "Add discrete port");
  const g = clone(a); g.parts.push(part("Ground"));
  assert.equal(inferLabel(a, g, ""), "Add Ground");
  const h = clone(g);
  assert.equal(inferLabel(g, design(), ""), "Delete Ground");
  assert.equal(inferLabel(a, h, "simulation.f_min"), "Change f min");
  assert.equal(inferLabel(a, a, ""), "Edit design");
}

// ---- merging: 4 keystrokes in 4 x 200 ms are one step; another field is another step; a long pause is another
{
  /** A stripped-down edit(): the same merge rule over a list of steps. */
  const run = (events) => {
    const steps = [];
    let prev = { key: "", at: 0, el: null };
    for (const { key, at, el = null, active = null } of events) {
      if (!mergesWithPrevious(prev, key, at, active)) steps.push(key);
      prev = { key, at, el };
    }
    return steps;
  };
  const len = "parts[0].primitives[0].length", wid = "parts[0].primitives[0].width";
  assert.equal(run([0, 200, 400, 600].map((at) => ({ key: len, at }))).length, 1, "typing 12.5 is one step");
  assert.equal(run([{ key: len, at: 0 }, { key: wid, at: 100 }]).length, 2, "different fields are two steps");
  assert.equal(run([{ key: len, at: 0 }, { key: "parts[1].primitives[0].length", at: 100 }]).length, 2, "the same field of another object is another step");
  assert.equal(run([{ key: len, at: 0 }, { key: len, at: MERGE_WINDOW_MS + 10 }]).length, 2, "a pause longer than the window splits the typing");
  const input = { tagName: "INPUT" };
  assert.equal(run([{ key: len, at: 0, el: input }, { key: len, at: 10_000, el: input, active: input }]).length, 1, "one input that keeps the focus keeps merging");
  assert.equal(run([{ key: len, at: 0, el: input }, { key: len, at: 10_000, el: input, active: { tagName: "BUTTON" } }]).length, 2, "focus elsewhere does not");
  assert.equal(run([{ key: "", at: 0 }, { key: "", at: 10 }]).length, 2, "edits with no key never merge");
}

// ---- F6 cycles the panes in order
{
  const order = ["tree", "ribbon", "main", "dock", "properties"];
  assert.deepEqual(PANES.map((p) => p.id), order);
  let at = null; const seen = [];
  for (let i = 0; i < 6; i++) { at = nextPane(at, 1); seen.push(at); }
  assert.deepEqual(seen, [...order, "tree"], "F6 goes tree, ribbon, main, dock, properties, then around");
  assert.equal(nextPane("tree", -1), "properties", "Shift+F6 wraps backwards");
  assert.equal(nextPane(null, -1), "properties");
  assert.equal(nextPane("ribbon", 1, ["tree", "ribbon", "dock", "properties"]), "dock", "a pane that is not shown (collapsed) is skipped");
  assert.equal(nextPane("main", -1, ["tree", "main"]), "tree");
  assert.equal(nextPane(null, 1, []), null);
  const key = (k, o = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
  assert.equal(matchesShortcut("panes", key("F6"), false), true);
  assert.equal(matchesShortcut("panes", key("F6", { shiftKey: true }), true), true);
  assert.equal(matchesShortcut("panes", key("F6", { ctrlKey: true }), false), false);
  assert.equal(matchesShortcut("ribbon", key("F6"), false), false, "F6 does not collide with another shortcut");
  assert.ok(shortcutTable(false).panes.label, "the shortcuts dialog lists the pane shortcut");
}

// ---- wiring
{
  const ws = read("src/designer/DesignWorkspace.tsx"), store = read("src/designer/store.ts"), ui = read("src/designer/panes.ts");
  const core = read("src/designer/sessionCore.ts");
  assert.match(ws, /matchesShortcut\("panes", e\)[\s\S]{0,200}cyclePanes\(e\.shiftKey \? -1 : 1\)/, "DesignKeys cycles panes on F6");
  assert.match(ws, /history\.undoNamed/, "the Undo button names the step");
  assert.match(ws, /history\.redoNamed/, "the Redo button names the step");
  assert.match(store, /defaultDesignerSession = createDesignerSession\(/, "the existing editor uses the session core");
  assert.match(core, /mergesWithPrevious\(/, "edit() merges with the shared rule");
  assert.match(core, /inferLabel\(/, "edit() labels steps with the shared rule");
  assert.match(ui, /"aria-label", t\(p\.label\)/, "each pane is announced by name");
  assert.match(read("src/styles/designer-ux.css"), /\.pane-ring:focus-within/, "a pane reached with F6 shows a focus ring");
}
console.log("history labels and pane cycling: ok");
