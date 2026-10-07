// Checks for the designer's navigation tree model (src/designer/navModel.ts, #52) and the Examples
// split (src/runner/examples.ts, #51): component folders, run labels (name · time · engine), the
// children of a run (1D, far fields, 2D/3D, tables, log), flattening with expand/collapse and the
// filter, the WAI-ARIA arrow keys, the multi-selection of runs for Compare, and which bundles are
// examples.
//
//   node --experimental-strip-types scripts/check-nav-tree.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  componentTree, flatten, folderParts, matchesFilter, MAX_COMPARE, normComponent, pickRuns, runChildren, runContent, runNodes, runRows, treeKey,
} from "../src/designer/navModel.ts";
import { designFor, exampleEntries, isExample, exampleSourceFor } from "../src/runner/examples.ts";
import { carriesFiles } from "../src/lib/fileDrop.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
let failures = 0;
const eq = (got, want, where) => {
  checks++;
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) {
    failures++;
    console.error(`  FAIL ${where}: got ${a}, want ${b}`);
  }
};
const ids = (rows) => rows.map((r) => r.id);

// component folders: canonical paths, folders in order of first use, then parts
{
  eq(normComponent(" antenna / feed/ "), "antenna/feed", "normComponent trims and drops empty segments");
  const t = componentTree([{ component: "antenna/feed" }, {}, { component: "antenna" }, { component: " antenna / feed " }]);
  eq(t.parts, [1], "top-level parts");
  eq(t.folders.map((f) => f.path), ["antenna"], "one top folder");
  eq(t.folders[0].parts, [2], "a part directly in antenna");
  eq(t.folders[0].folders[0].parts, [0, 3], "antenna/feed collects both spellings");
  eq(folderParts(t.folders[0]).sort(), [0, 2, 3], "folderParts counts nested parts");
}

// run labels: newest first; the time (with the date when runs span days) and the engine in the sub
// line, not repeated when the label already carries them; previews and other models left out
{
  const entries = [
    { file: "zz-ab.json", name: "zz_ab", model: "zz-ab", created: "2026-09-26T10:05:00+0300", simulated: true, engine: "CPU" },
    { file: "zz-ab-2.json", name: "zz_ab", model: "zz-ab", created: "2026-09-26T11:30:00+0300", simulated: true, engine: "CPU" },
    { file: "zz-ab-prev.json", name: "zz_ab", model: "zz-ab", created: "2026-09-26T12:00:00+0300", simulated: false },
    { file: "dipole.json", name: "Half-wave dipole", model: "dipole", created: "2026-09-24T23:18:48+0300", simulated: true },
  ];
  const rows = runRows(entries, "zz-ab");
  eq(rows.map((r) => r.file), ["zz-ab-2.json", "zz-ab.json"], "newest run first, preview and other models excluded");
  eq(rows.map((r) => r.label), ["zz_ab · 11:30", "zz_ab · 10:05"], "same names get the time (projectLabels)");
  eq(rows.map((r) => r.sub), ["CPU", "CPU"], "the time is not repeated in the sub line");
  const cuda = runRows([entries[0], { ...entries[1], engine: "CUDA", created: "2026-09-27T09:00:00+0300" }], "zz-ab");
  eq(cuda.map((r) => r.label), ["zz_ab · GPU", "zz_ab · CPU"], "engines tell runs apart first (CPU or GPU)");
  eq(cuda.map((r) => r.sub), ["09-27 09:00", "09-26 10:05"], "runs on several days show the date");
  eq(cuda[0].title.endsWith("GPU (CUDA)"), true, "the backend only in the row's title");
  const both = runRows([{ ...entries[0], name: "solo", engine: "gpu" }], "zz-ab");
  eq(both[0].sub, "GPU · 10:05", "the engine before the time: a narrow tree cuts the time, not the engine");
  const sameMinute = runRows([entries[0], { ...entries[1], created: "2026-09-26T10:05:40+0300" }], "zz-ab");
  eq(sameMinute.map((r) => [r.label, r.sub]), [["zz_ab · 10:05:40", "CPU"], ["zz_ab · 10:05:00", "CPU"]], "seconds in the label: no time in the sub line");
  const finished = new Map([["zz-ab.json", Date.parse("2026-09-26T12:00:00+0300")]]);
  eq(runRows(entries, "zz-ab", finished)[0].file, "zz-ab.json", "the job history's completion time wins");
  eq(runRows(entries, "unrun"), [], "a design without runs");
}

