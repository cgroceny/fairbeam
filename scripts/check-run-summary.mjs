// Result summaries in Design: the headline numbers of a run (src/designer/runSummary.ts)
// on the bundled example results and on edited copies, the Summary result tab's registration (focus,
// tabs, tree, ribbon, main area, Runs table), and the Copy / CSV table (English headers, decimal points).
// No DOM, no build.
//
//   node --experimental-strip-types scripts/check-run-summary.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleMetrics, deepestBand, deltaLabel, deltaText, indexMetrics, metricDeltas, metricsLine, oldestRunIndex, rawMetrics, referenceIndex, summaryTable } from "../src/designer/runSummary.ts";
import { activeResultDataTable, resultDataCsv, resultDataTable } from "../src/designer/resultData.ts";
import { isMainResultView, MAIN_RESULT_VIEWS, MAIN_TAB_LABELS } from "../src/designer/resultTabs.ts";
import { runChildren } from "../src/designer/navModel.ts";
import { bandsCsv, parseCsv } from "../src/export/csv.ts";
import { bandCentre, bandTexts, pickerBands } from "../src/lib/bands.ts";
import { columnDecimals } from "../src/lib/format.ts";
import { fmt, setDecimalChoice } from "../src/i18n/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8").replaceAll("\r\n", "\n");
const dir = join(root, "public/projects");
const load = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

// ---- the bundled examples: every run with results has a headline
const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
const metrics = new Map();
for (const f of files) {
  const b = load(f);
  const m = bundleMetrics(b);
  if (!b.results) { assert.equal(m, null, `${f}: a bundle without results has no headline`); continue; }
  metrics.set(f, m);
  const table = summaryTable([{ label: f, file: f, bundle: b }]);
  const csv = parseCsv(bandsCsv(b));
  for (const [i, band] of b.results.bands.entries()) {
    const prefix = b.results.bands.length > 1 ? `Band ${i + 1} ` : "Band ";
    for (const [name, column] of [["low (GHz)", 0], ["high (GHz)", 1], ["center (GHz)", 2], ["best match (GHz)", 3], ["bandwidth (MHz)", 6], ["fractional BW", 5]])
      assert.equal(table.rows[0][table.header.indexOf(prefix + name)], Number(csv[i + 1][column]), `${f}: Summary and bands.csv ${name}`);
    assert.equal(table.rows[0][table.header.indexOf(prefix + "edge low")], Number(band.edge_lo));
    assert.equal(table.rows[0][table.header.indexOf(prefix + "edge high")], Number(band.edge_hi));
  }
  assert.ok(m.f0 !== null && m.f0 > 0, `${f}: a resonance frequency`);
  assert.ok(m.s11MinDb !== null && m.s11MinDb < 0, `${f}: a negative |S11| minimum`);
  assert.equal(m.source, "bundle");
  assert.equal(m.quality?.verdict, "converged", `${f}: the verdict from runQuality`);
  assert.equal(m.cells, b.mesh.total_cells, `${f}: the cell count`);
  const band = deepestBand(b.results.bands);
  if (band) {
    assert.equal(m.f0, band.f_center, `${f}: the resonance is the deepest band's centre`);
    assert.equal(m.s11MinDb, band.s11_min_db);
    assert.equal(m.bwHz, band.f_hi - band.f_lo, `${f}: the bandwidth is the band's width`);
    assert.equal(m.bandCount, b.results.bands.length);
  }
  if (b.results.farfield?.length) {
    const ff = m.farfield;
    assert.ok(ff, `${f}: a far-field headline`);
    // the entry nearest the resonance
    const nearest = b.results.farfield.reduce((best, x) => (Math.abs(x.f - m.f0) < Math.abs(best.f - m.f0) ? x : best));
    assert.equal(ff.f, nearest.f, `${f}: the far field nearest the resonance`);
    assert.equal(ff.dmaxDbi, nearest.dmax_dbi);
    if (ff.realizedDbi !== null) assert.ok(ff.realizedDbi <= ff.dmaxDbi + 0.05, `${f}: realized gain does not exceed Dmax`);
    if (m.totalEff !== null) assert.ok(m.totalEff > 0 && m.totalEff <= 1.05, `${f}: total efficiency is a fraction`);
  } else {
    assert.equal(m.farfield, null, `${f}: no far field, no gain headline`);
  }
}
assert.ok(metrics.size >= 10, "the example bundles were read");

// known values (the committed example results)
{
  const dipole = metrics.get("dipole.json");
  near(dipole.f0, 2.415e9, 1, "dipole resonance");
  near(dipole.s11MinDb, -59.35, 1e-9, "dipole |S11| min");
  near(dipole.bwHz, 312.5e6, 1, "dipole bandwidth");
  near(dipole.farfield.dmaxDbi, 2.151, 1e-9, "dipole Dmax");
  near(dipole.farfield.realizedDbi, 2.143, 1e-9, "dipole realized gain");
  assert.ok(dipole.totalEff > 0.95 && dipole.totalEff <= 1, "dipole total efficiency");
  const patch = metrics.get("patch-antenna.json");
  near(patch.f0, 2.453e9, 1e6, "patch resonance");
  near(patch.bwHz, 37.5e6, 1, "patch bandwidth");
  const line = metrics.get("microstrip-line.json");
  assert.equal(line.farfield, null, "a transmission line has no far field");
  assert.equal(line.totalEff, null, "and no total efficiency");
}

