// The 3D side of the designer's draw tools: a grid on the work plane, the rubber-band preview of
// the shape being drawn, snapping (grid, corners and centres, edge midpoints and edges of the
// geometry on the plane), a coordinate readout next to the pointer, typed coordinates, the shape
// dialog's outline and "Pick face" for the work plane. Clicks place points; src/designer/draw.ts
// turns them into primitives. Orbiting still works: a drag is not a click.
import * as THREE from "three";
import { createEffect, createRoot, on } from "solid-js";
import {
  alignWcsWithFace, axisName, cancel, commit, drawEscapeAction, drawingPlaneWorldValue, drawPointToWorld, faceElevation, facePicking, extrudeFacePicking,
  ghost, ghostFrameTransforms, localFrame, parseTyped, place, placeTyped, plane, planeAxes, points, startTool, wcsIsGlobal, wcsVisible,
  heightStep, heightDraft, setHeightDraft, finishHeight,
  setFacePicking, setExtrudeFacePicking, snap, snapTo, tool, undoPoint, worldPointToDrawLocal,
} from "../designer/draw";
import { maps, pt } from "../designer/geometry";
import { names, setMessage } from "../designer/store";
import { evaluate } from "../designer/expr";
import type { DesignPrimitive, DesignTransform } from "../designer/types";
import { cssVar } from "../lib/cssvar";
import type { Bundle } from "../types";
import { sceneRadius } from "./geometry";
import { setTransformAnchor, transformAnchor, transformPlacement } from "./transformSnap";
import { pickedPoints } from "../designer/pointTools";
import { openShapeDialog } from "../designer/dialogs/shapes";
import { resolveFaceCandidate } from "../designer/faceAlign";
import type { PickedFace } from "../designer/faceTransforms.ts";
import { frameBasis } from "../designer/localFrame";
import { resolvePointCandidate } from "../designer/pointGeometry";
import { clearFaceHighlight, emptyFaceHighlight, faceBoundary, hoverFace, selectFace } from "./faceHighlight";
import { layers } from "../state";
import { appMode } from "../workspace";
import { t } from "../i18n";

const AXES = ["x", "y", "z"] as const;
const SNAP_PX = 10;
const MAX_GRID_LINES = 240;

interface Ctx {
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  requestRender: () => void;
  bundle: () => Bundle | null;
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

/** Replace a geometry's points (setFromPoints cannot grow an existing buffer). */
function setPoints3(geo: THREE.BufferGeometry, pts: THREE.Vector3[]) {
  const a = new Float32Array(pts.length * 3);
  pts.forEach((p, k) => { a[3 * k] = p.x; a[3 * k + 1] = p.y; a[3 * k + 2] = p.z; });
  geo.setAttribute("position", new THREE.BufferAttribute(a, 3));
  geo.computeBoundingSphere();
}

/** Snap targets of the existing geometry on the work plane (normal axis n at w), in plane
 * coordinates (u, v): corners and centres, straight edges and circles. Boxes and polygons give
 * their outline where the plane cuts or touches them, cylinders along the normal and spheres a
 * circle and its centre. */
export interface SnapGeo {
  points: { u: number; v: number; kind: "corner" | "centre" }[];
  segs: [number, number, number, number][];
  circles: { u: number; v: number; r: number }[];
}
export function snapGeometry(b: Bundle | null, n: number, w: number, exclude?: string): SnapGeo {
  const out: SnapGeo = { points: [], segs: [], circles: [] };
  if (!b || !Number.isFinite(w)) return out;
  const ui = (n + 1) % 3, vi = (n + 2) % 3;
  const eps = 1e-6 * Math.max(1, Math.abs(w));
  const within = (a: number, c: number) => w >= Math.min(a, c) - eps && w <= Math.max(a, c) + eps;
  const ring = (pts: [number, number][]) => {
    pts.forEach(([u, v], k) => {
      out.points.push({ u, v, kind: "corner" });
      const [u2, v2] = pts[(k + 1) % pts.length];
      if (Math.hypot(u2 - u, v2 - v) > 1e-9) out.segs.push([u, v, u2, v2]);
    });
  };
  for (const part of b.parts) {
    if (part.name === exclude) continue;
    for (const pr of part.primitives) {
      if (pr.kind === "polygon" || pr.kind === "linpoly") {
        if (pr.normal !== n) continue;
        const top = pr.elevation + (pr.kind === "linpoly" ? pr.length ?? 0 : 0);
        if (within(pr.elevation, top)) ring(pr.points);
      } else if (pr.kind === "cylinder" || pr.kind === "cylindricalshell") {
        const d = [0, 1, 2].map((k) => pr.stop[k] - pr.start[k]);
        if (Math.abs(d[ui]) > eps || Math.abs(d[vi]) > eps || !within(pr.start[n], pr.stop[n])) continue;
        const [u, v] = [pr.start[ui], pr.start[vi]];
        out.points.push({ u, v, kind: "centre" });
        if (pr.kind === "cylinder") out.circles.push({ u, v, r: pr.radius });
        else {
          out.circles.push({ u, v, r: pr.radius + pr.shell_width / 2 });
          if (pr.radius - pr.shell_width / 2 > 1e-9) out.circles.push({ u, v, r: pr.radius - pr.shell_width / 2 });
        }
      } else if (pr.kind === "sphere") {
        const dz = Math.abs(pr.center[n] - w);
        if (dz > pr.radius + eps) continue;
        out.points.push({ u: pr.center[ui], v: pr.center[vi], kind: "centre" });
        const r = Math.sqrt(Math.max(0, pr.radius ** 2 - dz ** 2));
        if (r > 1e-9) out.circles.push({ u: pr.center[ui], v: pr.center[vi], r });
      } else if (pr.kind === "box" || pr.kind === "bbox" || pr.kind === "polyhedron") {
        const [lo, hi] = pr.bbox;
        if (!within(lo[n], hi[n])) continue;
        const [a, c, e, f] = [lo[ui], lo[vi], hi[ui], hi[vi]];
        if (Math.abs(e - a) < 1e-9 && Math.abs(f - c) < 1e-9) out.points.push({ u: a, v: c, kind: "corner" });
        else if (Math.abs(e - a) < 1e-9 || Math.abs(f - c) < 1e-9) ring([[a, c], [e, f]]);
        else ring([[a, c], [e, c], [e, f], [a, f]]);
      }
    }
  }
  return out;
}

/** What the pointer snapped to (shown in the readout). */
export type SnapKind = "grid" | "corner" | "centre" | "midpoint" | "edge" | "point";
export interface Cursor { u: number; v: number; snap: SnapKind | null }

/** Outline of a design primitive (the shape dialog's shape) as line-segment pairs; [] when a value
 * does not evaluate. */
function outline(pr: DesignPrimitive | null, nm: Record<string, number>, transforms: DesignTransform[] = []): THREE.Vector3[] {
  if (!pr) return [];
  const out: THREE.Vector3[] = [];
  const e = (x: unknown) => evaluate(x as string | number, nm);
  const at = (n: number, w: number, u: number, v: number) => {
    const p = new THREE.Vector3();
    p.setComponent(n, w); p.setComponent((n + 1) % 3, u); p.setComponent((n + 2) % 3, v);
    return p;
  };
  const ring = (n: number, w: number, cu: number, cv: number, r: number) => {
    for (let k = 0; k < 64; k++) {
      const a0 = (k / 64) * 2 * Math.PI, a1 = ((k + 1) / 64) * 2 * Math.PI;
      out.push(at(n, w, cu + r * Math.cos(a0), cv + r * Math.sin(a0)), at(n, w, cu + r * Math.cos(a1), cv + r * Math.sin(a1)));
    }
  };
  try {
    if (pr.kind === "box") {
      const a = pr.start.map(e), b = pr.stop.map(e);
      const c = (k: number) => new THREE.Vector3(k & 1 ? b[0] : a[0], k & 2 ? b[1] : a[1], k & 4 ? b[2] : a[2]);
      for (const [i, j] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) out.push(c(i), c(j));
    } else if (pr.kind === "cylinder" && "axis" in pr) {
      const n = AXES.indexOf(pr.axis);
      const [cu, cv] = pr.center.map(e), r = e(pr.radius), ri = e(pr.inner_radius ?? 0), [lo, hi] = pr.range.map(e);
      for (const w of [lo, hi]) {
        ring(n, w, cu, cv, r);
        if (ri > 0) ring(n, w, cu, cv, ri);
      }
      for (const [du, dv] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) out.push(at(n, lo, cu + r * du, cv + r * dv), at(n, hi, cu + r * du, cv + r * dv));
    } else if (pr.kind === "sphere") {
      const c = pr.center.map(e), r = e(pr.radius);
      for (let n = 0; n < 3; n++) ring(n, c[n], c[(n + 1) % 3], c[(n + 2) % 3], r);
    } else if (pr.kind === "polygon" || pr.kind === "linpoly") {
      const n = AXES.indexOf(pr.normal);
      const w0 = e(pr.elevation), w1 = pr.kind === "linpoly" ? w0 + e(pr.length) : w0;
      const pts = pr.points.map(([u, v]) => [e(u), e(v)]);
      for (const w of w1 === w0 ? [w0] : [w0, w1]) {
        pts.forEach(([u, v], k) => { const [u2, v2] = pts[(k + 1) % pts.length]; out.push(at(n, w, u, v), at(n, w, u2, v2)); });
      }
      if (w1 !== w0) for (const [u, v] of pts) out.push(at(n, w0, u, v), at(n, w1, u, v));
    }
  } catch {
    return [];
  }
  try {
    const transformMaps = transforms.length ? maps(transforms, nm) : null;
    const mapped = transformMaps ? transformMaps.flatMap((m) => out.map((p) => new THREE.Vector3(...pt(m, p.toArray() as [number, number, number])))) : out;
    return mapped.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) ? mapped : [];
  } catch {
    return [];
  }
}

