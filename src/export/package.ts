// "Export everything": a zip with the bundle, a README report, Touchstone/CSV data, B&W drawings and
// figures, the CST macro and a 3D view. The file assembly is pure (runs in Node for the checks);
// the browser adds the PNG capture and the PDF (see src/components/PackageDialog.tsx).

import { strToU8, zipSync } from "fflate";
import type { Bundle } from "../types";
import { cstMacro, DEFAULT_CST_OPTIONS } from "./cst.ts";
import { arrayWeightsCsv, bandsCsv, farfieldCsv, patternCsv, signalsCsv, sparamsCsv, sweepCsv } from "./csv.ts";
import { readmeReport } from "./report.ts";
import * as touchstone from "./touchstone.ts";
import { touchstoneS1p } from "./touchstone.ts";
import { sweep } from "../lib/rf.ts";
import { technicalDrawing } from "../drawing/drawing.ts";
import { COLUMN_WIDTH, ffTag, patternFigure, patternFigureFor, patternTag, s11Figure, smithFigure, sparamFigure, zinFigure } from "../drawing/charts.ts";
import { arrayFarField, mainBeam, type Weight } from "../lib/array.ts";
import { elementPatterns, sMatrix } from "../lib/sparams.ts";
import { comparisonFigures } from "../drawing/charts.ts";
import { comparisonMetrics, metricsRows } from "../import/metrics.ts";
import type { RefBundle } from "../import/reference.ts";
import { toCsv } from "./csv.ts";
import { fabFiles, fabModel } from "../fab/index.ts";

/**
 * N-port Touchstone writer, provided by the physics side in touchstone.ts (not edited here). The
 * candidate names are tried in order; each takes (bundle, exportedTimestamp) and returns the file
 * text or null. Until one exists, multi-port packages carry data/sparams.csv only.
 */
export function touchstoneNPort(b: Bundle, exported: string): string | null {
  const mod = touchstone as unknown as Record<string, unknown>;
  for (const name of ["touchstoneNPort", "touchstoneSnp", "touchstoneNp", "touchstoneMultiport", "touchstoneSNP"]) {
    const fn = mod[name];
    if (typeof fn === "function") return (fn as (b: Bundle, e: string) => string | null)(b, exported);
  }
  return null;
}

/** Steered array patterns at the given weights, one per element-pattern frequency. */
export function steeredPatterns(b: Bundle, weights: Map<number, Weight>) {
  return elementPatterns(b).map((set) => {
    const ff = arrayFarField(b, set, weights);
    return { ff, beam: mainBeam(ff.theta, ff.phi, ff.directivity_dbi, !!b.half_space) };
  });
}

const weightsText = (w: Map<number, Weight>) => [...w].map(([p, x]) => `P${p} ${Number(x.ampDb.toFixed(2))} dB ∠${Number(x.phaseDeg.toFixed(1))}°`).join(", ");

export type PackageGroup = "project" | "readme" | "report" | "data" | "drawings" | "figures" | "cst" | "fab" | "image";

export const PACKAGE_GROUPS: { id: PackageGroup; label: string; hint: string }[] = [
  { id: "project", label: "Project bundle", hint: "project.json, the bundle as loaded" },
  { id: "readme", label: "README report", hint: "Model, parameters, solver, mesh, run statistics, results and a reproduce command" },
  { id: "report", label: "PDF report", hint: "report.pdf: A4 summary, drawing, setup tables, |S11|, Zin, Smith chart, patterns" },
  { id: "data", label: "Data", hint: "Touchstone s11.s1p, sweep, bands, far-field patterns and port signals as CSV" },
  { id: "drawings", label: "Technical drawings", hint: "A3 sheet (SVG and PDF) and a figure-mode drawing for papers" },
  { id: "figures", label: "Publication figures", hint: "B&W |S11|, Zin, Smith, pattern (and S-matrix / steered array) charts, 8.8 and 18 cm wide (SVG)" },
  { id: "cst", label: "CST macro", hint: "VBA macro with the default export options" },
  { id: "fab", label: "Fabrication files", hint: "fab/: Gerber X2 copper and outline, Excellon drill, DXF R12 per layer and a stack-up README (preview; printed boards only)" },
  { id: "image", label: "3D view", hint: "PNG of the current 3D view" },
];

/** Whether the package's CST macro leaves the ports out: a grouped port cannot be written as independent discrete ports. */
export const cstGeometryOnly = (b: Bundle) => b.ports.some((p) => p.group);

const CST_GROUPED_NOTE = "ports and lumped elements are not included, because grouped ports cannot be written as independent CST discrete ports";

/** Why the design has no fabrication export (not a printed board), or null when it has one. */
export function fabUnavailable(b: Bundle): string | null {
  const m = fabModel(b);
  return m.available ? null : m.reason;
}

