import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { comparedResultDataTable, copyResultData, resultDataCsv, resultDataTable } from "../src/designer/resultData.ts";
import { compareCuts, nearestFarfield, traces } from "../src/compare/series.ts";
import { quantityGrid } from "../src/lib/farfieldQuantity.ts";
import { reflectionAtPort, zFromGamma } from "../src/lib/sparams.ts";
import { importReference } from "../src/import/reference.ts";
import { smallAntennaAnalysis, smallAntennaColumns } from "../src/lib/smallAntenna.ts";
import { readResultDataFormat, writeResultDataFormat, RESULT_DATA_FORMAT_KEY } from "../src/designer/resultDataPreference.ts";

const check = (condition, message) => { if (!condition) throw new Error(message); };
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const settings = new Map();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: key => settings.get(key) ?? null,
  setItem: (key, value) => settings.set(key, value),
} });
try {
  check(readResultDataFormat() === "plot", "the default export format follows the plot");
  {
    const { tableFormat } = await import("../src/designer/resultDataPreference.ts");
    check(tableFormat("plot") === undefined && tableFormat("db") === "db", "As plotted leaves the table to the plot");
  }
  writeResultDataFormat("re_im");
  check(settings.get(RESULT_DATA_FORMAT_KEY) === "re_im" && readResultDataFormat() === "re_im", "complex format is remembered");
  settings.set(RESULT_DATA_FORMAT_KEY, "invalid");
  check(readResultDataFormat() === "plot", "invalid stored format falls back to the plot");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  check(readResultDataFormat() === "plot", "blocked storage read falls back to the plot");
  writeResultDataFormat("all");
} finally {
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else delete globalThis.localStorage;
}
const n = 230;
const frequency = Array.from({ length: n }, (_, i) => 1e9 + i * 1e6);
const results = {
  frequency,
  ports: { "1": { s11_re: frequency.map(() => 0.25), s11_im: frequency.map(() => 0), zin_re: frequency.map((_, i) => i + 50.123456789), zin_im: frequency.map((_, i) => -i - 0.987654321), z_ref: 50 } },
  bands: [], farfield: [{ f: frequency[0], theta: [0, 90], phi: [0, 180], directivity_dbi: [[1.23456789, 2.34567891], [3.45678912, 4.56789123]], dmax_dbi: 4, rad_efficiency: null, prad_w: 0, pacc_w: 0 }],
  signals: {},
  sparams: { ports: [1, 2], z_ref: [50, 50], excited: [1, 2], complete: true, method: "test", qa: {}, s: {
    "1,1": { re: frequency.map(() => 0.1), im: frequency.map(() => 0.2) },
    "1,2": { re: frequency.map(() => 0.3), im: frequency.map(() => 0.4) },
    "2,1": { re: frequency.map(() => 0.5), im: frequency.map(() => 0.6) },
    "2,2": { re: frequency.map(() => 0.7), im: frequency.map(() => 0.8) },
  } },
};
const bundle = { results, model: { id: "test", name: "Test", description: "", params: [] }, name: "first", ports: [{ number: 1, excite: true }], half_space: null };
const legacy = structuredClone(bundle);
delete legacy.results.sparams;

