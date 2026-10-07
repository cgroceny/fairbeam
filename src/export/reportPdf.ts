// One-file PDF report: A4 portrait pages composed as SVG (pure, testable in Node) and rendered to a
// vector PDF by src/drawing/pdfdoc.ts with IBM Plex Sans embedded.

import { withoutVoids } from "../lib/voidParts.ts";
import type { Bundle } from "../types";
import { convergenceText, efficiencyWarning, energyText, finalEnergy } from "../lib/run.ts";
import { technicalDrawing } from "../drawing/drawing.ts";
import { patternFigure, patternFigureFor, s11Figure, smithFigure, sparamFigure, zinFigure } from "../drawing/charts.ts";
import { activeReflection, arrayFarField, gammaDb, mainBeam, type Weight } from "../lib/array.ts";
import { elementPatterns, magDb, pairLabel, sMatrix } from "../lib/sparams.ts";
import { comparisonFigures } from "../drawing/charts.ts";
import { comparisonMetrics, metricsRows } from "../import/metrics.ts";
import type { RefBundle } from "../import/reference.ts";
import { fit, wrap } from "../drawing/metrics.ts";
import { esc, FONT, group, line, n, rect, text } from "../drawing/svg.ts";
import { svgPagesToPdf, type PdfFonts } from "../drawing/pdfdoc.ts";
import { engineText, meshText, reproduceCommand, reproduceNote, simulated, type ModelFileRef } from "./report.ts";
import { APP_VERSION, bundleWriter } from "../lib/appVersion.ts";

const W = 210;
const H = 297;
const ML = 18;
const MR = 18;
const TOP = 24;
const BOTTOM = 277;
const CW = W - ML - MR;
const FS = 3.1; // body ≈ 8.8 pt
const FS_S = 2.7; // tables ≈ 7.7 pt

export interface ReportOptions {
  /** "YYYY-MM-DD HH:MM" shown as the report date */
  generated: string;
  /** date for the drawing's title block (YYYY-MM-DD) */
  date?: string;
  /** fixed PDF creation date (reproducible files) */
  pdfDate?: Date;
  /** beam-steering weights for the array page (bundles with element patterns) */
  arrayWeights?: Map<number, Weight> | null;
  /** imported reference data to compare with */
  reference?: RefBundle | null;
  /** the paths of the package the report goes into (its "Files and formats" list); a report on its own has none */
  files?: readonly string[];
  /** the workspace file the bundle was run from (the reproduce command runs it) */
  model?: ModelFileRef | null;
}

const f3 = (hz: number) => (hz / 1e9).toFixed(3);
const fx = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d).replace(/^-/, "−"));
const minus = (s: string) => s.replace(/(^|[\s(])-(?=\d)/g, "$1−");

/** Inline a standalone SVG (from fairbeam) into a page at (x, y) with scale k. */
function embed(svg: string, x: number, y: number, k: number): string {
  const inner = svg.replace(/<\?xml[^>]*\?>/, "").replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title>[\s\S]*?<\/title>|<desc>[\s\S]*?<\/desc>/g, "");
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${n(k)})">${inner}</g>`;
}

function svgSizeOf(svg: string): [number, number] {
  const w = /<svg[^>]*\swidth="([\d.]+)mm"/.exec(svg);
  const h = /<svg[^>]*\sheight="([\d.]+)mm"/.exec(svg);
  return [Number(w?.[1] ?? 100), Number(h?.[1] ?? 100)];
}

type Align = "l" | "r";

