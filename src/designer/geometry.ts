// The draft's geometry in the browser, for an instant preview while editing: the same arithmetic as
// python/fairbeam/design.py (resolve_primitive, transform_maps, map_primitive, prim_bbox), written as
// bundle parts the viewer draws. The server preview replaces it a moment later with the real build
// (mesh, checks); this only removes the round-trip delay from what you see.
import { validColor } from "./colors.ts";
import type { Bundle, Matrix4Rows, Part, Port } from "../types";
import type { CircleCut, Design, DesignCut, DesignPart, DesignPrimitive, DesignTransform, PolygonCut, RectCut } from "./types";
import { evaluate, namesIn } from "./expr.ts";
import { wgCutoffGHz, wgMode } from "./checks.ts";
import { clipPolygons, type Ring } from "./polygonClip.ts";

type V3 = [number, number, number];
type M3 = [[number, number, number], [number, number, number], [number, number, number]];
/** An exact transform instance: world[k] = s[k] * local[a[k]] + t[k] (quarter turns, mirrors, shifts). */
export type Map3 = { a: V3; s: V3; t: V3; /** present only after a non-quarter rotation; row-major linear matrix */ linear?: M3 };
const AXES = ["x", "y", "z"] as const;
const inPlane = (n: number): [number, number] => [(n + 1) % 3, (n + 2) % 3];

interface Resolved {
  kind: DesignPrimitive["kind"];
  priority: number;
  start?: V3; stop?: V3; radius?: number; inner?: number; center?: V3;
  normal?: number; elevation?: number; length?: number; points?: [number, number][];
  /** cone, torus: the rotation axis, a point on it and the (radial, axial) outline */
  axis?: number; origin?: V3; profile?: [number, number][];
  /** wire: the polyline */
  points3?: V3[];
  /** polyhedron: the vertices and the polygon faces (vertex indices) */
  vertices?: V3[]; faces?: number[][];
  /** exact native affine instance, only for non-quarter rotations */
  affine?: Matrix4Rows;
  /** a flat circle (a cylinder of zero length): its centre, radius and inner radius; `points` is the outer ring */
  disc?: { center: [number, number]; radius: number; inner: number };
}

/** design.polyhedron_triangles: every face fanned from its first vertex, all reversed when the mesh
 * encloses a negative volume (a mirrored copy), so the triangles face outward. */
export function polyhedronTriangles(vertices: readonly (readonly number[])[], faces: readonly (readonly number[])[]): number[][] {
  const tris = faces.flatMap((f) => Array.from({ length: Math.max(0, f.length - 2) }, (_, k) => [f[0], f[k + 1], f[k + 2]]));
  let vol = 0;
  for (const [a, b, c] of tris) {
    const p = vertices[a], q = vertices[b], r = vertices[c];
    vol += p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0]);
  }
  return vol < 0 ? tris.map(([a, b, c]) => [a, c, b]) : tris;
}

/** design.TORUS_SEGMENTS: a torus is the rotation of a regular polygon of this many sides */
export const TORUS_SEGMENTS = 64;

/** (radial, axial) outline of a cone or frustum (design.cone_profile). */
export function coneProfile(lo: number, hi: number, rb: number, rt: number): [number, number][] {
  const pts: [number, number][] = [[0, lo]];
  if (rb > 0) pts.push([rb, lo]);
  if (rt > 0) pts.push([rt, hi]);
  pts.push([0, hi]);
  return pts;
}

/** (radial, axial) outline of a torus tube (design.torus_profile). */
export function torusProfile(big: number, small: number, n = TORUS_SEGMENTS): [number, number][] {
  return Array.from({ length: n }, (_, k) => [big + small * Math.cos((2 * Math.PI * k) / n), small * Math.sin((2 * Math.PI * k) / n)] as [number, number]);
}

/** design.DISC_SAG_MM / DISC_MIN_SEGMENTS / DISC_MAX_SEGMENTS: a flat circle is a regular polygon whose
 * sides stay within DISC_SAG_MM of the arc (at least 64 sides, always an even number). */
export const DISC_SAG_MM = 0.01, DISC_MIN_SEGMENTS = 64, DISC_MAX_SEGMENTS = 512;

/** design.disc_segments: the number of sides of the polygon that stands for a flat circle of this radius. */
export function discSegments(radius: number): number {
  const ratio = radius > 0 ? DISC_SAG_MM / radius : 2;
  let n = ratio >= 1 ? DISC_MIN_SEGMENTS : Math.ceil(Math.PI / Math.acos(1 - ratio));
  n = Math.max(DISC_MIN_SEGMENTS, Math.min(DISC_MAX_SEGMENTS, n));
  return n + (n % 2);
}

/** design.disc_ring: the counter-clockwise regular polygon on the circle, a vertex at angle 0. */
export function discRing(cu: number, cv: number, radius: number, n: number = discSegments(radius)): Ring {
  return Array.from({ length: n }, (_, k) => [cu + radius * Math.cos(2 * Math.PI * k / n), cv + radius * Math.sin(2 * Math.PI * k / n)] as [number, number]);
}

/** design.disc_halves: a flat ring as two simple polygons, split along the diameter through angles 0 and 180 degrees. */
export function discHalves(cu: number, cv: number, radius: number, inner: number, n: number = discSegments(radius)): Ring[] {
  const outer = discRing(cu, cv, radius, n), inn = discRing(cu, cv, inner, n), h = n / 2;
  return [[...outer.slice(0, h + 1), ...inn.slice(0, h + 1).reverse()],
    [...outer.slice(h), outer[0], inn[0], ...inn.slice(h).reverse()]];
}