const s = resultDataTable(bundle, "sparams");
check(s.header.join("|") === "f (GHz)||S11| (dB)||S12| (dB)||S21| (dB)||S22| (dB)", "all matrix Sij columns included, headers name the magnitude");
check(s.rows.length === n, "S matrix exports every stored frequency sample");
check(s.rows[0][2] === 20 * Math.log10(Math.hypot(0.3, 0.4)), "S12 uses full-precision bundle samples");
check(s.rows[229][0] === frequency[229] / 1e9, "frequency is exported in GHz");
const formats = ["db", "db_phase", "re_im", "mag_phase", "all"];
const pairValues = { "1,1": [0.1, 0.2], "1,2": [0.3, 0.4], "2,1": [0.5, 0.6], "2,2": [0.7, 0.8] };
for (const format of formats) {
  const table = resultDataTable(bundle, "sparams", undefined, { format, sparamMode: "phase" });
  const blocks = { db: [["|Sij| (dB)", v => 20 * Math.log10(Math.hypot(...v))]], db_phase: [["|Sij| (dB)", v => 20 * Math.log10(Math.hypot(...v))], ["∠Sij (deg)", v => Math.atan2(v[1], v[0]) * 180 / Math.PI]], re_im: [["Re Sij", v => v[0]], ["Im Sij", v => v[1]]], mag_phase: [["|Sij|", v => Math.hypot(...v)], ["∠Sij (deg)", v => Math.atan2(v[1], v[0]) * 180 / Math.PI]], all: [["|Sij| (dB)", v => 20 * Math.log10(Math.hypot(...v))], ["∠Sij (deg)", v => Math.atan2(v[1], v[0]) * 180 / Math.PI], ["Re Sij", v => v[0]], ["Im Sij", v => v[1]], ["|Sij|", v => Math.hypot(...v)]] }[format];
  const expectedHeaders = ["f (GHz)", ...Object.entries(pairValues).flatMap(([key]) => blocks.map(([label]) => label.replaceAll("Sij", `S${key.replace(",", "")}`)))];
  assert.deepEqual(table.header, expectedHeaders, `${format} headers and all pair order`);
  let col = 1;
  for (const vals of Object.values(pairValues)) for (const [, fn] of blocks) check(Math.abs(table.rows[0][col++] - fn(vals)) < 1e-12, `${format} value computed directly from re/im`);
  const chosen = resultDataTable(bundle, "sparams", undefined, { format, pairs: [[2, 1]], sparamMode: "phase" });
  check(chosen.header.length === blocks.length + 1, `${format} selected pair count`);
  const zt = resultDataTable(legacy, "impedance", undefined, { format });
  const zlabels = { db: ["Re Zin (Ω)", "Im Zin (Ω)"], db_phase: ["Re Zin (Ω)", "Im Zin (Ω)", "∠Zin (deg)"], re_im: ["Re Zin (Ω)", "Im Zin (Ω)"], mag_phase: ["|Zin| (Ω)", "∠Zin (deg)"], all: ["Re Zin (Ω)", "Im Zin (Ω)", "|Zin| (Ω)", "∠Zin (deg)"] }[format];
  assert.deepEqual(zt.header.slice(1, 1 + zlabels.length), zlabels, `${format} original impedance headers`);
  const zr = results.ports["1"].zin_re[0], zi = results.ports["1"].zin_im[0];
  const zv = format === "mag_phase" ? [Math.hypot(zr, zi), Math.atan2(zi, zr) * 180 / Math.PI] : format === "all" ? [zr, zi, Math.hypot(zr, zi), Math.atan2(zi, zr) * 180 / Math.PI] : format === "db_phase" ? [zr, zi, Math.atan2(zi, zr) * 180 / Math.PI] : [zr, zi];
  assert.deepEqual(zt.rows[0].slice(1, 1 + zlabels.length), zv, `${format} impedance values from stored Zin`);
  const small = smallAntennaColumns(smallAntennaAnalysis(legacy));
  assert.deepEqual(zt.header.slice(1 + zlabels.length), [...small.header, "Small antenna selection", "Small antenna result file"], `${format} complete appended scalar headers`);
  for (const row of zt.rows) assert.deepEqual(row.slice(1 + zlabels.length), [...small.row, "default", ""], `${format} same full-precision selected analysis on each sample`);
  assert.equal(small.row[small.header.indexOf("small_antenna_qz")], null, "unresolved/nonresonant fixture never gains an invented Q");
}
const nonfinite = structuredClone(bundle);
nonfinite.results.sparams.s["1,1"].re[0] = Number.NaN;
nonfinite.results.sparams.s["1,1"].im[1] = Number.POSITIVE_INFINITY;
for (const format of formats) {
  const nt = resultDataTable(nonfinite, "sparams", undefined, { format, pairs: [[1, 1]] });
  check(nt.rows[0].slice(1).every((x, i) => nt.header[i + 1].startsWith("Im ") ? x === 0.2 : x === null), `${format} NaN and derived cells become null`);
  check(nt.rows[1].slice(1).every((x, i) => nt.header[i + 1].startsWith("Re ") ? x === 0.1 : x === null), `${format} infinite derived cells become null`);
}
const legacyAll = resultDataTable(legacy, "sparams", undefined, { format: "all" });
check(legacyAll.header.length === 6 && legacyAll.rows[0][3] === 0.25, "legacy S11 complex values support all format");

