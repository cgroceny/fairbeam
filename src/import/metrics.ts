// openEMS-vs-reference metrics: resonance shift, |S11| depth, −10 dB bandwidth, Dmax
// at the matching frequency and the pattern RMS difference over the main lobe. Pure (Node + browser).
//
// Grids: S-parameter metrics are evaluated on each data set's own grid (band edges interpolated
// linearly at −10 dB), restricted to the frequency range both cover. Pattern metrics interpolate the
// reference bilinearly onto the openEMS θ/φ grid.

import type { Band, Bundle, FarField } from "../types";
import { sweep } from "../lib/rf.ts";
import { solidAngleWeights } from "../lib/array.ts";
import type { RefBundle } from "./reference.ts";

export interface S11Metrics {
  basis: "band centre" | "|S11| minimum";
  fOpen: number;
  fRef: number;
  shiftMHz: number;
  shiftPct: number;
  minOpenDb: number;
  minRefDb: number;
  dMinDb: number;
  /** −10 dB bandwidth in MHz (null when the matched band touches the overlap edge or is absent) */
  bwOpenMHz: number | null;
  bwRefMHz: number | null;
  dBwMHz: number | null;
  overlap: [number, number];
  grid: string;
}

export interface PatternMetrics {
  fOpen: number;
  fRef: number;
  maxOpenDbi: number;
  maxRefDbi: number;
  dMaxDb: number;
  /** RMS of (reference − openEMS) in dB over the openEMS main lobe (D ≥ Dmax − 3 dB), solid-angle weighted */
  rmsDb: number;
  /** mean offset over the same region, and the RMS after removing it (shape difference) */
  meanDb: number;
  shapeRmsDb: number;
  samples: number;
  grid: string;
}

export interface ComparisonMetrics {
  label: string;
  s11: S11Metrics | null;
  pattern: PatternMetrics | null;
  notes: string[];
}

const db = (re: number, im: number) => 10 * Math.log10(Math.max(1e-30, re * re + im * im));

/** −10 dB crossing between samples i and i+1 (linear in dB). */
const cross = (f: number[], y: number[], i: number) => f[i] + ((-10 - y[i]) * (f[i + 1] - f[i])) / (y[i + 1] - y[i] || 1e-30);

/** Band containing index k, with interpolated edges; null if it reaches the range limits. */
function bandAround(f: number[], y: number[], k: number, lo: number, hi: number): number | null {
  if (!(y[k] < -10)) return null;
  let a = k;
  while (a > 0 && y[a - 1] < -10 && f[a - 1] >= lo) a--;
  let b = k;
  while (b < f.length - 1 && y[b + 1] < -10 && f[b + 1] <= hi) b++;
  if (a === 0 || b === f.length - 1 || f[a - 1] < lo || f[b + 1] > hi) return null;
  return cross(f, y, b) - cross(f, y, a - 1);
}

function resonance(f: number[], y: number[], lo: number, hi: number, bands: Band[], near: number | null) {
  const inside = bands.filter((b) => b.f_center >= lo && b.f_center <= hi);
  if (inside.length) {
    const b = near === null ? inside.reduce((x, c) => (c.s11_min_db < x.s11_min_db ? c : x)) : inside.reduce((x, c) => (Math.abs(c.f_center - near) < Math.abs(x.f_center - near) ? c : x));
    const k = f.findIndex((v) => v === b.f_center);
    return { k: k >= 0 ? k : f.indexOf(f.reduce((p, c) => (Math.abs(c - b.f_center) < Math.abs(p - b.f_center) ? c : p))), basis: "band centre" as const };
  }
  let k = -1;
  for (let i = 0; i < f.length; i++) if (f[i] >= lo && f[i] <= hi && (k < 0 || y[i] < y[k])) k = i;
  return { k, basis: "|S11| minimum" as const };
}