// what a run holds: far-field and current frequencies, tolerant of missing sections
{
  const b = { results: { farfield: [{ f: 2.4e9, port: 1 }, { f: 2.4e9, port: 2 }, { f: 2.5e9 }] },
    fields: { planes: [{ frequencies: [{ f: 2.41e9, f_target: 2.4e9 }] }] } };
  eq(runContent(b), { farfield: [2.4e9, 2.5e9], currents: [2.4e9] }, "one far field per frequency (ports merged)");
  eq(runContent({ results: null }), { farfield: [], currents: [] }, "no results");
  eq(runContent(null), { farfield: [], currents: [] }, "nothing read yet");
  const kids = runChildren("r.json", runContent(b));
  eq(kids.map((k) => k.label), ["1D Results", "Far fields", "2D/3D Results", "Tables", "Log"], "result folders, in order");
  eq(kids[0].children.map((k) => k.action.view), ["sparams", "impedance", "vswr", "smith", "efficiency"], "1D views (the efficiency with them)");
  eq(kids[1].children.map((k) => [k.label, k.action.view, k.action.f]), [["Far field (f = 2.400 GHz)", "pattern", 2.4e9], ["3D pattern (f = 2.400 GHz)", "pattern3d", 2.4e9],
    ["Far field (f = 2.500 GHz)", "pattern", 2.5e9], ["3D pattern (f = 2.500 GHz)", "pattern3d", 2.5e9]], "per far-field frequency: its cuts and its 3D pattern");
  eq(kids[2].children[0].action, { kind: "result", file: "r.json", view: "currents", f: 2.4e9 }, "a current map focuses its frequency");
  eq(kids[4].action, { kind: "result", file: "r.json", view: "log" }, "the log is a leaf");
  eq(runChildren("r.json", null).map((k) => k.label), ["1D Results", "Tables", "Log"], "before the bundle is read: the fixed folders");
  const all = kids.flatMap((k) => [k.id, ...(k.children ?? []).map((c) => c.id)]);
  eq([all.length, new Set(all).size], [17, 17], "ids are unique within a run");
}

// flattening: levels, positions, the viewer's expand/collapse choices, defaults
const tree = [
  { id: "design", label: "Patch", action: { kind: "select", sel: { type: "design" } } },
  { id: "sec:components", label: "Components", section: "components", action: { kind: "section", section: "components" }, open: true, children: [
    { id: "folder:antenna", label: "antenna", action: { kind: "folder", path: "antenna" }, open: true, children: [
      { id: "part:0", label: "patch", sub: "copper", action: { kind: "select", sel: { type: "part", i: 0 } }, open: true, children: [
        { id: "prim:0:0", label: "Brick", action: { kind: "select", sel: { type: "primitive", i: 0, j: 0 } } },
      ] },
    ] },
    { id: "part:1", label: "substrate", sub: "FR4", action: { kind: "select", sel: { type: "part", i: 1 } } },
  ] },
  { id: "sec:results", label: "Results", section: "results", action: { kind: "section", section: "results" }, open: true,
    children: runNodes([{ file: "b.json", label: "Patch · 11:30", sub: "CPU", title: "" }, { file: "a.json", label: "Patch · 10:05", sub: "CPU", title: "" }],
      (f) => (f === "b.json" ? { farfield: [2.4e9], currents: [] } : null)) },
];
{
  const rows = flatten(tree, new Map());
  eq(ids(rows).slice(0, 7), ["design", "sec:components", "folder:antenna", "part:0", "prim:0:0", "part:1", "sec:results"], "depth first");
  eq(rows.map((r) => r.level).slice(0, 7), [1, 1, 2, 3, 4, 2, 1], "levels");
  eq([rows[2].pos, rows[2].size, rows[5].pos, rows[5].size], [1, 2, 2, 2], "posinset / setsize among siblings");
  eq(rows[4].expandable, false, "a leaf is not expandable");
  eq(rows.find((r) => r.id === "run:b.json").expanded, true, "the newest run is open");
  eq(rows.find((r) => r.id === "run:a.json").expanded, false, "older runs start closed");
  eq(rows.some((r) => r.id === "res:b.json:pattern:2400000000"), true, "the open run lists its far field");
  eq(rows.some((r) => r.id.startsWith("res:a.json")), false, "a closed run hides its views");
  eq(rows.find((r) => r.section === "components").section, "components", "sections keep data-node");
  const closed = flatten(tree, new Map([["folder:antenna", false], ["run:a.json", true]]));
  eq(ids(closed).includes("part:0"), false, "a collapsed folder hides its parts");
  eq(closed.find((r) => r.id === "folder:antenna").expanded, false, "and says so (aria-expanded)");
  eq(ids(closed).includes("grp:a.json:1d"), true, "a run opened by the viewer");
}

// the filter: every word, in the label or the sub line; ancestors shown, subtrees of a match kept
{
  eq(matchesFilter("", "x"), true, "empty filter matches");
  eq(matchesFilter("fr4 sub", "substrate", "FR4"), true, "words in label and sub, any order");
  eq(matchesFilter("rogers", "substrate", "FR4"), false, "no match");
  const rows = flatten(tree, new Map([["folder:antenna", false]]), "brick");
  eq(ids(rows), ["sec:components", "folder:antenna", "part:0", "prim:0:0"], "the path to a match, opened through a collapsed folder");
  const sec = flatten(tree, new Map(), "results");
  eq(ids(sec)[0], "sec:results", "a matching section");
  eq(ids(sec).includes("res:b.json:sparams"), true, "keeps everything under it");
  eq(ids(sec).includes("design"), false, "and drops the rest");
  eq(flatten(tree, new Map(), "far field 2.4").map((r) => r.id).at(-1), "res:b.json:pattern:2400000000", "result nodes filter too");
  eq(flatten(tree, new Map(), "nothing-like-this"), [], "no match: no rows");
}