const z = resultDataTable(legacy, "impedance");
check(z.rows.length === n && z.rows[7][1] === 57.123456789, "legacy impedance export retains raw sample precision");
const matrixZ = resultDataTable(bundle, "impedance");
check(matrixZ.rows.length === n, "matrix impedance exports every stored frequency sample");
// 50 * (1 + (0.1 + 0.2j)) / (1 - (0.1 + 0.2j)) = (950 + 400j) / 17.
check(matrixZ.rows.every(row => Math.abs(row[1] - 950 / 17) < 1e-12 && Math.abs(row[2] - 400 / 17) < 1e-12),
  "matrix impedance follows canonical S11 rather than the different raw-run Zin");
check(resultDataTable(bundle, "smith").header.includes("Re S11"), "Smith export includes complex reflection");
check(resultDataTable(bundle, "table").header.includes("VSWR"), "table export includes displayed quantities");
const p = resultDataTable(bundle, "pattern");
check(p.rows.length === 4 && p.header.includes("Directivity (dBi)"), "full stored pattern grid is exported");
check(p.rows[3][3] === 4.56789123, "pattern value is not rounded");

// Same-frequency embedded patterns must keep the selected driven-port identity on export.
const arrayPattern = JSON.parse(readFileSync(new URL("../public/projects/patch-array-2x1.json", import.meta.url), "utf8"));
const p2 = arrayPattern.results.farfield.find(ff => ff.port === 2);
assert.ok(p2);
const selectedPattern = resultDataTable(arrayPattern, "pattern", p2.f, { patternPort: 2 });
assert.ok(selectedPattern.rows.every(row => row[selectedPattern.header.indexOf("Port")] === 2));
assert.equal(selectedPattern.rows[0].at(-1), p2.directivity_dbi[0][0]);
assert.equal(resultDataTable(arrayPattern, "pattern", p2.f, { patternPort: 9 }).rows.length, 0,
  "missing driven port has no samples, rather than another port's pattern");
const otherPattern = structuredClone(arrayPattern);
otherPattern.name = "repeat";
assert.equal(nearestFarfield(otherPattern, p2.f, 2).port, 2);
const selectedCuts = compareCuts(traces(arrayPattern, [otherPattern]), p2.f, 0, p2);
assert.deepEqual(selectedCuts[0].value, selectedCuts[1].value, "overlay uses the same driven port as the primary cut");
otherPattern.results.farfield = otherPattern.results.farfield.filter(ff => ff.port !== 2);
assert.equal(compareCuts(traces(arrayPattern, [otherPattern]), p2.f, 0, p2).length, 1,
  "comparison without selected port has no substitute cut");
const portTables = comparedResultDataTable([{file: "primary", bundle: arrayPattern}, {file: "other", bundle: otherPattern}],
  "pattern", p2.f, {patternPort: 2});
assert.ok(portTables.rows.filter(row => row[0] === "other").every(row => row[portTables.header.indexOf("Port")] === null),
  "missing compared pattern retains run identity with empty data");