export function s11Metrics(project: Bundle, ref: RefBundle, notes: string[]): S11Metrics | null {
  const a = sweep(project);
  const b = sweep(ref);
  if (!a || !b || !b.f.length) return null;
  const lo = Math.max(a.f[0], b.f[0]);
  const hi = Math.min(a.f[a.f.length - 1], b.f[b.f.length - 1]);
  if (!(hi > lo)) {
    notes.push("The reference and the project do not overlap in frequency.");
    return null;
  }
  const ya = a.s11Re.map((re, i) => db(re, a.s11Im[i]));
  const yb = b.s11Re.map((re, i) => db(re, b.s11Im[i]));
  const ra = resonance(a.f, ya, lo, hi, project.results?.bands ?? [], null);
  if (ra.k < 0) return null;
  const rb = resonance(b.f, yb, lo, hi, ref.results?.bands ?? [], a.f[ra.k]);
  if (rb.k < 0) return null;
  if (ra.basis !== rb.basis) notes.push("One side has no −10 dB band in the common range: the resonance is taken at |S11| minimum there.");
  const fOpen = a.f[ra.k];
  const fRef = b.f[rb.k];
  const bwOpen = bandAround(a.f, ya, ra.k, lo, hi);
  const bwRef = bandAround(b.f, yb, rb.k, lo, hi);
  const step = (f: number[]) => (f.length > 1 ? (f[f.length - 1] - f[0]) / (f.length - 1) : 0);
  return {
    basis: ra.basis === "band centre" && rb.basis === "band centre" ? "band centre" : "|S11| minimum",
    fOpen, fRef,
    shiftMHz: (fRef - fOpen) / 1e6,
    shiftPct: ((fRef - fOpen) / fOpen) * 100,
    minOpenDb: ya[ra.k],
    minRefDb: yb[rb.k],
    dMinDb: yb[rb.k] - ya[ra.k],
    bwOpenMHz: bwOpen === null ? null : bwOpen / 1e6,
    bwRefMHz: bwRef === null ? null : bwRef / 1e6,
    dBwMHz: bwOpen === null || bwRef === null ? null : (bwRef - bwOpen) / 1e6,
    overlap: [lo, hi],
    grid: `each on its own grid (openEMS ${a.f.length} points, Δf ${(step(a.f) / 1e6).toFixed(2)} MHz; reference ${b.f.length} points, Δf ${(step(b.f) / 1e6).toFixed(2)} MHz) over the common ${(lo / 1e9).toFixed(3)}–${(hi / 1e9).toFixed(3)} GHz; −10 dB edges interpolated linearly`,
  };
}

/** Bilinear interpolation of a [theta][phi] grid (phi periodic) at (t, p); NaN where missing. */
export function sampleGrid(ff: FarField, t: number, p: number): number {
  const { theta, phi } = ff;
  const d = ff.directivity_dbi;
  if (t < theta[0] - 1e-9 || t > theta[theta.length - 1] + 1e-9) return NaN;
  let i = 0;
  while (i < theta.length - 2 && theta[i + 1] < t) i++;
  const i2 = Math.min(i + 1, theta.length - 1);
  const u = theta[i2] === theta[i] ? 0 : (t - theta[i]) / (theta[i2] - theta[i]);
  const pp = ((p % 360) + 360) % 360;
  const n = phi.length;
  let j = n - 1;
  for (let k = 0; k < n; k++) if (phi[k] <= pp + 1e-9) j = k;
  const j2 = (j + 1) % n;
  const span = ((phi[j2] - phi[j] + 360) % 360) || 360;
  const v = Math.min(1, (((pp - phi[j]) + 360) % 360) / span);
  const g = (a: number, b: number) => d[a]?.[b];
  const vals = [g(i, j), g(i, j2), g(i2, j), g(i2, j2)];
  if (vals.some((x) => x === undefined || !Number.isFinite(x))) return NaN;
  return (1 - u) * ((1 - v) * vals[0]! + v * vals[1]!) + u * ((1 - v) * vals[2]! + v * vals[3]!);
}

