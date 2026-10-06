// Black-and-white publication charts (IEEE-style): |S11|, input impedance and polar pattern cuts.
// Monochrome by design, so series differ by line style and open markers, never by colour. Sized in
// millimetres for single-column (8.8 cm) or double-column (18 cm) figures; text is 7-8 pt.

import type { Bundle, FarField } from "../types";
import { magDb, pairLabel, sMatrix } from "../lib/sparams.ts";
import { patternCut, sweep } from "../lib/rf.ts";
import { textWidth } from "./metrics.ts";
import { circle, group, line, n, polygon, polyline, rect, svgDoc, text, type Pt } from "./svg.ts";

export const COLUMN_WIDTH = { single: 88, double: 180 } as const;

const FS_TICK = 2.5; // ≈ 7 pt
const FS_LABEL = 2.8; // ≈ 8 pt
const LW_DATA = 0.35;
const LW_AXIS = 0.25;
const LW_GRID = 0.12;
const GRID = "#b3b3b3";

export type Marker = "circle" | "square" | "triangle" | "diamond";

export interface ChartSeries {
  label: string;
  x: number[];
  y: number[];
  dash?: string;
  marker?: Marker;
}

export interface FigureOptions {
  widthMm?: number;
  heightMm?: number;
}

/** "Nice" tick values covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, target = 6): { ticks: number[]; step: number; lo: number; hi: number } {
  if (!(hi > lo)) {
    const d = Math.abs(lo) || 1;
    lo -= d * 0.5;
    hi += d * 0.5;
  }
  const raw = (hi - lo) / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const step = (m >= 5 ? 10 : m >= 2.5 ? 5 : m >= 2 ? 2.5 : m >= 1 ? 2 : 1) * p;
  const a = Math.floor(lo / step + 1e-9) * step;
  const b = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = a; v <= b + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { ticks, step, lo: a, hi: b };
}

function tickText(v: number, step: number): string {
  let d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  if (Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) > 1e-6) d++;
  return v.toFixed(Math.min(d, 6)).replace(/^-/, "−");
}

function markerSvg(kind: Marker, x: number, y: number, r: number): string {
  const a = { fill: "#fff", stroke: "#000", "stroke-width": LW_AXIS };
  switch (kind) {
    case "circle":
      return circle(x, y, r, a);
    case "square":
      return rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8, a);
    case "triangle":
      return polygon([[x, y - r * 1.15], [x + r, y + r * 0.6], [x - r, y + r * 0.6]], a);
    case "diamond":
      return polygon([[x, y - r * 1.2], [x + r, y], [x, y + r * 1.2], [x - r, y]], a);
  }
}

function legendSize(items: ChartSeries[]): [number, number] {
  const w = 2 + 7 + 1.5 + Math.max(...items.map((s) => textWidth(s.label, FS_TICK))) + 2;
  return [w, FS_TICK * 1.55 * items.length + 1.2];
}

/** Legend box with its top-left corner at (x0, y). */
function legendBox(items: ChartSeries[], x0: number, y: number): string {
  if (!items.length) return "";
  const sample = 7;
  const lh = FS_TICK * 1.55;
  const [w, h] = legendSize(items);
  const out = [rect(x0, y, w, h, { fill: "#fff", stroke: "#000", "stroke-width": LW_GRID * 1.5 })];
  items.forEach((s, i) => {
    const cy = y + 0.6 + lh * (i + 0.5);
    out.push(line(x0 + 2, cy, x0 + 2 + sample, cy, { stroke: "#000", "stroke-width": LW_DATA, "stroke-dasharray": s.dash }));
    if (s.marker) out.push(markerSvg(s.marker, x0 + 2 + sample / 2, cy, 0.65));
    out.push(text(x0 + 2 + sample + 1.5, cy + FS_TICK * 0.35, s.label, { "font-size": FS_TICK }));
  });
  return group(out, { class: "legend" });
}

interface LineChartSpec {
  width: number;
  height: number;
  title: string;
  xLabel: string;
  yLabel: string;
  series: ChartSeries[];
  xDomain?: [number, number];
  yDomain?: [number, number];
  hlines?: { y: number; label?: string; dash?: string }[];
  points?: { x: number; y: number; label: string }[];
  legend?: boolean;
}