// Gallery gain / realized gain exports retain the plotted quantity beside directivity.
const gainBundle = JSON.parse(readFileSync(new URL("../public/projects/inset-patch.json", import.meta.url), "utf8"));
const gainFF = gainBundle.results.farfield[0];
for (const q of ["gain", "realized"]) {
  const table = resultDataTable(gainBundle, "pattern", gainFF.f, {patternQuantity: q});
  assert.equal(table.rows[0].at(-1), quantityGrid(gainBundle, gainFF, q)[0][0]);
  assert.equal(table.header.length, 5, "selected gain adds its own labeled column");
  assert.notEqual(table.rows[0].at(-1), gainFF.directivity_dbi[0][0]);
}
const noGain = structuredClone(gainBundle);
noGain.results.farfield[0].rad_efficiency = null;
assert.equal(resultDataTable(noGain, "pattern", gainFF.f, {patternQuantity: "gain"}).header.at(-1), "Directivity (dBi)",
  "unavailable quantity retains the same directivity fallback as the chart");
const dockSource = readFileSync(new URL("../src/components/Dock.tsx", import.meta.url), "utf8");
assert.match(dockSource, /patternQuantity:\s*shownQuantity\(\)/, "gallery export forwards the displayed pattern quantity");
assert.match(dockSource, /patternPort:\s*storedFF\(\)\?\.port/, "gallery export forwards the selected embedded-pattern port");

const tsvRows = [s.header, ...s.rows].map((r) => r.map((x) => x == null ? "" : String(x)).join("\t"));
const csvText = resultDataCsv(s).trimEnd();
check(csvText.startsWith("f (GHz),|S11| (dB),|S12| (dB),|S21| (dB),|S22| (dB)\r\n"), "CSV header corresponds to TSV header");

// the active plot's settings: the picked S_ij, dB or phase, the Smith chart's port
const picked = resultDataTable(bundle, "sparams", undefined, { pairs: [[2, 1], [1, 2]], sparamMode: "db" });
assert.deepEqual(picked.header, ["f (GHz)", "|S21| (dB)", "|S12| (dB)"], "only the picked pairs, in picker order");
check(Math.abs(picked.rows[3][1] - 20 * Math.log10(Math.hypot(0.5, 0.6))) < 1e-12, "picked |S21| is the magnitude in dB");
const phase = resultDataTable(bundle, "sparams", undefined, { pairs: [[2, 1]], sparamMode: "phase" });
assert.deepEqual(phase.header, ["f (GHz)", "∠S21 (deg)"], "phase header names the quantity and unit");
check(Math.abs(phase.rows[0][1] - Math.atan2(0.6, 0.5) * 180 / Math.PI) < 1e-12, "phase in degrees");
check(resultDataTable(bundle, "sparams", undefined, { pairs: [], sparamMode: "db" }).header.length === 1, "an empty pick exports only frequency, as plotted");
const smith2 = resultDataTable(bundle, "smith", undefined, { smithPort: 2 });
assert.deepEqual(smith2.header, ["f (GHz)", "Re S22", "Im S22", "Re Zin port 2 (Ω)", "Im Zin port 2 (Ω)"], "Smith export follows the picked port");
{
  const [gr, gi] = [0.7, 0.8], den = (1 - gr) ** 2 + gi ** 2;
  check(smith2.rows[0][1] === 0.7 && Math.abs(smith2.rows[0][3] - 50 * ((1 + gr) * (1 - gr) - gi * gi) / den) < 1e-9, "S22 and the impedance it sees");
}
check(resultDataTable(bundle, "smith").header[1] === "Re S11", "Smith export without a port keeps the sweep reflection");
check(resultDataTable(bundle, "smith", undefined, { smithPort: 4 }).rows.length === 0, "a run without the picked port exports no samples (it is not on the chart)");
check(tsvRows[1].split("\t").slice(0, 5).every((x, i) => x === csvText.split("\r\n")[1].split(",")[i]), "CSV and TSV preserve identical numeric cells");
check(resultDataCsv({ header: ["label, \"quoted\"", "value"], rows: [["a,b", 1]] }).startsWith('"label, ""quoted""",value\r\n"a,b",1'), "RFC4180 header and cell escaping");
check(resultDataTable(null, "sparams").rows.length === 0, "missing bundle is handled");

