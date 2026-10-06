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
console.log(`sweep tree: ${checks} checks passed`);
