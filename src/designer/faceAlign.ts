// Face alignment (#66): pick a planar face of a part, then a target face; the part turns by
// quarter turns (when the faces are not parallel) and moves so the picked face lies against the
// target (face to face) or flush with it (coplanar, same facing), optionally centred on it. Only
// faces along x, y or z are supported: box faces, sheets, polygon and extrusion faces along an
// axis, and the flat caps of cylinders and cones. The result is ordinary exact transforms.
import * as THREE from "three";
import type { PickedFace } from "./faceTransforms.ts";
export { faceAlignTransforms } from "./faceTransforms.ts";
export type { FaceAlignMode, PickedFace } from "./faceTransforms.ts";

type V3 = [number, number, number];
type MatrixRows = number[][];

const round = (x: number) => Math.round(x * 1e6) / 1e6;

function readAffine(value: unknown): THREE.Matrix4 | null {
  if (!Array.isArray(value) || value.length !== 4 || value.some((row) => !Array.isArray(row) || row.length !== 4
    || row.some((x) => typeof x !== "number" || !Number.isFinite(x)))) return null;
  const m = value as MatrixRows;
  if (Math.abs(m[3][0]) > 1e-12 || Math.abs(m[3][1]) > 1e-12 || Math.abs(m[3][2]) > 1e-12 || Math.abs(m[3][3] - 1) > 1e-12) return null;
  const determinant = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-30) return null;
  return new THREE.Matrix4().set(...m.flat() as [number, number, number, number, number, number, number, number,
    number, number, number, number, number, number, number, number]);
}

function mappedAxis(axis: number, wrapper: THREE.Matrix4 | null, object: THREE.Matrix4): THREE.Vector3 | null {
  const v = new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
  if (wrapper) v.transformDirection(wrapper);
  v.transformDirection(object);
  return [v.x, v.y, v.z].every(Number.isFinite) && v.lengthSq() > 0 ? v.normalize() : null;
}

/** The planar, axis-aligned face under a ray hit; "curved" or "slanted" when not supported. */
export function resolveFaceCandidate(hit: THREE.Intersection, rayDirection: THREE.Vector3): PickedFace | "curved" | "slanted" | null {
  if (!hit.face || !(hit.object instanceof THREE.Mesh)) return null;
  const obj = hit.object;
  const part = obj.userData.part as string | undefined;
  if (!part) return null;
  const source = obj.userData.primitive as {
    kind?: string; exact?: boolean; start?: number[]; stop?: number[]; bbox?: number[][]; axis?: number;
    primitive?: { kind?: string; exact?: boolean; start?: number[]; stop?: number[]; bbox?: number[][]; axis?: number };
    matrix?: unknown;
  } | undefined;
  const transformed = source?.kind === "transformed";
  const prim = transformed ? source?.primitive : source;
  if (transformed && !prim) return "slanted";
  const wrapper = transformed ? readAffine(source?.matrix) : null;
  if (transformed && !wrapper) return "slanted";
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
  const n = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
  if (![n.x, n.y, n.z].every(Number.isFinite) || n.lengthSq() < 1e-24) return "slanted";
  const k = [0, 1, 2].reduce((a, b) => (Math.abs(n.getComponent(b)) > Math.abs(n.getComponent(a)) ? b : a), 0);
  const kind = prim?.kind;
  if (kind === "sphere" || kind === "wire") return "curved";
  if ((kind === "cylinder" || kind === "cylindricalshell") && prim?.start && prim.stop) {
    const d = prim.stop.map((x, c) => x - prim.start![c]);
    const len = Math.hypot(...d);
    if (!(len > 0) || !d.every(Number.isFinite)) return "slanted";
    const direction = new THREE.Vector3(d[0] / len, d[1] / len, d[2] / len);
    if (wrapper) direction.transformDirection(wrapper);
    direction.transformDirection(obj.matrixWorld);
    if (direction.lengthSq() < 1e-24) return "slanted";
    if (Math.abs(direction.dot(n)) < 0.999) return "curved";
  }
  if (kind === "rotpoly" && Number.isInteger(prim?.axis) && prim!.axis! >= 0 && prim!.axis! <= 2) {
    const direction = mappedAxis(prim!.axis!, wrapper, obj.matrixWorld);
    if (!direction) return "slanted";
    if (Math.abs(direction.dot(n)) < 0.999) return "curved";
  }
  if (Math.abs(n.getComponent(k)) < 0.999) return "slanted";
  // the side that faces the viewer (sheets are one surface with two sides)
  const sign: 1 | -1 = rayDirection.getComponent(k) < 0 ? 1 : -1;
  const pos = obj.geometry.getAttribute("position");
  const index = obj.geometry.getIndex();
  const vtx = (i: number) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
  let value = (vtx(hit.face.a).getComponent(k) + vtx(hit.face.b).getComponent(k) + vtx(hit.face.c).getComponent(k)) / 3;
  const tol = 1e-5 * Math.max(1, Math.abs(value));
  const tris: V3[] = [];
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  const count = index ? index.count : pos.count;
  for (let t = 0; t + 2 < count; t += 3) {
    const vs = [0, 1, 2].map((j) => vtx(index ? index.getX(t + j) : t + j));
    if (!vs.every((v) => Math.abs(v.getComponent(k) - value) <= tol)) continue;
    for (const v of vs) {
      tris.push(v.toArray() as V3);
      for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], v.getComponent(c)); hi[c] = Math.max(hi[c], v.getComponent(c)); }
    }
  }
  if (!tris.length) return "slanted";
  const centre = [0, 1, 2].map((c) => (lo[c] + hi[c]) / 2) as V3;
  centre[k] = value;
  return { part, primitiveKind: kind, axis: k, sign, value: round(value), centre: centre.map(round) as V3, tris };
}
