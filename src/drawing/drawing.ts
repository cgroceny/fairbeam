import { withoutVoids } from "../lib/voidParts.ts";
import { lumpedLabel } from "../lumped.ts";
// Academic / engineering technical drawing of a project bundle: orthographic views (first or third
// angle), optional isometric view, automatic ISO-style dimensions, on an A4/A3 sheet with title
// block, or as a bare figure for papers. Pure TypeScript: bundle in, SVG string out (no DOM).

import type { Bundle, LumpedElement, Vec3 } from "../types";
import {
  axisName, isHidden, portLine, sameBox, toUV, unionBox, viewDefs, viewPorts, viewShapes,
  type PortView, type Projection, type Shape, type ViewDef, type ViewId,
} from "./geometry.ts";
import { layoutSides, paramLabel, planDimensions, renderDims, type AngleSpec, type DimPlan, type DimStyle } from "./dimensions.ts";
import { isoModel, isoPt, type IsoModel } from "./iso.ts";
import { frame, frameRect, notesBlock, SHEETS, titleBlock, type SheetSize } from "./sheet.ts";
import { arrowHead, circle, group, line, n, polygon, rect, svgDoc, text, type Pt } from "./svg.ts";
import { textWidth } from "./metrics.ts";
import { portFeedEntries } from "../lib/portGroups.ts";

export type SheetOption = SheetSize | "figure";

export interface DrawingOptions {
  sheet: SheetOption;
  projection: Projection;
  isometric: boolean;
  dimensions: boolean;
  /** figure mode: total width in mm (16 cm fits a single-column A4 thesis page) */
  figureWidthMm: number;
  /** date printed in the title block (YYYY-MM-DD); default today */
  date?: string;
  /** label dimensions that equal a model parameter as "key = value"; default: on in figure mode */
  paramLabels?: boolean;
  /** isometric view: draw edges hidden behind other faces as thin dashed lines */
  isoHidden?: boolean;
  /** per-view dimension switch (default: all on, subject to `dimensions`) */
  viewDims?: Partial<Record<ViewId, boolean>>;
  /** add a legend of the line types next to the notes */
  legend?: boolean;
}

export const DEFAULT_DRAWING_OPTIONS: DrawingOptions = {
  sheet: "A3",
  projection: "third",
  isometric: true,
  dimensions: true,
  figureWidthMm: 160,
};

export interface DrawingResult {
  svg: string;
  widthMm: number;
  heightMm: number;
  /** drawing scale (paper mm per model unit) */
  scale: number;
  scaleLabel: string;
  notes: string[];
  warnings: string[];
  /** dimension values shown, as printed */
  dimensions: string[];
  /** identity of each dimension (3D axis and interval, or the angle's part), aligned with `dimensions` */
  dimensionKeys: string[];
}

interface Style {
  metal: number;
  diel: number;
  thin: number;
  hatch: number;
  tmin: number;
  fs: number;
  fsTitle: number;
  fsSmall: number;
  arrow: number;
  base: number;
  step: number;
  extGap: number;
  extOver: number;
  portR: number;
  centre: string;
  hidden: string;
  gap: number;
}

// ISO 128 line groups 0.5 (A4, figures) and 0.7 (A3)
const STYLE_05: Style = {
  metal: 0.5, diel: 0.35, thin: 0.25, hatch: 0.18, tmin: 0.7, fs: 2.5, fsTitle: 3, fsSmall: 2.1, arrow: 2.5,
  base: 7, step: 5.5, extGap: 0.8, extOver: 1.5, portR: 1.3, centre: "6 1 0.5 1", hidden: "2.5 1", gap: 8,
};
const STYLE_07: Style = {
  metal: 0.7, diel: 0.5, thin: 0.35, hatch: 0.25, tmin: 1, fs: 3, fsTitle: 3.5, fsSmall: 2.5, arrow: 3,
  base: 8.5, step: 6.5, extGap: 1, extOver: 2, portR: 1.6, centre: "8 1.3 0.6 1.3", hidden: "3.2 1.2", gap: 10,
};

type Box = [number, number, number, number];

interface Cell {
  W: number;
  H: number;
  m: { t: number; b: number; l: number; r: number };
  render: () => string;
}

interface Ctx {
  b: Bundle;
  o: DrawingOptions;
  st: Style;
  figure: boolean;
  views: Record<ViewId, ViewDef>;
  shapes: Record<ViewId, Shape[]>;
  ports: Record<ViewId, PortView[]>;
  plan: DimPlan;
  iso: IsoModel;
  letters: Record<string, string>;
}

const METAL_FILL = "#d9d9d9";
const GROUND_FILL = "#f0f0f0";

const boxesHit = (a: Box, b: Box, pad = 0) => a[0] < b[2] + pad && a[2] > b[0] - pad && a[1] < b[3] + pad && a[3] > b[1] - pad;

