import assert from "node:assert/strict";
import { optimizationNodes, bestParameterChanges } from "../src/designer/optimizationResults.ts";

const opt = { method: "nelder-mead", max_evals: 40, vary: [{ key: "width", min: 1, max: 5 }], goals: [{ kind: "s11_max", target: -10, at: 2.45 }] };
const job = { id: "opt-1", kind: "optimize", status: "done", model: "design-a", created: 1, finished: 2, label: "Tune", name: "tune", optimize: opt,
  stats: { file: "optimizations/tune.json", best_file: "optimizations/tune/best.json", evaluations: 40, max_evals: 40 } };
const running = { ...job, id: "opt-2", status: "running", created: 5, finished: null, stats: { file: "optimizations/t2.json", evaluations: 14, max_evals: 40 } };
const runs = (id) => id === "opt-1" ? [{ index: 1, file: "optimizations/tune/1.json", label: "width=2 (evaluation 1)" }, { index: 2, file: "optimizations/tune/best.json", label: "width=3 (evaluation 2)" }] : [];
const nodes = optimizationNodes([job, { ...job, id: "other", model: "design-b" }, running], "design-a", runs);
assert.equal(nodes.length, 2, "a running and a finished optimization of this design");
assert.equal(nodes[0].id, "optimization:opt-2", "newest first");
assert.equal(nodes[0].label, "Nelder–Mead · |S11| ≤ -10 dB @ 2.45 GHz · 14/40 · running");
assert.equal(nodes[1].label, "Nelder–Mead · |S11| ≤ -10 dB @ 2.45 GHz · 40/40 · done");
assert.equal(nodes[0].action.kind, "optimization");
assert.deepEqual(nodes[0].children.map((c) => c.label), ["Progress"], "no best run yet, no evaluated runs known");
assert.deepEqual(nodes[1].children.map((c) => c.label), ["Progress", "Best result", "Evaluated runs"]);
assert.equal(nodes[1].children[0].action.kind, "optimization-history");
assert.equal(nodes[1].children[1].action.kind, "optimization-best");
assert.equal(nodes[1].children[1].action.file, "optimizations/tune/best.json");
assert.deepEqual(nodes[1].children[2].children.map((c) => c.action.file), ["optimizations/tune/1.json", "optimizations/tune/best.json"]);
assert.equal(nodes[1].children[2].children[1].sub, "best");
const cancelled = optimizationNodes([{ ...job, id: "stopped", status: "cancelled" }], "design-a");
assert.match(cancelled[0].label, /stopped$/, "a stopped optimization keeps its partial history");
assert.equal(cancelled[0].children[0].action.kind, "optimization-history");

// the tree filters by the design's file id (a job's `model`), not the design's model.id (#150 review)
const byFile = { ...job, id: "file-id", model: "zz_opt", model_id: "zz-opt" };
assert.equal(optimizationNodes([byFile], "zz_opt").length, 1, "jobs match the design file id");
assert.equal(optimizationNodes([byFile], "zz-opt").length, 0, "model.id is not the job's model key");
assert.equal(optimizationNodes([byFile], "").length, 0, "no open design file: no optimization rows");
const tree = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/designer/NavTree.tsx", import.meta.url), "utf8"));
assert.match(tree, /optimizationNodes\(jobs\(\), file\(\)\?\.id/, "NavTree passes the design file id");
assert.doesNotMatch(tree, /fetch\(`\/api\/optimizations/, "Save best goes through the runner store (JSON POST)");
assert.match(tree, /case "optimization-best": focusResult\(/, "Open best opens in the designer dock");
// the tree menu of an optimization node: Open, Apply best parameters, Stop while running, Delete record
for (const key of ["optTree.menu.open", "optTree.menu.apply", "optTree.menu.stop", "optTree.menu.delete"]) assert.ok(tree.includes(`t("${key}")`), `menu item ${key}`);
assert.match(tree, /sec\("optimizations"/, "Optimizations is its own tree folder");
assert.match(tree, /!isTerminal\(job\.status\)\) actions\.push\(\{ label: t\("optTree\.menu\.stop"\)/, "Stop only while running");
const actions = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/designer/optimizationActions.ts", import.meta.url), "utf8"));
assert.match(actions, /}, "", t\("tree\.history\.applyOptimization"\)\);/, "Apply best parameters is one named undo step");
const props = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/designer/PropsExtras.tsx", import.meta.url), "utf8"));
for (const key of ["optTree.menu.open", "optTree.menu.apply", "optTree.menu.stop", "optTree.menu.delete", "optTree.props.bounds", "optTree.props.bestParams"]) assert.ok(props.includes(`t("${key}")`), `Properties shows ${key}`);

const design = { params: [{ key: "width", default: 1 }, { key: "gap", default: 2 }] };
assert.deepEqual(bestParameterChanges(design, { width: 3.5 }), { ok: true, changes: { width: 3.5 } });
assert.equal(bestParameterChanges(design, { width: 3, missing: 4 }).ok, false, "unknown keys reject the entire apply");
assert.equal(bestParameterChanges(design, { width: Infinity }).ok, false, "non-finite values reject the entire apply");
assert.equal(bestParameterChanges({ params: [{ key: "width", default: 1, min: 0, max: 2 }] }, { width: 3 }).ok, false, "out-of-range values reject the entire apply");
console.log("Optimization results tree checks passed.");