/** Monochrome x-y line chart as a standalone SVG. */
export function lineChartSvg(spec: LineChartSpec): string {
  const xs = spec.series.flatMap((s) => s.x);
  const ys = spec.series.flatMap((s) => s.y).filter(Number.isFinite);
  const xd = spec.xDomain ?? [Math.min(...xs), Math.max(...xs)];
  const yt = niceTicks(spec.yDomain?.[0] ?? Math.min(...ys, ...(spec.hlines ?? []).map((h) => h.y)), spec.yDomain?.[1] ?? Math.max(...ys, ...(spec.hlines ?? []).map((h) => h.y)), 6);
  const xt = niceTicks(xd[0], xd[1], spec.width > 120 ? 10 : 6);
  // keep the frequency axis exactly on the data range; ticks inside it
  const xTicks = xt.ticks.filter((v) => v >= xd[0] - 1e-9 && v <= xd[1] + 1e-9);
  const yLabels = yt.ticks.map((v) => tickText(v, yt.step));
  const left = 1.2 + FS_LABEL + 1.8 + Math.max(...yLabels.map((l) => textWidth(l, FS_TICK))) + 1.2;
  const bottom = 1.2 + FS_TICK + 1.6 + FS_LABEL + 1.2;
  const top = FS_TICK * 0.5 + 1.5;
  const right = 3;
  const pw = spec.width - left - right;
  const ph = spec.height - top - bottom;
  const X = (v: number) => left + ((v - xd[0]) / (xd[1] - xd[0] || 1)) * pw;
  const Y = (v: number) => top + (1 - (v - yt.lo) / (yt.hi - yt.lo || 1)) * ph;
  const out: string[] = [];
  // grid
  const grid: string[] = [];
  xTicks.forEach((v) => grid.push(line(X(v), top, X(v), top + ph)));
  yt.ticks.forEach((v) => grid.push(line(left, Y(v), left + pw, Y(v))));
  out.push(group(grid, { stroke: GRID, "stroke-width": LW_GRID }));
  // reference lines
  for (const h of spec.hlines ?? []) {
    if (h.y < yt.lo || h.y > yt.hi) continue;
    out.push(line(left, Y(h.y), left + pw, Y(h.y), { stroke: "#000", "stroke-width": LW_AXIS, "stroke-dasharray": h.dash ?? "1.6 0.9" }));
    if (h.label) out.push(text(left + 1, Y(h.y) - 0.8, h.label, { "font-size": FS_TICK }));
  }
  // data
  const nS = spec.series.length;
  spec.series.forEach((s, k) => {
    const pts: Pt[] = [];
    for (let i = 0; i < s.x.length; i++) if (Number.isFinite(s.y[i])) pts.push([X(s.x[i]), Y(Math.max(yt.lo, Math.min(yt.hi, s.y[i])))]);
    out.push(polyline(pts, { stroke: "#000", "stroke-width": LW_DATA, "stroke-dasharray": s.dash, "stroke-linejoin": "round" }));
    if (s.marker) {
      const every = Math.max(1, Math.ceil(s.x.length / 11));
      const off = Math.floor((every * (k + 0.5)) / nS);
      const ms: string[] = [];
      for (let i = off; i < s.x.length; i += every) if (Number.isFinite(s.y[i])) ms.push(markerSvg(s.marker, X(s.x[i]), Y(s.y[i]), 0.65));
      out.push(group(ms));
    }
  });
  // annotated points (e.g. resonances): label centred under the point, stacked when they collide
  const placed: [number, number, number, number][] = [];
  for (const p of spec.points ?? []) {
    const x = X(p.x);
    const y = Y(Math.max(yt.lo, p.y));
    out.push(circle(x, y, 0.5, { fill: "#000", stroke: "none" }));
    const tw = textWidth(p.label, FS_TICK);
    const tx = Math.min(Math.max(x, left + tw / 2 + 0.5), left + pw - tw / 2 - 0.5);
    let ty = y + 1 + FS_TICK;
    const hit = (t: number) => placed.some((r) => tx - tw / 2 < r[2] + 0.8 && tx + tw / 2 > r[0] - 0.8 && t - FS_TICK < r[3] && t > r[1]);
    while (hit(ty)) ty += FS_TICK * 1.15;
    if (ty > top + ph - 0.6) ty = y - 1.2;
    placed.push([tx - tw / 2, ty - FS_TICK, tx + tw / 2, ty]);
    out.push(text(tx, ty, p.label, { "font-size": FS_TICK, "text-anchor": "middle" }));
  }
  // axes box + ticks
  out.push(rect(left, top, pw, ph, { fill: "none", stroke: "#000", "stroke-width": LW_AXIS }));
  const ticks: string[] = [];
  const labels: string[] = [];
  xTicks.forEach((v) => {
    ticks.push(line(X(v), top + ph, X(v), top + ph - 1), line(X(v), top, X(v), top + 1));
    labels.push(text(X(v), top + ph + 1.2 + FS_TICK * 0.8, tickText(v, xt.step), { "text-anchor": "middle" }));
  });
  yt.ticks.forEach((v, i) => {
    ticks.push(line(left, Y(v), left + 1, Y(v)), line(left + pw, Y(v), left + pw - 1, Y(v)));
    labels.push(text(left - 1.2, Y(v) + FS_TICK * 0.35, yLabels[i], { "text-anchor": "end" }));
  });
  out.push(group(ticks, { stroke: "#000", "stroke-width": LW_AXIS }));
  out.push(group(labels, { "font-size": FS_TICK }));
  out.push(text(left + pw / 2, spec.height - 1.2, spec.xLabel, { "font-size": FS_LABEL, "text-anchor": "middle" }));
  const yx = 1.2 + FS_LABEL * 0.8;
  const yy = top + ph / 2;
  out.push(text(yx, yy, spec.yLabel, { "font-size": FS_LABEL, "text-anchor": "middle", transform: `rotate(-90 ${n(yx)} ${n(yy)})` }));
  if (spec.legend !== false && spec.series.length > 1) {
    // the corner that covers the fewest data samples
    const [lw, lh] = legendSize(spec.series);
    const pts = spec.series.flatMap((se) => se.x.map((x, i) => [X(x), Y(se.y[i])] as Pt));
    const corners: Pt[] = [
      [left + pw - 1.5 - lw, top + 1.5], [left + 1.5, top + 1.5],
      [left + pw - 1.5 - lw, top + ph - 1.5 - lh], [left + 1.5, top + ph - 1.5 - lh],
    ];
    const cost = (c: Pt) => pts.filter(([x, y]) => x >= c[0] - 1 && x <= c[0] + lw + 1 && y >= c[1] - 1 && y <= c[1] + lh + 1).length;
    const best = corners.reduce((a, c) => (cost(c) < cost(a) ? c : a));
    out.push(legendBox(spec.series, best[0], best[1]));
  }
  return svgDoc(spec.width, spec.height, group(out), spec.title);
}

