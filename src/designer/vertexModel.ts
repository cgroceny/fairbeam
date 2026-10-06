// Vertex editing of polygons, extruded polygons and wires (#66): the pure model shared by the
// inspector and the 3D view (src/scene/vertexOverlay.ts). World positions follow the part's first
// transform instance (the original, for copies), so a moved or quarter-turned part is edited where
// it is drawn; the stored points stay in the primitive's own coordinates.
import { evaluate } from "./expr.ts";
import { maps, pt, unmapPoint, type Map3 } from "./geometry.ts";
import type { Axis, DesignPart, DesignPrimitive, Expr } from "./types.ts";

type V3 = [number, number, number];
const AXES: Axis[] = ["x", "y", "z"];
export type VertexPrimitive = Extract<DesignPrimitive, { kind: "polygon" | "linpoly" | "wire" }>;

export const isVertexPrimitive = (p: DesignPrimitive | undefined): p is VertexPrimitive =>
  !!p && (p.kind === "polygon" || p.kind === "linpoly" || p.kind === "wire");

/** Fewest points a primitive keeps: a polygon needs three corners, a wire two ends. */
export const minVertices = (p: VertexPrimitive) => (p.kind === "wire" ? 2 : 3);
/** Whether the outline closes (a polygon's last point joins the first; a wire is open). */
export const closedOutline = (p: VertexPrimitive) => p.kind !== "wire";

const round = (x: number) => Math.round(x * 1e6) / 1e6;

export interface VertexFrame {
  map: Map3;
  /** vertex positions in world coordinates (mm) */
  world: V3[];
  /** Whether the interactive drag plane can represent this frame without moving points off-shape. */
  dragSupported: boolean;
  /** polygons: present only when the transformed sheet still lies on a WCS-axis plane */
  planeAxis?: number;
  planeValue?: number;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Return the WCS drag plane only when a polygon's transformed plane is axis aligned. */
function axisPlane(prim: Exclude<VertexPrimitive, { kind: "wire" }>, map: Map3, world: V3[]) {
  const n = AXES.indexOf(prim.normal), [u, v] = [(n + 1) % 3, (n + 2) % 3];
  const zero: V3 = [0, 0, 0], basisU: V3 = [0, 0, 0], basisV: V3 = [0, 0, 0];
  basisU[u] = 1; basisV[v] = 1;
  const originWorld = pt(map, zero);
  const du = sub(pt(map, basisU), originWorld), dv = sub(pt(map, basisV), originWorld);
  const normal = cross(du, dv), length = Math.hypot(...normal);
  if (!Number.isFinite(length) || length < 1e-12 || !world.length) return null;
  const unit = normal.map((x) => x / length) as V3;
  const axis = [0, 1, 2].reduce((a, b) => Math.abs(unit[b]) > Math.abs(unit[a]) ? b : a, 0);
  if (Math.abs(unit[axis]) < 1 - 1e-9) return null;
  const value = world[0][axis];
  const tolerance = 1e-6 * Math.max(1, Math.abs(value), ...world.map((p) => Math.abs(p[axis])));
  if (world.some((p) => Math.abs(p[axis] - value) > tolerance)) return null;
  return { planeAxis: axis, planeValue: value };
}

/** World positions of the primitive's vertices under the part's first transform instance. */
export function vertexFrame(part: DesignPart, prim: VertexPrimitive, names: Record<string, number>): VertexFrame | null {
  try {
    const map = maps(part.transforms, names)[0];
    const n = (e: Expr) => evaluate(e, names);
    if (prim.kind === "wire") {
      const world = prim.points.map((p) => pt(map, p.map(n) as V3));
      return world.every((p) => p.every(Number.isFinite)) ? { map, world, dragSupported: true } : null;
    }
    const k = AXES.indexOf(prim.normal), u = (k + 1) % 3, v = (k + 2) % 3;
    const e = n(prim.elevation);
    const world = prim.points.map(([a, b]) => {
      const local: V3 = [0, 0, 0];
      local[k] = e; local[u] = n(a); local[v] = n(b);
      return pt(map, local);
    });
    if (!world.every((p) => p.every(Number.isFinite))) return null;
    const plane = axisPlane(prim, map, world);
    return plane ? { map, world, dragSupported: true, ...plane } : { map, world, dragSupported: false };
  } catch {
    return null;
  }
}

/** The stored point for a world position: [u, v] for polygons, [x, y, z] for wires. A wire keeps
 * the expression of the coordinate the drag plane holds fixed (`keepAxis`, a world axis). */
export function storedPoint(prim: VertexPrimitive, map: Map3, world: V3, previous?: Expr[], keepAxis?: number): Expr[] {
  const local = unmapPoint(map, world).map(round) as V3;
  if (prim.kind === "wire") {
    const out: Expr[] = [...local];
    if (previous && keepAxis !== undefined) {
      // Keep a wire's existing expression only when that local coordinate really stays fixed
      // throughout the chosen world-axis plane. With an arbitrary rotation, a WCS plane usually
      // changes all three local coordinates, so substituting an old expression would move the
      // committed point away from the preview.
      const origin = unmapPoint(map, [0, 0, 0]);
      const deltas = [0, 1, 2].map((axis) => {
        const p: V3 = [0, 0, 0]; p[axis] = 1;
        const q = unmapPoint(map, p);
        return q.map((x, c) => x - origin[c]) as V3;
      });
      const scale = Math.max(1, ...deltas.flat().map(Math.abs));
      const tolerance = 1e-9 * scale;
      const fixed = [0, 1, 2].find((coordinate) => [0, 1, 2]
        .filter((axis) => axis !== keepAxis)
        .every((axis) => Math.abs(deltas[axis][coordinate]) <= tolerance));
      if (fixed !== undefined) out[fixed] = previous[fixed];
    }
    return out;
  }
  const k = AXES.indexOf(prim.normal);
  return [local[(k + 1) % 3], local[(k + 2) % 3]];
}

/** Midpoint of the edge from vertex k to the next one, in stored coordinates (numbers). */
export function edgeMidpoint(prim: VertexPrimitive, k: number, names: Record<string, number>): number[] | null {
  const n = prim.points.length;
  const next = closedOutline(prim) ? (k + 1) % n : k + 1;
  if (next >= n) return null;
  try {
    const a = prim.points[k].map((e) => evaluate(e, names)), b = prim.points[next].map((e) => evaluate(e, names));
    const mid = a.map((x, c) => round((x + b[c]) / 2));
    return mid.every(Number.isFinite) ? mid : null;
  } catch {
    return null;
  }
}

/** Insert a point after vertex k (mutates the primitive). */
export function insertVertex(prim: VertexPrimitive, after: number, point: Expr[]) {
  (prim.points as Expr[][]).splice(after + 1, 0, [...point]);
}

/** Replace vertex k (mutates the primitive). */
export function moveVertex(prim: VertexPrimitive, k: number, point: Expr[]) {
  (prim.points as Expr[][])[k] = [...point];
}

/** Remove vertex k unless the primitive would fall below its minimum; false when refused. */
export function removeVertex(prim: VertexPrimitive, k: number): boolean {
  if (prim.points.length <= minVertices(prim) || k < 0 || k >= prim.points.length) return false;
  (prim.points as Expr[][]).splice(k, 1);
  return true;
}
