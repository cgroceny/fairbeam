// Orthographic projection of the bundle's exact primitives into 2D view shapes (model units, v up).

import type { Bundle, Matrix4Rows, Part, Primitive, Vec3 } from "../types";
import type { Pt } from "./svg.ts";
import { portFeedEntries } from "../lib/portGroups.ts";

export type ViewId = "top" | "front" | "side";
export type Projection = "third" | "first";

export interface AxisMap {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
}

export interface ViewDef {
  id: ViewId;
  title: string;
  /** horizontal drawing axis (u), vertical drawing axis (v, up) and depth (towards the viewer) */
  u: AxisMap;
  v: AxisMap;
  d: AxisMap;
}

const AX = ["x", "y", "z"] as const;
export const axisName = (a: 0 | 1 | 2) => AX[a];

/** The three principal views. Third angle uses the right-hand view (seen from +x), first angle the
 * left-hand view (seen from -x), each placed on the right of the front view. */
export function viewDefs(projection: Projection): Record<ViewId, ViewDef> {
  return {
    top: { id: "top", title: "Top view", u: { axis: 0, sign: 1 }, v: { axis: 1, sign: 1 }, d: { axis: 2, sign: 1 } },
    front: { id: "front", title: "Front view", u: { axis: 0, sign: 1 }, v: { axis: 2, sign: 1 }, d: { axis: 1, sign: -1 } },
    side:
      projection === "third"
        ? { id: "side", title: "Right view", u: { axis: 1, sign: 1 }, v: { axis: 2, sign: 1 }, d: { axis: 0, sign: 1 } }
        : { id: "side", title: "Left view", u: { axis: 1, sign: -1 }, v: { axis: 2, sign: 1 }, d: { axis: 0, sign: -1 } },
  };
}

export function planeLabel(v: ViewDef): string {
  const s = (m: AxisMap) => (m.sign < 0 ? "−" : "") + AX[m.axis];
  return `${s(v.u)}${s(v.v)}`.replace(/^([a-z])([a-z])$/, "$1$2");
}

export type Role = "metal" | "dielectric" | "other" | "approx";

export function roleOf(part: Part): Role {
  if (part.type === "Metal" || part.type === "ConductingSheet" || part.conductor) return "metal";
  if (part.type === "Material") return "dielectric";
  return "other";
}

export interface Shape {
  part: number;
  prim: number;
  role: Role;
  /** poly: closed ring; edge: zero-thickness sheet seen edge-on (2-point segment); circle */
  kind: "poly" | "edge" | "circle";
  pts: Pt[];
  c?: Pt;
  r?: number;
  /** circle with a hole: a tube seen along its axis */
  ri?: number;
  depth: [number, number];
  hatch: boolean;
  /** further visible edges inside the outline (extruded-polygon vertex lines) */
  inner: [Pt, Pt][];
  /** axis of a cylinder seen from the side, drawn as a centre line */
  axisLine?: [Pt, Pt];
  bbox: [number, number, number, number];
}

const EPS = 1e-9;

export const mapPt = (p: Vec3, m: AxisMap) => p[m.axis] * m.sign;
export const toUV = (p: Vec3, v: ViewDef): Pt => [mapPt(p, v.u), mapPt(p, v.v)];

/** Apply a row-major homogeneous transform to one local point. */
export function affinePoint(matrix: Matrix4Rows, p: Vec3): Vec3 {
  return [0, 1, 2].map((r) => matrix[r][0] * p[0] + matrix[r][1] * p[1] + matrix[r][2] * p[2] + matrix[r][3]) as Vec3;
}

function bboxOf(pts: Pt[]): [number, number, number, number] {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [u, v] of pts) {
    a = Math.min(a, u);
    b = Math.min(b, v);
    c = Math.max(c, u);
    d = Math.max(d, v);
  }
  return [a, b, c, d];
}

const range = (a: number, b: number): [number, number] => (a <= b ? [a, b] : [b, a]);

/** 3D point of an in-plane polygon vertex (CSXCAD convention: [a, b] -> axes (n+1)%3, (n+2)%3). */
export function polyPoint3(n: 0 | 1 | 2, elevation: number, [a, b]: [number, number]): Vec3 {
  const p: Vec3 = [0, 0, 0];
  p[n] = elevation;
  p[(n + 1) % 3] = a;
  p[(n + 2) % 3] = b;
  return p;
}

