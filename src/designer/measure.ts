// The Measure tool's math (no DOM): the distance and the per-axis differences of two picked points,
// the text that is copied, and which of the snap candidates under the pointer wins.
export interface Measurement { dx: number; dy: number; dz: number; distance: number }

/** B relative to A: ΔX, ΔY, ΔZ and the straight-line distance, all in mm. */
export function measure(a: readonly number[], b: readonly number[]): Measurement {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  return { dx, dy, dz, distance: Math.hypot(dx, dy, dz) };
}

/** The copied text: the distance with a decimal point whatever the Decimal separator setting is. */
export const copyText = (distance: number) => String(Math.round(distance * 1e4) / 1e4);

/** Snapping weights: the nearest candidate wins, but a vertex beats an edge midpoint and an edge
 *  midpoint beats a face center at a similar distance. */
export const SNAP_WEIGHT: Record<string, number> = { vertex: 1, "edge midpoint": 1.3, "face centre": 1.6 };

/** The candidate with the smallest weighted distance to the hit point (ties: first in the list). */
export function bestSnap<T extends { point: readonly number[]; kind: string }>(candidates: readonly (T | null)[], hit: readonly number[]): T | null {
  let best: T | null = null, bestScore = Infinity;
  for (const c of candidates) {
    if (!c) continue;
    const score = Math.hypot(c.point[0] - hit[0], c.point[1] - hit[1], c.point[2] - hit[2]) * (SNAP_WEIGHT[c.kind] ?? 1.6);
    if (score < bestScore - 1e-12) { best = c; bestScore = score; }
  }
  return best;
}
