// Series and tables for comparing the current project with pinned ones. Projects may use
// different frequency grids: every trace is interpolated onto the union of all grids (NaN outside
// a project's own range), so the chart's crosshair lists every project's value at the hovered x.
import type { Series } from "../charts/LineChart";
import { plotQuantities, type PlotFormat, type PlotQuantity } from "../charts/plotQuantities.ts";
import type { PolarSeries } from "../charts/PolarChart";
import { nearestIndex, patternCut, sweep, type Sweep } from "../lib/rf.ts";
import { magDb, pairLabel, phaseDeg, sMatrix } from "../lib/sparams.ts";
import type { Bundle, FarField } from "../types";
import { fmt } from "../i18n/index.ts";

/** The categorical slots in their fixed order (docs/DESIGN.md, Charts): one per compared run or
 * project. Eight validate on the adjacent pairlist that line charts use; past eight, nothing. */
export const SERIES_COLORS = ["--al-series-1", "--al-series-2", "--al-series-3", "--al-series-4", "--al-series-5", "--al-series-6", "--al-series-7", "--al-series-8"] as const;

export interface Trace {
  label: string;
  bundle: Bundle;
  sweep: Sweep;
}

const clip = (s: string, n = 30) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Short labels that tell the projects apart: the parameters that differ when the model is the
 * same, otherwise the project names. The differing parameter values are the trace's identity, so
 * only the model id in front of them is shortened, never the values themselves (the chart legend,
 * tooltip and the table's column groups all use these labels). */
export function traceLabels(bundles: Bundle[], names?: (string | undefined)[]): string[] {
  const models = new Set(bundles.map((b) => b.model.id));
  const labels = bundles.map((b, i) => {
    // imported reference data (src/import/reference.ts) carries its own label, e.g. "Reference: patch.s1p"
    const ref = (b as { reference?: { label: string } }).reference;
    if (ref) return clip(ref.label, 40);
    const group = bundles.filter((o) => o.model.id === b.model.id);
    const differing = group.length > 1 ? b.model.params.filter((p) =>
      new Set(group.map((o) => String(o.model.params.find((q) => q.key === p.key)?.value))).size > 1) : [];
    const params = differing.map((p) => `${p.key}=${p.value}${p.unit ? ` ${p.unit}` : ""}`).join(", ");
    const distinctByParams = !group.some((o) => o !== b && differing.every((p) =>
      String(o.model.params.find((q) => q.key === p.key)?.value) === String(b.model.params.find((q) => q.key === p.key)?.value)));
    // a caller-given name (a designer run's label: name · time · engine) tells identical-parameter
    // runs apart where the bundle name cannot (re-runs, CPU vs GPU)
    const runName = clip(names?.[i] || b.name || b.model.name, names?.[i] ? 60 : 30);
    const fallback = runName;
    if (models.size > 1 && names?.[i]) return names[i]!;
    if (models.size === 1) return params ? `${params}${distinctByParams ? "" : ` · ${runName}`}` : fallback;
    const identity = clip(b.model.id, params ? Math.max(12, 30 - params.length - 1) : 30);
    return `${identity}${params ? ` ${params}` : ""}${distinctByParams ? "" : ` · ${fallback}`}`;
  });
  return labels.map((n, i) => (labels.indexOf(n) !== i ? `${n} (${i + 1})` : n));
}

export function traces(current: Bundle | null, others: Bundle[], names?: (string | undefined)[]): Trace[] {
  const given = [current, ...others];
  const all = given.filter((b): b is Bundle => !!b?.results).slice(0, SERIES_COLORS.length);
  const sweeps = all.map((b) => sweep(b));
  const ok = all.filter((_, i) => sweeps[i]);
  const labels = traceLabels(ok, names && ok.map((b) => names[given.indexOf(b)]));
  return ok.map((b, i) => ({ label: labels[i], bundle: b, sweep: sweeps[all.indexOf(b)]! }));
}

/** Sorted union of several ascending grids (values closer than 1e-9 relative are merged). */
export function unionGrid(grids: number[][]): number[] {
  const all = grids.flat().sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of all) {
    const last = out[out.length - 1];
    if (out.length === 0 || Math.abs(v - last) > 1e-9 * Math.max(1, Math.abs(v))) out.push(v);
  }
  return out;
}