/** Convex hull (Andrew's monotone chain), counter-clockwise. */
function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Pt[]) => {
    const h: Pt[] = [];
    for (const q of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 1e-12) h.pop();
      h.push(q);
    }
    return h;
  };
  const lower = half(p);
  const upper = half([...p].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function projectedRing(base: Omit<Shape, "kind" | "pts" | "bbox" | "inner">, world: Vec3[], v: ViewDef, hatch = false): Shape | null {
  const pts = world.map((p) => toUV(p, v));
  const clean = pts.filter((p, i) => !i || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > EPS);
  if (clean.length > 2 && Math.hypot(clean[0][0] - clean.at(-1)![0], clean[0][1] - clean.at(-1)![1]) <= EPS) clean.pop();
  if (clean.length < 2) return null;
  const area = clean.length > 2 ? clean.reduce((s, p, i) => s + p[0] * clean[(i + 1) % clean.length][1] - p[1] * clean[(i + 1) % clean.length][0], 0) : 0;
  if (Math.abs(area) <= EPS) {
    let pair: [Pt, Pt] = [clean[0], clean[1]], farthest = -1;
    for (let i = 0; i < clean.length; i++) for (let j = i + 1; j < clean.length; j++) {
      const d = (clean[i][0] - clean[j][0]) ** 2 + (clean[i][1] - clean[j][1]) ** 2;
      if (d > farthest) { pair = [clean[i], clean[j]]; farthest = d; }
    }
    if (farthest <= EPS ** 2) return null;
    return { ...base, kind: "edge", pts: pair, inner: [], bbox: bboxOf(pair) };
  }
  return { ...base, kind: "poly", pts: clean, inner: [], bbox: bboxOf(clean), hatch };
}

type FaceEdge = { a: number; b: number; faces: number[] };
const edgeKey = (a: number, b: number) => a < b ? `${a},${b}` : `${b},${a}`;

function faceNormal(ring: Vec3[]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const len = Math.hypot(...n) || 1;
  return n.map((x) => x / len) as Vec3;
}

/** Project a closed polyhedron without replacing a concave silhouette with its convex hull. */
function projectedSolid(
  base: Omit<Shape, "kind" | "pts" | "bbox" | "inner">,
  vertices: Vec3[], sourceFaces: number[][],
  v: ViewDef,
): Shape[] {
  if (vertices.length < 4 || sourceFaces.length < 4) return [];
  const faces = sourceFaces.map((f) => [...f]);
  // A consistently oriented closed shell has signed volume with one global sign. Correct that sign
  // after the affine mapping (which may include a reflection) before deciding which faces are front.
  let volume6 = 0;
  for (const f of faces) for (let k = 1; k + 1 < f.length; k++) {
    const a = vertices[f[0]], b = vertices[f[k]], c = vertices[f[k + 1]];
    volume6 += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  if (volume6 < 0) for (const f of faces) f.reverse();
  const normals = faces.map((f) => faceNormal(f.map((i) => vertices[i])));
  const toward: Vec3 = [0, 0, 0];
  toward[v.d.axis] = v.d.sign;
  const front = normals.map((n) => n[0] * toward[0] + n[1] * toward[1] + n[2] * toward[2] > EPS);
  const edges = new Map<string, FaceEdge>();
  faces.forEach((f, fi) => f.forEach((a, i) => {
    const b = f[(i + 1) % f.length], id = edgeKey(a, b);
    const e = edges.get(id) ?? { a: Math.min(a, b), b: Math.max(a, b), faces: [] };
    e.faces.push(fi); edges.set(id, e);
  }));
  const silhouette: FaceEdge[] = [];
  const inner: [Pt, Pt][] = [];
  for (const e of edges.values()) {
    const flags = e.faces.map((i) => front[i]);
    if ((flags.some(Boolean) && flags.some((x) => !x)) || e.faces.length === 1) silhouette.push(e);
    else if (flags.every(Boolean) && (e.faces.length !== 2 || Math.abs(normals[e.faces[0]][0] * normals[e.faces[1]][0] + normals[e.faces[0]][1] * normals[e.faces[1]][1] + normals[e.faces[0]][2] * normals[e.faces[1]][2]) < 1 - 1e-6)) {
      const a = toUV(vertices[e.a], v), b = toUV(vertices[e.b], v);
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > EPS) inner.push([a, b]);
    }
  }

  const remaining = new Map(silhouette.map((e) => [edgeKey(e.a, e.b), e]));
  const incident = new Map<number, string[]>();
  for (const [id, e] of remaining) {
    incident.set(e.a, [...(incident.get(e.a) ?? []), id]);
    incident.set(e.b, [...(incident.get(e.b) ?? []), id]);
  }
  const rings: number[][] = [];
  while (remaining.size) {
    const first = remaining.values().next().value as FaceEdge;
    const start = first.a, ring = [start];
    let previous = start, current = first.b;
    remaining.delete(edgeKey(first.a, first.b));
    ring.push(current);
    for (let guard = 0; current !== start && guard <= silhouette.length; guard++) {
      const nextId = (incident.get(current) ?? []).find((id) => remaining.has(id));
      if (!nextId) break;
      const nextEdge = remaining.get(nextId)!;
      remaining.delete(nextId);
      const next = nextEdge.a === current ? nextEdge.b : nextEdge.a;
      previous = current;
      current = next;
      ring.push(current);
      if (current !== start && previous === current) break;
    }
    if (ring.length >= 4 && ring.at(-1) === start) rings.push(ring.slice(0, -1));
  }
  const shapes = rings.map((ring) => projectedRing(base, ring.map((i) => vertices[i]), v)).filter((s): s is Shape => !!s);
  if (shapes.length) shapes[0].inner = inner;
  return shapes;
}

function boxGeometry(start: Vec3, stop: Vec3): { vertices: Vec3[]; faces: number[][] } {
  const lo = start.map((x, i) => Math.min(x, stop[i])) as Vec3;
  const hi = start.map((x, i) => Math.max(x, stop[i])) as Vec3;
  const vertices = Array.from({ length: 8 }, (_, i): Vec3 => [0, 1, 2].map((k) => i & (1 << k) ? hi[k] : lo[k]) as Vec3);
  return { vertices, faces: [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]] };
}

