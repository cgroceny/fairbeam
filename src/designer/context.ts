import { createSignal } from "solid-js";
import { draft, file, selectionBounds, setSelection } from "./store";
import type { Selection } from "./types";

export type GeometrySelection = Extract<Selection, { type: "part" | "primitive" }>;
export interface ContextTarget {
  selection: GeometrySelection;
  x: number;
  y: number;
  trigger: HTMLElement;
  point?: [number, number, number];
  normal?: [number, number, number];
  /** Other metals along the face normal at `point` (nearest first on each side, one per part):
   * where a lumped port picked there could end. */
  targets?: { part: string; point: [number, number, number]; side: "behind" | "in front"; distance: number }[];
  /** the point is the centre of the part's face (boundsPortTarget), not a pick in the 3D view */
  fromBounds?: boolean;
}

/** Where "Add a lumped port" starts without a picked point (the tree, the menu key in the 3D
 * view): the centre of the part's face across its thinnest axis (a sheet's plane), facing the
 * nearest other metal whose bounds lie straight behind or in front of that centre (a patch faces
 * its ground plane). Up to three metals on that side are offered, nearest first; with none the
 * face looks along +axis and the port dialog offers a stub. Null for a part that is not metal or
 * does not resolve. */
export function boundsPortTarget(i: number): Pick<ContextTarget, "point" | "normal" | "targets" | "fromBounds"> | null {
  const part = draft.parts[i];
  const metal = (name: string | undefined) => draft.materials.find((m) => m.name === name)?.kind === "metal";
  if (!part || !metal(part.material)) return null;
  const b = selectionBounds({ type: "part", i });
  if (!b) return null;
  const extent = [0, 1, 2].map((k) => b[1][k] - b[0][k]);
  const k = extent.indexOf(Math.min(...extent));
  const center = [0, 1, 2].map((a) => (b[0][a] + b[1][a]) / 2) as [number, number, number];
  const size = Math.hypot(...extent);
  const found: NonNullable<ContextTarget["targets"]> = [];
  draft.parts.forEach((q, n) => {
    if (n === i || !metal(q.material)) return;
    const c = selectionBounds({ type: "part", i: n });
    if (!c) return;
    const tol = 1e-6 * Math.max(1, size, Math.hypot(...c[1].map((v, a) => v - c[0][a])));
    // the other metal must lie across the face centre in the two in-plane axes
    if (![0, 1, 2].every((a) => a === k || (c[0][a] <= center[a] + tol && center[a] <= c[1][a] + tol))) return;
    const point = [...center] as [number, number, number];
    if (b[0][k] - c[1][k] > tol) {
      point[k] = c[1][k];
      found.push({ part: q.name, point, side: "behind", distance: b[0][k] - c[1][k] });
    } else if (c[0][k] - b[1][k] > tol) {
      point[k] = c[0][k];
      found.push({ part: q.name, point, side: "in front", distance: c[0][k] - b[1][k] });
    }
  });
  found.sort((x, y) => x.distance - y.distance);
  const side = found[0]?.side ?? "in front";
  const point = [...center] as [number, number, number];
  point[k] = side === "behind" ? b[0][k] : b[1][k];
  const normal = [0, 0, 0] as [number, number, number];
  normal[k] = side === "behind" ? -1 : 1;
  return { point, normal, targets: found.filter((t) => t.side === side).slice(0, 3), fromBounds: true };
}
export const [contextTarget, setContextTarget] = createSignal<ContextTarget | null>(null);
export const [renaming, setRenaming] = createSignal<GeometrySelection | null>(null);

export function openContext(target: ContextTarget): boolean {
  if (!file() || !draft.parts[target.selection.i]) return false;
  setSelection(target.selection);
  setRenaming(null);
  setContextTarget(target);
  return true;
}

export function closeContext(restore = true) {
  const target = contextTarget();
  setContextTarget(null);
  if (restore) target?.trigger.focus();
}
