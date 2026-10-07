// Check the drawing, figure and package exports for every example bundle, and write example SVGs.
//
//   node --experimental-strip-types scripts/check-exports.mjs
//
// Writes examples/drawings/<bundle-stem>_{A3,A4,figure}.svg, <bundle-stem>_{s11,zin,smith,pattern_*}.svg
// and examples/reports/patch-antenna.pdf. Exits non-zero if any check fails: well-formed XML,
// expected dimension values, no NaN/undefined, Touchstone round trip, CSV columns and values, PDF structure
// and embedded glyphs, zip contents.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync, unzlibSync } from "fflate";
import { technicalDrawing } from "../src/drawing/drawing.ts";
import { ffTag, figureSet, patternTag } from "../src/drawing/charts.ts";
import { parseTouchstone, parseTouchstoneNPort, touchstoneNPort, touchstoneS1p } from "../src/export/touchstone.ts";
import { sMatrix } from "../src/lib/sparams.ts";
import { bandsCsv, parseCsv, patternCsv, signalsCsv, sweepCsv } from "../src/export/csv.ts";
import { packageFiles, packageName, zipPackage } from "../src/export/package.ts";
import { reproduceCommand } from "../src/export/report.ts";
import { fileFormats } from "../src/export/reportPdf.ts";
import { sweep } from "../src/lib/rf.ts";
import { reportPages, reportPdf } from "../src/export/reportPdf.ts";
import { svgPagesToPdf } from "../src/drawing/pdfdoc.ts";
import { validateBundle } from "../src/lib/validate.ts";
import { designStem } from "../src/lib/exportNames.ts";
import { quickBundle } from "../src/designer/geometry.ts";
import { paramValues } from "../src/designer/expr.ts";
import { cstMacro, DEFAULT_CST_OPTIONS } from "../src/export/cst.ts";
import { pngChunks, pngDpi, withPngDpi } from "../src/drawing/png.ts";
import { zlibSync } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projects = join(root, "public", "projects");
const outDir = join(root, "examples", "drawings");
mkdirSync(outDir, { recursive: true });
const reportDir = join(root, "examples", "reports");
mkdirSync(reportDir, { recursive: true });
const fonts = {
  regular: new Uint8Array(readFileSync(join(root, "src/assets/fonts/IBMPlexSans-Regular.woff"))),
  semibold: new Uint8Array(readFileSync(join(root, "src/assets/fonts/IBMPlexSans-SemiBold.woff"))),
};

/** Basic PDF structure: header, page count, embedded TrueType font, and the Unicode code points the
 * embedded fonts map (from the decompressed ToUnicode CMaps). */
function pdfInfo(pdf) {
  const latin = Buffer.from(pdf).toString("latin1");
  const pages = (latin.match(/\/Type\s*\/Page\b/g) ?? []).length;
  const codes = new Set();
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(latin))) {
    const start = m.index + m[0].length;
    const end = latin.indexOf("endstream", start);
    const dict = latin.slice(Math.max(0, m.index - 300), m.index);
    let body = pdf.subarray(start, end);
    if (/FlateDecode/.test(dict.slice(dict.lastIndexOf("<<")))) {
      try {
        body = unzlibSync(body);
      } catch {
        continue;
      }
    }
    const t = Buffer.from(body).toString("latin1");
    if (!t.includes("beginbfchar") && !t.includes("beginbfrange")) continue;
    for (const c of t.matchAll(/<[0-9a-fA-F]+>\s*<([0-9a-fA-F]{4})>/g)) codes.add(parseInt(c[1], 16));
  }
  return { header: latin.slice(0, 5), pages, embedded: /FontFile2/.test(latin), codes };
}

let failures = 0;
let checks = 0;
const fail = (where, msg) => {
  failures++;
  console.error(`  FAIL ${where}: ${msg}`);
};
const check = (cond, where, msg) => {
  checks++;
  if (!cond) fail(where, msg);
};

