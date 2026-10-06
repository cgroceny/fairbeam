// Automatic dimensioning: which dimensions to show (planning, scale independent) and where to put
// them (placement, per scale). ISO 129 style: extension lines, filled 3:1 arrowheads, value above
// the dimension line, vertical values readable from the right.

import type { Bundle, Vec3 } from "../types";
import { featurePoints, roleOf, structureBox, type Shape, type ViewDef, type ViewId } from "./geometry.ts";
import { arrowHead, dimText, group, line, text, type Pt } from "./svg.ts";
import { textWidth } from "./metrics.ts";

export type Side = "top" | "bottom" | "left" | "right";

export interface DimSpec {
  view: ViewId;
  /** h: measures along the view's u axis; v: along v */
  orient: "h" | "v";
  /** measured interval in view coordinates, a < b */
  a: number;
  b: number;
  kind: "size" | "gap" | "offset";
  key: string;
  owner: string;
  /** part index for feature lookup, or -1 (ports: explicit extension origins) */
  part: number;
  /** explicit extension-line origins (perpendicular coordinate) at a and b, for ports/offsets */
  origin?: [number | null, number | null];
  side: Side;
  text: string;
}

/** Angular dimension at a polygon apex (model view coordinates, v up). */
export interface AngleSpec {
  view: ViewId;
  apex: Pt;
  /** unit directions of the two legs */
  da: Pt;
  db: Pt;
  /** leg lengths (model units) */
  la: number;
  lb: number;
  deg: number;
  owner: string;
  text: string;
}

export interface DimPlan {
  dims: DimSpec[];
  angles: AngleSpec[];
  notes: string[];
  /** axes (x, y, z) about which the structure is symmetric, with the centre coordinate */
  symmetric: [boolean, boolean, boolean];
  center: Vec3;
}

const EPS = 1e-6;
const r4 = (x: number) => (Math.round(x * 1e4) / 1e4).toFixed(4);

function viewFor(views: Record<ViewId, ViewDef>, depthAxis: number): ViewDef {
  return Object.values(views).find((v) => v.d.axis === depthAxis)!;
}

/** Where an axis appears in a view: "h" (u), "v" or null (depth). */
function orientIn(v: ViewDef, axis: number): "h" | "v" | null {
  return v.u.axis === axis ? "h" : v.v.axis === axis ? "v" : null;
}

function mapRange(v: ViewDef, axis: number, lo: number, hi: number): [number, number] {
  const m = v.u.axis === axis ? v.u : v.v;
  const a = lo * m.sign;
  const b = hi * m.sign;
  return a <= b ? [a, b] : [b, a];
}

/** A view that shows `axis` in-plane, preferring the front view (xz), then top, then side. */
function viewShowing(views: Record<ViewId, ViewDef>, axis: number, avoidDepth?: number): ViewDef {
  const order: ViewId[] = axis === 1 ? ["side", "top", "front"] : ["front", "top", "side"];
  for (const id of order) {
    const v = views[id];
    if (v.d.axis !== axis && v.d.axis !== avoidDepth) return v;
  }
  return views[order[0]];
}