class Doc {
  pages: string[][] = [];
  y = TOP;
  /** the left edge and the width text is set in: the page margins, inset inside a box */
  ml = ML;
  cw = CW;
  b: Bundle;
  opt: ReportOptions;
  constructor(b: Bundle, opt: ReportOptions) {
    this.b = b;
    this.opt = opt;
    this.newPage();
  }
  get page() {
    return this.pages[this.pages.length - 1];
  }
  newPage() {
    this.pages.push([]);
    this.y = TOP;
  }
  ensure(h: number) {
    if (this.y + h > BOTTOM) this.newPage();
  }
  space(h: number) {
    this.y += h;
  }
  h1(t: string) {
    this.ensure(14);
    this.page.push(text(ML, this.y + 6, t, { "font-size": 6.2, "font-weight": 600 }));
    this.y += 10;
  }
  h2(t: string) {
    this.ensure(12);
    this.y += 2;
    this.page.push(text(ML, this.y + 4, t, { "font-size": 4.2, "font-weight": 600 }));
    this.page.push(line(ML, this.y + 5.6, ML + CW, this.y + 5.6, { stroke: "#000", "stroke-width": 0.2 }));
    this.y += 9;
  }
  para(t: string, fs = FS, color = "#000") {
    const lines = wrap(minus(t), fs, this.cw);
    for (const l of lines) {
      this.ensure(fs * 1.45);
      this.page.push(text(this.ml, this.y + fs, l, { "font-size": fs, fill: color }));
      this.y += fs * 1.45;
    }
    this.y += fs * 0.5;
  }
  /** Two-column key/value list. */
  kv(rows: [string, string][], keyW = 46) {
    for (const [k, v] of rows) {
      const lines = wrap(minus(v), FS_S, this.cw - keyW);
      const h = Math.max(1, lines.length) * FS_S * 1.45 + 0.8;
      this.ensure(h);
      this.page.push(text(this.ml, this.y + FS_S, k, { "font-size": FS_S, fill: "#444" }));
      lines.forEach((l, i) => this.page.push(text(this.ml + keyW, this.y + FS_S + i * FS_S * 1.45, l, { "font-size": FS_S })));
      this.y += h;
    }
    this.y += 2;
  }
  /** Table with header; widths are fractions of the content width. Breaks across pages. */
  table(head: string[], rows: string[][], widths: number[], align: Align[] = [], x0 = this.ml, width = this.cw) {
    const rh = FS_S * 1.75;
    const ws = widths.map((w) => (w / widths.reduce((a, c) => a + c, 0)) * width);
    const cell = (s: string, i: number, y: number, bold = false) => {
      const cx = x0 + ws.slice(0, i).reduce((a, c) => a + c, 0);
      const t = fit(minus(s), FS_S, ws[i] - 2, bold ? 600 : 400);
      return align[i] === "r"
        ? text(cx + ws[i] - 1, y, t, { "font-size": FS_S, "text-anchor": "end", "font-weight": bold ? 600 : undefined })
        : text(cx + 1, y, t, { "font-size": FS_S, "font-weight": bold ? 600 : undefined });
    };
    const header = () => {
      this.page.push(...head.map((h, i) => cell(h, i, this.y + rh * 0.7, true)));
      this.page.push(line(x0, this.y + rh, x0 + width, this.y + rh, { stroke: "#000", "stroke-width": 0.25 }));
      this.y += rh;
    };
    this.ensure(rh * 2);
    this.page.push(line(x0, this.y, x0 + width, this.y, { stroke: "#000", "stroke-width": 0.35 }));
    header();
    rows.forEach((r, j) => {
      if (this.y + rh > BOTTOM) {
        this.newPage();
        header();
      }
      this.page.push(...r.map((c, i) => cell(c, i, this.y + rh * 0.7)));
      this.y += rh;
      if (j < rows.length - 1) this.page.push(line(x0, this.y, x0 + width, this.y, { stroke: "#bbb", "stroke-width": 0.12 }));
    });
    this.page.push(line(x0, this.y, x0 + width, this.y, { stroke: "#000", "stroke-width": 0.35 }));
    this.y += 4;
  }
  /** A figure (standalone fairbeam SVG) scaled to the width, with a caption; own page if needed. */
  figure(svg: string, caption: string, maxH = BOTTOM - TOP - 14) {
    const [w, h] = svgSizeOf(svg);
    const k = Math.min(1, CW / w, maxH / h);
    const fh = h * k;
    this.ensure(fh + 10);
    this.page.push(embed(svg, ML + (CW - w * k) / 2, this.y, k));
    this.y += fh + 2;
    for (const l of wrap(caption, FS_S, CW)) {
      this.page.push(text(ML + CW / 2, this.y + FS_S, l, { "font-size": FS_S, "text-anchor": "middle", fill: "#333" }));
      this.y += FS_S * 1.45;
    }
    this.y += 4;
  }
  /** Figures side by side, each scaled to its share of the width, with one caption. */
  row(svgs: string[], caption: string) {
    const gap = 6;
    const slot = (CW - gap * (svgs.length - 1)) / svgs.length;
    const sizes = svgs.map(svgSizeOf);
    const ks = sizes.map(([w]) => Math.min(1, slot / w));
    const hMax = Math.max(...sizes.map(([, h], i) => h * ks[i]));
    this.ensure(hMax + 10);
    svgs.forEach((svg, i) => this.page.push(embed(svg, ML + i * (slot + gap) + (slot - sizes[i][0] * ks[i]) / 2, this.y, ks[i])));
    this.y += hMax + 2;
    for (const l of wrap(caption, FS_S, CW)) {
      this.page.push(text(ML + CW / 2, this.y + FS_S, l, { "font-size": FS_S, "text-anchor": "middle", fill: "#333" }));
      this.y += FS_S * 1.45;
    }
    this.y += 4;
  }
  /** A shaded box within the text margins; its content is inset by `pad` on each side. */
  box(draw: () => void, pad = 3) {
    const y0 = this.y;
    const page = this.page;
    this.y += pad;
    this.ml = ML + pad;
    this.cw = CW - 2 * pad;
    try { draw(); } finally { this.ml = ML; this.cw = CW; }
    page.splice(0, 0, rect(ML, y0, CW, this.y - y0, { fill: "#f4f4f4", stroke: "#000", "stroke-width": 0.25 }));
    this.y += pad;
  }
  render(): string[] {
    const b = this.b;
    const N = this.pages.length;
    return this.pages.map((body, i) => {
      const head = [
        text(ML, 13, "Fairbeam · simulation report", { "font-size": 2.5, fill: "#444" }),
        text(W - MR, 13, fit(b.name, 2.5, 110), { "font-size": 2.5, fill: "#444", "text-anchor": "end" }),
        line(ML, 15, W - MR, 15, { stroke: "#000", "stroke-width": 0.2 }),
      ];
      const foot = [
        line(ML, 283, W - MR, 283, { stroke: "#000", "stroke-width": 0.2 }),
        text(ML, 287.5, fit(`Fairbeam ${APP_VERSION} · ${b.solver.engine}${b.generator.openems ? ` ${b.generator.openems.split(/\.post|\+/)[0]}` : ""} · generated ${this.opt.generated}`, 2.5, 140), { "font-size": 2.5, fill: "#444" }),
        text(W - MR, 287.5, `Page ${i + 1} / ${N}`, { "font-size": 2.5, fill: "#444", "text-anchor": "end" }),
      ];
      return (
        `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" font-family="${esc(FONT)}">` +
        `<title>${esc(`${b.name} — report page ${i + 1}`)}</title>` +
        rect(0, 0, W, H, { fill: "#fff", stroke: "none" }) +
        group([...head, ...body, ...foot], { fill: "#000" }) +
        "</svg>\n"
      );
    });
  }
}