/** Tiny XML well-formedness checker: tag balance, attribute quoting, entities, single root. */
function xmlErrors(xml) {
  const errs = [];
  const stack = [];
  let roots = 0;
  let i = 0;
  const text = (s) => {
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(s)) errs.push(`bad entity in text near "${s.slice(0, 40)}"`);
    if (!stack.length && s.trim()) errs.push(`text outside the root: "${s.trim().slice(0, 40)}"`);
  };
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      text(xml.slice(i));
      break;
    }
    text(xml.slice(i, lt));
    if (xml.startsWith("<?", lt)) {
      const e = xml.indexOf("?>", lt);
      if (e < 0) return [...errs, "unterminated processing instruction"];
      i = e + 2;
      continue;
    }
    if (xml.startsWith("<!--", lt)) {
      const e = xml.indexOf("-->", lt);
      if (e < 0) return [...errs, "unterminated comment"];
      i = e + 3;
      continue;
    }
    // find the end of the tag, honouring quoted attribute values
    let j = lt + 1;
    let q = null;
    for (; j < xml.length; j++) {
      const c = xml[j];
      if (q) {
        if (c === q) q = null;
        else if (c === "<") errs.push(`"<" inside an attribute value at ${j}`);
      } else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
    }
    if (j >= xml.length) return [...errs, `unterminated tag at ${lt}`];
    const body = xml.slice(lt + 1, j);
    i = j + 1;
    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      const top = stack.pop();
      if (top !== name) errs.push(`closing </${name}> does not match <${top}>`);
      continue;
    }
    const selfClose = body.endsWith("/");
    const m = /^([A-Za-z_][\w:.-]*)([\s\S]*?)\/?$/.exec(body);
    if (!m) {
      errs.push(`bad tag <${body.slice(0, 30)}>`);
      continue;
    }
    const attrs = m[2].trim();
    const seen = new Set();
    const re = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let rest = attrs;
    let a;
    while ((a = re.exec(attrs))) {
      if (seen.has(a[1])) errs.push(`duplicate attribute ${a[1]} on <${m[1]}>`);
      seen.add(a[1]);
      const v = a[3] ?? a[4];
      if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(v)) errs.push(`bad entity in ${a[1]}="${v.slice(0, 30)}"`);
      rest = rest.replace(a[0], "");
    }
    if (rest.trim()) errs.push(`unparsed attribute text on <${m[1]}>: "${rest.trim().slice(0, 30)}"`);
    if (!stack.length) roots++;
    if (!selfClose) stack.push(m[1]);
  }
  if (stack.length) errs.push(`unclosed <${stack.join("> <")}>`);
  if (roots !== 1) errs.push(`${roots} root elements`);
  return errs;
}

/** Text content of all <text> elements. */
const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

function checkSvg(where, svg, expected = []) {
  const errs = xmlErrors(svg);
  check(!errs.length, where, `not well-formed XML: ${errs.slice(0, 3).join("; ")}`);
  for (const bad of ["NaN", "undefined", "Infinity", "[object"]) check(!svg.includes(bad), where, `contains "${bad}"`);
  check(/^<\?xml[^>]*>\s*<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg), where, "missing XML declaration / SVG namespace");
  const t = new Set(texts(svg));
  for (const e of expected) check(t.has(e), where, `missing dimension/label text "${e}"`);
}

// plain values (sheets) and parametric labels (figure mode: "key = value" where a dimension equals a parameter)
const EXPECT = {
  "patch-antenna": ["32", "40", "60", "1.524", "6"],
  "sierpinski-monopole--iterations-0": ["48", "55.43", "1", "60°"],
  "sierpinski-monopole--iterations-3": ["48", "55.43", "1", "60°"],
  "minkowski-patch": ["60", "30", "1.524", "10", "5", "3.5"],
  "inset-patch": ["55.4", "62", "1.6", "43.4", "38", "1", "9", "3.08", "14", "29.4"],
  dipole: ["58", "1"],
};
const EXPECT_PARAM = {
  "patch-antenna": ["patch_w = 32", "patch_l = 40", "sub_size = 60", "sub_h = 1.524", "|feed_x| = 6"],
  "sierpinski-monopole--iterations-0": ["height = 48", "55.43", "gap = 1", "flare = 60°"],
  "sierpinski-monopole--iterations-3": ["height = 48", "55.43", "gap = 1", "flare = 60°"],
  "minkowski-patch": ["sub_size = 60", "size = 30", "sub_h = 1.524", "10", "5", "|feed_x| = 3.5"],
  "inset-patch": ["patch_w = 38", "patch_l = 29.4", "inset = 9", "gap = 1", "feed_w = 3.08", "feed_len = 14", "sub_h = 1.6"],
  dipole: ["length = 58"],
};

