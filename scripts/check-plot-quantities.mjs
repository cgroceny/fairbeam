import assert from "node:assert/strict";
import { plotQuantities } from "../src/charts/plotQuantities.ts";

const input = [
  { id: "S11", label: "S11", color: "--al-series-1", x: [1, 2, 3], re: [3, 0, NaN], im: [4, 2, 1] },
  { id: "S21", label: "S21", color: "--al-series-2", x: [1, 2, 3], re: [1, Infinity, 0], im: [0, 1, 0] },
];
const formats = ["db", "db_phase", "re_im", "mag_phase", "all"];
const shape = { db: ["db"], db_phase: ["db", "phase"], re_im: ["re_im"], mag_phase: ["mag", "phase"], all: ["db", "phase", "re_im", "mag"] };
for (const format of formats) {
  const groups = plotQuantities(input, format);
  assert.deepEqual(groups.map(g => g.key), shape[format], `${format} plot quantity order`);
  assert.equal(groups[0].series.length, format === "re_im" ? 4 : 2);
  for (const g of groups) for (const s of g.series) assert.equal(s.y.length, 3);
}
const db = plotQuantities([input[0]], "db")[0].series[0].y;
assert.equal(db[0], 20 * Math.log10(5), "dB calculated from direct complex sample");
assert.equal(db[1], 20 * Math.log10(2), "dB calculated without an inverse conversion");
assert.ok(Number.isNaN(db[2]), "nonfinite complex input creates a plot gap");
const phase = plotQuantities([input[0]], "db_phase")[1].series[0].y;
assert.deepEqual(phase.slice(0, 2), [53.13010235415598, 90]);
const ri = plotQuantities([input[0], input[1]], "re_im")[0].series;
assert.deepEqual(ri.slice(0, 2).map(s => s.y), [[3, 0, NaN], [4, 2, NaN]], "Re and Im are plotted separately and invalid samples are gaps");
assert.notEqual(ri[0].dash, ri[1].dash, "real and imaginary traces have distinct strokes");
const compared = plotQuantities([
  { ...input[0], label: "S21 · run A", dash: undefined },
  { ...input[1], label: "S21 · run B", dash: "6 4" },
], "re_im")[0].series;
assert.equal(compared[0].color, "--al-series-1");
assert.equal(compared[2].color, "--al-series-2");
assert.equal(compared[0].dash, undefined, "Re remains solid in run A");
assert.equal(compared[2].dash, undefined, "Re remains solid in run B");
assert.equal(compared[1].dash, "6 4", "Im is dashed in run A");
assert.equal(compared[3].dash, "6 4", "Im is dashed in run B");
assert.equal(plotQuantities([{ ...input[0], id: "2,2", label: "S22" }], "db")[0].kind, "reflection", "any diagonal Sij is a reflection trace");
assert.equal(plotQuantities(input, "plot", "phase")[0].key, "phase", "As plotted follows the legacy phase switch");
console.log("plot quantities: analytic complex values, format order, nonfinite gaps and comparison strokes OK");
