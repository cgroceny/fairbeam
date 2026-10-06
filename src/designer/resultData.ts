import { powerWaveReflection } from "../lib/powerWaves.ts";
import type { Bundle } from "../types";
import { complexDb, complexMagnitude, complexPhase } from "../charts/plotQuantities.ts";
import { sweep, nearestIndex } from "../lib/rf.ts";
import { magDb, pairLabel, phaseDeg, sMatrix, zFromGamma } from "../lib/sparams.ts";
import type { ResultView } from "./resultFocus.ts";
import { traceLabels } from "../compare/series.ts";
import { effectiveQuantity, efficiencyData, mismatchAt, quantityGrid, type PatternQuantity } from "../lib/farfieldQuantity.ts";
import { phasorColumns } from "../scene/fieldPlaneModel.ts";
import { t, tEn } from "../i18n/index.ts";
import { summaryTable } from "./runSummary.ts";

export interface ResultDataTable {
  header: string[];
  rows: (string | number | null)[][];
}

export type ResultDataFormat = "db" | "db_phase" | "re_im" | "mag_phase" | "all";

/** What the active plot shows, so copied/exported data matches it (both Results docks pass it). */
export interface ResultDataOptions {
  /** the S_ij picked in the S-parameter picker; every stored pair only when omitted */
  pairs?: [number, number][];
  /** S-parameter quantity: dB magnitude (default) or phase in degrees */
  sparamMode?: "db" | "phase";
  /** Numeric representation of complex S/Z samples. */
  format?: ResultDataFormat;
  /** the Smith chart's port: its S_pp and input impedance (default: the sweep's S11 and Zin) */
  smithPort?: number;
  /** comparison: the names the legend uses for the runs (parallel to `runs`) */
  runNames?: (string | undefined)[];
  /** the far-field quantity shown (the pattern data add its column beside the directivity) */
  patternQuantity?: PatternQuantity;
  /** the summary of several runs: add the Δ columns (the Summary tab's "Δ vs A" view is on) */
  summaryDeltas?: boolean;
  /** the run (its file) the Δ columns are taken from; the oldest run when omitted or not compared */
  summaryReference?: string | null;
  /** the field-plane map of the fieldplane view (index into field_planes); every map when omitted */
  fieldPlane?: number;
}

const empty = (header: string[]): ResultDataTable => ({ header, rows: [] });
// no NaN or ±Infinity in copied/CSV data (an exactly zero |Sij| is -Infinity dB): an empty cell
const finiteCell = (n: number | undefined): number | null => typeof n === "number" && Number.isFinite(n) ? n : null;
const phase = complexPhase;
function sColumns(pair: [number, number], re: number[], im: number[], format: ResultDataFormat) {
  const p = pairLabel(pair);
  const safe = (fn: (k: number) => number) => (k: number) => Number.isFinite(re[k]) && Number.isFinite(im[k]) ? fn(k) : Number.NaN;
  const modes: Record<ResultDataFormat, { label: string; value: (k: number) => number }[]> = {
    db: [{ label: `|${p}| (dB)`, value: safe(k => complexDb(re[k], im[k])) }],
    db_phase: [{ label: `|${p}| (dB)`, value: safe(k => complexDb(re[k], im[k])) }, { label: `∠${p} (deg)`, value: safe(k => phase(re[k], im[k])) }],
    re_im: [{ label: `Re ${p}`, value: k => re[k] }, { label: `Im ${p}`, value: k => im[k] }],
    mag_phase: [{ label: `|${p}|`, value: safe(k => complexMagnitude(re[k], im[k])) }, { label: `∠${p} (deg)`, value: safe(k => phase(re[k], im[k])) }],
    all: [{ label: `|${p}| (dB)`, value: safe(k => complexDb(re[k], im[k])) }, { label: `∠${p} (deg)`, value: safe(k => phase(re[k], im[k])) }, { label: `Re ${p}`, value: k => re[k] }, { label: `Im ${p}`, value: k => im[k] }, { label: `|${p}|`, value: safe(k => complexMagnitude(re[k], im[k])) }],
  };
  return modes[format];
}
function zColumns(re: number[], im: number[], format: ResultDataFormat) {
  const safe = (fn: (k: number) => number) => (k: number) => Number.isFinite(re[k]) && Number.isFinite(im[k]) ? fn(k) : Number.NaN;
  const mag = safe((k: number) => Math.hypot(re[k], im[k]));
  const deg = safe((k: number) => phase(re[k], im[k]));
  const ri = [{ label: "Re Zin (Ω)", value: (k: number) => re[k] }, { label: "Im Zin (Ω)", value: (k: number) => im[k] }];
  const mp = [{ label: "|Zin| (Ω)", value: mag }, { label: "∠Zin (deg)", value: deg }];
  return format === "mag_phase" ? mp : format === "all" ? [...ri, ...mp] : format === "db_phase" ? [...ri, { label: "∠Zin (deg)", value: deg }] : ri;
}