function resolve(pr: DesignPrimitive, names: Record<string, number>, priority: number): Resolved {
  const n = (e: unknown) => evaluate(e as string | number, names);
  const v3 = (a: unknown[]) => a.map(n) as V3;
  const out: Resolved = { kind: pr.kind, priority: pr.priority ?? priority };
  if (pr.kind === "box") {
    out.start = v3(pr.start); out.stop = v3(pr.stop);
  } else if (pr.kind === "cylinder") {
    out.radius = n(pr.radius);
    out.inner = pr.inner_radius === undefined ? 0 : n(pr.inner_radius);
    if ("axis" in pr) {
      const k = AXES.indexOf(pr.axis);
      const [u, v] = inPlane(k);
      const [cu, cv] = pr.center.map(n);
      const [lo, hi] = pr.range.map(n);
      if (Math.abs(hi - lo) < 1e-9 && out.radius > 0 && out.inner >= 0 && out.inner < out.radius) {
        // design.resolve_primitive: zero length is a flat circle, built as a polygon sheet (a
        // zero-length CSXCAD cylinder would carve nothing)
        out.kind = "polygon"; out.normal = k; out.elevation = lo; out.points = discRing(cu, cv, out.radius);
        out.disc = { center: [cu, cv], radius: out.radius, inner: out.inner };
        return out;
      }
      const a: V3 = [0, 0, 0], c: V3 = [0, 0, 0];
      a[k] = lo; c[k] = hi; a[u] = c[u] = cu; a[v] = c[v] = cv;
      out.start = a; out.stop = c;
    } else {
      out.start = v3(pr.start); out.stop = v3(pr.stop);
    }
  } else if (pr.kind === "sphere") {
    out.center = v3(pr.center); out.radius = n(pr.radius);
  } else if (pr.kind === "cone") {
    const a = AXES.indexOf(pr.axis), [u, v] = inPlane(a);
    const [lo, hi] = pr.range.map(n);
    const rb = n(pr.bottom_radius), rt = n(pr.top_radius ?? 0);
    if (!(hi > lo) || rb < 0 || rt < 0 || (rb <= 0 && rt <= 0)) throw new Error("degenerate cone");
    const o: V3 = [0, 0, 0];
    [o[u], o[v]] = pr.center.map(n);
    out.axis = a; out.origin = o; out.profile = coneProfile(lo, hi, rb, rt);
  } else if (pr.kind === "wire") {
    out.points3 = pr.points.map(v3); out.radius = n(pr.radius);
    if (out.points3.length < 2 || !(out.radius > 0)) throw new Error("degenerate wire");
  } else if (pr.kind === "polyhedron") {
    if (!Array.isArray(pr.vertices) || pr.vertices.length < 4) throw new Error("degenerate polyhedron");
    out.vertices = pr.vertices.map(v3);
    const nv = out.vertices.length;
    if (!Array.isArray(pr.faces) || pr.faces.length < 4 || pr.faces.some((f) => !Array.isArray(f) || f.length < 3 || new Set(f).size < 3
      || f.some((i) => !Number.isInteger(i) || i < 0 || i >= nv))) throw new Error("degenerate polyhedron");
    out.faces = pr.faces.map((f) => [...f]);
  } else if (pr.kind === "torus") {
    const big = n(pr.major_radius), small = n(pr.minor_radius);
    if (!(big > 0 && small > 0 && small < big)) throw new Error("degenerate torus");
    out.axis = AXES.indexOf(pr.axis); out.origin = v3(pr.center); out.profile = torusProfile(big, small);
  } else {
    out.normal = AXES.indexOf(pr.normal);
    out.elevation = n(pr.elevation);
    out.points = pr.points.map((q) => [n(q[0]), n(q[1])] as [number, number]);
    if (pr.kind === "linpoly") out.length = n(pr.length);
  }
  return out;
}

/**
 * A rectangular sheet (zero size on one axis) minus rectangles in its plane: the exact difference as
 * disjoint rectangles, in the same order as design._sheet_minus (grid of the cut edges, free cells
 * merged into runs along the first in-plane axis, runs of the same span merged across rows).
 */
export function sheetMinus(start: V3, stop: V3, cuts: [V3, V3][]): [V3, V3][] {
  const tol = 1e-9;
  const n = [0, 1, 2].find((k) => Math.abs(stop[k] - start[k]) < 1e-12)!;
  const [u, v] = inPlane(n);
  const u0 = Math.min(start[u], stop[u]), u1 = Math.max(start[u], stop[u]);
  const v0 = Math.min(start[v], stop[v]), v1 = Math.max(start[v], stop[v]);
  const rel: [number, number, number, number][] = [];
  for (const [a, b] of cuts) {
    const cu0 = Math.max(Math.min(a[u], b[u]), u0), cu1 = Math.min(Math.max(a[u], b[u]), u1);
    const cv0 = Math.max(Math.min(a[v], b[v]), v0), cv1 = Math.min(Math.max(a[v], b[v]), v1);
    if (cu1 - cu0 > tol && cv1 - cv0 > tol) rel.push([cu0, cu1, cv0, cv1]);
  }
  if (!rel.length) return [[[...start], [...stop]]];
  const grid = (values: number[]) => {
    const out: number[] = [];
    for (const x of [...values].sort((p, q) => p - q)) if (!out.length || x - out[out.length - 1] > tol) out.push(x);
    return out;
  };
  const us = grid([u0, u1, ...rel.map((c) => c[0]), ...rel.map((c) => c[1])]);
  const vs = grid([v0, v1, ...rel.map((c) => c[2]), ...rel.map((c) => c[3])]);
  const rects: number[][] = [];
  let open = new Map<string, number>();
  for (let j = 0; j < vs.length - 1; j++) {
    const vm = (vs[j] + vs[j + 1]) / 2;
    const runs: [number, number][] = [];
    let run: number | null = null;
    for (let i = 0; i < us.length - 1; i++) {
      const um = (us[i] + us[i + 1]) / 2;
      const free = !rel.some((c) => c[0] <= um && um <= c[1] && c[2] <= vm && vm <= c[3]);
      if (free && run === null) run = i;
      if (!free && run !== null) { runs.push([us[run], us[i]]); run = null; }
    }
    if (run !== null) runs.push([us[run], us[us.length - 1]]);
    const next = new Map<string, number>();
    for (const r of runs) {
      const key = `${r[0]}|${r[1]}`;
      const at = open.get(key);
      if (at !== undefined) { rects[at][3] = vs[j + 1]; next.set(key, at); }
      else { rects.push([r[0], r[1], vs[j], vs[j + 1]]); next.set(key, rects.length - 1); }
    }
    open = next;
  }
  return rects.map(([a0, a1, b0, b1]) => {
    const lo: V3 = [0, 0, 0], hi: V3 = [0, 0, 0];
    lo[n] = hi[n] = start[n];
    lo[u] = a0; hi[u] = a1; lo[v] = b0; hi[v] = b1;
    return [lo, hi] as [V3, V3];
  });
}