/** The "Files and formats" rows for the paths of a package: one row per kind of file it holds, nothing it lacks. */
export function fileFormats(paths: readonly string[]): [string, string][] {
  const has = (re: RegExp) => paths.some((p) => re.test(p));
  const rows: [string, string][] = [];
  if (has(/^project\.json$/)) rows.push(["project.json", "The complete Fairbeam bundle (schema fairbeam.project/1): geometry, mesh, solver setup, run statistics and all results."]);
  if (has(/^data\/s11\.s1p$/)) rows.push(["data/s11.s1p", "Touchstone v1, option line “# GHz S RI R <port impedance>”: frequency in GHz, Re and Im of S11. Most RF tools read it directly, so it can be overlaid on other S11 results."]);
  if (has(/^data\/sparams\.s\d+p$/)) rows.push(["data/sparams.sNp", "Touchstone S-matrix of every port."]);
  if (has(/^data\/.*\.csv$/)) rows.push(["data/*.csv", "Sweep (f, |S11| dB, S11, VSWR, Zin), matched bands, far-field summary, directivity over θ and φ (long format) and port time signals."]);
  const dr = has(/^drawings\//), fi = has(/^figures\//);
  if (dr || fi) {
    rows.push([[dr ? "drawings/" : "", fi ? "figures/" : ""].filter(Boolean).join(", "),
      dr && fi ? "Black-and-white vector drawings and publication figures (SVG; the A3 drawing also as PDF)."
        : dr ? "Black-and-white vector drawings (SVG; the A3 drawing also as PDF)." : "Black-and-white publication figures (SVG)."]);
  }
  if (has(/^cst\/.*\.bas$/)) rows.push(["cst/*.bas", "CST-compatible VBA macro that rebuilds the model."]);
  if (has(/^cst\/.*\.stl$/)) rows.push(["cst/*.stl", "Polyhedra of the model as STL files; the macro imports them, so keep them next to the .bas."]);
  if (has(/^fab\//)) rows.push(["fab/", "Fabrication files: Gerber X2 copper and outline, Excellon drill, DXF per layer and a README with the stack-up."]);
  if (has(/^images\//)) rows.push(["images/", "PNG of the 3D view."]);
  if (has(/^comparison\//)) rows.push(["comparison/", "Comparison with the imported reference data: metrics, notes, overlay figures and the reference files."]);
  if (has(/^README\.md$/)) rows.push(["README.md", "This report as text, with the list of every file."]);
  return rows;
}

/** The report as A4 SVG pages. */
export function reportPages(bundle: Bundle, opt: ReportOptions): string[] {
  const b = withoutVoids(bundle);
  const d = new Doc(b, opt);
  const r = b.results;
  const run = b.run;

  // ---- page 1: summary
  d.h1(b.name);
  d.para(`${b.model.name} (${b.model.id})`, 3.6, "#333");
  d.para(b.model.description);
  if (b.model.reference) d.para(`Reference: ${b.model.reference}`, FS_S, "#333");
  d.space(2);
  d.kv([
    ["Simulated", simulated(b) ? b.created : "Geometry only: not simulated"],
    ["Report generated", opt.generated],
    ["Generator", [bundleWriter(b), b.generator.python && b.generator.python !== "?" ? `Python ${b.generator.python}` : null].filter(Boolean).join(", ") || "—"],
    ["Solver", `${b.solver.engine}${b.generator.openems ? ` ${b.generator.openems}` : ""} — ${b.solver.method}`],
    ["CSXCAD", b.generator.csxcad ?? "—"],
    ["Host", run ? `${run.host.os} ${run.host.machine}${run.host.cpu ? `, ${run.host.cpu}` : ""}` : "—"],
  ]);
  d.box(() => {
    d.page.push(text(d.ml, d.y + 4, "Key results", { "font-size": 4, "font-weight": 600 }));
    d.y += 7;
    if (!r) {
      d.para("Geometry only: not simulated.");
      return;
    }
    const conv = run
      ? `${run.converged ? "✓ " : ""}${convergenceText(run, b.solver.end_criteria_db, { maxTimesteps: b.solver.max_timesteps, minCell: b.mesh.min_cell }).replace(/-(?=\d)/g, "−").replace(/\.$/, "")}, ${fx(run.solver_time_s, 1)} s solver time.`
      : "No run statistics.";
    d.para(conv, FS_S);
    d.page.push(text(d.ml, d.y + FS_S, "Matched bands (|S11| < −10 dB)", { "font-size": FS_S, "font-weight": 600 }));
    d.y += FS_S * 1.8;
    if (r.bands.length)
      d.table(
        ["Centre (GHz)", "Range (GHz)", "Bandwidth (MHz)", "Fractional BW (%)", "|S11| min (dB)"],
        r.bands.map((x) => [f3(x.f_center), `${f3(x.f_lo)} – ${f3(x.f_hi)}`, fx((x.f_hi - x.f_lo) / 1e6, 1), fx(x.fractional_bw * 100, 2), fx(x.s11_min_db, 2)]),
        [1, 1.5, 1.1, 1.1, 1], ["r", "r", "r", "r", "r"],
      );
    else d.para("No band reaches −10 dB.", FS_S);
    d.page.push(text(d.ml, d.y + FS_S, "Far field", { "font-size": FS_S, "font-weight": 600 }));
    d.y += FS_S * 1.8;
    if (r.farfield.length)
      d.table(
        ["f (GHz)", "Dmax (dBi)", "Gain (dBi)", "Realized gain (dBi)", "Rad. efficiency (%)"],
        r.farfield.map((x) => [f3(x.f), fx(x.dmax_dbi), fx(x.gain_dbi), fx(x.realized_gain_dbi), x.rad_efficiency === null ? "—" : fx(x.rad_efficiency * 100, 1)]),
        [1, 1, 1, 1.2, 1.2], ["r", "r", "r", "r", "r"],
      );
    else d.para("No far-field data.", FS_S);
    for (const w of r.farfield.map((ff) => efficiencyWarning(ff)).filter((x): x is string => x !== null))
      d.para(`QA warning: ${w.replace(/-(?=\d)/g, "−")}`, FS_S * 0.95, "#8a5a00");
    if (r.farfield.some((x) => (x.mirror_planes ?? 0) > 0))
      d.para("Directivity, gain and efficiency refer to the physical half space above the infinite PEC ground (mirror-corrected by 2^m); patterns are defined for θ ≤ 90°.", FS_S * 0.95, "#333");
  });

  // at a glance: |S11| and the first pattern
  const glance = [s11Figure(b, { widthMm: 88, heightMm: 64 }), r?.farfield.length ? patternFigure(b, 0, { widthMm: 80 }) : null].filter((x): x is string => !!x);
  if (glance.length) {
    d.space(4);
    d.row(glance, `At a glance: |S11| versus frequency${glance.length > 1 ? ` and directivity cuts at ${f3(r!.farfield[0].f)} GHz` : ""} (details on the following pages).`);
  }

  // ---- page 2: technical drawing
  d.newPage();
  d.h2("Technical drawing");
  const drawing = technicalDrawing(b, { sheet: "figure", figureWidthMm: CW, date: opt.date, paramLabels: true });
  d.figure(drawing.svg, `Figure 1. ${b.name}: orthographic views (third-angle projection) and isometric view; dimensions in mm, labelled with the model parameter where one matches.`, BOTTOM - d.y - 12);

  // ---- page 3: setup tables
  d.newPage();
  d.h2("Parameters");
  d.table(
    ["Key", "Label", "Value", "Default", "Unit"],
    b.model.params.map((p) => [p.key, p.label, `${p.value}${p.value !== p.default ? " *" : ""}`, String(p.default), p.unit || "—"]),
    [1, 2.4, 0.9, 0.9, 0.6], ["l", "l", "r", "r", "l"],
  );
  if (b.model.params.some((p) => p.value !== p.default)) d.para("* differs from the model default.", FS_S, "#333");
  d.h2("Geometry and materials");
  d.table(
    ["Part", "Type", "Primitives", "εr", "tan δ", "Size (mm)"],
    b.parts.map((p) => [
      p.label ?? p.name, p.type === "Material" ? "Dielectric" : p.type === "Metal" ? "PEC" : p.type, String(p.primitives.length),
      p.material ? String(p.material.eps_r) : "—",
      p.material?.tan_d != null ? `${p.material.tan_d}${p.material.tan_d_freq ? ` @ ${f3(p.material.tan_d_freq)} GHz` : ""}` : "—",
      p.bbox[1].map((v, i) => Number((v - p.bbox[0][i]).toFixed(3))).join(" × "),
    ]),
    [1.5, 0.9, 0.8, 0.5, 1.3, 1.4], ["l", "l", "r", "r", "l", "r"],
  );
  if (b.half_space) d.para(`Infinite ${b.half_space.kind} ground plane at z = ${b.half_space.position} mm (boundary condition; image theory).`, FS_S);
  d.table(
    ["Port", "Type", "R (Ω)", "Direction", "Start (mm)", "Stop (mm)", "Excited"],
    b.ports.map((p) => [String(p.number), p.type, String(p.R), p.direction, p.start.join(", "), p.stop.join(", "), p.excite ? "yes" : "no"]),
    [0.5, 0.8, 0.6, 0.8, 1.3, 1.3, 0.7], ["r", "l", "r", "l", "r", "r", "l"],
  );
  d.h2("Solver, mesh and run");
  const ex = b.solver.excitation;
  const mesh = meshText(b);
  d.kv([
    ["Method", b.solver.method],
    ["Excitation", `${ex.type}${ex.dc_free ? " (DC-free)" : ""}, ${f3(ex.f_min)} – ${f3(ex.f_max)} GHz`],
    ["Boundaries", Object.entries(b.solver.boundaries).map(([k, v]) => `${k} ${v}`).join(", ")],
    ["End criterion", `${b.solver.end_criteria_db} dB, at most ${b.solver.max_timesteps} timesteps`],
    ["Mesh", mesh.size === "—" ? mesh.cells : `${mesh.cells} cells, cell size ${mesh.size}`],
    ["Domain", mesh.domain],
    ...(run
      ? ([
          ["Converged", run.converged ? `yes, final energy ${energyText(finalEnergy(run, b.solver.end_criteria_db)).replace(/-(?=\d)/g, "−")}` : `no${run.hit_timestep_limit ? " (timestep limit)" : ""}`],
          ["Timesteps", String(run.timesteps ?? "—")],
          ["Solver time", `${fx(run.solver_time_s, 2)} s (wall ${fx(run.wall_time_s, 2)} s), ${fx(run.speed_mcells_s, 1)} MCells/s, ${engineText(b)}`],
        ] as [string, string][])
      : []),
  ]);

  // ---- result figures
  let fig = 2;
  const s11 = s11Figure(b, { widthMm: CW, heightMm: 105 });
  if (s11) {
    d.newPage();
    d.h2("Input reflection coefficient");
    d.figure(s11, `Figure ${fig++}. |S11| versus frequency; the dashed line marks −10 dB and the dots the band centres.`);
    if (r?.bands.length)
      d.table(["Band", "f_lo (GHz)", "f_hi (GHz)", "Centre (GHz)", "|S11| min (dB)"], r.bands.map((x, i) => [String(i + 1), f3(x.f_lo), f3(x.f_hi), f3(x.f_center), fx(x.s11_min_db, 2)]), [0.6, 1, 1, 1, 1], ["r", "r", "r", "r", "r"]);
  }
  const zin = zinFigure(b, { widthMm: CW, heightMm: 105 });
  if (zin) {
    d.newPage();
    d.h2("Input impedance");
    d.figure(zin, `Figure ${fig++}. Real (solid, circles) and imaginary (dashed, squares) part of Zin; the dotted line marks the port reference impedance.`);
  }
  const smith = smithFigure(b, { widthMm: 150 });
  if (smith) {
    d.newPage();
    d.h2("Smith chart");
    d.figure(smith, `Figure ${fig++}. S11 on the Smith chart (normalised to the port impedance) from ${r ? f3(r.frequency[0]) : ""} to ${r ? f3(r.frequency[r.frequency.length - 1]) : ""} GHz.`);
  }
  // N-port S-matrix
  const S = sMatrix(b);
  if (S && S.ports.length > 1) {
    d.newPage();
    d.h2(`S-parameters (${S.ports.length} ports)`);
    const refl = sparamFigure(b, "reflection", { widthMm: CW, heightMm: 80 });
    if (refl) d.figure(refl, `Figure ${fig++}. Reflection coefficient |S_ii| of every port (−10 dB dashed).`, 95);
    const trans = sparamFigure(b, "transmission", { widthMm: CW, heightMm: 80 });
    if (trans) d.figure(trans, `Figure ${fig++}. Port coupling |S_ij|.`, 95);
    const fc = r?.bands[0]?.f_center ?? S.f[Math.floor(S.f.length / 2)];
    const k = S.f.reduce((best, f, i) => (Math.abs(f - fc) < Math.abs(S.f[best] - fc) ? i : best), 0);
    d.table(
      ["Pair", `|S| at ${f3(S.f[k])} GHz (dB)`, "min over band (dB)", "max over band (dB)"],
      S.pairs.map((p) => {
        const db = magDb(S.get(p[0], p[1])!);
        return [pairLabel(p), fx(db[k]), fx(Math.min(...db)), fx(Math.max(...db))];
      }),
      [0.8, 1.4, 1.2, 1.2], ["l", "r", "r", "r"],
    );
    d.kv([
      ["Reference impedances", S.ports.map((p, i) => `P${p} ${S.zRef[i]} Ω`).join(", ")],
      ["Excited ports", S.excited.map((p) => `P${p}`).join(", ") || "—"],
      ["Reciprocity (max |S_ij − S_ji|)", S.reciprocity === null ? "—" : S.reciprocity.toExponential(2)],
      ["Passivity (max column power)", S.passivity === null ? "—" : `${fx(S.passivity, 4)}${S.passivity > 1.001 ? " (> 1: not passive)" : ""}`],
    ], 60);
  }
  // steered array pattern at the current weights
  const weights = opt.arrayWeights;
  if (weights?.size) {
    for (const set of elementPatterns(b)) {
      const ff = arrayFarField(b, set, weights);
      const beam = mainBeam(ff.theta, ff.phi, ff.directivity_dbi, !!b.half_space);
      const p = patternFigureFor(b, ff, { widthMm: 150, title: `Array directivity (dBi), f = ${f3(ff.f)} GHz` });
      if (!p) continue;
      d.newPage();
      d.h2(`Array pattern at ${f3(ff.f)} GHz (current weights)`);
      d.figure(p, `Figure ${fig++}. Array pattern |Σ w_i E_i|² from the embedded element patterns, normalised to directivity by integrating over ${b.half_space ? "the upper half space" : "the sphere"}; cuts φ = 0° and φ = 90°.`);
      const g = S ? activeReflection(S, weights, ff.f) : new Map<number, [number, number] | null>();
      d.table(
        ["Port", "Amplitude (dB)", "Phase (°)", "Active |Γ| (dB)", ""],
        [...weights].map(([port, w]) => {
          const x = g.get(port);
          const db = x ? gammaDb(x) : null;
          return [`P${port}`, fx(w.ampDb, 2), fx(w.phaseDeg, 1), db === null ? "—" : fx(db, 2), db !== null && db > -10 ? "above −10 dB" : ""];
        }),
        [0.6, 1, 1, 1, 1.2], ["l", "r", "r", "r", "l"],
      );
      d.kv([
        ["Main beam", `θ = ${beam.theta}°, φ = ${beam.phi}°`],
        ["Dmax", `${fx(beam.dmaxDbi)} dBi`],
        ["HPBW", `${beam.hpbwTheta === null ? "—" : `${fx(beam.hpbwTheta, 1)}°`} (elevation cut), ${beam.hpbwPhi === null ? "—" : `${fx(beam.hpbwPhi, 1)}°`} (across)`],
      ]);
    }
  }
  (r?.farfield ?? []).forEach((ff, i) => {
    const p = patternFigure(b, i, { widthMm: 150 });
    if (!p) return;
    d.newPage();
    d.h2(`Radiation pattern at ${f3(ff.f)} GHz`);
    d.figure(p, `Figure ${fig++}. Directivity cuts φ = 0° (xz plane, solid) and φ = 90° (yz plane, dashed); θ measured from +z.`);
    d.kv([
      ["Dmax", `${fx(ff.dmax_dbi)} dBi`],
      ["Gain / realized gain", `${fx(ff.gain_dbi)} dBi / ${fx(ff.realized_gain_dbi)} dBi`],
      ["Radiation efficiency", ff.rad_efficiency === null ? "—" : `${fx(ff.rad_efficiency * 100, 1)} %`],
      ["Mirror planes", String(ff.mirror_planes ?? 0)],
    ]);
  });

  // ---- comparison with imported reference data
  const ref = opt.reference;
  if (ref && r) {
    const m = comparisonMetrics(b, ref);
    d.newPage();
    d.h2(`Comparison: ${ref.reference.label}`);
    d.table(
      ["Quantity", "openEMS", "Reference", "Difference", "Unit"],
      metricsRows(m).map((row) => row.map((v) => (v === null ? "—" : String(v)))),
      [2.2, 0.9, 0.9, 1.1, 0.8], ["l", "r", "r", "r", "l"],
    );
    d.para("Differences are reference − openEMS.", FS_S, "#333");
    for (const cf of comparisonFigures(b, ref, { widthMm: CW, heightMm: 78 })) {
      const what = cf.name.startsWith("s11") ? "|S11|: openEMS (solid) and the reference (dashed)." : "Pattern cuts: openEMS (solid) and the reference (dashed); circles φ = 0°, squares φ = 90°.";
      d.figure(cf.svg, `Figure ${fig++}. ${what}`, 100);
    }
    d.kv([
      ...(m.s11 ? ([["S-parameter grid", m.s11.grid]] as [string, string][]) : []),
      ...(m.pattern ? ([["Pattern grid", m.pattern.grid]] as [string, string][]) : []),
      ...[...ref.reference.notes, ...m.notes].map((n, i) => [i ? "" : "Notes", n] as [string, string]),
    ], 40);
  }

  // ---- last page: reproduce + file notes
  d.newPage();
  d.h2("Reproduce");
  d.para("Run the same model with the fairbeam command (openEMS installed, see the Fairbeam README):", FS);
  const cmd = reproduceCommand(b, opt.model);
  const cl = wrap(cmd, FS_S, CW - 6);
  const y0 = d.y;
  d.page.push(rect(ML, y0, CW, cl.length * FS_S * 1.5 + 3, { fill: "#f0f0f0", stroke: "none" }));
  cl.forEach((l, i) => d.page.push(text(ML + 3, y0 + 2 + FS_S + i * FS_S * 1.5, l, { "font-size": FS_S })));
  d.y += cl.length * FS_S * 1.5 + 6;
  d.para(reproduceNote(b, opt.model).replace(/`/g, ""), FS_S, "#333");
  // the files of the package this report goes into, from its own entries (a report saved on its own has none)
  const formats = fileFormats(opt.files ?? []);
  if (formats.length) {
    d.h2("Files and formats");
    d.kv(formats, 34);
  }
  d.h2("Notes");
  d.para("openEMS uses a staircase (Yee) FDTD mesh: slanted edges snap to mesh lines and zero-thickness sheets sit on grid planes. Expect resonances to differ by a few percent from conformal solvers unless the mesh is fine on metal edges; check mesh convergence before trusting a number.", FS_S);
  return d.render();
}

/** The report as a vector PDF. */
export async function reportPdf(b: Bundle, fonts: PdfFonts, opt: ReportOptions): Promise<Uint8Array> {
  return svgPagesToPdf(reportPages(b, opt), fonts, { title: `${b.name} — Fairbeam report`, subject: b.model.description, date: opt.pdfDate });
}