// the arrow keys (WAI-ARIA tree pattern)
{
  const rows = flatten(tree, new Map());
  const at = (id) => rows.findIndex((r) => r.id === id);
  eq(treeKey(rows, 0, "ArrowDown"), { focus: 1 }, "down");
  eq(treeKey(rows, 0, "ArrowUp"), { focus: 0 }, "up stops at the top");
  eq(treeKey(rows, 3, "End"), { focus: rows.length - 1 }, "End");
  eq(treeKey(rows, 3, "Home"), { focus: 0 }, "Home");
  eq(treeKey(rows, at("part:0"), "ArrowRight"), { focus: at("prim:0:0") }, "right on an open node steps into it");
  eq(treeKey(rows, at("prim:0:0"), "ArrowRight"), null, "right on a leaf does nothing");
  eq(treeKey(rows, at("part:0"), "ArrowLeft"), { toggle: at("part:0") }, "left on an open node closes it");
  eq(treeKey(rows, at("prim:0:0"), "ArrowLeft"), { focus: at("part:0") }, "left on a leaf goes to its parent");
  eq(treeKey(rows, at("run:a.json"), "ArrowRight"), { toggle: at("run:a.json") }, "right on a closed node opens it");
  eq(treeKey(rows, 0, "ArrowLeft"), null, "left at the top level");
  eq(treeKey([], 0, "ArrowDown"), null, "an empty tree");
}

// several runs: plain click selects one, Ctrl/⌘ toggles, at most MAX_COMPARE
{
  eq(MAX_COMPARE, 8, "eight series colours");
  eq(pickRuns(["a"], "b", false), { files: ["b"], full: false }, "plain click: only that run");
  eq(pickRuns(["a"], "b", true), { files: ["a", "b"], full: false }, "Ctrl-click adds");
  eq(pickRuns(["a", "b"], "a", true), { files: ["b"], full: false }, "Ctrl-click removes (the next becomes the focused run)");
  eq(pickRuns(["a"], "a", true), { files: ["a"], full: false }, "the last run stays selected");
  eq(pickRuns(["a", "b", "c"], "d", true), { files: ["a", "b", "c", "d"], full: false }, "a fourth run is added");
eq(pickRuns([..."abcdefgh"], "i", true), { files: [..."abcdefgh"], full: true }, "a ninth run is refused");
}

// Examples: only the committed static bundles, even when other runs share their model ID.
{
  const models = [
    { key: "zz_ab", file: "zz_ab.design.json", kind: "design", model: { id: "zz-ab", name: "zz_ab" } },
    { key: "broken", file: "broken.design.json", kind: "design", error: "bad", model: { id: "broken", name: "b" } },
    { key: "patch_antenna", file: "patch_antenna.py", kind: "python", readonly: true, model: { id: "patch-antenna", name: "Patch" } },
  ];
  eq(isExample({ file: "zz-ab-1.json" }), false, "a design's run is not an example");
  eq(isExample({ file: "patch-antenna.json" }), true, "the shipped Python bundle is an example");
  eq(isExample({ file: "patch-antenna-my-run.json" }), false, "a user's run of the bundled model stays out");
  eq(designFor(models, "zz-ab")?.key, "zz_ab", "Open in designer finds the design");
  eq(designFor(models, "patch-antenna"), undefined, "no designer for a Python example");
  eq(designFor(models, "broken"), undefined, "nor for a design that does not load");
  eq(exampleSourceFor(models, "patch-antenna")?.key, "patch_antenna", "source lookup finds the Python model");
  const index = JSON.parse(readFileSync(join(root, "public/projects/index.json"), "utf8")).projects;
  eq(exampleEntries(index).length, index.length, "every committed bundle is an example");
  eq(exampleEntries([{ file: "zz-ab-1.json", model: "zz-ab" }, { file: "patch-antenna.json", model: "patch-antenna" },
    { file: "patch-antenna-my-run.json", model: "patch-antenna" }]).map((e) => e.file),
    ["patch-antenna.json"], "only the shipped file appears");
}

// a part dragged in the tree is not a file drop: the app-wide drop hint must not cover the tree
// (#87; the event-level checks are in check-run-context.mjs)
{
  const partDrag = readFileSync(join(root, "src/designer/NavTree.tsx"), "utf8").match(/const PART_DRAG = "([^"]+)"/)?.[1];
  eq(partDrag, "application/x-fairbeam-part", "the tree's drag type");
  eq(carriesFiles({ types: [partDrag] }), false, "a tree part drag is not a file drag");
  eq(carriesFiles({ types: ["Files"] }), true, "a file from the desktop is");
}

console.log(`navigation tree: ${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
