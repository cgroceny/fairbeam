// Synthetic MIMO report/package integration. No solver measurements are generated.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mimoAnalysis } from "../src/lib/mimo.ts";
import { diversitySummary, bundleDiversityReport } from "../src/export/diversityReport.ts";
import { setLanguage, setDecimalChoice } from "../src/i18n/index.ts";
import { packageFiles } from "../src/export/package.ts";
import { readmeReport } from "../src/export/report.ts";
import { reportPages } from "../src/export/reportPdf.ts";
import { parseCsv } from "../src/export/csv.ts";
import { diversityCsv } from "../src/export/diversity.ts";
import { registerPortProjection } from "../src/lib/portProcessingMetadata.ts";

const b = JSON.parse(readFileSync(new URL("../public/projects/dipole.json", import.meta.url), "utf8"));
b.name = "Synthetic MIMO export control";
b.ports = [7, 42].map(number => ({ ...structuredClone(b.ports[0]), number, excite: true }));
b.results = { frequency: [1e9, 2e9, 3e9], ports: {}, bands: [], farfield: [],
  sparams: { ports: [1, 2], port_numbers: [7, 42], excited: [1, 2], z_ref: [50, 50], complete: true, method: "B A^-1",
    s: Object.fromEntries(["1,1", "1,2", "2,1", "2,2"].map(key => [key, { re: [0, 0, 0], im: [0, 0, 0] }])) } };
const a = mimoAnalysis(b), summary = diversitySummary(a);
assert.equal(a.reason, null);
assert.deepEqual(summary.frequencyHz, [1e9, 3e9]);
assert.deepEqual(summary.rows.find(r => r[1] === "ECC S (1)"), ["P7 / P42", "ECC S (1)", "0.00000", "0.00000", "3 / 3"]);
assert.deepEqual(summary.rows.find(r => r[1] === "ECC field (1)").slice(2), ["—", "—", "0 / 3"]);
assert.deepEqual(summary.rows.find(r => r[1] === "TARC (1)").slice(2), ["—", "—", "0 / 3"]);
assert.ok(summary.reasons.length > 0);
const limited = diversitySummary(a, 2);
assert.equal(limited.rows.length, 2);
assert.equal(limited.omittedGroups, summary.rows.length - 2);
const readme = readmeReport(b, { exported: "2026-10-28", files: [] });
assert.match(readme, /## MIMO diversity/);
assert.match(readme, /no session excitation weights/);
assert.match(readme, /P7 \/ P42/);
assert.match(readme, /lossless reciprocal/);
const pages = reportPages(b, { generated: "2026-10-28", date: "2026-10-28" }).join("\n");
assert.match(pages, /MIMO diversity/);
assert.match(pages, /TARC/);
assert.match(pages, /P7 \/ P42/);
assert.ok(!pages.includes("undefined") && !pages.includes("NaN"));
const include = { project: false, readme: true, report: false, data: true, drawings: false, figures: false, cst: false, fab: false, image: false };
const files = packageFiles(b, include, {}, new Date("2026-10-28T00:00:00Z"));
const data = files.find(f => f.path === "data/diversity.csv");
assert.ok(data && typeof data.data === "string");
const csv = parseCsv(data.data);
assert.equal(csv.length, 25); // header + 8 metrics × 3 frequencies, no report truncation
const tarc = csv.filter(row => row[2] === "TARC");
assert.equal(tarc.length, 3);
assert.ok(tarc.every(row => row[4] === "" && row[5] === "mimo.reason.weights" && row[7] === ""));
assert.deepEqual(a.weights, []);
assert.doesNotMatch(data.data, /NaN|Infinity/);
for (const weights of [new Map([[7, [1, 0]]]), new Map([[7, [1, 0]], [99, [1, 0]]]), new Map([[7, [NaN, 0]], [42, [1, 0]]])]) {
  const invalid = mimoAnalysis(b, weights);
  assert.deepEqual(invalid.weights, []);
  assert.ok(invalid.rows.every(row => row.tarc.value === null && row.tarc.reason === "mimo.reason.weights"));
  assert.doesNotMatch(diversityCsv(invalid), /NaN|Infinity/);
}
const weighted = mimoAnalysis(b, new Map([[42, [0, -2]], [7, [1, 0]]]));
assert.deepEqual(weighted.weights, [{ port: 7, re: 1, im: 0 }, { port: 42, re: 0, im: -2 }]);
assert.ok(parseCsv(diversityCsv(weighted)).slice(1).every(row => row[7] === "P7=1+j(0); P42=0+j(-2)"));
const partial = structuredClone(b); partial.results.sparams.complete = false;
assert.equal(bundleDiversityReport(partial).rows.length, 0);
assert.ok(bundleDiversityReport(partial).reasons.length > 0);
assert.equal(bundleDiversityReport({ ...b, ports: b.ports.slice(0, 1) }), null);
// Filtering vacuum carvers for geometry must not discard the session provenance
// that refuses projected S matrices paired with original stored far fields.
const projected = structuredClone(b);
projected.parts.push({ ...structuredClone(projected.parts[0]), void: true });
registerPortProjection(projected, {
  source: b, settings: { referenceOhm: 75, delayPs: {} },
  physicalPorts: [7, 42], sourceReferences: [50, 50], missingSamples: 0,
  description: "Synthetic renormalized control", primaryIndex: 1,
  channels: [7, 42].map((id, i) => ({ kind: "single", ordinal: i + 1,
    physical: [id], canonical: [i + 1], referenceRe: 75, referenceIm: 0 })),
});
const refused = bundleDiversityReport(projected);
assert.equal(refused.rows.length, 0);
assert.equal(mimoAnalysis(projected).reason, "mimo.reason.processed");
for (const report of [readmeReport(projected, { exported: "2026-10-28", files: [] }),
  reportPages(projected, { generated: "2026-10-28", date: "2026-10-28" }).join("\n")]) {
  assert.ok(report.includes(refused.reasons[0]), "geometry filtering preserves processed-result refusal");
  assert.ok(!report.includes("ECC S (1)"), "no metric table is fabricated for a processed source");
}
const projectedCsv = packageFiles(projected, include, {}, new Date("2026-10-28T00:00:00Z"))
  .find(f => f.path === "data/diversity.csv").data;
assert.match(projectedCsv, /mimo.reason.processed/);
assert.doesNotMatch(projectedCsv, /NaN|Infinity/);
const englishReport = bundleDiversityReport(b), englishCsv = diversityCsv(weighted);
setLanguage("tr"); setDecimalChoice("comma");
assert.deepEqual(bundleDiversityReport(b), englishReport, "UI language and decimal choice cannot change exported report");
assert.equal(diversityCsv(weighted), englishCsv, "CSV numeric values remain byte-identical under Turkish/comma UI");
setLanguage("en"); setDecimalChoice("language");
console.log("MIMO export integration passed: complete physical mapping, missing fields/weights, full CSV, bounded report, README/PDF, locale independence and partial-matrix refusal.");