// ---- the deepest band of a multi-band run, an edge band, and a run without a band
{
  const helix = load("helix-axial.json");
  assert.equal(helix.results.bands.length, 2, "the helix has two bands");
  const m = bundleMetrics(helix);
  assert.equal(m.f0, helix.results.bands[0].f_center, "the deeper band is the headline");
  assert.equal(m.bwAtEdge, true, "the helix's first band runs into the edge of the sweep");
  assert.equal(m.bands.length, 2, "both bands are kept for the bands table");
  const swapped = structuredClone(helix);
  swapped.results.bands[1].s11_min_db = -60;
  assert.equal(bundleMetrics(swapped).f0, swapped.results.bands[1].f_center, "the deepest band wins wherever it is");

  const none = structuredClone(load("patch-antenna.json"));
  none.results.bands = [];
  const n = bundleMetrics(none);
  assert.equal(n.bwHz, null, "no band, no bandwidth");
  assert.equal(n.bandCount, 0);
  assert.ok(n.f0 !== null && n.s11MinDb < 0, "the resonance is still the |S11| minimum");
  near(n.f0, 2.453e9, 5e6, "the minimum of the sweep is where the band was");

  const preview = structuredClone(load("patch-antenna.json"));
  delete preview.results;
  assert.equal(bundleMetrics(preview), null, "a geometry preview has no headline");
  assert.equal(rawMetrics({ nonsense: true }), null, "an odd file has no headline, and no exception");
  assert.equal(rawMetrics(null), null);

  // efficiency without a far field there: the band-wide efficiency at the resonance
  const bandWide = structuredClone(load("patch-antenna.json"));
  const f = bandWide.results.frequency;
  bandWide.results.farfield = [];
  bandWide.results.efficiency = [{ f, rad_efficiency: f.map(() => 0.8) }];
  const w = bundleMetrics(bandWide);
  assert.equal(w.farfield, null);
  assert.ok(w.totalEff > 0.7 && w.totalEff <= 0.8, "total efficiency from the band-wide radiation efficiency");

  const cut = structuredClone(load("patch-antenna.json"));
  cut.run.converged = false;
  assert.equal(bundleMetrics(cut).quality.verdict, "not-converged", "the quality verdict rides along");
}

// ---- the project index (a run nobody has read yet)
{
  const listed = JSON.parse(read("public/projects/index.json")).projects;
  for (const e of listed) {
    const im = indexMetrics(e);
    if (!e.simulated) { assert.equal(im, null, `${e.file}: not simulated`); continue; }
    const bm = metrics.get(e.file);
    if (!bm) continue;
    assert.equal(im.source, "index");
    assert.equal(im.bandCount, bm.bandCount, `${e.file}: the index counts the bands`);
    assert.equal(im.cells, e.cells);
    assert.equal(im.s11MinDb, null, "the index has no |S11| minimum");
    // the index lists the band centres in GHz (rounded), the first is the headline until the bundle is read
    if (bm.bands.length) near(im.f0, bm.bands[0].f_center, 0.5e6, `${e.file}: the index band centre`);
  }
  assert.equal(indexMetrics(undefined), null);
  assert.deepEqual(indexMetrics({ simulated: true, bands: [], cells: 10, quality: "suspicious" }).quality, { verdict: "suspicious", reasons: [] });
  assert.equal(indexMetrics({ simulated: true, bands: [], cells: 10 }).f0, null, "no band in the index, no resonance");
}

// ---- the tree line and the decimal separator
{
  const m = metrics.get("patch-antenna.json");
  assert.equal(metricsLine(m, fmt.fixed), "2.453 GHz · −34.5 dB · 6.8 dBi", "the tree line: resonance, |S11| min, Dmax");
  assert.equal(metricsLine(metrics.get("microstrip-line.json"), fmt.fixed).includes("dBi"), false, "no far field, no Dmax on the line");
  assert.equal(metricsLine(null, fmt.fixed), "");
  assert.equal(metricsLine(indexMetrics({ simulated: true, bands: [2.4], cells: 5 }), fmt.fixed), "2.400 GHz", "an index entry shows the band centre alone");
  setDecimalChoice("comma");
  assert.equal(metricsLine(m, fmt.fixed), "2,453 GHz · −34,5 dB · 6,8 dBi", "displayed numbers follow the Decimal separator setting");
  // exported data keeps the decimal point whatever is chosen
  const t = summaryTable([{ label: "A", file: "patch-antenna.json", bundle: load("patch-antenna.json") }]);
  for (const cell of t.rows[0]) assert.ok(cell === null || typeof cell === "number" || !/\d,\d/.test(cell), `exported cell ${cell} keeps the point`);
  setDecimalChoice("language");
}

// ---- Band exports: a committed band whose middle differs from best match, all open-edge states,
// and missing bands. The Summary CSV and copied TSV share the same numeric table.
{
  const dipole = load("dipole.json");
  const csv = parseCsv(bandsCsv(dipole));
  const col = (name) => Number(csv[1][csv[0].indexOf(name)]);
  assert.equal(col("f_center_GHz"), 2.43125, "dipole middle of the stored edges");
  assert.equal(col("f_best_GHz"), 2.415, "dipole best match is kept separately");
  near(col("fractional_bw"), 0.3125 / 2.43125, 1e-12, "dipole fractional bandwidth uses the middle");
  for (const edge_lo of [false, true]) for (const edge_hi of [false, true]) {
    const b = structuredClone(dipole);
    Object.assign(b.results.bands[0], { edge_lo, edge_hi });
    const band = parseCsv(bandsCsv(b))[1];
    assert.deepEqual(band.slice(0, 7), csv[1].slice(0, 7), "edge flags do not insert marks into numbers");
    assert.deepEqual(band.slice(7), [String(edge_lo), String(edge_hi)], "both open-edge flags survive CSV");
    const table = summaryTable([{ label: "Dipole", file: "dipole.json", bundle: b }]);
    const value = (name) => table.rows[0][table.header.indexOf(`Band ${name}`)];
    for (const [name, index] of [["low (GHz)", 0], ["high (GHz)", 1], ["center (GHz)", 2], ["best match (GHz)", 3], ["bandwidth (MHz)", 6], ["fractional BW", 5]])
      assert.equal(value(name), Number(band[index]), `Summary and bands.csv agree: ${name}`);
    assert.equal(value("edge low"), Number(edge_lo));
    assert.equal(value("edge high"), Number(edge_hi));
    const exported = parseCsv(resultDataCsv(table));
    assert.deepEqual(exported[1].slice(table.header.indexOf("Band low (GHz)"), table.header.indexOf("Band edge high") + 1),
      table.rows[0].slice(table.header.indexOf("Band low (GHz)"), table.header.indexOf("Band edge high") + 1).map(String), "Summary CSV preserves numeric band cells");
  }
  dipole.results.bands = [];
  assert.equal(parseCsv(bandsCsv(dipole)).length, 1, "no bands exports the header only");
  const none = summaryTable([{ label: "Empty", file: "empty.json", bundle: dipole }]);
  assert.ok(none.header.flatMap((h, i) => h.startsWith("Band ") ? [none.rows[0][i]] : []).every((v) => v === null), "missing band columns are empty");
  delete dipole.results;
  assert.equal(parseCsv(bandsCsv(dipole)).length, 1, "preview exports the same header only");
}

