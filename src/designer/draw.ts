// Drawing with the mouse in the 3D view (the designer's draw tools). The view (src/scene/drawOverlay.ts)
// turns pointer positions into points on the work plane; this module holds the tool state and
// turns finished points into design primitives, parametric where it can: the work plane's
// elevation is kept as the expression it came from (e.g. "h", the top of the substrate), so a
// sheet drawn there follows the substrate thickness. Points typed as coordinates keep their
// expressions too ("W/2, L/2", "@w, 0").
//
// A finished shape goes through the shape dialog (src/designer/dialogs/ShapeDialog.tsx) when
// "confirm drawn shapes" is on (the default), else straight into the design.
import { createMemo, createRoot, createSignal } from "solid-js";
import type { Axis, DesignPart, DesignPrimitive, DesignTransform, DesignWcs, Expr, Vec3 } from "./types";
import { unwrap } from "solid-js/store";
import { defaultPartName, draft, edit, file, names, selectAddedGeometry, setMessage } from "./store";
import { lastShapeMaterial, pickShapeMaterial, rememberShapeMaterial } from "./shapeMaterial";
import { evaluate } from "./expr";
import { shown as fmt } from "./displayNumber.ts";
import { readGeneralSettings, writeGeneralSettings } from "../lib/generalSettings";
import { t } from "../i18n";
import {
  frameBasis, frameTransforms as transformsForFrame, isGlobalFrame, localToWorldPoint, worldPlaneValue,
  validateLocalFrame, wcsAxisName, worldToLocalPoint, type LocalFrame,
} from "./localFrame";
import type { PickedFace } from "./faceTransforms.ts";

export type DrawTool = "brick" | "cylinder" | "polygon";
export type DrawEscapeAction = "leave" | "step-back" | "none";
/** What Esc does with a drawing tool armed (cancel() does it): with no point placed it leaves the
 * tool; otherwise it steps back, from the height to the base, else by removing the last point (the
 * first point too, staying in the tool), so a second Esc then leaves. */
export function drawEscapeAction(active: DrawTool | null, pointCount: number, inHeightStep: boolean): DrawEscapeAction {
  if (!active) return "none";
  if (inHeightStep || pointCount > 0) return "step-back";
  return "leave";
}
export type DrawEnterAction = "open-dialog" | "finish" | "none";
/** What Enter does with a drawing tool armed (outside the height step, where it finishes the
 * extrusion): before the first point it opens the tool's shape dialog with default values, with a
 * polygon of three or more points it closes the polygon. */
export function drawEnterAction(active: DrawTool | null, pointCount: number): DrawEnterAction {
  if (!active) return "none";
  if (pointCount === 0) return "open-dialog";
  return active === "polygon" && pointCount >= 3 ? "finish" : "none";
}
/** The shape a drawing tool makes (its shape dialog's kind). */
export const toolShape = (active: DrawTool): "box" | "cylinder" | "polygon" => (active === "brick" ? "box" : active);
export interface WorkPlane { normal: Axis; /** stored as given: a number or an expression */ elevation: Expr; originU: Expr; originV: Expr }
/** A placed point: its value on the plane and the expressions it keeps (numbers when clicked). */
export interface DrawPoint {
  u: number; v: number; eu: Expr; ev: Expr;
  /** typed relative to the previous point: the offsets as typed */
  rel?: [Expr, Expr];
  /** typed as a cylinder radius */
  r?: Expr;
}

// ------------------------------------------------------------------ preferences (per viewer)