const ghz = (hz: number) => String(Number((hz / 1e9).toFixed(3)));

/** |S11| in dB versus frequency, with the −10 dB reference and the band centres marked. */
export function s11Figure(b: Bundle, opt: FigureOptions = {}): string | null {
  const s = sweep(b);
  if (!s) return null;
  const width = opt.widthMm ?? COLUMN_WIDTH.single;
  const height = opt.heightMm ?? (width > 120 ? 80 : 62);
  const f = s.f.map((x) => x / 1e9);
  const minDb = Math.min(...s.s11Db.filter(Number.isFinite));
  const bands = b.results?.bands ?? [];
  return lineChartSvg({
    width, height,
    title: `${b.name} — |S11|`,
    xLabel: "Frequency (GHz)",
    yLabel: "|S11| (dB)",
    series: [{ label: "|S11|", x: f, y: s.s11Db }],
    xDomain: [f[0], f[f.length - 1]],
    yDomain: [Math.min(-30, Math.floor(minDb / 5) * 5), 0],
    hlines: [{ y: -10, label: "−10 dB" }],
    points: bands.map((bd) => ({ x: bd.f_center / 1e9, y: bd.s11_min_db, label: `${ghz(bd.f_center)} GHz` })),
  });
}

/** Real and imaginary part of the input impedance (one axis, Ω). */
export function zinFigure(b: Bundle, opt: FigureOptions = {}): string | null {
  const s = sweep(b);
  if (!s) return null;
  const width = opt.widthMm ?? COLUMN_WIDTH.single;
  const height = opt.heightMm ?? (width > 120 ? 80 : 62);
  const f = s.f.map((x) => x / 1e9);
  return lineChartSvg({
    width, height,
    title: `${b.name} — input impedance`,
    xLabel: "Frequency (GHz)",
    yLabel: "Input impedance (Ω)",
    series: [
      { label: "Re(Zin)", x: f, y: s.zRe, marker: "circle" },
      { label: "Im(Zin)", x: f, y: s.zIm, dash: "2 1", marker: "square" },
    ],
    xDomain: [f[0], f[f.length - 1]],
    hlines: [{ y: s.zRef, label: `${Number(s.zRef.toFixed(1))} Ω`, dash: "0.5 0.8" }, { y: 0, dash: "none" }],
  });
}

