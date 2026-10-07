// The numbers the designer shows about a run of the design: the mesh readouts and the solver-time
// estimate come from the draft's own preview (never a run's results shown in the 3D view) with the
// draft's own timestep limit.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { estimateTime } from "../src/designer/meshStats.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// ---- the estimate: a bundle's limit only when the caller does not know the run's own
const line = (n, step) => Array.from({ length: n }, (_, i) => i * step);
const preview = {
  units: { length_m: 1e-3 },
  solver: { excitation: { f_min: 1.7e9, f_max: 3.2e9 }, max_timesteps: 2000 },
  mesh: { x: line(60, 1), y: line(60, 1), z: line(40, 1), total_cells: 59 * 59 * 39 },
};
const capped = estimateTime(preview, "cpu", 1);
assert.equal(capped.capped, true, "a bundle with a 2000 step limit is capped");
const free = estimateTime(preview, "cpu", 1, { maxTimesteps: null });
assert.equal(free.capped, false, "a draft without its own limit is not capped by the shown bundle's");
assert.ok(free.timesteps[1] > 2000, "the range is no longer cut at the shown run's limit");
const own = estimateTime(preview, "cpu", 1, { maxTimesteps: 1000 });
assert.equal(own.capped, true, "a limit the draft sets caps the estimate");
assert.ok(own.timesteps.every((n) => n <= 1000));

// ---- every designer readout of the draft's mesh reads the draft's preview
const draftMesh = read("src/designer/draftMesh.ts");
assert.match(draftMesh, /meshStats\(draftPreview\(\)\)/, "draftMeshStats reads the draft's preview");
assert.match(draftMesh, /maxTimesteps: draft\.simulation\.max_timesteps \?\? null/, "the estimate takes the draft's own timestep limit");
for (const file of ["src/designer/RunDialog.tsx", "src/designer/MeshView.tsx", "src/designer/SimSettingsDialog.tsx", "src/designer/StatusBar.tsx",
  "src/designer/DesignWorkspace.tsx", "src/designer/SweepDialog.tsx", "src/designer/RunDock.tsx", "src/runner/designRun.ts"]) {
  const text = read(file);
  assert.doesNotMatch(text, /meshStats\(bundle\(\)\)|estimateTime\(bundle\(\)|bundle\(\)\?\.mesh\?\.auto/, `${file}: no mesh numbers from the viewer's bundle`);
}
const store = read("src/runner/store.ts");
assert.match(store, /if \(appMode\(\) === "design"\) setDraftPreview\(b\);/, "every preview shown in the designer is the draft's preview");
assert.match(store, /export const forgetPreviewFailure = \(\) => \{ setPreviewFailure\(null\); setDraftPreview\(null\); \};/,
  "another document forgets the previous draft's preview");
const designerStore = read("src/designer/store.ts");
assert.doesNotMatch(designerStore, /quickBundle\([^)]*, bundle\(\)\)/, "the browser-built preview borrows the draft's mesh, not a shown run's");
console.log("run numbers: estimates and mesh readouts from the draft passed");

// ---- the live run views (runner/liveRun.ts)
const { pulseNote, runFraction, pastSolver, decayEstablished } = await import("../src/runner/liveRun.ts");
const info = { pulse_steps: 1876, max_timesteps: 30000 };
// a fast GPU run: the solver summary (6,600 timesteps) arrives with "calculating results", no progress line
assert.equal(pulseNote(info, null, { timesteps: 6600 }, "postprocessing", "running"), null, "no excitation note once the solver finished");
assert.equal(pulseNote(info, { timestep: 2500 }, {}, "running", "running"), null, "no note past the pulse end");
assert.deepEqual(pulseNote(info, { timestep: 500 }, {}, "running", "running"), { kind: "running", end: 1876, left: 1376 });
assert.equal(pulseNote(info, null, {}, "setup", "running"), null, "the note belongs to the FDTD phase");
assert.equal(pulseNote(info, null, {}, "running", "running"), null, "no timestep reading yet (a short run often ends before the first one): no '0 of 1,876' note");
assert.equal(pulseNote(info, null, { timesteps: 1000 }, "running", "done"), null, "nothing after the run");
assert.deepEqual(pulseNote({ pulse_steps: 40000, max_timesteps: 30000 }, null, {}, "running", "running"), { kind: "overLimit", pulse: 40000, limit: 30000 });
assert.equal(pastSolver("exporting", "running"), true);
assert.equal(pastSolver("running", "running"), false);
// the progress: not 0 % for a whole run whose energy is still flat
const run = { status: "running", phase: "running" };
assert.ok(runFraction(run, { timestep: 1391, energy_db: 0, energy_fraction: 0, timestep_fraction: 0.0023 }, { max_timesteps: 600000 }) > 0.05,
  "the solver phase counts even while the energy is flat");
const decaying = runFraction(run, { timestep: 9000, energy_fraction: 0.74, eta: { target_timestep: 12000 } }, {});
assert.ok(decaying > 0.7 && decaying < 0.92, "energy decay and the projected end move the bar inside the solver's share");
assert.equal(runFraction({ status: "running", phase: "postprocessing" }, null, {}), 0.92);
assert.equal(runFraction({ status: "done", phase: "done" }, null, {}), 1);
assert.equal(runFraction({ status: "queued", phase: "queued" }, null, {}), 0);
const port2 = runFraction(run, { timestep: 100, energy_fraction: 0.5, port_run: 2, port_total: 2 }, {});
assert.ok(port2 > runFraction(run, { timestep: 100, energy_fraction: 0.5, port_run: 1, port_total: 2 }, {}), "the second port continues where the first ended");
assert.equal(decayEstablished([{ ts: 0, db: 0 }, { ts: 1, db: -5 }, { ts: 2, db: -11 }]), true);
assert.equal(decayEstablished([{ ts: 0, db: 0 }, { ts: 1, db: -1 }, { ts: 2, db: -2 }]), false);

