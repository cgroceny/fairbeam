// Exact Boolean operations on parts, #80. Operands may carry cuts and any transforms (moves,
// quarter turns, mirrors, copies), which keep boxes axis-aligned and polygons planar, so the
// result is exact, in world coordinates:
//  - parts made of boxes only (bricks and rectangular sheets): the exact box partition (Add, Intersect). Subtract
//    (and Insert) is as compact as it stays exact (compactSubtract): sheets and prisms on a common axis are extruded
//    polygons (a rectangle coming out is a brick), a pocket keeps A whole with B as an exact cut-out; a sheet minus a
//    volume is cut with the volume's cross-section at its plane. An operand's round or polygon cut, or its cut-outs of
//    bricks and polygons, are folded in first (foldedOperand), so Add and Intersect take them;
//  - parts with polygons (flat, or extruded along their normal) and boxes: when every polygon has
//    the same normal, the operands are cut into slabs along that axis wherever a face lies, each
//    slab is clipped exactly in 2D (polygonClip.ts) and the result is extruded polygons (sheets:
//    flat polygons), a hole splitting its surround into simple polygons.
//  - curved shapes (cylinders, tubes, cones, spheres, tori, wires, polyhedra), alone or mixed with
//    those: Add concatenates the shapes (the bricks and polygons are united as above); Insert keeps A
//    whole and lifts B above it (booleanResult); Subtract keeps A and adds B as a cut-out (void
//    primitives: openEMS vacuum above A, see booleanCurved.ts), exact for every shape, with coaxial
//    cylinders and tubes cut exactly into cylinders and tubes; Intersect is exact for coaxial
//    cylinders and tubes, for a tube or cone trimmed by a brick across its axis, for cylinders
//    clipped as prisms along a common axis (a 64-gon, the cylinder itself when the clip leaves its ring
//    untouched), and for a shape inside or outside a brick. Any other intersection is refused with the
//    combination and what to do instead.
// Polygons along different axes are refused with the reason. The result keeps its operands
// (booleanHistory) and is live: it is recomputed from them when parameters change, here on every edit
// (booleanUi.ts) and in python/fairbeam/design.py and boolean_curved.py (with polyclip.py) for builds,
// sweeps and optimisation.
import { worldBoxes, worldPrimitives } from "./geometry.ts";
import { clipPolygons, clipTolerance, type ClipMode, type Ring } from "./polygonClip.ts";
import type { BooleanOperation, Design, DesignPart, DesignPrimitive } from "./types.ts";
import { localeTag, t } from "../i18n/index.ts";
import { FACETS, coaxialRects, cylinderCell, designBounds, facetRing, flatAxis, isP, isTube, isVoid, kindKey, sameRing, shapeContains, snapToSheet, worldShapes } from "./booleanCurved.ts";
import { resolveShape } from "./geometry.ts";

type Bounds = [[number, number], [number, number], [number, number]];
type History = NonNullable<DesignPart["booleanHistory"]>;
const LIMIT = 5000;
const AXES = ["x", "y", "z"] as const;

/** A part's primitives at these values: a live Boolean's recomputed result, else its own. */
export function livePrimitives(part: DesignPart, values: Record<string, number>): DesignPrimitive[] {
  return part.booleanHistory?.live ? materialiseBoolean(part.booleanHistory, values) : part.primitives;
}

function checked(part: DesignPart, primitives: DesignPrimitive[]) {
  if (!primitives.length) throw Error(t("booleanParts.error.noPrimitives", { name: part.name }));
  // cut-outs take their priority from the shapes they cut (the build), so only the solid shapes count
  const priorities = new Set(primitives.filter((p) => !isVoid(p)).map((p) => p.priority));
  if (priorities.size > 1) throw Error(t("booleanParts.error.mixedPriorities", { name: part.name }));
  return primitives;
}

const isPolygon = (p: DesignPrimitive) => p.kind === "polygon" || p.kind === "linpoly";

// ------------------------------------------------------------------ parts of boxes only

function boxes(part: DesignPart, values: Record<string, number>, primitives: DesignPrimitive[]): { shape: "sheet" | "volume"; bounds: Bounds[]; plane?: number } {
  let world: [number[], number[]][];
  try { world = worldBoxes(part, values, primitives); } catch (e) { throw Error(`${part.name}: ${(e as Error).message}.`); }
  const bounds = world.map(([a, b]) => [0, 1, 2].map((k) => [Math.min(a[k], b[k]), Math.max(a[k], b[k])] as [number, number]) as Bounds);
  if (bounds.some(b => b.some(([lo, hi]) => !Number.isFinite(lo) || !Number.isFinite(hi)))) throw Error(t("booleanParts.error.nonFinite", { name: part.name }));
  const zeroAxes = bounds.map(b => b.map(([lo, hi], i) => lo === hi ? i : -1).filter(i => i >= 0));
  if (zeroAxes.some(a => a.length > 1) || zeroAxes.some(a => a.length !== zeroAxes[0].length)) throw Error(t("booleanParts.error.mixed", { name: part.name }));
  const isSheet = zeroAxes[0].length === 1;
  if (isSheet && (zeroAxes.some(a => a[0] !== zeroAxes[0][0]) || bounds.some(b => b[zeroAxes[0][0]][0] !== bounds[0][zeroAxes[0][0]][0]))) throw Error(t("booleanParts.error.notCoplanar", { name: part.name }));
  return { shape: isSheet ? "sheet" : "volume", bounds, ...(isSheet ? { plane: zeroAxes[0][0] } : {}) };
}

/** The operation's name in the messages ("Add", "Subtract", ...): a refusal says what the user chose. */
const opName = (operation: BooleanOperation) => t(`boolean.op.${operation}`);
const sheetVolume = (operation: BooleanOperation) => Error(t("booleanParts.error.sheetVolume", { op: opName(operation) }));

function resolved(a: DesignPart, b: DesignPart, pa: DesignPrimitive[], pb: DesignPrimitive[], values: Record<string, number>, operation: BooleanOperation) {
  const A = boxes(a, values, pa), B = boxes(b, values, pb);
  if (A.shape !== B.shape) throw sheetVolume(operation);
  if (A.shape === "sheet" && A.plane !== B.plane) throw Error(t("booleanParts.error.orientation"));
  if (A.shape === "sheet" && A.bounds[0][A.plane!][0] !== B.bounds[0][B.plane!][0]) throw Error(t("booleanParts.error.samePlane"));
  return { A, B, dims: A.shape === "sheet" ? [0, 1, 2].filter(i => i !== A.plane) : [0, 1, 2] };
}

