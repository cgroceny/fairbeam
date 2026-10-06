import * as THREE from "three";
import type { PickedPoint, PointPickMode } from "./pointTools";
import { bestSnap } from "./measure.ts";

/** True when `point` is the midpoint of a face diagonal of an exact box (a real edge midpoint has two
 *  coordinates on the box bounds, a diagonal's only one). */
function isBoxDiagonal(hit: THREE.Intersection, point: number[]): boolean {
  const prim = hit.object.userData.primitive as { kind?: string; exact?: boolean; start?: number[]; stop?: number[]; bbox?: number[][] } | undefined;
  if (!prim?.exact || (prim.kind !== "box" && prim.kind !== "bbox")) return false;
  const [lo, hi] = prim.kind === "box" ? [prim.start!, prim.stop!] : prim.bbox!;
  const onBounds = [0, 1, 2].filter((k) => Math.abs(point[k] - lo[k]) < 1e-6 || Math.abs(point[k] - hi[k]) < 1e-6).length;
  return onBounds < 2;
}

/** Resolve one displayed mesh hit into the candidate used by both hover and click. */
export function resolvePointCandidate(
  hit: THREE.Intersection,
  mode: PointPickMode,
  label: string,
): PickedPoint | null {
  const found = resolveCandidate(hit, mode, label);
  const part = hit.object.userData?.part as string | undefined;
  return found && part ? { ...found, part } : found;
}

function resolveCandidate(
  hit: THREE.Intersection,
  mode: PointPickMode,
  label: string,
): PickedPoint | null {
  // Measure: the nearest of the vertex, the edge midpoint and the face center of the hit
  // Alignment picks snap like measure: the nearest vertex, edge midpoint or face / circle centre
  if (mode === "measure" || mode === "align-source" || mode === "align-target") {
    const found = (["vertex", "edge", "face"] as const)
      .map((m) => resolvePointCandidate(hit, m, label))
      .filter((c) => c && c.kind !== "triangle centre")
      // a box face is two triangles: their shared diagonal is no edge of the box
      .filter((c) => !(c && c.kind === "edge midpoint" && isBoxDiagonal(hit, c.point)));
    return bestSnap(found, hit.point.toArray()) ?? resolvePointCandidate(hit, "face", label);
  }
  if (!hit.face || !(hit.object instanceof THREE.Mesh)) return null;
  const obj = hit.object,
    prim = obj.userData.primitive as
      | {
          kind?: string;
          exact?: boolean;
          start?: number[];
          stop?: number[];
          bbox?: number[][];
          radius?: number;
        }
      | undefined;
  const pos = obj.geometry.getAttribute("position"),
    f = hit.face;
  const tri = [f.a, f.b, f.c].map((id) =>
    new THREE.Vector3()
      .fromBufferAttribute(pos, id)
      .applyMatrix4(obj.matrixWorld),
  );
  let point = hit.point.clone(),
    kind: PickedPoint["kind"] = "triangle centre";
  if (mode === "vertex") {
    point = tri.reduce(
      (best, p) =>
        p.distanceTo(hit.point) < best.distanceTo(hit.point) ? p : best,
      tri[0],
    );
    kind = "vertex";
  } else if (mode === "edge") {
    const pairs = [
      [0, 1],
      [1, 2],
      [2, 0],
    ] as const;
    const pair = pairs
      .map(([a, b]) => tri[a].clone().add(tri[b]).multiplyScalar(0.5))
      .reduce((best, p) =>
        p.distanceTo(hit.point) < best.distanceTo(hit.point) ? p : best,
      );
    point = pair;
    kind = "edge midpoint";
  } else {
    const normal = f.normal.clone().transformDirection(obj.matrixWorld),
      exact = prim?.exact;
    if (exact && (prim?.kind === "box" || prim?.kind === "bbox")) {
      const bounds =
        prim.kind === "box" ? [prim.start!, prim.stop!] : prim.bbox!;
      const axis = [0, 1, 2].reduce(
        (a, b) =>
          Math.abs(normal.getComponent(b)) > Math.abs(normal.getComponent(a))
            ? b
            : a,
        0,
      );
      if (Math.abs(normal.getComponent(axis)) > 0.999) {
        point.set(
          (bounds[0][0] + bounds[1][0]) / 2,
          (bounds[0][1] + bounds[1][1]) / 2,
          (bounds[0][2] + bounds[1][2]) / 2,
        );
        point.setComponent(axis, hit.point.getComponent(axis));
        kind = "face centre";
      }
    } else if (exact && prim?.kind === "cylinder") {
      const a = new THREE.Vector3(...prim.start!),
        b = new THREE.Vector3(...prim.stop!),
        axis = b.clone().sub(a).normalize();
      if (Math.abs(normal.dot(axis)) > 0.999) {
        point = normal.dot(axis) > 0 ? b : a;
        kind = "circle centre";
      }
    }
    if (kind === "triangle centre")
      point = tri[0]
        .clone()
        .add(tri[1])
        .add(tri[2])
        .multiplyScalar(1 / 3);
  }
  return { point: point.toArray() as [number, number, number], kind, label };
}