const PREFS_KEY = "fairbeam.designer.draw";
interface Prefs { confirm: boolean; corner: boolean; midpoint: boolean; edge: boolean; wcs: boolean }
const PREF_DEFAULTS: Prefs = { confirm: true, corner: true, midpoint: true, edge: true, wcs: true };
function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return { ...PREF_DEFAULTS, ...raw, confirm: readGeneralSettings().confirmShapes };
  } catch {
    return { ...PREF_DEFAULTS };
  }
}
const [prefs, setPrefsSignal] = createSignal<Prefs>(loadPrefs());
function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]) {
  setPrefsSignal((p) => ({ ...p, [k]: v }));
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs()));
    if (k === "confirm") writeGeneralSettings({ ...readGeneralSettings(), confirmShapes: Boolean(v) });
  } catch { /* private window: keep it for this session only */ }
}
/** open the shape dialog when a drawn shape is finished; off: add it at once */
export const confirmShapes = () => prefs().confirm;
export const setConfirmShapes = (v: boolean) => setPref("confirm", v);
/** show the local WCS (its u, v, w arrows) in the 3D view */
export const wcsVisible = () => prefs().wcs;
export const setWcsVisible = (v: boolean) => setPref("wcs", v);
export type SnapKind = "corner" | "midpoint" | "edge";
export const snapTo = (k: SnapKind) => prefs()[k];
export const setSnapTo = (k: SnapKind, v: boolean) => setPref(k, v);

// ------------------------------------------------------------------ tool state

export const [tool, setTool] = createSignal<DrawTool | null>(null);
const GLOBAL_WCS: DesignWcs = { normal: "z", origin: [0, 0, 0], angle: 0 };
/** The work coordinate system: the design's `wcs`, the global one when it has none. It is saved with
 * the design and goes through the undo history. */
export const wcs = (): DesignWcs => draft.wcs ?? GLOBAL_WCS;
/** The drawing plane is the WCS' u-v plane: w is its normal, and the elevation is always 0 (the WCS
 * origin carries the offset). */
export const plane = createRoot(() => createMemo<WorkPlane>(() => ({ normal: wcs().normal, elevation: 0, originU: 0, originV: 0 })));
/** The WCS origin and quarter turn as the frame the drawing tools map through. New framed geometry
 * stores it on its own part as ordinary transforms. */
export const localFrame = createRoot(() => createMemo<LocalFrame>(() => {
  const w = wcs();
  return { origin: [...w.origin] as Vec3, angle: w.angle, ...(w.flip ? { flip: true } : {}) };
}));
export const localFrameActive = () => !isGlobalFrame(localFrame());
/** The frame transform captured when a new drawn shape is finished. */
export const drawingFrameTransforms = () => transformsForFrame(localFrame(), plane().normal);
/** Freeze the frame used by a shape dialog so later UI edits cannot change its preview or picks. */
export function captureDrawingFrame() {
  const frame = structuredClone(localFrame());
  const normal = plane().normal;
  /** a WCS other than the global one: dialogs show u, v, w and keep picks in its coordinates */
  const local = normal !== "z" || !isGlobalFrame(frame);
  return { frame, normal, local, transforms: transformsForFrame(frame, normal) };
}
/** The global point represented by local drawing coordinates. */
export function drawPointToWorld(u: number, v: number, elevation = planeValue()): [number, number, number] {
  try {
    const nm = names().names, frame = localFrame();
    if (!validateLocalFrame(frame, nm)) return [NaN, NaN, NaN];
    return localToWorldPoint(plane().normal, elevation, u, v, frame, nm);
  }
  catch { return [NaN, NaN, NaN]; }
}
/** Convert a picked world point into this work plane's local coordinates. */
export function worldPointToDrawLocal(point: [number, number, number]): [number, number, number] {
  try {
    const nm = names().names, frame = localFrame();
    if (!validateLocalFrame(frame, nm)) return [NaN, NaN, NaN];
    return worldToLocalPoint(plane().normal, point, frame, nm);
  }
  catch { return [NaN, NaN, NaN]; }
}
/** Normal-axis value of the plane for world-space projection and geometry snapping. */
export function drawingPlaneWorldValue(): number {
  try {
    const nm = names().names, frame = localFrame();
    if (!validateLocalFrame(frame, nm)) return NaN;
    return worldPlaneValue(plane().normal, planeValue(), frame, nm);
  }
  catch { return NaN; }
}
/** grid snap in mm (0: off) */
export const [snap, setSnap] = createSignal(1);
/** extrusion along the plane normal: 0 draws a sheet (brick, polygon, circle: a flat circle is built as a polygon) */
export const [height, setHeight] = createSignal<Expr>(0);
const [drawn, setDrawn] = createSignal<DrawPoint[]>([]);
const [heightPending, setHeightPending] = createSignal(false);
const [heightPreview, setHeightPreview] = createSignal<Expr>(0);
/** Whether the completed base is waiting for its extrusion height. */
export const heightStep = heightPending;
/** Current preview height while entering the extrusion. */
export const heightDraft = heightPreview;
export const setHeightDraft = (value: Expr) => setHeightPreview(value);
/** points placed so far, with the expressions they keep */
export const drawnPoints = drawn;
/** points placed so far, in plane coordinates (u, v) */
export const points = (): [number, number][] => drawn().map((p) => [p.u, p.v]);
/** replace the placed points by clicked (numeric) ones; setPoints([]) clears them */
export const setPoints = (pts: [number, number][]) => setDrawn(pts.map(([u, v]) => ({ u, v, eu: round(u), ev: round(v) })));