function partition(A: Bounds[], B: Bounds[], dims: number[], mode: ClipMode) {
  const axes = dims.map(d => [...new Set([...A, ...B].flatMap(b => b[d]))].sort((x, y) => x - y));
  const counts = axes.map(x => x.length - 1);
  const cellCount = counts.reduce((x, y) => x * y, 1);
  if (cellCount > 100_000 || cellCount * (A.length + B.length) > 2_000_000) throw Error(t("booleanParts.error.tooLarge"));
  const occupiedA = (lo: number[], hi: number[]) => A.some(b => dims.every((d, k) => b[d][0] <= lo[k] && b[d][1] >= hi[k]));
  const occupiedB = (lo: number[], hi: number[]) => B.some(b => dims.every((d, k) => b[d][0] <= lo[k] && b[d][1] >= hi[k]));
  let cells: { lo: number[]; hi: number[] }[] = [];
  for (let i = 0; i < counts[0]; i++) for (let j = 0; j < counts[1]; j++) for (let k = 0; k < (counts[2] ?? 1); k++) {
    const ix = [i, j, k].slice(0, dims.length), lo = ix.map((v, n) => axes[n][v]), hi = ix.map((v, n) => axes[n][v + 1]);
    const aa = occupiedA(lo, hi), bb = occupiedB(lo, hi);
    if (mode === "union" ? aa || bb : mode === "subtract" ? aa && !bb : aa && bb) cells.push({ lo, hi });
  }
  // Greedily merge cells sharing a complete face, repeating axes until no merge remains.
  let changed = true;
  while (changed) {
    changed = false;
    for (let d = 0; d < dims.length; d++) {
      const groups = new Map<string, typeof cells>();
      for (const cell of cells) {
        const key = cell.lo.flatMap((v, n) => n === d ? [] : [v, cell.hi[n]]).join(",");
        const group = groups.get(key) ?? [];
        group.push(cell);
        groups.set(key, group);
      }
      cells = [];
      for (const group of groups.values()) {
        group.sort((x, y) => x.lo[d] - y.lo[d]);
        let last: typeof group[number] | undefined;
        for (const cell of group) {
          if (last && last.hi[d] === cell.lo[d]) { last.hi[d] = cell.hi[d]; changed = true; }
          else { cells.push(cell); last = cell; }
        }
      }
    }
  }
  if (cells.length > LIMIT) throw Error(t("booleanParts.error.limit", { limit: LIMIT }));
  return cells;
}

function boxBoolean(a: DesignPart, b: DesignPart, pa: DesignPrimitive[], pb: DesignPrimitive[], values: Record<string, number>, mode: ClipMode, operation: BooleanOperation): DesignPrimitive[] {
  const { A, B, dims } = resolved(a, b, pa, pb, values, operation);
  const priority = pa[0].priority;
  return partition(A.bounds, B.bounds, dims, mode).map((cell) => {
    const lo = [0, 0, 0], hi = [0, 0, 0];
    if (A.shape === "sheet") lo[A.plane!] = hi[A.plane!] = A.bounds[0][A.plane!][0];
    dims.forEach((d, k) => { lo[d] = cell.lo[k]; hi[d] = cell.hi[k]; });
    return { kind: "box" as const, ...(priority === undefined ? {} : { priority }), start: lo as [number, number, number], stop: hi as [number, number, number] };
  });
}

// ------------------------------------------------------------------ parts with polygons

/** A world primitive as a prism along an axis: a box (any axis, axis -1) or a polygon. */
interface Solid { box?: Bounds; axis: number; ring?: Ring; lo: number; hi: number; sheetAxis: number }
interface Prism { ring: Ring; lo: number; hi: number }

function solids(part: DesignPart, values: Record<string, number>, primitives: DesignPrimitive[]): Solid[] {
  let world;
  try { world = worldPrimitives(part, values, primitives); } catch (e) { throw Error(`${part.name}: ${(e as Error).message}.`); }
  return world.map((q): Solid => {
    if (q.kind === "box") {
      const box = [0, 1, 2].map((k) => [Math.min(q.start![k], q.stop![k]), Math.max(q.start![k], q.stop![k])] as [number, number]) as Bounds;
      if (box.some(([lo, hi]) => !Number.isFinite(lo) || !Number.isFinite(hi))) throw Error(t("booleanParts.error.nonFinite", { name: part.name }));
      const zero = [0, 1, 2].filter((k) => box[k][0] === box[k][1]);
      if (zero.length > 1) throw Error(t("booleanParts.error.mixed", { name: part.name }));
      return { box, axis: -1, lo: 0, hi: 0, sheetAxis: zero.length ? zero[0] : -1 };
    }
    const e = q.elevation!, len = q.kind === "linpoly" ? q.length! : 0;
    const lo = Math.min(e, e + len), hi = Math.max(e, e + len);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || q.points!.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) throw Error(t("booleanParts.error.nonFinite", { name: part.name }));
    return { axis: q.normal!, ring: q.points!.map((p) => [p[0], p[1]] as [number, number]), lo, hi, sheetAxis: lo === hi ? q.normal! : -1 };
  });
}

function polygonBoolean(a: DesignPart, b: DesignPart, pa: DesignPrimitive[], pb: DesignPrimitive[], values: Record<string, number>, mode: ClipMode, operation: BooleanOperation): DesignPrimitive[] {
  return polygonSolids([a.name, b.name], solids(a, values, pa), solids(b, values, pb), pa[0].priority, mode, undefined, { operation });
}

/** Whether an operand's round or polygon cuts turn its sheets into polygons (a part of bricks only is then
 * clipped as polygons: the box partition cannot hold them). */
function cutsMakePolygons(part: DesignPart, values: Record<string, number>, primitives: DesignPrimitive[]): boolean {
  if (!part.cuts?.some((c) => (c.kind ?? "rect") !== "rect")) return false;
  try { return worldShapes(part, values, primitives).some((p) => p.kind === "polygon" || p.kind === "linpoly"); } catch { return false; }
}
const needsPolygons = (a: DesignPart, b: DesignPart, pa: DesignPrimitive[], pb: DesignPrimitive[], values: Record<string, number>) =>
  pa.some(isPolygon) || pb.some(isPolygon) || cutsMakePolygons(a, values, pa) || cutsMakePolygons(b, values, pb);

/** A result ring that is an axis-aligned rectangle (four corners, nothing else) as a brick, so a notch filled
 * or a cut that leaves a rectangle gives a brick again; null for any other ring. */