/** A cut in numbers (design.resolve_cuts): the plane's normal and position, the outline as in-plane
 * points, its bounds, and for a rectangle its corners (a sheet only rectangles cut keeps exact boxes). */
export interface ResolvedCut { axis: number; plane: number; shape: "rect" | "circle" | "polygon"; ring: Ring; bounds: [number, number, number, number]; a?: V3; b?: V3 }

const ringBounds = (ring: Ring): [number, number, number, number] => [
  Math.min(...ring.map((q) => q[0])), Math.min(...ring.map((q) => q[1])), Math.max(...ring.map((q) => q[0])), Math.max(...ring.map((q) => q[1]))];

/** design.resolve_cuts: a part's cuts evaluated. Throws on a rectangle that is not flat on exactly one axis. */
export function resolveCuts(cuts: DesignCut[] | undefined, names: Record<string, number>): ResolvedCut[] {
  return (cuts ?? []).map((c): ResolvedCut => {
    const n = (e: unknown) => evaluate(e as string | number, names);
    const kind = c.kind ?? "rect";
    let cut: Omit<ResolvedCut, "bounds">;
    if (kind === "circle") {
      const cc = c as CircleCut, [cu, cv] = cc.center.map(n), r = n(cc.radius);
      if (!(r > 0)) throw new Error("the radius must be > 0");
      cut = { axis: AXES.indexOf(cc.normal ?? "z"), plane: n(cc.elevation ?? 0), shape: "circle", ring: discRing(cu, cv, r) };
    } else if (kind === "polygon") {
      const pc = c as PolygonCut;
      if (!Array.isArray(pc.points) || pc.points.length < 3) throw new Error("a polygon cut needs at least 3 points");
      cut = { axis: AXES.indexOf(pc.normal ?? "z"), plane: n(pc.elevation ?? 0), shape: "polygon", ring: pc.points.map((q) => [n(q[0]), n(q[1])] as [number, number]) };
    } else {
      const rc = c as RectCut;
      const a = rc.start.map(n) as V3, b = rc.stop.map(n) as V3;
      const flat = [0, 1, 2].filter((k) => Math.abs(b[k] - a[k]) < 1e-12);
      if (flat.length !== 1) throw new Error("a cut is not a sheet");
      const k = flat[0], [u, v] = inPlane(k);
      const u0 = Math.min(a[u], b[u]), u1 = Math.max(a[u], b[u]), v0 = Math.min(a[v], b[v]), v1 = Math.max(a[v], b[v]);
      cut = { axis: k, plane: a[k], shape: "rect", a, b, ring: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] };
    }
    return { ...cut, bounds: ringBounds(cut.ring) };
  });
}

const onPlane = (x: number, y: number) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));

/** design.sheet_plane: the normal axis and position of a flat sheet a cut can remove area from. */
function sheetPlane(p: Resolved): [number, number] | null {
  if (p.kind === "box") {
    const flat = [0, 1, 2].filter((k) => Math.abs(p.stop![k] - p.start![k]) < 1e-12);
    return flat.length === 1 ? [flat[0], p.start![flat[0]]] : null;
  }
  return p.kind === "polygon" ? [p.normal!, p.elevation!] : null;
}

/** design.expand_discs: a flat ring becomes its two half rings, a flat circle drops its helper data. */
function expandDiscs(p: Resolved): Resolved[] {
  if (!p.disc) return [p];
  const { disc, ...base } = p;
  if (disc.inner > 0) return discHalves(disc.center[0], disc.center[1], disc.radius, disc.inner, p.points!.length).map((points) => ({ ...base, points }));
  return [base];
}

/**
 * design.cut_pieces / apply_cuts: every flat sheet in a cut's plane replaced by what the cuts leave of
 * it. A rectangular sheet that only rectangles cut becomes boxes (sheetMinus); any other sheet is
 * clipped in 2D (polygonClip.ts, the build's polyclip.py) into simple polygons, since CSXCAD polygons
 * have no holes: a hole leaves its surround as several.
 */
function applyCuts(base: Resolved[], cuts: ResolvedCut[]): Resolved[] {
  return base.flatMap((p) => {
    const plane = sheetPlane(p);
    const mine = plane ? cuts.filter((c) => c.axis === plane[0] && onPlane(c.plane, plane[1])) : [];
    return expandDiscs(p).flatMap((q): Resolved[] => {
      if (!mine.length) return [q];
      if (q.kind === "box" && mine.every((c) => c.shape === "rect")) {
        return sheetMinus(q.start!, q.stop!, mine.map((c) => [c.a!, c.b!] as [V3, V3])).map(([lo, hi]) => ({ ...q, start: lo, stop: hi }));
      }
      const n = plane![0], [u, v] = inPlane(n);
      const ring: Ring = q.kind === "polygon" ? q.points! : [
        [Math.min(q.start![u], q.stop![u]), Math.min(q.start![v], q.stop![v])], [Math.max(q.start![u], q.stop![u]), Math.min(q.start![v], q.stop![v])],
        [Math.max(q.start![u], q.stop![u]), Math.max(q.start![v], q.stop![v])], [Math.min(q.start![u], q.stop![u]), Math.max(q.start![v], q.stop![v])]];
      const rb = ringBounds(ring);
      const tol = 1e-9 * Math.max(1, ...rb.map(Math.abs));
      const hit = mine.filter((c) => Math.min(rb[2], c.bounds[2]) - Math.max(rb[0], c.bounds[0]) > tol
        && Math.min(rb[3], c.bounds[3]) - Math.max(rb[1], c.bounds[1]) > tol);
      if (!hit.length) return [q];
      const { start: _s, stop: _e, points: _p, ...rest } = q;
      return clipPolygons([ring], hit.map((c) => c.ring), "subtract").map((points) => ({ ...rest, kind: "polygon" as const, normal: n, elevation: plane![1], points }));
    });
  });
}