// ---- Copy / CSV: one row per run, English headers, differing parameters
{
  const a = load("patch-antenna.json");
  const b = structuredClone(a);
  b.model.params = b.model.params.map((p) => (p.key === a.model.params[0].key ? { ...p, value: typeof p.value === "number" ? p.value + 1 : p.value } : p));
  b.created = "2026-09-28T10:00:00+0300";
  const one = summaryTable([{ label: "Patch", file: "patch-antenna.json", bundle: a }]);
  assert.deepEqual(one.header.slice(0, 3), ["Run", "File", "Made"]);
  assert.equal(one.rows.length, 1);
  assert.equal(one.header.length, one.rows[0].length, "a cell for every header");
  assert.ok(one.header.includes("f res (GHz)") && one.header.includes("|S11| min (dB)") && one.header.includes("Total efficiency (%)"), "English headers with units");
  const col = (t, name, row = 0) => t.rows[row][t.header.indexOf(name)];
  near(col(one, "f res (GHz)"), 2.4525, 1e-9, "f res in GHz");
  near(col(one, "Bandwidth -10 dB (MHz)"), 37.5, 1e-9, "bandwidth in MHz");
  near(col(one, "Dmax (dBi)"), 6.789, 1e-9, "Dmax");
  assert.equal(col(one, "Verdict"), "converged");
  // the band as two numbers (a "2.098-2.287" text reads as a date or a subtraction in a spreadsheet)
  assert.equal(one.header.includes("Bands -10 dB (GHz)"), false, "no band range text");
  near(col(one, "Band low (GHz)"), a.results.bands[0].f_lo / 1e9, 1e-6, "the band's low edge");
  near(col(one, "Band high (GHz)"), a.results.bands[0].f_hi / 1e9, 1e-6, "the band's high edge");
  {
    const helix = load("helix-axial.json");
    const hb = summaryTable([{ label: "H", file: "helix-axial.json", bundle: helix }, { label: "P", file: "p.json", bundle: a }]);
    const names = ["low (GHz)", "high (GHz)", "center (GHz)", "best match (GHz)", "bandwidth (MHz)", "fractional BW", "edge low", "edge high"];
    assert.deepEqual(hb.header.filter((h) => h.startsWith("Band ")), [1, 2].flatMap((n) => names.map((name) => `Band ${n} ${name}`)), "numbered when a run has several bands");
    assert.equal(hb.rows[1][hb.header.indexOf("Band 2 low (GHz)")], null, "a run with fewer bands leaves the cells empty");
  }
  const key = a.model.params[0].key;
  assert.equal(one.header.some((h) => h.startsWith(key)), false, "one run has no differing parameter column");
  const two = summaryTable([{ label: "A", file: "a.json", bundle: a }, { label: "B", file: "b.json", bundle: b }]);
  assert.equal(two.rows.length, 2, "one row per run");
  assert.ok(two.header.some((h) => h.startsWith(`${key}`)), "the parameter that differs gets a column");
  assert.deepEqual(two.rows.map((r) => r[0]), ["A", "B"]);
  // the data plumbing the toolbar and the tree menu use
  const viaTool = activeResultDataTable(a, "summary", undefined, [{ file: "a.json", bundle: a }], { runNames: ["Patch run"] });
  assert.equal(viaTool.rows[0][0], "Patch run", "the toolbar names the run");
  assert.equal(viaTool.rows[0][1], "a.json");
  assert.equal(resultDataTable(a, "summary").rows.length, 1, "the tree menu exports the shown run");
  assert.equal(resultDataTable(a, "summary").rows[0][1], "");
  assert.deepEqual(resultDataTable({ ...a, results: undefined }, "summary").header, ["No result data"]);
  const csv = resultDataCsv(two);
  assert.ok(csv.startsWith("Run,File,Made,"), "CSV starts with the headers");
  assert.ok(csv.endsWith("\r\n"));
  assert.equal(csv.trim().split("\r\n").length, 3, "a header and two rows");
  // the Δ view adds Δ columns; the Values view (and one run) does not
  const plain = summaryTable([{ label: "A", file: "a.json", bundle: a }, { label: "B", file: "b.json", bundle: b }]);
  assert.equal(plain.header.some((h) => h.startsWith("Δ")), false, "no Δ columns in the Values view");
  const withD = summaryTable([{ label: "A", file: "a.json", bundle: a }, { label: "B", file: "b.json", bundle: b }], { deltas: true });
  const deltaHeaders = ["Δ f res (MHz)", "Δ |S11| min (dB)", "Δ Bandwidth -10 dB (MHz)", "Δ Dmax (dB)", "Δ Realized gain (dB)", "Δ Total efficiency (pp)", "Δ reference run"];
  assert.deepEqual(withD.header.slice(plain.header.length), deltaHeaders, "English headers with units, after the plain columns");
  assert.deepEqual(withD.header.slice(0, plain.header.length), plain.header, "the plain columns are unchanged");
  assert.equal(withD.header.length, withD.rows[0].length, "a cell for every header");
  assert.deepEqual(withD.rows[0].slice(plain.header.length), deltaHeaders.map(() => null), "the oldest run (a tie: the first) is the reference: empty Δ cells");
  assert.deepEqual(withD.rows[1].slice(0, plain.header.length), plain.rows[1], "the plain cells are unchanged");
  assert.deepEqual(withD.rows[1].slice(plain.header.length), [0, 0, 0, 0, 0, 0, "A"], "the same results: every Δ is 0, and the reference run is named");
  // real differences, in the units of the headers
  const c = structuredClone(a);
  c.results.bands[0].f_center += 12e6;
  c.results.bands[0].s11_min_db -= 0.4;
  c.results.bands[0].f_hi += 10e6;
  const tc = summaryTable([{ label: "A", file: "a.json", bundle: a }, { label: "C", file: "c.json", bundle: c }], { deltas: true });
  const dcol = (name) => tc.rows[1][tc.header.indexOf(name)];
  near(dcol("Δ f res (MHz)"), 12, 1e-9, "Δ resonance in MHz");
  near(dcol("Δ |S11| min (dB)"), -0.4, 1e-9, "Δ |S11| in dB");
  near(dcol("Δ Bandwidth -10 dB (MHz)"), 10, 1e-9, "Δ bandwidth in MHz");
  // a missing value leaves the cell empty, not zero
  const d2 = structuredClone(a);
  delete d2.results.farfield;
  const td = summaryTable([{ label: "A", file: "a.json", bundle: a }, { label: "D", file: "d.json", bundle: d2 }], { deltas: true });
  assert.equal(td.rows[1][td.header.indexOf("Δ Dmax (dB)")], null, "no far field, an empty Δ Dmax");
  assert.equal(td.rows[1][td.header.indexOf("Δ Total efficiency (pp)")], null);
  assert.notEqual(td.rows[1][td.header.indexOf("Δ |S11| min (dB)")], null);
  // one run has nothing to compare with
  const solo = summaryTable([{ label: "A", file: "a.json", bundle: a }], { deltas: true });
  assert.deepEqual(solo.header, one.header, "one run: no Δ columns even in the Δ view");
  // the toolbar's data path
  const tool = (deltas) => activeResultDataTable(a, "summary", undefined, [{ file: "a.json", bundle: a }, { file: "c.json", bundle: c }], { runNames: ["A", "C"], summaryDeltas: deltas });
  assert.equal(tool(false).header.includes("Δ f res (MHz)"), false);
  assert.equal(tool(undefined).header.includes("Δ f res (MHz)"), false, "Values is the default");
  assert.equal(tool(true).header.includes("Δ f res (MHz)"), true);
  // CSV with and without Δ: English headers, decimal points whatever the Decimal separator setting
  setDecimalChoice("comma");
  const csvD = resultDataCsv(tool(true));
  const csvV = resultDataCsv(tool(false));
  setDecimalChoice("language");
  const rowsOf = (x) => x.trim().split("\r\n");
  assert.ok(rowsOf(csvD)[0].endsWith(",Δ f res (MHz),Δ |S11| min (dB),Δ Bandwidth -10 dB (MHz),Δ Dmax (dB),Δ Realized gain (dB),Δ Total efficiency (pp),Δ reference run"), "CSV: the Δ headers end the header row");
  assert.equal(rowsOf(csvV)[0].includes("Δ"), false, "CSV without Δ has no Δ column");
  assert.equal(rowsOf(csvD).length, 3);
  assert.ok(/,12,-0\.4,10,/.test(rowsOf(csvD)[2]), `CSV: the Δ cells of run C use a decimal point: ${rowsOf(csvD)[2]}`);
  assert.equal(/\d,\d+"/.test(csvD) || /"\d+,\d/.test(csvD), false, "no decimal comma inside a quoted CSV cell");
  assert.ok(csvD.startsWith("Run,File,Made,"));
}