function rectangleBrick(ring: Ring, axis: number, lo: number, hi: number, priority: number | undefined): DesignPrimitive | null {
  if (ring.length !== 4) return null;
  const us = ring.map((p) => p[0]), vs = ring.map((p) => p[1]);
  const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
  if (!(u1 > u0 && v1 > v0)) return null;
  const corners = new Set(ring.map((p) => `${p[0] === u0 ? 0 : p[0] === u1 ? 1 : 2}${p[1] === v0 ? 0 : p[1] === v1 ? 1 : 2}`));
  if (corners.size !== 4 || [...corners].some((c) => c.includes("2"))) return null;
  const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
  const start: [number, number, number] = [0, 0, 0], stop: [number, number, number] = [0, 0, 0];
  start[axis] = lo; stop[axis] = hi; start[u] = u0; stop[u] = u1; start[v] = v0; stop[v] = v1;
  return { kind: "box", ...(priority === undefined ? {} : { priority }), start, stop };
}

/** A world design primitive as a Solid (a brick or a polygon), for the clipping of shapes that are not parts' own. */
function solidOf(name: string, q: DesignPrimitive): Solid {
  if (q.kind === "box") {
    const box = [0, 1, 2].map((k) => [Math.min(Number(q.start[k]), Number(q.stop[k])), Math.max(Number(q.start[k]), Number(q.stop[k]))] as [number, number]) as Bounds;
    const zero = [0, 1, 2].filter((k) => box[k][0] === box[k][1]);
    if (zero.length > 1) throw Error(t("booleanParts.error.mixed", { name }));
    return { box, axis: -1, lo: 0, hi: 0, sheetAxis: zero.length ? zero[0] : -1 };
  }
  if (q.kind === "polygon" || q.kind === "linpoly") {
    const e = Number(q.elevation), len = q.kind === "linpoly" ? Number(q.length) : 0;
    const lo = Math.min(e, e + len), hi = Math.max(e, e + len), normal = AXES.indexOf(q.normal);
    return { axis: normal, ring: q.points.map((p) => [Number(p[0]), Number(p[1])] as [number, number]), lo, hi, sheetAxis: lo === hi ? normal : -1 };
  }
  throw Error(t("booleanParts.error.mixed", { name }));
}

/** The slab clipping of booleanParts' polygons and bricks on ready Solids. `native` may replace a result ring by
 * the shape it came from (a cylinder whose ring the clip left untouched). `axis` is the extrusion axis when the
 * operands have no polygon to give one (bricks only: a sheet's normal, else z); `operation` words the refusals.
 * A sheet minus a volume (Subtract, Insert) is cut with the volume's cross-section at the sheet's plane. A ring
 * that is an axis-aligned rectangle comes out as a brick, when the operands are bricks only. */
function polygonSolids(names: [string, string], SA: Solid[], SB: Solid[], priority: number | undefined, mode: ClipMode, native?: (ring: Ring, lo: number, hi: number, eps: number) => DesignPrimitive | null,
  opts: { axis?: number; operation?: BooleanOperation } = {}): DesignPrimitive[] {
  const operation: BooleanOperation = opts.operation ?? (mode === "union" ? "add" : mode === "intersect" ? "intersect" : "subtract");
  const sheetA = SA[0].sheetAxis >= 0, sheetB = SB[0].sheetAxis >= 0;
  const first = [...SA, ...SB].find((s) => s.axis >= 0);
  const axis = sheetA ? SA[0].sheetAxis : first ? first.axis : opts.axis ?? (sheetB ? SB[0].sheetAxis : 2);
  for (const [name, list] of [[names[0], SA], [names[1], SB]] as const) {
    const other = list.find((s) => s.axis >= 0 && s.axis !== axis);
    if (other) throw Error(t("booleanParts.error.axes", { name, a: AXES[other.axis], b: AXES[axis] }));
    if (list.some((s) => s.sheetAxis >= 0) && list.some((s) => s.sheetAxis < 0)) throw Error(t("booleanParts.error.mixed", { name }));
  }
  const sheet = sheetA;
  // a sheet is cut by the cross-section of a volume; a flat shape cuts nothing from a volume
  const cross = sheetA && !sheetB && mode === "subtract";
  if (sheetA !== sheetB && !cross) throw operation === "subtract" ? Error(t("booleanParts.error.flatCarver", { name: names[1], a: names[0] })) : sheetVolume(operation);
  const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
  const prism = (s: Solid): Prism => s.box
    ? { ring: [[s.box[u][0], s.box[v][0]], [s.box[u][1], s.box[v][0]], [s.box[u][1], s.box[v][1]], [s.box[u][0], s.box[v][1]]], lo: s.box[axis][0], hi: s.box[axis][1] }
    : { ring: s.ring!, lo: s.lo, hi: s.hi };
  const A = SA.map(prism);
  let B = SB.map(prism);
  const eps = clipTolerance([A.map((p) => p.ring), B.map((p) => p.ring)]);
  let zscale = 1;
  for (const p of [...A, ...B]) zscale = Math.max(zscale, Math.abs(p.lo), Math.abs(p.hi));
  const zeps = 1e-9 * zscale;
  const out: DesignPrimitive[] = [];
  // bricks only: a rectangle that comes out is a brick again (with a polygon among the operands it stays a polygon)
  const bricksOnly = [...SA, ...SB].every((s) => s.axis < 0);
  const emit = (ring: Ring, lo: number, hi: number, flat: boolean) => {
    const kept = native ? native(ring, lo, hi, eps) : bricksOnly ? rectangleBrick(ring, axis, lo, hi, priority) : null;
    if (kept) out.push({ ...kept, ...(priority === undefined ? {} : { priority }) });
    else if (flat) out.push({ kind: "polygon", normal: AXES[axis], elevation: lo, points: ring, ...(priority === undefined ? {} : { priority }) });
    else out.push({ kind: "linpoly", normal: AXES[axis], elevation: lo, length: hi - lo, points: ring, ...(priority === undefined ? {} : { priority }) });
  };
  if (sheet) {
    if (SA.some((s) => s.sheetAxis !== axis) || (!cross && SB.some((s) => s.sheetAxis !== axis))) throw Error(t("booleanParts.error.orientation"));
    const plane = A[0].lo;
    if ([...A, ...(cross ? [] : B)].some((p) => Math.abs(p.lo - plane) > zeps)) throw Error(t("booleanParts.error.samePlane"));
    if (cross) B = B.filter((p) => p.lo <= plane + zeps && p.hi >= plane - zeps);
    for (const r of clipPolygons(A.map((p) => p.ring), B.map((p) => p.ring), mode, eps)) emit(r, plane, plane, true);
  } else {
    const zs = [...A, ...B].flatMap((p) => [p.lo, p.hi]).sort((x, y) => x - y);
    const cuts: number[] = [];
    for (const z of zs) if (!cuts.length || z - cuts[cuts.length - 1] > zeps) cuts.push(z);
    const slabs: { key: string; rings: Ring[]; lo: number; hi: number }[] = [];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const lo = cuts[k], hi = cuts[k + 1], zm = (lo + hi) / 2;
      const ra = A.filter((p) => p.lo < zm && p.hi > zm).map((p) => p.ring);
      const rb = B.filter((p) => p.lo < zm && p.hi > zm).map((p) => p.ring);
      const rings = ra.length || mode === "union" ? clipPolygons(ra, rb, mode, eps) : [];
      if (!rings.length) continue;
      const key = JSON.stringify(rings), last = slabs[slabs.length - 1];
      // the same cross-section in the next slab: one taller extrusion
      if (last && last.hi === lo && last.key === key) last.hi = hi;
      else slabs.push({ key, rings, lo, hi });
    }
    for (const s of slabs) for (const r of s.rings) emit(r, s.lo, s.hi, false);
  }
  if (out.length > LIMIT) throw Error(t("booleanParts.error.limit", { limit: LIMIT }));
  return out;
}

