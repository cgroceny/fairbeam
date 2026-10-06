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

const presenter = createEtaPresenter();
assert.equal(presenter({ jobId: "run-1", port: 1, eta: sample(100, 100) }).state, "early",
  "show a point estimate until three fresh projections are available");
presenter({ jobId: "run-1", port: 1, eta: sample(200, 90) });
const stable = presenter({ jobId: "run-1", port: 1, eta: sample(300, 80) });
assert.equal(stable.state, "range");
assert.deepEqual(stable.rangeSeconds, [80, 100], "the range reports the recent projection envelope");
assert.ok(stable.displaySeconds >= 80 && stable.displaySeconds <= 83,
  "improving projections ease down with a maximum lag of 15 percent or 3 seconds");

const worse = presenter({ jobId: "run-1", port: 1, eta: sample(400, 160) });
assert.equal(worse.displaySeconds, 160, "a worsening raw projection is never smoothed away");
assert.deepEqual(worse.rangeSeconds, [80, 160], "the visible range always includes a worsening raw value");

const improved = presenter({ jobId: "run-1", port: 1, eta: sample(500, 10) });
assert.ok(improved.displaySeconds >= 10 && improved.displaySeconds <= 13,
  "improving projections are smoothed with at most a 3 second/15 percent lag");
assert.deepEqual(improved.rangeSeconds, [10, 20], "the presentation envelope clips stale forecasts to 2× the current estimate");

const changedPort = presenter({ jobId: "run-1", port: 2, eta: sample(600, 30) });
const subtleWorsening = createEtaPresenter();
subtleWorsening({ jobId: "small-rise", eta: sample(100, 30) });
const eased = subtleWorsening({ jobId: "small-rise", eta: sample(200, 20) });
assert.ok(eased.displaySeconds > 21, "fixture has a downward smoothing lag");
assert.equal(subtleWorsening({ jobId: "small-rise", eta: sample(300, 21) }).displaySeconds, 21,
  "a raw rise below the prior smoothed projection is also shown immediately");
assert.equal(changedPort.state, "early", "port changes reset the rolling range");
assert.equal(changedPort.displaySeconds, 30);
const changedBasis = presenter({ jobId: "run-1", port: 2, eta: sample(700, 25, { basis: "energy-anchor" }) });
assert.equal(changedBasis.state, "early", "basis changes reset the rolling range");
const changedJob = presenter({ jobId: "run-2", port: 2, eta: sample(800, 20, { basis: "energy-anchor" }) });
assert.equal(changedJob.state, "early", "job changes reset the rolling range");
const unknownConfidence = presenter({ jobId: "run-2", port: 2, eta: sample(900, 19, {
  basis: "energy-anchor", confidence: undefined,
}) });
assert.equal(unknownConfidence.state, "early", "missing confidence stays a point estimate instead of implying a stable range");

const bound = presenter({ jobId: "run-2", port: 2, eta: sample(900, 40, {
  basis: "timestep-limit", confidence: "bound", limit_s: 40, remaining_timesteps: 1000,
}) });
assert.equal(bound.state, "timestep-bound");
assert.equal(bound.limitSeconds, 40, "the hard-stop time stays distinct from a convergence projection");
assert.equal(bound.rangeSeconds, undefined);

const multiPort = presenter({ jobId: "run-3", port: 1, eta: sample(1000, 12, { job_eta_s: 44, ports_remaining: 2 }) });
assert.equal(multiPort.rawSeconds, 44, "use the whole-job projection for the headline estimate");
assert.equal(multiPort.portSeconds, 12, "retain the current-port projection in details");
assert.equal(multiPort.portsRemaining, 2);

const waiting = presenter({ jobId: "run-4", port: 1, eta: { estimate: true, end_db: -40, points: 1, timestep: 5, limit_s: 60 } });
assert.equal(waiting.state, "waiting");
assert.equal(waiting.limitSeconds, 60, "the timestep cap remains visible while a convergence estimate is unavailable");

const shortEstimate = { timesteps: [10, 20], seconds: [0.2, 0.8], mcps: 1, basis: "measured" };
setLanguage("en");
assert.equal(estimateText(shortEstimate), "< 1 s", "the English estimate copy comes from i18n");
setLanguage("tr");
assert.equal(estimateText(shortEstimate), "1 s'den kısa", "sub-second estimate copy is localized");
setLanguage("en");

const dock = readFileSync(new URL("../src/designer/RunDock.tsx", import.meta.url), "utf8");
assert.match(dock, /presentEta\(\{ jobId:/, "RunDock presents solver values through the bounded ETA presenter");
assert.match(dock, /job\(\)\.phase === "postprocessing"[\s\S]*?runDock\.eta\.postprocessing/, "postprocessing uses its own status copy");
assert.match(dock, /job\(\)\.phase === "exporting"[\s\S]*?runDock\.eta\.exporting/, "exporting uses its own status copy");
assert.match(dock, /<details class="rdk-eta-details">[\s\S]*?etaDetails\(\)/, "raw solver values remain expandable");

console.log("ETA presentation checks passed");