const linearOf = (m: Map3): M3 => m.linear ?? [
  [m.a[0] === 0 ? m.s[0] : 0, m.a[0] === 1 ? m.s[0] : 0, m.a[0] === 2 ? m.s[0] : 0],
  [m.a[1] === 0 ? m.s[1] : 0, m.a[1] === 1 ? m.s[1] : 0, m.a[1] === 2 ? m.s[1] : 0],
  [m.a[2] === 0 ? m.s[2] : 0, m.a[2] === 1 ? m.s[2] : 0, m.a[2] === 2 ? m.s[2] : 0],
];
const matVec = (a: M3, p: V3): V3 => a.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2]) as V3;
const matMul = (a: M3, b: M3): M3 => a.map((r) => [
  r[0] * b[0][0] + r[1] * b[1][0] + r[2] * b[2][0],
  r[0] * b[0][1] + r[1] * b[1][1] + r[2] * b[2][1],
  r[0] * b[0][2] + r[1] * b[1][2] + r[2] * b[2][2],
]) as M3;
const generalMap = (linear: M3, t: V3): Map3 => ({ a: [0, 1, 2], s: [1, 1, 1], t, linear });

/** Row-major homogeneous matrix; matches CSXCAD's column-vector `GetMatrix()` convention. */
export function affineMatrix(m: Map3): Matrix4Rows {
  const a = linearOf(m);
  return [[...a[0], m.t[0]], [...a[1], m.t[1]], [...a[2], m.t[2]], [0, 0, 0, 1]];
}

/** The part's transform instances in assembly order; the first is the primary (the original for copies). */
export function maps(transforms: DesignTransform[] | undefined, names: Record<string, number>): Map3[] {
  let out: Map3[] = [{ a: [0, 1, 2], s: [1, 1, 1], t: [0, 0, 0] }];
  const vec = (value: unknown): V3 => {
    if (!Array.isArray(value) || value.length !== 3) throw new Error("expected three coordinates");
    return value.map((e) => evaluate(e, names)) as V3;
  };
  for (const tr of transforms ?? []) {
    if (tr.type === "move") {
      const d = vec(tr.offset);
      out = out.map((m) => ({ ...m, t: [m.t[0] + d[0], m.t[1] + d[1], m.t[2] + d[2]] }));
    } else if (tr.type === "rotate") {
      const axis = AXES.indexOf(tr.axis), center = vec(tr.center);
      const degrees = evaluate(tr.angle, names);
      const turns = degrees / 90, quarter = Math.round(turns);
      if (axis < 0) throw new Error("rotation requires a valid axis");
      const quarterTurn = Math.abs(turns - quarter) <= 1e-9;
      const n = evaluate(tr.copies ?? 0, names), copies = Math.round(n);
      if (n < 0 || Math.abs(n - copies) > 1e-9) throw new Error("copies must be a whole number >= 0");
      if ((copies + 1) * out.length > 1001) throw new Error("at most 1000 copies of a solid");
      const [u, v] = inPlane(axis);
      const rotateQuarter = (m: Map3, k: number): Map3 => {
        if (m.linear) {
          const linear = m.linear.map((r) => [...r]) as M3;
          const t = [...m.t] as V3;
          for (let j = 0, count = (((quarter % 4) * k) % 4 + 4) % 4; j < count; j++) {
            const ru = [...linear[u]] as [number, number, number], rv = [...linear[v]] as [number, number, number];
            linear[u] = [-rv[0], -rv[1], -rv[2]]; linear[v] = ru;
            const tu = t[u] - center[u], tv = t[v] - center[v];
            t[u] = center[u] - tv; t[v] = center[v] + tu;
          }
          return generalMap(linear, t);
        }
        let next = m;
        for (let j = 0, count = (((quarter % 4) * k) % 4 + 4) % 4; j < count; j++) {
          const a = [...next.a] as V3, s = [...next.s] as V3, t = [...next.t] as V3;
          a[u] = next.a[v]; s[u] = -next.s[v]; t[u] = center[u] - (next.t[v] - center[v]);
          a[v] = next.a[u]; s[v] = next.s[u]; t[v] = center[v] + (next.t[u] - center[u]);
          next = { a, s, t };
        }
        return next;
      };
      const rotateAny = (m: Map3, k: number): Map3 => {
        // In a copy array, k=0 is the unchanged source. Preserve its existing compact
        // axis-map instead of wrapping that same source in an equivalent native matrix; Python's
        // transform_maps follows this rule, and lossy ConductingSheet primitives rely on the
        // baked local normal for quarter-turn-only sources.
        if (k === 0) return m;
        const degrees = ((evaluate(tr.angle, names) % 360) * k) % 360;
        const radians = degrees * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
        let r: M3;
        if (axis === 0) r = [[1, 0, 0], [0, c, -s], [0, s, c]];
        else if (axis === 1) r = [[c, 0, s], [0, 1, 0], [-s, 0, c]];
        else r = [[c, -s, 0], [s, c, 0], [0, 0, 1]];
        const offset = [m.t[0] - center[0], m.t[1] - center[1], m.t[2] - center[2]] as V3;
        const rotated = matVec(r, offset);
        return generalMap(matMul(r, linearOf(m)), [rotated[0] + center[0], rotated[1] + center[1], rotated[2] + center[2]]);
      };
      const rotate = quarterTurn ? rotateQuarter : rotateAny;
      out = copies === 0 ? out.map((m) => rotate(m, 1))
        : Array.from({ length: copies + 1 }, (_, k) => out.map((m) => rotate(m, k))).flat();
    } else if (tr.type === "translate") {
      const n = evaluate(tr.copies, names), copies = Math.round(n);
      if (n < 0 || Math.abs(n - copies) > 1e-9) throw new Error("copies must be a whole number >= 0");
      if ((copies + 1) * out.length > 1001) throw new Error("at most 1000 copies of a solid");
      const d = vec(tr.step);
      const next: Map3[] = [];
      for (let i = 0; i <= copies; i++) for (const m of out) next.push({ ...m, t: [m.t[0] + i * d[0], m.t[1] + i * d[1], m.t[2] + i * d[2]] });
      out = next;
    } else if (tr.type === "scale") {
      const f = vec(tr.factors), origin = vec(tr.origin);
      if (f.some((x) => !(x > 0))) throw new Error("scale factors must be positive");
      if (Math.max(...f) - Math.min(...f) > 1e-12 * Math.max(1, ...f.map(Math.abs))) throw new Error("only positive uniform scaling is supported exactly");
      const n = evaluate(tr.copies ?? 0, names), copies = Math.round(n);
      if (n < 0 || Math.abs(n - copies) > 1e-9) throw new Error("copies must be a whole number >= 0");
      if ((copies + 1) * out.length > 1001) throw new Error("at most 1000 copies of a solid");
      const factor = (f[0] + f[1] + f[2]) / 3;
      const scaled = (m: Map3, power: number): Map3 => {
        const q = factor ** power;
        if (m.linear) return generalMap(m.linear.map((r) => r.map((x) => q * x)) as M3,
          m.t.map((x, k) => origin[k] + q * (x - origin[k])) as V3);
        return { a: m.a, s: m.s.map((x) => q * x) as V3,
          t: m.t.map((x, k) => origin[k] + q * (x - origin[k])) as V3 };
      };
      out = copies === 0 ? out.map((m) => scaled(m, 1))
        : Array.from({ length: copies + 1 }, (_, k) => out.map((m) => scaled(m, k))).flat();
    } else {
      const a = AXES.indexOf(tr.plane);
      if (a < 0) throw new Error("invalid mirror plane");
      const point = tr.point === undefined ? [0, 0, 0] as V3 : vec(tr.point);
      if (tr.keep !== false && out.length * 2 > 1001) throw new Error("at most 1000 copies of a solid");
      const flipped = out.map((m) => {
        if (m.linear) {
          const linear = m.linear.map((r) => [...r]) as M3;
          linear[a] = linear[a].map((x) => -x) as [number, number, number];
          const t = [...m.t] as V3; t[a] = 2 * point[a] - t[a];
          return generalMap(linear, t);
        }
        const s = [...m.s] as V3, t = [...m.t] as V3;
        s[a] = -s[a]; t[a] = 2 * point[a] - t[a];
        return { a: m.a, s, t };
      });
      out = tr.keep === false ? flipped : [...out, ...flipped];
    }
  }
  return out;
}