export function planDimensions(b: Bundle, views: Record<ViewId, ViewDef>): DimPlan {
  const dims: DimSpec[] = [];
  const notes: string[] = [];
  const owners = new Map<string, string>();
  const [lo, hi] = structureBox(b);
  const center = lo.map((x, i) => Math.round(((x + hi[i]) / 2) * 1e6) / 1e6) as Vec3;
  const partsOnly = b.parts.filter((p) => p.primitives.length);
  const symmetric = [0, 1, 2].map(
    (i) => hi[i] - lo[i] > EPS && partsOnly.every((p) => Math.abs(p.bbox[0][i] + p.bbox[1][i] - 2 * center[i]) < 1e-4),
  ) as [boolean, boolean, boolean];
  const half = b.half_space;

  const sideFor = (v: ViewDef, orient: "h" | "v", kind: DimSpec["kind"]): Side => {
    // sizes below / right; offsets from the centre line above / left; with a ground line along
    // the bottom of the view, horizontal sizes move to the top as well
    const ground = !!half && v.id !== "top";
    if (orient === "h") return kind === "offset" || ground ? "top" : "bottom";
    return kind === "offset" ? "left" : "right";
  };

  const add = (spec: Omit<DimSpec, "side" | "text">, axis: number, from: number, to: number, side?: Side): boolean => {
    const key = `${axis}:${r4(Math.min(from, to))}:${r4(Math.max(from, to))}`;
    if (owners.has(key) || Math.abs(to - from) < EPS) return false;
    owners.set(key, spec.owner);
    dims.push({ ...spec, key, side: side ?? sideFor(views[spec.view], spec.orient, spec.kind), text: dimText(spec.b - spec.a) });
    return true;
  };

  // parts: dielectrics first so that a ground plane or a patch matching a substrate outline refers to it
  const order = b.parts
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.primitives.length)
    .sort((x, y) => rank(roleOf(x.p)) - rank(roleOf(y.p)) || x.i - y.i);
  for (const { p, i } of order) {
    const label = p.label ?? p.name;
    const bb = p.bbox;
    const ext = [0, 1, 2].map((k) => bb[1][k] - bb[0][k]);
    let thin: 0 | 1 | 2 = 2;
    for (const k of [1, 0] as const) if (ext[k] < ext[thin] - EPS) thin = k;
    const main = viewFor(views, thin);
    const tried: string[] = [];
    const dup: string[] = [];
    for (const k of [0, 1, 2] as const) {
      if (ext[k] < EPS) continue;
      const v = k === thin ? viewShowing(views, k) : main;
      const orient = orientIn(v, k);
      if (!orient) continue;
      const [a, c] = mapRange(v, k, bb[0][k], bb[1][k]);
      tried.push(dimText(ext[k]));
      const key = `${k}:${r4(bb[0][k])}:${r4(bb[1][k])}`;
      const prev = owners.get(key);
      if (!add({ view: v.id, orient, a, b: c, kind: "size", key, owner: label, part: i }, k, bb[0][k], bb[1][k]) && prev && prev !== label) {
        dup.push(prev);
      }
    }
    if (tried.length && dup.length === tried.length && dup.every((d) => d === dup[0])) {
      notes.push(`${label} = ${dup[0]} outline (${tried.join(" × ")}).`);
    }
  }

  // notches / slots and feed tabs of rectilinear parts (in the view that shows them face-on)
  for (const { p, i } of order) planFeatures(views, p, i, add);

  // ports: feed gap along the port direction, and the feed offset from the centre (or the edge)
  for (const port of b.ports) {
    if (port.type === "waveguide") continue;   // no feed gap: the guide itself is dimensioned
    const dirAxis = ({ x: 0, y: 1, z: 2 } as Record<string, number>)[port.direction] ?? -1;
    const d = [0, 1, 2].map((k) => port.stop[k] - port.start[k]);
    const k = dirAxis >= 0 && Math.abs(d[dirAxis]) > EPS ? dirAxis : d.findIndex((x) => Math.abs(x) > EPS);
    const owner = `P${port.number}`;
    const mid = port.start.map((x, i) => (x + port.stop[i]) / 2);
    if (k >= 0) {
      const v = viewShowing(views, k);
      const orient = orientIn(v, k);
      if (orient) {
        const [a, c] = mapRange(v, k, port.start[k], port.stop[k]);
        const other = orient === "h" ? v.v : v.u;
        const o = mid[other.axis] * other.sign;
        add({ view: v.id, orient, a, b: c, kind: "gap", key: "", owner, part: -1, origin: [o, o] }, k, Math.min(port.start[k], port.stop[k]), Math.max(port.start[k], port.stop[k]));
      }
    }
    const pointView = k >= 0 ? viewFor(views, k) : views.top;
    for (const i of [0, 1, 2] as const) {
      if (i === k) continue;
      const p = mid[i];
      const ref = symmetric[i] ? center[i] : lo[i];
      if (Math.abs(p - ref) < EPS) continue;
      const v = pointView.d.axis !== i ? pointView : viewShowing(views, i, k);
      const orient = orientIn(v, i);
      if (!orient) continue;
      const [a, c] = mapRange(v, i, Math.min(p, ref), Math.max(p, ref));
      const other = orient === "h" ? v.v : v.u;
      const po = mid[other.axis] * other.sign;
      const pAt = p * (orient === "h" ? v.u.sign : v.v.sign);
      // extension origin: the port point on its side; the centre line (or edge) has no single origin
      const origin: [number | null, number | null] = Math.abs(a - pAt) < EPS ? [po, null] : [null, po];
      add({ view: v.id, orient, a, b: c, kind: "offset", key: "", owner, part: -1, origin }, i, Math.min(p, ref), Math.max(p, ref));
    }
  }
  // clearance between an infinite ground plane and the lowest point of each part
  if (half) {
    const g = half.position;
    for (const { p, i } of order) {
      const z0 = p.bbox[0][2];
      if (z0 - g < EPS) continue;
      const v = views.front;
      const [a, c] = mapRange(v, 2, g, z0);
      add({ view: "front", orient: "v", a, b: c, kind: "gap", key: "", owner: p.label ?? p.name, part: i, origin: [null, null] }, 2, g, z0);
    }
  }
  const angles = planAngles(b, views);
  return { dims, angles, notes, symmetric, center };
}