// ---- deltas against a reference run: the math, missing values, the sign text, the colour
{
  const base = metrics.get("patch-antenna.json");
  const withFf = (over) => ({ ...base, ...over, farfield: { ...base.farfield, ...(over.farfield ?? {}) } });
  const ref = withFf({ f0: 2.4e9, s11MinDb: -20, bwHz: 40e6, totalEff: 0.8, farfield: { dmaxDbi: 6, realizedDbi: 5, gainDbi: 5.5 } });
  const run = withFf({ f0: 2.412e9, s11MinDb: -20.4, bwHz: 50e6, totalEff: 0.823, farfield: { dmaxDbi: 6.6, realizedDbi: 4.2, gainDbi: 5 } });
  const d = metricDeltas(ref, run);
  near(d.f0.value, 12, 1e-6, "resonance delta in MHz");
  near(d.s11.value, -0.4, 1e-9, "|S11| delta in dB");
  near(d.bw.value, 10, 1e-6, "bandwidth delta in MHz");
  near(d.dmax.value, 0.6, 1e-9, "Dmax delta in dB");
  near(d.realized.value, -0.8, 1e-9, "realized gain delta in dB");
  near(d.eff.value, 2.3, 1e-9, "efficiency delta in percentage points");
  assert.deepEqual([d.f0.unit, d.s11.unit, d.bw.unit, d.dmax.unit, d.realized.unit, d.eff.unit], ["MHz", "dB", "MHz", "dB", "dB", "pp"]);
  // sign text: a plus, a real minus sign, the unit, and the display decimal setting
  assert.equal(deltaLabel("f0", d.f0, fmt.fixed), "+12 MHz");
  assert.equal(deltaLabel("s11", d.s11, fmt.fixed), "−0.4 dB");
  assert.equal(deltaLabel("bw", d.bw, fmt.fixed), "+10 MHz");
  assert.equal(deltaLabel("dmax", d.dmax, fmt.fixed), "+0.60 dB");
  assert.equal(deltaLabel("realized", d.realized, fmt.fixed), "−0.80 dB");
  assert.equal(deltaLabel("eff", d.eff, fmt.fixed), "+2.3 pp");
  assert.equal(deltaLabel("eff", d.eff, fmt.fixed, "puan"), "+2.3 puan", "the UI language's word for pp");
  assert.equal(deltaText("f0", 0.4, fmt.fixed), "+0.4", "a small shift keeps a decimal");
  assert.equal(deltaText("f0", 0.001, fmt.fixed), "0.0", "a difference that rounds to zero has no sign");
  assert.equal(deltaText("s11", -0.04, fmt.fixed), "0.0");
  assert.equal(deltaText("f0", -123.4, fmt.fixed), "−123");
  setDecimalChoice("comma");
  assert.equal(deltaLabel("s11", d.s11, fmt.fixed), "−0,4 dB", "displayed deltas follow the Decimal separator setting");
  assert.equal(deltaLabel("eff", d.eff, fmt.fixed, "puan"), "+2,3 puan");
  setDecimalChoice("language");

  // a run against itself: zero everywhere, all neutral
  const same = metricDeltas(ref, ref);
  for (const k of Object.keys(same)) { assert.equal(same[k].value, 0, `${k}: no difference`); assert.equal(same[k].tone, "neutral"); }

  // colour: lower |S11| and higher BW / Dmax / gain / efficiency are better; the resonance is never coloured
  assert.deepEqual(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.tone])),
    { f0: "neutral", s11: "neutral", bw: "better", dmax: "better", realized: "worse", eff: "better" },
    "-0.4 dB of |S11| is noise, +12 MHz of resonance is neutral, the rest is clear");
  const tone = (over, key) => metricDeltas(ref, withFf(over))[key].tone;
  assert.equal(tone({ s11MinDb: -25 }, "s11"), "better", "a deeper |S11| minimum is better");
  assert.equal(tone({ s11MinDb: -12 }, "s11"), "worse", "a shallower one is worse");
  assert.equal(tone({ bwHz: 20e6 }, "bw"), "worse");
  assert.equal(tone({ bwHz: 41e6 }, "bw"), "neutral", "2.5 % of the bandwidth is noise");
  assert.equal(tone({ farfield: { dmaxDbi: 5 } }, "dmax"), "worse");
  assert.equal(tone({ farfield: { realizedDbi: 5.4 } }, "realized"), "neutral", "0.4 dB of gain is noise");
  assert.equal(tone({ totalEff: 0.7 }, "eff"), "worse");
  assert.equal(tone({ totalEff: 0.805 }, "eff"), "neutral");
  assert.equal(tone({ f0: 3e9 }, "f0"), "neutral", "the resonance has no better or worse");
  // ambiguous: a run that did not converge, an efficiency above 100 %, a bandwidth that is only a lower bound
  const cut = { quality: { verdict: "not-converged", reasons: [] } };
  assert.equal(tone({ ...cut, s11MinDb: -30 }, "s11"), "neutral", "a run that did not converge is not judged");
  assert.equal(metricDeltas({ ...ref, ...cut }, run).bw.tone, "neutral", "nor is a reference that did not converge");
  assert.equal(tone({ quality: { verdict: "suspicious", reasons: [] }, bwHz: 80e6 }, "bw"), "neutral");
  assert.equal(tone({ totalEff: 1.2 }, "eff"), "neutral", "an efficiency above 100 % is not judged");
  assert.equal(tone({ farfield: { realizedDbi: 8 }, totalEff: 1.2 }, "realized"), "neutral");
  assert.equal(tone({ bwHz: 80e6, bwAtEdge: true }, "bw"), "better", "a lower bound above the reference is still wider");
  assert.equal(tone({ bwHz: 20e6, bwAtEdge: true }, "bw"), "neutral", "a lower bound below the reference proves nothing");
  assert.equal(metricDeltas({ ...ref, bwAtEdge: true }, withFf({ bwHz: 80e6 })).bw.tone, "neutral", "the reference is only a lower bound too");
  assert.equal(metricDeltas({ ...ref, bwAtEdge: true }, withFf({ bwHz: 20e6 })).bw.tone, "worse", "narrower than a lower bound is narrower");

  // missing values: no delta when either side lacks the number
  const bare = metricDeltas(ref, withFf({ bwHz: null, totalEff: null, farfield: { realizedDbi: null } }));
  assert.equal(bare.bw, null, "no bandwidth, no delta");
  assert.equal(bare.eff, null);
  assert.equal(bare.realized, null);
  assert.ok(bare.s11 && bare.dmax && bare.f0, "what both runs have keeps its delta");
  const line = metrics.get("microstrip-line.json");
  const noFar = metricDeltas(ref, line);
  assert.equal(noFar.dmax, null, "a run without a far field has no Dmax delta");
  assert.equal(noFar.realized, null);
  assert.equal(noFar.eff, null);
  assert.ok(noFar.s11, "|S11| min is still compared");
  const fromLine = metricDeltas(line, ref);
  assert.equal(fromLine.dmax, null, "and the reference's missing number blocks the delta the other way round");
  assert.equal(fromLine.eff, null);
  const idx = metricDeltas(ref, indexMetrics({ simulated: true, bands: [2.45], cells: 5 }));
  assert.equal(idx.s11, null, "an index entry has no |S11| minimum");
  assert.equal(idx.bw, null);
  assert.ok(idx.f0, "but it has a resonance");
  for (const v of Object.values(metricDeltas(null, ref))) assert.equal(v, null, "no reference, no deltas");
  for (const v of Object.values(metricDeltas(ref, null))) assert.equal(v, null);
  // NaN and Infinity never become a delta
  assert.equal(metricDeltas(ref, withFf({ s11MinDb: Number.NaN })).s11, null);
  assert.equal(metricDeltas(ref, withFf({ f0: Infinity })).f0, null);
}