/** Raw, unsampled data for a result view. Numeric cells retain the precision stored in the bundle. */
export function resultDataTable(bundle: Bundle | null | undefined, view: ResultView, frequencyHz?: number, options: ResultDataOptions = {}): ResultDataTable {
  const results = bundle?.results;
  if (!results) return empty(["No result data"]);

  // the run card's headline numbers: one row (the comparison's per-run table has one row per run)
  if (view === "summary") return summaryTable([{ label: options.runNames?.[0] ?? bundle.model.name, file: "", bundle }]);

  if (view === "sparams") {
    const matrix = sMatrix(bundle);
    if (matrix?.pairs.length) {
      // the picked pairs this run stores (a two-port run beside a four-port one lacks some)
      const picked = (options.pairs ?? []).filter(([i, j]) => matrix.get(i, j));
      const format = options.format;
      const cols = (options.pairs === undefined ? matrix.pairs : picked).flatMap((p) => {
        const c = matrix.get(p[0], p[1])!;
        if (format) return sColumns(p, c.re, c.im, format).map(x => ({ label: x.label, values: c.re.map((_, k) => x.value(k)) }));
        return options.sparamMode === "phase" ? [{ label: `∠${pairLabel(p)} (deg)`, values: phaseDeg(c) }] : [{ label: `|${pairLabel(p)}| (dB)`, values: magDb(c) }];
      });
      return { header: ["f (GHz)", ...cols.map((x) => x.label)], rows: matrix.f.map((f, k) => [f / 1e9, ...cols.map((x) => finiteCell(x.values[k]))]) };
    }
    const sw = sweep(bundle);
    if (!sw) return empty(["f (GHz)", "|S11| (dB)"]);
    const haveComplex = sw.s11Re && sw.s11Im;
    const fallbackRe = haveComplex ? sw.s11Re : sw.f.map(() => Number.NaN);
    const fallbackIm = haveComplex ? sw.s11Im : sw.f.map(() => Number.NaN);
    const cols = options.format ? sColumns([1, 1], fallbackRe, fallbackIm, options.format).map(c => c.label === "|S11| (dB)" && !haveComplex ? { ...c, value: (i: number) => sw.s11Db[i] } : c) : [{ label: "|S11| (dB)", value: (i: number) => sw.s11Db[i] }];
    return { header: ["f (GHz)", ...cols.map(c => c.label)], rows: sw.f.map((f, i) => [f / 1e9, ...cols.map(c => finiteCell(c.value(i)))]) };
  }

  if (view === "smith" && options.smithPort !== undefined) {
    // a multi-port run: the picked port's reflection and the impedance it sees
    const m = sMatrix(bundle);
    const p = options.smithPort;
    const g = m?.get(p, p);
    const s = pairLabel([p, p]);
    const header = ["f (GHz)", `Re ${s}`, `Im ${s}`, `Re Zin port ${p} (Ω)`, `Im Zin port ${p} (Ω)`];
    if (m && g && m.ports.length > 1) {
      const z = zFromGamma(g, m.zRef[m.ports.indexOf(p)] ?? 50);
      const extra = options.format ? [...sColumns([p, p], g.re, g.im, options.format), ...zColumns(z.re, z.im, options.format)].filter(c => !header.includes(c.label)) : [];
      return { header: [...header, ...extra.map(c => c.label)], rows: m.f.map((f, i) => [f / 1e9, finiteCell(g.re[i]), finiteCell(g.im[i]), finiteCell(z.re[i]), finiteCell(z.im[i]), ...extra.map(c => finiteCell(c.value(i)))]) };
    }
    // a compared run without that port is not on the chart: no samples (a one-port run's own port
    // falls through to its sweep below)
    if (!g) return empty(header);
  }

  if (view === "impedance" || view === "vswr" || view === "smith" || view === "table") {
    const sw = sweep(bundle);
    if (!sw) return empty(view === "vswr" ? ["f (GHz)", "VSWR"] : ["f (GHz)", "Re Zin (Ω)", "Im Zin (Ω)"]);
    if (view === "vswr") return { header: ["f (GHz)", "VSWR"], rows: sw.f.map((f, i) => [f / 1e9, finiteCell(sw.vswr[i])]) };
    const fmt = options.format;
    if (view === "smith" || view === "table") {
      const base = view === "smith" ? ["Re S11", "Im S11", "Re Zin (Ω)", "Im Zin (Ω)"] : ["|S11| (dB)", "VSWR", "Re Zin (Ω)", "Im Zin (Ω)"];
      const sCols = fmt && sw.s11Re && sw.s11Im ? sColumns([1, 1], sw.s11Re, sw.s11Im, fmt) : [];
      const zCols = fmt ? zColumns(sw.zRe, sw.zIm, fmt) : [];
      const extras = [...sCols, ...zCols].filter(c => !base.includes(c.label));
      return {
        header: ["f (GHz)", ...base, ...extras.map(c => c.label)],
        rows: sw.f.map((f, i) => [
          f / 1e9,
          ...(view === "smith"
            ? [finiteCell(sw.s11Re[i]), finiteCell(sw.s11Im[i]), finiteCell(sw.zRe[i]), finiteCell(sw.zIm[i])]
            : [finiteCell(sw.s11Db[i]), finiteCell(sw.vswr[i]), finiteCell(sw.zRe[i]), finiteCell(sw.zIm[i])]),
          ...extras.map(c => finiteCell(c.value(i))),
        ]),
      };
    }
    const cols = fmt ? zColumns(sw.zRe, sw.zIm, fmt) : [{ label: "Re Zin (Ω)", value: (i: number) => sw.zRe[i] }, { label: "Im Zin (Ω)", value: (i: number) => sw.zIm[i] }];
    const reference = (bundle.ports.find((p) => p.excite) ?? bundle.ports[0])?.reference_impedance;
    if (reference) {
      const power = (i: number) => powerWaveReflection(sw.zRe[i], sw.zIm[i], reference.real, reference.imag);
      cols.push({ label: "Re power-wave Zref (Ω)", value: () => reference.real }, { label: "Im power-wave Zref (Ω)", value: () => reference.imag },
        { label: "Re Γpower (Kurokawa)", value: (i) => power(i)?.re ?? NaN }, { label: "Im Γpower (Kurokawa)", value: (i) => power(i)?.im ?? NaN },
        { label: "Power transfer factor", value: (i) => power(i)?.transfer ?? NaN });
    }
    return { header: ["f (GHz)", ...cols.map(c => c.label)], rows: sw.f.map((f, i) => [f / 1e9, ...cols.map(c => finiteCell(c.value(i)))]) };
  }

  if (view === "pattern") {
    const ffs = results.farfield ?? [];
    if (!ffs.length) return empty(["theta (deg)", "phi (deg)", "Directivity (dBi)"]);
    const idx = frequencyHz === undefined ? 0 : nearestIndex(ffs.map((x) => x.f), frequencyHz);
    const ff = ffs[idx];
    if (!ff?.theta?.length || !ff.phi?.length) return empty(["theta (deg)", "phi (deg)", "Directivity (dBi)"]);
    const withPort = ffs.some((x) => x.port != null);
    // the shown quantity (gain, realized gain, a circular part) beside the directivity
    const q = options.patternQuantity ? effectiveQuantity(bundle, ff, options.patternQuantity) : "directivity";
    const extra = q === "directivity" ? null : quantityGrid(bundle, ff, q);
    const rows: (string | number | null)[][] = [];
    ff.theta.forEach((theta, i) => ff.phi.forEach((phi, j) => {
      const value = ff.directivity_dbi?.[i]?.[j];
      rows.push([...(withPort ? [ff.port ?? null] : []), ff.f / 1e9, theta, phi, finiteCell(value), ...(extra ? [finiteCell(extra[i]?.[j])] : [])]);
    }));
    return { header: [...(withPort ? ["Port"] : []), "f (GHz)", "theta (deg)", "phi (deg)", "Directivity (dBi)", ...(extra ? [`${tEn(`farfield.quantity.${q}`)} (dBi)`] : [])], rows };
  }
  if (view === "efficiency") {
    // every frequency of the band, the far-field frequencies and the band-wide efficiency (sorted):
    // the mismatch efficiency at each (|S11|² interpolated off the S11 grid), the radiation and total
    // efficiency where they are known, per driven port; percent
    const data = efficiencyData(bundle);
    if (!data.length) return empty(["f (GHz)", "Mismatch efficiency (%)"]);
    const multi = data.length > 1;
    const fs = [...new Set(data.flatMap((d) => [...(d.mismatch?.f ?? []), ...(d.band?.f ?? []), ...d.points.map((p) => p.f)]))].sort((a, b) => a - b);
    const pct = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v * 100 : null);
    const cols = data.flatMap((d) => {
      const tag = multi && d.port != null ? ` P${d.port}` : "";
      const misAt = new Map(d.mismatch?.f.map((f, i) => [f, d.mismatch!.eta[i]]) ?? []);
      const band = new Map(d.band?.f.map((f, i) => [f, { rad: d.band!.rad[i], total: d.band!.total[i] }]) ?? []);
      const pts = new Map(d.points.map((p) => [p.f, p]));
      return [
        { label: `Mismatch efficiency${tag} (%)`, value: (f: number) => pct(misAt.has(f) ? misAt.get(f) : mismatchAt(bundle, f, d.port)) },
        { label: `Radiation efficiency${tag} (%)`, value: (f: number) => pct(pts.get(f)?.rad ?? band.get(f)?.rad) },
        { label: `Total efficiency${tag} (%)`, value: (f: number) => pct(pts.get(f)?.total ?? band.get(f)?.total) },
      ];
    });
    return { header: ["f (GHz)", ...cols.map((c) => c.label)], rows: fs.map((f) => [f / 1e9, ...cols.map((c) => finiteCell(c.value(f) ?? undefined))]) };
  }
  if (view === "log") return { header: ["Line"], rows: (bundle?.run?.log_tail ?? []).map((line) => [line]) };
  if (view === "currents") return {
    header: ["Plane", "f (GHz)", "u index", "v index", "Current (normalized)"],
    rows: (bundle?.fields?.planes ?? []).flatMap((plane) => plane.frequencies
      .filter((frequency) => frequencyHz === undefined || frequency.f_target === frequencyHz)
      .flatMap((frequency) => frequency.values.map((value, index) =>
        [plane.name, frequency.f / 1e9, index % plane.nu, Math.floor(index / plane.nu), finiteCell(value)]))),
  };
  if (view === "fieldplane" || view === "fieldmap") {
    const maps = (bundle?.field_planes ?? []).map((m, i) => [m, i] as const)
      .filter(([, i]) => options.fieldPlane === undefined || i === options.fieldPlane);
    const ax = "xyz";
    // maps with a phasor add the real and imaginary part and the phase of each stored component
    // (the union over the maps; a map lacks the columns of another)
    const phased = maps.map(([m]) => phasorColumns(m));
    const extra = [...new Set(phased.flatMap((p) => p.header))];
    return {
      header: ["Map", "f (GHz)", "u axis", "u (mm)", "v axis", "v (mm)", "Magnitude", "Unit", ...extra],
      rows: maps.flatMap(([m, i], n) => m.magnitude.flatMap((row, j) => row.map((value, k) => {
        const own = phased[n].at(j * m.nu + k);
        return [
          i + 1, m.f / 1e9, ax[m.u_axis], m.u_range[0] + (k * (m.u_range[1] - m.u_range[0])) / Math.max(1, m.nu - 1),
          ax[m.v_axis], m.v_range[0] + (j * (m.v_range[1] - m.v_range[0])) / Math.max(1, m.nv - 1), finiteCell(value), m.unit,
          ...extra.map((h) => own[phased[n].header.indexOf(h)] ?? null),
        ];
      }))),
    };
  }
  return empty(["No tabular data for this view"]);
}