// ------------------------------------------------------------------ features of rectilinear parts

type AddFn = (spec: Omit<DimSpec, "side" | "text">, axis: number, from: number, to: number, side?: Side) => boolean;

/**
 * Pockets (notches, inset slots: empty regions enclosed by the part on three sides) and tabs
 * (feed lines: a thin strip reaching the part's bounding box edge) of a part whose outline is
 * axis-aligned in its face-on view. Each distinct pocket size is dimensioned once (width at the
 * opening, depth), each tab by its width and length plus the remaining body length.
 */
function planFeatures(views: Record<ViewId, ViewDef>, part: Bundle["parts"][number], pi: number, add: AddFn) {
  const bb = part.bbox;
  const ext = [0, 1, 2].map((k) => bb[1][k] - bb[0][k]);
  let thin: 0 | 1 | 2 = 2;
  for (const k of [1, 0] as const) if (ext[k] < ext[thin] - EPS) thin = k;
  const v = viewFor(views, thin);
  const owner = part.label ?? part.name;
  // outlines in view coordinates
  const polys: Pt[][] = [];
  for (const q of part.primitives) {
    if (q.kind === "box") {
      const a: Pt = [q.start[v.u.axis] * v.u.sign, q.start[v.v.axis] * v.v.sign];
      const c: Pt = [q.stop[v.u.axis] * v.u.sign, q.stop[v.v.axis] * v.v.sign];
      polys.push([a, [c[0], a[1]], c, [a[0], c[1]]]);
    } else if ((q.kind === "polygon" || q.kind === "linpoly") && q.normal === thin) {
      polys.push(q.points.map((pt) => {
        const p3: Vec3 = [0, 0, 0];
        p3[q.normal] = q.elevation;
        p3[(q.normal + 1) % 3] = pt[0];
        p3[(q.normal + 2) % 3] = pt[1];
        return [p3[v.u.axis] * v.u.sign, p3[v.v.axis] * v.v.sign] as Pt;
      }));
    } else return;
  }
  // rectilinear only
  for (const pl of polys) for (let j = 0; j < pl.length; j++) {
    const a = pl[j];
    const c = pl[(j + 1) % pl.length];
    if (Math.abs(a[0] - c[0]) > 1e-6 && Math.abs(a[1] - c[1]) > 1e-6) return;
  }
  const uniq = (xs: number[]) => [...new Set(xs.map((x) => Math.round(x * 1e6) / 1e6))].sort((x, y) => x - y);
  const us = uniq(polys.flat().map((q) => q[0]));
  const vs = uniq(polys.flat().map((q) => q[1]));
  const nu = us.length - 1;
  const nv = vs.length - 1;
  if (nu < 2 || nv < 2 || nu * nv > 40000) return;
  const inside = (x: number, y: number, poly: Pt[]) => {
    let c = false;
    for (let a = 0, z = poly.length - 1; a < poly.length; z = a++) {
      const [xi, yi] = poly[a];
      const [xj, yj] = poly[z];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const filled: boolean[][] = [];
  for (let a = 0; a < nu; a++) {
    filled.push([]);
    for (let c = 0; c < nv; c++) {
      const x = (us[a] + us[a + 1]) / 2;
      const y = (vs[c] + vs[c + 1]) / 2;
      filled[a].push(polys.some((pl) => inside(x, y, pl)));
    }
  }
  const U0 = us[0], U1 = us[nu], V0 = vs[0], V1 = vs[nv];
  const mapU = (x: number) => [x * v.u.sign, v.u.axis] as const; // view u -> 3D value, axis
  const mapV = (y: number) => [y * v.v.sign, v.v.axis] as const;
  const addU = (a: number, c: number, side: Side, origin: [number | null, number | null]) => {
    const [fa, ax] = mapU(a);
    const [fc] = mapU(c);
    return add({ view: v.id, orient: "h", a: Math.min(a, c), b: Math.max(a, c), kind: "size", key: "", owner, part: pi, origin }, ax, Math.min(fa, fc), Math.max(fa, fc), side);
  };
  const addV = (a: number, c: number, side: Side, origin: [number | null, number | null]) => {
    const [fa, ax] = mapV(a);
    const [fc] = mapV(c);
    return add({ view: v.id, orient: "v", a: Math.min(a, c), b: Math.max(a, c), kind: "size", key: "", owner, part: pi, origin }, ax, Math.min(fa, fc), Math.max(fa, fc), side);
  };

  // --- pockets
  const hit = (a: number, c: number, da: number, dc: number) => {
    for (let x = a + da, y = c + dc; x >= 0 && x < nu && y >= 0 && y < nv; x += da, y += dc) if (filled[x][y]) return true;
    return false;
  };
  const open: (string | null)[][] = filled.map((col, a) => col.map((f, c) => {
    if (f) return null;
    const sides = { left: hit(a, c, -1, 0), right: hit(a, c, 1, 0), bottom: hit(a, c, 0, -1), top: hit(a, c, 0, 1) };
    const missing = (Object.keys(sides) as (keyof typeof sides)[]).filter((k) => !sides[k]);
    return missing.length === 1 ? missing[0] : null;
  }));
  const seen = filled.map((col) => col.map(() => false));
  const sizes = new Set<string>();
  for (let a = 0; a < nu; a++) for (let c = 0; c < nv; c++) {
    const side = open[a][c];
    if (!side || seen[a][c]) continue;
    // flood fill cells with the same opening side
    const stack: [number, number][] = [[a, c]];
    seen[a][c] = true;
    let ua = a, ub = a, va = c, vb = c;
    while (stack.length) {
      const [x, y] = stack.pop()!;
      ua = Math.min(ua, x); ub = Math.max(ub, x); va = Math.min(va, y); vb = Math.max(vb, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && X < nu && Y >= 0 && Y < nv && !seen[X][Y] && open[X][Y] === side) {
          seen[X][Y] = true;
          stack.push([X, Y]);
        }
      }
    }
    const pu0 = us[ua], pu1 = us[ub + 1], pv0 = vs[va], pv1 = vs[vb + 1];
    const horizOpen = side === "top" || side === "bottom";
    const width = horizOpen ? pu1 - pu0 : pv1 - pv0;
    const depth = horizOpen ? pv1 - pv0 : pu1 - pu0;
    const sig = `${width.toFixed(4)}x${depth.toFixed(4)}`;
    if (sizes.has(sig)) continue;
    sizes.add(sig);
    if (horizOpen) {
      const edge = side === "bottom" ? pv0 : pv1;
      addU(pu0, pu1, side as Side, [edge, edge]);
      const s: Side = (pu0 + pu1) / 2 >= (U0 + U1) / 2 ? "right" : "left";
      const o = s === "right" ? pu1 : pu0;
      addV(pv0, pv1, s, [o, o]);
    } else {
      const edge = side === "left" ? pu0 : pu1;
      addV(pv0, pv1, side as Side, [edge, edge]);
      const s: Side = (pv0 + pv1) / 2 >= (V0 + V1) / 2 ? "top" : "bottom";
      const o = s === "top" ? pv1 : pv0;
      addU(pu0, pu1, s, [o, o]);
    }
  }

  // --- tabs (thin strips reaching the bounding box edge along u or along v)
  for (const along of ["u", "v"] as const) {
    const n1 = along === "u" ? nu : nv;
    const n2 = along === "u" ? nv : nu;
    const cellAt = (i: number, j: number) => (along === "u" ? filled[i][j] : filled[j][i]);
    const across = along === "u" ? vs : us;
    const extentAcross = across[n2] - across[0];
    const interval = (i: number): [number, number] | null => {
      let s0 = -1, s1 = -1, runs = 0;
      for (let j = 0; j < n2; j++) {
        if (cellAt(i, j) && (j === 0 || !cellAt(i, j - 1))) runs++;
        if (cellAt(i, j)) {
          if (s0 < 0) s0 = j;
          s1 = j;
        }
      }
      return runs === 1 ? [s0, s1] : null;
    };
    for (const fromStart of [true, false]) {
      const first = fromStart ? 0 : n1 - 1;
      const iv = interval(first);
      if (!iv) continue;
      const w = across[iv[1] + 1] - across[iv[0]];
      if (w > 0.5 * extentAcross) continue;
      let last = first;
      for (let i = first; fromStart ? i < n1 : i >= 0; i += fromStart ? 1 : -1) {
        const x = interval(i);
        if (!x || x[0] !== iv[0] || x[1] !== iv[1]) break;
        last = i;
      }
      if ((fromStart ? last : first - last) >= n1 - 1) continue; // the whole part is the strip
      const coords = along === "u" ? us : vs;
      const t0 = fromStart ? coords[0] : coords[last];
      const t1 = fromStart ? coords[last + 1] : coords[n1];
      const a0 = across[iv[0]], a1 = across[iv[1] + 1];
      if (along === "u") {
        const endSide: Side = fromStart ? "left" : "right";
        const endU = fromStart ? U0 : U1;
        addV(a0, a1, endSide, [endU, endU]);
        addU(t0, t1, "bottom", [a0, a0]);
        addU(fromStart ? t1 : U0, fromStart ? U1 : t0, "bottom", [null, null]);
      } else {
        const endSide: Side = fromStart ? "bottom" : "top";
        const endV = fromStart ? V0 : V1;
        addU(a0, a1, endSide, [endV, endV]);
        addV(t0, t1, "right", [a1, a1]);
        addV(fromStart ? t1 : V0, fromStart ? V1 : t0, "right", [null, null]);
      }
    }
  }
}

// ------------------------------------------------------------------ angles

function hull(points: Pt[]): Pt[] {
  const pts = [...new Map(points.map((p) => [`${p[0].toFixed(6)},${p[1].toFixed(6)}`, p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  // relative tolerance: nearly collinear points (6-decimal geometry) are not hull vertices
  const span = Math.hypot(pts[pts.length - 1][0] - pts[0][0], Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])));
  const tol = 1e-6 * span * span;
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= tol) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= tol) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]; // counter-clockwise
}

function intersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | null {
  const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / d;
  return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
}

/**
 * Outline of a part as a simplified convex hull: short hull edges (feed tabs, bridges, rounding)
 * collapse into the intersection of their neighbouring long edges, so a fractal gasket reads as
 * its outer triangle.
 */
export function simplifiedHull(points: Pt[]): Pt[] {
  let h = hull(points);
  if (h.length < 3) return h;
  let diam = 0;
  for (const a of h) for (const c of h) diam = Math.max(diam, Math.hypot(a[0] - c[0], a[1] - c[1]));
  for (let guard = 0; guard < 64 && h.length > 3; guard++) {
    const n = h.length;
    let k = -1;
    let best = 0.05 * diam;
    for (let i = 0; i < n; i++) {
      const l = Math.hypot(h[(i + 1) % n][0] - h[i][0], h[(i + 1) % n][1] - h[i][1]);
      if (l < best) {
        best = l;
        k = i;
      }
    }
    if (k < 0) break;
    const a = h[(k - 1 + n) % n];
    const p = h[k];
    const q = h[(k + 1) % n];
    const c = h[(k + 2) % n];
    const x = intersect(a, p, q, c) ?? [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const next = h.filter((_, i) => i !== k && i !== (k + 1) % n);
    next.splice(k < (k + 1) % n ? k : 0, 0, x as Pt);
    h = hull(next);
  }
  return h;
}

/** Interior angles (degrees) of a convex counter-clockwise polygon. */
function interiorAngles(h: Pt[]): number[] {
  return h.map((p, i) => {
    const a = h[(i - 1 + h.length) % h.length];
    const c = h[(i + 1) % h.length];
    const u = [a[0] - p[0], a[1] - p[1]];
    const w = [c[0] - p[0], c[1] - p[1]];
    const cos = (u[0] * w[0] + u[1] * w[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(w[0], w[1]));
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  });
}

/**
 * One angular dimension per polygon part with a clear apex, in the view that shows the polygon
 * face-on: the hull vertex at the feed if a port touches it, else a uniquely sharpest vertex.
 */
function planAngles(b: Bundle, views: Record<ViewId, ViewDef>): AngleSpec[] {
  const out: AngleSpec[] = [];
  b.parts.forEach((part) => {
    const polys = part.primitives.filter((q) => q.kind === "polygon" || q.kind === "linpoly");
    if (!polys.length || polys.length !== part.primitives.length) return;
    const n0 = (polys[0] as { normal: 0 | 1 | 2 }).normal;
    if (!polys.every((q) => (q as { normal: number }).normal === n0)) return;
    const v = viewFor(views, n0);
    const pts: Pt[] = [];
    // small helper pieces (feed tabs, contact bridges) do not define the outline
    const area = (q: { points: [number, number][] }) =>
      Math.abs(q.points.reduce((s, [a0, b0], i) => {
        const [a1, b1] = q.points[(i + 1) % q.points.length];
        return s + a0 * b1 - a1 * b0;
      }, 0)) / 2;
    const areas = polys.map((q) => area(q as { points: [number, number][] }));
    const big = Math.max(...areas);
    for (const q of polys.filter((_, i) => areas[i] >= 0.25 * big)) {
      const pq = q as { normal: 0 | 1 | 2; elevation: number; points: [number, number][] };
      for (const pt of pq.points) {
        const p3: Vec3 = [0, 0, 0];
        p3[pq.normal] = pq.elevation;
        p3[(pq.normal + 1) % 3] = pt[0];
        p3[(pq.normal + 2) % 3] = pt[1];
        pts.push([p3[v.u.axis] * v.u.sign, p3[v.v.axis] * v.v.sign]);
      }
    }
    const h = simplifiedHull(pts);
    if (h.length < 3 || h.length > 8) return;
    const ang = interiorAngles(h);
    let diam = 0;
    for (const a of h) for (const c of h) diam = Math.max(diam, Math.hypot(a[0] - c[0], a[1] - c[1]));
    let k = -1;
    // a port at a vertex marks the feed apex
    for (const port of b.ports) {
      for (const e of [port.start, port.stop]) {
        const pu: Pt = [e[v.u.axis] * v.u.sign, e[v.v.axis] * v.v.sign];
        h.forEach((q, i) => {
          if (Math.hypot(q[0] - pu[0], q[1] - pu[1]) < 0.08 * diam && ang[i] < 150) k = i;
        });
      }
    }
    if (k < 0) {
      const order = ang.map((a, i) => [a, i]).sort((x, y) => x[0] - y[0]);
      if (order[0][0] < 110 && (order.length < 2 || order[1][0] - order[0][0] > 5)) k = order[0][1];
    }
    if (k < 0) return;
    const p = h[k];
    const a = h[(k - 1 + h.length) % h.length];
    const c = h[(k + 1) % h.length];
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const lb = Math.hypot(c[0] - p[0], c[1] - p[1]);
    const deg = ang[k];
    out.push({
      view: v.id, apex: p, da: [(a[0] - p[0]) / la, (a[1] - p[1]) / la], db: [(c[0] - p[0]) / lb, (c[1] - p[1]) / lb],
      la, lb, deg, owner: part.label ?? part.name, text: `${Number(deg.toFixed(deg < 10 ? 2 : 1))}°`,
    });
  });
  return out;
}

// ------------------------------------------------------------------ parametric labels

/**
 * "key = value" when a dimension equals exactly one model parameter (mm for lengths, deg for
 * angles). Offsets match |value| and read "|key| = value".
 */
export function paramLabel(b: Bundle, value: number, text: string, kind: DimSpec["kind"] | "angle"): string {
  const unit = kind === "angle" ? /^(deg|°)$/i : /^mm$/i;
  const hits = b.model.params.filter((p) => typeof p.value === "number" && unit.test(p.unit) && Math.abs(Math.abs(p.value) - value) < 5e-4 * Math.max(1, value));
  const exact = hits.filter((p) => Math.abs((p.value as number) - value) < 5e-4 * Math.max(1, value));
  if (exact.length === 1) return `${exact[0].key} = ${text}`;
  if (!exact.length && hits.length === 1 && kind === "offset") return `|${hits[0].key}| = ${text}`;
  return text;
}

const rank = (r: string) => (r === "dielectric" ? 0 : r === "metal" ? 1 : 2);

// ------------------------------------------------------------------ placement

export interface DimStyle {
  fs: number;
  thin: number;
  arrow: number;
  base: number;
  step: number;
  extGap: number;
  extOver: number;
}

export interface Placed {
  spec: DimSpec;
  side: Side;
  tier: number;
  /** along-axis paper coordinates of the two ends */
  pa: number;
  pb: number;
  /** extension line origins (perpendicular paper coordinate) */
  oa: number;
  ob: number;
  inside: boolean;
  textInside: boolean;
  tw: number;
  /** paper coordinate of the dimension line (set by layoutSides) */
  at: number;
}

export interface Mapper {
  X: (u: number) => number;
  Y: (v: number) => number;
}

/** Perpendicular origin for an extension line at coordinate `c` on `side`. */
function extensionOrigin(spec: DimSpec, end: 0 | 1, shapes: Shape[], side: Side): number | null {
  if (spec.origin && spec.origin[end] !== null) return spec.origin[end];
  if (spec.part < 0) return null;
  const c = end === 0 ? spec.a : spec.b;
  const pts: Pt[] = featurePoints(shapes, spec.part);
  const idx = spec.orient === "h" ? 0 : 1;
  const perp = spec.orient === "h" ? 1 : 0;
  const near = pts.filter((p) => Math.abs(p[idx] - c) < 1e-6).map((p) => p[perp]);
  const vals = near.length ? near : pts.map((p) => p[perp]);
  if (!vals.length) return null;
  // bottom/left take the minimum coordinate, top/right the maximum (in view coordinates, v up)
  return side === "bottom" || side === "left" ? Math.min(...vals) : Math.max(...vals);
}

export interface SideLayout {
  placed: Placed[];
  /** margin needed beyond the object box on each side */
  margin: Record<Side, number>;
}

/**
 * Stack dimensions on each side of a view. `obj` is the object box in paper coordinates
 * [x0, y0, x1, y1] (y down) beyond which dimension lines start.
 */
export function layoutSides(specs: DimSpec[], shapes: Shape[], map: Mapper, obj: [number, number, number, number], st: DimStyle): SideLayout {
  const margin: Record<Side, number> = { top: 0, bottom: 0, left: 0, right: 0 };
  const placed: Placed[] = [];
  for (const side of ["top", "bottom", "left", "right"] as Side[]) {
    const list = specs.filter((d) => d.side === side);
    if (!list.length) continue;
    const items = list.map((spec) => {
      const horiz = spec.orient === "h";
      const pa = horiz ? map.X(spec.a) : map.Y(spec.a);
      const pb = horiz ? map.X(spec.b) : map.Y(spec.b);
      const lo = Math.min(pa, pb);
      const hi = Math.max(pa, pb);
      const span = hi - lo;
      const tw = textWidth(spec.text, st.fs);
      const inside = span >= 2 * st.arrow + 0.8;
      const textInside = tw + 2 <= span;
      const perpMap = horiz ? map.Y : map.X;
      const fallback = side === "top" ? obj[1] : side === "bottom" ? obj[3] : side === "left" ? obj[0] : obj[2];
      const o = (end: 0 | 1) => {
        const val = extensionOrigin(spec, end, shapes, side);
        return val === null ? fallback : perpMap(val);
      };
      const oA = o(0);
      const oB = o(1);
      const [oLo, oHi] = pa <= pb ? [oA, oB] : [oB, oA];
      const p: Placed = { spec, side, tier: 0, pa: lo, pb: hi, oa: oLo, ob: oHi, inside, textInside, tw, at: 0 };
      return p;
    });
    // occupied interval along the side, including outside arrows / text
    const extent = (p: Placed): [number, number] => {
      const out = p.inside ? 0.6 : st.arrow + 1.2;
      // vertical dims put outside text above the top end (smaller y)
      const horiz = p.spec.orient === "h";
      const txt = p.textInside ? 0 : p.tw + 1.5;
      return horiz ? [p.pa - out, p.pb + out + txt] : [p.pa - out - txt, p.pb + out];
    };
    items.sort((x, y) => x.pb - x.pa - (y.pb - y.pa));
    const tiers: [number, number][][] = [];
    for (const it of items) {
      const [e0, e1] = extent(it);
      let t = 0;
      while (tiers[t]?.some(([a, b]) => e0 < b + 1.2 && e1 > a - 1.2)) t++;
      (tiers[t] ??= []).push([e0, e1]);
      it.tier = t;
      placed.push(it);
    }
    const n = tiers.length;
    const reach = st.base + (n - 1) * st.step;
    for (const it of items) {
      const off = st.base + it.tier * st.step;
      it.at = side === "top" ? obj[1] - off : side === "bottom" ? obj[3] + off : side === "left" ? obj[0] - off : obj[2] + off;
    }
    const textOut = side === "top" || side === "left" ? st.fs + 1 : st.arrow / 3 + 0.8;
    margin[side] = Math.max(margin[side], reach + textOut);
    // outside arrows / values can run past the ends of the object box: reserve that too
    for (const it of items) {
      const [e0, e1] = extent(it);
      if (side === "left" || side === "right") {
        margin.top = Math.max(margin.top, obj[1] - e0);
        margin.bottom = Math.max(margin.bottom, e1 - obj[3]);
      } else {
        margin.left = Math.max(margin.left, obj[0] - e0);
        margin.right = Math.max(margin.right, e1 - obj[2]);
      }
    }
  }
  return { placed, margin };
}

/** Render placed dimensions (paper coordinates). */
export function renderDims(placed: Placed[], st: DimStyle): string {
  const lines: string[] = [];
  const heads: string[] = [];
  const texts: string[] = [];
  for (const p of placed) {
    const horiz = p.spec.orient === "h";
    const at = p.at;
    const sgn = p.side === "top" || p.side === "left" ? -1 : 1; // direction away from the object
    // extension lines
    for (const [c, o] of [[p.pa, p.oa], [p.pb, p.ob]] as const) {
      const start = o + sgn * st.extGap;
      const end = at + sgn * st.extOver;
      if ((end - start) * sgn <= 0) continue;
      lines.push(horiz ? line(c, start, c, end) : line(start, c, end, c));
    }
    // dimension line + arrowheads
    const al = st.arrow;
    let l0 = p.pa;
    let l1 = p.pb;
    if (!p.inside) {
      l0 -= al + 1.5;
      l1 += al + 1.5;
    }
    if (!p.textInside) {
      if (horiz) l1 = Math.max(l1, p.pb + (p.inside ? 0 : al) + 1.5 + p.tw);
      else l0 = Math.min(l0, p.pa - (p.inside ? 0 : al) - 1.5 - p.tw);
    }
    lines.push(horiz ? line(l0, at, l1, at) : line(at, l0, at, l1));
    const dir = p.inside ? 1 : -1;
    if (horiz) {
      heads.push(arrowHead(p.pa, at, -dir, 0, al), arrowHead(p.pb, at, dir, 0, al));
    } else {
      heads.push(arrowHead(at, p.pa, 0, -dir, al), arrowHead(at, p.pb, 0, dir, al));
    }
    // value: above horizontal lines; left of vertical lines, rotated to read from the right
    const gap = 0.7;
    if (horiz) {
      const x = p.textInside ? (p.pa + p.pb) / 2 : p.pb + (p.inside ? 0 : al) + 1.5 + p.tw / 2;
      texts.push(text(x, at - gap, p.spec.text, { "text-anchor": "middle" }));
    } else {
      const y = p.textInside ? (p.pa + p.pb) / 2 : p.pa - (p.inside ? 0 : al) - 1.5 - p.tw / 2;
      const x = at - gap;
      texts.push(text(x, y, p.spec.text, { "text-anchor": "middle", transform: `rotate(-90 ${round(x)} ${round(y)})` }));
    }
  }
  return group(
    [
      group(lines, { stroke: "#000", "stroke-width": st.thin, fill: "none" }),
      group(heads),
      group(texts, { fill: "#000", "font-size": st.fs, stroke: "none" }),
    ],
    { class: "dimensions" },
  );
}

const round = (v: number) => Math.round(v * 1000) / 1000;