// ---- no resonance in the band: the |S11| minimum at a band edge with nothing below -10 dB
{
  const a = load("patch-antenna.json");
  const n = a.results.frequency.length;
  const withCurve = (db) => {
    const b = structuredClone(a);
    b.results.bands = [];
    const p = Object.values(b.results.ports)[0];
    p.s11_re = db.map((x) => 10 ** (x / 20));
    p.s11_im = db.map(() => 0);
    return b;
  };
  const ramp = (from, to) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
  const falling = bundleMetrics(withCurve(ramp(-1, -6)));   // deepest at the last frequency
  assert.equal(falling.noResonance, true, "the minimum is the last frequency: no resonance");
  assert.equal(falling.f0, a.results.frequency[n - 1], "the point is still reported");
  assert.equal(bundleMetrics(withCurve(ramp(-6, -1))).noResonance, true, "the minimum is the first frequency");
  const dip = ramp(-2, -2).map((v, i) => v - 4 * Math.exp(-(((i - n / 2) / (n / 10)) ** 2)));   // -6 dB in the middle
  const inside = bundleMetrics(withCurve(dip));
  assert.equal(inside.noResonance, false, "a minimum inside the band is a resonance, matched or not");
  assert.ok(Math.abs(inside.f0 - a.results.frequency[Math.round(n / 2)]) <= 2 * (a.results.frequency[1] - a.results.frequency[0]), "the interior minimum is the resonance");
  assert.equal(bundleMetrics(a).noResonance, false, "a matched band is a resonance");
  const edgeBand = structuredClone(a);   // a -10 dB band that runs into the edge is a band, so the example is matched
  edgeBand.results.bands[0].edge_lo = true;
  assert.equal(bundleMetrics(edgeBand).noResonance, false, "a -10 dB band at the edge is not 'no resonance'");
  assert.equal(indexMetrics({ simulated: true, bands: [2.4], cells: 10, quality: "converged" }).noResonance, false, "an index entry knows no curve");
  // the words
  const en = JSON.parse(read("src/i18n/en.json"));
  assert.equal(en["summary.noResonance"], "no resonance in band (minimum at the band edge)");
  assert.ok(metricsLine(falling, fmt.fixed).startsWith(en["summary.noResonance"]), "the tree line says so instead of a frequency");
  assert.equal(metricsLine(inside, fmt.fixed).includes("no resonance"), false);
  // Copy / CSV leave the resonance empty and the differences against it out
  const t = summaryTable([{ label: "A", file: "a.json", bundle: withCurve(ramp(-1, -6)) }, { label: "B", file: "b.json", bundle: a }], { deltas: true });
  assert.equal(t.rows[0][t.header.indexOf("f res (GHz)")], null, "no resonance: an empty f res cell");
  assert.notEqual(t.rows[0][t.header.indexOf("|S11| min (dB)")], null, "the minimum itself is data");
  assert.equal(t.rows[1][t.header.indexOf("Δ f res (MHz)")], null, "no Δ resonance against a band edge");
  assert.equal(metricDeltas(falling, bundleMetrics(a)).f0, null);
  // Summary, Runs table, Properties and tree show it
  const has = (path, re, what) => assert.ok(re.test(read(path)), what);
  has("src/designer/RunSummaryView.tsx", /metrics\(\)\.noResonance[\s\S]*summary\.noResonance"\)\}/, "Summary: the card says no resonance");
  has("src/designer/RunSummaryView.tsx", /row\.m\?\.noResonance \? t\("summary\.noResonanceShort"\)/, "Summary: the comparison cell says no resonance");
  has("src/designer/RunDock.tsx", /m\(\)\?\.noResonance \? t\("summary\.noResonanceShort"\)/, "Runs table: the cell says no resonance");
  has("src/designer/PropsExtras.tsx", /x\?\.noResonance\) out\.push\(\[t\("summary\.f0"\), t\("summary\.noResonance"\)\]\)/, "Properties: the inspector says no resonance");
  has("src/designer/runSummary.ts", /if \(m\.noResonance\) parts\.push\(t\("summary\.noResonance"\)\)/, "the tree line says no resonance");
}