export function patternMetrics(project: Bundle, ref: RefBundle, notes: string[], fHint?: number): PatternMetrics | null {
  const rl = ref.results?.farfield ?? [];
  const pl = project.results?.farfield ?? [];
  if (!rl.length || !pl.length) return null;
  // the reference far field nearest to the requested (or first) openEMS frequency
  const target = fHint ?? pl[0].f;
  const r = rl.reduce((x, c) => (Math.abs(c.f - target) < Math.abs(x.f - target) ? c : x));
  const p = pl.reduce((x, c) => (Math.abs(c.f - r.f) < Math.abs(x.f - r.f) ? c : x));
  if (Math.abs(p.f - r.f) / r.f > 0.01) notes.push(`Far fields compared at different frequencies: openEMS ${(p.f / 1e9).toFixed(3)} GHz, reference ${(r.f / 1e9).toFixed(3)} GHz.`);
  const maxOpen = p.dmax_dbi;
  const half = !!project.half_space;
  const { wt, wp } = solidAngleWeights(p.theta, p.phi, half ? 90 : 180);
  const peak = p.dmax_dbi;
  let w = 0, s1 = 0, s2 = 0, n = 0;
  p.theta.forEach((t, i) => {
    if (half && t > 90.0001) return;
    p.phi.forEach((ph, j) => {
      const v = p.directivity_dbi[i][j];
      if (v < peak - 3) return;
      const rv = sampleGrid(r, t, ph);
      if (!Number.isFinite(rv)) return;
      const d = rv - v;
      const ww = wt[i] * wp[j] || 1e-9; // keep θ = 0 samples (zero cell weight at the pole otherwise)
      w += ww;
      s1 += ww * d;
      s2 += ww * d * d;
      n++;
    });
  });
  if (!n) {
    notes.push("The reference far field does not cover the openEMS main lobe.");
    return null;
  }
  const mean = s1 / w;
  const rms = Math.sqrt(s2 / w);
  return {
    fOpen: p.f, fRef: r.f,
    maxOpenDbi: maxOpen,
    maxRefDbi: r.dmax_dbi,
    dMaxDb: r.dmax_dbi - maxOpen,
    rmsDb: rms,
    meanDb: mean,
    shapeRmsDb: Math.sqrt(Math.max(0, rms * rms - mean * mean)),
    samples: n,
    grid: `openEMS θ/φ grid (${p.theta.length} × ${p.phi.length}); reference (${r.theta.length} × ${r.phi.length}) interpolated bilinearly; main lobe = openEMS D ≥ Dmax − 3 dB${half ? ", θ ≤ 90°" : ""}; solid-angle weighted`,
  };
}

export function comparisonMetrics(project: Bundle, ref: RefBundle, fHint?: number): ComparisonMetrics {
  const notes: string[] = [];
  return { label: ref.reference.label, s11: s11Metrics(project, ref, notes), pattern: patternMetrics(project, ref, notes, fHint), notes };
}

/** Metrics as CSV rows (quantity, openEMS, reference, difference, unit). */
export function metricsRows(m: ComparisonMetrics): (string | number | null)[][] {
  const r = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
  const rows: (string | number | null)[][] = [];
  if (m.s11) {
    rows.push([`Resonance (${m.s11.basis})`, r(m.s11.fOpen / 1e9, 4), r(m.s11.fRef / 1e9, 4), r(m.s11.shiftMHz, 2), "GHz / MHz"]);
    rows.push(["Resonance shift", null, null, r(m.s11.shiftPct, 3), "%"]);
    rows.push(["|S11| minimum", r(m.s11.minOpenDb, 2), r(m.s11.minRefDb, 2), r(m.s11.dMinDb, 2), "dB"]);
    rows.push(["−10 dB bandwidth", r(m.s11.bwOpenMHz, 2), r(m.s11.bwRefMHz, 2), r(m.s11.dBwMHz, 2), "MHz"]);
  }
  if (m.pattern) {
    rows.push([`Dmax at ${(m.pattern.fRef / 1e9).toFixed(3)} GHz`, r(m.pattern.maxOpenDbi, 2), r(m.pattern.maxRefDbi, 2), r(m.pattern.dMaxDb, 2), "dBi / dB"]);
    rows.push(["Pattern RMS difference, main lobe", null, null, r(m.pattern.rmsDb, 2), "dB"]);
    rows.push(["Pattern mean offset / shape RMS", null, null, `${r(m.pattern.meanDb, 2)} / ${r(m.pattern.shapeRmsDb, 2)}`, "dB"]);
  }
  return rows;
}