const index = JSON.parse(readFileSync(join(projects, "index.json"), "utf8"));
for (const entry of index.projects) {
  const stem = entry.file.replace(/\.json$/, "");
  const b = JSON.parse(readFileSync(join(projects, entry.file), "utf8"));
  const date = b.created.slice(0, 10);
  const expected = EXPECT[stem] ?? [];
  console.log(`${stem}`);

  // --- technical drawings
  const variants = [
    ["A3", { sheet: "A3" }, true],
    ["A4", { sheet: "A4" }, true],
    ["figure", { sheet: "figure" }, true],
    ["A3-first-angle", { sheet: "A3", projection: "first" }, false],
    ["A4-no-iso", { sheet: "A4", isometric: false }, false],
    ["figure-no-dims", { sheet: "figure", dimensions: false }, false],
    ["A3-param-labels", { sheet: "A3", paramLabels: true }, false],
    ["figure-plain", { sheet: "figure", paramLabels: false }, false],
    ["A3-legend-hidden", { sheet: "A3", legend: true, isoHidden: true }, false],
  ];
  for (const [name, opt, write] of variants) {
    const r = technicalDrawing(b, { ...opt, date });
    const where = `${stem} drawing ${name}`;
    const labelled = opt.paramLabels ?? opt.sheet === "figure";
    checkSvg(where, r.svg, opt.dimensions === false ? [] : labelled ? EXPECT_PARAM[stem] ?? [] : expected);
    // collinear-867 is 360 mm tall: on A4 it only fits at 1:100, so the drawing says so (A3 and the figure sheet fit)
    const tooTall = stem === "collinear-867" && opt.sheet === "A4";
    if (tooTall) check(r.warnings.length === 1 && /do not fit/.test(r.warnings[0]), where, `expected the "do not fit" warning, got: ${r.warnings.join("; ")}`);
    else check(!r.warnings.length, where, `warnings: ${r.warnings.join("; ")}`);
    if (opt.legend) check(texts(r.svg).includes("LINE TYPES"), where, "legend missing");
    check(Number.isFinite(r.scale) && r.scale > 0, where, `bad scale ${r.scale}`);
    if (opt.dimensions !== false) {
      // equal values are legitimate (60 × 60); the same interval on the same axis twice is not
      check(r.dimensionKeys.length === new Set(r.dimensionKeys).size, where, `duplicate dimensions ${r.dimensions}`);
    }
    if (write) writeFileSync(join(outDir, `${stem}_${name}.svg`), r.svg);
    console.log(`  drawing ${name.padEnd(15)} scale ${r.scaleLabel.padEnd(6)} dims ${r.dimensions.join(", ")}`);
  }
  // the title block: every value whole (a long one is set smaller, the drawing number on two lines if need be)
  {
    const tb = technicalDrawing(b, { sheet: "A3", date }).svg;
    const block = texts(tb.slice(tb.indexOf('class="title-block"')));
    // a long parameter description may be shortened; an identifier, a name or a number never
    const cut = block.filter((s) => s.includes("…") && !/^[A-Z][a-z]+ [a-z]/.test(s));
    check(!cut.length, `${stem} title block`, `a value is cut: ${cut.join(" | ")}`);
    check(block.includes(`${b.model.id.toUpperCase()}-01`), `${stem} title block`, "the drawing number is not the whole model id");
  }
  if (stem === "patch-antenna") {
    const r = technicalDrawing(b, { sheet: "A3", date });
    check(r.notes.some((n) => /Ground plane = Substrate/.test(n)), `${stem} notes`, "missing 'Ground plane = Substrate' note");
    check(r.dimensions.filter((d) => d === "60").length === 2, `${stem} dedup`, `60 should appear exactly twice (x and y), got ${r.dimensions}`);
  }

  // --- publication figures
  for (const w of [88, 180]) {
    const figs = figureSet(b, w);
    // |S11|, Zin, Smith, one pattern per far-field entry, plus reflection and transmission S-matrix
    // charts for multi-port bundles
    const Sm = sMatrix(b);
    const nExp = 3 + (b.results?.farfield.length ?? 0) + (Sm && !Sm.legacy && Sm.ports.length > 1 ? 2 : 0);
    check(figs.length === nExp, `${stem} figures ${w}`, `expected ${nExp} figures, got ${figs.length}`);
    for (const f of figs) {
      checkSvg(`${stem} figure ${w} ${f.name}`, f.svg);
      check(f.svg.includes(`width="${w}mm"`), `${stem} figure ${f.name}`, `not ${w} mm wide`);
      if (w === 88) writeFileSync(join(outDir, `${stem}_${f.name}`), f.svg);
    }
  }

  // --- Touchstone round trip
  const s = sweep(b);
  if (s) {
    const ts = touchstoneS1p(b, "check");
    const where = `${stem} s1p`;
    // S11 is normalised to the port reference impedance (50 ohm for most models, 73 ohm for the dipole)
    const optLine = `# GHz S RI R ${s.zRef}`;
    check(ts.split("\n").some((l) => l === optLine), where, `option line is not '${optLine}'`);
    check(/^[\x00-\x7f]*$/.test(ts), where, "non-ASCII characters");
    const p = parseTouchstone(ts);
    check(p.f.length === s.f.length, where, `${p.f.length} rows, expected ${s.f.length}`);
    let maxErr = 0;
    p.f.forEach((f, i) => {
      maxErr = Math.max(maxErr, Math.abs(f - s.f[i]) / 1e9, Math.abs(p.re[i] - s.s11Re[i]), Math.abs(p.im[i] - s.s11Im[i]));
    });
    check(maxErr < 1e-8, where, `round-trip error ${maxErr}`);
    check(p.z0 === s.zRef && p.format === "RI" && p.parameter === "S" && p.unit === "GHZ", where, "option line parsed wrong");
    console.log(`  touchstone ${p.f.length} points, max round-trip error ${maxErr.toExponential(1)}`);

    // --- N-port Touchstone round trip (bundles with a complete multi-port S-matrix)
    const S = sMatrix(b);
    if (S && !S.legacy && S.ports.length > 1) {
      const n = S.ports.length;
      const tn = touchstoneNPort(b, "check");
      const whereN = `${stem} s${n}p`;
      check(!!tn, whereN, "no N-port Touchstone for a complete S-matrix");
      if (tn) {
        check(/^[\x00-\x7f]*$/.test(tn), whereN, "non-ASCII characters");
        const q = parseTouchstoneNPort(tn, n);
        check(q.f.length === S.f.length && q.z0 === S.zRef[0], whereN, "rows / reference impedance");
        let e = 0;
        q.s.forEach((m, k) => S.ports.forEach((pi, i) => S.ports.forEach((pj, j) => {
          const c = S.get(pi, pj);
          e = Math.max(e, Math.abs(m[i][j][0] - c.re[k]), Math.abs(m[i][j][1] - c.im[k]));
        })));
        check(e < 1e-8, whereN, `round-trip error ${e}`);
        const perRecord = n === 2 ? 1 : n * Math.ceil(n / 4);
        const dataLines = tn.split("\n").filter((l) => l && !l.startsWith("!") && !l.startsWith("#")).length;
        check(dataLines === perRecord * S.f.length, whereN, `${dataLines} data lines, expected ${perRecord * S.f.length}`);
        console.log(`  touchstone ${n}-port: ${q.f.length} points, round-trip error ${e.toExponential(1)}`);
      }
    }

    // --- CSV
    const rows = (t) => parseCsv(t).length - 1;
    const sw = parseCsv(sweepCsv(b));
    check(sw.length - 1 === s.f.length, `${stem} sweep.csv`, `${sw.length - 1} rows`);
    check(sw.every((r) => r.length === 7), `${stem} sweep.csv`, "ragged rows");
    check(Math.abs(Number(sw[1][1]) - s.s11Db[0]) < 1e-3, `${stem} sweep.csv`, "s11_dB mismatch");
    const bands = parseCsv(bandsCsv(b));
    const bandHeader = ["f_lo_GHz", "f_hi_GHz", "f_center_GHz", "f_best_GHz", "s11_min_dB", "fractional_bw", "bandwidth_MHz", "edge_lo", "edge_hi"];
    check(JSON.stringify(bands[0]) === JSON.stringify(bandHeader), `${stem} bands.csv`, "column set and order");
    check(bands.length - 1 === b.results.bands.length, `${stem} bands.csv`, "row count");
    b.results.bands.forEach((band, i) => {
      const row = bands[i + 1];
      const middle = (band.f_lo + band.f_hi) / 2;
      const expected = [band.f_lo / 1e9, band.f_hi / 1e9, middle / 1e9, band.f_center / 1e9, band.s11_min_db,
        (band.f_hi - band.f_lo) / middle, (band.f_hi - band.f_lo) / 1e6];
      const tolerance = [5.1e-7, 5.1e-7, 5.1e-7, 5.1e-7, 1e-12, 1e-12, 5.1e-4];
      check(row?.length === bandHeader.length, `${stem} bands.csv`, "rectangular rows");
      expected.forEach((value, col) => check(row?.[col] !== "" && Math.abs(Number(row?.[col]) - value) <= tolerance[col],
        `${stem} bands.csv ${i + 1} ${bandHeader[col]}`, "numeric value matches table definition"));
      check(row?.[7] === String(band.edge_lo) && row?.[8] === String(band.edge_hi), `${stem} bands.csv`, "open-edge flags");
    });
    for (const ff of b.results.farfield) {
      const t = patternCsv(ff);
      check(rows(t) === ff.theta.length * ff.phi.length, `${stem} pattern_${patternTag(ff.f)}.csv`, "row count");
      check(!/NaN|undefined/.test(t), `${stem} pattern csv`, "NaN/undefined");
      if (ff.cp) check(parseCsv(t)[0].length === 6 && Number(parseCsv(t)[1][3]) === ff.cp.rhcp_dbi[0][0], `${stem} pattern csv`, "circular-polarisation columns");
    }
    const sig = signalsCsv(b);
    if (sig) check(rows(sig) === b.results.signals.time_ns.length, `${stem} port_signals.csv`, "row count");
  }

  // --- PDF report (pages as SVG, then the vector PDF with embedded IBM Plex Sans)
  const now = new Date(b.created.replace(/(\d{2})(\d{2})$/, "$1:$2"));
  // the report of a full package lists its files ("Files and formats")
  const packaged = packageFiles(b, { project: true, readme: true, report: true, data: true, drawings: true, figures: true, cst: true, image: true }, { reportPdf: new Uint8Array(1), drawingPdf: new Uint8Array(1) }, now).map((f) => f.path);
  const ropt = { generated: b.created.slice(0, 16).replace("T", " "), date, pdfDate: now, files: packaged };
  const pages = reportPages(b, ropt);
  pages.forEach((p, i) => checkSvg(`${stem} report page ${i + 1}`, p, [`Page ${i + 1} / ${pages.length}`]));
  const allText = pages.map((p) => texts(p).join(" ")).join(" ");
  for (const ch of ["Ω", "ε", "δ", "θ", "φ", "−", "≤"]) check(allText.includes(ch), `${stem} report`, `no "${ch}" in the report text`);
  check(allText.includes(reproduceCommand(b)) || pages.some((p) => p.includes("fairbeam run")), `${stem} report`, "missing reproduce command");
  const pdf = await reportPdf(b, fonts, ropt);
  const info = pdfInfo(pdf);
  check(info.header === "%PDF-", `${stem} report.pdf`, "not a PDF");
  check(info.pages === pages.length, `${stem} report.pdf`, `${info.pages} pages, expected ${pages.length}`);
  check(info.embedded, `${stem} report.pdf`, "font not embedded");
  for (const ch of ["Ω", "ε", "δ", "θ", "φ", "−", "≤"]) check(info.codes.has(ch.codePointAt(0)), `${stem} report.pdf`, `glyph "${ch}" not mapped in the embedded font`);
  if (stem === "patch-antenna") writeFileSync(join(reportDir, `${stem}.pdf`), pdf);
  console.log(`  report ${pages.length} pages, ${(pdf.length / 1024).toFixed(0)} KiB, ${info.codes.size} glyphs mapped`);
  const drawingPdf = await svgPagesToPdf([technicalDrawing(b, { sheet: "A3", date }).svg], fonts, { title: b.name, date: now });
  check(pdfInfo(drawingPdf).pages === 1, `${stem} drawing_A3.pdf`, "page count");

  // --- package (without the browser-only 3D PNG)
  const all = { project: true, readme: true, report: true, data: true, drawings: true, figures: true, cst: true, image: true };
  const files = packageFiles(b, all, { reportPdf: pdf, drawingPdf }, now);
  const name = packageName(b, now);
  check(/^[a-z0-9_-]+_\d{8}-\d{4}\.zip$/i.test(name), `${stem} package`, `bad name ${name}`);
  const zip = zipPackage(files, name.replace(/\.zip$/, ""), now);
  const un = unzipSync(zip);
  const bandPath = Object.keys(un).find((p) => p.endsWith("/data/bands.csv"));
  check(!!bandPath && strFromU8(un[bandPath]) === bandsCsv(b), `${stem} package bands.csv`, "packaged CSV matches the writer");
  const paths = Object.keys(un).map((p) => p.split("/").slice(1).join("/"));
  // port time signals exist for lumped ports only (a waveguide port has no scalar reference impedance)
  const hasSignals = !!b.results.signals?.time_ns;
  const want = ["README.md", "project.json", "data/s11.s1p", "data/sweep.csv", "data/bands.csv", ...(hasSignals ? ["data/port_signals.csv"] : []), "drawings/drawing_A3.svg", "drawings/drawing_A3.pdf", "drawings/figure.svg", "figures/s11.svg", "figures/zin.svg", "figures/smith.svg", "report.pdf", `cst/${designStem(b.model.id)}.bas`,
    ...b.results.farfield.flatMap((_, i, ffs) => [`data/pattern_${ffTag(ffs, i)}.csv`, `figures/pattern_${ffTag(ffs, i)}.svg`])];
  for (const w of want) check(paths.includes(w), `${stem} package`, `missing ${w}`);
  const readme = strFromU8(un[Object.keys(un).find((p) => p.endsWith("README.md"))]);
  for (const w of want.filter((p) => p !== "README.md")) check(readme.includes(`\`${w}\``), `${stem} README`, `file index lacks ${w}`);
  check(!/NaN|undefined|\[object/.test(readme), `${stem} README`, "NaN/undefined");
  check(readme.includes("`f_center_GHz` is the middle of the edges") && readme.includes("`f_best_GHz`") && readme.includes("`edge_lo=true`") && readme.includes("`edge_hi=true`"),
    `${stem} README`, "CSV meanings and open-edge convention travel with the package");
  check(readme.includes(reproduceCommand(b)), `${stem} README`, "missing reproduce command");
  const json = JSON.parse(strFromU8(un[Object.keys(un).find((p) => p.endsWith("project.json"))]));
  check(json.name === b.name, `${stem} package`, "project.json differs");
  console.log(`  package ${name}: ${paths.length} files, ${(zip.length / 1024).toFixed(0)} KiB · ${reproduceCommand(b)}`);
  if (stem === "sierpinski-monopole--iterations-0") check(reproduceCommand(b).includes("--set iterations=0"), `${stem} reproduce`, "missing --set iterations=0");
  if (stem === "patch-antenna") check(!reproduceCommand(b).includes("--set"), `${stem} reproduce`, "no --set expected for defaults");
}

// --- package of a design with a grouped port: the CST macro refuses grouped discrete ports, so the package carries the
// geometry-only macro (and says so) instead of throwing, which used to take the whole Package dialog down
{
  const where = "grouped-port package";
  const raw = JSON.parse(readFileSync(join(projects, "dipole.json"), "utf8"));
  raw.ports[0].group = { connection: "parallel", members: [{ start: [-0.5, 2, -0.5], stop: [0.5, 2, 0.5], direction: "z", polarity: 1 }] };
  const v = validateBundle(raw);
  check(!!v.bundle && !v.errors.length, where, `the grouped bundle opens (${v.errors.join("; ")})`);
  if (v.bundle) {
    const b = v.bundle;
    const now = new Date(b.created.replace(/(\d{2})(\d{2})$/, "$1:$2"));
    const all = { project: true, readme: true, report: true, data: true, drawings: true, figures: true, cst: true, image: true };
    let files = null;
    try { files = packageFiles(b, all, {}, now); } catch (e) { fail(where, `packageFiles threw: ${e.message}`); }
    if (files) {
      const bas = files.find((f) => f.path === `cst/${designStem(b.model.id)}.bas`);
      check(!!bas, where, "the CST macro is still in the package");
      check(!!bas && !bas.data.includes("DiscretePort") && /grouped ports cannot be written as independent CST discrete ports/.test(bas.data), where, "the macro carries no port and says why");
      check(!!bas && /^CST-compatible VBA macro, geometry only/.test(bas.description), where, "the file list describes the macro as geometry only");
      const readme = files.find((f) => f.path === "README.md")?.data ?? "";
      check(readme.includes(`cst/${designStem(b.model.id)}.bas`) && readme.includes("geometry only"), where, "the README index says the macro is geometry only");
      check(JSON.parse(files.find((f) => f.path === "project.json").data).ports[0].group?.members.length === 1, where, "project.json keeps the group");
    }
    const plain = packageFiles(JSON.parse(readFileSync(join(projects, "dipole.json"), "utf8")), all, {}, now).find((f) => f.path.endsWith(".bas"));
    check(!!plain && plain.data.includes("DiscretePort") && plain.description === "CST-compatible VBA macro (default options)", where, "an ungrouped design keeps the default macro with its ports");
    console.log(`grouped-port package: ${files?.length ?? 0} files, CST macro geometry only`);
  }
}

// --- a design's instant preview (src/designer/geometry.ts quickBundle) exported as it is (Export package of a design
// without a run, Export > CST macro): the deliverables carry the design's own name, never an internal "(preview)" tag,
// and every file of one design shares one stem, the workspace id (export_patch.py, export_patch.design.json)
{
  const where = "design preview exports";
  const d = JSON.parse(readFileSync(join(root, "examples", "designs", "ux_inset_patch_24.design.json"), "utf8"));
  d.model = { ...d.model, id: "export-patch", name: "Export patch" };
  const v = validateBundle(quickBundle(d, paramValues(d.params).names, null));
  const b = v.bundle;
  check(!!b && b.preview === true && b.name === "Export patch", where, `the preview bundle is named after the design (${b?.name})`);
  if (b) {
    check(designStem(b.model.id) === "export_patch" && designStem("Patch antenna (v2)") === "Patch_antenna_v2" && designStem("") === "fairbeam", where, "designStem");
    const now = new Date(2026, 9, 6, 23, 38);
    const all = { project: true, readme: true, report: true, data: true, drawings: true, figures: true, cst: true, fab: true, image: true };
    const files = packageFiles(b, all, { reportPdf: new Uint8Array(1), drawingPdf: new Uint8Array(1) }, now);
    for (const f of files.filter((x) => typeof x.data === "string")) check(!f.data.includes("(preview)"), where, `${f.path} carries "(preview)"`);
    check(files.some((f) => f.path === "cst/export_patch.bas"), where, `the macro is cst/export_patch.bas (${files.filter((f) => f.path.startsWith("cst/")).map((f) => f.path)})`);
    const fab = files.filter((f) => f.path.startsWith("fab/") && f.path !== "fab/README.txt");
    check(fab.length > 0 && fab.every((f) => f.path.startsWith("fab/export_patch-")), where, `fab files share the stem (${fab.map((f) => f.path).join(", ")})`);
    check(packageName(b, now) === "export_patch_20261006-2338.zip", where, `package name ${packageName(b, now)}`);
    const drawing = technicalDrawing(b, { sheet: "A3", date: "2026-10-06" }).svg;
    check(texts(drawing).includes("Export patch") && !drawing.includes("(preview)"), where, "the drawing's title is the design name");
    const pages = reportPages(b, { generated: "2026-10-06 23:38", date: "2026-10-06" });
    check(!pages.some((pg) => pg.includes("(preview)")), where, "the PDF report carries (preview)");
    check(cstMacro(b, DEFAULT_CST_OPTIONS).text.split(/\r?\n/)[0] === "' Export patch", where, "the macro's first line is the design name");
    console.log(`design preview exports: ${files.length} files named export_patch*, no "(preview)" in any of them`);

    // geometry only: no simulation time stamp anywhere, only "Geometry only: not simulated"; the file lists name only
    // the files in the zip; every mm value rounded
    const readme = files.find((f) => f.path === "README.md").data;
    check(readme.includes("Geometry only: not simulated") && !/simulation ran on/i.test(readme), "geometry-only README", "a simulation time stamp in a geometry-only README");
    check(!readme.includes("data/s11.s1p") && !readme.includes("figures/"), "geometry-only README", "the README names files that are not in the package");
    check(!/built-in model layout/.test(readme) && !/-?\d+\.\d{4,}\b(?! mm²)/.test(readme.split("## Mesh")[1].split("## Run")[0]), "geometry-only README", "the Mesh section prints unrounded numbers or the model-layout text");
    const pdfText = pages.map((pg) => texts(pg).join(" ")).join(" ");
    check(pdfText.includes("Geometry only: not simulated") && !/Simulated \d{4}-/.test(pdfText), "geometry-only report", "a simulation time stamp in a geometry-only PDF report");
    check(!pdfText.includes("Files and formats"), "geometry-only report", "a report without its package lists package files");
    const listed = reportPages(b, { generated: "2026-10-06 23:38", date: "2026-10-06", files: files.map((f) => f.path) }).map((pg) => texts(pg).join(" ")).join(" ");
    check(listed.includes("Files and formats") && listed.includes("cst/*.bas") && listed.includes("fab/") && !listed.includes("data/s11.s1p") && !listed.includes("figures/"), "geometry-only report", "Files and formats does not follow the package's files");
    check(fileFormats(["README.md", "report.pdf"]).map((r) => r[0]).join() === "README.md" && fileFormats([]).length === 0, "fileFormats", "rows for files the package lacks");
    // the Key results box sits within the text margins (18 mm on each side of the A4 page)
    const box = /<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"[^>]*fill="#f4f4f4"/.exec(pages[0]);
    check(!!box && Number(box[1]) >= 18 - 1e-9 && Number(box[1]) + Number(box[2]) <= 210 - 18 + 1e-9, "report page 1", `the Key results box is outside the text margins (${box?.slice(1)})`);
  }
}

// --- a drawing number too long for one line goes on two, whole; a 300 dpi PNG says so (pHYs)
{
  const where = "drawing number";
  const b = validateBundle(JSON.parse(readFileSync(join(projects, "patch-antenna.json"), "utf8"))).bundle;
  const id = "a-very-long-model-id-for-a-colleagues-patch";
  const block = texts((() => { const s = technicalDrawing({ ...b, model: { ...b.model, id } }, { sheet: "A3", date: "2026-10-06" }).svg; return s.slice(s.indexOf('class="title-block"')); })());
  const want = `${id.toUpperCase()}-01`;
  const i = block.findIndex((s) => want.startsWith(s) && s.length > 4);
  check(i >= 0 && block[i] + block[i + 1] === want, where, `the number is not split into two whole lines: ${block.slice(Math.max(0, i), i + 2).join(" | ")}`);
  check(!block.some((s) => s.includes("…")), where, "a value is cut");

  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const x of bytes) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)).concat([...data]));
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length); out.set(body, 4); v.setUint32(8 + data.length, crc(body));
    return out;
  };
  const ihdr = new Uint8Array(13); new DataView(ihdr.buffer).setUint32(0, 1); new DataView(ihdr.buffer).setUint32(4, 1); ihdr.set([8, 6, 0, 0, 0], 8);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk("IHDR", ihdr), ...chunk("IDAT", zlibSync(new Uint8Array([0, 255, 0, 0, 255]))), ...chunk("IEND", new Uint8Array(0))]);
  check(pngDpi(png) === null, "png dpi", "a canvas PNG states no resolution");
  const at300 = withPngDpi(png, 300);
  const chunks = pngChunks(at300);
  check(chunks.map((c) => c.type).join() === "IHDR,pHYs,IDAT,IEND" && chunks.every((c) => c.crcOk), "png dpi", `chunks ${chunks.map((c) => c.type)}`);
  check(Math.abs(pngDpi(at300) - 300) < 0.01, "png dpi", `300 dpi stated as ${pngDpi(at300)}`);
  check(pngChunks(withPngDpi(at300, 150)).filter((c) => c.type === "pHYs").length === 1 && Math.abs(pngDpi(withPngDpi(at300, 150)) - 150) < 0.05, "png dpi", "a second call replaces the chunk");
}

