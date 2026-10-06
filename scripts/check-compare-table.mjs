// Regression and optional benchmark for comparison tables with interpolated pattern cuts.
// node --experimental-strip-types scripts/check-compare-table.mjs [--benchmark]
import assert from "node:assert/strict";
import { compareTable, interp } from "../src/compare/series.ts";

function before(xLabel, x, ts, cols) {
  const step = Math.max(1, Math.ceil(x.length / 201));
  const rows = Array.from({ length: x.length }, (_, i) => i)
    .filter((i) => i % step === 0 || i === x.length - 1).map((r) => {
      const row = [x[r]];
      ts.forEach((_, i) => cols.forEach((c) => {
        const v = c.values(i)[r];
        row.push(Number.isFinite(v) ? v : "—");
      }));
      return row;
    });
  return { columns: [xLabel, ...ts.flatMap(() => cols.map((c) => c.label))],
    groups: [{ label: "", span: 1 }, ...ts.map((t) => ({ label: t.label, span: cols.length }))], rows };
}

for (const n of [0, 1, 200, 201, 202, 721, 10001]) {
  const x = Array.from({ length: n }, (_, i) => i / 2);
  const traces = [{ label: "A" }, { label: "B" }];
  let calls = 0;
  const cols = [{ label: "Gain", values: (i) => { calls++; return x.map((v, k) => k % 7 === 0 ? NaN : v + i); } },
    { label: "Missing", values: () => { calls++; return [Infinity, -Infinity]; } }];
  const expected = before("Angle", x, traces, cols);
  calls = 0;
  assert.deepEqual(compareTable("Angle", x, traces, cols), expected);
  assert.equal(calls, n ? 4 : 0, "each column is evaluated once, empty tables do no work");
  assert.deepEqual(compareTable("Angle", x, [], cols), before("Angle", x, [], cols));
}
// Rebuilding uses current values, with no cache retained across table invocations.
let current = [1];
const args = ["x", [0], [{ label: "A" }], [{ label: "y", values: () => current }]];
assert.equal(compareTable(...args).rows[0][1], 1);
current = [2];
assert.equal(compareTable(...args).rows[0][1], 2);
console.log("compare-table: exact output, bounded evaluation and fresh values passed");

if (process.argv.includes("--benchmark")) {
  for (const n of [361, 721]) {
    const x = Array.from({ length: n }, (_, i) => i * 360 / (n - 1));
    const traces = Array.from({ length: 8 }, (_, i) => ({ label: `Run ${i}` }));
    const ys = traces.map((_, i) => x.map((v) => Math.sin(v * Math.PI / 180) + i));
    const cols = [{ label: "Gain", values: (i) => interp(x, ys[i], x) }];
    const args = ["Angle", x, traces, cols];
    assert.deepEqual(compareTable(...args), before(...args));
    const measure = (fn) => {
      for (let i = 0; i < 5; i++) fn(...args);
      const times = Array.from({ length: 31 }, () => { const start = performance.now(); fn(...args); return performance.now() - start; }).sort((a, b) => a - b);
      return { medianMs: times[15], p95Ms: times[29] };
    };
    console.log(JSON.stringify({ samples: n, runs: 8, before: measure(before), after: measure(compareTable) }));
  }
}