export interface PlaneSnapOptions {
  canvas: HTMLCanvasElement;
  camera: THREE.Camera;
  /** the plane: normal axis index and its value */
  axis: number;
  value: number;
  /** grid origin in plane coordinates; null: no valid grid (nothing is returned without a snap) */
  origin: [number, number] | null;
  geo: SnapGeo;
  /** extra snap points in plane coordinates (placed or picked points) */
  points: { u: number; v: number }[];
  /** place without snapping (Alt) */
  free?: boolean;
  /** Optional local-plane mapping for drawing in a translated/rotated coordinate frame. */
  toWorld?: (u: number, v: number) => [number, number, number];
  fromWorld?: (point: [number, number, number]) => [number, number];
}

/** The point on a plane under the pointer, snapped: extra points, corners and centres first, then
 * edge midpoints, then the nearest point on an edge, then the grid. */
export function planeSnap(e: PointerEvent | MouseEvent, o: PlaneSnapOptions): Cursor | null {
  const r = o.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, o.camera);
  const i = o.axis;
  const normal = new THREE.Vector3().setComponent(i, 1);
  const p = new THREE.Vector3();
  if (!Number.isFinite(o.value) || !ray.ray.intersectPlane(new THREE.Plane(normal, -o.value), p)) return null;
  const worldPoint = p.toArray() as [number, number, number];
  const [pu, pv] = o.fromWorld ? o.fromWorld(worldPoint) : [p.getComponent((i + 1) % 3), p.getComponent((i + 2) % 3)];
  if (o.free) return { u: pu, v: pv, snap: null };
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const world = new THREE.Vector3();
  const px = (u: number, v: number) => {
    if (o.toWorld) world.set(...o.toWorld(u, v));
    else { world.setComponent(i, o.value); world.setComponent((i + 1) % 3, u); world.setComponent((i + 2) % 3, v); }
    const s = world.project(o.camera);
    return Math.hypot((s.x + 1) / 2 * r.width - mx, (1 - s.y) / 2 * r.height - my);
  };
  /** the closest candidate within SNAP_PX on screen */
  const best = (cands: Iterable<{ u: number; v: number; kind: SnapKind }>): Cursor | null => {
    let out: Cursor | null = null, d0 = SNAP_PX;
    for (const c of cands) {
      const d = px(c.u, c.v);
      if (d < d0) { d0 = d; out = { u: c.u, v: c.v, snap: c.kind }; }
    }
    return out;
  };
  const g = o.geo;
  const pts = [
    ...o.points.map(({ u, v }) => ({ u, v, kind: "point" as const })),
    ...(snapTo("corner") ? g.points : []),
  ];
  const hitPoint = best(pts);
  if (hitPoint) return hitPoint;
  if (snapTo("midpoint")) {
    const m = best(g.segs.map(([a, b, c, d]) => ({ u: (a + c) / 2, v: (b + d) / 2, kind: "midpoint" as const })));
    if (m) return m;
  }
  if (snapTo("edge")) {
    const near = function* () {
      for (const [a, b, c, d] of g.segs) {
        const du = c - a, dv = d - b, L = du * du + dv * dv;
        const t = Math.max(0, Math.min(1, ((pu - a) * du + (pv - b) * dv) / L));
        yield { u: a + t * du, v: b + t * dv, kind: "edge" as const };
      }
      for (const c of g.circles) {
        const d = Math.hypot(pu - c.u, pv - c.v);
        if (d > 1e-12) yield { u: c.u + (c.r * (pu - c.u)) / d, v: c.v + (c.r * (pv - c.v)) / d, kind: "edge" as const };
      }
    };
    const ed = best(near());
    if (ed) return ed;
  }
  const st = snap();
  if (!o.origin) return null;
  const [ou, ov] = o.origin;
  const q = (x: number, org: number) => (st > 0 ? org + Math.round((x - org) / st) * st : x);
  return { u: q(pu, ou), v: q(pv, ov), snap: st > 0 ? "grid" : null };
}