/** A shape waiting in the shape dialog: drawn (points finished) or from a Shapes button. */
export interface ShapeRequest {
  prim: DesignPrimitive;
  /** part to add into; always -1 (a new solid) as offered: adding into a solid is the user's explicit pick in the dialog */
  into: number;
  drawn: boolean;
  /** Captured local-frame transforms for drawn geometry; these always require a new part. Present
   * with `frame` and `frameNormal` whenever the WCS is not the global one (even when it adds no
   * transform: a yz plane at the origin), so the dialog shows u, v, w. */
  frameTransforms?: DesignTransform[];
  /** Frame snapshot used to convert picked global points back into the dialog's local coordinates. */
  frame?: LocalFrame;
  frameNormal?: Axis;
}
export const [shapeRequest, setShapeRequest] = createSignal<ShapeRequest | null>(null);
/** the shape the open dialog describes, drawn as an outline in the 3D view */
export const [ghost, setGhostPrimitive] = createSignal<DesignPrimitive | null>(null);
export const [ghostFrameTransforms, setGhostFrameTransforms] = createSignal<DesignTransform[]>([]);
export function setGhost(prim: DesignPrimitive | null, transforms: DesignTransform[] = []) {
  setGhostPrimitive(prim);
  setGhostFrameTransforms(transforms);
}
/** "Pick face": the next click on a part face in the 3D view sets the work plane */
export const [facePicking, setFacePicking] = createSignal(false);
/** Pick a planar face to extrude it into a new part. */
export const [extrudeFacePicking, setExtrudeFacePicking] = createSignal(false);

const AXES: Axis[] = ["x", "y", "z"];
/** in-plane axes of a plane with normal n, in CSXCAD order: u = (n+1)%3, v = (n+2)%3 */
export const planeAxes = (n: Axis): [Axis, Axis] => {
  const i = AXES.indexOf(n);
  return [AXES[(i + 1) % 3], AXES[(i + 2) % 3]];
};
/** The Transform WCS dialog is open */
export const [wcsDialog, setWcsDialog] = createSignal(false);
/** The WCS is the global one: u, v, w are x, y, z and nothing is offset or turned. */
export const wcsIsGlobal = () => plane().normal === "z" && !localFrameActive();
const sameWcs = (a: DesignWcs | null, b: DesignWcs | null) => JSON.stringify(a) === JSON.stringify(b);
/** Make `next` the work coordinate system (null: the global one). One undo step; points placed so far
 * are dropped because they were in the old system. */