// ---- the reference run of the differences: not the first row (the newest run), a choice
{
  const a = load("patch-antenna.json");
  const older = structuredClone(a); older.created = "2026-09-01T10:00:00+0300"; older.results.bands[0].f_center -= 20e6;
  const newer = structuredClone(a); newer.created = "2026-09-02T09:00:00+0300"; newer.results.bands[0].f_center += 30e6;
  const middle = structuredClone(a); middle.created = "2026-09-01T18:00:00+0300";
  // rows in the order the Summary lists them: the run in focus (newest) first
  const runs = [{ label: "N", file: "newer.json", bundle: newer }, { label: "M", file: "middle.json", bundle: middle }, { label: "O", file: "older.json", bundle: older }];
  assert.equal(oldestRunIndex(runs), 2, "the oldest run");
  assert.equal(referenceIndex(runs), 2, "default: the oldest selected run");
  assert.equal(referenceIndex(runs.slice(0, 2)), 1, "the oldest of the selected, A or not");
  assert.equal(referenceIndex(runs, "middle.json"), 1, "a chosen run");
  assert.equal(referenceIndex(runs, "gone.json"), 2, "a run that is no longer compared falls back to the default");
  assert.equal(referenceIndex(runs, null), 2);
  assert.equal(oldestRunIndex([{ bundle: {} }, { bundle: {} }]), 0, "no times: the first");
  assert.equal(oldestRunIndex([{ bundle: { created: "x" } }, { bundle: { created: "2026-09-01T10:00:00+0300" } }]), 1, "an unreadable time is skipped");
  const fres = (t, row) => t.rows[row][t.header.indexOf("Δ f res (MHz)")];
  const ref = (t, row) => t.rows[row][t.header.indexOf("Δ reference run")];
  const byDefault = summaryTable(runs, { deltas: true });
  near(fres(byDefault, 0), 50, 1e-9, "default: the newest run is 50 MHz above the oldest");
  near(fres(byDefault, 1), 20, 1e-9, "default: the middle run is 20 MHz above the oldest");
  assert.equal(fres(byDefault, 2), null, "the reference run has no difference from itself");
  assert.deepEqual([ref(byDefault, 0), ref(byDefault, 1), ref(byDefault, 2)], ["O", "O", null], "the CSV names the reference");
  const chosen = summaryTable(runs, { deltas: true, reference: "newer.json" });
  assert.equal(fres(chosen, 0), null, "a chosen reference run");
  near(fres(chosen, 2), -50, 1e-9, "the oldest run is 50 MHz below the chosen one");
  assert.deepEqual([ref(chosen, 0), ref(chosen, 1), ref(chosen, 2)], [null, "N", "N"]);
  // the toolbar's path: Copy data and CSV follow the choice
  const tool = (reference) => activeResultDataTable(newer, "summary", undefined, runs.map((r) => ({ file: r.file, bundle: r.bundle })), { runNames: ["N", "M", "O"], summaryDeltas: true, summaryReference: reference });
  assert.equal(fres(tool(undefined), 2), null, "Copy / CSV: the default is the oldest run");
  assert.equal(fres(tool("newer.json"), 0), null, "Copy / CSV: the chosen run");
  assert.equal(ref(tool("middle.json"), 0), "M");
  // wiring: the selector, the memo, the data options
  const has = (path, re, what) => assert.ok(re.test(read(path)), what);
  has("src/designer/RunSummaryView.tsx", /referenceIndex\(rows\(\), summaryReference\(\)\)/, "the Summary table takes its reference from the choice");
  has("src/designer/RunSummaryView.tsx", /chooseSummaryReference\(e\.currentTarget\.value\)/, "the selector sets it");
  has("src/designer/RunSummaryView.tsx", /i === refIdx\(\) \? null : metricDeltas\(rows\(\)\[refIdx\(\)\]\.m, r\.m\)/, "every other run is compared with it");
  has("src/designer/ResultViews.tsx", /summaryReference: summaryReference\(\)/, "Copy data and CSV pass the choice");
  const en = JSON.parse(read("src/i18n/en.json")), tr = JSON.parse(read("src/i18n/tr.json"));
  for (const k of ["summary.reference.label", "summary.reference.option", "summary.noResonance", "summary.noResonance.title", "summary.noResonanceShort"]) assert.ok(en[k] && tr[k], `${k} in both languages`);
}

