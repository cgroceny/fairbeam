// Far-field quantities and efficiencies (src/lib/farfieldQuantity.ts): the gain and realized-gain
// patterns against the exporter's gain_dbi / realized_gain_dbi of every example bundle, the total
// efficiency η_rad·(1 − |S11(f)|²), the driven port of multi-port runs, what is unavailable and why,
// the band-wide radiation efficiency (results.efficiency) when a bundle has it, the Efficiency view's
// data table, and the remembered choice. No DOM, no build.
//
//   node --experimental-strip-types scripts/check-farfield-quantities.mjs

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  drivenPort, drivenPorts, effectiveQuantity, efficiencyData, efficiencySweeps, farfieldSummary, gridMax, interpAt, mismatchAt, mismatchCurve,
  quantityAvailability, quantityGrid, quantityMax, quantityOffsetDb, toDb,
} from "../src/lib/farfieldQuantity.ts";
import { resultDataTable } from "../src/designer/resultData.ts";
import { losslessNote } from "../src/lib/run.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
let failures = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) { failures++; console.error(`FAIL ${what}`); }
};
const near = (got, want, tol, what) => check(Number.isFinite(got) && Number.isFinite(want) && Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} ± ${tol}`);

// ---- every example bundle with far fields: the pattern maxima reproduce the exporter's values
// (grid values are rounded to 0.01 dB and the efficiency to 1e-4, so within 0.01 dB)
const dir = join(root, "public/projects");
let entries = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json")) {
  const b = JSON.parse(readFileSync(join(dir, file), "utf8"));
  for (const ff of b.results?.farfield ?? []) {
    entries++;
    const at = `${file} ${ff.f / 1e9} GHz${ff.port ? ` P${ff.port}` : ""}`;
    near(gridMax(quantityGrid(b, ff, "directivity")), ff.dmax_dbi, 0.006, `${at}: directivity grid max = Dmax`);
    if (ff.gain_dbi === undefined) continue;
    check(quantityAvailability(b, ff, "gain").ok && quantityAvailability(b, ff, "realized").ok, `${at}: gain and realized gain are offered`);
    near(gridMax(quantityGrid(b, ff, "gain")), ff.gain_dbi, 0.01, `${at}: gain pattern max = gain_dbi`);
    near(gridMax(quantityGrid(b, ff, "realized")), ff.realized_gain_dbi, 0.01, `${at}: realized-gain pattern max = realized_gain_dbi`);
    near(quantityMax(b, ff, "gain"), ff.gain_dbi, 0.005, `${at}: gain scale top`);
    near(quantityMax(b, ff, "realized"), ff.realized_gain_dbi, 0.005, `${at}: realized-gain scale top`);
    // the driven port's own |S11|, interpolated linearly in |S11|² as the exporter does
    const pr = b.results.ports[String(ff.port ?? (b.ports.find((p) => p.excite) ?? b.ports[0]).number)];
    const g2 = interpAt(b.results.frequency, pr.s11_re.map((re, i) => re * re + pr.s11_im[i] ** 2), ff.f);
    near(mismatchAt(b, ff.f, drivenPort(b, ff)), 1 - g2, 1e-12, `${at}: mismatch efficiency of the driven port`);
    const s = farfieldSummary(b, ff);
    near(s.totalEff, ff.rad_efficiency * (1 - g2), 1e-12, `${at}: total efficiency = η_rad·(1 − |S11|²)`);
    near(ff.dmax_dbi + toDb(s.totalEff), ff.realized_gain_dbi, 0.005, `${at}: Dmax + total efficiency (dB) = realized gain`);
    check(s.gainDbi === ff.gain_dbi && s.realizedDbi === ff.realized_gain_dbi, `${at}: the card shows the bundle's gain values`);
    const peak = ff.directivity_dbi[ff.theta.indexOf(s.peak.theta)]?.[ff.phi.indexOf(s.peak.phi)];
    near(peak, gridMax(b.half_space ? ff.directivity_dbi.filter((_, i) => ff.theta[i] <= 90) : ff.directivity_dbi), 1e-9, `${at}: the main lobe is the pattern maximum`);
  }
  if (file === "patch-array-4x1.json") {
    const [p1, p2] = [b.results.farfield[0], b.results.farfield[1]];
    check(drivenPort(b, p2) === 2 && farfieldSummary(b, p2).port === 2, "a multi-port entry names its driven port");
    check(mismatchAt(b, p2.f, 2) !== mismatchAt(b, p1.f, 1), "each driven port uses its own reflection");
    check(JSON.stringify(drivenPorts(b)) === "[1,2,3,4]", "every driven port of a four-port run");
    check(efficiencyData(b).length === 4 && efficiencyData(b)[1].points.length === 1 && efficiencyData(b)[1].points[0].f === p2.f, "the Efficiency view: one curve and far-field point per driven port");
  }
  if (file === "helix-axial.json") {
    const ff = b.results.farfield[0];
    check(quantityAvailability(b, ff, "rhcp").ok && quantityGrid(b, ff, "rhcp") === ff.cp.rhcp_dbi, "RHCP draws the stored partial directivity");
    check(quantityMax(b, ff, "lhcp") === ff.dmax_dbi, "the circular parts share Dmax as their scale top");
  }
  if (file === "pyramidal-horn.json") {
    const ff = b.results.farfield[0];
    // since the waveguide port calibration (#208) the lossless horn balances: no over-unity flag
    const w = efficiencyData(b)[0].points[0].warning ?? "";
    check(!/above 100|over.?unity/i.test(w) && /lossless model/.test(w) && b.results.farfield[0].rad_efficiency_raw <= 1.005,
      `the calibrated horn balances (raw ${b.results.farfield[0].rad_efficiency_raw}); only the lossless-model note remains`);
    // the note is information: no over-unity banner or warning style (SpecPanel, Dock, FarfieldCard)
    check(b.results.farfield.every((f) => losslessNote(f)), "the horn's lossless notes are not warnings");
  }
}
check(entries >= 15, `the example bundles hold far fields (${entries})`);