/** Linear interpolation of (x, y) at xq; NaN outside [x0, xn]. x must be ascending. */
export function interp(x: number[], y: number[], xq: number[]): number[] {
  const n = x.length;
  return xq.map((q) => {
    if (!n || q < x[0] - 1e-12 || q > x[n - 1] + 1e-12) return NaN;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (x[mid] <= q) lo = mid;
      else hi = mid;
    }
    if (hi === lo || x[hi] === x[lo]) return y[lo];
    const t = (q - x[lo]) / (x[hi] - x[lo]);
    return y[lo] + t * (y[hi] - y[lo]);
  });
}

export interface CompareLines {
  /** union frequency grid in GHz */
  x: number[];
  series: Series[];
}

/** One series per project for a quantity picked from its sweep, on the union grid (GHz). */
export function compareLines(ts: Trace[], pick: (s: Sweep) => number[]): CompareLines {
  const grids = ts.map((t) => t.sweep.f.map((f) => f / 1e9));
  const x = unionGrid(grids);
  const series = ts.map((t, i) => ({
    id: `cmp-${i}`,
    label: t.label,
    color: SERIES_COLORS[i],
    x,
    y: interp(grids[i], pick(t.sweep), x),
  }));
  return { x, series };
}

/** Line dashes telling the picked S_ij of one run apart (the colour is the run's): solid,
 * dashed, dotted. At most three pairs are picked (src/components/SParamView.tsx). */
export const PAIR_DASHES = [undefined, "6 4", "2 3"] as const;

const wrapDeg = (v: number) => ((((v + 180) % 360) + 360) % 360) - 180;
/** Phase in degrees made continuous, so interpolating across the ±180° wrap stays on the curve. */
function unwrapDeg(p: number[]): number[] {
  const out: number[] = [];
  let offset = 0;
  p.forEach((v, i) => {
    if (i > 0 && Number.isFinite(v) && Number.isFinite(p[i - 1])) {
      const d = v - p[i - 1];
      if (d > 180) offset -= 360;
      else if (d < -180) offset += 360;
    }
    out.push(v + offset);
  });
  return out;
}

/** The label of a picked S_ij in a comparison: |S21| (magnitude) or ∠S21 (phase). */
export const pairQuantity = (p: [number, number], mode: "db" | "phase") => (mode === "db" ? `|${pairLabel(p)}|` : `∠${pairLabel(p)}`);

/** One series per run and picked S_ij (dB magnitude or phase in degrees) on the union grid (GHz):
 * the run's colour, the pair's dash, labelled "|S21| · <run>". A pair a run does not store is
 * left out for that run (e.g. a two-port run beside a four-port one). */
export function compareSParams(ts: Trace[], pairs: [number, number][], mode: "db" | "phase"): CompareLines {
  const mats = ts.map((t) => sMatrix(t.bundle));
  const grids = mats.map((m) => (m ? m.f.map((f) => f / 1e9) : []));
  const x = unionGrid(grids.filter((g) => g.length));
  const series: Series[] = [];
  ts.forEach((t, i) => {
    const m = mats[i];
    if (!m) return;
    pairs.forEach((p, k) => {
      const c = m.get(p[0], p[1]);
      if (!c) return;
      const y = mode === "db" ? interp(grids[i], magDb(c), x) : interp(grids[i], unwrapDeg(phaseDeg(c)), x).map((v) => (Number.isFinite(v) ? wrapDeg(v) : NaN));
      series.push({ id: `cmp-${i}-${p[0]},${p[1]}`, label: `${pairQuantity(p, mode)} · ${t.label}`, color: SERIES_COLORS[i], dash: PAIR_DASHES[k], x, y });
    });
  });
  return { x, series };
}

