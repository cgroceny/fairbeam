// Booleans with curved shapes (cylinders, tubes, cones, spheres, tori, wires, polyhedra), #80. The
// helpers of booleanParts.ts that are not about bricks and polygons: a part's shapes in world
// coordinates as design primitives (numbers), the cut-out ("void") marker, the rule that makes a
// carver lie exactly on a sheet it touches, coaxial cylinders as (radius, height) rectangles, the faceted ring of a
// cylinder and the point test the overlap prompt uses. python/fairbeam/boolean_curved.py is the same
// arithmetic, step by step (live results are recomputed by the build and must match).
//
// A cut-out is a primitive with `void: true`: the build makes it openEMS vacuum with a priority just
// above its part's own shapes, which erases what lies under it (a Subtract of a curved shape). Its
// priority is left out: the build chooses it (host + 0.5).
import { applyShapeCuts, mapShape, maps, resolveCuts, resolveShape, shapeBounds, type ResolvedShape } from "./geometry.ts";
import type { DesignPart, DesignPrimitive } from "./types.ts";
import type { Ring } from "./polygonClip.ts";

type V3 = [number, number, number];
export type Bounds = [[number, number], [number, number], [number, number]];
const AXES = ["x", "y", "z"] as const;
const inPlane = (n: number): [number, number] => [(n + 1) % 3, (n + 2) % 3];
/** a cylinder's ring is a regular polygon of this many sides when it is clipped as a prism (sagitta 0.12 % of r) */
export const FACETS = 64;

export const isP = (p: DesignPrimitive) => p.kind === "box" || p.kind === "polygon" || p.kind === "linpoly";
export const isVoid = (p: DesignPrimitive) => p.void === true;
export const isTube = (p: DesignPrimitive) => p.kind === "cylinder" && p.inner_radius !== undefined && Number(p.inner_radius) > 0;

/** The kind of a shape as a word key for messages (booleanParts.kind.*). */
export const kindKey = (p: DesignPrimitive) => (isTube(p) ? "tube" : p.kind);

// ------------------------------------------------------------------ world shapes

/** A resolved world shape as a design primitive in numbers (the inverse of resolving, for what the
 * quarter-turn maps leave: a cylinder keeps its axis form when axis-aligned, a cone and a torus are
 * read back from their outline). */
export function unresolve(q: ResolvedShape): DesignPrimitive {
  switch (q.kind) {
    case "box": return { kind: "box", start: [...q.start!], stop: [...q.stop!] };
    case "cylinder": {
      const a = q.start!, c = q.stop!;
      const inner = q.inner && q.inner > 0 ? { inner_radius: q.inner } : {};
      const n = [0, 1, 2].find((k) => { const [u, v] = inPlane(k); return a[u] === c[u] && a[v] === c[v]; });
      if (n === undefined) return { kind: "cylinder", start: [...a], stop: [...c], radius: q.radius!, ...inner };
      const [u, v] = inPlane(n);
      return { kind: "cylinder", axis: AXES[n], center: [a[u], a[v]], radius: q.radius!, ...inner, range: [a[n], c[n]] };
    }
    case "sphere": return { kind: "sphere", center: [...q.center!], radius: q.radius! };
    case "wire": return { kind: "wire", points: q.points3!.map((p) => [...p] as V3), radius: q.radius! };
    case "polyhedron": return { kind: "polyhedron", vertices: q.vertices!.map((p) => [...p] as V3), faces: q.faces!.map((f) => [...f]) };
    case "cone": {
      const o = q.origin!, a = q.axis!, [u, v] = inPlane(a), hs = q.profile!.map((p) => p[1]);
      const lo = Math.min(...hs), hi = Math.max(...hs);
      const radiusAt = (h: number) => Math.max(0, ...q.profile!.filter((p) => p[1] === h).map((p) => p[0]));
      return { kind: "cone", axis: AXES[a], center: [o[u], o[v]], bottom_radius: radiusAt(lo), top_radius: radiusAt(hi), range: [o[a] + lo, o[a] + hi] };
    }
    case "torus": {
      const rs = q.profile!.map((p) => p[0]), hi = Math.max(...rs), lo = Math.min(...rs);
      return { kind: "torus", axis: AXES[q.axis!], center: [...q.origin!], major_radius: (hi + lo) / 2, minor_radius: (hi - lo) / 2 };
    }
    default: {
      const out = { kind: q.kind, normal: AXES[q.normal!], elevation: q.elevation!, points: q.points!.map((p) => [p[0], p[1]] as [number, number]) };
      return (q.kind === "linpoly" ? { ...out, length: q.length! } : out) as DesignPrimitive;
    }
  }
}