const bundle2 = structuredClone(bundle);
bundle2.name = "second";
bundle2.model.params = [{ key: "width", value: 12, unit: "mm" }];
bundle.model.params = [{ key: "width", value: 10, unit: "mm" }];
const pair = [{ file: "a.json", bundle }, { file: "b.json", bundle: bundle2 }];
for (const format of formats) {
  const cw = comparedResultDataTable(pair, "sparams", undefined, { format });
  const columns = { db: 1, db_phase: 2, re_im: 2, mag_phase: 2, all: 5 }[format];
  check(cw.header.length === 1 + 2 * 4 * columns && cw.rows[0].length === cw.header.length, `${format} compared wide values`);
  const zWide = comparedResultDataTable(pair, "impedance", undefined, { format });
  check(zWide.header[0] === "f (GHz)" && zWide.rows[0].length === zWide.header.length, `${format} impedance compared wide values`);
}
const wide = comparedResultDataTable(pair, "sparams");
check(wide.header[0] === "f (GHz)" && wide.header.some((h) => h.includes("width=10")) && wide.header.some((h) => h.includes("width=12")), "identical grids use wide labeled columns");
check(wide.rows.length === n && wide.rows[0].length === 9, "wide layout retains every run and Sij value");
const unequal = structuredClone(bundle2);
unequal.results.frequency = unequal.results.frequency.slice(1);
for (const pairValue of Object.values(unequal.results.sparams.s)) { pairValue.re = pairValue.re.slice(1); pairValue.im = pairValue.im.slice(1); }
for (const format of formats) {
  const cl = comparedResultDataTable([{ file: "a", bundle }, { file: "b", bundle: unequal }], "sparams", undefined, { format });
  check(cl.header[0] === "run" && cl.rows.length === n * 2 - 1 && cl.rows[0].length === cl.header.length, `${format} compared long values`);
  const zLong = comparedResultDataTable([{ file: "a", bundle }, { file: "b", bundle: unequal }], "impedance", undefined, { format });
  check(zLong.header[0] === "run" && zLong.rows.length === n * 2 - 1 && zLong.rows[0].length === zLong.header.length, `${format} impedance compared long values`);
}
for (const format of formats) {
  const smithFormat = resultDataTable(bundle, "smith", undefined, { format });
  const tableFormat = resultDataTable(bundle, "table", undefined, { format });
  check(smithFormat.header.includes("Re S11") && smithFormat.header.some(h => h.includes("Zin")), `${format} Smith base and complex fields`);
  check(tableFormat.header.includes("VSWR") && tableFormat.header.some(h => h.includes("Zin")), `${format} table preserves VSWR and Zin`);
}
// designer runs: the legend's run names label the columns (identical parameters told apart by run)
const twin = structuredClone(bundle);
const named = comparedResultDataTable([{ file: "a.json", bundle }, { file: "b.json", bundle: twin }], "sparams", undefined,
  { pairs: [[2, 1]], sparamMode: "phase", runNames: ["Test · 01:47 · CPU", "Test · 01:48 · CUDA"] });
assert.deepEqual(named.header, ["f (GHz)", "∠S21 (deg) · Test · 01:47 · CPU", "∠S21 (deg) · Test · 01:48 · CUDA"], "compared export follows the pick and names runs like the legend");
const long = comparedResultDataTable([{ file: "a.json", bundle }, { file: "b.json", bundle: unequal }], "sparams");
check(long.header[0] === "run" && long.header.includes("width (mm)") && long.rows.length === n * 2 - 1, "unequal grids use long rows with parameter columns");
check(long.rows[0][0] === "a.json" && long.rows[n][0] === "b.json", "long rows retain unambiguous run filenames");
const namedLong = comparedResultDataTable([{ file: "a.json", bundle }, { file: "b.json", bundle: unequal }], "sparams", undefined,
  { runNames: ["Local run · Current project", "Foreign run · Other project"] });