// ---- synthetic: what is unavailable, and why
const f = [2e9, 2.5e9, 3e9];
const grid = [[1, 2], [3, 4]];
const base = (ff, extra = {}) => ({
  ports: [{ number: 1, excite: true }, { number: 2, excite: false }],
  results: {
    frequency: f,
    ports: { "1": { s11_re: [0.5, 0, 0.5], s11_im: [0, 0, 0], zin_re: [0, 0, 0], zin_im: [0, 0, 0], z_ref: 50 } },
    bands: [], signals: {},
    farfield: [{ f: 2.25e9, theta: [0, 90], phi: [0, 90], directivity_dbi: grid, dmax_dbi: 4, prad_w: 1, pacc_w: 1, rad_efficiency: 0.5, ...ff }],
    ...extra,
  },
  half_space: null,
});
/** the same with port 2 driven too (its own reflection) */
const twoPort = (ff, extra) => { const b = base(ff, extra); b.results.ports["2"] = { s11_re: [0.2, 0.2, 0.2], s11_im: [0.1, 0.1, 0.1], zin_re: [0, 0, 0], zin_im: [0, 0, 0], z_ref: 50 }; return b; };
{
  const b = base({});
  const ff = b.results.farfield[0];
  near(mismatchAt(b, ff.f, 1), 1 - 0.125, 1e-12, "|S11|² is interpolated linearly between samples (0.25 → 0 at the midpoint: 0.125)");
  near(quantityOffsetDb(b, ff, "gain"), toDb(0.5), 1e-12, "gain offset = 10·log10(η_rad)");
  near(quantityOffsetDb(b, ff, "realized"), toDb(0.5 * 0.875), 1e-12, "realized-gain offset = 10·log10(η_rad·(1 − |S11|²))");
  near(quantityGrid(b, ff, "realized")[1][1], 4 + toDb(0.4375), 1e-12, "the realized-gain grid is shifted by that offset");
  near(farfieldSummary(b, ff).totalEff, 0.4375, 1e-12, "total efficiency");
  check(farfieldSummary(b, ff).gainDbi !== null && Math.abs(farfieldSummary(b, ff).gainDbi - (4 + toDb(0.5))) < 1e-12, "a bundle without gain_dbi: gain computed");
  check(!quantityAvailability(b, ff, "rhcp").ok && effectiveQuantity(b, ff, "rhcp") === "directivity", "no CP data: RHCP unavailable, directivity drawn");
  const p2 = twoPort({ port: 2 });
  near(mismatchAt(p2, 2.25e9, drivenPort(p2, p2.results.farfield[0])), 1 - 0.05, 1e-12, "a port-2 entry uses port 2's reflection");
  check(JSON.stringify(mismatchCurve(b, 1).eta) === JSON.stringify([0.75, 1, 0.75]), "the mismatch curve over the band");
}
for (const eff of [null, 0, -0.2]) {
  const b = base({ rad_efficiency: eff });
  const ff = b.results.farfield[0];
  const g = quantityAvailability(b, ff, "gain"), r = quantityAvailability(b, ff, "realized");
  check(!g.ok && !r.ok && /radiation efficiency/.test(g.reason), `efficiency ${eff}: gain and realized gain unavailable, with the reason`);
  check(quantityGrid(b, ff, "gain") === ff.directivity_dbi && quantityMax(b, ff, "realized") === ff.dmax_dbi && effectiveQuantity(b, ff, "gain") === "directivity", `efficiency ${eff}: directivity drawn instead`);
  check(farfieldSummary(b, ff).totalEff === null && farfieldSummary(b, ff).gainDbi === null, `efficiency ${eff}: no total efficiency or gain`);
}
{
  const b = base({});
  b.results.ports = {};
  const ff = b.results.farfield[0];
  check(quantityAvailability(b, ff, "gain").ok && !quantityAvailability(b, ff, "realized").ok, "no S11: gain still, realized gain unavailable");
}

