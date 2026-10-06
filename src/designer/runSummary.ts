// The headline numbers of a run (the result summary in Design): resonance, |S11| minimum,
// -10 dB bandwidth, far-field Dmax and realized gain at the resonance, total efficiency, and the
// quality verdict. Read from a bundle when one is loaded, else from the project-index entry (which
// only knows the band centres, the cell count and the verdict). Pure (no Solid, no DOM), so
// scripts/check-run-summary.mjs runs it on the bundled examples. The Summary tab (RunSummaryView.tsx),
// the navigation tree's run rows and the Runs table show these; `summaryTable` is the Copy / CSV table
// (English headers, decimal points).
import type { Band, Bundle, ProjectIndexEntry } from "../types";
import { efficiencyData, farfieldSummary } from "../lib/farfieldQuantity.ts";
import { nearestIndex, sweep } from "../lib/rf.ts";
import { indexQuality, runQuality, type RunQuality } from "../lib/runQuality.ts";
import { differingParams, madeLabels } from "./resultTabs.ts";
import { t } from "../i18n/index.ts";

/** The far-field entry nearest the resonance, with the numbers the summary shows. */
export interface FarfieldHeadline {
  /** Hz */
  f: number;
  /** driven port of a multi-port run */
  port: number | null;
  dmaxDbi: number;
  gainDbi: number | null;
  realizedDbi: number | null;
  /** fractions (0.92 = 92 %) */
  radEff: number | null;
  totalEff: number | null;
}

