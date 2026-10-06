// Default shapes for the ribbon's Shapes buttons: on the work plane (WCS), sized from the design;
// these are the defaults a shape dialog gets when Esc is pressed instead of picking points.
import type { Axis, DesignPrimitive, Expr } from "../types";
import { designScale, draft, file, type ShapeKind } from "../store";
import { lastShapeMaterial, pickShapeMaterial, rememberShapeMaterial as remember } from "../shapeMaterial";
import { addExpr, captureDrawingFrame, height, plane, setShapeRequest } from "../draw";
import { evaluate } from "../expr";
import { designChecks } from "../checks";
import { checkMessage } from "../checkText";
import { localeTag } from "../../i18n";

const AXES: Axis[] = ["x", "y", "z"];

function vec(n: Axis, elev: Expr, u: Expr, v: Expr): [Expr, Expr, Expr] {
  const out: [Expr, Expr, Expr] = [0, 0, 0];
  const i = AXES.indexOf(n);
  out[i] = elev;
  const p = plane();
  out[(i + 1) % 3] = addExpr(p.originU ?? 0, u);
  out[(i + 2) % 3] = addExpr(p.originV ?? 0, v);
  return out;
}

const nonZero = (e: Expr) => {
  try {
    return Math.abs(evaluate(e, {})) > 1e-12;
  } catch {
    return true; // an expression over the parameters: keep it
  }
};

/** Shape kinds the shape dialog edits: every Shapes button. */
export const DIALOG_KINDS: ShapeKind[] = ["box", "cylinder", "sphere", "polygon", "linpoly", "cone", "torus", "wire"];

/** A new shape at the work-plane origin, sized from the design; null for kinds without a dialog.
 * Solids stand on the work plane and extend along its normal: by the WCS height when it is set,
 * else by a length from the design (a solid cannot be a sheet). */
export function defaultPrimitive(kind: ShapeKind): DesignPrimitive | null {
  const { normal: n, elevation: e, originU: ou = 0, originV: ov = 0 } = plane();
  const a = designScale();
  const h = a / 2;
  const thick: Expr = nonZero(height()) ? height() : h;
  const long: Expr = nonZero(height()) ? height() : a;
  switch (kind) {
    case "box": return { kind, start: vec(n, e, -h, -h), stop: vec(n, addExpr(e, thick), h, h) };
    case "cylinder": return { kind, axis: n, center: [ou ?? 0, ov ?? 0], radius: a / 4, inner_radius: 0, range: [e, addExpr(e, long)] };
    case "sphere": return { kind, center: vec(n, addExpr(e, a / 4), 0, 0), radius: a / 4 };
    case "polygon": return { kind, normal: n, elevation: e, points: [[addExpr(ou, -h), addExpr(ov, -h)], [addExpr(ou, h), addExpr(ov, -h)], [ou, addExpr(ov, h)]] };
    case "linpoly": return { kind, normal: n, elevation: e, length: thick, points: [[addExpr(ou, -h), addExpr(ov, -h)], [addExpr(ou, h), addExpr(ov, -h)], [addExpr(ou, h), addExpr(ov, h)], [addExpr(ou, -h), addExpr(ov, h)]] };
    case "cone": return { kind, axis: n, center: [ou ?? 0, ov ?? 0], bottom_radius: a / 4, top_radius: 0, range: [e, addExpr(e, long)] };
    // the ring lies parallel to the plane, resting on it: its centre one tube radius above
    case "torus": return { kind, axis: n, center: vec(n, addExpr(e, a / 20), 0, 0), major_radius: a / 4, minor_radius: a / 20 };
    case "wire": return { kind, points: [vec(n, e, 0, 0), vec(n, addExpr(e, long), 0, 0)], radius: a / 50 };
    default: return null;
  }
}

/** Open the shape dialog for a Shapes button; false when that kind has no dialog. */
export function openShapeDialog(kind: ShapeKind): boolean {
  const prim = defaultPrimitive(kind);
  if (!prim) return false;
  const capturedFrame = captureDrawingFrame();
  const transforms = capturedFrame.transforms;
  // a new solid, whatever is selected: adding into a solid is picked in the dialog
  setShapeRequest({ prim, into: -1, drawn: false, ...(capturedFrame.local ? { frameTransforms: transforms, frame: capturedFrame.frame, frameNormal: capturedFrame.normal } : {}) });
  return true;
}

/** Kinds whose geometry the dialog validates with the design checks (src/designer/checks.ts), so
 * the dialog refuses exactly what the Checks list would flag after OK: polygon topology (fewer
 * than 3 distinct points, zero area, a crossing outline), cone radii and lengths, torus radii and
 * wire points. Bricks, cylinders and spheres keep the dialog's own field-named messages. */
const CHECKED: ReadonlySet<DesignPrimitive["kind"]> = new Set(["polygon", "linpoly", "cone", "torus", "wire"]);

/** Geometry errors the design checks report for this new shape, as sentences; values that do not
 * evaluate are left to the dialog's own message. */
export function checkedShapeProblems(prim: DesignPrimitive): string[] {
  if (!CHECKED.has(prim.kind)) return [];
  const candidate = {
    ...draft,
    parts: [{ name: "__shape", material: draft.materials?.[0]?.name ?? "", primitives: [prim] }],
    ports: [], resistors: [],
  };
  const where = "parts[0].primitives[0]";
  return designChecks(candidate)
    .filter((c) => c.severity === "error" && c.code !== "expr" && (c.path === where || c.path.startsWith(`${where}.`)))
    .map((c) => checkMessage(c))
    // "i" capitalises to "İ" in Turkish
    .map((m) => `${m.charAt(0).toLocaleUpperCase(localeTag())}${m.slice(1)}.`)
    .filter((m, k, all) => all.indexOf(m) === k);
}

/** The material a new shape starts with, on every creation path (see shapeMaterial.ts): the metal used last in this
 * design, else its first metal, else `fallback` (a new metal). */
export function defaultShapeMaterial(fallback: string): string {
  return pickShapeMaterial(draft.materials ?? [], lastShapeMaterial(file()?.id), fallback);
}
/** Remember the material a new solid was made with (per design, until the app closes). */
export function rememberShapeMaterial(name: string) { remember(file()?.id, name); }
export { pickShapeMaterial };
