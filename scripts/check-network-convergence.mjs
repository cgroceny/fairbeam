// Pure request/report checks; no browser, process launch, network or solver.
import assert from "node:assert/strict";
import { networkRequest, newNetworkDraft, networkLabel, networkReason, networkReportRows } from "../src/designer/networkConvergence.ts";
import { verdictDetail } from "../src/designer/convergence.ts";
import { setLanguage, t } from "../src/i18n/index.ts";

const ports = [10, 20, 30];
const draft = newNetworkDraft(ports);
assert.deepEqual(networkRequest(false, "", [], []), {}, "opt-out never sends a field");
assert.deepEqual(networkRequest(true, "2.4", [draft], ports).request, { frequency_ghz: 2.4, metrics: ["coupling:20,10:0.2"] });
assert.deepEqual(networkRequest(true, "2.4", [{ ...draft, kind: "phase_balance", tolerance: "1" }], ports).request.metrics, ["phase:20,30,10:1"]);
assert.deepEqual(networkRequest(true, "2.4", [{ ...draft, kind: "s11" }], ports).request.metrics, ["s11:20:0.2"]);
const invalid = [
  ["", [draft], ports], ["Infinity", [draft], ports], ["1e308", [draft], ports], ["-1", [draft], ports],
  ["2.4", [], ports], ["2.4", Array(13).fill(draft), ports], ["2.4", [draft, draft], ports],
  ["2.4", [{ ...draft, tolerance: "0" }], ports], ["2.4", [{ ...draft, tolerance: "" }], ports],
  ["2.4", [{ ...draft, output: "2" }], ports], ["2.4", [{ ...draft, kind: "directivity", reference: "20" }], ports],
];
const criterion = { key: "coupling:20,10", kind: "coupling", ports: [20, 10], tolerance: 0.2, unit: "dB" };
const config = { frequency_hz: 2.4e9, criteria: [criterion] };
const measurement = { ...config, values: [{ value: 20, reason: null }], solver_converged: true };
const check = { ...criterion, before: 20, after: 21, delta: 1, ok: false, reason: null };
const base = {
  network_criteria: config,
  members: [15, 20].map(density => ({ density, status: "done", metrics: { network: structuredClone(measurement) } })),
  convergence: { reason: "exhausted", tolerances: { f_pct: 0.5, s11_db: 1, dmax_db: 0.2 }, verdict: "not converged: refine further or check the model", steps: [{ from: 15, to: 20, ok: { f: true, s11: true, dmax: null }, quality: { energy: true, local_mesh: true }, network: { checks: [check], converged: false, reason: null } }] },
};
let checks = 4;
for (const language of ["en", "tr"]) {
  setLanguage(language);
  for (const args of invalid) { assert.ok(networkRequest(true, ...args).error); assert.equal(networkRequest(true, ...args).request, undefined); checks += 2; }
  const rows = networkReportRows(base);
  assert.equal(rows[0].status, t("conv.net.first"));
  assert.equal(rows[1].status, t("conv.no"));
  assert.equal(rows[1].delta, 1);
  assert.ok(verdictDetail(base).includes(networkLabel(criterion)));
  for (const failure of ["column", "previous-column", "energy", "solver-energy", "missing", "nonfinite", "frequency", "criterion"]) {
    const study = structuredClone(base);
    if (failure === "column") study.members[1].metrics.network.values[0] = { value: null, reason: "requested excitation column is absent" };
    if (failure === "energy") { study.convergence.steps[0].quality.energy = false; study.convergence.steps[0].network.checks[0].ok = true; }
    if (failure === "solver-energy") { study.members[1].metrics.network.solver_converged = false; study.convergence.steps[0].network.checks[0].ok = true; }
    if (failure === "previous-column") study.convergence.steps[0].network.checks[0].reason = "requested excitation column is absent";
    if (failure === "missing") delete study.members[1].metrics.network;
    if (failure === "nonfinite") study.members[1].metrics.network.values[0].value = NaN;
    if (failure === "frequency") study.members[1].metrics.network.frequency_hz = 3e9;
    if (failure === "criterion") study.members[1].metrics.network.criteria[0].key = "coupling:30,10";
    const row = networkReportRows(study)[1];
    assert.notEqual(row.status, t("conv.yes"));
    assert.equal(row.status, t(failure.includes("energy") ? "conv.net.unverified" : "conv.net.unavailable"));
    if (failure === "column") assert.equal(row.reason, t("conv.net.reason.column"));
    checks += 2;
  }
  assert.equal(networkReason("energy convergence missing"), t("conv.net.reason.energy"));
  assert.equal(networkReason("unrecognized diagnostic"), "unrecognized diagnostic");
  assert.ok(!verdictDetail(base).includes("conv.net."));
  checks += 7;
}
setLanguage("en");
console.log(`network convergence: ${checks} request/report checks passed (EN/TR; no browser or solver)`);