export const pt = (m: Map3, p: V3): V3 => {
  if (m.linear) {
    const q = matVec(m.linear, p);
    return [q[0] + m.t[0], q[1] + m.t[1], q[2] + m.t[2]];
  }
  return [m.s[0] * p[m.a[0]] + m.t[0], m.s[1] * p[m.a[1]] + m.t[1], m.s[2] * p[m.a[2]] + m.t[2]];
};

/** Inverse of pt: the local point of a world point under the map m. */
export const unmapPoint = (m: Map3, w: V3): V3 => {
  if (m.linear) {
    const a = m.linear, d = [w[0] - m.t[0], w[1] - m.t[1], w[2] - m.t[2]] as V3;
    const det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    if (Math.abs(det) < 1e-30) throw new Error("transform matrix is singular");
    const inv: M3 = [
      [(a[1][1] * a[2][2] - a[1][2] * a[2][1]) / det, (a[0][2] * a[2][1] - a[0][1] * a[2][2]) / det, (a[0][1] * a[1][2] - a[0][2] * a[1][1]) / det],
      [(a[1][2] * a[2][0] - a[1][0] * a[2][2]) / det, (a[0][0] * a[2][2] - a[0][2] * a[2][0]) / det, (a[0][2] * a[1][0] - a[0][0] * a[1][2]) / det],
      [(a[1][0] * a[2][1] - a[1][1] * a[2][0]) / det, (a[0][1] * a[2][0] - a[0][0] * a[2][1]) / det, (a[0][0] * a[1][1] - a[0][1] * a[1][0]) / det],
    ];
    return matVec(inv, d);
  }
  const out: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) out[m.a[k]] = (w[k] - m.t[k]) / m.s[k];
  return out;
};

function mapped(p: Resolved, m: Map3): Resolved {
  if (m.linear) return { ...p, affine: affineMatrix(m) };
  const q: Resolved = { ...p };
  const sizeScale = Math.abs(m.s[0]);
  if (p.kind === "box" || p.kind === "cylinder") {
    q.start = pt(m, p.start!); q.stop = pt(m, p.stop!);
    if (p.kind === "cylinder") { q.radius = p.radius! * sizeScale; q.inner = p.inner! * sizeScale; }
  }
  else if (p.kind === "sphere") { q.center = pt(m, p.center!); q.radius = p.radius! * sizeScale; }
  else if (p.kind === "wire") { q.points3 = p.points3!.map((x) => pt(m, x)); q.radius = p.radius! * sizeScale; }
  else if (p.kind === "polyhedron") q.vertices = p.vertices!.map((x) => pt(m, x));
  else if (p.kind === "cone" || p.kind === "torus") {
    q.origin = pt(m, p.origin!);
    q.axis = m.a.indexOf(p.axis!);
    q.profile = p.profile!.map(([r, h]) => [r * sizeScale, m.s[q.axis!] * h] as [number, number]);
  } else {
    const n = p.normal!;
    const [u, v] = inPlane(n);
    q.normal = m.a.indexOf(n);
    const [qu, qv] = inPlane(q.normal);
    q.points = p.points!.map(([a, b]) => {
      const point: V3 = [0, 0, 0]; point[n] = p.elevation!; point[u] = a; point[v] = b;
      const mapped = pt(m, point); return [mapped[qu], mapped[qv]];
    });
    const sign = m.s[q.normal];
    q.elevation = sign * (p.elevation! + (p.kind === "linpoly" && sign < 0 ? p.length! : 0)) + m.t[q.normal];
    if (p.kind === "linpoly") q.length = p.length! * sizeScale;
  }
  return q;
}

/**
 * The boxes of a part of box primitives in world coordinates, after its cuts and all its transform
 * instances (map-major, like the build). Quarter turns, mirrors and shifts keep boxes axis-aligned,
 * so this is exact. `primitives` replaces the part's own (a live Boolean's recomputed boxes).
 */
export function worldBoxes(part: DesignPart, names: Record<string, number>, primitives = part.primitives): [V3, V3][] {
  const cuts = resolveCuts(part.cuts, names);
  const base = applyCuts(primitives.map((pr) => {
    if (pr.kind !== "box") throw new Error("only box primitives");
    return resolve(pr, names, 0);
  }), cuts);
  if (base.some((p) => p.kind !== "box")) throw new Error("a round or polygon cut turns its sheets into polygons: remove the cut, or Boolean the polygons");
  return maps(part.transforms, names).flatMap((m) => base.map((p) => {
    if (m.linear) throw new Error("live Booleans do not support arbitrary rotations of their operands; use quarter turns or materialise the result first");
    const q = mapped(p, m);
    return [q.start!, q.stop!] as [V3, V3];
  }));
}

