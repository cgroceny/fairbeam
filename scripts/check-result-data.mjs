import assert from "node:assert/strict";
import { comparedResultDataTable, copyResultData, resultDataCsv, resultDataTable } from "../src/designer/resultData.ts";
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
  const zt = resultDataTable(bundle, "impedance", undefined, { format });
  const zlabels = { db: ["Re Zin (Ω)", "Im Zin (Ω)"], db_phase: ["Re Zin (Ω)", "Im Zin (Ω)", "∠Zin (deg)"], re_im: ["Re Zin (Ω)", "Im Zin (Ω)"], mag_phase: ["|Zin| (Ω)", "∠Zin (deg)"], all: ["Re Zin (Ω)", "Im Zin (Ω)", "|Zin| (Ω)", "∠Zin (deg)"] }[format];
  assert.deepEqual(zt.header.slice(1), zlabels, `${format} impedance headers`);
  const zr = results.ports["1"].zin_re[0], zi = results.ports["1"].zin_im[0];
  const zv = format === "mag_phase" ? [Math.hypot(zr, zi), Math.atan2(zi, zr) * 180 / Math.PI] : format === "all" ? [zr, zi, Math.hypot(zr, zi), Math.atan2(zi, zr) * 180 / Math.PI] : format === "db_phase" ? [zr, zi, Math.atan2(zi, zr) * 180 / Math.PI] : [zr, zi];
  assert.deepEqual(zt.rows[0].slice(1), zv, `${format} impedance values from stored Zin`);
}
const nonfinite = structuredClone(bundle);
nonfinite.results.sparams.s["1,1"].re[0] = Number.NaN;
nonfinite.results.sparams.s["1,1"].im[1] = Number.POSITIVE_INFINITY;
for (const format of formats) {
  const nt = resultDataTable(nonfinite, "sparams", undefined, { format, pairs: [[1, 1]] });
  check(nt.rows[0].slice(1).every((x, i) => nt.header[i + 1].startsWith("Im ") ? x === 0.2 : x === null), `${format} NaN and derived cells become null`);
  check(nt.rows[1].slice(1).every((x, i) => nt.header[i + 1].startsWith("Re ") ? x === 0.1 : x === null), `${format} infinite derived cells become null`);
}
const legacy = structuredClone(bundle);
delete legacy.results.sparams;
const legacyAll = resultDataTable(legacy, "sparams", undefined, { format: "all" });
check(legacyAll.header.length === 6 && legacyAll.rows[0][3] === 0.25, "legacy S11 complex values support all format");

const z = resultDataTable(bundle, "impedance");
check(z.rows.length === n && z.rows[7][1] === 57.123456789, "impedance export retains raw sample precision");
check(resultDataTable(bundle, "smith").header.includes("Re S11"), "Smith export includes complex reflection");
check(resultDataTable(bundle, "table").header.includes("VSWR"), "table export includes displayed quantities");
const p = resultDataTable(bundle, "pattern");
check(p.rows.length === 4 && p.header.includes("Directivity (dBi)"), "full stored pattern grid is exported");
check(p.rows[3][3] === 4.56789123, "pattern value is not rounded");

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

console.log(`result data: ${n} raw sweep samples, compared wide/long tables, all 4 Sij, pattern grid, precision and RFC4180 escaping OK`);

await import("./check-download-completion.mjs");
