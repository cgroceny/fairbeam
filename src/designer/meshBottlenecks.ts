import type { Bundle, Part } from "../types.ts";

export const MESH_AXES = ["x", "y", "z"] as const;
export type MeshAxis = (typeof MESH_AXES)[number];
export interface AxisBottleneck {
  axis: MeshAxis;
  minIndex: number;
  minWidth: number;
  minInterval: [number, number];
  ratioIndex: number | null;
  ratio: number;
  ratioCoordinates: [number, number, number] | null;
  addedCellsPerLine: number;
}
export interface MeshBottlenecks {
  axes: AxisBottleneck[];
  worst: AxisBottleneck | null;
  unitMm: number;
}
export interface MeshHighlight { source: Bundle; axis: MeshAxis; index: number; intervals: 1 | 2 }

// Browser-only provenance, intentionally not part of the saved project format. validateBundle
// retains bundle identity. A successful server preview is a new, unmarked bundle.
const carriedMeshes = new WeakSet<Bundle>();
export function markCarriedMesh(b: Bundle): Bundle { carriedMeshes.add(b); return b; }
export function meshMatchesGeometry(b: Bundle): boolean { return !carriedMeshes.has(b); }

/** Indices refer to the original stored lines, not display-thinned lines. Ties choose the first. */
export function meshBottlenecks(b: Bundle | null | undefined): MeshBottlenecks | null {
  if (!b || !(Number.isFinite(b.mesh.total_cells) && b.mesh.total_cells > 0)) return null;
  const grids = MESH_AXES.map(a => b.mesh[a]);
  const unit = b.units?.length_m ?? 1e-3;
  if (!(Number.isFinite(unit) && unit > 0) || grids.some(g => g.length < 2
    || g.some((x, i) => !Number.isFinite(x) || (i > 0 && x <= g[i - 1])))) return null;
  const axes = grids.map((g, a): AxisBottleneck => {
    let minIndex = 0, ratioIndex: number | null = null, ratio = 1;
    for (let i = 0; i < g.length - 1; i++) {
      const width = g[i + 1] - g[i];
      if (width < g[minIndex + 1] - g[minIndex]) minIndex = i;
      if (i < g.length - 2) {
        const next = g[i + 2] - g[i + 1], r = Math.max(width / next, next / width);
        if (ratioIndex === null || r > ratio) { ratio = r; ratioIndex = i; }
      }
    }
    return { axis: MESH_AXES[a], minIndex, minWidth: g[minIndex + 1] - g[minIndex],
      minInterval: [g[minIndex], g[minIndex + 1]], ratioIndex, ratio,
      ratioCoordinates: ratioIndex === null ? null : [g[ratioIndex], g[ratioIndex + 1], g[ratioIndex + 2]],
      addedCellsPerLine: (grids[(a + 1) % 3].length - 1) * (grids[(a + 2) % 3].length - 1) };
  });
  const eligible = axes.filter(a => a.ratioIndex !== null);
  return { axes, worst: eligible.reduce<AxisBottleneck | null>((best, a) => !best || a.ratio > best.ratio ? a : best, null), unitMm: unit * 1000 };
}

/** A world-space bounding-box face near a selected line is only a candidate, never mesher provenance. */
export function likelyMeshSources(b: Bundle, axis: MeshAxis, index: number, intervals: 1 | 2): Part[] {
  if (!meshMatchesGeometry(b)) return [];
  const lines = b.mesh[axis], coordinates = lines.slice(index, index + intervals + 1);
  if (coordinates.length !== intervals + 1) return [];
  const a = MESH_AXES.indexOf(axis);
  const tolerance = Math.max(1e-10, (coordinates[coordinates.length - 1] - coordinates[0]) * 0.05);
  return b.parts.filter(p => !p.void && !["ProbeBox", "DumpBox", "Excitation"].includes(p.type)
    && p.bbox?.length === 2 && p.bbox.every(v => v.length === 3 && v.every(Number.isFinite))
    && p.bbox[0].every((v, i) => v <= p.bbox[1][i])
    && coordinates.some(x => p.bbox.some(face => Math.abs(face[a] - x) <= tolerance)));
}

/** A perpendicular plane exposes the interval as a strip, rather than hiding it along the normal. */
export function bottleneckPlane(b: Bundle, axis: MeshAxis, candidate?: Part): { axis: MeshAxis; index: number } {
  const normal = axis === "z" ? "y" : "z", a = MESH_AXES.indexOf(normal), lines = b.mesh[normal];
  const middle = candidate ? (candidate.bbox[0][a] + candidate.bbox[1][a]) / 2 : (lines[0] + lines[lines.length - 1]) / 2;
  let index = 0;
  lines.forEach((x, i) => { if (Math.abs(x - middle) < Math.abs(lines[index] - middle)) index = i; });
  return { axis: normal, index };
}

/** Recenter every coordinate after a deliberate jump, including the formerly panned cross axis. */
export function bottleneckTarget(b: Bundle, h: MeshHighlight, normal: MeshAxis, planeIndex: number): [number, number, number] {
  const candidates = likelyMeshSources(b, h.axis, h.index, h.intervals);
  const p = candidates.length === 1 ? candidates[0] : undefined;
  const target = MESH_AXES.map((axis, i) => {
    const lines = b.mesh[axis], lo = lines[0], hi = lines[lines.length - 1];
    const middle = p ? (p.bbox[0][i] + p.bbox[1][i]) / 2 : (lo + hi) / 2;
    return Math.max(lo, Math.min(hi, middle));
  }) as [number, number, number];
  target[MESH_AXES.indexOf(h.axis)] = (b.mesh[h.axis][h.index] + b.mesh[h.axis][h.index + h.intervals]) / 2;
  target[MESH_AXES.indexOf(normal)] = b.mesh[normal][planeIndex];
  return target;
}

/** Exact highlighted interval/pair edges on the currently shown mesh plane, before display thinning. */
export function meshHighlightSegments(b: Bundle, h: MeshHighlight | null, normal: MeshAxis, planeIndex: number): number[] {
  if (!h || h.source !== b || h.axis === normal || !meshBottlenecks(b)) return [];
  const a = MESH_AXES.indexOf(h.axis), n = MESH_AXES.indexOf(normal), other = 3 - a - n;
  const bounds = b.mesh[h.axis].slice(h.index, h.index + h.intervals + 1), plane = b.mesh[normal][planeIndex];
  if (h.index < 0 || bounds.length !== h.intervals + 1 || !Number.isFinite(plane)) return [];
  const cross = b.mesh[MESH_AXES[other]], lo = cross[0], hi = cross[cross.length - 1], points: number[] = [];
  const at = (x: number, y: number) => { const p = [0, 0, 0]; p[a] = x; p[n] = plane; p[other] = y; return p; };
  for (const x of bounds) points.push(...at(x, lo), ...at(x, hi));
  for (const y of [lo, hi]) points.push(...at(bounds[0], y), ...at(bounds[bounds.length - 1], y));
  return points;
}
