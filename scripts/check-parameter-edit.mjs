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

console.log("parameter edit: Enter commits, Escape undoes only uncommitted typing, blur commits (6 sequences, dock wiring)");
