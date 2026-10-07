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