const dock = read("src/designer/RunDock.tsx");
const card = read("src/runner/ProgressCard.tsx");
const bar = read("src/designer/StatusBar.tsx");
assert.match(dock, /runFraction\(job\(\), liveProgress\(\), liveInfo\(\)\)/, "the dock's bar uses the phase-aware fraction");
assert.match(bar, /runFraction\(j, liveProgress\(\), liveInfo\(\)\)/, "the status bar's percentage is the dock's");
for (const [name, text] of [["RunDock", dock], ["ProgressCard", card]]) {
  assert.match(text, /livePulseNote\(liveInfo\(\), liveProgress\(\), liveStats\(\), job\(\)\.phase, job\(\)\.status\)/, `${name}: the excitation note knows the phase`);
  assert.match(text, /fmt\.int\(endDb\(\)\)/, `${name}: the end criterion is written with the typographic minus`);
  assert.doesNotMatch(text, /\{ db: endDb\(\) \}/, `${name}: no raw end criterion in a text`);
  assert.match(text, /t\("runDock\.stopRun"\)/, `${name}: the button says Stop run`);
  assert.doesNotMatch(text, /t\("common\.cancel"\)/, `${name}: one verb for stopping a run`);
}
assert.match(dock, /if \(pts\.length < 2\) return \[\];/, "the energy chart appears with two readings");
assert.match(read("src/charts/useSize.ts"), /requestAnimationFrame\(apply\)/, "chart resizes are applied a frame later (no ResizeObserver loop)");
const queue = read("src/runner/RunQueue.tsx");
assert.match(queue, /if \(engine === "gpu"\) return "GPU";/, "a GPU run shows its engine, not a thread count");
assert.doesNotMatch(queue + read("src/runner/RunHistory.tsx"), /threadsShort", \{ n: j(\(\))?\.threads \}/, "no raw thread counts in the run rows");
assert.match(card, /engineThreadsText\(liveInfo\(\)\.engine \?\? job\(\)\.engine/, "the Run panel names the engine instead of 'Threads 1' for a GPU run");
const en = JSON.parse(read("src/i18n/en.json"));
assert.equal(en["status.queue.busyQueued"], "Busy · {count} queued", "the status bar's queue item stays short");
assert.ok(!("dock.cancelRun" in en), "the dock header says Stop run too");
const css = read("src/styles/designer-sim.css");
assert.match(css, /\.sb-fixed \{ flex: none; \}/, "the status bar's right group never shrinks");
assert.match(bar, /class="sb-item sb-btn sb-fixed sb-server"/, "the server item is in the fixed group");
assert.match(css, /\.rdk-run \{[^}]*min-height: fit-content;/, "the live panel is as tall as its fields");
console.log("run numbers: live panel, progress and status bar passed");

// ---- the Simulation ribbon and the run texts: one number format
const { setLanguage } = await import("../src/i18n/index.ts");
const { shown } = await import("../src/designer/displayNumber.ts");
const { energyTextUi, convergenceTextUi } = await import("../src/lib/runText.ts");
setLanguage("tr");
assert.equal(`${shown(Number((299.792458 / 3).toPrecision(5)))}–${shown(Number((299.792458 / 1).toPrecision(5)))}`, "99,931–299,79", "the λ readout in Turkish notation");
setLanguage("en");
assert.equal(energyTextUi({ db: -50, bound: true, timestep: null }), "≤ −50.0 dB", "the run card's energy takes the typographic minus in English too");
assert.equal(energyTextUi({ db: -65.94, bound: false, timestep: 10842 }), "−65.9 dB at timestep 10,842");
assert.doesNotMatch(convergenceTextUi({ converged: false, final_energy_db: -22.1, timesteps: 5000, energy_trace: [{ timestep: 4800, db: -22.1 }] }, -50), /-\d/, "no hyphen-minus before a number in the English summary");
const ws = read("src/designer/DesignWorkspace.tsx");
assert.match(ws, /return f && f > 0 \? fmt\(Number\(\(299\.792458 \/ f\)\.toPrecision\(5\)\)\) : "—";/, "the λ readout uses the locale formatter");
assert.match(ws, /solverLimitsTitle", \{ db: fmt\(draft\.simulation\.end_criteria_db \?\? -60\), steps: draft\.simulation\.max_timesteps \? i18nFmt\.int\(/,
  "the Solver limits tooltip: minus sign and grouped timesteps (automatic when unset)");
assert.match(ws, /<div class="rb-frequency" title=\{frequencyReadout\(\)\}>/, "the λ and mesh readout is the Frequency group's tooltip");
assert.doesNotMatch(ws, /<span class="rb-info mono" title=/, "no third line under the frequency fields (the Simulation tab kept the ribbon's height)");
assert.match(ws, /t\("ribbon\.sim\.meshManualLines", \{/, "the Mesh group names a manual mesh instead of an empty block");
const sim = read("src/designer/SimSettingsDialog.tsx");
assert.match(sim, /onKeyDown=\{onEnter\}/, "Enter in a field commits and closes the Simulation settings");
assert.match(sim, /t\("sim\.profile\.applied"/, "Apply setup confirms");
assert.match(sim, /title=\{runProfileSupported\(d\(\)\) \? undefined : t\("sim\.profile\.manual"\)\}/, "a disabled Apply says why");
console.log("run numbers: ribbon, settings dialog and run texts passed");