/** Polar directivity cuts φ = 0° (xz) and φ = 90° (yz) at far-field entry `index`. */
export function patternFigure(b: Bundle, index: number, opt: FigureOptions = {}): string | null {
  const ff = b.results?.farfield?.[index];
  return ff ? patternFigureFor(b, ff, opt) : null;
}

/** Polar cuts of any FarField record (stored, or synthesized from element patterns). */
export interface PolarCut {
  label: string;
  angle: number[];
  value: number[];
  dash?: string;
  marker?: Marker;
}

export function patternFigureFor(b: Bundle, ff: FarField, opt: FigureOptions & { title?: string; cuts?: PolarCut[] } = {}): string | null {
  const half = !!b.half_space;
  const width = opt.widthMm ?? COLUMN_WIDTH.single;
  const range = 30;
  const topDb = Math.ceil(Math.max(ff.dmax_dbi, ...(opt.cuts ?? []).flatMap((c) => c.value.filter(Number.isFinite))) / 5) * 5;
  // legend rows (wrapped to the figure width)
  const legendItems = opt.cuts?.map((c) => c.label) ?? ["φ = 0° (xz plane)", "φ = 90° (yz plane)"];
  const legendRows: number[][] = [[]];
  {
    let used = 0;
    legendItems.forEach((l, i) => {
      const w = 7 + 1.5 + textWidth(l, FS_TICK) + 4;
      if (used + w > width - 2 && legendRows[legendRows.length - 1].length) {
        legendRows.push([]);
        used = 0;
      }
      legendRows[legendRows.length - 1].push(i);
      used += w;
    });
  }
  const lo = topDb - range;
  const legendH = FS_TICK * 1.6 * legendRows.length + 2;
  const titleH = FS_LABEL + 2;
  const labelPad = FS_TICK * 2.4;
  const maxR = Math.min((width - 2 * labelPad - 4) / 2, (opt.heightMm ? opt.heightMm - titleH - legendH - labelPad * 2 : 70) / (half ? 1 : 2));
  const R = Math.max(10, maxR);
  const height = opt.heightMm ?? titleH + labelPad + R * (half ? 1 : 2) + (half ? FS_TICK * 2.5 : labelPad) + legendH + 1;
  const cx = width / 2;
  const cy = titleH + labelPad + R;
  const rOf = (d: number) => (Math.max(lo, Math.min(topDb, d)) - lo) / range * R;
  const P = (angDeg: number, r: number): Pt => [cx + r * Math.sin((angDeg * Math.PI) / 180), cy - r * Math.cos((angDeg * Math.PI) / 180)];
  const out: string[] = [];
  const grid: string[] = [];
  const a0 = half ? -90 : -180;
  const a1 = half ? 90 : 180;
  // rings every 10 dB
  for (let k = 0; k <= range / 10; k++) {
    const r = (k / (range / 10)) * R;
    if (r < 1e-6) continue;
    const pts: Pt[] = [];
    for (let a = a0; a <= a1 + 1e-9; a += 2) pts.push(P(a, r));
    grid.push(polyline(pts, k === range / 10 ? { stroke: "#000", "stroke-width": LW_AXIS } : {}));
  }
  // spokes every 30°
  const labels: string[] = [];
  for (let a = a0; a <= a1 + 1e-9; a += 30) {
    if (!half && a === 180) continue;
    const [x, y] = P(a, R);
    grid.push(line(cx, cy, x, y));
    const [lx, ly] = P(a, R + FS_TICK * 1.3);
    const lab = !half && Math.abs(a) === 180 ? "±180°" : `${String(a).replace(/^-/, "−")}°`;
    // in half space the ±90° labels sit above the horizon, clear of the ring labels below it
    const up = half && Math.abs(a) === 90 ? -FS_TICK * 0.9 : 0;
    labels.push(text(lx, ly + FS_TICK * 0.35 + up, lab, { "text-anchor": "middle" }));
  }
  if (half) grid.push(line(cx - R, cy, cx + R, cy, { stroke: "#000", "stroke-width": LW_AXIS }));
  out.push(group(grid, { stroke: GRID, "stroke-width": LW_GRID, fill: "none" }));
  // ring labels along the horizon (half space) or along the spoke where the pattern is weakest
  const cutData = [0, 90].map((phi) => patternCut(ff.theta, ff.phi, ff.directivity_dbi, phi, half));
  const labelAngle = [165, 135, 105, -105, -135, -165].reduce(
    (best, a) => {
      const near = cutData.flatMap((c) => c.value.filter((_, i) => Math.abs(c.angle[i] - a + 7) <= 12));
      const r = near.length ? Math.max(...near) : -Infinity;
      return r < best.r ? { a, r } : best;
    },
    { a: 165, r: Infinity },
  ).a;
  for (let k = 1; k <= range / 10; k++) {
    const r = (k / (range / 10)) * R;
    const v = lo + k * 10;
    const t = `${String(v).replace(/^-/, "−")}`;
    if (half) labels.push(text(cx - r, cy + FS_TICK * 1.1, t, { "text-anchor": "middle" }));
    else {
      const [x, y] = P(labelAngle, r);
      labels.push(text(x + (labelAngle > 0 ? 0.6 : -0.6), y + FS_TICK * 0.35, t, { "text-anchor": labelAngle > 0 ? "start" : "end" }));
    }
  }
  out.push(group(labels, { "font-size": FS_TICK }));
  // data
  const cuts: ChartSeries[] = opt.cuts
    ? opt.cuts.map((c) => ({ label: c.label, x: c.angle, y: c.value, dash: c.dash, marker: c.marker ?? "circle" }))
    : [0, 90].map((phi, k) => {
        const c = patternCut(ff.theta, ff.phi, ff.directivity_dbi, phi, half);
        return { label: k ? "φ = 90° (yz plane)" : "φ = 0° (xz plane)", x: c.angle, y: c.value, dash: k ? "2 1" : undefined, marker: (k ? "square" : "circle") as Marker };
      });
  cuts.forEach((cs, k) => {
    const c = { angle: cs.x, value: cs.y };
    const ok = c.angle.map((_, i) => Number.isFinite(c.value[i]));
    const pts = c.angle.map((a, i) => P(a, rOf(ok[i] ? c.value[i] : lo)));
    // break the line where the data has gaps (a reference outside its own θ range)
    let run: Pt[] = [];
    pts.forEach((pt, i) => {
      if (ok[i]) run.push(pt);
      if ((!ok[i] || i === pts.length - 1) && run.length) {
        out.push(polyline(run, { stroke: "#000", "stroke-width": LW_DATA, "stroke-dasharray": cuts[k].dash, "stroke-linejoin": "round" }));
        run = [];
      }
    });
    const ms: string[] = [];
    const every = Math.max(1, Math.round(15 / Math.max(1e-6, Math.abs((c.angle[1] ?? 3) - (c.angle[0] ?? 0)))));
    const off = k * Math.floor(every / 2);
    for (let i = off; i < c.angle.length; i += every) if (ok[i]) ms.push(markerSvg(cuts[k].marker!, pts[i][0], pts[i][1], 0.6));
    out.push(group(ms));
  });
  out.push(text(1, FS_LABEL + 0.5, opt.title ?? `Directivity (dBi), f = ${ghz(ff.f)} GHz`, { "font-size": FS_LABEL }));
  out.push(text(width - 1, FS_LABEL + 0.5, `Dmax ${ff.dmax_dbi.toFixed(2)} dBi`, { "font-size": FS_TICK, "text-anchor": "end" }));
  // legend: rows under the plot
  const itemW = cuts.map((c) => 7 + 1.5 + textWidth(c.label, FS_TICK) + 4);
  const leg: string[] = [];
  legendRows.forEach((row, r) => {
    const ly = height - legendH + 0.5 + r * FS_TICK * 1.6;
    let lx = (width - row.reduce((a, i) => a + itemW[i], 0)) / 2;
    for (const i of row) {
      const c = cuts[i];
      const y = ly + FS_TICK * 0.6;
      leg.push(line(lx, y, lx + 7, y, { stroke: "#000", "stroke-width": LW_DATA, "stroke-dasharray": c.dash }));
      leg.push(markerSvg(c.marker!, lx + 3.5, y, 0.6));
      leg.push(text(lx + 8.5, y + FS_TICK * 0.35, c.label, { "font-size": FS_TICK }));
      lx += itemW[i];
    }
  });
  out.push(group(leg, { class: "legend" }));
  return svgDoc(width, height, group(out), `${b.name} — pattern at ${ghz(ff.f)} GHz`, `θ measured from +z; ${half ? "upper half space (infinite ground)" : "full sphere"}; radius ${range} dB below ${topDb} dBi`);
}