// ------------------------------------------------------------------ Subtract: the fewest shapes that stay exact

/** A − B as extruded polygons (sheets: flat polygons, bricks where a ring is a rectangle), along the axis that
 * gives the fewest: the polygons' own axis, else (bricks only) the best of z, x, y. */
function fewestSlabs(names: [string, string], SA: Solid[], SB: Solid[], priority: number | undefined, operation: BooleanOperation): DesignPrimitive[] {
  const sheet = SA[0].sheetAxis >= 0, polygon = [...SA, ...SB].find((s) => s.axis >= 0);
  const axes = sheet ? [SA[0].sheetAxis] : polygon ? [polygon.axis] : [2, 0, 1];
  let best: DesignPrimitive[] | undefined;
  for (const axis of axes) {
    const out = polygonSolids(names, SA, SB, priority, "subtract", undefined, { axis, operation });
    if (!best || out.length < best.length) best = out;
  }
  return best!;
}

/** B's shapes as cut-outs of A's bounding box: a brick is trimmed to it (what lies outside A is not A's to cut),
 * a shape beside it cuts nothing, a polygon stays as it is. */
function trimCutout(p: DesignPrimitive, lo: number[], hi: number[]): DesignPrimitive[] {
  const [plo, phi] = designBounds(p);
  if ([0, 1, 2].some((k) => phi[k] <= lo[k] || plo[k] >= hi[k])) return [];
  if (p.kind !== "box") return [p];
  const start = [0, 1, 2].map((k) => Math.max(Math.min(Number(p.start[k]), Number(p.stop[k])), lo[k])) as [number, number, number];
  const stop = [0, 1, 2].map((k) => Math.min(Math.max(Number(p.start[k]), Number(p.stop[k])), hi[k])) as [number, number, number];
  return [{ ...p, start, stop }];
}

/**
 * B's cut-outs that came through as they are keep B's own shapes, expressions and all, instead of their numbers: a
 * cut-out then follows the parameters it was built from and shows them in its Properties. Only when B has no
 * transforms or cuts of its own (its shapes are then its world shapes, one for one) and the shape was neither trimmed
 * nor moved; a trimmed one (a notch reaching out of A) stays in numbers, recomputed with every edit as before.
 */
function keepSource(b: DesignPart, source: DesignPrimitive[], worldShapes: DesignPrimitive[], out: DesignPrimitive[]): DesignPrimitive[] {
  if (b.transforms?.length || b.cuts?.length || source.length !== worldShapes.length) return out;
  const key = (p: DesignPrimitive) => JSON.stringify(designBounds(p)) + p.kind;
  const strip = (p: DesignPrimitive) => { const { label: _l, void: _v, ...rest } = p as DesignPrimitive & { label?: string }; return JSON.stringify(rest); };
  return out.map((o) => {
    const k = worldShapes.findIndex((w) => (o.kind === "box" ? w.kind === "box" && key(w) === key(o) : strip(w) === strip(o)));
    if (k < 0 || isVoid(source[k])) return o;
    const { priority: _p, ...own } = source[k] as DesignPrimitive & { priority?: number };
    return { ...JSON.parse(JSON.stringify(own)), ...((o as { label?: string }).label ? { label: (o as { label?: string }).label } : {}), void: true } as DesignPrimitive;
  });
}

const labelled = (ps: DesignPrimitive[], label: (k: number) => string): DesignPrimitive[] => ps.map((p, k) => ({ ...p, label: label(k) }));

/**
 * Subtract (and Insert: no cut-outs) of operands of bricks and polygons, as compact as it stays exact:
 *  - sheets: one flat polygon where the notch allows (a hole splits its surround in two); a volume is cut with
 *    its cross-section at the sheet's plane;
 *  - prisms on a common axis: the extruded polygons of the slabs, along the axis giving the fewest;
 *  - else (a pocket, say): A whole plus B as a vacuum cut-out, exactly like a curved Boolean.
 * The representation with the fewest shapes wins (the polygons on a tie); pieces are named after A and its cut-out after B.
 */
function compactSubtract(a: DesignPart, b: DesignPart, pa: DesignPrimitive[], pb: DesignPrimitive[], values: Record<string, number>, operation: BooleanOperation): DesignPrimitive[] {
  const priority = pa[0].priority, names: [string, string] = [a.name, b.name];
  const SA = solids(a, values, pa), SB = solids(b, values, pb);
  let out = fewestSlabs(names, SA, SB, priority, operation);
  if (operation === "subtract" && SA[0].sheetAxis < 0) {
    const WA = world(a, values, pa), WB = world(b, values, pb), [lo, hi] = boundsOf(WA);
    const cutouts = keepSource(b, pb, WB, WB.flatMap((p) => trimCutout(p, lo, hi)));
    if (WA.length + cutouts.length < out.length) return [...stamp(WA, priority), ...labelled(cutouts, () => `${b.name} (cut-out)`).map((p) => ({ ...p, void: true }))];
  }
  if (out.length > 1) out = labelled(out, (k) => `${a.name} (part ${k + 1} of ${out.length})`);
  return out;
}

/** An operand with cut-outs of bricks and polygons as the shapes that remain: its solids less its cut-outs
 * (a shape the cut-outs do not reach stays), for the operations that cannot carry cut-outs. null when it has none
 * or they are curved (the operation then says so). */