// --- the reproduce command of a design's run: the design file in the workspace, the engine the run used (no thread
// count for a GPU run), and no text about a fixed model layout
{
  const where = "reproduce";
  const b = validateBundle(JSON.parse(readFileSync(join(projects, "patch-antenna.json"), "utf8"))).bundle;
  const design = { file: "export_patch.design.json", kind: "design" };
  const gpu = { ...b, model: { ...b.model, id: "export-patch" }, run: { ...b.run, engine: "gpu", threads: 1 } };
  const cmd = reproduceCommand(gpu, design);
  check(cmd.startsWith("fairbeam run '<workspace>/models/export_patch.design.json'") && cmd.includes("--engine gpu") && !cmd.includes("--threads"), where, `GPU design run: ${cmd}`);
  const cpu = reproduceCommand({ ...gpu, run: { ...b.run, engine: "cpu", threads: 2 } }, design);
  check(cpu.includes("--threads 2") && !cpu.includes("--engine"), where, `CPU design run: ${cpu}`);
  check(reproduceCommand(b, { file: "patch_antenna.py", kind: "python" }).startsWith("fairbeam run '<workspace>/models/patch_antenna.py'"), where, "Python model run");
  const files = packageFiles(gpu, { project: true, readme: true }, { model: design }, new Date(2026, 9, 6, 23, 53));
  const readme = files.find((f) => f.path === "README.md").data;
  check(readme.includes(cmd) && !/built-in model layout/.test(readme) && !/threads 1/.test(readme) && readme.includes("GPU engine"), where, "README: the GPU run's command and throughput line");
  check(!readme.includes("data/s11.s1p"), where, "the README names a Touchstone file the package does not hold");
  const pdf = reportPages(gpu, { generated: "2026-10-06 23:53", date: "2026-10-06", model: design }).map((pg) => texts(pg).join(" ")).join(" ");
  check(pdf.includes("export_patch.design.json") && pdf.includes("--engine gpu") && !/threads 1/.test(pdf) && !/built-in model layout/.test(pdf), where, "PDF report: the GPU run's command and solver line");
  check(!/\d\.\d{6,}/.test(pdf.split("Domain")[1]?.split("Converged")[0] ?? ""), where, "the PDF's Domain line is not rounded");
  console.log(`reproduce: ${cmd}`);
}

console.log(`\n${checks} checks, ${failures} failed. Examples in ${outDir}`);
if (failures) process.exit(1);