/** A primitive in world coordinates (numbers): what a Boolean operand is made of. */
export interface WorldPrimitive {
  kind: DesignPrimitive["kind"];
  start?: V3; stop?: V3;
  /** polygon, linpoly: the normal axis (0, 1, 2), the plane, the extrusion and in-plane points */
  normal?: number; elevation?: number; length?: number; points?: [number, number][];
}

/**
 * Every primitive of a part in world coordinates after its cuts and transforms (the build's
 * resolve_primitive, apply_cuts and map_primitive), for the Boolean of boxes and polygons.
 */
export function worldPrimitives(part: DesignPart, names: Record<string, number>, primitives = part.primitives): WorldPrimitive[] {
  const cuts = resolveCuts(part.cuts, names);
  const base = applyCuts(primitives.map((pr) => resolve(pr, names, 0)), cuts);
  return maps(part.transforms, names).flatMap((m) => base.map((p) => {
    if (m.linear) throw new Error("live Booleans do not support arbitrary rotations of their operands; use quarter turns or materialise the result first");
    const q = mapped(p, m);
    return { kind: q.kind, start: q.start, stop: q.stop, normal: q.normal, elevation: q.elevation, length: q.length, points: q.points };
  }));
}

const boundsOfPoints = (points: V3[], expand: V3 = [0, 0, 0]): [V3, V3] => [
  [0, 1, 2].map((k) => Math.min(...points.map((q) => q[k])) - expand[k]) as V3,
  [0, 1, 2].map((k) => Math.max(...points.map((q) => q[k])) + expand[k]) as V3,
];
const affinePoint = (m: Matrix4Rows, p: V3): V3 => [
  m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + m[0][3],
  m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + m[1][3],
  m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + m[2][3],
];
function affineScale(m: Matrix4Rows): number { return Math.hypot(m[0][0], m[0][1], m[0][2]); }

/** Tight world bounds for supported rigid/uniform affine transforms, without replacing geometry. */
function transformedBounds(p: Resolved, m: Matrix4Rows): [V3, V3] {
  const scale = affineScale(m);
  if (p.kind === "box") {
    const a = p.start!, c = p.stop!;
    const lo = a.map((x, k) => Math.min(x, c[k])) as V3, hi = a.map((x, k) => Math.max(x, c[k])) as V3;
    const points: V3[] = [];
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) points.push(affinePoint(m, [x, y, z]));
    return boundsOfPoints(points);
  }
  if (p.kind === "polygon" || p.kind === "linpoly") {
    const n = p.normal!, [u, v] = inPlane(n), e0 = p.elevation!, levels = p.kind === "linpoly" ? [e0, e0 + p.length!] : [e0];
    return boundsOfPoints(levels.flatMap((e) => p.points!.map(([a, b]) => {
      const q: V3 = [0, 0, 0]; q[n] = e; q[u] = a; q[v] = b; return affinePoint(m, q);
    })));
  }
  if (p.kind === "cylinder") {
    const a = affinePoint(m, p.start!), c = affinePoint(m, p.stop!);
    const axis = c.map((x, k) => x - a[k]) as V3, length = Math.hypot(...axis) || 1, r = p.radius! * scale;
    const expand = axis.map((x) => r * Math.sqrt(Math.max(0, 1 - (x / length) ** 2))) as V3;
    return boundsOfPoints([a, c], expand);
  }
  if (p.kind === "sphere") {
    const c = affinePoint(m, p.center!), r = p.radius! * scale;
    return [c.map((x) => x - r) as V3, c.map((x) => x + r) as V3];
  }
  if (p.kind === "wire") return boundsOfPoints(p.points3!.map((q) => affinePoint(m, q)), [p.radius! * scale, p.radius! * scale, p.radius! * scale]);
  if (p.kind === "polyhedron") return boundsOfPoints(p.vertices!.map((q) => affinePoint(m, q)));
  if (p.kind === "cone" || p.kind === "torus") {
    const origin = affinePoint(m, p.origin!), axis = p.axis!;
    const direction: V3 = [m[0][axis] / scale, m[1][axis] / scale, m[2][axis] / scale];
    const lo = [...origin] as V3, hi = [...origin] as V3;
    for (let k = 0; k < 3; k++) {
      const radial = Math.sqrt(Math.max(0, 1 - direction[k] ** 2));
      const values = p.profile!.map(([r, h]) => scale * (h * direction[k] + r * radial));
      const lows = p.profile!.map(([r, h]) => scale * (h * direction[k] - r * radial));
      lo[k] += Math.min(...lows); hi[k] += Math.max(...values);
    }
    return [lo, hi];
  }
  return [[0, 0, 0], [0, 0, 0]];
}

function bbox(p: Resolved): [V3, V3] {
  if (p.affine) return transformedBounds(p, p.affine);
  if (p.kind === "box") {
    const a = p.start!, c = p.stop!;
    return [[Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2])], [Math.max(a[0], c[0]), Math.max(a[1], c[1]), Math.max(a[2], c[2])]];
  }
  if (p.kind === "cylinder") {
    const a = p.start!, c = p.stop!, r = p.radius!;
    const ax = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const len = Math.hypot(ax[0], ax[1], ax[2]) || 1;
    const ext = ax.map((d) => r * Math.sqrt(Math.max(0, 1 - (d / len) ** 2)));
    return [[0, 1, 2].map((k) => Math.min(a[k], c[k]) - ext[k]) as V3, [0, 1, 2].map((k) => Math.max(a[k], c[k]) + ext[k]) as V3];
  }
  if (p.kind === "sphere") {
    const c = p.center!, r = p.radius!;
    return [[c[0] - r, c[1] - r, c[2] - r], [c[0] + r, c[1] + r, c[2] + r]];
  }
  if (p.kind === "wire") {
    const r = p.radius!, P = p.points3!;
    return [[0, 1, 2].map((k) => Math.min(...P.map((q) => q[k])) - r) as V3, [0, 1, 2].map((k) => Math.max(...P.map((q) => q[k])) + r) as V3];
  }
  if (p.kind === "polyhedron") {
    const V = p.vertices!;
    return [[0, 1, 2].map((k) => Math.min(...V.map((q) => q[k]))) as V3, [0, 1, 2].map((k) => Math.max(...V.map((q) => q[k]))) as V3];
  }
  if (p.kind === "cone" || p.kind === "torus") {
    const a = p.axis!, o = p.origin!, rmax = Math.max(...p.profile!.map((q) => q[0]));
    const lo = o.map((x) => x - rmax) as V3, hi = o.map((x) => x + rmax) as V3;
    lo[a] = o[a] + Math.min(...p.profile!.map((q) => q[1]));
    hi[a] = o[a] + Math.max(...p.profile!.map((q) => q[1]));
    return [lo, hi];
  }
  const n = p.normal!, [u, v] = inPlane(n);
  const e0 = p.elevation!, e1 = p.kind === "linpoly" ? e0 + p.length! : e0;
  const lo: V3 = [0, 0, 0], hi: V3 = [0, 0, 0];
  lo[n] = Math.min(e0, e1); hi[n] = Math.max(e0, e1);
  lo[u] = Math.min(...p.points!.map((q) => q[0])); hi[u] = Math.max(...p.points!.map((q) => q[0]));
  lo[v] = Math.min(...p.points!.map((q) => q[1])); hi[v] = Math.max(...p.points!.map((q) => q[1]));
  return [lo, hi];
}