assert.deepEqual(namedLong.header.slice(0, 2), ["run", "label"]);
assert.deepEqual(namedLong.rows[0].slice(0, 2), ["a.json", "Local run · Current project"]);
assert.deepEqual(namedLong.rows[n].slice(0, 2), ["b.json", "Foreign run · Other project"]);
const partial = structuredClone(bundle2);
delete partial.results.sparams;
const union = comparedResultDataTable([{ file: "a.json", bundle }, { file: "partial.json", bundle: partial }], "sparams");
check(union.header[0] === "f (GHz)" && union.header.length === 6, "matching grids use wide layout even when value columns differ");
check(union.rows[n - 1].length === 6, "wide rows retain each run's available value columns");
const missing = structuredClone(bundle2);
missing.results.frequency = [];
for (const pairValue of Object.values(missing.results.sparams.s)) { pairValue.re = []; pairValue.im = []; }
const withMissing = comparedResultDataTable([{ file: "a.json", bundle }, { file: "empty.json", bundle: missing }], "sparams");
check(withMissing.header[0] === "run" && withMissing.rows.at(-1)[0] === "empty.json", "long layout identifies a compared run without samples");

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let copied = "";
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async text => { copied = text; } } } });
try {
  for (const runs of [pair, [{ file: "a.json", bundle }, { file: "b.json", bundle: unequal }]]) {
    const expected = comparedResultDataTable(runs, "sparams");
    const result = await copyResultData(bundle, "sparams", undefined, runs);
    assert.equal(result.ok, true);
    const tsvRows = copied.trimEnd().split("\n").map(row => row.split("\t"));
    const csvRows = resultDataCsv(expected).trimEnd().split("\r\n").map(row => row.split(","));
    assert.deepEqual(tsvRows, csvRows, "wide and long TSV/CSV retain identical headers, run identities and values");
    assert.equal(tsvRows.length, expected.rows.length + 1);
  }
} finally {
  if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  else delete globalThis.navigator;
}