/**
 * B&W Smith chart of the input reflection coefficient: constant-resistance circles and
 * constant-reactance arcs (normalised to the port impedance), the locus with arrow and start/stop
 * labels, and the band centres marked.
 */
export function smithFigure(b: Bundle, opt: FigureOptions = {}): string | null {
  const s = sweep(b);
  if (!s) return null;
  const width = opt.widthMm ?? COLUMN_WIDTH.single;
  const titleH = FS_LABEL + 2;
  const legendH = FS_TICK * 1.6 + 2;
  const pad = FS_TICK * 2.2;
  const R = Math.max(15, Math.min((width - 2 * pad) / 2, opt.heightMm ? (opt.heightMm - titleH - legendH - 2 * pad) / 2 : 60));
  const height = opt.heightMm ?? titleH + 2 * pad + 2 * R + legendH + FS_TICK;
  const cx = width / 2;
  const cy = titleH + pad + R;
  const P = (re: number, im: number): Pt => [cx + R * re, cy - R * im];
  const gamma = (r: number, x: number): [number, number] => {
    // Γ = (z − 1) / (z + 1)
    const dr = (r + 1) * (r + 1) + x * x;
    return [(r * r + x * x - 1) / dr, (2 * x) / dr];
  };
  const sweepVals = (n: number) => Array.from({ length: n + 1 }, (_, i) => Math.tan(((i / n) * 0.999 - 0.4995) * Math.PI));
  const grid: string[] = [];
  const minor = { stroke: GRID, "stroke-width": LW_GRID };
  // resistance circles: x swept over (−∞, ∞)
  for (const r of [0.2, 0.5, 1, 2, 5]) grid.push(polyline(sweepVals(160).map((x) => P(...gamma(r, x))), minor));
  // reactance arcs: r swept over [0, ∞)
  const rs = Array.from({ length: 121 }, (_, i) => Math.tan((i / 120) * 0.4995 * Math.PI));
  for (const x of [0.2, 0.5, 1, 2, 5]) for (const sg of [1, -1]) grid.push(polyline(rs.map((r) => P(...gamma(r, sg * x))), minor));
  grid.push(line(cx - R, cy, cx + R, cy, minor));
  const out: string[] = [group(grid)];
  out.push(circle(cx, cy, R, { fill: "none", stroke: "#000", "stroke-width": LW_AXIS }));
  // labels: resistance values along the real axis, reactance at the rim
  const labels: string[] = [];
  for (const r of [0.2, 0.5, 1, 2, 5]) {
    const [x] = P(...gamma(r, 0));
    labels.push(text(x - 0.6, cy - 0.8, String(r), { "text-anchor": "end" }));
  }
  for (const x of [0.2, 0.5, 1, 2, 5]) for (const sg of [1, -1]) {
    const g = gamma(0, sg * x);
    const [px, py] = P(g[0] * 1.07, g[1] * 1.07);
    labels.push(text(px, py + FS_TICK * 0.35, `${sg > 0 ? "+" : "−"}j${x}`, { "text-anchor": "middle" }));
  }
  labels.push(text(cx - R - 1, cy + FS_TICK * 0.35, "0", { "text-anchor": "end" }));
  labels.push(text(cx + R + 1, cy + FS_TICK * 0.35, "∞", { "text-anchor": "start" }));
  out.push(group(labels, { "font-size": FS_TICK }));
  // locus
  const pts = s.s11Re.map((re, i) => P(re, s.s11Im[i]));
  out.push(polyline(pts, { stroke: "#000", "stroke-width": LW_DATA, "stroke-linejoin": "round" }));
  // direction arrow at 1/3 of the sweep
  const k = Math.floor(pts.length / 3);
  if (pts.length > k + 1) {
    const [x0, y0] = pts[k];
    const [x1, y1] = pts[k + 1];
    const l = Math.hypot(x1 - x0, y1 - y0) || 1;
    const ux = (x1 - x0) / l;
    const uy = (y1 - y0) / l;
    out.push(polygon([[x0 + ux * 1.6, y0 + uy * 1.6], [x0 - uy * 0.6, y0 + ux * 0.6], [x0 + uy * 0.6, y0 - ux * 0.6]], { fill: "#000", stroke: "none" }));
  }
  const endLabel = (i: number, t: string) => {
    const [x, y] = pts[i];
    out.push(markerSvg("square", x, y, 0.6));
    out.push(text(x + 1.2, y - 1, t, { "font-size": FS_TICK }));
  };
  endLabel(0, `${ghz(s.f[0])} GHz`);
  endLabel(pts.length - 1, `${ghz(s.f[s.f.length - 1])} GHz`);
  for (const bd of b.results?.bands ?? []) {
    let i = 0;
    for (let j = 1; j < s.f.length; j++) if (Math.abs(s.f[j] - bd.f_center) < Math.abs(s.f[i] - bd.f_center)) i = j;
    const [x, y] = pts[i];
    out.push(markerSvg("circle", x, y, 0.7));
    out.push(text(x + 1.2, y + FS_TICK * 1.1, `${ghz(bd.f_center)} GHz`, { "font-size": FS_TICK }));
  }
  out.push(text(1, FS_LABEL + 0.5, `Input reflection coefficient, Z0 = ${Number(s.zRef.toFixed(1))} Ω`, { "font-size": FS_LABEL }));
  const ly = Math.max(height - legendH + 0.5 + FS_TICK * 0.6, cy + R + pad + FS_TICK * 0.6);
  out.push(group([
    markerSvg("square", cx - 34, ly, 0.6), text(cx - 32.5, ly + FS_TICK * 0.35, "sweep start / stop", { "font-size": FS_TICK }),
    markerSvg("circle", cx + 6, ly, 0.7), text(cx + 7.5, ly + FS_TICK * 0.35, "band centre (|S11| min)", { "font-size": FS_TICK }),
  ], { class: "legend" }));
  return svgDoc(width, height, group(out), `${b.name} — Smith chart`, "Normalised impedance grid; locus of S11 over the simulated band");
}

