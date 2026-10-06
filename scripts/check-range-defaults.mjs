// Sweep and optimizer defaults (UX audit 2.4): a new range is a window around the current value,
// never the parameter's whole min..max; the parameter to vary is a geometric one, not f0.
//
//   node --experimental-strip-types scripts/check-range-defaults.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isFrequencyParam, isMeshParam, OPTIMIZE_SPAN, pickVaryParam, rangeAround, SWEEP_STEPS, sweepRange } from "../src/lib/rangeDefaults.ts";

// the dipole starter's parameters, as the designer stores them (f0 0.1..30 GHz, k 0.3..1.5)
const params = [
  { key: "f0", unit: "GHz", min: 0.1, max: 30 },
  { key: "k", unit: "", min: 0.3, max: 1.5 },
  { key: "w", unit: "mm" },
  { key: "g", unit: "mm" },
];

// frequency parameters are recognised by unit or by name
for (const p of [{ key: "f0", unit: "GHz" }, { key: "f_min" }, { key: "f_max" }, { key: "fc" }, { key: "freq" }, { key: "x", unit: "MHz" }])
  assert.equal(isFrequencyParam(p), true, `${p.key} is a frequency`);
for (const p of [{ key: "k" }, { key: "w", unit: "mm" }, { key: "feed_x", unit: "mm" }, { key: "eps_r" }, { key: "sub_h", unit: "mm" }])
  assert.equal(isFrequencyParam(p), false, `${p.key} is geometry`);
assert.equal(isMeshParam("cells_per_wavelength"), true);
assert.equal(isMeshParam("patch_w"), false);

// which parameter comes first
assert.equal(pickVaryParam(params).key, "k", "the first geometric parameter, not f0");
assert.equal(pickVaryParam(params, new Set(["k"])).key, "w", "the next unused one");
assert.equal(pickVaryParam([{ key: "f0", unit: "GHz" }]).key, "f0", "only a frequency left: better than nothing");
assert.equal(pickVaryParam(params, new Set(params.map((p) => p.key))), undefined);

// the sweep: current ±10 % in 5 steps, clipped to the limits
assert.equal(SWEEP_STEPS, 5);
assert.deepEqual(sweepRange(2.4, params[0]), { start: "2.16", stop: "2.64", steps: "5" }, "f0 is not 0.1..30");
assert.deepEqual(sweepRange(0.466, params[1]), { start: "0.4194", stop: "0.5126", steps: "5" });
assert.deepEqual(sweepRange(1.5, params[1]), { start: "1.35", stop: "1.5", steps: "5" }, "clipped at the maximum");
assert.deepEqual(sweepRange(0.3, params[1]), { start: "0.3", stop: "0.33", steps: "5" }, "clipped at the minimum");
assert.deepEqual(sweepRange(-4, { }), { start: "-4.4", stop: "-3.6", steps: "5" }, "a negative value keeps start < stop");
assert.deepEqual(sweepRange(0, {}), { start: "-0.1", stop: "0.1", steps: "5" }, "zero has no size: ±0.1");
assert.deepEqual(sweepRange(0, { min: 0, max: 10 }), { start: "0", stop: "1", steps: "5" }, "zero with limits: a tenth of their span");
for (const [v, p] of [[2.4, params[0]], [0.466, params[1]], [1.5, params[1]], [0.3, params[1]], [12, { min: 12, max: 12.5 }]]) {
  const r = sweepRange(v, p);
  assert.ok(Number(r.start) >= (p.min ?? -Infinity) && Number(r.stop) <= (p.max ?? Infinity), "inside the limits");
}
// the window never grows into the whole range of a parameter with wide limits
const wide = rangeAround(2.4, { min: 0.1, max: 30 }, 0.1);
assert.ok(wide[1] - wide[0] < 1, `a window, not 0.1..30: ${wide}`);

// the optimizer: ±20 %
assert.equal(OPTIMIZE_SPAN, 0.2);
assert.deepEqual(rangeAround(0.466, { min: 0.3, max: 1.5 }, OPTIMIZE_SPAN), [0.3728, 0.5592]);
assert.deepEqual(rangeAround(50, { int: true }, OPTIMIZE_SPAN), [40, 60], "whole numbers stay whole");
assert.deepEqual(rangeAround(1, { int: true, min: 1, max: 2 }, OPTIMIZE_SPAN), [1, 2], "whole bounds are at least one apart");

// the dialogs use them
const sweep = readFileSync(new URL("../src/designer/SweepDialog.tsx", import.meta.url), "utf8");
assert.ok(/pickVaryParam\(draft\.params\.filter/.test(sweep), "a new axis picks a geometric parameter");
assert.ok(!/p\.min \?\? names/.test(sweep) && !/start: "0"/.test(sweep), "no min..max or 0..1 defaults left in the sweep dialog");
assert.ok((sweep.match(/seedRange\(/g) ?? []).length >= 3, "a new axis, a changed parameter and a changed kind are all seeded");
const opt = readFileSync(new URL("../src/runner/optimize.ts", import.meta.url), "utf8");
assert.ok(/rangeAround\(currentValue\(s\)/.test(opt) && /defaultVarySpec\(numeric\(\), used\)/.test(opt), "the optimizer seeds ±20 % of a geometric parameter");

console.log("range defaults: sweep ±10 % x 5, optimizer ±20 %, geometric parameter first (dipole starter, clipping, zero, int)");