function foldedOperand(part: DesignPart, prims: DesignPrimitive[], values: Record<string, number>): { part: DesignPart; prims: DesignPrimitive[] } | null {
  const V = prims.filter(isVoid), S = solidsOf(prims);
  if (!V.length || !S.every(isP) || !V.every(isP)) return null;
  const priority = S[0].priority, WS = world(part, values, S);
  const flat = WS.every((p) => flatAxis(p) >= 0);
  // a flat cut-out removes nothing from a volume; a volume cuts a sheet where it crosses
  const WV = world(part, values, V).filter((p) => flat || flatAxis(p) < 0);
  const left = WV.length ? fewestSlabs([part.name, part.name], WS.map((p) => solidOf(part.name, p)), WV.map((p) => solidOf(part.name, p)), priority, "subtract") : WS;
  if (!left.length) throw Error(t("booleanParts.error.noPrimitives", { name: part.name }));
  const plainPart: DesignPart = { ...part, primitives: left };
  delete plainPart.transforms; delete plainPart.cuts; delete plainPart.booleanHistory;
  return { part: plainPart, prims: left };
}


// ------------------------------------------------------------------ the operation

const MODES: Record<BooleanOperation, ClipMode> = { add: "union", subtract: "subtract", insert: "subtract", intersect: "intersect" };

/** Operands made of bricks and polygons only (no cut-outs): the exact clipping of the sections above. */
const plain = (...lists: DesignPrimitive[][]) => lists.every((l) => l.every((p) => isP(p) && !isVoid(p)));
const solidsOf = (ps: DesignPrimitive[]) => ps.filter((p) => !isVoid(p));

/**
 * The result primitives of A op B (Insert: A − B) at these values, in world coordinates: boxes for
 * parts of boxes, extruded or flat polygons when a polygon is involved, and with curved shapes (or an
 * earlier cut-out) the shapes of curvedBoolean. `lenient` skips the material and priority rules (the
 * preview's intersection highlight).
 */
export function materialiseBoolean(history: Pick<History, "operation" | "A" | "B">, values: Record<string, number>, lenient = false): DesignPrimitive[] {
  const { operation } = history;
  let a = history.A, b = history.B;
  if (!lenient && (operation === "add" || operation === "intersect") && a.material !== b.material) throw Error(t("booleanParts.error.sameMaterial"));
  let pa = checked(a, livePrimitives(a, values)), pb = checked(b, livePrimitives(b, values));
  const priority = solidsOf(pa)[0]?.priority;
  if (!lenient && (operation === "add" || operation === "intersect") && priority !== solidsOf(pb)[0]?.priority) throw Error(t("booleanParts.error.samePriority"));
  const mode = MODES[operation];
  if (!mode) throw Error(t("booleanParts.error.unknownOp", { op: operation }));
  // cut-outs of bricks and polygons (an earlier Subtract) are folded in first, where the operation cannot carry them:
  // Subtract keeps A's own cut-outs, every other operand and operation takes the shapes that remain
  if (operation !== "subtract") { const f = foldedOperand(a, pa, values); if (f) { a = f.part; pa = f.prims; } }
  const folded = foldedOperand(b, pb, values);
  if (folded) { b = folded.part; pb = folded.prims; }
  if (!plain(pa, pb)) return curvedBoolean(a, b, pa, pb, values, operation);
  if (operation === "subtract" || operation === "insert") return compactSubtract(a, b, pa, pb, values, operation);
  if (needsPolygons(a, b, pa, pb, values)) return polygonBoolean(a, b, pa, pb, values, mode, operation);
  return boxBoolean(a, b, pa, pb, values, mode, operation);
}

// ------------------------------------------------------------------ with curved shapes

const stamp = (ps: DesignPrimitive[], priority: number | undefined): DesignPrimitive[] =>
  priority === undefined ? ps : ps.map((p) => (isVoid(p) ? p : { ...p, priority }));
const world = (part: DesignPart, values: Record<string, number>, ps: DesignPrimitive[]): DesignPrimitive[] => {
  try { return worldShapes(part, values, ps); } catch (e) { throw Error(`${part.name}: ${(e as Error).message}.`); }
};
const kindsOf = (ps: DesignPrimitive[]) => [...new Set(ps.map((p) => t(`booleanParts.kind.${kindKey(p)}`)))].join(", ");
const notP = (ps: DesignPrimitive[]) => ps.filter((p) => !isP(p));

/** the (radius, height) rectangles of two coaxial cylinder and tube sets, else null */
function coaxialPair(WA: DesignPrimitive[], WB: DesignPrimitive[]) {
  const ra = coaxialRects(WA), rb = coaxialRects(WB);
  if (!ra || !rb || ra.axis !== rb.axis) return null;
  const tol = 1e-9 * Math.max(1, ...ra.centre.map(Math.abs), ...rb.centre.map(Math.abs));
  return Math.abs(ra.centre[0] - rb.centre[0]) <= tol && Math.abs(ra.centre[1] - rb.centre[1]) <= tol ? { ra, rb } : null;
}
function coaxialBoolean(pair: NonNullable<ReturnType<typeof coaxialPair>>, mode: ClipMode, priority: number | undefined): DesignPrimitive[] {
  const cells = partition(pair.ra.rects, pair.rb.rects, [0, 1], mode);
  return stamp(cells.map((c) => cylinderCell(pair.ra.axis, pair.ra.centre, c.lo[0], c.hi[0], c.lo[1], c.hi[1])), priority);
}

/** A tube or cone clipped to a brick's extent along its axis, when the brick covers the whole disc across. */
function trimmed(R: DesignPrimitive, K: DesignPrimitive): DesignPrimitive[] | null {
  if (K.kind !== "box" || (R.kind !== "cone" && !(R.kind === "cylinder" && "axis" in R))) return null;
  const n = AXES.indexOf(R.axis), [u, v] = [(n + 1) % 3, (n + 2) % 3];
  const [klo, khi] = designBounds(K);
  const rmax = R.kind === "cone" ? Math.max(Number(R.bottom_radius), Number(R.top_radius)) : Number(R.radius);
  const c = [Number(R.center[0]), Number(R.center[1])];
  const tol = 1e-9 * Math.max(1, Math.abs(c[0]), Math.abs(c[1]), rmax);
  if (klo[u] > c[0] - rmax + tol || khi[u] < c[0] + rmax - tol || klo[v] > c[1] - rmax + tol || khi[v] < c[1] + rmax - tol) return null;
  if (klo[n] === khi[n]) throw sheetVolume("intersect");
  const lo0 = Math.min(Number(R.range[0]), Number(R.range[1])), hi0 = Math.max(Number(R.range[0]), Number(R.range[1]));
  const lo = Math.max(lo0, klo[n]), hi = Math.min(hi0, khi[n]);
  if (!(hi > lo)) return [];
  if (R.kind === "cylinder") return [{ ...R, range: [lo, hi] }];
  const rb = Number(R.bottom_radius), rt = Number(R.top_radius), slope = (rt - rb) / (hi0 - lo0);
  const rb2 = Math.max(0, rb + slope * (lo - lo0)), rt2 = Math.max(0, rt + slope * (hi - hi0));
  return rb2 <= 0 && rt2 <= 0 ? [] : [{ ...R, range: [lo, hi], bottom_radius: rb2, top_radius: rt2 }];
}