export function attachDrawOverlay(ctx: Ctx): () => void {
  const { host, canvas, scene, camera, requestRender } = ctx;
  const group = new THREE.Group();
  group.renderOrder = 10;
  scene.add(group);

  const readout = document.createElement("div");
  readout.className = "vp-draw-readout";
  readout.hidden = true;
  host.appendChild(readout);

  // rubber band and point markers, drawn on top
  const lineGeo = new THREE.BufferGeometry();
  const lineMat = new THREE.LineBasicMaterial({ depthTest: false, transparent: true });
  const line = new THREE.Line(lineGeo, lineMat);
  line.renderOrder = 11;
  const dotGeo = new THREE.BufferGeometry();
  const dotMat = new THREE.PointsMaterial({ size: 8, sizeAttenuation: false, depthTest: false, transparent: true });
  const dots = new THREE.Points(dotGeo, dotMat);
  dots.renderOrder = 12;
  const snapDotGeo = new THREE.BufferGeometry();
  const snapMat = new THREE.PointsMaterial({ size: 14, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.55 });
  const snapDot = new THREE.Points(snapDotGeo, snapMat);
  snapDot.renderOrder = 12;
  // the shape dialog's shape, outlined while its values are edited
  const ghostGeo = new THREE.BufferGeometry();
  const ghostMat = new THREE.LineBasicMaterial({ depthTest: false, transparent: true, opacity: 0.9 });
  const ghostLines = new THREE.LineSegments(ghostGeo, ghostMat);
  ghostLines.renderOrder = 11;
  group.add(line, dots, snapDot, ghostLines);
  const heightGeo = new THREE.BufferGeometry();
  const heightMat = new THREE.LineBasicMaterial({ depthTest: false, transparent: true, opacity: 0.95 });
  const heightLines = new THREE.LineSegments(heightGeo, heightMat);
  heightLines.renderOrder = 13;
  group.add(heightLines);
  let grid: THREE.Object3D | null = null;

  let cursor: Cursor | null = null;
  /** Move/Translate placement target: the snapped world point and the plane it lies on */
  interface Placed { world: THREE.Vector3; cursor: Cursor; axis: number; value: number; face: string | null }
  let placed: Placed | null = null;
  /** snap geometry per placement plane ("axis|value"), dropped when the design or tool changes */
  let placeGeo = new Map<string, SnapGeo>();
  let snapGeo: SnapGeo = { points: [], segs: [], circles: [] };

  const n = () => AXES.indexOf(plane().normal);
  /** The WCS origin's coordinates on the plane's two world axes: the lattice of the placement grid. */
  const origin = (): [number, number] | null => {
    try {
      const o = localFrame().origin.map((x) => evaluate(x, names().names));
      const value: [number, number] = [o[(n() + 1) % 3], o[(n() + 2) % 3]];
      return value.every(Number.isFinite) ? value : null;
    } catch { return null; }
  };
  const toWorld = (u: number, v: number) => {
    return new THREE.Vector3(...drawPointToWorld(u, v));
  };

  const localUvFromWorld = (point: [number, number, number]): [number, number] => {
    const local = worldPointToDrawLocal(point), [ua, va] = planeAxes(plane().normal).map((a) => AXES.indexOf(a));
    return [local[ua], local[va]];
  };
  const localizeSnapGeometry = (geo: SnapGeo): SnapGeo => {
    const uv = (u: number, v: number): [number, number] => {
      const world: [number, number, number] = [0, 0, 0];
      const axis = n(), ui = (axis + 1) % 3, vi = (axis + 2) % 3;
      world[axis] = drawingPlaneWorldValue(); world[ui] = u; world[vi] = v;
      return localUvFromWorld(world);
    };
    return {
      points: geo.points.map((p) => {
        const [u, v] = uv(p.u, p.v);
        return { ...p, u, v };
      }),
      segs: geo.segs.map(([u0, v0, u1, v1]) => [...uv(u0, v0), ...uv(u1, v1)] as [number, number, number, number]),
      circles: geo.circles.map((c) => {
        const [u, v] = uv(c.u, c.v);
        return { ...c, u, v };
      }),
    };
  };

  function colours() {
    const accent = new THREE.Color(cssVar("--al-focus") || "#d98b4f");
    lineMat.color = accent;
    ghostMat.color = accent;
    heightMat.color = accent;
    faceMat.color = new THREE.Color(cssVar("--al-critical") || "#b42318");
    boundaryMat.color = new THREE.Color(cssVar("--al-critical") || "#b42318");
    dotMat.color = accent;
    snapMat.color = accent;
  }

  const AXIS_COLOURS = ["#c8553d", "#4b9b4b", "#3f7fd1"];
  /** A small camera-facing letter in the scene (u, v, w). */
  function labelSprite(text: string, color: string, size: number) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 64;
    const c2 = cv.getContext("2d");
    if (c2) {
      c2.fillStyle = color; c2.font = "600 40px IBM Plex Mono, monospace"; c2.textAlign = "center"; c2.textBaseline = "middle";
      c2.fillText(text, 32, 34);
    }
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
    sp.scale.setScalar(size);
    sp.renderOrder = 15;
    return sp;
  }
  /** The local WCS in the scene: u, v, w arrows at its origin (when shown), and while drawing the
   * letters u and v at the ends of the work-plane grid. Nothing for the global WCS. */
  const wcsMarks = new THREE.Group();
  wcsMarks.renderOrder = 14;
  group.add(wcsMarks);
  let gridHalf = 0;
  function rebuildWcsMarks() {
    for (const child of [...wcsMarks.children]) {
      wcsMarks.remove(child);
      child.traverse((o) => {
        const m = o as THREE.Mesh | THREE.Sprite;
        if (!(m as THREE.Sprite).isSprite) (m as THREE.Mesh).geometry?.dispose?.();
        const mat = (m as THREE.Mesh).material as THREE.Material & { map?: THREE.Texture } | undefined;
        mat?.map?.dispose?.(); mat?.dispose?.();
      });
    }
    const b = ctx.bundle();
    if (wcsIsGlobal() || !b || appMode() !== "design") return requestRender();
    const o = new THREE.Vector3(...drawPointToWorld(0, 0, 0));
    if (!o.toArray().every(Number.isFinite)) return requestRender();
    const { radius } = sceneRadius(b);
    const basis = frameBasis(plane().normal, localFrame());
    const names3 = ["u", "v", "w"];
    if (wcsVisible()) {
      const len = Math.max(radius * 0.22, 1e-3);
      basis.forEach((d, k) => {
        const dir = new THREE.Vector3(...d);
        const mat = new THREE.LineBasicMaterial({ color: AXIS_COLOURS[k], depthTest: false, transparent: true });
        const geo = new THREE.BufferGeometry().setFromPoints([o, o.clone().addScaledVector(dir, len)]);
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 14;
        wcsMarks.add(line);
        const tag = labelSprite(names3[k], AXIS_COLOURS[k], len * 0.28);
        tag.position.copy(o).addScaledVector(dir, len * 1.18);
        wcsMarks.add(tag);
      });
    }
    if (tool() && gridHalf > 0) {
      [0, 1].forEach((k) => {
        const tag = labelSprite(names3[k], cssVar("--al-focus") || "#d98b4f", Math.max(radius * 0.05, 1e-3));
        tag.position.copy(o).addScaledVector(new THREE.Vector3(...basis[k]), gridHalf * 0.96);
        wcsMarks.add(tag);
      });
    }
    requestRender();
  }

  function rebuildGrid() {
    gridHalf = 0;
    buildGrid();
    rebuildWcsMarks();
  }
  function buildGrid() {
    if (grid) {
      group.remove(grid);
      grid.traverse((o) => { (o as THREE.LineSegments).geometry?.dispose?.(); ((o as THREE.LineSegments).material as THREE.Material)?.dispose?.(); });
      grid = null;
    }
    const b = ctx.bundle();
    const drawing = !!tool();
    const w = drawingPlaneWorldValue();
    if (!(drawing || transformPlacement()) || !b || !Number.isFinite(w) || !layers.guideGrid) return requestRender();
    const at = origin();
    if (!at) return requestRender();
    const { center, radius } = sceneRadius(b);
    const step = snap() > 0 ? snap() : Math.max(radius / 20, 1e-3);
    let shown = step;
    let size = Math.ceil((radius * 2.6) / step) * step;
    while (size / shown > MAX_GRID_LINES) shown *= 5;
    size = Math.ceil(size / shown) * shown;
    const g = new THREE.GridHelper(size, Math.round(size / shown), new THREE.Color(cssVar("--al-focus") || "#d98b4f"), new THREE.Color(cssVar("--al-text-3") || "#888"));
    const mats = Array.isArray(g.material) ? g.material : [g.material];
    for (const m of mats) { m.transparent = true; m.opacity = 0.22; m.depthWrite = false; }
    // GridHelper lies in the xz plane (normal y): turn it onto the work plane
    const i = n();
    if (i === 2) g.rotation.x = Math.PI / 2;
    else if (i === 0) g.rotation.z = Math.PI / 2;
    const c = center.clone();
    gridHalf = drawing ? size / 2 : 0;
    if (drawing) {
      c.fromArray(drawPointToWorld(0, 0));
      if (localFrame().angle) g.rotateOnWorldAxis(new THREE.Vector3().setComponent(i, 1), localFrame().angle * Math.PI / 180);
    } else {
      c.setComponent(i, w);
      // Keep placement grid lines relative to the WCS origin.
      c.setComponent((i + 1) % 3, at[0]);
      c.setComponent((i + 2) % 3, at[1]);
    }
    g.position.copy(c);
    grid = g;
    group.add(g);
    requestRender();
  }

  function redraw() {
    const t = tool();
    const pts = points();
    const cur = cursor;
    const verts: THREE.Vector3[] = [];
    if (t && pts.length) {
      const [u0, v0] = pts[0];
      if (t === "brick" && cur) {
        verts.push(toWorld(u0, v0), toWorld(cur.u, v0), toWorld(cur.u, cur.v), toWorld(u0, cur.v), toWorld(u0, v0));
      } else if (t === "cylinder" && cur) {
        const r = Math.hypot(cur.u - u0, cur.v - v0);
        for (let k = 0; k <= 64; k++) {
          const a = (k / 64) * 2 * Math.PI;
          verts.push(toWorld(u0 + r * Math.cos(a), v0 + r * Math.sin(a)));
        }
        verts.push(toWorld(u0, v0));
      } else if (t === "polygon") {
        for (const [u, v] of pts) verts.push(toWorld(u, v));
        if (cur) verts.push(toWorld(cur.u, cur.v));
      }
    }
    setPoints3(lineGeo, verts);
    line.visible = verts.length > 1;
    const marks = pts.map(([u, v]) => toWorld(u, v));
    if (transformPlacement()) { if (placed) marks.push(placed.world.clone()); }
    else if (cur && t) marks.push(toWorld(cur.u, cur.v));
    setPoints3(dotGeo, marks);
    dots.visible = marks.length > 0;
    const snapped = transformPlacement() ? !!placed?.cursor.snap && placed.cursor.snap !== "grid" : !!cur?.snap && cur.snap !== "grid";
    setPoints3(snapDotGeo, snapped ? [transformPlacement() ? placed!.world.clone() : toWorld(cur!.u, cur!.v)] : []);
    snapDot.visible = snapped;
    const heightVerts: THREE.Vector3[] = [];
    if (heightStep() && pts.length) {
      const axis = n();
      const h = (() => { try { return evaluate(heightDraft(), names().names); } catch { return 0; } })();
      let ring: [number, number][] = [];
      if (tool() === "brick" && pts.length >= 2) { const [[a,b],[c,d]] = pts; ring = [[a,b],[c,b],[c,d],[a,d]]; }
      else if (tool() === "cylinder" && pts.length >= 2) {
        const [u,v] = pts[0], radius = Math.hypot(pts[1][0]-u, pts[1][1]-v);
        ring = Array.from({length:64}, (_,k) => [u+radius*Math.cos(k*2*Math.PI/64),v+radius*Math.sin(k*2*Math.PI/64)] as [number,number]);
      } else if (tool() === "polygon") ring = pts;
      if (ring.length > 1) {
        const bottom = ring.map(([u,v]) => toWorld(u,v));
        const top = bottom.map(p => p.clone().setComponent(axis, p.getComponent(axis)+(localFrame().flip ? -h : h)));
        for (let k=0;k<ring.length;k++) {
          const j=(k+1)%ring.length;
          heightVerts.push(bottom[k],bottom[j],top[k],top[j],bottom[k],top[k]);
        }
      }
      heightLines.visible = heightVerts.length > 0;
      const at = pointerAt ?? {x:0,y:0};
      readout.textContent = `Height ${fmt(h)} mm · click or Enter to confirm · Esc to return to base`;
      const fake = { clientX: host.getBoundingClientRect().left+at.x, clientY: host.getBoundingClientRect().top+at.y } as PointerEvent;
      placeReadout(fake);
    } else heightLines.visible = false;
    setPoints3(heightGeo, heightVerts);
    requestRender();
  }

  /** The point on the work plane under the pointer while drawing, snapped (planeSnap). */
  function hit(e: PointerEvent | MouseEvent): Cursor | null {
    return planeSnap(e, {
      canvas, camera, axis: n(), value: drawingPlaneWorldValue(), origin: [0, 0], geo: snapGeo,
      points: points().map(([u, v]) => ({ u, v })),
      toWorld: (u, v) => drawPointToWorld(u, v),
      fromWorld: localUvFromWorld,
    });
  }

  /** The part mesh under the pointer (nearest; metal wins a tie with a coplanar dielectric). */
  function partHit(e: PointerEvent | MouseEvent, only?: string, except?: string) {
    const r = canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const meshes: THREE.Object3D[] = [];
    scene.traverseVisible((o) => {
      const part = o.userData.part as string | undefined;
      if ((o as THREE.Mesh).isMesh && part && (!only || part === only) && part !== except) meshes.push(o);
    });
    const hits = ray.intersectObjects(meshes, false);
    const first = hits[0];
    if (!first) return null;
    const tie = first.distance * 1e-4 + 1e-9;
    return { hit: hits.find((h) => h.distance - first.distance <= tie && h.object.userData.metal) ?? first, ray: ray.ray };
  }

  /** The Move/Translate target: on the flat face (along x, y or z) of another part under the pointer,
   * else on the work plane; snapped to that plane's corners, edges, picked points and the grid. */
  function placementHit(e: PointerEvent | MouseEvent): Placed | null {
    const moving = transformPlacement()?.part;
    const under = partHit(e, undefined, moving);
    const face = under ? resolveFaceCandidate(under.hit, under.ray.direction) : null;
    const onFace = face && typeof face === "object" ? face : null;
    const axis = onFace ? onFace.axis : n();
    const value = onFace ? onFace.value : drawingPlaneWorldValue();
    if (!Number.isFinite(value)) return null;
    const key = `${axis}|${value}`;
    let geo = placeGeo.get(key);
    if (!geo) { geo = snapGeometry(ctx.bundle(), axis, value, moving); placeGeo.set(key, geo); }
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const wcs = axis === n();
    const c = planeSnap(e, {
      canvas, camera, axis, value, origin: wcs ? origin() ?? [0, 0] : [0, 0], geo,
      points: pickedPoints().filter(({ point }) => Math.abs(point[axis] - value) < 1e-6).map(({ point }) => ({ u: point[u], v: point[v] })),
      free: e.altKey,
    });
    if (!c) return null;
    const world = new THREE.Vector3();
    world.setComponent(axis, value); world.setComponent(u, c.u); world.setComponent(v, c.v);
    return { world, cursor: c, axis, value, face: onFace ? `${onFace.sign > 0 ? "+" : "−"}${AXES[axis]} face of ${onFace.part}` : null };
  }

  /** The anchor on the moving part: its nearest corner when within snapping distance on screen. */
  function anchorHit(e: PointerEvent, part: string): { point: [number, number, number]; snap: string | null } | null {
    const under = partHit(e, part);
    if (!under) return null;
    const r = canvas.getBoundingClientRect();
    const corner = e.altKey ? null : resolvePointCandidate(under.hit, "vertex", "anchor");
    if (corner) {
      const s = new THREE.Vector3(...corner.point).project(camera);
      if (Math.hypot((s.x + 1) / 2 * r.width - (e.clientX - r.left), (1 - s.y) / 2 * r.height - (e.clientY - r.top)) < SNAP_PX) return { point: corner.point, snap: "corner" };
    }
    return { point: under.hit.point.toArray() as [number, number, number], snap: null };
  }

  function showPlacementReadout(e: PointerEvent, p: Placed | null) {
    if (!p) { readout.hidden = true; return; }
    const a = transformAnchor();
    const [un, vn] = planeAxes(AXES[p.axis]);
    const delta = a ? ` · Δ ${[0, 1, 2].map((k) => fmt(p.world.getComponent(k) - a[k])).join(", ")} mm` : "";
    readout.textContent = `${un} ${fmt(p.cursor.u)}  ${vn} ${fmt(p.cursor.v)}  ${AXES[p.axis]} ${fmt(p.value)}${p.cursor.snap ? ` · ${p.cursor.snap}` : e.altKey ? " · Alt: snapping off" : ""} · on ${p.face ?? "the work plane"}${delta}`;
    placeReadout(e);
  }

  function showReadout(e: PointerEvent, c: Cursor | null) {
    if (!c) { readout.hidden = true; return; }
    const [un, vn] = planeAxes(plane().normal).map((a) => axisName(a)) as [string, string];
    const pts = points();
    let extra = "";
    if (pts.length) {
      const [u0, v0] = pts[pts.length - 1];
      const t = tool();
      if (t === "brick") extra = ` · ${fmt(Math.abs(c.u - pts[0][0]))} × ${fmt(Math.abs(c.v - pts[0][1]))} mm`;
      else if (t === "cylinder") extra = ` · r ${fmt(Math.hypot(c.u - u0, c.v - v0))} mm`;
      else extra = ` · ${fmt(Math.hypot(c.u - u0, c.v - v0))} mm`;
    }
    const local = wcsIsGlobal() ? "" : `${t("draw.localFrame.readout")} · `;
    readout.textContent = `${local}${un} ${fmt(c.u)}  ${vn} ${fmt(c.v)}  ${axisName(plane().normal)} 0${c.snap ? ` · ${c.snap}` : ""}${extra}`;
    placeReadout(e);
  }

  function updateHeightFromPointer(e: PointerEvent) {
    const pts = points(); if (!pts.length) return;
    const anchor = toWorld(...pts[pts.length - 1]);
    const axis = n(), unit = anchor.clone().setComponent(axis, anchor.getComponent(axis)+1);
    anchor.project(camera); unit.project(camera);
    const r = canvas.getBoundingClientRect();
    const sx = (unit.x-anchor.x)*r.width/2, sy = -(unit.y-anchor.y)*r.height/2;
    const den = sx*sx+sy*sy;
    // A normal aimed at the camera has no screen displacement. Keep the last valid draft;
    // the typed height field remains available in that view.
    if (den > 1e-8) {
      const dx=e.clientX-(r.left+(anchor.x+1)*r.width/2), dy=e.clientY-(r.top+(1-anchor.y)*r.height/2);
      // along the world axis; a flipped WCS has w along its negative direction
      let h=(dx*sx+dy*sy)/den;
      if (!e.altKey) {
        const step = snap();
        if (step > 0) h=Math.round(h/step)*step;
        const base = drawingPlaneWorldValue(), targets = pickedPoints().map(({point}) => point[axis] - base);
        scene.traverseVisible((o) => {
          if (!(o as THREE.Mesh).isMesh || !o.userData.part) return;
          const mesh=o as THREE.Mesh; mesh.geometry.computeBoundingBox();
          if (!mesh.geometry.boundingBox) return;
          const box=mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
          targets.push(box.min.getComponent(axis)-base,box.max.getComponent(axis)-base);
        });
        const tolerance = Math.max(step > 0 ? step/2 : 0, 10/Math.sqrt(den));
        const near = targets.filter(Number.isFinite).sort((a,b)=>Math.abs(a-h)-Math.abs(b-h))[0];
        if (near !== undefined && Math.abs(near-h) <= tolerance) h=near;
      }
      setHeightDraft(localFrame().flip ? -h : h);
    }
  }

  function placeReadout(e: PointerEvent) {
    const r = host.getBoundingClientRect();
    readout.hidden = false;
    // beside the pointer, flipped to its left / above it near the right / bottom edge
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const w = readout.offsetWidth, h = readout.offsetHeight;
    readout.style.left = `${x + 14 + w > r.width ? Math.max(0, x - 14 - w) : x + 14}px`;
    readout.style.top = `${y + 14 + h > r.height ? Math.max(0, y - 14 - h) : y + 14}px`;
  }

  // ---- typed coordinates: a digit, "-", "@", "=" or a letter while drawing opens a small input
  const typed = document.createElement("div");
  typed.className = "vp-draw-typed";
  typed.hidden = true;
  typed.innerHTML = '<input type="text" spellcheck="false" autocomplete="off" aria-label="Coordinates"><div class="vp-draw-typed-out" aria-live="polite"></div><div class="vp-draw-typed-help"></div>';
  host.appendChild(typed);
  const typedInput = typed.querySelector("input")!;
  const typedOut = typed.querySelector<HTMLDivElement>(".vp-draw-typed-out")!;
  const typedHelp = typed.querySelector<HTMLDivElement>(".vp-draw-typed-help")!;
  let pointerAt: { x: number; y: number } | null = null;

  function typedHelpText(): string {
    if (heightStep()) return "height along the work-plane normal · expression or number · Enter confirms · Esc closes";
    const [un, vn] = planeAxes(plane().normal).map((a) => axisName(a)) as [string, string];
    const n = points().length;
    if (tool() === "brick" && n === 1) return "w, h: the size · =u, v: absolute · Enter places · Esc closes";
    if (tool() === "cylinder" && n === 1) return `r: the radius · ${un}, ${vn} · @d${un}, d${vn} · Enter · Esc`;
    return `${un}, ${vn}: absolute · @d${un}, d${vn}: from the last point · Enter · Esc`;
  }
  function updateTyped() {
    if (heightStep()) {
      const src = typedInput.value.trim();
      try {
        const value = evaluate(src, names().names);
        setHeightDraft(src);
        typedOut.textContent = `Height ${fmt(value)} mm`;
        typedOut.classList.remove("bad"); typedInput.setAttribute("aria-invalid", "false"); redraw();
      } catch (err) {
        typedOut.textContent = src ? (err as Error).message : "…";
        typedOut.classList.toggle("bad", !!src); typedInput.setAttribute("aria-invalid", String(!!src));
      }
      return;
    }
    const r = parseTyped(typedInput.value);
    typedOut.textContent = r.ok ? r.text ?? "" : r.error || "…";
    typedOut.classList.toggle("bad", !r.ok && !!r.error);
    typedInput.setAttribute("aria-invalid", String(!r.ok && !!r.error));
    // the rubber band follows the typed point
    if (r.ok && r.point) cursor = { u: r.point.u, v: r.point.v, snap: null };
    redraw();
  }
  function openTyped(first: string) {
    const hr = host.getBoundingClientRect();
    const at = pointerAt ?? { x: hr.width / 2, y: hr.height / 2 };
    typedHelp.textContent = typedHelpText();
    typed.hidden = false;
    const w = typed.offsetWidth, h = typed.offsetHeight;
    // under the pointer readout, kept inside the view
    typed.style.left = `${Math.max(4, Math.min(at.x + 14, hr.width - w - 4))}px`;
    typed.style.top = `${at.y + 44 + h > hr.height ? Math.max(4, at.y - 20 - h) : at.y + 44}px`;
    typedInput.value = first;
    typedInput.focus();
    typedInput.setSelectionRange(first.length, first.length);
    updateTyped();
  }
  function closeTyped() {
    if (typed.hidden) return;
    typed.hidden = true;
    typedInput.value = "";
    if (document.activeElement === typedInput) typedInput.blur();
    redraw();
  }
  typedInput.addEventListener("input", updateTyped);
  typedInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (heightStep()) {
        try { evaluate(typedInput.value.trim(), names().names); setHeightDraft(typedInput.value.trim()); finishHeight(typedInput.value.trim()); closeTyped(); }
        catch { typedOut.classList.add("bad"); }
      } else if (placeTyped(typedInput.value)) closeTyped();
      else typedOut.classList.add("bad");
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeTyped();
    }
  });
  typedInput.addEventListener("blur", () => setTimeout(closeTyped, 0));

  // ---- "Pick face": the next click on an axis-aligned face of a part sets the work plane
  const faceGeo = new THREE.BufferGeometry();
  const faceMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, depthTest: false, side: THREE.DoubleSide });
  const faceMesh = new THREE.Mesh(faceGeo, faceMat);
  faceMesh.renderOrder = 10;
  faceMesh.visible = false;
  group.add(faceMesh);
  const boundaryGeo = new THREE.BufferGeometry();
  const boundaryMat = new THREE.LineBasicMaterial({ depthTest: false, transparent: true, linewidth: 2 });
  const boundaryLines = new THREE.LineSegments(boundaryGeo, boundaryMat);
  boundaryLines.renderOrder = 12;
  group.add(boundaryLines);
  let highlight = emptyFaceHighlight<Face | NonNullable<ReturnType<typeof extrudeAt>>>();
  function renderFaceHighlight() {
    const f = highlight.selected ?? highlight.hover;
    const tris = f && typeof f === "object" ? ("tris" in f ? f.tris : []) : [];
    const tuples = tris.map((v) => v instanceof THREE.Vector3 ? v.toArray() as [number,number,number] : v as [number,number,number]);
    setPoints3(faceGeo, tuples.map((v) => new THREE.Vector3(...v)));
    setPoints3(boundaryGeo, faceBoundary(tuples).map((v) => new THREE.Vector3(...v)));
    faceMesh.visible = !!tris.length;
    boundaryLines.visible = !!tris.length;
    requestRender();
  }
  const clearSelectedFace = () => { highlight = clearFaceHighlight(highlight); renderFaceHighlight(); };
  window.addEventListener("fairbeam:extrude-face-close", clearSelectedFace);
  type Face = PickedFace;

  /** The part face under the pointer, including unsupported curved and slanted faces. */
  function faceAt(e: PointerEvent): Face | "curved" | "slanted" | null {
    camera.updateMatrixWorld();
    const r = canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const meshes: THREE.Object3D[] = [];
    scene.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && o.userData.part) meshes.push(o); });
    const h = ray.intersectObjects(meshes, false)[0];
    if (!h?.face) return null;
    const candidate = resolveFaceCandidate(h, ray.ray.direction);
    return candidate;
  }
  function extrudeAt(e: PointerEvent) {
    camera.updateMatrixWorld();
    const r = canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX-r.left)/r.width)*2-1, -((e.clientY-r.top)/r.height)*2+1), camera);
    const meshes: THREE.Object3D[] = [];
    scene.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && o.userData.part) meshes.push(o); });
    const h = ray.intersectObjects(meshes, false)[0];
    return h ? resolveFaceCandidate(h, ray.ray.direction) : null;
  }
  function showFace(e: PointerEvent) {
    if (extrudeFacePicking()) {
      const candidate = extrudeAt(e);
      const ok = !!candidate && candidate !== "slanted" && candidate !== "curved";
      highlight = hoverFace(highlight, ok ? candidate : null);
      renderFaceHighlight();
      canvas.style.cursor = candidate === "slanted" || candidate === "curved" ? "not-allowed" : "crosshair";
      readout.textContent = candidate === "curved" ? "Curved faces cannot be extruded" : candidate === "slanted" ? "Slanted faces cannot be extruded" : ok ? `Extrude ${candidate.part} · click to select` : "Pick a flat, axis aligned face · Esc cancels";
      placeReadout(e); requestRender(); return;
    }
    const f = faceAt(e);
    const ok = !!f && f !== "slanted" && f !== "curved";
    highlight = hoverFace(highlight, ok ? f : null);
    renderFaceHighlight();
    canvas.style.cursor = f === "slanted" || f === "curved" ? "not-allowed" : "crosshair";
    let text = t("draw.wcs.facePrompt");
    if (f === "curved") text = t("draw.wcs.faceCurved");
    else if (f === "slanted") text = t("draw.wcs.faceSlanted");
    else if (f) {
      const { elevation, label } = faceElevation(AXES[f.axis], f.value, f.part);
      text = t("draw.wcs.faceHover", { face: label, w: `${f.sign < 0 ? "-" : "+"}${AXES[f.axis]}`, at: typeof elevation === "number" ? fmt(elevation) : `${elevation} (${fmt(f.value)})` });
    }
    readout.textContent = text;
    placeReadout(e);
    requestRender();
  }
  function endFacePick() {
    if (!highlight.selected) { highlight = hoverFace(highlight, null); renderFaceHighlight(); }
    readout.hidden = true;
    requestRender();
  }

  let downAt: { x: number; y: number } | null = null;
  const onMove = (e: PointerEvent) => {
    const r = host.getBoundingClientRect();
    pointerAt = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (facePicking() || extrudeFacePicking()) return showFace(e);
    if (heightStep()) { if (typed.hidden) updateHeightFromPointer(e); redraw(); return; }
    const placement = transformPlacement();
    if (placement && transformAnchor()) {
      placed = placementHit(e);
      if (placed) {
        window.dispatchEvent(new CustomEvent("fairbeam:transform-placement", { detail: { kind: "target", point: placed.world.toArray(), snap: placed.cursor.snap, bypass: e.altKey, face: placed.face } }));
      }
      showPlacementReadout(e, placed); redraw(); return;
    }
    if (placement) {
      const a = anchorHit(e, placement.part);
      placed = null;
      readout.textContent = a ? `Anchor (${a.point.map(fmt).join(", ")}) mm${a.snap ? ` · ${a.snap}` : ""} · click to set · Esc cancels` : `Click ${placement.part} to set the anchor · Esc cancels`;
      placeReadout(e); redraw(); return;
    }
    if (!tool() || !typed.hidden) return;
    cursor = hit(e);
    showReadout(e, cursor);
    redraw();
  };
  const onDown = (e: PointerEvent) => { downAt = (tool() || heightStep() || facePicking() || extrudeFacePicking() || transformPlacement()) && e.button === 0 && !e.altKey ? { x: e.clientX, y: e.clientY } : null; };
  const onUp = (e: PointerEvent) => {
    const placement = transformPlacement();
    if (placement && e.button === 0) {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4;
      downAt = null;
      if (moved) return;
      if (!transformAnchor()) {
        const a = anchorHit(e, placement.part);
        if (a) {
          setTransformAnchor(a.point);
          window.dispatchEvent(new CustomEvent("fairbeam:transform-placement", { detail: { kind: "anchor", point: a.point } }));
        }
      } else {
        const p = placementHit(e);
        if (p) {
          window.dispatchEvent(new CustomEvent("fairbeam:transform-placement", { detail: { kind: "target", point: p.world.toArray(), snap: p.cursor.snap, bypass: e.altKey, face: p.face, accept: true } }));
        }
      }
      return;
    }
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
    downAt = null;
    if (extrudeFacePicking()) {
      const candidate = extrudeAt(e);
      if (candidate === "curved" || candidate === "slanted") { readout.textContent = candidate === "curved" ? "Curved faces cannot be extruded" : "Slanted faces cannot be extruded"; placeReadout(e); return; }
      if (candidate) { highlight = selectFace(highlight, candidate); highlight = hoverFace(highlight, null); renderFaceHighlight(); setExtrudeFacePicking(false); window.dispatchEvent(new CustomEvent("fairbeam:extrude-face-pick", { detail: candidate })); }
      return;
    }
    if (heightStep()) { finishHeight(heightDraft()); return; }
    if (facePicking()) {
      const f = faceAt(e);
      if (f === "slanted" || f === "curved") setMessage({ tone: "warn", text: t("draw.wcs.faceUnsupported") });
      else if (f) { highlight = hoverFace(highlight, null); renderFaceHighlight(); alignWcsWithFace(f); }
      return;
    }
    if (!tool()) return;
    const c = hit(e);
    if (c) place(c.u, c.v);
    cursor = c;
    redraw();
  };
  const onDbl = (e: MouseEvent) => {
    if (heightStep()) { e.preventDefault(); finishHeight(heightDraft()); return; }
    if (tool() !== "polygon") return;
    e.preventDefault();
    if (points().length >= 3) commit();
  };
  const onLeave = () => { readout.hidden = true; cursor = null; placed = null; if (!highlight.selected) { highlight = hoverFace(highlight, null); renderFaceHighlight(); } redraw(); };
  const onKey = (e: KeyboardEvent) => {
    if (extrudeFacePicking() && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setExtrudeFacePicking(false); return; }
    if (facePicking() && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setFacePicking(false); return; }
    const t = e.target as HTMLElement | null;
    // menus own their keys (Esc closes the menu first, as in DesignKeys' overlay guard)
    if (t?.matches?.("input, textarea, select") || t?.closest?.(".dialog, .scrim, .rb-pop, [role=menu]")) return;
    // an open folded ribbon group closes on Esc before Esc reaches the drawing tool
    if (e.key === "Escape" && t?.closest?.(".rb-group[data-open]")) return;
    if (heightStep()) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); return; }
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finishHeight(heightDraft()); return; }
    }
    if (!tool()) return;
    // a coordinate starts with a digit, a sign, "@" (relative), "=" (absolute) or a parameter name
    // AltGr counts as typing: Windows reports it as Ctrl+Alt, and it types "@" on many layouts
    // (Turkish Q: AltGr+Q, German: AltGr+Q)
    const typing = e.getModifierState("AltGraph") || (!e.metaKey && !e.ctrlKey && !e.altKey);
    if (e.key.toLowerCase() === "s" && typing && !e.shiftKey) return;
    if (/^[\w.@=(-]$/.test(e.key) && typing) { e.preventDefault(); e.stopPropagation(); openTyped(e.key); return; }
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      const action = drawEscapeAction(tool(), points().length, heightStep());
      if (action === "open-dialog") {
        const activeTool = tool();
        const kind = activeTool === "brick" ? "box" : activeTool === "cylinder" ? "cylinder" : "polygon";
        openShapeDialog(kind);
        startTool(null);
      } else if (action === "step-back") cancel();
    }
    else if (e.key === "Enter" && tool() === "polygon" && points().length >= 3) { e.preventDefault(); commit(); }
    else if (e.key === "Backspace" || e.key === "Delete") {
      // while drawing these edit the points, never delete the selected item
      e.preventDefault(); e.stopPropagation();
      if (points().length) undoPoint();
    }
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("dblclick", onDbl);
  canvas.addEventListener("pointerleave", onLeave);
  window.addEventListener("keydown", onKey, true);

  const dispose = createRoot((d) => {
    createEffect(on([tool, () => plane().normal, localFrame, names, wcsVisible, appMode, snap, () => layers.guideGrid, ctx.bundle, transformPlacement], () => {
      colours();
      const worldValue = drawingPlaneWorldValue();
      const geometry = snapGeometry(ctx.bundle(), n(), worldValue, transformPlacement()?.part);
      snapGeo = tool() ? localizeSnapGeometry(geometry) : geometry;
      placeGeo = new Map();
      if (!transformPlacement()) placed = null;
      canvas.style.cursor = tool() || facePicking() || extrudeFacePicking() || transformPlacement() ? "crosshair" : "";
      if (!tool()) { readout.hidden = true; closeTyped(); }
      if (!tool() && !transformPlacement()) cursor = null;
      rebuildGrid();
      redraw();
    }));
    createEffect(on([points, heightStep, heightDraft], redraw, { defer: true }));
    createEffect(on(facePicking, (on) => {
      canvas.style.cursor = on || tool() ? "crosshair" : "";
      if (!on) endFacePick();
    }, { defer: true }));
    createEffect(on(extrudeFacePicking, (on) => {
      canvas.style.cursor = on || tool() ? "crosshair" : "";
      if (!on) endFacePick();
    }, { defer: true }));
    createEffect(on([ghost, ghostFrameTransforms, names], () => {
      colours();
      const segs = outline(ghost(), names().names, ghostFrameTransforms());
      setPoints3(ghostGeo, segs);
      ghostLines.visible = segs.length > 0;
      requestRender();
    }));
    return d;
  });

  return () => {
    dispose();
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("dblclick", onDbl);
    canvas.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("fairbeam:extrude-face-close", clearSelectedFace);
    readout.remove();
    typed.remove();
    scene.remove(group);
    lineGeo.dispose(); dotGeo.dispose(); snapDotGeo.dispose(); ghostGeo.dispose(); heightGeo.dispose(); faceGeo.dispose();
    lineMat.dispose(); dotMat.dispose(); snapMat.dispose(); ghostMat.dispose(); heightMat.dispose(); faceMat.dispose(); boundaryGeo.dispose(); boundaryMat.dispose();
  };
}