/** Complex S-parameter quantities for each run on the shared comparison frequency grid. */
export function compareSParamQuantities(ts: Trace[], pairs: [number, number][], format: PlotFormat, mode: "db" | "phase" = "db"): PlotQuantity[] {
  const mats = ts.map((t) => sMatrix(t.bundle));
  const grids = mats.map((m) => (m ? m.f.map((f) => f / 1e9) : []));
  const x = unionGrid(grids.filter((g) => g.length));
  const inputs = ts.flatMap((t, i) => {
    const m = mats[i];
    if (!m) return [];
    return pairs.flatMap((p, k) => {
      const c = m.get(p[0], p[1]);
      if (!c) return [];
      return [{ id: `cmp-${i}-${p[0]},${p[1]}`, label: pairLabel(p), suffix: t.label, color: SERIES_COLORS[i], dash: PAIR_DASHES[k] ?? "", x,
        re: interp(grids[i], c.re, x), im: interp(grids[i], c.im, x) }];
    });
  });
  return plotQuantities(inputs, format, mode);
}

/** The far field of a project closest to a frequency (Hz). */
export function nearestFarfield(b: Bundle, fHz: number): FarField | undefined {
  const list = b.results?.farfield ?? [];
  if (!list.length) return undefined;
  return list[nearestIndex(list.map((f) => f.f), fHz)];
}

/** One pattern cut per project at the far-field frequency nearest to `fHz`; `grid` picks the plotted
 * quantity of each far field (gain, realized gain: lib/farfieldQuantity.ts), directivity by default. */
export function compareCuts(ts: Trace[], fHz: number, phi: 0 | 90, current?: FarField, grid?: (b: Bundle, ff: FarField) => number[][]): PolarSeries[] {
  const out: PolarSeries[] = [];
  ts.forEach((t, i) => {
    // the open project (trace 0) shows the pattern selected in the dock, e.g. port 3's of an array
    const ff = i === 0 && current ? current : nearestFarfield(t.bundle, fHz);
    if (!ff) return;
    const c = patternCut(ff.theta, ff.phi, grid ? grid(t.bundle, ff) : ff.directivity_dbi, phi, !!t.bundle.half_space);
    const shifted = Math.abs(ff.f - fHz) / fHz > 0.005;
    out.push({
      id: `cmp-${i}`,
      label: shifted ? `${t.label} · ${fmt.fixed(ff.f / 1e9, 2)} GHz` : t.label,
      color: SERIES_COLORS[i],
      angle: c.angle,
      value: c.value,
    });
  });
  return out;
}

export interface GroupedTable {
  columns: string[];
  rows: (string | number)[][];
  /** header row above `columns`: one group per project (span = number of columns) */
  groups?: { label: string; span: number }[];
}

const every = (n: number, maxRows = 201) => {
  const step = Math.max(1, Math.ceil(n / maxRows));
  return Array.from({ length: n }, (_, i) => i).filter((i) => i % step === 0 || i === n - 1);
};

/** Table view for a comparison: the x column, then a column group per project. */
export function compareTable(
  xLabel: string,
  x: number[],
  ts: { label: string }[],
  cols: { label: string; values: (i: number) => number[] }[],
): GroupedTable {
  const selected = every(x.length);
  // A column may interpolate an entire pattern cut. Resolve it once per table,
  // rather than repeating the same interpolation for every displayed row.
  const values = selected.length ? ts.map((_, i) => cols.map((c) => c.values(i))) : [];
  const rows = selected.map((r) => {
    const row: (string | number)[] = [x[r]];
    values.forEach((columns) => columns.forEach((column) => {
      const v = column[r];
      row.push(Number.isFinite(v) ? v : "—");
    }));
    return row;
  });
  return {
    columns: [xLabel, ...ts.flatMap(() => cols.map((c) => c.label))],
    groups: [{ label: "", span: 1 }, ...ts.map((t) => ({ label: t.label, span: cols.length }))],
    rows,
  };
}
