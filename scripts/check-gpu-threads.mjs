// Guard GPU thread-control visibility, explanatory copy, and submission thread counts.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const [dialog, panel, optimizer, enJson] = await Promise.all([
  readFile(new URL("../src/designer/RunDialog.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/runner/OptimizePanel.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/runner/optimize.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/i18n/en.json", import.meta.url), "utf8"),
]);
const en = JSON.parse(enJson);

// the note is the i18n key run.gpuNote (src/i18n/en.json), shown by the Run dialog and the optimizer
const note = "The GPU engine runs on the graphics card; threads only affect the CPU engine";
assert.equal(en["run.gpuNote"], note, "the GPU note's English text");
assert.equal(en["run.threads"], "Threads", "the Threads label's English text");
assert.match(dialog, /threads:\s*eng\(\)\s*===\s*"gpu"\s*\?\s*1\s*:\s*thr\(\)/);
// the note wraps (and carries the text as its title), never cut off in a narrow dialog
assert.match(dialog, /<Show when=\{eng\(\) === "cpu"\} fallback=\{<p class="dz-value dz-wrap" title=\{t\("run\.gpuNote"\)\}>\{t\("run\.gpuNote"\)\}/);
assert.match(panel, /<Show when=\{optEngine\(\) !== "gpu"\}>[\s\S]*?<span>\{t\("run\.threads"\)\}<\/span>[\s\S]*?<\/Show>/);
assert.ok(panel.includes('t("run.gpuNote")'), "optimizer GPU note is present");
assert.match(optimizer, /threadsForEngine\(optEngine\(\) \|\| "cpu", threads\(\) \|\| health\(\)\?\.default_threads \|\| 1\)/);
assert.match(optimizer, /return engine === "gpu" \? 1 : cpuThreads/);

console.log("GPU thread controls: 8 checks passed");