/** The shapes of a part in world coordinates after its cuts and all its transform instances
 * (map-major, like the build), as design primitives in numbers. Cut-outs keep `void`. Sheet cuts apply
 * to solid bricks only. `primitives` replaces the part's own. */
export function worldShapes(part: DesignPart, names: Record<string, number>, primitives: DesignPrimitive[] = part.primitives): DesignPrimitive[] {
  const cuts = resolveCuts(part.cuts, names);
  const base = primitives.flatMap((pr) => {
    const r = resolveShape(pr, names, 0);
    return pr.void ? [{ hole: true, r }] : applyShapeCuts([r], cuts).map((s) => ({ hole: false, r: s }));
  });
  return maps(part.transforms, names).flatMap((m) => base.map(({ hole, r }) => {
    if (m.linear) throw new Error("live Booleans do not support arbitrary rotations of their operands; use quarter turns or materialise the result first");
    const out = unresolve(mapShape(r, m));
    return hole ? { ...out, void: true } : out;
  }));
}

/** The bounds of a design primitive in numbers. */
export const designBounds = (p: DesignPrimitive): [V3, V3] => shapeBounds(resolveShape(p, {}, 0));

// ------------------------------------------------------------------ carvers across a sheet

/**
 * A cut-out only removes a sheet (zero thickness, normal axis n, at z0) it reaches: measured with openEMS, a
 * volume whose face lies ON the sheet cuts it as well as one crossing it, while one with a gap, or a flat one
 * (zero thickness), cuts nothing. A face that lies on the sheet up to rounding is made to lie exactly on it
 * (a brick, extrusion, cylinder or cone), so the cut does not depend on the last bit of an expression; the rest
 * (a shape already crossing, a sphere, a shape lying away) stays as it is.
 */
export function snapToSheet(p: DesignPrimitive, n: number, z0: number): DesignPrimitive {
  const [lo3, hi3] = designBounds(p), lo = lo3[n], hi = hi3[n];
  const tol = 1e-9 * Math.max(1, Math.abs(z0));
  const snapLo = lo !== z0 && Math.abs(lo - z0) <= tol, snapHi = hi !== z0 && Math.abs(hi - z0) <= tol;
  if (!snapLo && !snapHi) return p;
  const nlo = snapLo ? z0 : lo, nhi = snapHi ? z0 : hi;
  const put = (a: number, b: number): [number, number] => (a <= b ? [nlo, nhi] : [nhi, nlo]);
  if (p.kind === "box") {
    const start = [...p.start] as unknown as V3, stop = [...p.stop] as unknown as V3;
    [start[n], stop[n]] = put(Number(p.start[n]), Number(p.stop[n]));
    return { ...p, start, stop } as DesignPrimitive;
  }
  if (p.kind === "linpoly" && AXES.indexOf(p.normal) === n) return { ...p, elevation: nlo, length: nhi - nlo };
  if (p.kind === "cylinder" && "axis" in p && AXES.indexOf(p.axis) === n) return { ...p, range: put(Number(p.range[0]), Number(p.range[1])) };
  if (p.kind === "cylinder" && "start" in p) {
    const start = [...p.start] as unknown as V3, stop = [...p.stop] as unknown as V3;
    const [u, v] = inPlane(n);
    if (start[u] !== stop[u] || start[v] !== stop[v]) return p;
    [start[n], stop[n]] = put(Number(p.start[n]), Number(p.stop[n]));
    return { ...p, start, stop } as DesignPrimitive;
  }
  if (p.kind === "cone" && AXES.indexOf(p.axis) === n) return { ...p, range: [nlo, nhi] };
  return p;
}

