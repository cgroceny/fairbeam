import assert from "node:assert/strict";
import { planParameterSweep } from "../src/designer/sweepPlan.ts";

const design = { params: [{ key: "w", default: 10, min: 1, max: 20 }, { key: "twice", expr: "w*2" }] };
const base = { schema: "fairbeam.parameter-sweep/1", sequences: [{ name: "A", axes: [{ key: "w", kind: "range", start: "w/2", stop: "20", steps: "3" }] }] };
const p = planParameterSweep(base, design, { w: 10, twice: 20 }, 2);
assert.equal(p.count, 3); assert.equal(p.sequences[0].sweep[0].start, 5); assert.equal(p.estimateSeconds, 6);
assert.match(planParameterSweep({ ...base, sequences: [{ name: "A", axes: [{ key: "twice", kind: "list", list: "1" }] }] }, design, { w: 10, twice: 20 }).error, /unknown or derived/);
assert.match(planParameterSweep({ ...base, sequences: [{ name: "A", axes: [{ key: "w", kind: "list", list: "1,21" }] }] }, design, { w: 10 }).error, /above maximum/);
assert.match(planParameterSweep({ ...base, sequences: [{ name: "A", axes: [{ key: "w", kind: "range", start: "1", stop: "20", steps: "501" }] }] }, design, { w: 10 }).error, /1 to 500/);
assert.equal(planParameterSweep({ ...base, sequences: [...base.sequences, { name: "B", axes: [{ key: "w", kind: "list", list: "w / 2, 10" }] }] }, design, { w: 10 }).count, 5);
assert.match(planParameterSweep({ ...base, sequences: [...base.sequences, base.sequences[0]] }, design, { w: 10 }).error, /Duplicate sequence name/);
assert.match(planParameterSweep({ ...base, sequences: [{ name: "A", axes: [{ key: "w", kind: "range", start: "10", stop: "10.0000000001", steps: "3" }] }] }, design, { w: 10 }).error, /duplicate values/);
// server parity: sequence and axis caps, int parameters take whole samples only
import { MAX_SWEEP_SEQUENCES, MAX_SEQUENCE_AXES } from "../src/designer/sweepPlan.ts";
assert.equal(MAX_SWEEP_SEQUENCES, 100); assert.equal(MAX_SEQUENCE_AXES, 6);
const manySeq = Array.from({ length: 101 }, (_, i) => ({ name: `S${i}`, axes: [{ key: "w", kind: "list", list: "10" }] }));
assert.match(planParameterSweep({ ...base, sequences: manySeq }, design, { w: 10 }).error, /101 sequences; maximum is 100/);
assert.equal(planParameterSweep({ ...base, sequences: manySeq.slice(0, 100) }, design, { w: 10 }).count, 100);
const ints = new Set(["w"]);
assert.match(planParameterSweep({ ...base, sequences: [{ name: "A", axes: [{ key: "w", kind: "range", start: "1", stop: "2", steps: "3" }] }] }, design, { w: 10 }, null, null, ints).error, /1\.5 must be a whole number/);
assert.equal(planParameterSweep({ ...base, sequences: [{ name: "A", axes: [{ key: "w", kind: "range", start: "1", stop: "5", steps: "5" }] }] }, design, { w: 10 }, null, null, ints).count, 5);
assert.match(planParameterSweep({ ...base, sequences: [{ name: "A", axes: [{ key: "w", kind: "list", list: "2, 2.5" }] }] }, design, { w: 10 }, null, null, ints).error, /2\.5 must be a whole number/);
assert.equal(planParameterSweep({ ...base, sequences: [{ name: "A", axes: [{ key: "w", kind: "range", start: "1", stop: "2", steps: "3" }] }] }, design, { w: 10 }).count, 3, "a design's (float) parameter takes any sample");
// the running total stops at the first sequence over the cap, like the server
const big = { name: "B", axes: [{ key: "w", kind: "range", start: "1", stop: "20", steps: "300" }] };
assert.match(planParameterSweep({ ...base, sequences: [big, { ...big, name: "C" }] }, design, { w: 10 }).error, /600 cells; maximum is 500/);
console.log("sweep planner checks passed");