export interface PackageExtras {
  /** PNG of the 3D view */
  isoPng?: Uint8Array | null;
  /** PDF of the A3 drawing */
  drawingPdf?: Uint8Array | null;
  /** the one-file PDF report (src/export/reportPdf.ts) */
  reportPdf?: Uint8Array | null;
  /** current beam-steering weights (bundles with element patterns) */
  arrayWeights?: Map<number, Weight> | null;
  /** imported reference data (Touchstone / CSV) to compare with */
  reference?: RefBundle | null;
}

export interface PackageFile {
  path: string;
  description: string;
  data: Uint8Array | string;
}

const p2 = (n: number) => String(n).padStart(2, "0");
export const stamp = (d: Date) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
const safeId = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_") || "fairbeam";

export const packageName = (b: Bundle, now: Date) => `${safeId(b.model.id)}_${stamp(now)}.zip`;

/** Local time as "YYYY-MM-DD HH:MM (UTC±hh:mm)". */
export function localTime(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "−";
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())} (UTC${sign}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)})`;
}

/** The package's files in order; README.md is generated last so it can index the others. */
export function packageFiles(b: Bundle, include: Record<PackageGroup, boolean>, extras: PackageExtras = {}, now: Date = new Date()): PackageFile[] {
  const files: PackageFile[] = [];
  const add = (path: string, description: string, data: Uint8Array | string | null | undefined) => {
    if (data !== null && data !== undefined) files.push({ path, description, data });
  };
  const date = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  if (include.project) add("project.json", `Fairbeam bundle (${b.schema})`, JSON.stringify(b));
  if (include.report) add("report.pdf", "PDF report: summary, technical drawing, setup, |S11|, Zin, Smith chart and patterns (A4)", extras.reportPdf);
  if (include.data && b.results) {
    add("data/s11.s1p", `S11 of the excited port, Touchstone v1 (GHz, RI, R ${Number((sweep(b)?.zRef ?? 50).toFixed(2))})`, touchstoneS1p(b, localTime(now)));
    add("data/sweep.csv", "f, |S11| dB, S11 re/im, VSWR, Zin re/im per frequency point", sweepCsv(b));
    add("data/bands.csv", "Matched bands (|S11| < −10 dB)", bandsCsv(b));
    add("data/farfield.csv", "Dmax, gain, realized gain, efficiency per pattern frequency", farfieldCsv(b));
    b.results.farfield.forEach((ff, i, ffs) => add(`data/pattern_${ffTag(ffs, i)}.csv`, `Directivity (dBi) over θ, φ at ${patternTag(ff.f).replace("GHz", " GHz")}${ff.port != null ? `, port ${ff.port} driven` : ""} (long format)`, patternCsv(ff)));
    add("data/port_signals.csv", "Port time signals: incident, reflected, total voltage, scaled current", signalsCsv(b));
    const S = sMatrix(b);
    if (S && S.ports.length > 1) {
      add(`data/sparams.s${S.ports.length}p`, `${S.ports.length}-port S-matrix, Touchstone`, touchstoneNPort(b, localTime(now)));
      add("data/sparams.csv", "All stored S_ij: dB, phase, re/im per frequency point", sparamsCsv(b));
    }
    if (extras.arrayWeights?.size) {
      const set = elementPatterns(b)[0];
      if (set) add("data/array_weights.csv", `Beam-steering weights (${weightsText(extras.arrayWeights)}) and active reflection`, arrayWeightsCsv(b, extras.arrayWeights, set.f));
    }
  }
  if (include.drawings) {
    add("drawings/drawing_A3.svg", "Technical drawing, A3 sheet, third-angle projection (vector)", technicalDrawing(b, { sheet: "A3", date }).svg);
    add("drawings/drawing_A3.pdf", "Technical drawing, A3 sheet (vector PDF)", extras.drawingPdf);
    add("drawings/figure.svg", "Technical drawing, figure mode (16 cm wide, no sheet)", technicalDrawing(b, { sheet: "figure", date }).svg);
  }
  if (include.figures && b.results) {
    for (const [suffix, w, what] of [["", COLUMN_WIDTH.single, "8.8 cm"], ["_wide", COLUMN_WIDTH.double, "18 cm"]] as const) {
      add(`figures/s11${suffix}.svg`, `|S11| vs frequency, ${what} wide`, s11Figure(b, { widthMm: w }));
      add(`figures/zin${suffix}.svg`, `Input impedance vs frequency, ${what} wide`, zinFigure(b, { widthMm: w }));
      add(`figures/smith${suffix}.svg`, `Smith chart of S11, ${what} wide`, smithFigure(b, { widthMm: w }));
      b.results.farfield.forEach((ff, i, ffs) => add(`figures/pattern_${ffTag(ffs, i)}${suffix}.svg`, `Pattern cuts φ = 0°/90° at ${patternTag(ff.f).replace("GHz", " GHz")}${ff.port != null ? `, port ${ff.port} driven` : ""}, ${what} wide`, patternFigure(b, i, { widthMm: w })));
      add(`figures/sparams_reflection${suffix}.svg`, `|S_ii| of every port, ${what} wide`, sparamFigure(b, "reflection", { widthMm: w }));
      add(`figures/sparams_transmission${suffix}.svg`, `Port coupling |S_ij|, ${what} wide`, sparamFigure(b, "transmission", { widthMm: w }));
      if (extras.arrayWeights?.size) {
        for (const { ff, beam } of steeredPatterns(b, extras.arrayWeights)) {
          add(
            `figures/array_pattern_${patternTag(ff.f)}${suffix}.svg`,
            `Array pattern at the current weights (${weightsText(extras.arrayWeights)}), beam θ=${beam.theta}° φ=${beam.phi}°, ${what} wide`,
            patternFigureFor(b, ff, { widthMm: w, title: `Array directivity (dBi), f = ${Number((ff.f / 1e9).toFixed(3))} GHz` }),
          );
        }
      }
    }
  }
  if (extras.reference && b.results) {
    const ref = extras.reference;
    const m = comparisonMetrics(b, ref);
    add("comparison/metrics.csv", `openEMS vs ${ref.reference.label}: resonance, |S11|, bandwidth, Dmax, pattern RMS`, toCsv(["quantity", "openEMS", "reference", "difference", "unit"], metricsRows(m)));
    add("comparison/notes.txt", "How the comparison was made (grids, interpolation, renormalisation, assumptions)", [
      `Reference: ${ref.reference.label} (${ref.reference.source})`,
      ...(m.s11 ? [`S-parameters: ${m.s11.grid}`] : []),
      ...(m.pattern ? [`Pattern: ${m.pattern.grid}`] : []),
      ...ref.reference.notes,
      ...m.notes,
    ].join("\n") + "\n");
    for (const fig of comparisonFigures(b, ref)) add(`comparison/${fig.name}`, `openEMS vs reference overlay (${fig.name.replace(/\.svg$/, "")}), B&W`, fig.svg);
    for (const r of ref.reference.raw) add(`comparison/reference/${r.name.replace(/[\\/]/g, "_")}`, "The imported reference file, unchanged", r.text);
  }
  if (include.cst) {
    // the macro writes independent discrete ports only and refuses grouped ports (src/export/cst.ts): a design with a
    // grouped port gets the geometry macro without ports (and without the lumped elements that option also leaves out)
    const geometryOnly = cstGeometryOnly(b);
    const macro = cstMacro(b, geometryOnly ? { ...DEFAULT_CST_OPTIONS, includePorts: false } : DEFAULT_CST_OPTIONS, { macroBase: safeId(b.model.id) });
    add(
      `cst/${safeId(b.model.id)}.bas`,
      geometryOnly ? `CST-compatible VBA macro, geometry only: ${CST_GROUPED_NOTE}` : "CST-compatible VBA macro (default options)",
      geometryOnly ? macro.text.replace(/\r\nOption Explicit\r\n/, `\r\n' ${CST_GROUPED_NOTE}\r\n'\r\nOption Explicit\r\n`) : macro.text,
    );
    for (const f of macro.files) add(`cst/${f.name}`, "Polyhedron for the CST macro (ASCII STL, imported by the macro; keep it next to the .bas)", f.data);
  }
  if (include.fab) for (const f of fabFiles(b, {}, now).files) add(`fab/${f.path}`, f.description, f.data);
  if (include.image) add("images/view_iso.png", "3D view as shown in the viewer", extras.isoPng);
  if (include.readme) {
    const index = [{ path: "README.md", description: "This report" }, ...files.map(({ path, description }) => ({ path, description }))];
    files.unshift({ path: "README.md", description: "This report", data: readmeReport(b, { exported: localTime(now), files: index }) });
  }
  return files;
}

export function zipPackage(files: PackageFile[], root: string, now: Date = new Date()): Uint8Array {
  const entries: Record<string, [Uint8Array, { mtime: Date; level: 0 | 6 }]> = {};
  for (const f of files) {
    const data = typeof f.data === "string" ? strToU8(f.data) : f.data;
    const binary = /\.(png|pdf)$/.test(f.path);
    entries[`${root}/${f.path}`] = [data, { mtime: now, level: binary ? 0 : 6 }];
  }
  return zipSync(entries);
}
