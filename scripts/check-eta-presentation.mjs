import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEtaPresenter } from "../src/designer/etaPresentation.ts";
import { estimateText } from "../src/designer/meshStats.ts";
import { setLanguage } from "../src/i18n/index.ts";

const sample = (timestep, eta_s, overrides = {}) => ({
  estimate: true,
  end_db: -40,
  points: 4,
  timestep,
  eta_s,
  basis: "energy-fit",
  confidence: "medium",
  ...overrides,
});
/** energy readings: flat during the pulse, then falling by `slope` dB per reading */
const energy = (flat, falling, slope = 4) => [
  ...Array.from({ length: flat }, (_, i) => ({ ts: i * 500, db: -0.1 * i })),
  ...Array.from({ length: falling }, (_, i) => ({ ts: (flat + i) * 500, db: -(i + 1) * slope })),
];

// ---- nothing while the pulse runs or the decay has only begun (the 12 min / 2 min / 6 s jumps)
const presenter = createEtaPresenter();
const pulse = presenter({ jobId: "run-1", port: 1, eta: sample(1000, 760), energy: energy(3, 0), now: 100 });
assert.equal(pulse.state, "waiting", "no forecast while the energy is flat (the pulse is running)");
assert.equal(pulse.waitingFor, "decay");
const begun = presenter({ jobId: "run-1", port: 1, eta: sample(1500, 120), energy: energy(3, 2), now: 104 });
assert.equal(begun.state, "waiting", "8 dB below the peak is not enough to forecast");
const few = presenter({ jobId: "run-1", port: 1, eta: sample(500, 50), energy: energy(1, 0), now: 104 });
assert.equal(few.waitingFor, "samples", "one reading: waiting for readings");

// ---- then a range of finishing times that only narrows while the projections agree
const first = presenter({ jobId: "run-1", port: 1, eta: sample(2000, 20), energy: energy(3, 3), now: 108 });
assert.equal(first.state, "range", "12 dB below the peak and three readings after it: a forecast");
assert.deepEqual(first.rangeSeconds, [14, 30], "a medium-confidence projection of 20 s spans 0.7× to 1.5×");
const second = presenter({ jobId: "run-1", port: 1, eta: sample(2500, 15), energy: energy(3, 4), now: 112 });
// finish 127 lies inside [122, 138]: the new spread [122.5, 134.5] tightens it
assert.deepEqual(second.rangeSeconds, [10.5, 22.5], "the range narrows around a projection inside it");
const width = (r) => r.rangeSeconds[1] - r.rangeSeconds[0];
assert.ok(width(second) <= width(first), "never wider than before while the projections stay inside it");
const aged = presenter({ jobId: "run-1", port: 1, eta: sample(2500, 15), energy: energy(3, 4), now: 114 });
assert.deepEqual(aged.rangeSeconds, [8.5, 20.5], "the same projection later: the range is two seconds closer, no wider");
const third = presenter({ jobId: "run-1", port: 1, eta: sample(3000, 9), energy: energy(3, 5), now: 116 });
assert.ok(width(third) <= width(second) && third.rangeSeconds[0] <= 9 && third.rangeSeconds[1] >= 9, "keeps narrowing and holds the projection");
const outside = presenter({ jobId: "run-1", port: 1, eta: sample(3500, 60), energy: energy(3, 6), now: 120 });
assert.ok(outside.rangeSeconds[0] <= 60 && outside.rangeSeconds[1] >= 60, "a projection outside the range starts a new range around it");

// ---- resets, bounds and the multi-port projection
const changedPort = presenter({ jobId: "run-1", port: 2, eta: sample(100, 30), energy: energy(3, 0), now: 130 });
assert.equal(changedPort.state, "waiting", "a new port starts over (openEMS restarts the energy)");
const bound = presenter({ jobId: "run-2", port: 2, eta: sample(900, 40, {
  basis: "timestep-limit", confidence: "bound", limit_s: 40, remaining_timesteps: 1000,
}) });
assert.equal(bound.state, "timestep-bound");
assert.equal(bound.limitSeconds, 40, "the hard-stop time stays distinct from a convergence projection");
assert.equal(bound.rangeSeconds, undefined);
const multiPort = presenter({ jobId: "run-3", port: 1, eta: sample(1000, 12, { job_eta_s: 44, ports_remaining: 2 }), energy: energy(3, 4), now: 10 });
assert.equal(multiPort.rawSeconds, 44, "use the whole-job projection for the headline estimate");
assert.equal(multiPort.portSeconds, 12, "retain the current-port projection in details");
assert.equal(multiPort.portsRemaining, 2);
const waiting = presenter({ jobId: "run-4", port: 1, eta: { estimate: true, end_db: -40, points: 1, timestep: 5, limit_s: 60 } });
assert.equal(waiting.state, "waiting");
assert.equal(waiting.limitSeconds, 60, "the limit is known while no convergence estimate is");
const converged = presenter({ jobId: "run-5", eta: sample(4000, 0, { basis: "converged", confidence: "high" }) });
assert.equal(converged.state, "converged");

const shortEstimate = { timesteps: [10, 20], seconds: [0.2, 0.8], mcps: 1, basis: "measured" };
setLanguage("en");
assert.equal(estimateText(shortEstimate), "< 1 s", "the English estimate copy comes from i18n");
setLanguage("tr");
assert.equal(estimateText(shortEstimate), "1 s'den kısa", "sub-second estimate copy is localized");
setLanguage("en");

const dock = readFileSync(new URL("../src/designer/RunDock.tsx", import.meta.url), "utf8");
assert.match(dock, /presentEta\(\{ jobId:[^}]*energy: liveEnergy\(\) \}\)/, "RunDock presents solver values with the current port's energy readings");
assert.match(dock, /job\(\)\.phase === "postprocessing"[\s\S]*?runDock\.eta\.postprocessing/, "postprocessing uses its own status copy");
assert.match(dock, /job\(\)\.phase === "exporting"[\s\S]*?runDock\.eta\.exporting/, "exporting uses its own status copy");
assert.match(dock, /<details class="rdk-eta-details">[\s\S]*?etaDetails\(\)/, "raw solver values remain expandable");
assert.match(dock, /e\.state === "range" && !!e\.rangeSeconds && e\.limitSeconds < e\.rangeSeconds\[1\]/,
  "the time to the timestep limit shows only when it comes before the forecast end");

console.log("ETA presentation checks passed");