export function setWcs(next: DesignWcs | null, label?: string) {
  if (!draft.schema) return;
  const clean = next && !(next.normal === "z" && isGlobalFrame({ origin: next.origin, angle: next.angle, flip: next.flip })) ? {
    normal: next.normal, origin: [...next.origin] as DesignWcs["origin"], angle: next.angle, ...(next.flip ? { flip: true } : {}),
  } : null;
  const current = (unwrap(draft.wcs) as DesignWcs | undefined) ?? null;
  if (sameWcs(clean, current)) return;
  edit((d) => { if (clean) d.wcs = clean; else delete d.wcs; }, "", label ?? t("history.wcs")); // no key: every WCS change is its own undo step
  setDrawn([]);
}
/** Align the WCS with the global coordinates: u, v, w
 * are x, y, z and the origin is 0. Shapes already drawn stay where they are. */
export function resetWcsToGlobal() {
  setWcs(null, t("history.wcsGlobal"));
}
/** Move the WCS origin to a world point (a picked point), keeping its orientation. */
export function setWcsOrigin(point: [number, number, number]) {
  if (!point.every(Number.isFinite)) return;
  setWcs({ ...wcs(), origin: point.map(round) as DesignWcs["origin"] }, t("history.wcsMove"));
}
/** (u, v, w) of a world point in the current WCS (the status bar's cursor readout). */
export function worldToWcs(point: [number, number, number]): [number, number, number] | null {
  try {
    const nm = names().names, frame = localFrame();
    if (!validateLocalFrame(frame, nm)) return null;
    const l = worldToLocalPoint(plane().normal, point, frame, nm), n = AXES.indexOf(plane().normal);
    return [l[(n + 1) % 3], l[(n + 2) % 3], l[n]].map((x) => (Math.abs(x) < 1e-9 ? 0 : x)) as [number, number, number]; // no "-0.00"
  } catch { return null; }
}
/** The name of a local axis letter in the current WCS: u, v, w while it is local, else x, y, z. */
export const axisName = (axis: Axis, upper = false): string => wcsIsGlobal() ? (upper ? axis.toUpperCase() : axis) : wcsAxisName(axis, plane().normal, upper);

export const planeValue = createRoot(() => createMemo(() => {
  try {
    return evaluate(plane().elevation, names().names);
  } catch {
    return NaN;
  }
}));

/** What to click with each tool, in the current language (getters: read at render). */
export const HINTS: Readonly<Record<DrawTool, string>> = {
  get brick() { return t("draw.hint.brick"); },
  get cylinder() { return t("draw.hint.cylinder"); },
  get polygon() { return t("draw.hint.polygon"); },
};

/** Arm a drawing tool (null: leave drawing). Arming or leaving always starts from no points, so a
 * tool armed again never shows the points of an earlier attempt. */
export function startTool(t: DrawTool | null) {
  setHeightPending(false);
  setHeightPreview(0);
  setDrawn([]);
  setTool(t);
}

/** Esc (drawEscapeAction): back from the height to the base, else remove the last point, else
 * leave the tool. */
export function cancel() {
  if (heightPending()) { setHeightPending(false); setHeightPreview(0); if (tool() !== "polygon") setDrawn((p) => p.slice(0, 1)); return; }
  if (drawn().length) setDrawn((p) => p.slice(0, -1));
  else startTool(null);
}

export function undoPoint() {
  if (heightPending()) { cancel(); return; }
  setDrawn((p) => p.slice(0, -1));
}

// ------------------------------------------------------------------ work-plane presets and faces

interface FaceLevel { part: string; label: string; elevation: Expr; value: number }

const sum = (a: Expr, b: Expr): Expr => (typeof a === "number" && typeof b === "number" ? a + b : `${a} + ${b}`);

/** Faces of the design perpendicular to `normal`, with the expression they are defined by and the
 * part they belong to (duplicates kept). */