/** A resolved primitive in the bundle's (exporter's) form. */
function toBundlePrim(p: Resolved): Record<string, unknown> {
  if (p.affine) {
    const { affine, ...local } = p;
    return { kind: "transformed", primitive: toBundlePrim(local as Resolved), matrix: affine,
      priority: p.priority, bbox: bbox(p), exact: true };
  }
  const common = { priority: p.priority, bbox: bbox(p), exact: true };
  if (p.kind === "box") return { kind: "box", start: p.start, stop: p.stop, ...common };
  if (p.kind === "cylinder") {
    return p.inner && p.inner > 0
      ? { kind: "cylindricalshell", start: p.start, stop: p.stop, radius: (p.radius! + p.inner) / 2, shell_width: p.radius! - p.inner, ...common }
      : { kind: "cylinder", start: p.start, stop: p.stop, radius: p.radius, ...common };
  }
  if (p.kind === "sphere") return { kind: "sphere", center: p.center, radius: p.radius, ...common };
  if (p.kind === "wire") return { kind: "wire", points: p.points3, radius: p.radius, ...common };
  if (p.kind === "polyhedron") return { kind: "polyhedron", vertices: p.vertices, faces: polyhedronTriangles(p.vertices!, p.faces!), ...common };
  if (p.kind === "cone" || p.kind === "torus") return { kind: "rotpoly", axis: p.axis, origin: p.origin, points: p.profile, ...common };
  return p.kind === "linpoly"
    ? { kind: "linpoly", normal: p.normal, elevation: p.elevation, length: p.length, points: p.points, ...common }
    : { kind: "polygon", normal: p.normal, elevation: p.elevation, points: p.points, ...common };
}

/**
 * The draft as a geometry bundle, or null when a value does not evaluate yet (the last preview
 * stays). `previous` (the last server preview of this design) lends its mesh and domain.
 */
// Solid store primitive objects retain identity when untouched. One successful entry per
// primitive keeps memory bounded, while presentation and evaluated material values stay fresh.
type ExpandedPrimitive = {
  signature: string;
  /** Pieces for each map, in map-major assembly order. */
  byMap: Record<string, unknown>[][];
  bbox: [V3, V3];
  count: number;
};
const expanded = new WeakMap<object, ExpandedPrimitive>();

