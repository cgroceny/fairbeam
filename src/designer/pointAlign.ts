// Point-to-point alignment (CST "Transform > Translate", from point to point): the solid that owns the
// first pick A moves by B - A in x, y and z. It gains one "move" transform, so the part stays
// editable (its primitives, cuts, parameters and Boolean history are untouched) and Booleans that
// name it keep working.
import { applyTransform } from "./transformModel.ts";
import type { Design } from "./types.ts";

export type Point3 = [number, number, number];

/** B - A, rounded to 1e-5 mm: picked mesh vertices are float32, so 1.6 arrives as 1.5999999. */
export function alignOffset(a: readonly number[], b: readonly number[]): Point3 {
  return [0, 1, 2].map((k) => Math.round((b[k] - a[k]) * 1e5) / 1e5 + 0) as Point3;
}

/** Move the named part by `offset`. Returns the part's index, or -1 when there is no such part.
 * A zero offset changes nothing. Call inside one store edit so it is one undo step. */
export function applyPointAlign(d: Design, partName: string, offset: readonly number[]): number {
  const i = d.parts.findIndex((p) => p.name === partName);
  if (i < 0 || offset.every((v) => v === 0)) return i;
  applyTransform(d, { type: "part", i }, { type: "move", offset: [offset[0], offset[1], offset[2]] });
  return i;
}