const cell = (v: string | number | null | undefined) => v == null ? "" : String(v);
const tsv = (table: ResultDataTable) => [table.header, ...table.rows].map((row) => row.map(cell).join("\t")).join("\n");
const csvCell = (v: string | number | null | undefined) => {
  const s = cell(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const resultDataCsv = (table: ResultDataTable) => [table.header, ...table.rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";

/** One shared raw-data table for a comparison selection. */
export function comparedResultDataTable(runs: { file: string; bundle: Bundle }[], view: ResultView, frequencyHz?: number, options: ResultDataOptions = {}): ResultDataTable {
  if (!runs.length) return { header: [], rows: [] };
  const tables = runs.map((r) => resultDataTable(r.bundle, view, frequencyHz, options));
  const params = [...new Map(runs.flatMap((r) => r.bundle.model.params).map((p) => [p.key, p])).values()];
  const differing = params.filter((p) => runs.some((r) => String(r.bundle.model.params.find((q) => q.key === p.key)?.value) !== String(runs[0].bundle.model.params.find((q) => q.key === p.key)?.value)));
  const paramHeaders = differing.map((p) => `${p.key}${p.unit ? ` (${p.unit})` : ""}`);
  // the legend's names: a designer run's label tells identical-parameter runs apart (re-runs, CPU vs GPU)
  const labels = traceLabels(runs.map((r) => r.bundle), options.runNames);
  const identityKeys = runs.map(({ bundle }) => `${bundle.model.id}\0${bundle.model.params.map((p) => `${p.key}=${String(p.value)}`).sort().join("\0")}`);
  const identities = runs.map((r, i) => !options.runNames?.[i] && identityKeys.filter((key) => key === identityKeys[i]).length > 1 ? `${labels[i].replace(/ \(\d+\)$/, "")} · ${r.file}` : (options.runNames?.[i] ?? labels[i]));
  const frequencyView = ["sparams", "impedance", "vswr", "smith", "efficiency", "table"].includes(view);
  const sameGrid = frequencyView && tables.every((t) => t.header[0] === "f (GHz)") && tables.every((t) => t.rows.length === tables[0].rows.length && t.rows.every((row, i) => row[0] === tables[0].rows[i][0]));
  if (sameGrid) {
    const headers = ["f (GHz)", ...tables.flatMap((t, i) => t.header.slice(1).map((h) => `${h} · ${identities[i]}`))];
    return { header: headers, rows: tables[0].rows.map((row, i) => [row[0], ...tables.flatMap((t) => t.rows[i].slice(1))]) };
  }
  const valueHeaders = [...new Set(tables.flatMap((t) => t.header))].filter((h) => h !== "No result data");
  const headers = ["run", "label", ...paramHeaders, ...valueHeaders];
  const rows = tables.flatMap((table, i) => (table.rows.length ? table.rows : [[]]).map((row) => {
    const byHeader = new Map(table.header.map((h, j) => [h, row[j]]));
    const pvals = differing.map((p) => runs[i].bundle.model.params.find((q) => q.key === p.key)?.value ?? "");
    return [runs[i].file, identities[i], ...pvals, ...valueHeaders.map((h) => byHeader.get(h) ?? null)];
  }));
  return { header: headers, rows };
}

/** The table Copy data and CSV write: one run, or every compared run. */
export function activeResultDataTable(bundle: Bundle | null | undefined, view: ResultView, frequencyHz?: number, runs?: { file: string; bundle: Bundle }[], options: ResultDataOptions = {}): ResultDataTable {
  // the summary lists its runs as rows, one run included (its file name is a column)
  if (view === "summary" && runs?.length) return summaryTable(runs.map((r, i) => ({ label: options.runNames?.[i] ?? r.bundle.model.name, file: r.file, bundle: r.bundle })), { deltas: options.summaryDeltas, reference: options.summaryReference });
  return runs && runs.length >= 2 ? comparedResultDataTable(runs, view, frequencyHz, options) : resultDataTable(bundle, view, frequencyHz, options);
}

export async function copyResultData(bundle: Bundle | null | undefined, view: ResultView, frequencyHz?: number, runs?: { file: string; bundle: Bundle }[], options: ResultDataOptions = {}): Promise<{ ok: boolean; message: string }> {
  try {
    if (!globalThis.navigator?.clipboard?.writeText) return { ok: false, message: t("results.data.clipboardUnavailable") };
    await navigator.clipboard.writeText(tsv(activeResultDataTable(bundle, view, frequencyHz, runs, options)));
    return { ok: true, message: t("results.data.copied") };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : t("results.data.copyFailed") };
  }
}

export async function exportResultCsv(bundle: Bundle | null | undefined, view: ResultView, filename = "result.csv", frequencyHz?: number, runs?: { file: string; bundle: Bundle }[], options: ResultDataOptions = {}) {
  const { saveDownload } = await import("../lib/download");
  return saveDownload(filename.toLowerCase().endsWith(".csv") ? filename : `${filename}.csv`,
    resultDataCsv(activeResultDataTable(bundle, view, frequencyHz, runs, options)), "text/csv;charset=utf-8");
}

/** Add a run to the current comparison selection through the existing run-selection flow. */
export async function addResultToComparison(file: string): Promise<boolean> {
  const { selectRun, selectedRuns } = await import("./runResults.ts");
  if (selectedRuns().includes(file)) return true;
  return selectRun(file, true);
}
