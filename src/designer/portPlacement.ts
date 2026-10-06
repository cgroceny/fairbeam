// Where a newly added lumped port goes (UX audit 2.2.5): across the nearest gap between two metal
// parts (a probe between a patch and its ground plane) instead of floating at the origin. Pure (no
// Solid, no DOM); store.ts addPort feeds it the metal parts' bounds.
import type { Axis, Vec3 } from "./types";

export type Box = [number[], number[]];
export interface PortPlacement { start: Vec3; stop: Vec3; direction: Axis }

const AXES: Axis[] = ["x", "y", "z"];
const size = (b: Box) => Math.hypot(...b[1].map((v, k) => v - b[0][k]));

function build(k: number, lo: number, hi: number, mid: number[]): PortPlacement {
  const start = [...mid], stop = [...mid];
  start[k] = lo; stop[k] = hi;
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { start: start.map(r) as Vec3, stop: stop.map(r) as Vec3, direction: AXES[k] };
}

/** The port across the smallest gap between two boxes (their extents overlap in the other two axes),
 * from the lower face to the upper one at the centre of the overlap. `anchor` limits the pairs to
 * those with that box (the selected part). With no such gap the port runs from the anchor's edge
 * (else the smallest box's) to the nearest other box's face along their widest separation. Null
 * with fewer than two boxes or no separation at all (touching or overlapping metal). */
export function portPlacement(boxes: Box[], anchor: number | null = null): PortPlacement | null {
  if (boxes.length < 2) return null;
  const tol = 1e-6 * Math.max(1, ...boxes.map(size));
  const ids = anchor !== null && boxes[anchor] ? [anchor] : boxes.map((_, i) => i);
  let best: { gap: number; k: number; lo: number; hi: number; mid: number[] } | null = null;
  for (const i of ids) for (let j = 0; j < boxes.length; j++) {
    if (j === i || (anchor === null && j < i)) continue;
    const a = boxes[i], b = boxes[j];
    for (const k of [2, 0, 1]) {
      const gap = Math.max(b[0][k] - a[1][k], a[0][k] - b[1][k]);
      if (gap <= tol) continue;
      const across = [0, 1, 2].every((m) => m === k || Math.min(a[1][m], b[1][m]) - Math.max(a[0][m], b[0][m]) > -tol);
      if (!across) continue;
      if (!best || gap < best.gap - tol) {
        const mid = [0, 1, 2].map((m) => (Math.max(a[0][m], b[0][m]) + Math.min(a[1][m], b[1][m])) / 2);
        const below = a[0][k] - b[1][k] > tol;
        best = { gap, k, lo: below ? b[1][k] : a[1][k], hi: below ? a[0][k] : b[0][k], mid };
      }
    }
  }
  if (best) return build(best.k, best.lo, best.hi, best.mid);
  // no gap with metal across it: from the edge to the nearest other metal
  const from = anchor !== null && boxes[anchor] ? anchor : boxes.reduce((s, b, i) => size(b) < size(boxes[s]) ? i : s, 0);
  const a = boxes[from];
  let near: { d: number; k: number; lo: number; hi: number } | null = null;
  boxes.forEach((b, j) => {
    if (j === from) return;
    const gaps = [0, 1, 2].map((m) => Math.max(b[0][m] - a[1][m], a[0][m] - b[1][m]));
    const k = gaps.indexOf(Math.max(...gaps));
    if (gaps[k] <= tol) return;
    const d = Math.hypot(...gaps.map((g) => Math.max(g, 0)));
    if (!near || d < near.d) {
      const below = a[0][k] - b[1][k] > tol;
      near = { d, k, lo: below ? b[1][k] : a[1][k], hi: below ? a[0][k] : b[0][k] };
    }
  });
  if (!near) return null;
  const n: { k: number; lo: number; hi: number } = near;
  return build(n.k, n.lo, n.hi, [0, 1, 2].map((m) => (a[0][m] + a[1][m]) / 2));
}
