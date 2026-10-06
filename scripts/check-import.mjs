// Checks for the reference-data importers (src/import/*) and the comparison metrics, using the
// fixtures in examples/import-fixtures/ (regenerate with scripts/gen-import-fixtures.mjs).
//
//   node --experimental-strip-types scripts/check-import.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTouchstoneN, renormalise } from "../src/import/touchstone.ts";
import { parseCurves } from "../src/import/curves.ts";
import { detectKind, gridMismatch, GRID_RTOL, importReference } from "../src/import/reference.ts";
import { comparisonMetrics, metricsRows } from "../src/import/metrics.ts";
import { delimiterOf, numericRow, splitHeader } from "../src/import/text.ts";
import { sweep } from "../src/lib/rf.ts";
import { comparisonFigures } from "../src/drawing/charts.ts";
import { packageFiles } from "../src/export/package.ts";
import { reportPages } from "../src/export/reportPdf.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fx = join(root, "examples/import-fixtures");
let checks = 0;
let failures = 0;
const check = (cond, where, msg) => {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL ${where}: ${msg}`);
  }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const read = (n) => readFileSync(join(fx, n), "utf8");
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const patch = JSON.parse(readFileSync(join(root, "public/projects/patch-antenna.json"), "utf8"));
const ps = sweep(patch);
const f0 = patch.results.bands[0].f_center;

// ------------------------------------------------------------------ text helpers
{
  const w = "text";
  check(JSON.stringify(numericRow("1,5;-10,25")) === "[1.5,-10.25]", w, "semicolon + decimal comma");
  check(JSON.stringify(numericRow("  6.634e+000\t-3.021e+001 ")) === "[6.634,-30.21]", w, "three-digit exponents, tabs");
  check(JSON.stringify(numericRow("1.0, 2.0, 3")) === "[1,2,3]", w, "commas");
  check(numericRow("Frequency / GHz  S1,1") === null, w, "header is not numeric");
}

// ------------------------------------------------------------------ Touchstone
{
  const w = "touchstone";
  const d = parseTouchstoneN(read("patch_75ohm.s1p"), "patch_75ohm.s1p");
  check(d.ports === 1 && d.z0 === 75 && d.format === "DB" && d.unit === "MHz" && d.f.length === 201, w, `1-port header: ${d.ports} ${d.z0} ${d.format} ${d.unit} ${d.f.length}`);
  const r = renormalise(d, 50);
  // renormalised back to 50 Ω it must equal the original patch S11 (sampled every 4th point)
  let err = 0;
  r.s[0][0].re.forEach((v, k) => (err = Math.max(err, Math.abs(v - ps.s11Re[4 * k]), Math.abs(r.s[0][0].im[k] - ps.s11Im[4 * k]))));
  check(err < 2e-6, w, `75 → 50 Ω renormalisation error ${err}`);
  check(near(r.f[0], ps.f[0] * 1.01, 1), w, "MHz frequency unit");
  const d2 = parseTouchstoneN(read("array2x1_synthetic.s2p"), "array2x1_synthetic.s2p");
  const a = JSON.parse(readFileSync(join(root, "examples/synthetic/array2x1.json"), "utf8"));
  const s21 = a.results.sparams.s["2,1"];
  check(d2.ports === 2 && near(d2.s[1][0].re[1], s21.re[8], 1e-6) && near(d2.s[1][0].im[1], s21.im[8], 1e-6), w, "2-port S11 S21 S12 S22 column order");
  // 3-port, row-major with continuation lines, RI, Hz, and a v2 keyword
  const t3 = ["[Version] 2.0", "# Hz S RI R 50", "1e9 0.1 0 0.2 0 0.3 0", "  0.4 0 0.5 0 0.6 0", "  0.7 0 0.8 0 0.9 0", "2e9 0.1 0.1 0.2 0 0.3 0 0.4 0", "  0.5 0 0.6 0 0.7 0 0.8 0 0.9 0", "[End]"].join("\n");
  const d3 = parseTouchstoneN(t3, "x.s3p");
  check(d3.ports === 3 && d3.s[0][1].re[0] === 0.2 && d3.s[1][0].re[0] === 0.4 && d3.s[2][2].re[1] === 0.9 && d3.f[1] === 2e9, w, "3-port row-major with continuation lines");
  // MA default without option line, port count inferred
  const d1 = parseTouchstoneN("1 0.5 90\n2 0.5 180\n", "noext");
  check(d1.ports === 1 && near(d1.s[0][0].im[0], 0.5, 1e-12) && near(d1.s[0][0].re[1], -0.5, 1e-12) && d1.f[0] === 1e9, w, "defaults: GHz S MA R 50, 1-port inferred");
  const dz = parseTouchstoneN("# GHz Z RI R 50\n1 50 0\n", "z.s1p"); // v1: z = 50 means 2500 Ω
  check(dz.parameter === "Z" && near(dz.s[0][0].re[0], 49 / 51, 1e-12), w, "Z-parameters converted to S");
  check(throws(() => parseTouchstoneN("# GHz H RI R 50\n1 1 0 0 0 0 0 1 0\n", "h.s2p")), w, "H-parameters rejected");
  check(throws(() => parseTouchstoneN("# GHz S RI R 50\n1 0.1 0 0.2\n", "a.s1p")), w, "ragged data rejected");
  // 2-port renormalisation against a direct two-step check: renormalise 50→75→50 is the identity
  const back = renormalise(renormalise(d2, 75), 50);
  let e2 = 0;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) back.s[i][j].re.forEach((v, k) => (e2 = Math.max(e2, Math.abs(v - d2.s[i][j].re[k]))));
  check(e2 < 1e-9, w, `2-port renormalisation round trip ${e2}`);
}

// ------------------------------------------------------------------ Touchstone fixtures
// examples/import-fixtures/touchstone/ with closed-form answers in expected.json, shared with the
// Python reader's tests (python/tests/test_touchstone.py): noise blocks, Y/Z → S, H/G refused,
// Touchstone 2 keywords, formats, units, comments, continuation lines, defaults.
{
  const w = "touchstone fixtures";
  const dir = join(fx, "touchstone");
  const { files } = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
  check(Object.keys(files).length >= 17, w, "expected.json lists too few files");
  const errorOf = (fn) => {
    try {
      fn();
      return "";
    } catch (e) {
      return e.message;
    }
  };
  for (const [name, e] of Object.entries(files)) {
    const where = `${w} ${name}`;
    const text = readFileSync(join(dir, name), "utf8");
    if (e.error) {
      const msg = errorOf(() => parseTouchstoneN(text, name));
      check(msg.includes(e.error), where, `expected the error "${e.error}", got "${msg}"`);
      continue;
    }
    let d;
    const msg = errorOf(() => (d = parseTouchstoneN(text, name)));
    if (msg) {
      check(false, where, `threw: ${msg}`);
      continue;
    }
    check(d.ports === e.ports && d.z0 === e.z0 && d.f.length === e.f.length, where, `ports ${d.ports}, z0 ${d.z0}, ${d.f.length} frequencies`);
    if (d.ports !== e.ports || d.f.length !== e.f.length) continue;
    check(e.f.every((x, k) => near(d.f[k], x, x * 1e-12)), where, `frequencies ${d.f}`);
    let err = 0;
    e.s.forEach((m, k) => m.forEach((row, i) => row.forEach(([re, im], j) => (err = Math.max(err, Math.abs(d.s[i][j].re[k] - re), Math.abs(d.s[i][j].im[k] - im))))));
    check(err <= (e.tol ?? 1e-9), where, `S-parameter error ${err}`);
    check(d.noiseFrequencies === (e.noise ?? 0), where, `${d.noiseFrequencies} noise frequencies`);
    for (const s of e.warn ?? []) check(d.warnings.some((x) => x.includes(s)), where, `no warning with "${s}" in ${JSON.stringify(d.warnings)}`);
  }
  // the error paths of python/tests/test_touchstone.py (same messages)
  const head = "[Version] 2.0\n# GHz S RI R 50\n[Number of Ports] 1\n";
  const cases = [
    [head + "[Number of Frequencies] 3\n1 0 0\n2 0 0\n", "[Number of Frequencies] is 3, but the file has 2"],
    [head + "[Matrix Format] Diagonal\n1 0 0\n", "Invalid [Matrix Format]"],
    [head + "[Mixed-Mode Order] D1,2 C1,2\n1 0 0\n", "Mixed-mode"],
    ["[Version] 2.0\n[Reference] 50\n[Number of Ports] 1\n1 0 0\n", "must come after"],
    ["[Version] 2.0\n[Number of Ports] 2\n[Reference] 50\n[Two-Port Data Order] 12_21\n1 0 0 0 0 0 0 0 0\n", "needs 2 values"],
    ["[Version] 3.0\n1 0 0\n", "not supported"],
    ["# GHz S RI R -5\n1 0 0\n", "Invalid reference impedance"],
    ["# GHz S RI R 50\n1 0 0 x\n", "Not a number"],
    ["# GHz S RI R 50\n1 0 0\n2 0\n", "does not fit 1 port"],
    ["# GHz S RI R 50\n! nothing\n", "No Touchstone network data"],
    ["# GHz S RI R 50\n1 0 0 0 0\n", "Cannot tell the port count"],
    ["# GHz S RI R 50\n2 0 0 0 0 0 0 0 0\n1 0 0 0 0 0 0 0 0\n", "not strictly increasing"],
  ];
  for (const [text, want] of cases) {
    const msg = errorOf(() => parseTouchstoneN(text, want.includes("strictly") ? "x.s2p" : "x.ts"));
    check(msg.includes(want), w, `expected the error "${want}", got "${msg}"`);
  }
  const t = parseTouchstoneN("[Version] 2.1\n# MHz S RI R 50\n# GHz Z MA R 75\n[Number of Ports] 1\n[Begin Information]\n[Anything] 1 2 3\n[End Information]\n[Frobnicate] x\n[Network Data]\n100, 0.5D-00, 0.25\n[End]\n", "x.ts");
  check(t.f[0] === 1e8 && t.s[0][0].re[0] === 0.5 && t.s[0][0].im[0] === 0.25 && t.z0 === 50 && t.unit === "MHz" && t.warnings.some((x) => x.includes("Frobnicate")), w, "information block, first option line, commas, Fortran exponent");
  // v2 files are recognised and imported (renormalised to the project's 50 Ω)
  const v2 = readFileSync(join(dir, "v2_z_ohms.ts"), "utf8");
  check(detectKind("v2_z_ohms.ts", v2) === "touchstone" && detectKind("x.dat", v2) === "touchstone", w, "v2 file detected as Touchstone");
  check(detectKind("x.txt", "# S RI R 50\n1 0 0\n") === "touchstone" && detectKind("x.txt", "# S parameters of something\n1 0\n") !== "touchstone", w, "option line without a unit detected, a comment is not");
  const rz = importReference("v2_z_ohms.ts", v2, patch);
  // 50 Ω and 75 Ω loads: S11 = 0 and 0.2 at 50 Ω
  check(rz.reference.zRef === 50 && near(rz.results.ports[1].s11_re[0], 0, 1e-12) && near(rz.results.ports[1].s11_re[1], 0.2, 1e-12), w, `v2 Z file imported at 50 Ω (${rz.results.ports[1].s11_re})`);
}

// ------------------------------------------------------------------ CSV curves
{
  const w = "curves";
  const { curves, warnings } = parseCurves(read("patch_generic_semicolon.csv"), { guessUnit: true });
  check(curves.length === 1 && curves[0].quantity === "db" && curves[0].f.length === 201, w, `${curves.length} curves, ${curves[0]?.quantity}, ${curves[0]?.f.length} points`);
  check(near(curves[0].f[0], ps.f[0] * 1.01, 1), w, `frequency unit (f0 ${curves[0].f[0]})`);
  check(!warnings.length, w, warnings.join("; "));
  check(throws(() => parseCurves("hello\nworld\n")), w, "no data rejected");
}

// ------------------------------------------------------------------ detection, reference, metrics
{
  const w = "reference";
  const kinds = { "patch_75ohm.s1p": "touchstone", "array2x1_synthetic.s2p": "touchstone", "patch_generic_semicolon.csv": "csv" };
  for (const [n, k] of Object.entries(kinds)) check(detectKind(n, read(n)) === k, w, `${n} detected as ${detectKind(n, read(n))}, expected ${k}`);
  check(detectKind("sweep.txt", "Frequency (GHz)\tS11 (dB)\n2\t-10\n") === "csv", w, "text tables are read as CSV");
  // Touchstone at 75 Ω
  const ref = importReference("patch_75ohm.s1p", read("patch_75ohm.s1p"), patch);
  check(ref.reference.notes.some((n) => /renormalised from 75/.test(n)) && ref.reference.zRef === 50, w, "renormalisation noted");
  check(ref.reference.label === "Reference: patch_75ohm.s1p", w, `label ${ref.reference.label}`);
  const m = comparisonMetrics(patch, ref);
  check(m.s11 && m.s11.basis === "band centre", w, `s11 metrics basis ${m.s11?.basis}`);
  // +1 % frequency shift, reference grid 10.1 MHz
  check(m.s11 && near(m.s11.shiftPct, 1, 0.45), w, `resonance shift ${m.s11?.shiftPct.toFixed(3)} % (expected ≈ +1 %)`);
  check(m.s11 && m.s11.bwOpenMHz !== null && m.s11.bwRefMHz !== null && near(m.s11.dBwMHz, 0.01 * m.s11.bwOpenMHz, 8), w, `bandwidth difference ${m.s11?.dBwMHz}`);
  check(m.pattern === null, w, "no far-field data, so no pattern metrics");
  check(metricsRows(m).length >= 4, w, "metrics rows");
  // magnitude-only CSV
  const csv = importReference("patch_generic_semicolon.csv", read("patch_generic_semicolon.csv"), patch);
  check(!csv.reference.phaseKnown && csv.reference.notes.some((n) => /magnitude only/.test(n)), w, "magnitude-only reference flagged");
  check(csv.reference.label.startsWith("Reference: ") && near(sweep(csv).f[0], ps.f[0] * 1.01, 1), w, `generic CSV (${csv.reference.label})`);
  const mc = comparisonMetrics(patch, csv);
  check(mc.s11 && near(mc.s11.shiftPct, 1, 0.45), w, `CSV resonance shift ${mc.s11?.shiftPct}`);
  // figures / package / report
  const figs = comparisonFigures(patch, ref);
  check(figs.length >= 1 && figs.every((x) => /<svg/.test(x.svg) && !/NaN/.test(x.svg)), w, `comparison figures ${figs.map((x) => x.name)}`);
  const inc = { project: false, readme: true, report: false, data: false, drawings: false, figures: false, cst: false, image: false };
  const files = packageFiles(patch, inc, { reference: ref }, new Date("2026-09-24T22:00:00+03:00"));
  const paths = files.map((x) => x.path);
  for (const p of ["comparison/metrics.csv", "comparison/s11_overlay.svg", "comparison/reference/patch_75ohm.s1p"]) check(paths.includes(p), w, `package lacks ${p}`);
  const pages = reportPages(patch, { generated: "2026-09-24 22:00", date: "2026-09-24", reference: ref });
  check(pages.join(" ").includes("Comparison: Reference: patch_75ohm.s1p"), w, "report lacks the comparison page");
  // curves combined sample by sample must share one frequency grid (#91): pairing by row would move
  // the 2 GHz magnitude onto the phase curve's 3 GHz sample. Mismatched grids are rejected with a
  // message naming both curves and the first differing point; matching grids (and printing
  // roundoff within GRID_RTOL) still combine.
  const errorOf = (fn) => {
    try {
      fn();
      return "";
    } catch (e) {
      return e.message;
    }
  };
  const blocks = (a, b) => `${a}\n${b}\n`;
  const magPh = (fPh, fMag = ["1", "2"]) => blocks(`Frequency (GHz),S11 Magnitude (dB)\n${fMag[0]},-10\n${fMag[1]},-20`, `Frequency (GHz),S11 Phase (deg)\n${fPh[0]},0\n${fPh[1]},180`);
  const reIm = (fIm) => blocks(`Frequency (GHz),S11 Real Part\n1,0.1\n2,0.2`, `Frequency (GHz),S11 Imaginary Part\n${fIm[0]},0\n${fIm[1]},0.3`);
  const bad = errorOf(() => importReference("grid_mismatch.txt", magPh(["1", "3"]), patch));
  check(/different frequency grids/.test(bad) && /magnitude \(dB\) curve/.test(bad) && /phase curve/.test(bad) && /point 2 is at 2 GHz in one and 3 GHz in the other/.test(bad), w, `magnitude 1,2 GHz + phase 1,3 GHz rejected: "${bad}"`);
  const badRi = errorOf(() => importReference("grid_mismatch_ri.txt", reIm(["1", "3"]), patch));
  check(/different frequency grids/.test(badRi) && /real-part curve/.test(badRi) && /imaginary-part curve/.test(badRi), w, `real 1,2 GHz + imaginary 1,3 GHz rejected: "${badRi}"`);
  const badLen = errorOf(() => importReference("grid_len.txt", blocks(`Frequency (GHz),S11 Magnitude (dB)\n1,-10\n2,-20`, `Frequency (GHz),S11 Phase (deg)\n1,0\n2,90\n3,180`), patch));
  check(/2 points against 3/.test(badLen), w, `different point counts rejected, not dropped to magnitude only: "${badLen}"`);
  const okMp = importReference("grid_ok.txt", magPh(["1", "2"]), patch);
  const sw = sweep(okMp);
  check(okMp.reference.phaseKnown && sw.f.join() === "1000000000,2000000000" && near(sw.s11Db[1], -20, 1e-9) && near(sw.s11Re[1], -0.1, 1e-12) && Math.max(...sw.f) === 2e9, w, `matching magnitude/phase grids combine (${sw.f} Hz, ${sw.s11Db} dB)`);
  const round = importReference("grid_round.txt", magPh(["1.0000001", "2.0000001"], ["1", "2"]), patch);
  check(round.reference.phaseKnown && sweep(round).f.length === 2, w, "printing roundoff (1e-7 relative) still pairs");
  const okRi = importReference("grid_ok_ri.txt", reIm(["1", "2"]), patch);
  check(okRi.reference.phaseKnown && near(sweep(okRi).s11Im[1], 0.3, 1e-12), w, "matching real/imaginary grids combine");
  check(gridMismatch([1e9, 2e9], [1e9, 2e9 * (1 + 5e-7)]) === null && gridMismatch([1e9, 2e9], [1e9, 2e9 * (1 + 5e-6)]) !== null && GRID_RTOL === 1e-6, w, "grid tolerance is 1e-6 relative");
  console.log(`reference: shift ${m.s11.shiftPct.toFixed(2)} %, |S11| min Δ ${m.s11.dMinDb.toFixed(2)} dB, BW Δ ${m.s11.dBwMHz?.toFixed(1)} MHz`);
}

// ------------------------------------------------------------------ CSV / text column headers (#100)
// A comma CSV header must be split into columns before quantities are assigned: "Frequency
// (GHz),S11 Real,S11 Imaginary" is one complex S11 (0.1 + j0.2 at 2 GHz = −13.0103 dB, 63.4349°),
// not two unknown curves read as dB. Fixtures in examples/import-fixtures/csv/ all hold the same two
// samples: 0.1 + j0.2 at 2.0 GHz and 0.2 + j0.3 at 2.1 GHz.
{
  const w = "csv headers";
  const csvDir = join(fx, "csv");
  const readCsv = (n) => readFileSync(join(csvDir, n), "utf8");
  const errorOf = (fn) => {
    try {
      fn();
      return "";
    } catch (e) {
      return e.message;
    }
  };
  const DB = [-13.0102999566, -8.8605664769];
  const PH = [63.4349488229, 56.3099324740];
  const expectSamples = (ref, where, tol = 1e-9) => {
    const s = sweep(ref);
    const deg = s.s11Re.map((re, k) => (Math.atan2(s.s11Im[k], re) * 180) / Math.PI);
    const ok = ref.reference.phaseKnown && s.f.length === 2 && near(s.f[0], 2e9, 1) && near(s.f[1], 2.1e9, 1) && near(s.s11Re[0], 0.1, tol) && near(s.s11Im[0], 0.2, tol) && near(s.s11Re[1], 0.2, tol) && near(s.s11Im[1], 0.3, tol) && near(s.s11Db[0], DB[0], tol) && near(s.s11Db[1], DB[1], tol) && near(deg[0], PH[0], 1e-6) && near(deg[1], PH[1], 1e-6);
    check(ok, where, `phaseKnown ${ref.reference.phaseKnown}, f ${s.f}, S11 ${s.s11Re.map((r, k) => `${r}${s.s11Im[k] >= 0 ? "+" : ""}${s.s11Im[k]}j`)}, ${s.s11Db} dB, ${deg}°`);
    check(!ref.reference.notes.some((n) => /Unknown quantity|magnitude only|read as dB/.test(n)), where, `notes: ${ref.reference.notes.join(" | ")}`);
  };
  // the issue's file, under its Unicode name
  const issue = readCsv("s11_comma_re_im.csv");
  check(detectKind("測定 re-im.csv", issue) === "csv", w, `issue file detected as ${detectKind("測定 re-im.csv", issue)}`);
  const pc = parseCurves(issue, { guessUnit: true });
  check(pc.curves.length === 1 && pc.curves[0].quantity === "complex" && JSON.stringify(pc.curves[0].pair) === "[1,1]" && !pc.warnings.length, w, `issue file parsed as ${pc.curves.map((c) => `${c.name}:${c.quantity}`)} (${pc.warnings.join("; ")})`);
  const issueRef = importReference("測定 re-im.csv", issue, patch);
  expectSamples(issueRef, `${w} 測定 re-im.csv`);
  check(near(sweep(issueRef).s11Db[0], -13.0102999566, 1e-9), w, `2 GHz is ${sweep(issueRef).s11Db[0]} dB, expected −13.0102999566 dB`);
  check(issueRef.reference.label === "Reference: 測定 re-im.csv" && issueRef.reference.notes.some((n) => /測定 re-im\.csv: CSV curve, 2 points/.test(n)), w, `label / notes ${issueRef.reference.label} ${issueRef.reference.notes}`);
  // quoted header with embedded commas and doubled quotes, quoted numbers, CRLF
  expectSamples(importReference("s11_quoted_re_im_crlf.csv", readCsv("s11_quoted_re_im_crlf.csv"), patch), `${w} s11_quoted_re_im_crlf.csv`);
  // semicolon CSV with decimal commas, |S11| in dB and phase in degrees, MHz in brackets
  expectSamples(importReference("s11_semicolon_db_phase.csv", readCsv("s11_semicolon_db_phase.csv"), patch), `${w} s11_semicolon_db_phase.csv`);
  // tab separated, Re(S11)/Im(S11) followed by S21_re/S21_im: S11 is used, S21 kept as its own curve
  const tab = importReference("s11_s21_tab_re_im.txt", readCsv("s11_s21_tab_re_im.txt"), patch);
  expectSamples(tab, `${w} s11_s21_tab_re_im.txt`);
  const tc = parseCurves(readCsv("s11_s21_tab_re_im.txt")).curves;
  check(tc.length === 2 && tc.every((c) => c.quantity === "complex") && tc[1].pair?.join() === "2,1" && tc[1].y[0] === 0.9, w, `tab file curves ${tc.map((c) => `${c.name}:${c.quantity}:${c.pair}`)}`);
  // linear magnitude and phase in radians, Hz
  const rad = importReference("s11_comma_mag_rad.csv", readCsv("s11_comma_mag_rad.csv"), patch);
  const s = sweep(rad);
  check(rad.reference.phaseKnown && near(s.s11Re[0], 0.1, 1e-9) && near(s.s11Im[1], 0.3, 1e-9) && rad.reference.notes.some((n) => /radians, converted to degrees/.test(n)), w, `magnitude + phase (rad): ${s.s11Re} ${s.s11Im}`);
  // inline variants: every header gives complex (or magnitude + phase) S11 with the same samples
  const variants = [
    ["Frequency (GHz),Re,Im", "comma, bare Re/Im"],
    ["Frequency (GHz), real , imag ", "comma, spaces, real/imag"],
    ["freq_GHz,S11_re,S11_im", "underscore names"],
    ["Frequency (GHz),S1,1 Real,S1,1 Imaginary", "unquoted S1,1 split by the comma delimiter"],
    ['"Frequency (GHz)","Re(S1,1)","Im(S1,1)"', "quoted Re(S1,1)/Im(S1,1)"],
    ["Frequency (GHz),S11 Real,S11 Imaginary,", "trailing comma"],
    ["% Frequency [GHz]\tRE S11\tIM S11", "tab, MATLAB comment mark"],
    ["Frequency (GHz),S11 Imaginary,S11 Real", "imaginary column first", true],
  ];
  for (const [head, label, swap] of variants) {
    const d = head.includes("\t") ? "\t" : ",";
    const tail = head.endsWith(",") ? "," : "";
    const rowsTxt = [[2.0, 0.1, 0.2], [2.1, 0.2, 0.3]].map(([fq, re, im]) => [fq.toFixed(1), swap ? im : re, swap ? re : im].join(d) + tail).join("\n");
    const name = `variant ${label}.csv`;
    const msg = errorOf(() => expectSamples(importReference(name, `${head}\n${rowsTxt}\n`, patch), `${w} ${label}`));
    check(!msg, `${w} ${label}`, `threw: ${msg}`);
  }
  expectSamples(importReference("mag_phase.csv", `Frequency (GHz),S11 Magnitude (dB),S11 Phase (deg)\n2.0,${DB[0]},${PH[0]}\n2.1,${DB[1]},${PH[1]}\n`, patch), `${w} comma dB/deg columns`);
  expectSamples(importReference("mag_lin.csv", `Frequency (GHz),|S11|,arg(S11) [°]\n2.0,0.2236067977,${PH[0]}\n2.1,0.3605551275,${PH[1]}\n`, patch), `${w} |S11| + arg [°]`, 1e-8); // magnitudes printed to 10 decimals
  // header tokenizer and quote-aware data rows
  check(JSON.stringify(splitHeader('"a, b","c ""q"" d", e ', ",")) === JSON.stringify(["a, b", 'c "q" d', "e"]), w, `quoted CSV header: ${JSON.stringify(splitHeader('"a, b","c ""q"" d", e ', ","))}`);
  check(JSON.stringify(splitHeader("Frequency / GHz        S1,1/abs,dB", " ")) === JSON.stringify(["Frequency / GHz", "S1,1/abs,dB"]), w, "a space-aligned header keeps S1,1/abs,dB whole");
  check(JSON.stringify(splitHeader('#"Frequency / GHz"\t"S1,1 [Magnitude in dB]"', "\t")) === JSON.stringify(["Frequency / GHz", "S1,1 [Magnitude in dB]"]), w, "a quoted tab header");
  check(JSON.stringify(numericRow('"2,5";"-1,5"')) === "[2.5,-1.5]" && JSON.stringify(numericRow('"2.0","0.1"')) === "[2,0.1]" && JSON.stringify(numericRow('"2,5","-1,5"')) === "[2.5,-1.5]", w, "quoted numbers, decimal commas inside quotes");
  check(delimiterOf("1,5;2,5") === ";" && delimiterOf("1\t2") === "\t" && delimiterOf("1, 2") === "," && delimiterOf("1  2") === " " && delimiterOf('"a;b",1') === ",", w, "delimiter precedence (quoted text ignored)");
  // unknown quantities stay explicit: read as dB with a note naming the column, never silently
  const unk = importReference("unknown.csv", "Frequency (GHz),A,B\n2.0,-10,-20\n2.1,-11,-21\n", patch);
  check(!unk.reference.phaseKnown && unk.reference.notes.filter((n) => /Unknown quantity "A": read as dB/.test(n) || /Unknown quantity "B": read as dB/.test(n)).length === 2 && near(sweep(unk).s11Db[0], -10, 1e-9), w, `unknown columns flagged: ${unk.reference.notes.join(" | ")}`);
  const noHead = parseCurves("2.0,0.1,0.2\n2.1,0.2,0.3\n", { guessUnit: true });
  check(noHead.curves.length === 2 && noHead.warnings.some((x) => /Unknown quantity "column 2"/.test(x)) && noHead.warnings.some((x) => /guessed GHz/.test(x)), w, `headerless file flagged: ${noHead.warnings.join(" | ")}`);
  const short = parseCurves("Frequency (GHz),S11 Real\n2.0,0.1,0.2\n", { guessUnit: true });
  check(short.warnings.some((x) => /2 column names for 3 data columns/.test(x)), w, `header/column count mismatch noted: ${short.warnings.join(" | ")}`);
  // #95 still holds: real and imaginary parts from different sweeps are rejected, not paired by row
  const split = `Frequency (GHz),S11 Real\n2.0,0.1\n2.1,0.2\nFrequency (GHz),S11 Imaginary\n2.0,0.2\n2.2,0.3\n`;
  const bad = errorOf(() => importReference("split.csv", split, patch));
  check(/different frequency grids/.test(bad) && /real-part curve/.test(bad) && /imaginary-part curve/.test(bad), w, `CSV real/imaginary blocks on different grids rejected: "${bad}"`);
  // regression: the generic CSV fixture keeps its quantity and has no warnings
  const r = parseCurves(read("patch_generic_semicolon.csv"), { guessUnit: true });
  check(r.curves.length === 1 && r.curves[0].quantity === "db" && !r.warnings.length, `${w} patch_generic_semicolon.csv`, `${r.curves.map((c) => c.quantity)} ${r.warnings.join("; ")}`);
}

console.log(`\n${checks} checks, ${failures} failed.`);
if (failures) process.exit(1);