export const patternTag = (fHz: number) => `${(Math.round(fHz / 1e6) / 1e3).toFixed(3)}GHz`;

/** File tag of far field i: the frequency, plus the driven port (or index) when another pattern
 * shares the frequency (multi-port runs store one embedded pattern per port). */
export function ffTag(ffs: FarField[], i: number): string {
  const t = patternTag(ffs[i].f);
  const shared = ffs.some((g, j) => j !== i && patternTag(g.f) === t);
  return shared ? `${t}_${ffs[i].port != null ? `P${ffs[i].port}` : i + 1}` : t;
}

const DASHES = [undefined, "2 1", "0.5 0.8", "3 0.8 0.6 0.8"];
const MARKERS: Marker[] = ["circle", "square", "triangle", "diamond"];

/**
 * B&W N-port S-parameter magnitudes: "reflection" (S_ii of every port) or "transmission"
 * (S_ij, i ≠ j; with a reciprocal matrix only i > j is drawn). Series differ by dash and marker;
 * at most 8 are drawn (the description says how many were left out).
 */
export function sparamFigure(b: Bundle, kind: "reflection" | "transmission", opt: FigureOptions = {}): string | null {
  const S = sMatrix(b);
  if (!S || S.ports.length < 2) return null;
  const recip = S.reciprocity !== null ? S.reciprocity < 1e-3 : true;
  const pairs = S.pairs.filter(([i, j]) => (kind === "reflection" ? i === j : i !== j && (!recip || i > j || !S.get(j, i))));
  if (!pairs.length) return null;
  const shown = pairs.slice(0, 8);
  const width = opt.widthMm ?? COLUMN_WIDTH.single;
  const height = opt.heightMm ?? (width > 120 ? 80 : 62);
  const f = S.f.map((x) => x / 1e9);
  const series: ChartSeries[] = shown.map((p, k) => ({
    label: `|${pairLabel(p)}|${kind === "transmission" && recip ? ` = |${pairLabel([p[1], p[0]])}|` : ""}`,
    x: f,
    y: magDb(S.get(p[0], p[1])!),
    dash: DASHES[k % 4],
    marker: shown.length > 1 ? MARKERS[k % 4] : undefined,
  }));
  const minDb = Math.min(...series.flatMap((x) => x.y.filter(Number.isFinite)));
  const svg = lineChartSvg({
    width, height,
    title: `${b.name} — ${kind === "reflection" ? "reflection coefficients" : "transmission (coupling)"}`,
    xLabel: "Frequency (GHz)",
    yLabel: series.length === 1 ? `${series[0].label} (dB)` : kind === "reflection" ? "|Sii| (dB)" : "|Sij| (dB)",
    series,
    xDomain: [f[0], f[f.length - 1]],
    yDomain: [Math.min(kind === "reflection" ? -30 : -40, Math.floor(minDb / 5) * 5), 0],
    hlines: kind === "reflection" ? [{ y: -10, label: "−10 dB" }] : [],
  });
  return pairs.length > shown.length ? svg.replace("</title>", `</title><desc>${pairs.length - shown.length} further pairs omitted; see data/sparams.csv</desc>`) : svg;
}