/** Does segment p-q cross rectangle r (Liang–Barsky)? */
function segHitsRect(p: Pt, q: Pt, r: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const clip = (pp: number, qq: number) => {
    if (Math.abs(pp) < 1e-12) return qq >= 0;
    const t = qq / pp;
    if (pp < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, p[0] - r[0]) && clip(dx, r[2] - p[0]) && clip(-dy, p[1] - r[1]) && clip(dy, r[3] - p[1]);
}

/** 45° section hatch lines clipped to a rectangle (explicit lines: exact in every renderer). */
function hatchRect(r: Box, spacing: number, flip: boolean): string {
  const [x0, y0, x1, y1] = r;
  const step = spacing * Math.SQRT2;
  const pts: string[] = [];
  if (!flip) {
    // lines x + y = c (rising to the right on paper)
    for (let c = x0 + y0 + step / 2; c < x1 + y1; c += step) {
      const xa = Math.max(x0, c - y1);
      const xb = Math.min(x1, c - y0);
      if (xb - xa > 1e-6) pts.push(`M${n(xa)} ${n(c - xa)}L${n(xb)} ${n(c - xb)}`);
    }
  } else {
    // lines x - y = c (falling to the right)
    for (let c = x0 - y1 + step / 2; c < x1 - y0; c += step) {
      const xa = Math.max(x0, c + y0);
      const xb = Math.min(x1, c + y1);
      if (xb - xa > 1e-6) pts.push(`M${n(xa)} ${n(xa - c)}L${n(xb)} ${n(xb - c)}`);
    }
  }
  return pts.join("");
}

function portSymbol(cx: number, cy: number, r: number, sw: number): string {
  const x0 = cx - 0.62 * r;
  return group([
    circle(cx, cy, r, { fill: "#fff", stroke: "#000", "stroke-width": sw }),
    `<path d="M${n(x0)} ${n(cy)}Q${n(x0 + 0.31 * r)} ${n(cy - 0.75 * r)} ${n(x0 + 0.62 * r)} ${n(cy)}T${n(x0 + 1.24 * r)} ${n(cy)}" fill="none" stroke="#000" stroke-width="${n(sw)}"/>`,
  ]);
}

/** Zigzag through a rectangle along x or y (the resistor symbol's body), as a path string. */
function zigzag(x0: number, y0: number, x1: number, y1: number, along: "x" | "y"): string {
  const N = 6;
  const pts: Pt[] = [];
  const L = along === "x" ? x1 - x0 : y1 - y0;
  const A = (along === "x" ? y1 - y0 : x1 - x0) * 0.3;
  for (let i = 0; i <= N + 1; i++) {
    const t = (along === "x" ? x0 : y0) + L * (0.12 + (0.76 * i) / (N + 1));
    const off = i === 0 || i === N + 1 ? 0 : i % 2 ? A : -A;
    pts.push(along === "x" ? [t, (y0 + y1) / 2 + off] : [(x0 + x1) / 2 + off, t]);
  }
  return pts.map(([x, y], i) => `${i ? "L" : "M"}${n(x)} ${n(y)}`).join("");
}

/** Small label on a white box, readable over traces and centre lines. */
function haloText(x: number, y: number, t: string, fs: number): string {
  const w = textWidth(t, fs);
  return group([rect(x - 0.3, y - fs * 0.85, w + 0.6, fs * 1.1, { fill: "#fff", stroke: "none" }), text(x, y, t, { "font-size": fs })]);
}

/** Lumped resistor in an orthographic view: its footprint outlined, a zigzag along the current. */
function lumpedSymbol(e: LumpedElement, v: ViewDef, X: (u: number) => number, Y: (v: number) => number, st: Style, label: boolean): string {
  const a = toUV(e.start, v);
  const c = toUV(e.stop, v);
  let x0 = Math.min(X(a[0]), X(c[0])), x1 = Math.max(X(a[0]), X(c[0]));
  let y0 = Math.min(Y(a[1]), Y(c[1])), y1 = Math.max(Y(a[1]), Y(c[1]));
  const minS = st.portR * 1.4;
  if (x1 - x0 < minS) [x0, x1] = [(x0 + x1) / 2 - minS / 2, (x0 + x1) / 2 + minS / 2];
  if (y1 - y0 < minS) [y0, y1] = [(y0 + y1) / 2 - minS / 2, (y0 + y1) / 2 + minS / 2];
  const k = "xyz".indexOf(e.direction);
  const along = k === v.u.axis ? "x" : k === v.v.axis ? "y" : null;
  const out = [rect(x0, y0, x1 - x0, y1 - y0, { fill: "#fff", stroke: "#000", "stroke-width": st.thin * 1.2 })];
  if (along) out.push(`<path d="${zigzag(x0, y0, x1, y1, along)}" fill="none" stroke="#000" stroke-width="${n(st.thin * 1.2)}" stroke-linejoin="round"/>`);
  if (label) out.push(haloText(x1 + 0.8, (y0 + y1) / 2 + st.fsSmall * 0.35, lumpedLabel(e), st.fsSmall));
  return group(out);
}

/** Lumped resistor in the isometric view: the element's face (the flattest side, on top). */
function lumpedIso(e: LumpedElement, P: (p: Vec3) => Pt, st: Style): string {
  const lo = e.start.map((x, i) => Math.min(x, e.stop[i])) as Vec3;
  const hi = e.start.map((x, i) => Math.max(x, e.stop[i])) as Vec3;
  const ext = hi.map((x, i) => x - lo[i]);
  const nAx = ext.indexOf(Math.min(...ext));
  const u = (nAx + 1) % 3;
  const w = (nAx + 2) % 3;
  const at = (su: number, sw: number): Vec3 => {
    const p: Vec3 = [...lo];
    p[nAx] = hi[nAx];
    p[u] = su;
    p[w] = sw;
    return p;
  };
  const face = [at(lo[u], lo[w]), at(hi[u], lo[w]), at(hi[u], hi[w]), at(lo[u], hi[w])].map(P);
  const out = [polygon(face, { fill: "#fff", stroke: "#000", "stroke-width": st.thin * 1.2, "stroke-linejoin": "round" })];
  const k = "xyz".indexOf(e.direction);
  if (k !== nAx) {
    const o = k === u ? w : u;
    const N = 6;
    const pts: Pt[] = [];
    for (let i = 0; i <= N + 1; i++) {
      const q: Vec3 = [...lo];
      q[nAx] = hi[nAx];
      q[k] = lo[k] + ext[k] * (0.12 + (0.76 * i) / (N + 1));
      q[o] = (lo[o] + hi[o]) / 2 + (i === 0 || i === N + 1 ? 0 : (i % 2 ? 0.3 : -0.3) * ext[o]);
      pts.push(P(q));
    }
    out.push(`<path d="${pts.map(([x, y], i) => `${i ? "L" : "M"}${n(x)} ${n(y)}`).join("")}" fill="none" stroke="#000" stroke-width="${n(st.thin)}" stroke-linejoin="round"/>`);
  }
  const right = Math.max(...face.map((f) => f[0]));
  const cy = face.reduce((acc, f) => acc + f[1], 0) / 4;
  out.push(haloText(right + 0.8, cy + st.fsSmall * 0.35, lumpedLabel(e), st.fsSmall));
  return group(out, { class: "lumped" });
}

/** Small coordinate triad; returns [svg, width]. `dirs` are paper unit vectors with labels. */
function triad(x: number, y: number, dirs: { d: Pt; label: string }[], len: number, st: Style): string {
  const out: string[] = [circle(x, y, 0.35, { fill: "#000", stroke: "none" })];
  for (const { d, label } of dirs) {
    const ex = x + d[0] * len;
    const ey = y + d[1] * len;
    out.push(line(x, y, ex, ey, { stroke: "#000", "stroke-width": st.thin }));
    out.push(arrowHead(ex, ey, d[0], d[1], Math.min(1.6, len * 0.35)));
    const lx = ex + d[0] * 1.3;
    const ly = ey + d[1] * 1.3 + st.fsSmall * 0.35;
    out.push(text(lx, ly, label, { "font-size": st.fsSmall, "text-anchor": Math.abs(d[0]) < 0.3 ? "middle" : d[0] > 0 ? "start" : "end", "font-style": "italic" }));
  }
  return group(out, { class: "triad" });
}

// ------------------------------------------------------------------ orthographic view

function viewRange(ctx: Ctx, id: ViewId): Box {
  const boxes = ctx.shapes[id].map((s) => s.bbox);
  for (const p of ctx.ports[id]) boxes.push([Math.min(p.a[0], p.b[0]), Math.min(p.a[1], p.b[1]), Math.max(p.a[0], p.b[0]), Math.max(p.a[1], p.b[1])]);
  const u = unionBox(boxes) ?? [-1, -1, 1, 1];
  const hs = ctx.b.half_space;
  if (hs && id !== "top") {
    const g = hs.position * ctx.views[id].v.sign;
    u[1] = Math.min(u[1], g);
    u[3] = Math.max(u[3], g);
  }
  return u;
}

function viewTitle(ctx: Ctx, key: string, t: string): string {
  return ctx.figure ? `${ctx.letters[key]} ${t}` : t;
}

function buildOrtho(ctx: Ctx, id: ViewId, s: number, ur: [number, number], vr: [number, number]): Cell {
  const st = ctx.st;
  const v = ctx.views[id];
  const shapes = ctx.shapes[id];
  const pad = st.tmin;
  const X = (u: number) => pad + (u - ur[0]) * s;
  const Y = (w: number) => pad + (vr[1] - w) * s;
  const W = 2 * pad + (ur[1] - ur[0]) * s;
  const H = 2 * pad + (vr[1] - vr[0]) * s;
  const obj: Box = [0, 0, W, H];
  const hs = ctx.b.half_space;
  const groundV = hs && id !== "top" ? hs.position * v.v.sign : null;
  const groundLabel = "PEC ground plane (infinite)";
  const showGroundLabel = groundV !== null && id === "front";
  if (groundV !== null) {
    obj[0] = Math.min(obj[0], -4);
    obj[2] = Math.max(obj[2], W + 4, showGroundLabel ? -4 + textWidth(groundLabel, st.fsSmall) : 0);
    obj[3] = Math.max(obj[3], Y(groundV) + 2.2 + (showGroundLabel ? st.fsSmall + 1 : 0));
  }

  // --- metal bars (sheets seen edge-on and very thin solids) in paper coordinates
  const dielPolys = shapes.filter((x) => x.role === "dielectric" && x.kind === "poly");
  const barOf = (sh: Shape): Box | null => {
    const [a, b, c, d] = sh.bbox;
    const px0 = X(a), px1 = X(c), py0 = Y(d), py1 = Y(b);
    const wPx = px1 - px0;
    const hPx = py1 - py0;
    const isRect = sh.kind === "edge" || (sh.kind === "poly" && sh.pts.length === 4 && sh.pts.every(([u, w]) => (Math.abs(u - a) < 1e-9 || Math.abs(u - c) < 1e-9) && (Math.abs(w - b) < 1e-9 || Math.abs(w - d) < 1e-9)));
    if (!isRect) return null;
    if (hPx < st.tmin && wPx >= hPx) {
      if (wPx < 1e-6) return null;
      const vc = (b + d) / 2;
      const onTop = sh.kind === "edge" && dielPolys.some((o) => Math.abs(o.bbox[3] - vc) < 1e-6 && o.bbox[0] < c && o.bbox[2] > a);
      const below = sh.kind === "edge" && dielPolys.some((o) => Math.abs(o.bbox[1] - vc) < 1e-6 && o.bbox[0] < c && o.bbox[2] > a);
      const y = Y(vc);
      return onTop ? [px0, y - st.tmin, px1, y] : below ? [px0, y, px1, y + st.tmin] : [px0, y - st.tmin / 2, px1, y + st.tmin / 2];
    }
    if (wPx < st.tmin && hPx > wPx) {
      const uc = (a + c) / 2;
      const right = sh.kind === "edge" && dielPolys.some((o) => Math.abs(o.bbox[2] - uc) < 1e-6 && o.bbox[1] < d && o.bbox[3] > b);
      const left = sh.kind === "edge" && dielPolys.some((o) => Math.abs(o.bbox[0] - uc) < 1e-6 && o.bbox[1] < d && o.bbox[3] > b);
      const x = X(uc);
      return right ? [x, py0, x + st.tmin, py1] : left ? [x - st.tmin, py0, x, py1] : [x - st.tmin / 2, py0, x + st.tmin / 2, py1];
    }
    return null;
  };

  // outline segments (paper) for label collision tests
  const segs: [Pt, Pt][] = [];
  for (const sh of shapes) {
    if (sh.kind === "circle" && sh.c && sh.r) {
      const [a, b, c, d] = sh.bbox;
      segs.push([[X(a), Y(b)], [X(c), Y(b)]], [[X(c), Y(b)], [X(c), Y(d)]], [[X(c), Y(d)], [X(a), Y(d)]], [[X(a), Y(d)], [X(a), Y(b)]]);
      continue;
    }
    const P = sh.pts.map(([u, w]) => [X(u), Y(w)] as Pt);
    const bar = barOf(sh);
    if (bar) {
      const [x0, y0, x1, y1] = bar;
      segs.push([[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]);
    } else if (sh.kind === "edge") segs.push([P[0], P[1]]);
    else P.forEach((p, i) => segs.push([p, P[(i + 1) % P.length]]));
  }
  if (groundV !== null) segs.push([[-4, Y(groundV)], [W + 4, Y(groundV)]], [[-4, Y(groundV) + 1.8], [W + 4, Y(groundV) + 1.8]]);

  // --- port label (only in the front view, where the feed gap shows)
  const labelParts: string[] = [];
  if (id === "front") {
    for (const p of ctx.ports[id]) {
      const c: Pt = [(X(p.a[0]) + X(p.b[0])) / 2, (Y(p.a[1]) + Y(p.b[1])) / 2];
      const tw = textWidth(p.label, st.fsSmall);
      const r = st.portR;
      const cands: Pt[] = [[1, -1], [-1, -1], [1, 0], [-1, 0], [1, 1], [-1, 1]];
      let best: { score: number; svg: string; box: Box } | null = null;
      for (const d of cands) {
        const l = Math.hypot(d[0], d[1]);
        const u: Pt = [d[0] / l, d[1] / l];
        const reach = d[1] === 0 ? r + 3 : r + 5;
        const k: Pt = [c[0] + u[0] * reach, c[1] + u[1] * reach];
        const sx = d[0];
        const e: Pt = [k[0] + sx * (tw + 1.5), k[1]];
        const box: Box = [Math.min(k[0], e[0]), k[1] - st.fsSmall * 0.95, Math.max(k[0], e[0]), k[1] + 0.3];
        let score = segs.filter(([a, b]) => segHitsRect(a, b, box)).length * 10;
        if (box[0] < 0 || box[2] > W || box[1] < 0 || box[3] > H) score += 1;
        if (!best || score < best.score) {
          const tx = sx > 0 ? k[0] + 0.6 : k[0] - 0.6;
          best = {
            score,
            box,
            svg: group([
              polyLine([[c[0] + u[0] * r, c[1] + u[1] * r], k, e], st.thin),
              rect(box[0], box[1], box[2] - box[0], box[3] - box[1] - 0.5, { fill: "#fff", stroke: "none", "fill-opacity": 0.85 }),
              text(tx, k[1] - 0.6, p.label, { "font-size": st.fsSmall, "text-anchor": sx > 0 ? "start" : "end" }),
            ]),
          };
        }
      }
      if (best) {
        labelParts.push(best.svg);
        obj[0] = Math.min(obj[0], best.box[0] - 1);
        obj[1] = Math.min(obj[1], best.box[1] - 1);
        obj[2] = Math.max(obj[2], best.box[2] + 1);
        obj[3] = Math.max(obj[3], best.box[3] + 1);
      }
    }
  }

  // --- dimensions
  const dimSt: DimStyle = { fs: st.fs, thin: st.thin, arrow: st.arrow, base: st.base, step: st.step, extGap: st.extGap, extOver: st.extOver };
  const dimsOn = ctx.o.dimensions && ctx.o.viewDims?.[id] !== false;
  const specs = dimsOn ? ctx.plan.dims.filter((d) => d.view === id) : [];
  const lay = layoutSides(specs, shapes, { X, Y }, obj, dimSt);
  const m = {
    t: -obj[1] + lay.margin.top,
    b: obj[3] - H + lay.margin.bottom,
    l: -obj[0] + lay.margin.left,
    r: obj[2] - W + lay.margin.right,
  };

  // --- title with a small triad
  const title = viewTitle(ctx, id, `${v.title} (${axisName(v.u.axis)}${axisName(v.v.axis)})`);
  const triadW = 9;
  const titleW = triadW + textWidth(title, st.fsTitle, 600);
  const titleBase = H + m.b + 2 + 4.6;
  m.b += 2 + 4.6 + 1;
  const half = titleW / 2 - W / 2;
  m.l = Math.max(m.l, half, 0.5);
  m.r = Math.max(m.r, half, 0.5);

  const render = () => {
    const out: string[] = [];
    // 1. dielectrics and other non-metal parts
    const fills: string[] = [];
    const hatches: string[] = [];
    const outlines: string[] = [];
    const approx: string[] = [];
    const inner: string[] = [];
    const axes: string[] = [];
    for (const sh of shapes) {
      if (sh.role === "metal") continue;
      const target = sh.role === "approx" ? approx : outlines;
      if (sh.kind === "circle" && sh.c && sh.r) {
        fills.push(circle(X(sh.c[0]), Y(sh.c[1]), sh.r * s, { fill: "#fff", stroke: "none" }));
        target.push(circle(X(sh.c[0]), Y(sh.c[1]), sh.r * s));
        if (sh.ri) target.push(circle(X(sh.c[0]), Y(sh.c[1]), sh.ri * s));
        continue;
      }
      const P = sh.pts.map(([u, w]) => [X(u), Y(w)] as Pt);
      if (sh.kind === "edge") {
        target.push(line(P[0][0], P[0][1], P[1][0], P[1][1]));
        continue;
      }
      fills.push(polygon(P, { fill: "#fff", stroke: "none" }));
      if (sh.hatch) {
        const r: Box = [X(sh.bbox[0]), Y(sh.bbox[3]), X(sh.bbox[2]), Y(sh.bbox[1])];
        const sp = Math.min(2, Math.max(0.7, Math.min(r[2] - r[0], r[3] - r[1]) / 2));
        hatches.push(hatchRect(r, sp, sh.part % 2 === 1));
      }
      target.push(polygon(P));
      for (const [a, b] of sh.inner) inner.push(line(X(a[0]), Y(a[1]), X(b[0]), Y(b[1])));
      if (sh.axisLine) axes.push(line(X(sh.axisLine[0][0]) - 2, Y(sh.axisLine[0][1]), X(sh.axisLine[1][0]) + 2, Y(sh.axisLine[1][1])));
    }
    out.push(group(fills));
    if (hatches.length) out.push(`<path d="${hatches.join("")}" fill="none" stroke="#000" stroke-width="${n(st.hatch)}"/>`);
    out.push(group(outlines, { fill: "none", stroke: "#000", "stroke-width": st.diel }));
    if (inner.length) out.push(group(inner, { stroke: "#000", "stroke-width": st.thin }));
    if (approx.length) out.push(group(approx, { fill: "none", stroke: "#000", "stroke-width": st.diel, "stroke-dasharray": st.centre }));

    // 2. metal hidden behind dielectric: dashed thin (skipped where it coincides with a visible outline)
    const metal = shapes.filter((x) => x.role === "metal");
    const hidden = new Set(metal.filter((x) => isHidden(x, shapes)));
    const dashed: string[] = [];
    for (const sh of dashedShapes(shapes)) {
      if (sh.kind === "circle" && sh.c && sh.r) {
        dashed.push(circle(X(sh.c[0]), Y(sh.c[1]), sh.r * s));
        if (sh.ri) dashed.push(circle(X(sh.c[0]), Y(sh.c[1]), sh.ri * s));
      }
      else if (sh.kind === "edge") dashed.push(line(X(sh.pts[0][0]), Y(sh.pts[0][1]), X(sh.pts[1][0]), Y(sh.pts[1][1])));
      else dashed.push(polygon(sh.pts.map(([u, w]) => [X(u), Y(w)] as Pt)));
    }
    if (dashed.length) out.push(group(dashed, { fill: "none", stroke: "#000", "stroke-width": st.thin, "stroke-dasharray": st.hidden }));

    // 3. visible metal, back to front
    const vis = metal.filter((x) => !hidden.has(x)).sort((a, c) => a.depth[1] - c.depth[1]);
    const mf: string[] = [];
    for (const sh of vis) {
      const bar = barOf(sh);
      if (bar) {
        mf.push(rect(bar[0], bar[1], bar[2] - bar[0], bar[3] - bar[1], { fill: "#000", stroke: "none" }));
      } else if (sh.kind === "circle" && sh.c && sh.r) {
        const cx = X(sh.c[0]);
        const cy = Y(sh.c[1]);
        mf.push(circle(cx, cy, sh.r * s, { fill: METAL_FILL, stroke: "#000", "stroke-width": st.metal }));
        if (sh.ri) mf.push(circle(cx, cy, sh.ri * s, { fill: "#fff", stroke: "#000", "stroke-width": st.metal }));
        axes.push(line(cx - sh.r * s - 2, cy, cx + sh.r * s + 2, cy), line(cx, cy - sh.r * s - 2, cx, cy + sh.r * s + 2));
      } else if (sh.kind === "poly") {
        mf.push(polygon(sh.pts.map(([u, w]) => [X(u), Y(w)] as Pt), { fill: METAL_FILL, stroke: "#000", "stroke-width": st.metal }));
        for (const [a, b] of sh.inner) mf.push(line(X(a[0]), Y(a[1]), X(b[0]), Y(b[1]), { stroke: "#000", "stroke-width": st.thin }));
        if (sh.axisLine) axes.push(line(X(sh.axisLine[0][0]) - 2, Y(sh.axisLine[0][1]), X(sh.axisLine[1][0]) + 2, Y(sh.axisLine[1][1])));
      }
    }
    out.push(group(mf, { "stroke-linejoin": "round" }));

    // 4. centre lines on symmetry axes
    const sb = unionBox(shapes.map((x) => x.bbox));
    if (sb) {
      const { symmetric, center } = ctx.plan;
      if (symmetric[v.u.axis]) {
        const x = X(center[v.u.axis] * v.u.sign);
        axes.push(line(x, Y(sb[3]) - 3, x, Y(sb[1]) + 3));
      }
      if (symmetric[v.v.axis]) {
        const y = Y(center[v.v.axis] * v.v.sign);
        axes.push(line(X(sb[0]) - 3, y, X(sb[2]) + 3, y));
      }
    }
    if (axes.length) out.push(group(axes, { stroke: "#000", "stroke-width": st.thin, "stroke-dasharray": st.centre }));

    // 5. PEC ground boundary: thick line with hatch strokes underneath
    if (groundV !== null) {
      const gy = Y(groundV);
      const ticks: string[] = [];
      for (let x = -4 + 1.8; x <= W + 4 + 1e-6; x += 1.8) ticks.push(`M${n(x)} ${n(gy)}L${n(x - 1.6)} ${n(gy + 1.8)}`);
      out.push(group([
        line(-4, gy, W + 4, gy, { stroke: "#000", "stroke-width": st.metal }),
        `<path d="${ticks.join("")}" fill="none" stroke="#000" stroke-width="${n(st.thin)}"/>`,
        showGroundLabel ? text(-4, gy + 2.2 + st.fsSmall, groundLabel, { "font-size": st.fsSmall }) : "",
      ], { class: "ground" }));
    }

    // 6. ports
    const ports: string[] = [];
    for (const p of ctx.ports[id]) {
      const A: Pt = [X(p.a[0]), Y(p.a[1])];
      const B: Pt = [X(p.b[0]), Y(p.b[1])];
      if (!p.point) ports.push(line(A[0], A[1], B[0], B[1], { stroke: "#000", "stroke-width": st.thin }));
      ports.push(portSymbol((A[0] + B[0]) / 2, (A[1] + B[1]) / 2, st.portR, st.thin * 1.2));
    }
    out.push(group([...ports, ...labelParts], { class: "ports" }));

    // 6b. lumped elements (resistors), labelled in the top view
    const lumped = (ctx.b.lumped_elements ?? []).map((e) => lumpedSymbol(e, v, X, Y, st, id === "top"));
    if (lumped.length) out.push(group(lumped, { class: "lumped" }));

    // 7. dimensions
    if (lay.placed.length) out.push(renderDims(lay.placed, dimSt));
    if (dimsOn) for (const a of ctx.plan.angles.filter((x) => x.view === id)) out.push(renderAngle(a, X, Y, s, st));

    // 8. title and triad
    const tx = W / 2 - titleW / 2;
    const dirs = [
      { d: [v.u.sign, 0] as Pt, label: axisName(v.u.axis) },
      { d: [0, -v.v.sign] as Pt, label: axisName(v.v.axis) },
    ];
    const ox = v.u.sign > 0 ? tx + 0.8 : tx + 6.2;
    out.push(triad(ox, titleBase - 0.4, dirs, 4.2, st));
    out.push(text(tx + triadW, titleBase, title, { "font-size": st.fsTitle, "font-weight": 600 }));
    return group(out, { class: `view view-${id}` });
  };
  return { W, H, m, render };
}

/** Hidden metal shapes that get dashed lines (those coinciding with a visible outline are skipped). */
function dashedShapes(shapes: Shape[]): Shape[] {
  const hidden = shapes.filter((x) => isHidden(x, shapes));
  const visible = shapes.filter((x) => !hidden.includes(x));
  const rect4 = (x: Shape) => x.kind === "poly" && x.pts.length === 4;
  return hidden.filter((sh) => !visible.some((o) => sameBox(o.bbox, sh.bbox) && rect4(o) && rect4(sh)));
}

/** Angular dimension: arc between the legs with outward-pointing arrowheads and the value. */
function renderAngle(a: AngleSpec, X: (u: number) => number, Y: (v: number) => number, s: number, st: Style): string {
  const P: Pt = [X(a.apex[0]), Y(a.apex[1])];
  // paper directions (v up -> y down)
  const da: Pt = [a.da[0], -a.da[1]];
  const db: Pt = [a.db[0], -a.db[1]];
  const R = Math.max(8, Math.min(Math.min(a.la, a.lb) * s * 0.42, 32));
  const t0 = Math.atan2(da[1], da[0]);
  let dt = Math.atan2(db[1], db[0]) - t0;
  while (dt <= -Math.PI) dt += 2 * Math.PI;
  while (dt > Math.PI) dt -= 2 * Math.PI;
  const t1 = t0 + dt;
  const N = 32;
  const pts: Pt[] = Array.from({ length: N + 1 }, (_, i) => {
    const t = t0 + (dt * i) / N;
    return [P[0] + R * Math.cos(t), P[1] + R * Math.sin(t)];
  });
  const sg = Math.sign(dt);
  // arrowhead at the arc end at angle t, tangent pointing away from the arc's middle
  const head = (t: number, dir: number) => arrowHead(P[0] + R * Math.cos(t), P[1] + R * Math.sin(t), -Math.sin(t) * dir, Math.cos(t) * dir, st.arrow);
  const tm = t0 + dt / 2;
  const tr = R + st.fs * 0.95;
  const cx = P[0] + tr * Math.cos(tm);
  const cy = P[1] + tr * Math.sin(tm) + st.fs * 0.35;
  const tw = textWidth(a.text, st.fs);
  return group(
    [
      polyLine(pts, st.thin),
      head(t0, -sg),
      head(t1, sg),
      rect(cx - tw / 2 - 0.5, cy - st.fs * 0.85, tw + 1, st.fs * 1.05, { fill: "#fff", stroke: "none" }),
      text(cx, cy, a.text, { "font-size": st.fs, "text-anchor": "middle", fill: "#000" }),
    ],
    { class: "angle" },
  );
}

type Block = { w: number; h: number; render: (x: number, y: number) => string };

/** Legend of the line types used on the drawing (ISO 128 conventions as applied here). */
function lineLegend(st: Style, hasGround: boolean, hasLumped = false): Block {
  const fs = st.fs * 0.85;
  const rowH = fs * 1.9;
  const sw = 12;
  const rows: { label: string; draw: (x: number, y: number) => string }[] = [
    { label: "Metal (PEC), visible outline", draw: (x, y) => rect(x, y - 1.2, sw, 2.4, { fill: METAL_FILL, stroke: "#000", "stroke-width": st.metal }) },
    { label: "Metal sheet seen edge-on", draw: (x, y) => rect(x, y - st.tmin / 2, sw, st.tmin, { fill: "#000", stroke: "none" }) },
    { label: "Dielectric, section hatching", draw: (x, y) => group([
      rect(x, y - 1.2, sw, 2.4, { fill: "#fff", stroke: "#000", "stroke-width": st.diel }),
      `<path d="${hatchRect([x, y - 1.2, x + sw, y + 1.2], 0.9, false)}" fill="none" stroke="#000" stroke-width="${n(st.hatch)}"/>`,
    ]) },
    { label: "Hidden edge", draw: (x, y) => line(x, y, x + sw, y, { stroke: "#000", "stroke-width": st.thin, "stroke-dasharray": st.hidden }) },
    { label: "Centre line / symmetry axis", draw: (x, y) => line(x, y, x + sw, y, { stroke: "#000", "stroke-width": st.thin, "stroke-dasharray": st.centre }) },
    { label: "Dimension line", draw: (x, y) => group([line(x, y, x + sw, y, { stroke: "#000", "stroke-width": st.thin }), arrowHead(x, y, -1, 0, st.arrow * 0.8), arrowHead(x + sw, y, 1, 0, st.arrow * 0.8)]) },
    { label: "Lumped port (source)", draw: (x, y) => portSymbol(x + sw / 2, y, st.portR, st.thin * 1.2) },
  ];
  if (hasLumped) rows.push({ label: "Lumped resistor", draw: (x, y) => group([
    rect(x + 1, y - 1.3, sw - 2, 2.6, { fill: "#fff", stroke: "#000", "stroke-width": st.thin * 1.2 }),
    `<path d="${zigzag(x + 1, y - 1.3, x + sw - 1, y + 1.3, "x")}" fill="none" stroke="#000" stroke-width="${n(st.thin * 1.2)}" stroke-linejoin="round"/>`,
  ]) });
  if (hasGround) rows.push({ label: "Infinite PEC ground (boundary)", draw: (x, y) => {
    const t: string[] = [];
    for (let k = 1.6; k <= sw; k += 1.6) t.push(`M${n(x + k)} ${n(y)}L${n(x + k - 1.4)} ${n(y + 1.6)}`);
    return group([line(x, y, x + sw, y, { stroke: "#000", "stroke-width": st.metal }), `<path d="${t.join("")}" fill="none" stroke="#000" stroke-width="${n(st.thin)}"/>`]);
  } });
  const w = sw + 3 + Math.max(...rows.map((r) => textWidth(r.label, fs))) + 1;
  const h = fs * 1.6 + rows.length * rowH;
  return {
    w,
    h,
    render: (x, y) =>
      group([
        text(x, y + fs, "LINE TYPES", { "font-size": fs, "font-weight": 600 }),
        ...rows.map((r, i) => {
          const cy = y + fs * 1.6 + rowH * (i + 0.5);
          return group([r.draw(x, cy), text(x + sw + 3, cy + fs * 0.35, r.label, { "font-size": fs })]);
        }),
      ], { class: "legend" }),
  };
}

/** Notes with the line-type legend beside (or below) them. */
function withLegend(nb: Block, lg: Block | null, maxW: number): Block {
  if (!lg) return nb;
  const gap = 6;
  if (nb.w + gap + lg.w <= maxW) {
    return { w: nb.w + gap + lg.w, h: Math.max(nb.h, lg.h), render: (x, y) => nb.render(x, y) + lg.render(x + nb.w + gap, y) };
  }
  return { w: Math.max(nb.w, lg.w), h: nb.h + 3 + lg.h, render: (x, y) => nb.render(x, y) + lg.render(x, y + nb.h + 3) };
}

const polyLine = (pts: Pt[], sw: number) => `<polyline points="${pts.map(([x, y]) => `${n(x)},${n(y)}`).join(" ")}" fill="none" stroke="#000" stroke-width="${n(sw)}"/>`;

// ------------------------------------------------------------------ isometric view

/** Model extent of the isometric projection (width, height). */
function isoExtent(ctx: Ctx): [number, number] {
  const all: Pt[] = [];
  ctx.iso.faces.forEach((f) => f.pts.forEach((p) => all.push(isoPt(p))));
  ctx.iso.lines.forEach((l) => all.push(isoPt(l.a), isoPt(l.b)));   // wires have no faces
  ctx.iso.ground?.forEach((p) => all.push(isoPt(p)));
  const bb = unionBox(all.map(([x, y]) => [x, y, x, y] as Box)) ?? [-1, -1, 1, 1];
  return [bb[2] - bb[0], bb[3] - bb[1]];
}

function buildIso(ctx: Ctx, s: number, main: number): Cell {
  const st = ctx.st;
  const iso = ctx.iso;
  const all: Pt[] = [];
  iso.faces.forEach((f) => f.pts.forEach((p) => all.push(isoPt(p))));
  iso.lines.forEach((l) => all.push(isoPt(l.a), isoPt(l.b)));
  iso.ground?.forEach((p) => all.push(isoPt(p)));
  ctx.b.ports.flatMap((p) => portFeedEntries(p, "")).forEach(([, p]) => all.push(...portLine(p).map(isoPt)));
  const bb = unionBox(all.map(([x, y]) => [x, y, x, y] as Box)) ?? [-1, -1, 1, 1];
  const pad = st.tmin;
  const X = (x: number) => pad + (x - bb[0]) * s;
  const Y = (y: number) => pad + (bb[3] - y) * s;
  const W = 2 * pad + (bb[2] - bb[0]) * s;
  const H = 2 * pad + (bb[3] - bb[1]) * s;
  const P = (p: [number, number, number]): Pt => {
    const [x, y] = isoPt(p);
    return [X(x), Y(y)];
  };
  const title = viewTitle(ctx, "iso", Math.abs(s - main) > 1e-9 && !ctx.figure ? `Isometric view (${scaleLabel(s)})` : "Isometric view");
  const triadW = 10;
  const titleW = triadW + textWidth(title, st.fsTitle, 600);

  const gl = iso.ground ? st.fsSmall + 1.5 : 0;
  const m = { t: 1, b: gl + 2 + 6 + 1, l: 0.5, r: 0.5 };
  const half = titleW / 2 - W / 2;
  m.l = Math.max(m.l, half);
  m.r = Math.max(m.r, half);
  const titleBase = H + gl + 2 + 6;
  const render = () => {
    const out: string[] = [];
    if (iso.ground) {
      const g = iso.ground.map(P);
      out.push(polygon(g, { fill: GROUND_FILL, stroke: "#000", "stroke-width": st.thin }));
      // label along the front-left edge of the ground plane
      out.push(text(g[1][0], g[1][1] + st.fsSmall + 1, "PEC ground (infinite)", { "font-size": st.fsSmall, fill: "#000", "text-anchor": "middle" }));
    }
    for (const f of iso.faces) {
      const pts = f.pts.map(P);
      const metal = f.role === "metal";
      const fill = metal ? METAL_FILL : "#fff";
      const sw = metal && !f.dense ? st.diel : st.thin;
      const dash = f.role === "approx" ? st.centre : undefined;
      if (f.stroke && !f.stroke.length) {
        out.push(polygon(pts, { fill, stroke: fill, "stroke-width": 0.05 }));
      } else {
        out.push(polygon(pts, { fill, stroke: "#000", "stroke-width": sw, "stroke-linejoin": "round", "stroke-dasharray": dash }));
      }
    }
    if (ctx.o.isoHidden) {
      // every edge dashed on top: where an edge is visible the solid outline underneath hides the
      // dashes, where it is hidden only the dashes remain
      const seen = new Set<string>();
      const d: string[] = [];
      for (const e of iso.edges) {
        const a = P(e.a);
        const c = P(e.b);
        const k = [a, c].map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).sort().join("|");
        if (seen.has(k) || Math.hypot(c[0] - a[0], c[1] - a[1]) < 0.05) continue;
        seen.add(k);
        d.push(`M${n(a[0])} ${n(a[1])}L${n(c[0])} ${n(c[1])}`);
      }
      out.push(`<path d="${d.join("")}" fill="none" stroke="#000" stroke-width="${n(st.hatch)}" stroke-dasharray="${st.hidden}"/>`);
    }
    for (const l of iso.lines) {
      const a = P(l.a);
      const b = P(l.b);
      out.push(line(a[0], a[1], b[0], b[1], { stroke: "#000", "stroke-width": l.role === "metal" ? st.diel : st.thin }));
    }
    for (const [, p] of ctx.b.ports.flatMap((p) => portFeedEntries(p, ""))) {
      const [a, b] = portLine(p).map(P);
      out.push(line(a[0], a[1], b[0], b[1], { stroke: "#000", "stroke-width": st.thin }));
      const c: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      out.push(portSymbol(c[0], c[1], st.portR * 0.85, st.thin * 1.2));
      out.push(text(c[0] + st.portR + 0.8, c[1] + st.fsSmall * 0.35, `P${p.number}`, { "font-size": st.fsSmall }));
    }
    for (const e of ctx.b.lumped_elements ?? []) out.push(lumpedIso(e, P, st));
    const tx = W / 2 - titleW / 2;
    const dirs = [0, 1, 2].map((k) => {
      const e: [number, number, number] = [0, 0, 0];
      e[k] = 1;
      const [x, y] = isoPt(e);
      const l = Math.hypot(x, y);
      return { d: [x / l, -y / l] as Pt, label: axisName(k as 0 | 1 | 2) };
    });
    out.push(triad(tx + 3.2, titleBase - 1.2, dirs, 3.4, st));
    out.push(text(tx + triadW, titleBase, title, { "font-size": st.fsTitle, "font-weight": 600 }));
    return group(out, { class: "view view-iso" });
  };
  return { W, H, m, render };
}

// ------------------------------------------------------------------ layout

interface Placed {
  cell: Cell;
  x: number;
  y: number;
}

const cellBox = (p: Placed): Box => [p.x - p.cell.m.l, p.y - p.cell.m.t, p.x + p.cell.W + p.cell.m.r, p.y + p.cell.H + p.cell.m.b];

function layoutAt(ctx: Ctx, s: number): { items: Placed[]; w: number; h: number } {
  const st = ctx.st;
  const rT = viewRange(ctx, "top");
  const rF = viewRange(ctx, "front");
  const rS = viewRange(ctx, "side");
  const xr: [number, number] = [Math.min(rT[0], rF[0]), Math.max(rT[2], rF[2])];
  const zr: [number, number] = [Math.min(rF[1], rS[1]), Math.max(rF[3], rS[3])];
  const top = buildOrtho(ctx, "top", s, xr, [rT[1], rT[3]]);
  const front = buildOrtho(ctx, "front", s, xr, zr);
  const side = buildOrtho(ctx, "side", s, [rS[0], rS[2]], zr);
  // the pictorial view is an aid, not a measuring view: shrink it to a standard scale (or, in
  // figure mode, proportionally) when it would dominate the orthographic views
  let iso: Cell | null = null;
  if (ctx.o.isometric) {
    const [iw, ih] = isoExtent(ctx);
    const ref = Math.max(front.W, front.H, top.W, top.H, side.H) * 0.9;
    let si = s;
    if (Math.max(iw, ih) * s > ref) {
      si = ctx.figure ? ref / Math.max(iw, ih) : SCALES.find((x) => x <= s && Math.max(iw, ih) * x <= ref) ?? s;
    }
    iso = buildIso(ctx, si, s);
  }
  const gap = st.gap;
  const cw = (c: Cell) => c.m.l + c.W + c.m.r;
  const ch = (c: Cell) => c.m.t + c.H + c.m.b;
  const L1 = Math.max(top.m.l, front.m.l);
  const R1 = Math.max(top.m.r, front.m.r);
  const col2x = L1 + top.W + R1 + gap;
  const col2w = Math.max(cw(side), iso ? cw(iso) : 0);
  const items: Placed[] = [];
  const isoX = iso ? col2x + (col2w - cw(iso)) / 2 + iso.m.l : 0;
  if (ctx.o.projection === "third") {
    const hA = Math.max(ch(top), iso ? ch(iso) : 0);
    const tB = Math.max(front.m.t, side.m.t);
    const yB = hA + gap + tB;
    items.push({ cell: top, x: L1, y: hA - top.m.b - top.H });
    if (iso) items.push({ cell: iso, x: isoX, y: hA - iso.m.b - iso.H });
    items.push({ cell: front, x: L1, y: yB });
    items.push({ cell: side, x: col2x + side.m.l, y: yB });
  } else {
    const tA = Math.max(front.m.t, side.m.t);
    const bA = Math.max(front.m.b, side.m.b);
    items.push({ cell: front, x: L1, y: tA });
    items.push({ cell: side, x: col2x + side.m.l, y: tA });
    const yB = tA + front.H + bA + gap;
    items.push({ cell: top, x: L1, y: yB + top.m.t });
    if (iso) items.push({ cell: iso, x: isoX, y: yB + iso.m.t });
  }
  const boxes = items.map(cellBox);
  const u = unionBox(boxes)!;
  for (const it of items) {
    it.x -= u[0];
    it.y -= u[1];
  }
  return { items, w: u[2] - u[0], h: u[3] - u[1] };
}

const SCALES = [20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01];

export function scaleLabel(s: number): string {
  if (s >= 1) return `${Number(s.toPrecision(3))}:1`;
  return `1:${Number((1 / s).toPrecision(3))}`;
}

function render(items: Placed[], dx: number, dy: number): string {
  return items.map((it) => group(it.cell.render(), { transform: `translate(${n(it.x + dx)} ${n(it.y + dy)})` })).join("");
}

function collectNotes(ctx: Ctx): string[] {
  const b = ctx.b;
  const notes = ["All dimensions in mm."];
  notes.push(...ctx.plan.notes);
  const sheets = b.parts.some((p) => p.type !== "Material" && p.primitives.some((q) => q.kind === "polygon" || (q.kind === "box" && q.start.some((x, i) => Math.abs(x - q.stop[i]) < 1e-9))));
  if (sheets) notes.push("Metal parts are PEC; zero-thickness sheets are drawn with a minimum line width (solid black when seen edge-on).");
  if (b.half_space) notes.push(`Infinite PEC ground plane at z = ${Number(b.half_space.position.toFixed(4))} mm (boundary condition, image theory), shown as a hatched ground line.`);
  const anyHidden = (Object.keys(ctx.shapes) as ViewId[]).some((id) => dashedShapes(ctx.shapes[id]).length > 0);
  if (anyHidden) notes.push("Dashed lines: metal hidden behind a dielectric.");
  if (b.parts.some((p) => p.primitives.some((q) => !q.exact))) notes.push("Dash-dotted outlines are bounding-box approximations (primitive not exported exactly).");
  for (const p of b.ports) {
    if (p.group) {
      const count = p.group.members.length + 1;
      const memberR = p.group.connection === "parallel" ? p.R * count : p.R / count;
      notes.push(`P${p.number}: ${count} ${p.group.connection} feeds, logical reference ${p.R} Ω, each physical feed ${memberR} Ω; polarities +1, ${p.group.members.map((m) => m.polarity ?? 1).join(", ")}.`);
      continue;
    }
    const d = p.stop.map((x, i) => Math.abs(x - p.start[i]));
    const len = Math.max(...d);
    if (p.type === "waveguide") {
      notes.push(`P${p.number}: ${p.mode ?? "TE"} waveguide port, ${Number((p.a ?? 0).toFixed(4))} × ${Number((p.b ?? 0).toFixed(4))} mm, along ${p.direction}, reference impedance Z_TE (${Number(p.R.toFixed(1))} Ω at the band centre)${p.excite ? ", excited" : ""}.`);
      continue;
    }
    notes.push(`P${p.number}: ${p.type} port, ${Number(p.R.toFixed(2))} Ω, along ${p.direction}, gap ${Number(len.toFixed(4))} mm${p.excite ? ", excited" : ""}.`);
  }
  for (const e of b.lumped_elements ?? []) notes.push(e.type === "resistor" && e.R !== undefined ? `${e.label || e.name}: ${Number(e.R.toFixed(2))} Ω ${e.type}, current along ${e.direction}.` : `${e.label || e.name}: ${lumpedLabel(e)}, current along ${e.direction}.`);
  return notes;
}

function today(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function technicalDrawing(bundle: Bundle, options: Partial<DrawingOptions> = {}): DrawingResult {
  const b = withoutVoids(bundle);
  const o: DrawingOptions = { ...DEFAULT_DRAWING_OPTIONS, ...options };
  const figure = o.sheet === "figure";
  const st = o.sheet === "A3" ? STYLE_07 : STYLE_05;
  const views = viewDefs(o.projection);
  const ids: ViewId[] = ["top", "front", "side"];
  const shapes = Object.fromEntries(ids.map((id) => [id, viewShapes(b, views[id])])) as Record<ViewId, Shape[]>;
  const ports = Object.fromEntries(ids.map((id) => [id, viewPorts(b, views[id])])) as Record<ViewId, PortView[]>;
  const letters =
    o.projection === "third"
      ? { top: "(a)", iso: "(b)", front: "(c)", side: "(d)" }
      : { front: "(a)", side: "(b)", top: "(c)", iso: "(d)" };
  if (!o.isometric) {
    if (o.projection === "third") Object.assign(letters, { front: "(b)", side: "(c)" });
    else Object.assign(letters, { top: "(c)" });
  }
  const plan = planDimensions(b, views);
  if (o.paramLabels ?? figure) {
    plan.dims.forEach((d) => (d.text = paramLabel(b, d.b - d.a, d.text, d.kind)));
    plan.angles.forEach((a) => (a.text = paramLabel(b, Number(a.deg.toFixed(3)), a.text, "angle")));
  }
  const ctx: Ctx = { b, o, st, figure, views, shapes, ports, plan, iso: isoModel(b), letters };
  const warnings: string[] = [];
  const notes = collectNotes(ctx);
  const dims = o.dimensions ? [...ctx.plan.dims.map((d) => d.text), ...ctx.plan.angles.map((a) => a.text)] : [];
  const dimKeys = o.dimensions ? [...ctx.plan.dims.map((d) => d.key), ...ctx.plan.angles.map((a) => `angle:${a.owner}`)] : [];
  const desc = `${b.name} (${b.model.id}) · Fairbeam ${b.generator.version} · ${o.projection}-angle projection`;

  if (figure) {
    const width = o.figureWidthMm;
    const margin = 2;
    const fits = (s: number) => {
      const L = layoutAt(ctx, s);
      return L.w <= width - 2 * margin && L.h <= width * 1.3;
    };
    let lo = 1e-4;
    let hi = 1e3;
    for (let i = 0; i < 40; i++) {
      const mid = Math.sqrt(lo * hi);
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    const s = lo;
    const L = layoutAt(ctx, s);
    const fs = st.fsSmall;
    const noteLines = notes.map((t) => t);
    const nb = withLegend(notesBlock(noteLines, width - 2 * margin, fs), o.legend ? lineLegend(st, !!b.half_space, !!b.lumped_elements?.length) : null, width - 2 * margin);
    const height = margin + L.h + 3 + nb.h + margin;
    const body = render(L.items, (width - L.w) / 2, margin) + nb.render(margin, margin + L.h + 3);
    return {
      svg: svgDoc(width, height, body, `${b.name} — technical drawing`, desc),
      widthMm: width, heightMm: height, scale: s, scaleLabel: scaleLabel(s), notes, warnings, dimensions: dims, dimensionKeys: dimKeys,
    };
  }

  const size = o.sheet as SheetSize;
  const sheet = SHEETS[size];
  const fr = frameRect(size);
  const tb = titleBlock(b, { size, projection: o.projection, date: o.date ?? today(), version: b.generator.version }, { fs: st.fs, thick: st.metal, thin: st.thin });
  const tbBox: Box = [fr[2] - tb.w, fr[3] - tb.h, fr[2], fr[3]];
  const leftW = fr[2] - fr[0] - tb.w - 8;
  const noteW = leftW >= 70 ? leftW : tb.w;
  const nb = withLegend(notesBlock(notes, noteW, st.fs * 0.9), o.legend ? lineLegend(st, !!b.half_space, !!b.lumped_elements?.length) : null, noteW);
  const inset = 4;
  let chosen: { s: number; items: Placed[]; dx: number; dy: number; nx: number; ny: number } | null = null;

  const placeNotes = (cells: Box[]): [number, number] | null => {
    let best: [number, number] | null = null;
    let bestScore = Infinity;
    for (let y = fr[3] - inset - nb.h; y >= fr[1] + inset; y -= 2) {
      for (let x = fr[0] + inset; x + nb.w <= fr[2] - inset; x += 2) {
        const r: Box = [x, y, x + nb.w, y + nb.h];
        if (boxesHit(r, tbBox, 3) || cells.some((c) => boxesHit(r, c, 3))) continue;
        const score = (x - fr[0]) + (fr[3] - (y + nb.h)) * 1.5;
        if (score < bestScore) {
          bestScore = score;
          best = [x, y];
        }
      }
    }
    return best;
  };

  for (const s of SCALES) {
    const L = layoutAt(ctx, s);
    if (L.w > fr[2] - fr[0] - 2 * inset || L.h > fr[3] - fr[1] - 2 * inset) continue;
    const target: Pt = [(fr[0] + fr[2]) / 2, (fr[1] + tbBox[1]) / 2];
    const cand: { dx: number; dy: number; score: number }[] = [];
    for (let dy = fr[1] + inset; dy + L.h <= fr[3] - inset; dy += 4) {
      for (let dx = fr[0] + inset; dx + L.w <= fr[2] - inset; dx += 4) {
        const cells = L.items.map((it) => {
          const c = cellBox(it);
          return [c[0] + dx, c[1] + dy, c[2] + dx, c[3] + dy] as Box;
        });
        if (cells.some((c) => boxesHit(c, tbBox, 3))) continue;
        cand.push({ dx, dy, score: Math.abs(dx + L.w / 2 - target[0]) + Math.abs(dy + L.h / 2 - target[1]) });
      }
    }
    cand.sort((a, c) => a.score - c.score);
    for (const c of cand.slice(0, 60)) {
      const cells = L.items.map((it) => {
        const q = cellBox(it);
        return [q[0] + c.dx, q[1] + c.dy, q[2] + c.dx, q[3] + c.dy] as Box;
      });
      const np = placeNotes(cells);
      if (np) {
        chosen = { s, items: L.items, dx: c.dx, dy: c.dy, nx: np[0], ny: np[1] };
        break;
      }
    }
    if (chosen) break;
  }
  if (!chosen) {
    const s = SCALES[SCALES.length - 1];
    const L = layoutAt(ctx, s);
    warnings.push("The views do not fit on this sheet; try a larger sheet or figure mode.");
    chosen = { s, items: L.items, dx: fr[0] + inset, dy: fr[1] + inset, nx: fr[0] + inset, ny: fr[3] - inset - nb.h };
  }
  const sl = scaleLabel(chosen.s);
  const body =
    frame(size, st.metal, st.thin) +
    render(chosen.items, chosen.dx, chosen.dy) +
    nb.render(chosen.nx, chosen.ny) +
    tb.render(tbBox[0], tbBox[1], sl);
  return {
    svg: svgDoc(sheet.w, sheet.h, body, `${b.name} — technical drawing`, `${desc} · scale ${sl} · ${size}`),
    widthMm: sheet.w, heightMm: sheet.h, scale: chosen.s, scaleLabel: sl, notes, warnings, dimensions: dims, dimensionKeys: dimKeys,
  };
}