/** Intersect where cylinders (without a bore) and bricks or polygons share one axis: the cylinders are clipped as 64-gon prisms. */
function facetedIntersect(a: DesignPart, b: DesignPart, WA: DesignPrimitive[], WB: DesignPrimitive[], priority: number | undefined): DesignPrimitive[] | null {
  const all = [...WA, ...WB];
  const cyls = all.filter((p) => p.kind === "cylinder");
  const ok = (p: DesignPrimitive) => (p.kind === "cylinder" ? "axis" in p && !isTube(p) : isP(p));
  if (!cyls.length || !all.every(ok)) return null;
  const polygon = all.find((p) => p.kind === "polygon" || p.kind === "linpoly");
  const axisOf = (c: DesignPrimitive) => AXES.indexOf((c as { axis: "x" | "y" | "z" }).axis);
  const axis = polygon && "normal" in polygon ? AXES.indexOf(polygon.normal) : axisOf(cyls[0]);
  if (cyls.some((c) => axisOf(c) !== axis)) return null;
  const rings: { ring: Ring; centre: [number, number]; radius: number }[] = [];
  const solid = (name: string) => (q: DesignPrimitive): Solid => {
    if (q.kind !== "cylinder") return solidOf(name, q);
    const c = q as unknown as { center: [number, number]; radius: number; range: [number, number] };
    const centre: [number, number] = [Number(c.center[0]), Number(c.center[1])], radius = Number(c.radius);
    const ring = facetRing(centre, radius, FACETS);
    rings.push({ ring, centre, radius });
    const r0 = Number(c.range[0]), r1 = Number(c.range[1]);
    return { axis, ring, lo: Math.min(r0, r1), hi: Math.max(r0, r1), sheetAxis: -1 };
  };
  const SA = WA.map(solid(a.name)), SB = WB.map(solid(b.name));
  const native = (ring: Ring, lo: number, hi: number, eps: number): DesignPrimitive | null => {
    const hit = rings.find((c) => sameRing(ring, c.ring, eps));
    return hit ? cylinderCell(axis, hit.centre, 0, hit.radius, lo, hi) : null;
  };
  return polygonSolids([a.name, b.name], SA, SB, priority, "intersect", native);
}

function boundsOf(ps: DesignPrimitive[]): [number[], number[]] {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of ps) { const [l, h] = designBounds(p); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], l[k]); hi[k] = Math.max(hi[k], h[k]); } }
  return [lo, hi];
}

function intersectCurved(a: DesignPart, b: DesignPart, WA: DesignPrimitive[], WB: DesignPrimitive[], priority: number | undefined): DesignPrimitive[] {
  const pair = coaxialPair(WA, WB);
  if (pair) return coaxialBoolean(pair, "intersect", priority);
  // a tube or cone trimmed by one brick across its axis
  for (const [R, K] of [[WA, WB], [WB, WA]] as const) {
    if (R.length === 1 && K.length === 1) {
      const out = trimmed(R[0], K[0]);
      if (out) return stamp(out, priority);
    }
  }
  const faceted = facetedIntersect(a, b, WA, WB, priority);
  if (faceted) return faceted;
  // a shape inside a brick stays as it is; shapes that cannot meet leave nothing
  const [alo, ahi] = boundsOf(WA), [blo, bhi] = boundsOf(WB);
  const tol = 1e-9 * Math.max(1, ...alo.map(Math.abs), ...ahi.map(Math.abs), ...blo.map(Math.abs), ...bhi.map(Math.abs));
  if ([0, 1, 2].some((k) => Math.min(ahi[k], bhi[k]) < Math.max(alo[k], blo[k]) - tol)) return [];
  const brick = (ps: DesignPrimitive[]) => ps.length === 1 && ps[0].kind === "box" && flatAxis(ps[0]) < 0;
  const within = (lo: number[], hi: number[], klo: number[], khi: number[]) => [0, 1, 2].every((k) => lo[k] >= klo[k] - tol && hi[k] <= khi[k] + tol);
  if (brick(WB) && within(alo, ahi, blo, bhi)) return stamp(WA, priority);
  if (brick(WA) && within(blo, bhi, alo, ahi)) return stamp(WB, priority);
  const all = [...WA, ...WB];
  const why = all.every((p) => p.kind === "cylinder") ? "axes"
    : all.some((p) => p.kind !== "cylinder" && p.kind !== "cone" && !isP(p)) || all.every((p) => !isP(p)) ? "curved"
    : "partial";
  throw Error(t("booleanParts.error.intersectUnsupported", { a: a.name, ka: kindsOf(WA), b: b.name, kb: kindsOf(WB), why: t(`booleanParts.error.intersectWhy.${why}`) }));
}

function curvedBoolean(a: DesignPart, b: DesignPart, pa: DesignPrimitive[], pb: DesignPrimitive[], values: Record<string, number>, operation: BooleanOperation): DesignPrimitive[] {
  const SA = solidsOf(pa), SB = solidsOf(pb), VA = pa.filter(isVoid), VB = pb.filter(isVoid);
  const priority = SA[0].priority;
  if (operation === "subtract" && VB.length) throw Error(t("booleanParts.error.bHasCut", { name: b.name }));
  if ((operation === "add" || operation === "intersect") && (VA.length || VB.length)) throw Error(t("booleanParts.error.hasCut", { name: VA.length ? a.name : b.name, op: t(`boolean.op.${operation}`) }));
  let out: DesignPrimitive[];
  if (operation === "add") {
    const PA = SA.filter(isP), PB = SB.filter(isP);
    out = PA.length && PB.length ? (needsPolygons(a, b, PA, PB, values) ? polygonBoolean(a, b, PA, PB, values, "union", "add") : boxBoolean(a, b, PA, PB, values, "union", "add"))
      : stamp([...(PA.length ? world(a, values, PA) : []), ...(PB.length ? world(b, values, PB) : [])], priority);
    out = [...out, ...stamp([...world(a, values, notP(SA)), ...world(b, values, notP(SB))], priority)];
  } else if (operation === "insert") {
    // A stays whole; B (a part of its own) is lifted above it by booleanResult
    world(b, values, SB);
    out = [...stamp(world(a, values, SA), priority), ...world(a, values, VA)];
  } else {
    const WA = world(a, values, SA), WB = world(b, values, SB);
    if (operation === "intersect") {
      out = intersectCurved(a, b, WA, WB, priority);
    } else {
      const pair = VA.length ? null : coaxialPair(WA, WB);
      if (pair) out = coaxialBoolean(pair, "subtract", priority);
      else out = [...stamp(WA, priority), ...world(a, values, VA), ...keepSource(b, SB, WB, carvers(a, b, WA, WB))];
    }
  }
  if (out.length > LIMIT) throw Error(t("booleanParts.error.limit", { limit: LIMIT }));
  return out;
}