// ---- band-wide radiation efficiency (results.efficiency, docs/BUNDLE.md#efficiency)
{
  const sweep = { f: [2e9, 2.5e9, 3e9, 2.75e9], prad_w: [1, 1, 1, 1], pacc_w: [1, 1, 1, 1], rad_efficiency: [0.8, 0.9, 1.05, null], mirror_planes: 0, theta_step: 5, phi_step: 10, qa_warnings: ["radiation efficiency above 100 % at 1 of 4 frequencies"] };
  const b = base({}, { efficiency: [sweep] });
  const d = efficiencyData(b);
  check(d.length === 1 && d[0].band && d[0].band.warnings === 1, "a band-wide efficiency: one entry, the value above 100 % counted");
  near(d[0].band.total[0], 0.8 * 0.75, 1e-12, "band total efficiency at a sample of the S11 grid");
  check(Number.isNaN(d[0].band.total[3]) && Number.isNaN(d[0].band.rad[3]), "a null efficiency stays a gap");
  check(JSON.stringify(d[0].band.qa) === JSON.stringify(sweep.qa_warnings), "the sweep's qa_warnings reach the view");
  check(efficiencySweeps({ ...base({}), efficiency: [sweep] }).length === 0, "only results.efficiency is read (the documented location)");
  check(efficiencySweeps(base({}, { efficiency: [{ f: [1, 2], rad_efficiency: [0.5] }] })).length === 0, "a malformed sweep is ignored");
  check(efficiencyData(base({}))[0].band === null, "without it: far-field points only");
  const t = resultDataTable(b, "efficiency");
  check(JSON.stringify(t.header) === JSON.stringify(["f (GHz)", "Mismatch efficiency (%)", "Radiation efficiency (%)", "Total efficiency (%)"]), `efficiency table header: ${JSON.stringify(t.header)}`);
  const row = (ghz) => t.rows.find((r) => Math.abs(r[0] - ghz) < 1e-12);
  check(t.rows.length === 5 && t.rows.every((r, i) => i === 0 || r[0] > t.rows[i - 1][0]), "rows: the band, the band-wide and the far-field frequencies, sorted");
  near(row(2.25)[1], 87.5, 1e-9, "far-field row: mismatch efficiency interpolated");
  near(row(2.25)[2], 50, 1e-9, "far-field row: radiation efficiency");
  near(row(2.25)[3], 43.75, 1e-9, "far-field row: total efficiency");
  near(row(3)[2], 105, 1e-9, "band row: an efficiency above 100 % is kept (flagged in the view)");
  check(row(2.75)[2] === null, "band row: a null efficiency is an empty cell");
  const multi = resultDataTable(twoPort({ port: 1 }, { farfield: [{ ...base({}).results.farfield[0], port: 1 }, { ...base({}).results.farfield[0], port: 2 }] }), "efficiency");
  check(multi.header.includes("Total efficiency P2 (%)"), "multi-port: columns per driven port");
  const pat = resultDataTable(base({}), "pattern", undefined, { patternQuantity: "realized" });
  check(pat.header.at(-1) === "Realized gain (dBi)" && Math.abs(pat.rows[3].at(-1) - (4 + toDb(0.4375))) < 1e-12, "pattern data add the shown quantity's column");
  check(resultDataTable(base({ rad_efficiency: null }), "pattern", undefined, { patternQuantity: "gain" }).header.at(-1) === "Directivity (dBi)", "an unavailable quantity adds no column");
}

// ---- the choice is remembered for the session (sessionStorage; blocked storage still works)
{
  const store = new Map();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } });
  store.set("fairbeam:pattern-quantity", "realized");
  const m = await import("../src/lib/patternQuantityStore.ts");
  check(m.patternQuantity() === "realized", "a stored choice is read back");
  m.setPatternQuantity("gain");
  check(store.get(m.PATTERN_QUANTITY_KEY) === "gain" && m.patternQuantity() === "gain", "a new choice is stored");
  m.setPatternQuantity("bogus");
  check(m.patternQuantity() === "gain", "an unknown quantity is ignored");
  m.setEfficiencyUnit("db");
  check(store.get(m.EFFICIENCY_UNIT_KEY) === "db" && m.efficiencyUnit() === "db", "the efficiency unit is remembered");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("blocked"); } });
  m.setPatternQuantity("directivity");
  check(m.patternQuantity() === "directivity", "blocked storage: the choice still applies");
  delete globalThis.sessionStorage;
}

console.log(`check-farfield-quantities: ${checks - failures}/${checks} passed (${entries} far-field entries)`);
process.exit(failures ? 1 : 0);