function projectedTransformed(part: Part, prim: Extract<Primitive, { kind: "transformed" }>, v: ViewDef, base: Omit<Shape, "kind" | "pts" | "bbox" | "inner">): Shape[] {
  const source = prim.primitive;
  const map = (p: Vec3) => affinePoint(prim.matrix, p);
  if (source.kind === "box") {
    const lo = source.start.map((x, i) => Math.min(x, source.stop[i])) as Vec3;
    const hi = source.start.map((x, i) => Math.max(x, source.stop[i])) as Vec3;
    const zero = lo.map((x, i) => Math.abs(hi[i] - x) < EPS);
    if (zero.filter(Boolean).length === 1) {
      const n = zero.indexOf(true) as 0 | 1 | 2, u = (n + 1) % 3, w = (n + 2) % 3;
      const local: Vec3[] = [[...lo], [...lo], [...hi], [...lo]];
      local[1][u] = hi[u]; local[2][u] = hi[u]; local[2][w] = hi[w]; local[3][w] = hi[w];
      const world = local.map(map);
      const a = world[1].map((x, i) => x - world[0][i]) as Vec3;
      const b = world[3].map((x, i) => x - world[0][i]) as Vec3;
      const normal: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const length = Math.hypot(...normal) || 1;
      const cosine = Math.abs(normal[v.d.axis] / length);
      return [projectedRing(base, world, v, roleOf(part) === "dielectric" && cosine < 1 - 1e-6)].filter((s): s is Shape => !!s);
    }
    const { vertices, faces } = boxGeometry(lo, hi);
    if (zero.filter(Boolean).length >= 2) {
      const unique = vertices.filter((p, i) => vertices.findIndex((q) => q.every((x, k) => Math.abs(x - p[k]) < EPS)) === i).map(map);
      return [projectedRing(base, unique, v)].filter((s): s is Shape => !!s);
    }
    return projectedSolid(base, vertices.map(map), faces, v);
  }
  if (source.kind === "polygon") {
    const world = source.points.map((q) => map(polyPoint3(source.normal, source.elevation, q)));
    return [projectedRing(base, world, v)].filter((s): s is Shape => !!s);
  }
  if (source.kind === "linpoly") {
    const len = source.length ?? 0;
    const low = source.elevation + Math.min(0, len), high = source.elevation + Math.max(0, len);
    const bottom = source.points.map((q) => map(polyPoint3(source.normal, low, q)));
    if (Math.abs(len) < EPS) return [projectedRing(base, bottom, v)].filter((s): s is Shape => !!s);
    const top = source.points.map((q) => map(polyPoint3(source.normal, high, q)));
    const n = bottom.length;
    const faces = [Array.from({ length: n }, (_, i) => n - i - 1), Array.from({ length: n }, (_, i) => n + i)];
    for (let i = 0; i < n; i++) faces.push([i, (i + 1) % n, n + (i + 1) % n, n + i]);
    return projectedSolid(base, [...bottom, ...top], faces, v);
  }
  if (source.kind === "polyhedron") return projectedSolid(base, source.vertices.map(map), source.faces, v);
  if (source.kind === "wire" || source.kind === "curve") {
    const points = source.points.map(map).map((p) => toUV(p, v));
    if (points.length < 2) return [];
    const ring = [...points, ...points.slice(1, -1).reverse()];
    return [{ ...base, kind: ring.length === 2 ? "edge" : "poly", pts: ring, inner: [], bbox: bboxOf(points) }];
  }
  // Curved transformed primitives have an exact world AABB in the bundle. Until a projected
  // curved-surface outline is available, show that bound with the existing dashed approx role.
  const [u0, v0] = toUV(prim.bbox[0], v), [u1, v1] = toUV(prim.bbox[1], v);
  const shape = rectShape({ ...base, role: "approx" }, u0, u1, v0, v1);
  return [shape];
}