/** Whether a design primitive is flat (zero thickness): a sheet brick, a flat polygon, a polygon of no length. */
export function flatAxis(p: DesignPrimitive): number {
  if (p.kind === "box") { const z = [0, 1, 2].filter((k) => Number(p.start[k]) === Number(p.stop[k])); return z.length === 1 ? z[0] : -1; }
  if (p.kind === "polygon") return AXES.indexOf(p.normal);
  if (p.kind === "linpoly") return Number(p.length) === 0 ? AXES.indexOf(p.normal) : -1;
  return -1;
}

// ------------------------------------------------------------------ coaxial cylinders and tubes

/** Cylinders and tubes that share one axis (axis-aligned, the same in-plane centre) as (radius, height)
 * rectangles; null when any shape is something else or the axes differ. */
export function coaxialRects(list: DesignPrimitive[]): { axis: number; centre: [number, number]; rects: Bounds[] } | null {
  let axis = -1, centre: [number, number] = [0, 0];
  const rects: Bounds[] = [];
  for (const p of list) {
    if (p.kind !== "cylinder" || !("axis" in p)) return null;
    const n = AXES.indexOf(p.axis), c: [number, number] = [Number(p.center[0]), Number(p.center[1])];
    const tol = 1e-9 * Math.max(1, Math.abs(c[0]), Math.abs(c[1]));
    if (axis < 0) { axis = n; centre = c; }
    else if (n !== axis || Math.abs(c[0] - centre[0]) > tol || Math.abs(c[1] - centre[1]) > tol) return null;
    const lo = Math.min(Number(p.range[0]), Number(p.range[1])), hi = Math.max(Number(p.range[0]), Number(p.range[1]));
    rects.push([[Number(p.inner_radius ?? 0), Number(p.radius)], [lo, hi], [0, 0]]);
  }
  return axis < 0 ? null : { axis, centre, rects };
}

/** A cell of radii r0..r1 and heights h0..h1 as a cylinder (r0 = 0) or a tube. */
export function cylinderCell(axis: number, centre: [number, number], r0: number, r1: number, h0: number, h1: number): DesignPrimitive {
  return { kind: "cylinder", axis: AXES[axis], center: [centre[0], centre[1]], radius: r1, ...(r0 > 0 ? { inner_radius: r0 } : {}), range: [h0, h1] };
}

/** The regular FACETS-gon with its vertices on a cylinder's circle, counter-clockwise in (u, v) of its axis. */
export function facetRing(centre: [number, number], r: number, n = FACETS): Ring {
  return Array.from({ length: n }, (_, k) => [centre[0] + r * Math.cos((2 * Math.PI * k) / n), centre[1] + r * Math.sin((2 * Math.PI * k) / n)] as [number, number]);
}

/** Two rings with the same vertices (any start, either direction is not accepted: both counter-clockwise). */
export function sameRing(a: Ring, b: Ring, eps: number): boolean {
  if (a.length !== b.length) return false;
  const close = (p: [number, number], q: [number, number]) => Math.abs(p[0] - q[0]) <= eps && Math.abs(p[1] - q[1]) <= eps;
  const at = b.findIndex((q) => close(a[0], q));
  return at >= 0 && a.every((p, i) => close(p, b[(i + at) % b.length]));
}

// ------------------------------------------------------------------ point test (the overlap prompt)

