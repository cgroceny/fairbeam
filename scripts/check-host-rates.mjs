import assert from "node:assert/strict";
import { median, pickHostRates } from "../src/lib/hostRates.ts";

const bench = { models: {
  a: [{ machine: "Apple M5 Pro", host_cpu: "Apple M5 Pro", engine: "cpu", mcells_s: 300 }, { machine: "Apple M5 Pro", host_cpu: "Apple M5 Pro", engine: "gpu", mcells_s: 1000 }],
  b: [{ machine: "Apple M5 Pro", host_cpu: "Apple M5 Pro", engine: "cpu", mcells_s: 100 }, { machine: "AMD", host_cpu: "AMD", engine: "cpu", mcells_s: 50 }, { machine: "x", host_cpu: null, engine: "cpu", mcells_s: null }],
} };
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([1, 2, 3, 10]), 2.5);
// 1. the machine's own runs
assert.deepEqual(pickHostRates({ cpu: { mcells_s: 180, runs: 4 } }, "Apple M5 Pro", bench).cpu, { mcps: 180, source: "runs", n: 4 });
// 2. the benchmark rows of the same machine name for the engine without runs
const r = pickHostRates({ cpu: { mcells_s: 180, runs: 4 } }, "Apple M5 Pro", bench);
assert.deepEqual(r.gpu, { mcps: 1000, source: "bench", n: 1 });
assert.deepEqual(pickHostRates(undefined, "Apple M5 Pro", bench).cpu, { mcps: 200, source: "bench", n: 2 });
// 3. otherwise nothing: the fixed 250 / 700 apply
assert.deepEqual(pickHostRates(undefined, "Unknown CPU", bench), {});
assert.deepEqual(pickHostRates(undefined, null, bench), {});
assert.deepEqual(pickHostRates({ cpu: { mcells_s: 0, runs: 1 } }, null, null), {});
console.log("host-aware throughput selection passed");