/** B's shapes as cut-outs of A: a flat shape cuts nothing from a solid or a sheet, and what touches a sheet lies exactly on it. */
function carvers(a: DesignPart, b: DesignPart, WA: DesignPrimitive[], WB: DesignPrimitive[]): DesignPrimitive[] {
  const flats = WA.map(flatAxis);
  const sheet = flats.every((n) => n >= 0);
  if (!sheet && flats.some((n) => n >= 0)) throw Error(t("booleanParts.error.mixed", { name: a.name }));
  if (!sheet) {
    if (WB.some((p) => flatAxis(p) >= 0)) throw Error(t("booleanParts.error.flatCarver", { name: b.name, a: a.name }));
    return WB.map((p) => ({ ...p, void: true }));
  }
  if (flats.some((n) => n !== flats[0])) throw Error(t("booleanParts.error.orientation"));
  const n = flats[0], level = (p: DesignPrimitive) => (p.kind === "box" ? Number(p.start[n]) : Number((p as { elevation: number }).elevation));
  if (WA.some((p) => level(p) !== level(WA[0]))) throw Error(t("booleanParts.error.notCoplanar", { name: a.name }));
  return WB.map((p) => {
    if (flatAxis(p) >= 0) throw Error(t("booleanParts.error.flatCarver", { name: b.name, a: a.name }));
    return { ...snapToSheet(p, n, level(WA[0])), void: true };
  });
}

/** A and B overlap (a volume, or an area for sheets, in common) and a Boolean of them is possible. */
export function booleanOverlap(a: DesignPart, b: DesignPart, values: Record<string, number>): boolean {
  try {
    const pa = checked(a, livePrimitives(a, values)), pb = checked(b, livePrimitives(b, values));
    if (plain(pa, pb)) {
      if (needsPolygons(a, b, pa, pb, values)) return polygonBoolean(a, b, pa, pb, values, "intersect", "intersect").length > 0;
      const { A, B, dims } = resolved(a, b, pa, pb, values, "intersect");
      return A.bounds.some(x => B.bounds.some(y => dims.every(i => Math.min(x[i][1], y[i][1]) > Math.max(x[i][0], y[i][0]))));
    }
    return shapesOverlap(world(a, values, solidsOf(pa)), world(b, values, solidsOf(pb)));
  } catch { return false; }
}

/** Shapes overlapping with curved ones: bounding boxes with a positive overlap (an area in one plane for
 * sheets) and, unless both are bricks, a point inside both on a grid in the common box. A sheet and a solid
 * never overlap here (a Boolean cannot combine them). */
function shapesOverlap(X: DesignPrimitive[], Y: DesignPrimitive[]): boolean {
  if (X.length * Y.length > 400) return X.some((x) => Y.some((y) => (flatAxis(x) >= 0) === (flatAxis(y) >= 0) && boundsOverlap(designBounds(x), designBounds(y))));
  const N = 7;
  return X.some((x) => Y.some((y) => {
    const bx = designBounds(x), by = designBounds(y);
    if ((flatAxis(x) >= 0) !== (flatAxis(y) >= 0) || !boundsOverlap(bx, by)) return false;
    if (x.kind === "box" && y.kind === "box") return true;
    const lo = [0, 1, 2].map((k) => Math.max(bx[0][k], by[0][k])), hi = [0, 1, 2].map((k) => Math.min(bx[1][k], by[1][k]));
    const rx = resolveShape(x, {}, 0), ry = resolveShape(y, {}, 0);
    const at = (k: number, i: number) => (hi[k] > lo[k] ? lo[k] + ((i + 0.5) / N) * (hi[k] - lo[k]) : lo[k]);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let l = 0; l < N; l++) {
      const q: [number, number, number] = [at(0, i), at(1, j), at(2, l)];
      if (shapeContains(rx, q) && shapeContains(ry, q)) return true;
    }
    return false;
  }));
}
const boundsOverlap = (x: [number[], number[]], y: [number[], number[]]) => {
  const flat = [0, 1, 2].filter((k) => x[0][k] === x[1][k] || y[0][k] === y[1][k]);
  return flat.length < 2 && [0, 1, 2].every((k) => (flat.includes(k)
    ? Math.max(x[0][k], y[0][k]) <= Math.min(x[1][k], y[1][k]) + 1e-9 * Math.max(1, Math.abs(x[0][k]))
    : Math.min(x[1][k], y[1][k]) > Math.max(x[0][k], y[0][k])));
};

/** What the 3D view shows while a Boolean is set up: the result, or why it cannot be built, and the common volume. */
export function booleanPreview(a: DesignPart, b: DesignPart, operation: BooleanOperation, values: Record<string, number>): { result: DesignPrimitive[]; intersection: DesignPrimitive[]; error?: string; empty?: boolean } {
  let intersection: DesignPrimitive[] = [];
  try { intersection = materialiseBoolean({ operation: "intersect", A: a, B: b }, values, true); } catch { /* shown by the result's error */ }
  try {
    const result = materialiseBoolean({ operation, A: a, B: b }, values);
    return { result, intersection, ...(result.length ? {} : { empty: true }) };
  } catch (e) { return { result: [], intersection, error: (e as Error).message }; }
}