function thinAxis(bb: [Vec3, Vec3]): 0 | 1 | 2 {
  const e = [0, 1, 2].map((i) => Math.abs(bb[1][i] - bb[0][i]));
  // ties prefer z, then y (sheets are usually horizontal or vertical in xz)
  let best: 0 | 1 | 2 = 2;
  for (const i of [1, 0] as const) if (e[i] < e[best] - EPS) best = i;
  return best;
}

function rectShape(base: Omit<Shape, "kind" | "pts" | "bbox" | "inner">, u0: number, u1: number, v0: number, v1: number): Shape {
  const [a, c] = range(u0, u1);
  const [b, d] = range(v0, v1);
  if (c - a < EPS || d - b < EPS) {
    const pts: Pt[] = [[a, b], [c, d]];
    return { ...base, kind: "edge", pts, inner: [], bbox: [a, b, c, d] };
  }
  const pts: Pt[] = [[a, b], [c, b], [c, d], [a, d]];
  return { ...base, kind: "poly", pts, inner: [], bbox: [a, b, c, d] };
}

/** Outline of a solid of revolution seen from the side: (largest radius, axial) at every axial
 * position where the profile has a vertex or two of its edges cross, ascending. Exact for any
 * simple profile (the envelope is piecewise linear between those positions). */
export function silhouette(points: [number, number][]): [number, number][] {
  const n = points.length;
  const hs = new Set(points.map((q) => q[1]));
  // crossings of two edges inside both (where the largest radius may switch edges)
  for (let i = 0; i < n; i++) {
    const [a0, b0] = points[i], [a1, b1] = points[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      const [c0, d0] = points[j], [c1, d1] = points[(j + 1) % n];
      const den = (a1 - a0) * (d1 - d0) - (b1 - b0) * (c1 - c0);
      if (Math.abs(den) < 1e-15) continue;
      const t = ((c0 - a0) * (d1 - d0) - (d0 - b0) * (c1 - c0)) / den;
      const u = ((c0 - a0) * (b1 - b0) - (d0 - b0) * (a1 - a0)) / den;
      if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) hs.add(b0 + t * (b1 - b0));
    }
  }
  const rAt = (h: number) => {
    let r = 0;
    for (let i = 0; i < n; i++) {
      const [r0, h0] = points[i], [r1, h1] = points[(i + 1) % n];
      if (h < Math.min(h0, h1) - 1e-12 || h > Math.max(h0, h1) + 1e-12) continue;
      r = Math.max(r, Math.abs(h1 - h0) < 1e-12 ? Math.max(r0, r1) : r0 + ((h - h0) / (h1 - h0)) * (r1 - r0));
    }
    return r;
  };
  return [...hs].sort((x, y) => x - y).map((h) => [rAt(h), h]);
}

