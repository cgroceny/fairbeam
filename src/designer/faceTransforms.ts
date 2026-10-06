// Face alignment transforms are independent of the 3D hit-testing code. Keeping them separate
// lets the point tools load without pulling three.js into the Start screen bundle.
import type { Axis, DesignTransform } from "./types.ts";

type V3 = [number, number, number];
const AXES: Axis[] = ["x", "y", "z"];

export interface PickedFace {
  part: string;
  /** Mesh primitive type, so tools can identify a face in a part with several primitives. */
  primitiveKind?: string;
  /** world axis of the face normal and the side it faces (+1 / -1) */
  axis: number;
  sign: 1 | -1;
  /** the face's coordinate on its axis */
  value: number;
  /** the face's centre (the exact centre of box faces and caps; else of its outline's bounds) */
  centre: V3;
  /** the face's triangles in world coordinates, for highlighting */
  tris: V3[];
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

/** A right-handed quarter turn about `axis`, applied q times to a direction (maps() convention). */
function turn(v: V3, axis: number, q: number): V3 {
  let out = [...v] as V3;
  const u = (axis + 1) % 3, w = (axis + 2) % 3;
  for (let j = 0; j < ((q % 4) + 4) % 4; j++) {
    const next = [...out] as V3;
    next[u] = -out[w]; next[w] = out[u];
    out = next;
  }
  return out;
}

export type FaceAlignMode = "against" | "flush";

/** The transforms that put the source face against (or flush with) the target face: a quarter or
 * half turn about the source face's centre when the faces are not already parallel the right way,
 * then a move (along the target normal, and in its plane too when `centre`). */
export function faceAlignTransforms(source: PickedFace, target: PickedFace, mode: FaceAlignMode, centre: boolean): DesignTransform[] {
  const ns: V3 = [0, 0, 0], d: V3 = [0, 0, 0];
  ns[source.axis] = source.sign;
  d[target.axis] = mode === "against" ? -target.sign : target.sign;
  const out: DesignTransform[] = [];
  const same = (a: V3, b: V3) => a.every((x, c) => x === b[c]);
  if (!same(ns, d)) {
    let best: { axis: number; q: number } | null = null;
    for (const q of [1, 3, 2]) {
      for (let axis = 0; axis < 3 && !best; axis++) if (same(turn(ns, axis, q), d)) best = { axis, q };
      if (best) break;
    }
    if (!best) throw new Error("no quarter turn aligns these faces");
    out.push({ type: "rotate", axis: AXES[best.axis], center: [...source.centre] as V3, angle: best.q === 3 ? -90 : best.q * 90, copies: 0 });
  }
  const offset: V3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    if (c === target.axis) offset[c] = round(target.value - source.centre[c]);
    else if (centre) offset[c] = round(target.centre[c] - source.centre[c]);
  }
  if (offset.some((x) => x !== 0)) out.push({ type: "move", offset });
  return out;
}