export interface RunMetrics {
  /** Hz: the centre (deepest point) of the deepest -10 dB band, else the |S11| minimum */
  f0: number | null;
  /** nothing is below -10 dB and the |S11| minimum is the first or last frequency of the sweep: the
   * curve only ends there, it is not a resonance ("no resonance in band"); f0 and s11MinDb still
   * hold that point. False for an index entry (it knows no curve). */
  noResonance: boolean;
  s11MinDb: number | null;
  /** Hz: width of that band; null when nothing is below -10 dB (or the band is not in the index) */
  bwHz: number | null;
  /** fraction of the centre frequency */
  fractionalBw: number | null;
  /** the band runs into the edge of the simulated range: its width is a lower bound */
  bwAtEdge: boolean;
  /** every -10 dB band, in the bundle's order (empty for an index entry) */
  bands: Band[];
  /** how many bands there are (an index entry knows the number, not the bands) */
  bandCount: number;
  farfield: FarfieldHeadline | null;
  /** total efficiency (fraction) at the far-field frequency, else from the band-wide efficiency */
  totalEff: number | null;
  quality: RunQuality | null;
  cells: number | null;
  /** where the numbers came from: a loaded bundle, or the index entry (bands, cells, verdict) */
  source: "bundle" | "index";
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The deepest band: the one with the lowest |S11| minimum (the first on a tie). */
export function deepestBand(bands: readonly Band[]): Band | null {
  let best: Band | null = null;
  for (const b of bands) if (finite(b.s11_min_db) && (!best || b.s11_min_db < best.s11_min_db)) best = b;
  return best;
}

/** The headline numbers of a loaded bundle; null for a bundle without results (a geometry preview). */
export function bundleMetrics(b: Bundle): RunMetrics | null {
  const res = b.results;
  if (!res) return null;
  const bands = Array.isArray(res.bands) ? res.bands : [];
  const band = deepestBand(bands);
  let f0: number | null = band ? band.f_center : null;
  let s11MinDb: number | null = band ? band.s11_min_db : null;
  let noResonance = false;
  if (!band) {
    // nothing below -10 dB: the resonance is still the |S11| minimum, unless that minimum is where
    // the sweep ends (a band edge): then there is no resonance in the band
    const s = sweep(b);
    if (s) {
      let at = -1;
      s.s11Db.forEach((db, i) => { if (Number.isFinite(db) && (at < 0 || db < s.s11Db[at])) at = i; });
      if (at >= 0) { f0 = s.f[at]; s11MinDb = s.s11Db[at]; noResonance = s.s11Db.length > 2 && (at === 0 || at === s.s11Db.length - 1); }
    }
  }
  // the far-field entry nearest the resonance (a multi-port run's other ports share the frequency)
  let farfield: FarfieldHeadline | null = null;
  let summary: ReturnType<typeof farfieldSummary> | null = null;
  const ffs = res.farfield ?? [];
  if (ffs.length) {
    const ff = ffs[f0 === null ? 0 : nearestIndex(ffs.map((x) => x.f), f0)];
    summary = farfieldSummary(b, ff);
    farfield = { f: ff.f, port: summary.port, dmaxDbi: ff.dmax_dbi, gainDbi: summary.gainDbi, realizedDbi: summary.realizedDbi, radEff: summary.radEff, totalEff: summary.totalEff };
  }
  let totalEff = farfield?.totalEff ?? null;
  if (totalEff === null && f0 !== null) {
    // no far field there: the band-wide efficiency of the driven port, when the run stored it
    const band = efficiencyData(b).find((e) => e.band)?.band;
    if (band) {
      const i = nearestIndex(band.f, f0);
      if (finite(band.total[i])) totalEff = band.total[i];
    }
  }
  return {
    f0, noResonance, s11MinDb,
    bwHz: band ? band.f_hi - band.f_lo : null,
    fractionalBw: band ? band.fractional_bw : null,
    bwAtEdge: !!band && (band.edge_lo || band.edge_hi),
    bands: [...bands], bandCount: bands.length,
    farfield, totalEff,
    quality: runQuality(b),
    cells: finite(b.mesh?.total_cells) ? b.mesh.total_cells : null,
    source: "bundle",
  };
}

/** What the project index knows of a run: the band centres (GHz), the cell count and the verdict.
 * Null for an entry that was not simulated. */
export function indexMetrics(entry: Pick<ProjectIndexEntry, "bands" | "cells" | "quality" | "simulated"> | undefined): RunMetrics | null {
  if (!entry || entry.simulated === false) return null;
  const centres = (entry.bands ?? []).filter(finite);
  return {
    f0: centres.length ? centres[0] * 1e9 : null, noResonance: false,
    s11MinDb: null, bwHz: null, fractionalBw: null, bwAtEdge: false,
    bands: [], bandCount: centres.length,
    farfield: null, totalEff: null,
    quality: indexQuality(entry),
    cells: finite(entry.cells) ? entry.cells : null,
    source: "index",
  };
}

/** The headline of raw bundle JSON (a run read for its tree children), tolerant of an odd file. */
export function rawMetrics(raw: unknown): RunMetrics | null {
  try { return bundleMetrics(raw as Bundle); } catch { return null; }
}

// ------------------------------------------------------------------ text (display; the UI language)

/** A short line for the navigation tree: "2.415 GHz · −59.3 dB", the bandwidth and Dmax when there is
 * room for them elsewhere. `fmt` is the display number formatter (fmt.fixed). */
export function metricsLine(m: RunMetrics | null, fixed: (v: number, digits: number) => string): string {
  if (!m) return "";
  const parts: string[] = [];
  if (m.noResonance) parts.push(t("summary.noResonance"));
  else if (m.f0 !== null) parts.push(`${fixed(m.f0 / 1e9, 3)} GHz`);
  if (m.s11MinDb !== null) parts.push(`${fixed(m.s11MinDb, 1).replace(/^-/, "−")} dB`);
  if (m.farfield) parts.push(`${fixed(m.farfield.dmaxDbi, 1)} dBi`);
  return parts.join(" · ");
}

// ------------------------------------------------------------------ deltas against a reference run

/** The metrics a comparison shows a difference for: resonance, |S11| minimum, bandwidth, Dmax, realized gain, total efficiency. */
export const DELTA_KEYS = ["f0", "s11", "bw", "dmax", "realized", "eff"] as const;
export type DeltaKey = typeof DELTA_KEYS[number];
/** MHz for the frequencies, dB for the levels, pp (percentage points) for the efficiency */
export type DeltaUnit = "MHz" | "dB" | "pp";
export type DeltaTone = "better" | "worse" | "neutral";
export interface MetricDelta { value: number; unit: DeltaUnit; tone: DeltaTone }

interface DeltaRule {
  unit: DeltaUnit;
  /** the value in `unit` (null when the run does not have it) */
  pick: (m: RunMetrics) => number | null;
  /** which way is better; null: neither (the resonance is a design choice, not a quality) */
  better: "up" | "down" | null;
  /** the smallest difference worth a colour, given the reference value: a smaller one is noise */
  clear: (ref: number) => number;
  /** decimals of the displayed difference */
  digits: (d: number) => number;
}
const coarse = (d: number) => (Math.abs(d) < 10 ? 1 : 0);
const DELTA_RULES: Record<DeltaKey, DeltaRule> = {
  f0: { unit: "MHz", pick: (m) => (finite(m.f0) && !m.noResonance ? m.f0 / 1e6 : null), better: null, clear: () => Infinity, digits: coarse },
  s11: { unit: "dB", pick: (m) => (finite(m.s11MinDb) ? m.s11MinDb : null), better: "down", clear: () => 1, digits: () => 1 },
  bw: { unit: "MHz", pick: (m) => (finite(m.bwHz) ? m.bwHz / 1e6 : null), better: "up", clear: (ref) => 0.05 * Math.abs(ref), digits: coarse },
  dmax: { unit: "dB", pick: (m) => (finite(m.farfield?.dmaxDbi) ? m.farfield!.dmaxDbi : null), better: "up", clear: () => 0.5, digits: () => 2 },
  realized: { unit: "dB", pick: (m) => (finite(m.farfield?.realizedDbi) ? m.farfield!.realizedDbi : null), better: "up", clear: () => 0.5, digits: () => 2 },
  eff: { unit: "pp", pick: (m) => (finite(m.totalEff) ? m.totalEff * 100 : null), better: "up", clear: () => 2, digits: () => 1 },
};

/** Better, worse or neither: only a difference above the noise level of a run that can be trusted is
 * coloured. Ambiguous cases stay neutral: a run that did not converge or looks unphysical, an
 * efficiency above 100 %, and a bandwidth that is only a lower bound (it runs into the edge of the
 * simulated range) where the bound does not settle which run is wider. */
function toneOf(key: DeltaKey, d: number, refValue: number, ref: RunMetrics, m: RunMetrics): DeltaTone {
  const rule = DELTA_RULES[key];
  if (rule.better === null) return "neutral";
  if (ref.quality?.verdict !== "converged" || m.quality?.verdict !== "converged") return "neutral";
  if ((key === "eff" || key === "realized") && ((ref.totalEff ?? 0) > 1 || (m.totalEff ?? 0) > 1)) return "neutral";
  if (key === "bw" && ((d > 0 && ref.bwAtEdge) || (d < 0 && m.bwAtEdge))) return "neutral";
  if (Math.abs(d) < rule.clear(refValue)) return "neutral";
  return (d > 0) === (rule.better === "up") ? "better" : "worse";
}

/** The difference of each headline number of run `m` from the reference run `ref` (m - ref, in the
 * metric's delta unit). A metric either run lacks has no delta (null). */
export function metricDeltas(ref: RunMetrics | null, m: RunMetrics | null): Record<DeltaKey, MetricDelta | null> {
  const out = {} as Record<DeltaKey, MetricDelta | null>;
  for (const key of DELTA_KEYS) {
    out[key] = null;
    if (!ref || !m) continue;
    const rule = DELTA_RULES[key];
    const a = rule.pick(ref), b = rule.pick(m);
    if (a === null || b === null) continue;
    const value = b - a;
    out[key] = { value, unit: rule.unit, tone: toneOf(key, value, a, ref, m) };
  }
  return out;
}

/** A difference as text with its sign and no unit: "+12", "−0.4"; a difference that rounds to zero has
 * no sign. `fixed` is the display number formatter (fmt.fixed), so it follows the decimal setting. */
export function deltaText(key: DeltaKey, value: number, fixed: (v: number, digits: number) => string): string {
  const digits = DELTA_RULES[key].digits(value);
  const a = Math.abs(value);
  const zero = Number(a.toFixed(digits)) === 0;
  return `${zero ? "" : value < 0 ? "−" : "+"}${fixed(a, digits)}`;
}

/** A difference with its unit: "+12 MHz", "−0.4 dB", "+2.3 pp" (`pp` is the UI language's word). */
export function deltaLabel(key: DeltaKey, d: MetricDelta, fixed: (v: number, digits: number) => string, pp = "pp"): string {
  return `${deltaText(key, d.value, fixed)} ${d.unit === "pp" ? pp : d.unit}`;
}

// ------------------------------------------------------------------ the reference run of the differences

/** The index of the oldest run (by its `created` time; the first of equals), 0 when none has a time.
 * That is the run labelled A when it is among them: A is the oldest run of the design. */
export function oldestRunIndex(runs: readonly { bundle: { created?: string } }[]): number {
  let best = 0, at = Number.POSITIVE_INFINITY;
  runs.forEach((r, i) => {
    const time = Date.parse(r.bundle.created ?? "");
    if (Number.isFinite(time) && time < at) { at = time; best = i; }
  });
  return best;
}

/** The index of the reference run the differences are taken from: the chosen file when it is among the
 * runs, else the oldest run (not the first row: that is the newest run in focus). */
export function referenceIndex(runs: readonly { file: string; bundle: { created?: string } }[], chosen?: string | null): number {
  const i = chosen ? runs.findIndex((r) => r.file === chosen) : -1;
  return i >= 0 ? i : oldestRunIndex(runs);
}

// ------------------------------------------------------------------ Copy / CSV table

export interface SummaryRun { label: string; file: string; bundle: Bundle }

export interface SummaryTable { header: string[]; rows: (string | number | null)[][] }

const round = (v: number | null | undefined, digits: number): number | null => (finite(v) ? Number(v.toFixed(digits)) : null);
const bandList = (bands: readonly Band[]) => bands.map((b) => `${(b.f_lo / 1e9).toFixed(3)}-${(b.f_hi / 1e9).toFixed(3)}`).join("; ");

/** The Δ columns of the delta view: the difference from the reference run, in the units of their headers. */
const DELTA_COLUMNS: { key: DeltaKey; header: string; digits: number }[] = [
  { key: "f0", header: "Δ f res (MHz)", digits: 3 },
  { key: "s11", header: "Δ |S11| min (dB)", digits: 3 },
  { key: "bw", header: "Δ Bandwidth -10 dB (MHz)", digits: 3 },
  { key: "dmax", header: "Δ Dmax (dB)", digits: 3 },
  { key: "realized", header: "Δ Realized gain (dB)", digits: 3 },
  { key: "eff", header: "Δ Total efficiency (pp)", digits: 2 },
];
/** the Δ column naming the run the differences are taken from */
const DELTA_REFERENCE_HEADER = "Δ reference run";

/** One row per run with the headline numbers, and one column per parameter that differs between the
 * runs. English headers and decimal points whatever the UI language, like the other exports.
 * `deltas` (the Summary tab's "Δ vs A" view, with two runs or more) adds the Δ columns at the end:
 * each run's difference from the reference run (empty for the reference run itself and for a missing
 * value) and the file of that reference run. The reference is `reference` (a run's file) when it is
 * among the runs, else the oldest run. */
export function summaryTable(runs: readonly SummaryRun[], options: { deltas?: boolean; reference?: string | null } = {}): SummaryTable {
  const withDeltas = !!options.deltas && runs.length >= 2;
  const columns = differingParams(runs.map((r) => r.bundle.model));
  const made = madeLabels(runs.map((r) => r.bundle.created));
  const header = [
    "Run", "File", "Made", ...columns.map((c) => `${c.key}${c.unit ? ` (${c.unit})` : ""}`),
    "Verdict", "f res (GHz)", "|S11| min (dB)", "Bandwidth -10 dB (MHz)", "Bandwidth (%)", "Bands -10 dB (GHz)",
    "Far field f (GHz)", "Dmax (dBi)", "Gain (dBi)", "Realized gain (dBi)", "Radiation efficiency (%)", "Total efficiency (%)", "Cells",
    ...(withDeltas ? [...DELTA_COLUMNS.map((c) => c.header), DELTA_REFERENCE_HEADER] : []),
  ];
  const all = runs.map((r) => bundleMetrics(r.bundle));
  const ref = withDeltas ? referenceIndex(runs, options.reference) : -1;
  const rows = runs.map((r, i) => {
    const m = all[i];
    const deltas = withDeltas && i !== ref ? metricDeltas(all[ref], m) : null;
    const ff = m?.farfield ?? null;
    return [
      r.label, r.file, made[i] === "—" ? null : made[i],
      ...columns.map((c) => { const v = r.bundle.model.params.find((p) => p.key === c.key)?.value; return typeof v === "number" || typeof v === "string" ? v : v == null ? null : String(v); }),
      m?.quality?.verdict ?? null,
      round(m?.f0 == null || m.noResonance ? null : m.f0 / 1e9, 6), round(m?.s11MinDb, 3), round(m?.bwHz == null ? null : m.bwHz / 1e6, 3),
      round(m?.fractionalBw == null ? null : m.fractionalBw * 100, 3), m && m.bands.length ? bandList(m.bands) : null,
      round(ff ? ff.f / 1e9 : null, 6), round(ff?.dmaxDbi, 3), round(ff?.gainDbi, 3), round(ff?.realizedDbi, 3),
      round(ff?.radEff == null ? null : ff.radEff * 100, 2), round(m?.totalEff == null ? null : m.totalEff * 100, 2), m?.cells ?? null,
      ...(withDeltas ? [...DELTA_COLUMNS.map((c) => round(deltas?.[c.key]?.value, c.digits)), i === ref ? null : runs[ref].label] : []),
    ];
  });
  return { header, rows };
}
