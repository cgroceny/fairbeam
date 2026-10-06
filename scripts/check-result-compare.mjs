import assert from "node:assert/strict";
import { compareSParams, compareSParamQuantities, traceLabels, traces } from "../src/compare/series.ts";

const model = (id, name, params) => ({
  model: { id, name, params: params.map(([key, value, unit = ""]) => ({ key, value, unit })) },
  name: `${id} run`,
});

const sameModel = [
  model("patch", "Patch", [["W", 20, "mm"], ["L", 30, "mm"]]),
  model("patch", "Patch", [["W", 24, "mm"], ["L", 30, "mm"]]),
];
assert.deepEqual(traceLabels(sameModel), ["W=20 mm", "W=24 mm"]);
assert.equal(traceLabels([
  model("patch", "Patch", [["W", 20, "mm"]]),
  model("patch", "Patch", [["W", 20, "mm"]]),
]).every((label) => label.includes("patch run")), true);
const crossModel = traceLabels([
  model("patch", "Patch", [["W", 20, "mm"]]),
  model("dipole", "Dipole", [["W", 20, "mm"]]),
]);
assert.ok(crossModel[0].includes("patch"));
assert.ok(crossModel[1].includes("dipole"));
assert.deepEqual(traceLabels([
  model("patch", "Patch", [["W", 20, "mm"]]), model("dipole", "Dipole", [["W", 20, "mm"]]),
], ["Local run · Current project", "Foreign run · Other project"]),
["Local run · Current project", "Foreign run · Other project"], "cross-project caller labels retain project and run identities");
// identical-parameter runs of one design (a re-run, CPU vs GPU) are told apart by the run names the
// designer passes, not by a "(2)" suffix
const reruns = traceLabels([
  model("patch", "Patch", [["W", 20, "mm"]]),
  model("patch", "Patch", [["W", 20, "mm"]]),
], ["Patch · 00:04:41 · CPU", "Patch · 00:04:42 · CUDA"]);
assert.deepEqual(reruns, ["Patch · 00:04:41 · CPU", "Patch · 00:04:42 · CUDA"]);
assert.ok(reruns.every((label) => !/\(\d\)$/.test(label)));
// multi-port comparison: every picked S_ij of every run, run colour + pair dash, "|Sij| · <run>"
const f = [1e9, 2e9, 3e9];
const c = (re, im = 0) => ({ re: f.map(() => re), im: f.map(() => im) });
const mp = (w, s) => ({
  model: { id: "coupler", name: "Coupler", params: [{ key: "W", value: w, unit: "mm" }] }, name: `coupler ${w}`, ports: [{ number: 1, excite: true }],
  results: { frequency: f, ports: { "1": { s11_re: c(0.1).re, s11_im: c(0).im, zin_re: f.map(() => 50), zin_im: f.map(() => 0), z_ref: 50 } }, sparams: { ports: Object.keys(s).length > 4 ? [1, 2, 3] : [1, 2], z_ref: 50, excited: [1], s } },
});
const two = mp(10, { "1,1": c(0.1), "2,1": c(0.5), "1,2": c(0.5), "2,2": c(0.1) });
const three = mp(12, { "1,1": c(0.2), "2,1": c(0.6), "1,2": c(0.6), "2,2": c(0.2), "3,1": c(0, 0.5), "1,3": c(0, 0.5), "3,3": c(0.3) });
const ts = traces(three, [two]);
const db = compareSParams(ts, [[2, 1], [3, 1]], "db");
assert.deepEqual(db.series.map((s) => s.label), ["|S21| · W=12 mm", "|S31| · W=12 mm", "|S21| · W=10 mm"], "a pair the two-port run lacks is left out for it");
assert.deepEqual(db.series.map((s) => s.color), ["--al-series-1", "--al-series-1", "--al-series-2"], "colour follows the run");
assert.deepEqual(db.series.map((s) => s.dash), [undefined, "6 4", undefined], "dash follows the picked pair");
assert.ok(Math.abs(db.series[2].y[1] - 20 * Math.log10(0.5)) < 1e-9, "|S21| in dB");
const ph = compareSParams(ts, [[3, 1]], "phase");
assert.equal(ph.series[0].label, "∠S31 · W=12 mm");
assert.ok(ph.series[0].y.every((v) => Math.abs(v - 90) < 1e-9), "phase in degrees");
const quantities = compareSParamQuantities(ts, [[2, 1], [3, 1]], "all");
assert.deepEqual(quantities.map((g) => g.key), ["db", "phase", "re_im", "mag"], "comparison quantities have independent axes in format order");
const realImag = quantities.find((g) => g.key === "re_im").series;
assert.equal(realImag.length, 6, "only pairs stored in each compared run are drawn");
assert.deepEqual(realImag[0].y, [0.6, 0.6, 0.6], "complex real samples interpolate directly onto the union frequency grid");
assert.deepEqual(realImag[1].y, [0, 0, 0], "complex imaginary samples interpolate directly onto the union grid");
assert.notEqual(realImag[0].dash, realImag[1].dash, "Re and Im have distinct strokes within a run");
assert.equal(realImag[4].color, "--al-series-2", "run colors remain stable through Re/Im charts");
console.log("result comparison labels and multi-port S_ij overlays: ok");
