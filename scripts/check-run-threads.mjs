import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chooseRunThreads, RUN_THREADS_KEY } from "../src/lib/generalSettings.ts";
import { autoThreads } from "../src/lib/autoThreads.ts";

class MemoryStorage {
  data = new Map();
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, String(value)); }
}

const storage = new MemoryStorage();
// Settings uses the old key; Run remembers its choice under a separate key.
storage.setItem("fairbeam.threads", "4");
assert.equal(storage.getItem(RUN_THREADS_KEY), null);
assert.equal(chooseRunThreads(16, 0, 0, 4, 8), 4);
assert.equal(chooseRunThreads(2, 0, 0, 4, 8), 2, "Settings default is clamped to CPU count");

storage.setItem(RUN_THREADS_KEY, "12");
const remembered = Number(storage.getItem(RUN_THREADS_KEY));
let live = chooseRunThreads(16, 0, remembered, 4, 8);
assert.equal(live, 12, "remembered Run choice wins over Settings");
assert.equal(chooseRunThreads(16, live, remembered, 4, 8), 12, "re-probe preserves the live Run choice");
assert.equal(storage.getItem(RUN_THREADS_KEY), "12", "probing does not overwrite the remembered choice");
assert.equal(chooseRunThreads(8, 0, remembered, 4, 8), 8, "remembered choice is clamped to CPU count");
assert.equal(chooseRunThreads(16, 0, 0, 4, 8), 4, "Settings default is used without a Run choice");
assert.equal(chooseRunThreads(16, 0, 0, 0, 8), 0, "Settings Auto (0) stays Auto");
assert.equal(chooseRunThreads(16, 0, 0, NaN, 8), 8, "server default is the final fallback");
assert.equal(chooseRunThreads(16, 0, 12, 0, 8), 12, "a remembered manual number beats Settings Auto");
assert.equal(chooseRunThreads(16, 0, 0, 4, 8, { remembered: true }), 0, "a remembered Auto beats a Settings number");
assert.equal(chooseRunThreads(16, 0, 12, 4, 8, { live: true }), 0, "a live Auto survives a re-probe");
assert.equal(chooseRunThreads(16, 6, 0, 0, 8, { live: true }), 6, "a live number wins");
const settingsDialog = readFileSync(new URL("../src/components/GeneralSettings.tsx", import.meta.url), "utf8");
const runDialog = readFileSync(new URL("../src/designer/RunDialog.tsx", import.meta.url), "utf8");
const designRun = readFileSync(new URL("../src/runner/designRun.ts", import.meta.url), "utf8");
assert.doesNotMatch(settingsDialog, /setThreads\(/, "changing a Settings default must not remember a Run choice");
assert.match(runDialog, /createSignal\(Math\.min\(health\(\)\?\.cpu_count \?\? 64, storedThreads\(\)\)\)/, "the dialog starts from the store choice: live, then remembered, then Settings");
assert.match(runDialog, /n >= 1 && n <= cpu\(\)\) setThreads\(n\)/, "invalid dialog edits must not be remembered");
assert.match(designRun, /if \(opts\.engine !== "gpu"\) setThreads\(opts\.threads\)/, "a GPU run must preserve the remembered CPU choice");

// the Run dialog's "Auto uses N threads" is the server's rule for this grid (it said 4 while the dock,
// started with the real cell count, said 8): the same table as python/tests/test_resources.py
const table = JSON.parse(readFileSync(new URL("../python/tests/fixtures/auto_threads.json", import.meta.url), "utf8"));
for (const [logical, physical, cells, expected] of table.cases) {
  assert.equal(autoThreads(logical, physical, cells), expected, `Auto for ${logical} CPUs, ${physical} cores, ${cells} cells`);
}
assert.equal(autoThreads(8, undefined, null), 4, "physical cores unknown: all logical CPUs count");
assert.match(runDialog, /autoThreads\(cpu\(\), health\(\)\?\.physical_cores, cells\(\)\)/, "the dialog resolves Auto with the grid it will send");
assert.match(runDialog, /run\.threads\.autoHint", \{ n: autoCount\(\) \}/, "the hint names that number, not the server's small-grid default");
assert.doesNotMatch(runDialog, /run\.threads\.autoHint", \{ n: health\(\)/, "no hint from default_threads");
assert.match(designRun, /\.\.\.\(nodes \? \{ cells: nodes \} : \{\}\)/, "the run sends the same cell count");

console.log("Run thread precedence and repeated probe passed");