function faceLevels(normal: Axis): FaceLevel[] {
  if (!draft.schema) return [];
  const n = AXES.indexOf(normal);
  const out: FaceLevel[] = [];
  const add = (part: string, label: string, e: Expr | undefined) => {
    if (e === undefined || e === null || e === "") return;
    try {
      out.push({ part, label, elevation: e, value: evaluate(e, names().names) });
    } catch { /* an unfinished expression: skip */ }
  };
  // "bottom" / "top" along z, "x min" / "x max" along x and y
  const [lo, hi] = normal === "z" ? [t("draw.face.bottom"), t("draw.face.top")] : [`${normal} min`, `${normal} max`];
  const sheet = t("draw.face.sheet");
  for (const part of draft.parts) {
    const name = part.label || part.name;
    for (const pr of part.primitives) {
      if (pr.kind === "box") {
        add(part.name, `${name}: ${pr.start[n] === pr.stop[n] ? sheet : lo}`, pr.start[n]);
        add(part.name, `${name}: ${hi}`, pr.stop[n]);
      } else if ((pr.kind === "polygon" || pr.kind === "linpoly") && pr.normal === normal) {
        add(part.name, `${name}: ${pr.kind === "polygon" ? sheet : lo}`, pr.elevation);
        if (pr.kind === "linpoly") add(part.name, `${name}: ${hi}`, sum(pr.elevation, pr.length));
      } else if (pr.kind === "cylinder" && "axis" in pr && pr.axis === normal) {
        add(part.name, `${name}: ${lo}`, pr.range[0]);
        add(part.name, `${name}: ${hi}`, pr.range[1]);
      }
    }
  }
  return out;
}

/** The elevation expression of a face at `value` along `normal`: the design's own expression
 * when a primitive defines it (the picked part's first), else the number. */
export function faceElevation(normal: Axis, value: number, part: string | null): { elevation: Expr; label: string } {
  const tol = 1e-5 * Math.max(1, Math.abs(value)); // picked faces come from float32 vertices
  const levels = faceLevels(normal).filter((f) => Math.abs(f.value - value) <= tol);
  const hit = levels.find((f) => f.part === part) ?? levels[0];
  if (hit) return { elevation: hit.elevation, label: hit.label };
  return { elevation: round(value), label: `${normal} = ${fmt(value)}` };
}

/** Align WCS with face: the origin goes to the face centre and w along its outward normal;
 * u points along +x (along +y on a face looking along x), v completes the right-handed set. The face's own elevation
 * expression is kept for the origin, so a WCS on "Substrate: top" follows the substrate height. */
export function alignWcsWithFace(face: PickedFace) {
  const normal = AXES[face.axis];
  const f = faceElevation(normal, face.value, face.part);
  const origin = face.centre.map((c, i) => (i === face.axis ? f.elevation : round(c))) as DesignWcs["origin"];
  const flip = face.sign < 0;
  // u along +x (along +y on a face looking along x): the turn about w that makes the axes read naturally
  const wantU = normal === "x" ? [0, 1, 0] : [1, 0, 0];
  const angle = ([0, 90, 180, 270] as const).find((a) => frameBasis(normal, { angle: a, flip })[0].join() === wantU.join()) ?? 0;
  setWcs({ normal, origin, angle, ...(flip ? { flip: true } : {}) }, t("history.wcsFace", { face: f.label }));
  setFacePicking(false);
  setDrawn([]);
  setMessage({ tone: "good", text: t("draw.wcsAligned", { face: f.label, w: `${face.sign < 0 ? "-" : "+"}${normal}` }) });
}

// ------------------------------------------------------------------ expressions of points

const round = (x: number) => Math.round(x * 1e6) / 1e6;
/** a + b, kept readable: numbers are added, zeros dropped, "a - 3" rather than "a + -3" */
export const addExpr = (a: Expr, b: Expr): Expr => {
  if (typeof a === "number" && typeof b === "number") return round(a + b);
  if (b === 0 || b === "0") return a;
  if (a === 0 || a === "0") return b;
  if (typeof b === "number" && b < 0) return `${a} - ${-b}`;
  return `${a} + ${b}`;
};
const plus = addExpr;
const ev = (e: Expr) => {
  try {
    return evaluate(e, names().names);
  } catch {
    return NaN;
  }
};
const isZero = (e: Expr) => Math.abs(ev(e)) < 1e-12;
/** "12.5" -> 12.5, anything else stays an expression (trimmed) */
export const toExpr = (text: string): Expr => {
  const t = text.trim();
  return t !== "" && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : t;
};