// ---- registration: the Summary tab is a main-area result view like Efficiency
{
  assert.ok(isMainResultView("summary") && MAIN_RESULT_VIEWS.includes("summary"), "it opens as a main-area tab");
  assert.equal(MAIN_TAB_LABELS.summary, "Summary");
  const en = JSON.parse(read("src/i18n/en.json"));
  const tr = JSON.parse(read("src/i18n/tr.json"));
  for (const k of ["results.tab.summary", "mainTabs.summary", "tree.result.summary", "ribbon.post.summary", "ribbon.post.summaryTitle", "runDock.runs.col.f0", "runDock.runs.col.s11", "runDock.runs.col.bw",
    "runDock.runs.col.dmax", "runDock.runs.col.eff", "runDock.runs.noDiff", "runDock.runs.openSummary", "summary.converged", "summary.f0", "summary.bandwidth", "summary.compare.differ", "summary.compare.same",
    "summary.delta.better", "summary.delta.diff", "summary.delta.pp", "summary.delta.worse", "summary.mode.delta", "summary.mode.hint", "summary.mode.label", "summary.mode.values"]) {
    assert.ok(en[k] && tr[k], `${k} in both languages`);
  }
  assert.equal(tr["mainTabs.summary"], "Özet");
  const has = (path, re, what) => assert.ok(re.test(read(path)), what);
  has("src/designer/resultFocus.ts", /"table" \| "summary" \| "log"/, "resultFocus: summary is a result view");
  has("src/designer/resultTabs.ts", /Extract<ResultView, [^>]*"summary">/, "resultTabs: summary is a main result view");
  has("src/designer/MainArea.tsx", /summary: "mainTabs\.summary"/, "MainArea: the tab's name");
  has("src/designer/ResultViews.tsx", /props\.view === "summary"\}><ResultSummary b=\{props\.b\} \/>/, "ResultViews: the tab draws the summary");
  has("src/designer/runResults.ts", /COMPARABLE = new Set<ResultView>\(\[[^\]]*"summary"\]/, "runResults: several runs can be selected under Summary");
  has("src/designer/DesignWorkspace.tsx", /label=\{t\("ribbon\.post\.summary"\)\}[^\n]*openRibbonResult\("summary"\)/, "Post-processing opens the Summary tab");
  has("src/designer/NavTree.tsx", /<span class="nt-metrics">\{r\.metrics\}<\/span>/, "the tree row shows the run's headline numbers");
  has("src/designer/runResults.ts", /resultNodes\([^\n]*metricsLine\(runMetricsOf\(file\), fmt\.fixed\)/, "the tree's numbers follow the Decimal separator (fmt.fixed)");
  has("src/designer/RunDock.tsx", /bundleRunMetrics\(r\.bundle\)/, "the Runs table reads the headline numbers");
  has("src/designer/RunDock.tsx", /runDock\.runs\.col\.f0[\s\S]*runDock\.runs\.col\.s11[\s\S]*runDock\.runs\.col\.bw[\s\S]*runDock\.runs\.col\.dmax[\s\S]*runDock\.runs\.col\.eff/, "the Runs table has the fixed metric columns");
  has("src/designer/ResultViews.tsx", /props\.view === "summary" \? \[\{ file: run\.file, bundle: run\.bundle \}\]/, "Copy data / CSV of a single run go through the summary table");
  // the tree lists it under Tables, before the sweep table
  const tables = runChildren("r.json", null).find((k) => k.id === "grp:r.json:tables");
  assert.deepEqual(tables.children.map((k) => k.action.view), ["summary", "table"], "Tables: Summary, then the S-parameter table");
}

