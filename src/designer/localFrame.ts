import type { Axis, DesignTransform, DesignWcs, Expr, Vec3 } from "./types";
import { evaluate } from "./expr.ts";

/** The work coordinate system (WCS) of the drawing tools. Its origin and orientation are stored on
 * new parts using ordinary design transforms, so saved designs stay in global coordinates and keep
 * parameter expressions. The WCS itself is kept in the design file (`wcs`, see types.ts) so it
 * survives save and reopen. */
export interface LocalFrame {
  /** Translation from local coordinates to the global coordinate system. */
  origin: Vec3;
  /** Exact right-handed quarter turn about the world axis of the work-plane normal. */
  angle: 0 | 90 | 180 | 270;
  /** w points along the negative world axis of the normal (a face that looks towards -x, -y or -z).
   * The local geometry is turned half a turn about the (n+1) axis first: u = e(n+1), v = -e(n+2),
   * w = -e(n). */
  flip?: boolean;
}

export const GLOBAL_FRAME: LocalFrame = { origin: [0, 0, 0], angle: 0 };
const AXES: Axis[] = ["x", "y", "z"];
const QUARTER_TURNS = new Set<number>([0, 90, 180, 270]);

/** Check the editable frame without normalizing it, so valid parameter expressions stay intact. */
export function validateLocalFrame(frame: LocalFrame, names: Record<string, number>): boolean {
  if (!frame || !Array.isArray(frame.origin) || frame.origin.length !== 3 || !QUARTER_TURNS.has(frame.angle)) return false;
  if (frame.flip !== undefined && typeof frame.flip !== "boolean") return false;
  try {
    for (const value of frame.origin) {
      if (typeof value !== "number" && typeof value !== "string") return false;
      if (!Number.isFinite(evaluate(value, names))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** CSXCAD order: u = (normal + 1) % 3, v = (normal + 2) % 3. */
export function localPlaneAxes(normal: Axis): [Axis, Axis] {
  const i = AXES.indexOf(normal);
  return [AXES[(i + 1) % 3], AXES[(i + 2) % 3]];
}

function literalZero(value: Expr): boolean {
  if (typeof value === "number") return value === 0;
  return /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[eE][+-]?\d+)?$/.test(value.trim());
}

/** Whether the frame is exactly the identity without evaluating parameter expressions. */
export function isGlobalFrame(frame: LocalFrame): boolean {
  return frame.angle === 0 && !frame.flip && frame.origin.every(literalZero);
}

/** Part transforms implementing world = translation(origin) x rotation(angle) x flip(local). The
 * rotations precede the move in the array because transforms are applied in order by the design format. */
export function frameTransforms(frame: LocalFrame, normal: Axis): DesignTransform[] {
  const out: DesignTransform[] = [];
  if (frame.flip) out.push({ type: "rotate", axis: AXES[(AXES.indexOf(normal) + 1) % 3], center: [0, 0, 0], angle: 180, copies: 0 });
  if (frame.angle !== 0) out.push({ type: "rotate", axis: normal, center: [0, 0, 0], angle: frame.angle, copies: 0 });
  if (frame.origin.some((x) => !literalZero(x))) out.push({ type: "move", offset: [...frame.origin] as Vec3 });
  return out;
}

function evaluatedOrigin(frame: LocalFrame, names: Record<string, number>): [number, number, number] {
  return frame.origin.map((value) => evaluate(value, names)) as [number, number, number];
}

function rotatePair(u: number, v: number, angle: LocalFrame["angle"]): [number, number] {
  if (angle === 90) return [-v, u];
  if (angle === 180) return [-u, -v];
  if (angle === 270) return [v, -u];
  return [u, v];
}

function unrotatePair(u: number, v: number, angle: LocalFrame["angle"]): [number, number] {
  if (angle === 90) return [v, -u];
  if (angle === 180) return [-u, -v];
  if (angle === 270) return [-v, u];
  return [u, v];
}

/** Local (unrotated) coordinates to the world offset from the frame origin. */
function orient(local: [number, number, number], n: number, frame: Pick<LocalFrame, "angle" | "flip">): [number, number, number] {
  const ua = (n + 1) % 3, va = (n + 2) % 3;
  const l: [number, number, number] = [...local];
  if (frame.flip) { l[va] = -l[va]; l[n] = -l[n]; }
  const [ru, rv] = rotatePair(l[ua], l[va], frame.angle);
  l[ua] = ru; l[va] = rv;
  return l;
}

/** Inverse of `orient`. */
function unorient(world: [number, number, number], n: number, frame: Pick<LocalFrame, "angle" | "flip">): [number, number, number] {
  const ua = (n + 1) % 3, va = (n + 2) % 3;
  const l: [number, number, number] = [...world];
  const [u, v] = unrotatePair(l[ua], l[va], frame.angle);
  l[ua] = u; l[va] = v;
  if (frame.flip) { l[va] = -l[va]; l[n] = -l[n]; }
  return l;
}

/** Map local work-plane coordinates and its normal elevation into global XYZ. */
export function localToWorldPoint(
  normal: Axis,
  elevation: number,
  u: number,
  v: number,
  frame: LocalFrame,
  names: Record<string, number>,
): [number, number, number] {
  const n = AXES.indexOf(normal), [ua, va] = localPlaneAxes(normal).map((a) => AXES.indexOf(a)) as [number, number];
  const origin = evaluatedOrigin(frame, names);
  const local: [number, number, number] = [0, 0, 0];
  local[n] = elevation; local[ua] = u; local[va] = v;
  const d = orient(local, n, frame);
  return [origin[0] + d[0], origin[1] + d[1], origin[2] + d[2]];
}

/** Inverse of localToWorldPoint, returning only the in-plane coordinates. */
export function worldToLocalPlanePoint(
  normal: Axis,
  world: [number, number, number],
  frame: LocalFrame,
  names: Record<string, number>,
): [number, number] {
  const [ua, va] = localPlaneAxes(normal).map((a) => AXES.indexOf(a)) as [number, number];
  const local = worldToLocalPoint(normal, world, frame, names);
  return [local[ua], local[va]];
}

/** Inverse of the frame mapping for all three coordinates. */
export function worldToLocalPoint(
  normal: Axis,
  world: [number, number, number],
  frame: LocalFrame,
  names: Record<string, number>,
): [number, number, number] {
  const origin = evaluatedOrigin(frame, names);
  return unorient([world[0] - origin[0], world[1] - origin[1], world[2] - origin[2]], AXES.indexOf(normal), frame);
}

/** Global normal-axis value of a local work plane. */
export function worldPlaneValue(normal: Axis, elevation: number, frame: LocalFrame, names: Record<string, number>): number {
  return evaluatedOrigin(frame, names)[AXES.indexOf(normal)] + (frame.flip ? -elevation : elevation);
}

// ------------------------------------------------------------------ the WCS as u, v, w

export type NumVec = [number, number, number];
type Basis = [NumVec, NumVec, NumVec];

/** u, v, w as global unit vectors (integers) for a work-plane normal and frame orientation. */
export function frameBasis(normal: Axis, frame: Pick<LocalFrame, "angle" | "flip">): Basis {
  const n = AXES.indexOf(normal);
  const dir = (axis: number): NumVec => {
    const l: [number, number, number] = [0, 0, 0];
    l[axis] = 1;
    return orient(l, n, frame).map((x) => Math.round(x) + 0) as NumVec;
  };
  return [dir((n + 1) % 3), dir((n + 2) % 3), dir(n)];
}

const sameBasis = (a: Basis, b: Basis) => a.every((v, i) => v.every((x, k) => x === b[i][k]));

/** The (normal, angle, flip) whose u, v, w are exactly this basis. All 24 proper axis-aligned
 * orientations are covered; null for anything else. */
export function orientationOfBasis(basis: Basis): { normal: Axis; angle: LocalFrame["angle"]; flip: boolean } | null {
  for (const normal of AXES) for (const flip of [false, true]) for (const angle of [0, 90, 180, 270] as const) {
    if (sameBasis(frameBasis(normal, { angle, flip }), basis)) return { normal, angle, flip };
  }
  return null;
}

const cosSin = (quarterTurns: number): [number, number] => [[1, 0], [0, 1], [-1, 0], [0, -1]][((quarterTurns % 4) + 4) % 4] as [number, number];
const combine = (a: NumVec, b: NumVec, ca: number, cb: number): NumVec => [0, 1, 2].map((k) => ca * a[k] + cb * b[k]) as NumVec;

/** Rotate the WCS about its own u, v or w axis by whole quarter turns (right-handed, as CST does).
 * The new orientation as (normal, angle, flip). */
export function rotateOrientation(normal: Axis, frame: Pick<LocalFrame, "angle" | "flip">, about: "u" | "v" | "w", quarterTurns: number) {
  const [u, v, w] = frameBasis(normal, frame);
  const [c, s] = cosSin(quarterTurns);
  let next: Basis;
  if (about === "w") next = [combine(u, v, c, s), combine(u, v, -s, c), w];
  else if (about === "u") next = [u, combine(v, w, c, s), combine(v, w, -s, c)];
  else next = [combine(u, w, c, -s), v, combine(u, w, s, c)];
  return orientationOfBasis(next);
}

const termSum = (a: Expr, b: Expr): Expr => {
  if (typeof a === "number" && typeof b === "number") return Math.round((a + b) * 1e6) / 1e6;
  if (literalZero(b)) return a;
  if (literalZero(a)) return b;
  if (typeof b === "number" && b < 0) return `${a} - ${-b}`;
  return `${a} + ${b}`;
};
const negateExpr = (e: Expr): Expr => typeof e === "number" ? (e === 0 ? 0 : -e) : literalZero(e) ? 0 : `-(${e})`;

/** Move the WCS origin by (du, dv, dw) along its own axes. Parameter expressions stay expressions. */
export function moveOrigin(origin: Vec3, normal: Axis, frame: Pick<LocalFrame, "angle" | "flip">, delta: [Expr, Expr, Expr]): Vec3 {
  const basis = frameBasis(normal, frame);
  return origin.map((o, k) => {
    let out: Expr = o;
    basis.forEach((dir, i) => {
      if (dir[k] === 0 || literalZero(delta[i])) return;
      out = termSum(out, dir[k] > 0 ? delta[i] : negateExpr(delta[i]));
    });
    return out;
  }) as Vec3;
}

/** Display name of a local axis: the local axis letter x, y or z, seen from a work plane with this
 * normal, is w (the normal), u = (n+1) or v = (n+2). */
export function wcsAxisName(axis: Axis, normal: Axis, upper = false): string {
  const name = (["w", "u", "v"] as const)[(AXES.indexOf(axis) - AXES.indexOf(normal) + 3) % 3];
  return upper ? name.toUpperCase() : name;
}

export type WcsTransformError = "angle" | "orientation" | "value";

/** CST: WCS > Transform WCS. Move the origin by (du, dv, dw) along the current u, v, w, then rotate
 * about u, then about v, then about w (each about the axes as the previous turn left them). Turns
 * are whole quarter turns because the geometry stays axis aligned; a turn that cannot be expressed
 * (never the case for multiples of 90 degrees) or an unevaluable value is reported, not applied. */
export function transformedWcs(
  from: DesignWcs,
  move: [Expr, Expr, Expr],
  rotate: [Expr, Expr, Expr],
  names: Record<string, number>,
): { wcs: DesignWcs } | { error: WcsTransformError } {
  try {
    for (const m of move) if (!Number.isFinite(evaluate(m, names))) return { error: "value" };
  } catch { return { error: "value" }; }
  let normal = from.normal, angle = from.angle, flip = !!from.flip;
  const origin = moveOrigin(from.origin, normal, { angle, flip }, move);
  for (const [k, about] of (["u", "v", "w"] as const).entries()) {
    let degrees: number;
    try { degrees = evaluate(rotate[k], names); } catch { return { error: "value" }; }
    if (!Number.isFinite(degrees)) return { error: "value" };
    const turns = degrees / 90;
    if (Math.abs(turns - Math.round(turns)) > 1e-9) return { error: "angle" };
    if (Math.round(turns) % 4 === 0) continue;
    const next = rotateOrientation(normal, { angle, flip }, about, Math.round(turns));
    if (!next) return { error: "orientation" };
    ({ normal, angle, flip } = next);
  }
  return { wcs: { normal, origin, angle, ...(flip ? { flip: true } : {}) } };
}