/** A 3-vector with `elev` on the normal axis and u, v on the plane axes. */
function vec(n: Axis, elev: Expr, u: Expr, v: Expr): [Expr, Expr, Expr] {
  const out: [Expr, Expr, Expr] = [0, 0, 0];
  const i = AXES.indexOf(n);
  out[i] = elev;
  out[(i + 1) % 3] = typeof u === "number" ? round(u) : u;
  out[(i + 2) % 3] = typeof v === "number" ? round(v) : v;
  return out;
}

function primitiveFor(t: DrawTool, pts: DrawPoint[]): DesignPrimitive | null {
  const { normal: n, elevation: e } = plane();
  const h = heightDraft();
  if (t === "brick") {
    const [a, b] = pts;
    if (Math.abs(a.u - b.u) < 1e-9 || Math.abs(a.v - b.v) < 1e-9) return null;
    const [u0, u1] = a.u <= b.u ? [a.eu, b.eu] : [b.eu, a.eu];
    const [v0, v1] = a.v <= b.v ? [a.ev, b.ev] : [b.ev, a.ev];
    const [lo, hi] = ev(h) < 0 ? [plus(e, h), e] : [e, plus(e, h)];
    return { kind: "box", start: vec(n, lo, u0, v0), stop: vec(n, hi, u1, v1) };
  }
  if (t === "cylinder") {
    const [c, rim] = pts;
    const rv = Math.hypot(rim.u - c.u, rim.v - c.v);
    if (!(rv > 1e-9)) return null;
    // a typed radius, or a typed offset along one in-plane axis, stays an expression
    let r: Expr = round(rv);
    if (rim.r !== undefined) r = rim.r;
    else if (rim.rel) {
      const [du, dv] = rim.rel;
      if (isZero(dv) && ev(du) > 0) r = du;
      else if (isZero(du) && ev(dv) > 0) r = dv;
    }
    const top = isZero(h) ? e : plus(e, h); // height 0: a flat circle (design.resolve_primitive builds it as a polygon sheet)
    const range: [Expr, Expr] = ev(top) < ev(e) ? [top, e] : [e, top];
    return { kind: "cylinder", axis: n, center: [c.eu, c.ev], radius: r, inner_radius: 0, range };
  }
  const ring = pts.filter((p, k) => k === 0 || Math.hypot(p.u - pts[k - 1].u, p.v - pts[k - 1].v) > 1e-9);
  if (ring.length > 3 && Math.hypot(ring[0].u - ring[ring.length - 1].u, ring[0].v - ring[ring.length - 1].v) < 1e-9) ring.pop();
  if (ring.length < 3) return null;
  const uv = ring.map((p) => [p.eu, p.ev] as [Expr, Expr]);
  if (isZero(h)) return { kind: "polygon", normal: n, elevation: e, points: uv };
  const negative = ev(h) < 0;
  return { kind: "linpoly", normal: n, elevation: negative ? plus(e, h) : e,
    length: negative ? (typeof h === "number" ? -h : `-(${h})`) : h, points: uv };
}

// ------------------------------------------------------------------ adding shapes

export const unique = (base: string, taken: string[]) => {
  if (!taken.includes(base)) return base;
  for (let k = 2; ; k++) if (!taken.includes(`${base}${k}`)) return `${base}${k}`;
};
/** The name a new part with this shape gets: the shape in the UI language with the first free
 * number ("Brick 1", "Kutu 1"), store.defaultPartName. */
export const newPartName = (kind: DesignPrimitive["kind"]) => defaultPartName(kind);

/** material value that makes a new metal ("copper") for the new part: the metal used last, else the first metal, else a new copper */
export const NEW_METAL = "";
export interface ShapeTarget {
  /** part to add into; -1: a new part */
  into: number;
  /** the new part's name */
  name?: string;
  /** the new part's material; NEW_METAL or undefined: the metal used last, else the first metal, else a new copper */
  material?: string;
  /** Captured local-frame transforms; framed geometry must be a new part. */
  transforms?: DesignTransform[];
}

