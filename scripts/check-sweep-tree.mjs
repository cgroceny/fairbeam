import { resultNodes, flatten, pickRuns } from "../src/designer/navModel.ts";

let checks = 0;
const eq = (got, want, label) => {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${label}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
};
const runs = ["normal-new.json", "sweep-b.json", "sweep-a.json", "normal-old.json"].map((file) => ({ file, label: file, sub: "", title: file }));
const jobs = [
  { model: "other", bundle: "sweep-b.json", status: "done", created: 20, sweep: { id: "wrong-model", name: "Other", total: 2 } },
  { model: "m", bundle: "sweep-b.json", status: "done", created: 20, sweep: { id: "stable", name: "Param", total: 3, index: 1 } },
  { model: "m", bundle: "sweep-a.json", status: "done", created: 10, sweep: { id: "stable", name: "Param", total: 3, index: 0 } },
  { model: "m", status: "failed", created: 30, sweep: { id: "stable", name: "Param", total: 3 } },
];
const nodes = resultNodes(runs, jobs, "m", () => null);
eq(nodes.map(n => n.id), ["run:normal-new.json", "sweep:stable", "run:normal-old.json"], "stable group at newest member position; normal peers retained");
eq(nodes[1].sub, "3 runs · failed · 2 done · 1 failed", "partial and failed group status/count");
eq(nodes[1].children.map(n => n.action), [{ kind: "run", file: "sweep-a.json" }, { kind: "run", file: "sweep-b.json" }], "group children retain run-focus actions, in sweep.index order (#151)");
eq(nodes[1].action, { kind: "sweep", id: "stable" }, "group action opens all-run view, without selecting a run");
const rows = flatten([{ id: "sec:results", label: "Results", action: { kind: "section", section: "results" }, open: true, children: nodes }], new Map(), "Param");
eq([rows.some(r => r.id === "sweep:stable"), rows.some(r => r.id === "run:sweep-b.json"), rows.some(r => r.id === "run:sweep-a.json")], [true, true, true], "filter keeps sweep and its navigable run descendants");
eq(pickRuns([], "sweep-a.json", false), { files: ["sweep-a.json"], full: false }, "child remains ordinary focused run");
const waiting = resultNodes([], [{ model: "m", status: "queued", created: 40, sweep: { id: "pending", name: "New", total: 2 } }], "m", () => null);
eq(waiting.map(n => [n.id, n.sub]), [["sweep:pending", "2 runs · in progress · 0 done"]], "queued sweep appears before first result");

// every sweep point is named by its value, also the one at the design's own value (no parameter of
// its own in the index, so the name groups would tell it apart by engine and time)
const { runRows, sweepPointText } = await import("../src/designer/navModel.ts");
const entries = [
  { file: "dip-a.json", name: "Dip C", model: "dip_c", created: "2026-10-06T23:39:01+0300", simulated: true, bands: [], cells: 1, engine: "CUDA", params: { k: 0.4194 } },
  { file: "dip-b.json", name: "Dip C", model: "dip_c", created: "2026-10-06T23:39:20+0300", simulated: true, bands: [], cells: 1, engine: "CUDA", params: {} },
  { file: "dip-c.json", name: "Dip C", model: "dip_c", created: "2026-10-06T23:39:40+0300", simulated: true, bands: [], cells: 1, engine: "CUDA", params: { k: 0.5126 } },
  { file: "dip-solo.json", name: "Dip C", model: "dip_c", created: "2026-10-06T22:00:00+0300", simulated: true, bands: [], cells: 1, engine: "CPU", params: {} },
];
const points = new Map([["dip-a.json", { k: 0.41941 }], ["dip-b.json", { k: 0.46597 }], ["dip-c.json", { k: 0.51262 }]]);
const labelled = Object.fromEntries(runRows(entries, "dip_c", new Map(), points).map((r) => [r.file, r.label]));
eq(labelled["dip-b.json"], "Dip C · k=0.466", "the middle point is named by its value, not 'CUDA · time'");
eq([labelled["dip-a.json"], labelled["dip-c.json"]], ["Dip C · k=0.4194", "Dip C · k=0.5126"], "its neighbours too, with four significant digits");
eq(labelled["dip-solo.json"] !== undefined && !labelled["dip-solo.json"].includes("k="), true, "a run outside the sweep keeps its usual label");
eq(sweepPointText({ w: 12, h: 1.6 }), "w=12, h=1.6", "several axes");

// a click opens or closes the folder; double-click or its menu compares all
const { readFileSync } = await import("node:fs");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const tree = read("src/designer/NavTree.tsx");
eq(/case "sweep": toggle\(r\); break;/.test(tree), true, "a single click on the sweep folder expands or collapses it");
eq(/onDblClick=\{a\.kind === "sweep" \? \(e\) => \{ e\.preventDefault\(\); openSweepView\(a\.id\); \}/.test(tree), true, "double-click compares all runs");
eq(/label:t\("tree\.sweep\.compareAllMenu"\),run:\(\)=>openSweepView\(a\.id\)/.test(tree), true, "the folder's menu offers Compare all runs");
eq(nodes[1].title.includes("double-click"), true, "the folder's tooltip says how to compare");

// the dialog: the engine and threads of its runs, an estimate that follows them, and one sweep at a time
const dialog = read("src/designer/SweepDialog.tsx");
eq(/onChange=\{\(e\) => setEngine\(e\.currentTarget\.value\)\}/.test(dialog) && /setThreads\(/.test(dialog), true, "engine and threads like Mesh convergence");
eq(/\(j\.engine \?\? "cpu"\) === eng\(\)/.test(dialog) && /draftEstimate\(eng\(\)\)/.test(dialog), true, "the estimate follows the engine");
eq(/disabled=\{submitting\(\) \|\| active\(\) \|\| !!plan\(\)\.error\}/.test(dialog), true, "Start waits while the sweep runs");
eq(/active\(\) \? t\("sweep\.running"[\s\S]*?t\("sweep\.runAgain"\)/.test(dialog), true, "'Running 2/3…', then 'Run again'");
// Compare all: the radiation efficiency, named and flagged above 100 %
const history = read("src/runner/RunHistory.tsx");
const en = JSON.parse(read("src/i18n/en.json"));
eq(/label: t\("runHistory\.col\.radEff"\)/.test(history) && en["runHistory.col.radEff"] === "η rad", true, "the column says η rad");
eq(/key === "eff" && v !== null && v > 100/.test(history), true, "values above 100 % are flagged");
console.log(`sweep tree: ${checks} checks passed`);