/**
 * openEMS vs imported reference: |S11| overlay (openEMS solid, reference dashed with markers) and
 * pattern cuts at the reference far-field frequency (φ = 0°/90° by marker, source by dash).
 */
export function comparisonFigures(b: Bundle, ref: Bundle & { reference: { label: string } }, opt: FigureOptions = {}): { name: string; svg: string }[] {
  const out: { name: string; svg: string }[] = [];
  const width = opt.widthMm ?? COLUMN_WIDTH.single;
  const a = sweep(b);
  const r = sweep(ref);
  const label = ref.reference.label;
  if (a && r && r.f.length) {
    const fa = a.f.map((x) => x / 1e9);
    const fr = r.f.map((x) => x / 1e9);
    const minDb = Math.min(...a.s11Db.filter(Number.isFinite), ...r.s11Db.filter(Number.isFinite));
    out.push({
      name: "s11_overlay.svg",
      svg: lineChartSvg({
        width, height: opt.heightMm ?? (width > 120 ? 80 : 62),
        title: `${b.name} vs ${label} — |S11|`,
        xLabel: "Frequency (GHz)",
        yLabel: "|S11| (dB)",
        series: [
          { label: "openEMS", x: fa, y: a.s11Db },
          { label, x: fr, y: r.s11Db, dash: "2 1", marker: "circle" },
        ],
        xDomain: [Math.min(fa[0], fr[0]), Math.max(fa[fa.length - 1], fr[fr.length - 1])],
        yDomain: [Math.min(-30, Math.floor(minDb / 5) * 5), 0],
        hlines: [{ y: -10, label: "−10 dB" }],
      }),
    });
  }
  const rl = ref.results?.farfield ?? [];
  const pl = b.results?.farfield ?? [];
  if (rl.length && pl.length) {
    const rf = rl[0];
    const pf = pl.reduce((x, c) => (Math.abs(c.f - rf.f) < Math.abs(x.f - rf.f) ? c : x));
    const half = !!b.half_space;
    const cut = (ff: FarField, phi: number) => patternCut(ff.theta, ff.phi, ff.directivity_dbi, phi, half);
    const short = label.length > 22 ? `${label.slice(0, 21)}…` : label;
    const cuts: PolarCut[] = [
      { label: "openEMS φ = 0°", ...cut(pf, 0), marker: "circle" },
      { label: "openEMS φ = 90°", ...cut(pf, 90), marker: "square" },
      { label: `${short} φ = 0°`, ...cut(rf, 0), dash: "2 1", marker: "circle" },
      { label: `${short} φ = 90°`, ...cut(rf, 90), dash: "2 1", marker: "square" },
    ];
    const svg = patternFigureFor(b, pf, { widthMm: width, cuts, title: `Pattern (dBi), openEMS ${ghz(pf.f)} GHz vs reference ${ghz(rf.f)} GHz` });
    if (svg) out.push({ name: `pattern_overlay_${patternTag(rf.f)}.svg`, svg });
  }
  return out;
}

/** All publication figures of a bundle at a column width. */
export function figureSet(b: Bundle, widthMm: number = COLUMN_WIDTH.single): { name: string; svg: string }[] {
  const out: { name: string; svg: string }[] = [];
  const s = s11Figure(b, { widthMm });
  if (s) out.push({ name: "s11.svg", svg: s });
  const z = zinFigure(b, { widthMm });
  if (z) out.push({ name: "zin.svg", svg: z });
  const sm = smithFigure(b, { widthMm });
  if (sm) out.push({ name: "smith.svg", svg: sm });
  const sr = sparamFigure(b, "reflection", { widthMm });
  if (sr) out.push({ name: "sparams_reflection.svg", svg: sr });
  const st = sparamFigure(b, "transmission", { widthMm });
  if (st) out.push({ name: "sparams_transmission.svg", svg: st });
  (b.results?.farfield ?? []).forEach((_, i, ffs) => {
    const p = patternFigure(b, i, { widthMm });
    if (p) out.push({ name: `pattern_${ffTag(ffs, i)}.svg`, svg: p });
  });
  return out;
}