/** Add a shape in one undo step, into an existing part or as a new part, and select it. */
export function insertShape(prim: DesignPrimitive, t: ShapeTarget) {
  if (!t.transforms?.length && t.into >= 0 && draft.parts[t.into]) {
    const into = t.into;
    edit((d) => { d.parts[into].primitives.push(prim); });
    selectAddedGeometry({ type: "primitive", i: into, j: draft.parts[into].primitives.length - 1 });
    return;
  }
  edit((d) => {
    let mat = t.material && d.materials.some((m) => m.name === t.material) ? t.material : undefined;
    if (!mat && !t.material) mat = pickShapeMaterial(d.materials, lastShapeMaterial(file()?.id), "") || undefined;
    if (!mat) {
      mat = unique("copper", d.materials.map((m) => m.name));
      d.materials.push({ name: mat, kind: "metal" });
    }
    rememberShapeMaterial(file()?.id, mat);
    const part: DesignPart = {
      name: t.name?.trim() ? unique(t.name.trim(), d.parts.map((p) => p.name)) : defaultPartName(prim.kind, d.parts.flatMap((p) => [p.name, p.label ?? ""])), material: mat,
      primitives: [prim], ...(t.transforms?.length ? { transforms: structuredClone(t.transforms) } : {}),
    };
    d.parts.push(part);
  });
  selectAddedGeometry({ type: "primitive", i: draft.parts.length - 1, j: 0 });
}

/** Finish the shape: a new solid with the design's metal (never into whatever is selected: a cutter or a feed
 * drawn next to a solid must not join it); through the shape dialog, where adding into a solid can be picked,
 * when "confirm drawn shapes" is on. */
export function commit(pts = drawn()) {
  const active = tool();
  if (!active || heightPending()) return;
  const baseValid = active === "brick" ? pts.length >= 2 && Math.abs(pts[0].u - pts[1].u) >= 1e-9 && Math.abs(pts[0].v - pts[1].v) >= 1e-9
    : active === "cylinder" ? pts.length >= 2 && Math.hypot(pts[1].u - pts[0].u, pts[1].v - pts[0].v) > 1e-9
      : primitiveFor(active, pts) !== null;
  if (!baseValid) { setMessage({ tone: "warn", text: t("draw.noArea") }); return; }
  setHeightPreview(height());
  setHeightPending(true);
}

/** Finish the extrusion. Invalid or zero geometry follows the shape dialog's shared validation. */
export function finishHeight(value?: Expr) {
  if (!heightPending()) return;
  if (value !== undefined) setHeightPreview(value);
  const active = tool();
  if (!active) { startTool(null); return; }
  const prim = primitiveFor(active, drawn());
  const capturedFrame = captureDrawingFrame();
  const transforms = capturedFrame.transforms;
  if (!confirmShapes() && !validateLocalFrame(capturedFrame.frame, names().names)) {
    setMessage({ tone: "warn", text: t("draw.localFrame.invalid") });
    return;
  }
  setHeightPending(false);
  setDrawn([]);
  if (!prim) {
    setMessage({ tone: "warn", text: t("draw.noArea") });
    return;
  }
  const into = -1;
  // The shape is finished: leave the drawing mode. OK in the dialog, or the shape added at once,
  // then ends with the new part selected and no tool left to cancel with Esc.
  startTool(null);
  const frameInfo = capturedFrame.local ? { frameTransforms: transforms, frame: capturedFrame.frame, frameNormal: capturedFrame.normal } : {};
  if (confirmShapes()) setShapeRequest({ prim, into, drawn: true, ...frameInfo });
  else insertShape(prim, { into, transforms });
}