function inPolygon(x: number, y: number, pts: [number, number][], tol = 1e-7): boolean {
  let inside = false;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    if (Math.min(x1, x2) - tol <= x && x <= Math.max(x1, x2) + tol && Math.min(y1, y2) - tol <= y && y <= Math.max(y1, y2) + tol) {
      const cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
      if (Math.abs(cross) <= tol * Math.max(1, Math.hypot(x2 - x1, y2 - y1))) return true;
    }
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

function inMesh(verts: V3[], tris: number[][], q: V3): boolean {
  const d: V3 = [1, 1.7e-4, 2.9e-4];
  let inside = false;
  for (const [a, b, c] of tris) {
    const p0 = verts[a], p1 = verts[b], p2 = verts[c];
    const e1 = [0, 1, 2].map((k) => p1[k] - p0[k]), e2 = [0, 1, 2].map((k) => p2[k] - p0[k]);
    const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (Math.abs(det) < 1e-18) continue;
    const s = [0, 1, 2].map((k) => q[k] - p0[k]);
    const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
    if (u < 0 || u > 1) continue;
    const cr = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (d[0] * cr[0] + d[1] * cr[1] + d[2] * cr[2]) / det;
    if (v < 0 || u + v > 1) continue;
    if ((e2[0] * cr[0] + e2[1] * cr[1] + e2[2] * cr[2]) / det > 0) inside = !inside;
  }
  return inside;
}

/** Whether a point lies inside (or on) a world shape (numbers, no native rotation). */
export function shapeContains(p: ResolvedShape, q: V3, tol = 1e-6): boolean {
  const [lo, hi] = shapeBounds(p);
  if ([0, 1, 2].some((k) => q[k] < lo[k] - tol || q[k] > hi[k] + tol)) return false;
  switch (p.kind) {
    case "box": return true;
    case "cylinder": {
      const a = p.start!, c = p.stop!, ax = [0, 1, 2].map((k) => c[k] - a[k]);
      const len2 = ax[0] ** 2 + ax[1] ** 2 + ax[2] ** 2, len = Math.sqrt(len2);
      const t = ([0, 1, 2].reduce((s, k) => s + (q[k] - a[k]) * ax[k], 0)) / len2;
      if (t < -tol / len || t > 1 + tol / len) return false;
      const dist = Math.sqrt([0, 1, 2].reduce((s, k) => s + (q[k] - a[k] - t * ax[k]) ** 2, 0));
      return dist <= p.radius! + tol && dist >= (p.inner ?? 0) - tol;
    }
    case "sphere": return Math.hypot(q[0] - p.center![0], q[1] - p.center![1], q[2] - p.center![2]) <= p.radius! + tol;
    case "wire": {
      let best = Infinity;
      const P = p.points3!;
      for (let i = 0; i + 1 < P.length; i++) {
        const ab = [0, 1, 2].map((k) => P[i + 1][k] - P[i][k]), L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
        const t = L2 < 1e-30 ? 0 : Math.max(0, Math.min(1, [0, 1, 2].reduce((s, k) => s + (q[k] - P[i][k]) * ab[k], 0) / L2));
        best = Math.min(best, Math.hypot(...([0, 1, 2].map((k) => q[k] - (P[i][k] + t * ab[k])) as V3)));
      }
      return best <= p.radius! + tol;
    }
    case "polyhedron": {
      const tris = p.faces!.flatMap((f) => Array.from({ length: Math.max(0, f.length - 2) }, (_, k) => [f[0], f[k + 1], f[k + 2]]));
      return inMesh(p.vertices!, tris, q);
    }
    case "cone": case "torus": {
      const a = p.axis!, o = p.origin!;
      const r = Math.sqrt([0, 1, 2].reduce((s, k) => (k === a ? s : s + (q[k] - o[k]) ** 2), 0));
      return inPolygon(r, q[a] - o[a], p.profile!, tol);
    }
    default: {
      const [u, v] = inPlane(p.normal!);
      return inPolygon(q[u], q[v], p.points!, tol);
    }
  }
}