// ---- the reference run select shows the reference (each option says so; a value set on the select before
// its options exist leaves the browser on the first option, the shown run), in EN and TR alike
{
  const view = read("src/designer/RunSummaryView.tsx");
  assert.ok(/<option value=\{row\.file\} selected=\{row\.file === refFile\(\)\}>/.test(view), "each option is selected when it is the reference");
  assert.equal(/<select[^>]*value=\{rows\(\)\[refIdx\(\)\]\.file\}/.test(view), false, "no value on the select itself");
  assert.ok(/const refFile = \(\) => rows\(\)\[refIdx\(\)\]\.file;/.test(view), "the reference is the run the differences are taken from");
}

// ---- matched bands: the centre is the middle of the edges, the |S11| minimum is the best match, and a
// band that runs past the simulated range is marked (the horn: below -10 dB over the whole 8-12 GHz)
{
  const g = (hz) => (hz / 1e9).toFixed(3);
  const horn = load("pyramidal-horn.json").results.bands[0];
  assert.equal(bandCentre(horn), 10e9, "the horn's band centre is 10 GHz, not its |S11| minimum");
  const h = bandTexts(horn, g, (v, d) => v.toFixed(d));
  assert.deepEqual([h.centre, h.best, h.range, h.bwMhz, h.open], ["10.000", "11.160", "≤\u00a08.000–≥\u00a012.000", "≥\u00a04000", true], "the open band's cells");
  const openTop = { f_lo: .757e9, f_hi: 1.05e9, f_center: .909e9, edge_lo: false, edge_hi: true };
  const b = bandTexts(openTop, g, (v, d) => v.toFixed(d));
  assert.equal(b.centre.startsWith("≥\u00a0"), true, "a band open at the top: its centre is a lower bound");
  assert.equal(b.range, `${g(openTop.f_lo)}–≥\u00a0${g(openTop.f_hi)}`, "the mark stays with its number (a no-break space)");
  const dip = load("dipole.json").results.bands[0];
  const d = bandTexts(dip, g, (v, k) => v.toFixed(k));
  assert.deepEqual([d.centre, d.best, d.open], [g((dip.f_lo + dip.f_hi) / 2), g(dip.f_center), false], "a closed band: no marks");
  assert.equal(d.percent, (((dip.f_hi - dip.f_lo) / bandCentre(dip)) * 100).toFixed(1), "the width as a share of the centre");
  // the example picker reads the same centre: the horn is "≥ 8–12 GHz", not "11.16 GHz"
  const index = JSON.parse(read("public/projects/index.json")).projects;
  const hornEntry = index.find((e) => e.file === "pyramidal-horn.json");
  assert.deepEqual(pickerBands(hornEntry, (f) => String(f)), ["≥\u00a08–12"], "the picker: the horn's open band as its range");
  const dipEntry = index.find((e) => e.file === "dipole.json");
  near(Number(pickerBands(dipEntry, (f) => String(f))[0]), (dip.f_lo + dip.f_hi) / 2e9, 1e-3, "the picker: a closed band's centre");
  assert.deepEqual(pickerBands({ bands: [2.4] }, String), ["2.4"], "an older index: its band list");
  for (const e of index.filter((x) => x.simulated)) {
    const bundle = load(e.file);
    assert.equal(e.band_ranges?.length ?? 0, bundle.results.bands.length, `${e.file}: the index lists every band's edges`);
  }
  // the Summary card, the Examples panel and the S-parameter side panel use these cells
  for (const p of ["src/designer/RunSummaryView.tsx", "src/components/SpecPanel.tsx", "src/designer/ResultViews.tsx"]) assert.ok(/bandTexts\(/.test(read(p)), `${p}: the band cells`);
  const en = JSON.parse(read("src/i18n/en.json")), tr = JSON.parse(read("src/i18n/tr.json"));
  for (const k of ["spec.bestMatch", "spec.bestMatch.title", "spec.centre.title", "spec.bandOpen", "spec.bandOpenNote"]) assert.ok(en[k] && tr[k], `${k} in both languages`);
  assert.match(en["spec.bandOpenNote"], /continues past the simulated range/);
}

// ---- number formats: a parameter column has one number of decimals (the most precise value's, at most
// four) in the UI language's separator; the run letter sits on the text baseline
{
  assert.equal(columnDecimals([0.466, 0.4194, 0.5126]), 4, "the sweep of k: four decimals for every row");
  assert.equal(columnDecimals([2, 3, 4]), 0, "integers");
  assert.equal(columnDecimals([1.5, 2.25, "x", null]), 2, "non-numbers are ignored");
  assert.equal(columnDecimals([0.123456]), 4, "at most four");
  setDecimalChoice("comma");
  assert.deepEqual([0.466, 0.4194].map((v) => fmt.fixed(v, columnDecimals([0.466, 0.4194]))), ["0,4660", "0,4194"], "Turkish: a decimal comma in the parameter cells");
  setDecimalChoice("language");
  const dock = read("src/designer/RunDock.tsx"), view = read("src/designer/RunSummaryView.tsx");
  assert.ok(/columnDecimals\(rows\(\)\.map\(\(r\) => paramValue\(r\.bundle, p\.key\)\)\)/.test(dock) && /fmt\.fixed\(v, paramDigits\(\)\.get\(key\) \?\? 0\)/.test(dock), "Runs table: the parameter cells");
  assert.ok(/columnDecimals\(rows\(\)\.map\(\(r\) => paramValue\(r\.bundle, p\.key\)\)\)/.test(view), "Summary: the parameter cells");
  assert.ok(/<RunQualityBadge compact q=\{bundleQuality\(row\.bundle\)\} \/>/.test(view), "Summary: the badge is an icon next to the name");
  const css = read("src/styles/run-summary.css");
  assert.ok(/\.rs-compare :is\(th, td\):last-child \{ padding-right/.test(css), "Summary: the last column keeps its padding");
}

console.log("check-run-summary: ok");