/** A point clicked (or typed) in the view: place it, and finish when the tool has what it needs. */
export function place(u: number, v: number, extra: Partial<DrawPoint> = {}) {
  const t = tool();
  if (!t || heightPending()) return;
  const p: DrawPoint = { u, v, eu: round(u), ev: round(v), ...extra };
  const pts = [...drawn(), p];
  if (t === "brick" || t === "cylinder") {
    if (pts.length === 2) { setDrawn(pts); commit(pts); }
    else setDrawn(pts);
    return;
  }
  // polygon: clicking the first point again closes it
  if (pts.length > 3 && Math.hypot(u - pts[0].u, v - pts[0].v) < 1e-9) {
    commit(pts.slice(0, -1));
    return;
  }
  setDrawn(pts);
}

// ------------------------------------------------------------------ typed coordinates

export interface Typed {
  ok: boolean;
  /** why it cannot be placed ("" while empty) */
  error?: string;
  /** what it places, in words */
  text?: string;
  point?: DrawPoint;
}

/** Split at the commas (or semicolons) outside parentheses: "min(a, b), 3" -> two parts. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const c of s) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if ((c === "," || c === ";") && depth === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/** What typing `src` while drawing would place: "u, v" an absolute point on the work
 * plane, "@du, dv" relative to the last point; for a brick's second corner "w, h" is the size
 * ("=u, v" forces an absolute corner); for a cylinder's rim a single value is the radius. */
export function parseTyped(src: string): Typed {
  const active = tool();
  if (!active) return { ok: false, error: t("draw.typed.noTool") };
  let s = src.trim();
  if (!s) return { ok: false, error: "" };
  const pts = drawn();
  const last = pts[pts.length - 1];
  const [an, bn] = planeAxes(plane().normal).map((a) => axisName(a)) as [string, string];
  let mode: "abs" | "rel" | "size";
  if (s.startsWith("@")) { mode = active === "brick" && pts.length === 1 ? "size" : "rel"; s = s.slice(1); }
  else if (s.startsWith("=")) { mode = "abs"; s = s.slice(1); }
  else mode = active === "brick" && pts.length === 1 ? "size" : "abs";
  const parts = splitTop(s);
  const value = (e: Expr): number => evaluate(e, names().names);
  try {
    if (active === "cylinder" && pts.length === 1 && parts.length === 1 && parts[0] !== "") {
      const r = toExpr(parts[0]);
      const rv = value(r);
      if (!(rv > 0)) return { ok: false, error: t("draw.typed.radiusPositive") };
      return { ok: true, text: t("draw.typed.radius", { r: fmt(rv) }), point: { u: last.u + rv, v: last.v, eu: plus(last.eu, r), ev: last.ev, r } };
    }
    if (parts.length !== 2 || parts.some((p) => p === "")) {
      const what = mode === "size" ? t("draw.typed.widthHeight") : mode === "rel" ? `d${an}, d${bn}` : `${an}, ${bn}`;
      return { ok: false, error: t(active === "cylinder" && pts.length === 1 ? "draw.typed.orRadius" : "draw.typed.twoValues", { what }) };
    }
    const [a, b] = parts.map(toExpr);
    const [av, bv] = [value(a), value(b)];
    if (mode === "abs") return { ok: true, text: `${an} ${fmt(av)}, ${bn} ${fmt(bv)}`, point: { u: av, v: bv, eu: a, ev: b } };
    const base = last ?? { u: 0, v: 0, eu: 0, ev: 0 };
    const u = base.u + av, v = base.v + bv;
    const point: DrawPoint = { u, v, eu: plus(base.eu, a), ev: plus(base.ev, b), rel: [a, b] };
    const at = `${an} ${fmt(u)}, ${bn} ${fmt(v)}`;
    return { ok: true, text: mode === "size" ? t("draw.typed.size", { w: fmt(Math.abs(av)), h: fmt(Math.abs(bv)), at }) : `→ ${at}`, point };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Place a typed point; false when it does not parse. */
export function placeTyped(src: string): boolean {
  const r = parseTyped(src);
  if (!r.ok || !r.point) return false;
  const { u, v, ...rest } = r.point;
  place(u, v, rest);
  return true;
}