/** The volume (mm³) or, for sheets, the area (mm²) of exact shapes (bricks, polygons and extruded polygons); null for any other shape. */
export function measureShapes(prims: DesignPrimitive[]): { kind: "volume" | "area"; value: number } | null {
  let volume = 0, area = 0;
  const ringArea = (pts: [number, number][]) => Math.abs(pts.reduce((sum, q, i) => sum + q[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * q[1], 0)) / 2;
  for (const p of prims) {
    if (isVoid(p)) continue;
    const r = resolveShape(p, {}, 0);
    if (p.kind === "box" && r.start && r.stop) {
      const d = [0, 1, 2].map((k) => Math.abs(r.stop![k] - r.start![k])).filter((x) => x > 0);
      if (d.length === 3) volume += d[0] * d[1] * d[2]; else if (d.length === 2) area += d[0] * d[1]; else return null;
    } else if (p.kind === "linpoly" && r.points && r.length !== undefined) volume += ringArea(r.points) * Math.abs(r.length);
    else if (p.kind === "polygon" && r.points) area += ringArea(r.points);
    else return null;
  }
  if (volume > 0 && area > 0) return null;
  return area > 0 ? { kind: "area", value: area } : { kind: "volume", value: volume };
}

/** What a Subtract takes out of A: the volume (the area of a sheet) A and B have in common, "none" when they do not touch
 * (nothing is removed), null when it cannot be measured (curved shapes). */
export function removedMeasure(a: DesignPart, b: DesignPart, values: Record<string, number>): { kind: "volume" | "area"; value: number } | "none" | null {
  let common: DesignPrimitive[] = [];
  try { common = materialiseBoolean({ operation: "intersect", A: a, B: b }, values, true); } catch { /* measured below, or not at all */ }
  const m = common.length ? measureShapes(common) : null;
  if (m && m.value > 0) return m;
  // a sheet cut by a volume (no common volume): what the sheet lost is its area before less its area after
  try {
    const result = materialiseBoolean({ operation: "subtract", A: a, B: b }, values);
    if (!result.some(isVoid)) {
      const before = measureShapes(world(a, values, solidsOf(livePrimitives(a, values)))), after = result.length ? measureShapes(result) : { kind: "area" as const, value: 0 };
      if (before && after && before.kind === after.kind || before && !result.length) {
        const lost = before!.value - (after?.value ?? 0);
        if (lost > 1e-9 * Math.max(1, before!.value)) return { kind: before!.kind, value: lost };
        if (lost <= 1e-9 * Math.max(1, before!.value)) return "none";
      }
    }
  } catch { /* not measurable */ }
  return booleanOverlap(a, b, values) ? null : "none";
}

export const BOOLEAN_SYMBOLS: Record<BooleanOperation, string> = { add: "∪", subtract: "−", intersect: "∩", insert: "−" };

/** What a Boolean did, in the toast: the operands, the part the result is (A's, which keeps its material and
 * name: B's solid is merged into it or removed), how many shapes it has and what became of B. A Subtract also says
 * which solid lost which volume (`removed`: removedMeasure), or that nothing was removed. */
export function appliedText(operation: BooleanOperation, a: DesignPart, b: DesignPart, result: DesignPart | undefined, removed?: ReturnType<typeof removedMeasure>): string {
  const titles = { a: a.label || a.name, b: b.label || b.name };
  if (!result?.primitives.length) return t("boolean.applied.empty", { op: opName(operation), ...titles, symbol: BOOLEAN_SYMBOLS[operation] });
  const cutout = operation === "subtract" && result.primitives.some((p) => p.void);
  let removedText = "";
  if (operation === "subtract" && removed !== undefined) {
    if (removed === "none") removedText = t("boolean.removed.none", titles);
    else if (removed) removedText = t(removed.kind === "area" ? "boolean.removed.area" : "boolean.removed.volume", { ...titles, amount: new Intl.NumberFormat(localeTag(), { maximumSignificantDigits: 4 }).format(removed.value) });
  }
  const text = t(cutout ? "boolean.applied.subtractCutout" : `boolean.applied.${operation}`, {
    ...titles, result: result.label || result.name, shapes: t("boolean.shapes", { count: result.primitives.length }), material: a.material, removed: removedText,
  }).replace(/ {2,}/g, " ");
  return text;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
function uniqueName(name: string, parts: DesignPart[]) {
  if (!parts.some(p => p.name === name)) return name;
  let n = 2; while (parts.some(p => p.name === `${name} ${n}`)) n++;
  return `${name} ${n}`;
}

/** The priority a shape has without one of its own: 10 for a metal, 0 for a dielectric (the build's rule). */
function effectivePriority(design: Design, part: DesignPart, p: DesignPrimitive): number {
  return p.priority ?? ((design.materials ?? []).find((m) => m.name === part.material)?.kind === "metal" ? 10 : 0);
}

/** Give B's shapes a priority half a step above A's highest, unless they already have a higher one. */
function liftAbove(design: Design, a: DesignPart, b: DesignPart) {
  const top = Math.max(...a.primitives.filter((p) => !isVoid(p)).map((p) => effectivePriority(design, a, p)));
  const own = Math.min(...b.primitives.filter((p) => !isVoid(p)).map((p) => effectivePriority(design, b, p)));
  if (own > top) return;
  for (const p of b.primitives) if (!isVoid(p)) p.priority = top + 0.5;
}

export function booleanResult(design: Design, values: Record<string, number>, aIndex: number, bIndex: number, operation: BooleanOperation): { parts: DesignPart[]; error?: never } | { parts?: never; error: string } {
  try {
    const a = design.parts[aIndex], b = design.parts[bIndex];
    if (!a || !b || aIndex === bIndex) throw Error(t("booleanParts.error.twoParts"));
    // Insert again of the very shape an Insert result already has in its history: the result follows that shape
    // (it is live), so the history is refreshed rather than stacked on itself, and B stays where it is
    const earlier = a.booleanHistory;
    if (operation === "insert" && earlier?.live && earlier.operation === "insert" && earlier.B.name === b.name) {
      const again: History = { operation, A: clone(earlier.A), B: clone(b), live: true };
      const primitives = materialiseBoolean(again, values);
      const base = clone(a); delete base.transforms; delete base.cuts;
      base.primitives = primitives; base.booleanHistory = again;
      const parts = design.parts.slice();
      if (primitives.length) parts[aIndex] = base; else parts.splice(aIndex, 1);
      return { parts };
    }
    // operands are kept whole, nested Boolean histories included, so a nested result stays live
    const history: History = { operation, A: clone(a), B: clone(b), live: true };
    const primitives = materialiseBoolean(history, values);
    const base = clone(a); delete base.transforms; delete base.cuts;
    base.primitives = primitives;
    base.booleanHistory = history;
    const parts = design.parts.filter((_, i) => i !== bIndex);
    const at = parts.indexOf(a);
    if (primitives.length) parts[at] = base;
    else parts.splice(at, 1);
    if (operation === "insert") {
      const inserted = clone(b); inserted.name = uniqueName(inserted.name, parts);
      // curved shapes are not cut out of A: B simply takes priority over it, half a step above
      if (!plain(livePrimitives(a, values), livePrimitives(b, values))) liftAbove(design, a, inserted);
      parts.push(inserted);
    }
    return { parts };
  } catch (e) { return { error: (e as Error).message }; }
}