/** Radius of the hole through a solid of revolution seen along its axis (a torus' R - r), else 0. */
export function revolvedHole(points: [number, number][]): number {
  return Math.max(0, Math.min(...points.map((q) => q[0])));
}

function primShape(part: Part, pi: number, prim: Primitive, ip: number, v: ViewDef): Shape | Shape[] | null {
  const role: Role = prim.kind === "bbox" ? "approx" : roleOf(part);
  const hatchable = role === "dielectric";
  const bb = prim.bbox;
  const depth = range(mapPt(bb[0], v.d), mapPt(bb[1], v.d));
  const base = { part: pi, prim: ip, role, depth, hatch: false };
  if (prim.kind === "transformed") return projectedTransformed(part, prim, v, base);
  switch (prim.kind) {
    case "box": {
      const [u0, v0] = toUV(prim.start, v);
      const [u1, v1] = toUV(prim.stop, v);
      if (Math.abs(u1 - u0) < EPS && Math.abs(v1 - v0) < EPS) return null;
      const s = rectShape(base, u0, u1, v0, v1);
      s.hatch = hatchable && s.kind === "poly" && thinAxis([prim.start, prim.stop]) !== v.d.axis;
      return s;
    }
    case "polygon":
    case "linpoly": {
      const len = prim.kind === "linpoly" ? prim.length ?? 0 : 0;
      const ring = prim.points.map((q) => polyPoint3(prim.normal, prim.elevation, q));
      if (ring.length < 2) return null;
      if (v.d.axis === prim.normal) {
        const pts = ring.map((p) => toUV(p, v));
        return { ...base, kind: "poly", pts, inner: [], bbox: bboxOf(pts) };
      }
      const all = ring.map((p) => toUV(p, v));
      if (Math.abs(len) > EPS) ring.forEach((p) => {
        const q: Vec3 = [...p];
        q[prim.normal] += len;
        all.push(toUV(q, v));
      });
      const [a, b, c, d] = bboxOf(all);
      const s = rectShape(base, a, c, b, d);
      if (s.kind === "poly") {
        s.hatch = hatchable && thinAxis(prim.bbox) !== v.d.axis;
        // vertex lines of the extrusion: the in-view in-plane axis is the one that is not the normal
        const alongU = v.u.axis !== prim.normal;
        const coords = [...new Set(ring.map((p) => toUV(p, v)[alongU ? 0 : 1]).map((x) => Math.round(x * 1e6) / 1e6))];
        for (const x of coords) {
          if (alongU && x > a + 1e-6 && x < c - 1e-6) s.inner.push([[x, b], [x, d]]);
          if (!alongU && x > b + 1e-6 && x < d - 1e-6) s.inner.push([[a, x], [c, x]]);
        }
      }
      return s;
    }
    case "cylinder":
    case "cylindricalshell": {
      const dv = prim.stop.map((x, i) => x - prim.start[i]);
      const nz = dv.map((x) => Math.abs(x) > EPS);
      const k = nz.indexOf(true) as 0 | 1 | 2;
      // a tube: outer radius here, its bore as the circle's hole seen along the axis; from the
      // side it looks like a solid cylinder (the bore would be hidden lines, not drawn)
      const r = prim.kind === "cylinder" ? prim.radius : prim.radius + prim.shell_width / 2;
      const ri = prim.kind === "cylinder" ? 0 : Math.max(0, prim.radius - prim.shell_width / 2);
      if (nz.filter(Boolean).length !== 1 || r <= EPS) break; // oblique: fall back to the bbox below
      if (k === v.d.axis) {
        const c = toUV(prim.start, v);
        return { ...base, kind: "circle", pts: [], c, r, ...(ri > EPS ? { ri } : {}), inner: [], bbox: [c[0] - r, c[1] - r, c[0] + r, c[1] + r] };
      }
      const [su, sv] = toUV(prim.start, v);
      const [eu, ev] = toUV(prim.stop, v);
      if (k === v.u.axis) {
        const s = rectShape(base, su, eu, sv - r, sv + r);
        s.axisLine = [[Math.min(su, eu), sv], [Math.max(su, eu), sv]];
        s.hatch = hatchable;
        return s;
      }
      const s = rectShape(base, su - r, su + r, sv, ev);
      s.axisLine = [[su, Math.min(sv, ev)], [su, Math.max(sv, ev)]];
      s.hatch = hatchable;
      return s;
    }
    case "sphere": {
      // a circle of its radius in every view
      const c = toUV(prim.center, v);
      const r = prim.radius;
      if (r <= EPS) break;
      return { ...base, kind: "circle", pts: [], c, r, inner: [], bbox: [c[0] - r, c[1] - r, c[0] + r, c[1] + r] };
    }
    case "rotpoly": {
      // along the axis: a circle of the largest radius (with the hole of a torus); from the side:
      // the silhouette, the largest radius at each axial position mirrored about the axis
      const rs = prim.points.map((q) => q[0]);
      const rmax = Math.max(...rs);
      if (!(rmax > EPS)) break;
      if (prim.axis === v.d.axis) {
        const c = toUV(prim.origin, v);
        const inner = revolvedHole(prim.points);
        return { ...base, kind: "circle", pts: [], c, r: rmax, ...(inner > EPS ? { ri: inner } : {}), inner: [], bbox: [c[0] - rmax, c[1] - rmax, c[0] + rmax, c[1] + rmax] };
      }
      const across = v.u.axis === prim.axis ? v.v.axis : v.u.axis;
      const env = silhouette(prim.points);
      const at = (x: number, h: number): Pt => {
        const p: Vec3 = [...prim.origin];
        p[prim.axis] += h;
        p[across] += x;
        return toUV(p, v);
      };
      const pts = [...env.map(([r, h]) => at(r, h)), ...[...env].reverse().map(([r, h]) => at(-r, h))];
      const [h0, h1] = [env[0][1], env[env.length - 1][1]];
      return { ...base, kind: "poly", pts, inner: [], axisLine: [at(0, h0), at(0, h1)], hatch: hatchable, bbox: bboxOf(pts) };
    }
    case "polyhedron": {
      // silhouette = convex hull of the projected vertices; the projected feature edges inside it
      const P = prim.vertices.map((p) => toUV(p, v));
      const hull = convexHull(P);
      if (hull.length < 3) break;
      const s: Shape = { ...base, kind: "poly", pts: hull, inner: [], bbox: bboxOf(hull) };
      // edges between two coplanar faces (a triangulated quad's diagonal) are not drawn
      const unit = (f: number[]): Vec3 => {
        const [a, b, c] = f.map((i) => prim.vertices[i]);
        const n: Vec3 = [
          (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
          (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
          (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
        ];
        const l = Math.hypot(...n) || 1;
        return [n[0] / l, n[1] / l, n[2] / l];
      };
      const byEdge = new Map<string, Vec3[]>();
      for (const f of prim.faces) {
        if (f.length < 3) continue;
        const n = unit(f);
        f.forEach((i, k) => {
          const j = f[(k + 1) % f.length];
          const id = i < j ? `${i},${j}` : `${j},${i}`;
          byEdge.set(id, [...(byEdge.get(id) ?? []), n]);
        });
      }
      for (const [id, ns] of byEdge) {
        if (ns.length === 2 && Math.abs(ns[0][0] * ns[1][0] + ns[0][1] * ns[1][1] + ns[0][2] * ns[1][2]) > 1 - 1e-6) continue;
        const [i, j] = id.split(",").map(Number);
        const [a, b] = [P[i], P[j]];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) s.inner.push([a, b]);
      }
      return s;
    }
    case "curve":
    case "wire": {
      // an open polyline as a ring that retraces itself (zero area, the outline is the wire)
      const P = prim.points.map((p) => toUV(p, v));
      if (P.length < 2) return null;
      const ring = [...P, ...P.slice(1, -1).reverse()];
      const bb = bboxOf(P);
      if (bb[2] - bb[0] < EPS && bb[3] - bb[1] < EPS) return null;
      return { ...base, kind: ring.length === 2 ? "edge" : "poly", pts: ring, inner: [], bbox: bb };
    }
    default:
      break;
  }
  // bounding-box fallback (inexact or oblique primitives)
  const [u0, v0] = toUV(bb[0], v);
  const [u1, v1] = toUV(bb[1], v);
  if (Math.abs(u1 - u0) < EPS && Math.abs(v1 - v0) < EPS) return null;
  return { ...rectShape({ ...base, role: "approx" }, u0, u1, v0, v1) };
}

export function viewShapes(b: Pick<Bundle, "parts">, v: ViewDef): Shape[] {
  const out: Shape[] = [];
  b.parts.forEach((part, pi) =>
    part.primitives.forEach((prim, ip) => {
      const s = primShape(part, pi, prim, ip, v);
      if (Array.isArray(s)) out.push(...s);
      else if (s) out.push(s);
    }),
  );
  return out;
}

/** Characteristic points of a part in a view (vertices, circle extremes) for extension lines. */
export function featurePoints(shapes: Shape[], part: number): Pt[] {
  const pts: Pt[] = [];
  for (const s of shapes) {
    if (s.part !== part) continue;
    if (s.kind === "circle" && s.c && s.r) {
      const [x, y] = s.c;
      pts.push([x - s.r, y], [x + s.r, y], [x, y - s.r], [x, y + s.r]);
    } else pts.push(...s.pts);
  }
  return pts;
}

/** A metal shape is drawn hidden (dashed) when a dielectric lies entirely in front of it and covers it. */
export function isHidden(s: Shape, all: Shape[]): boolean {
  if (s.role !== "metal") return false;
  const [a, b, c, d] = s.bbox;
  return all.some(
    (o) =>
      o !== s &&
      o.role === "dielectric" &&
      o.kind !== "edge" &&
      o.depth[0] >= s.depth[1] - 1e-6 &&
      o.depth[1] > s.depth[1] + 1e-6 &&
      o.bbox[0] <= a + 1e-6 &&
      o.bbox[1] <= b + 1e-6 &&
      o.bbox[2] >= c - 1e-6 &&
      o.bbox[3] >= d - 1e-6,
  );
}

export function sameBox(p: [number, number, number, number], q: [number, number, number, number]): boolean {
  return p.every((x, i) => Math.abs(x - q[i]) < 1e-6);
}

export function unionBox(boxes: [number, number, number, number][]): [number, number, number, number] | null {
  if (!boxes.length) return null;
  return [
    Math.min(...boxes.map((x) => x[0])),
    Math.min(...boxes.map((x) => x[1])),
    Math.max(...boxes.map((x) => x[2])),
    Math.max(...boxes.map((x) => x[3])),
  ];
}

export interface PortView {
  number: number;
  label: string;
  a: Pt;
  b: Pt;
  /** true when the port runs along the view direction and shows as a point */
  point: boolean;
}

/** The line a port is drawn along: start to stop for a lumped port; for a waveguide port (whose
 * start/stop are corners of the guide cross-section) the guide axis from the excitation plane to
 * the probe plane. */
export function portLine(p: Bundle["ports"][number]): [Vec3, Vec3] {
  if (p.type !== "waveguide") return [p.start, p.stop];
  const n = "xyz".indexOf(p.direction);
  const c = p.start.map((x, i) => (x + p.stop[i]) / 2) as Vec3;
  const a: Vec3 = [...c];
  const b: Vec3 = [...c];
  a[n] = p.start[n];
  b[n] = p.stop[n];
  return [a, b];
}

export function viewPorts(b: Bundle, v: ViewDef): PortView[] {
  return b.ports.flatMap((p) => portFeedEntries(p, "")).map(([, p]) => {
    const [s, e] = portLine(p);
    const a = toUV(s, v);
    const c = toUV(e, v);
    const label = p.type === "waveguide" ? `P${p.number} ${p.mode ?? "TE"}` : `P${p.number} ${fmtOhm(p.R)} Ω${p.group ? " (group)" : ""}`;
    return { number: p.number, label, a, b: c, point: Math.hypot(c[0] - a[0], c[1] - a[1]) < 1e-9 };
  });
}

const fmtOhm = (r: number) => String(Number(r.toFixed(2)));

/** Overall structure bounding box (parts only; ports lie inside). */
export function structureBox(b: Bundle): [Vec3, Vec3] {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const add = (p: Vec3) => p.forEach((x, i) => {
    lo[i] = Math.min(lo[i], x);
    hi[i] = Math.max(hi[i], x);
  });
  b.parts.forEach((p) => {
    add(p.bbox[0]);
    add(p.bbox[1]);
  });
  b.ports.flatMap((p) => portFeedEntries(p, "")).forEach(([, p]) => {
    add(p.start);
    add(p.stop);
  });
  if (!Number.isFinite(lo[0])) return [[-1, -1, -1], [1, 1, 1]];
  return [lo, hi];
}