export function quickBundle(d: Design, names: Record<string, number>, previous: Bundle | null): Bundle | null {
  const pending: [object, ExpandedPrimitive][] = [];
  try {
    const mats = new Map(d.materials.map((m) => [m.name, m]));
    const parts: Part[] = [];
    let totalPrimitives = 0;
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    const grow = (b: [V3, V3]) => { for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b[0][k]); hi[k] = Math.max(hi[k], b[1][k]); } };
    for (const part of d.parts) {
      const mt = mats.get(part.material);
      if (!mt) return null;
      const metal = mt.kind === "metal";
      const cuts = resolveCuts(part.cuts, names);
      const ms = maps(part.transforms, names);
      const contextDeps = new Set<string>();
      const scan = (v: unknown, deps: Set<string>) => {
        if (typeof v === "string" || typeof v === "number") for (const key of namesIn(v)) deps.add(key);
        else if (Array.isArray(v)) v.forEach((item) => scan(item, deps));
        else if (v && typeof v === "object") Object.values(v).forEach((item) => scan(item, deps));
      };
      scan(part.cuts ?? [], contextDeps); scan(part.transforms ?? [], contextDeps);
      const context = JSON.stringify([part.cuts ?? [], part.transforms ?? []]);
      const perPrimitive: ExpandedPrimitive[] = [];
      const perVoid: ExpandedPrimitive[] = [];
      let partPrimitiveCount = 0;
      const basePriority = metal ? 10 : 0;
      // A void carver sits just above the host's own shapes (same rule as the Python build).
      const hostPriorities = part.primitives.filter((q) => !q.void).map((q) => q.priority ?? basePriority);
      const voidPriority = (hostPriorities.length ? Math.max(...hostPriorities) : basePriority) + 0.5;
      for (const pr of part.primitives) {
        const isVoid = pr.void === true;
        const deps = new Set(contextDeps);
        scan(pr, deps);
        // A primitive depends on all cuts, the map transforms, and only its own geometry.
        // The default priority depends on material kind even when geometry is unchanged.
        const signature = JSON.stringify([pr, context, metal, isVoid ? voidPriority : null,
          [...deps].sort().map((key) => [key, names[key]])]);
        let entry = expanded.get(pr as object);
        if (entry?.signature !== signature) {
          const base = applyCuts([resolve(pr, names, isVoid ? voidPriority : basePriority)], cuts);
          if (totalPrimitives + partPrimitiveCount + ms.length * base.length > 5000) throw new Error("at most 5000 expanded primitives");
          const byMap = ms.map((m) => base.map((p) => toBundlePrim(mapped(p, m))));
          const pb: [V3, V3] = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
          for (const mapPrims of byMap) for (const p of mapPrims) {
            const b = (p.bbox as [V3, V3]);
            for (let k = 0; k < 3; k++) { pb[0][k] = Math.min(pb[0][k], b[0][k]); pb[1][k] = Math.max(pb[1][k], b[1][k]); }
          }
          entry = { signature, byMap, bbox: pb, count: byMap.reduce((n, ps) => n + ps.length, 0) };
          pending.push([pr as object, entry]);
        }
        partPrimitiveCount += entry.count;
        if (totalPrimitives + partPrimitiveCount > 5000) throw new Error("at most 5000 expanded primitives");
        (isVoid ? perVoid : perPrimitive).push(entry);
      }
      const count = perPrimitive.reduce((n, p) => n + p.count, 0) + perVoid.reduce((n, p) => n + p.count, 0);
      totalPrimitives += count;
      if (totalPrimitives > 5000) throw new Error("at most 5000 expanded primitives");
      // `source`: the index of the design shape each piece came from, so the 3D view can highlight
      // the one shape selected in the tree (the cached pieces stay shared, so they are copied here)
      const bp = ms.flatMap((_, i) => perPrimitive.flatMap((p, j) => p.byMap[i].map((q) => ({ ...q, source: j }))));
      const pb: [V3, V3] = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
      for (const p of perPrimitive) {
        grow(p.bbox);
        for (let k = 0; k < 3; k++) { pb[0][k] = Math.min(pb[0][k], p.bbox[0][k]); pb[1][k] = Math.max(pb[1][k], p.bbox[1][k]); }
      }
      parts.push({
        name: part.name, type: metal ? "Metal" : "Material", label: part.label, color: validColor(part.color) ?? validColor(mt.color),
        primitives: bp, bbox: pb,
        ...(metal ? {} : { material: { eps_r: mt.eps_r === undefined ? 1 : evaluate(mt.eps_r, names), mu_r: evaluate(mt.mu_r ?? 1, names) } }),
      } as unknown as Part);
      if (perVoid.length) {
        const vb: [V3, V3] = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
        for (const p of perVoid) {
          grow(p.bbox);
          for (let k = 0; k < 3; k++) { vb[0][k] = Math.min(vb[0][k], p.bbox[0][k]); vb[1][k] = Math.max(vb[1][k], p.bbox[1][k]); }
        }
        parts.push({
          name: `${part.name} (cut)`, type: "Material", void: true, material: { eps_r: 1, mu_r: 1 },
          color: validColor(part.color) ?? validColor(mt.color),
          primitives: ms.flatMap((_, i) => perVoid.flatMap((p) => p.byMap[i])), bbox: vb,
        } as unknown as Part);
      }
    }
    const ports: Port[] = d.ports.map((p) => {
      const a = p.start.map((e) => evaluate(e, names)) as V3, c = p.stop.map((e) => evaluate(e, names)) as V3;
      grow([a.map((x, k) => Math.min(x, c[k])) as V3, a.map((x, k) => Math.max(x, c[k])) as V3]);
      const common = { number: p.number, direction: p.direction, start: a, stop: c, excite: p.excite !== false };
      if (p.type === "waveguide") {
        // Simulation.waveguide_port: the cut-off and the TE wave impedance at the band centre
        const mode = wgMode(p.mode ?? "TE10");
        const wa = evaluate(p.a ?? "", names), wb = evaluate(p.b ?? "", names);
        if (!mode || !(wa > 0 && wb > 0)) throw new Error("waveguide port");
        const fc = wgCutoffGHz(mode[0], mode[1], wa, wb);
        const fMid = (evaluate(d.simulation.f_min, names) + evaluate(d.simulation.f_max, names)) / 2;
        const R = Math.round((376.730313668 / Math.sqrt(Math.max(1 - (fc / fMid) ** 2, 1e-12))) * 1000) / 1000;
        return { ...common, type: "waveguide", mode: `TE${mode[0]}${mode[1]}`, a: wa, b: wb, f_cutoff: fc * 1e9, R } as unknown as Port;
      }
      const group = p.group && { ...p.group, members: p.group.members.map((member) => {
        const start = member.start.map((e) => evaluate(e, names)) as V3;
        const stop = member.stop.map((e) => evaluate(e, names)) as V3;
        grow([start.map((x, k) => Math.min(x, stop[k])) as V3, start.map((x, k) => Math.max(x, stop[k])) as V3]);
        return { ...member, start, stop, polarity: member.polarity ?? 1 };
      }) };
      return { ...common, type: "lumped", R: evaluate(p.R ?? 50, names), ...(p.reference_impedance ? { reference_impedance: { real: evaluate(p.reference_impedance.real, names), imag: evaluate(p.reference_impedance.imag, names) } } : {}), ...(group ? { group } : {}) } as unknown as Port;
    });
    if (!Number.isFinite(lo[0])) return null;
    const pad = Math.max(...hi.map((h, k) => h - lo[k])) * 0.25 + 1;
    const same = previous && previous.model.id === d.model.id && previous.mesh.x.length > 1;
    const f0 = evaluate(d.simulation.f_min, names) * 1e9, f1 = evaluate(d.simulation.f_max, names) * 1e9;
    for (const [part, entry] of pending) expanded.set(part, entry);
    return {
      // the design's own name: exports of a preview (drawings, reports, macros, file names) are deliverables; `preview`
      // marks it as not simulated for the UI
      schema: "fairbeam.project/1", name: d.model.name, preview: true,
      model: { id: d.model.id, name: d.model.name, description: d.model.description ?? "", params: [] },
      solver: { excitation: { type: "gauss", f_min: f0, f_max: f1 > f0 ? f1 : f0 * 2 }, boundaries: Object.fromEntries(["x-", "x+", "y-", "y+", "z-", "z+"].map((k, i) => [k, typeof d.simulation.boundaries === "string" ? d.simulation.boundaries : d.simulation.boundaries[i]])), end_criteria_db: d.simulation.end_criteria_db ?? -60, max_timesteps: 60000, engine: "openEMS", method: "FDTD" },
      parts, ports,
      mesh: same ? previous!.mesh : { x: [lo[0] - pad, hi[0] + pad], y: [lo[1] - pad, hi[1] + pad], z: [lo[2] - pad, hi[2] + pad], total_cells: 0 },
      domain: same ? previous!.domain : { min: lo.map((x) => x - pad), max: hi.map((x) => x + pad) },
      focus: { min: lo, max: hi },
      lumped_elements: (previous && same ? previous.lumped_elements : undefined) ?? [],
    } as unknown as Bundle;
  } catch {
    return null;
  }
}

// The shape resolver, cut and transform steps, shared with the Boolean of curved shapes (booleanCurved.ts).
export { resolve as resolveShape, applyCuts as applyShapeCuts, mapped as mapShape, bbox as shapeBounds };
export type { Resolved as ResolvedShape };