// Singular and frequency-dependent impedances: the plotted port and its CSV share one adapter.
{
  const open = zFromGamma({ re: [1, -1, 0, 1 - 1e-12, 1], im: [0, 0, 0, 0, 1e-6] }, 50);
  assert.ok(Number.isNaN(open.re[0]) && Number.isNaN(open.im[0]), "exact open is unavailable, never 0 ohm");
  assert.equal(open.re[1], 0); assert.equal(open.re[2], 50);
  assert.ok(open.re[3] > 1e13 && Number.isFinite(open.re[3]), "near-open finite impedance is not clipped");
  assert.ok(Math.abs(open.re[4] + 50) < 1e-8 && Math.abs(open.im[4] - 1e8) < 1e-6);
  const imported = importReference("open.s1p", "# GHz S RI R 50\n1 1 0\n2 -1 0\n", null);
  assert.ok(Number.isNaN(imported.results.ports["1"].zin_re[0]), "actual Touchstone import does not cache a false short");
  assert.deepEqual(resultDataTable(imported, "smith").rows[0], [1, 1, 0, null, null]);
  imported.results.ports["1"].zin_re[0] = 0; imported.results.ports["1"].zin_im[0] = 0;
  assert.ok(Number.isNaN(reflectionAtPort(imported, 1).zRe[0]), "old cached false short is not reused");
  assert.deepEqual(resultDataTable(imported, "smith").rows[0], [1, 1, 0, null, null]);
  imported.results.ports["1"].zin_re[0] = 1e20;
  assert.equal(reflectionAtPort(imported, 1).zRe[0], 1e20, "rounded gamma does not discard a measured finite high impedance");
  const fixture = structuredClone(bundle);
  fixture.results.frequency = [1e9, 2e9];
  fixture.ports = [{ number: 1, excite: true }, { number: 2, excite: true, type: "waveguide" }];
  fixture.results.sparams = { ports: [1, 2], z_ref: [50, 500], s: {
    "1,1": { re: [1, -1], im: [0, 0] }, "2,2": { re: [0, 0.5], im: [0, 0] },
  } };
  fixture.results.ports = { "2": { z_ref: 500, z_ref_f: [600, 400], s11_re: [0, 0.5], s11_im: [0, 0], zin_re: [600, 1200], zin_im: [0, 0] } };
  let table = resultDataTable(fixture, "smith", undefined, { smithPort: 1 });
  assert.deepEqual(table.rows[0], [1, 1, 0, null, null]);
  assert.ok(resultDataCsv(table).includes("1,1,0,,\r\n"), "CSV leaves nonfinite impedance empty");
  assert.deepEqual(reflectionAtPort(fixture, 2).zRe, [600, 1200]);
  assert.deepEqual(reflectionAtPort(fixture, 2).zRefF, [600, 400]);
  table = resultDataTable(fixture, "smith", undefined, { smithPort: 2 });
  assert.deepEqual(table.rows, [[1, 0, 0, 600, 0], [2, 0.5, 0, 1200, 0]]);
  assert.ok(table.header.includes("Re S22"), "selected port is retained in export headings");
  // Matching stored U/I keeps its precision; matrix gamma changes must invalidate that choice.
  fixture.results.ports["2"].zin_re[0] = 600.0000000000001;
  assert.equal(reflectionAtPort(fixture, 2).zRe[0], 600.0000000000001);
  fixture.results.sparams.s["2,2"].re[0] = 0.5;
  assert.equal(reflectionAtPort(fixture, 2).zRe[0], 1800, "B A^-1 reflection cannot reuse a different driven-run Zin");
  fixture.results.sparams.z_ref[1] = 50;
  assert.equal(reflectionAtPort(fixture, 2).zRefF, undefined);
  assert.equal(reflectionAtPort(fixture, 2).zRe[0], 150, "renormalized matrix cannot inherit native waveguide reference");
  // Optional complex matching reference does not redefine native real-reference S_pp.
  fixture.ports[1].reference_impedance = { real: 20, imag: -150 };
  fixture.results.ports["2"].power_wave_reference = { real: 20, imag: -150, convention: "Kurokawa", gamma_re: [0, 0], gamma_im: [0, 0], power_transfer: [1, 1] };
  assert.equal(reflectionAtPort(fixture, 2).re[0], 0.5);
  assert.equal(reflectionAtPort(fixture, 2).zRe[0], 150);
  const remapped = structuredClone(fixture);
  remapped.results.sparams.port_numbers = [2, 5];
  remapped.results.sparams.z_ref[1] = 500;
  remapped.results.sparams.s["2,2"].re = [0, 0.5];
  remapped.results.ports["5"] = { z_ref: 500, z_ref_f: [800, 700], s11_re: [0, 0.5], s11_im: [0, 0], zin_re: [800, 2100], zin_im: [0, 0] };
  assert.deepEqual(reflectionAtPort(remapped, 2).zRe, [800, 2100], "matrix port 2 reads physical port 5, not native port 2");
  assert.deepEqual(reflectionAtPort(remapped, 2).zRefF, [800, 700]);
  for (const mapping of [[2], [2, 2], [2, -5], [2, 5.5], [2, "5"], null]) {
    remapped.results.sparams.port_numbers = mapping;
    assert.equal(reflectionAtPort(remapped, 2).zRefF, undefined, "malformed mapping never attaches a native port reference");
    assert.deepEqual(reflectionAtPort(remapped, 2).zRe, [500, 1500]);
  }
  fixture.reference = { phaseKnown: false };
  assert.equal(reflectionAtPort(fixture, 2), null);
  assert.equal(resultDataTable(fixture, "smith", undefined, { smithPort: 2 }).rows.length, 0);
}

console.log(`result data: ${n} raw sweep samples, compared wide/long tables, all 4 Sij, pattern grid, precision, Smith impedance boundaries and RFC4180 escaping OK`);

await import("./check-download-completion.mjs");
