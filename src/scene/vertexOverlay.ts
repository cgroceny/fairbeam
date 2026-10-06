// Vertex editing in the 3D view (#66): square handles on the points of the polygon, extruded
// polygon or wire being edited, and "+" handles on its edges. Drag a point to move it, drag or click
// a "+" to insert a point, click a point to pick it and press Delete to remove it. Dragging uses the
// draw tools' snapping (points, corners, midpoints, edges, grid; Alt places freely) on the sheet's
// plane, or for a wire on the plane parallel to the work plane through the point. Every change is
// one design edit, so one undo step.
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { createEffect, createRoot, on } from "solid-js";
import { facePicking, plane, planeAxes, tool } from "../designer/draw";
import { draft, names } from "../designer/store";
import { evaluate } from "../designer/expr";
import { pointPickMode } from "../designer/pointTools";
import { t } from "../i18n/index.ts";
import {
  deleteVertex, insertVertexAt, moveVertexTo, pickVertex, pickedVertex, stopVertexEdit, targetPrimitive, vertexTarget,
} from "../designer/vertexEdit";
import { closedOutline, edgeMidpoint, storedPoint, vertexFrame, type VertexFrame } from "../designer/vertexModel";
import { cssVar } from "../lib/cssvar";
import { theme } from "../state";
import type { Bundle } from "../types";
import { planeSnap, snapGeometry, type Cursor, type SnapGeo } from "./drawOverlay";
import { transformPlacement } from "./transformSnap";

type V3 = [number, number, number];
const AXES = ["x", "y", "z"] as const;
const VERTEX_PX = 9;
const MID_PX = 8;
const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

interface Ctx {
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  requestRender: () => void;
  bundle: () => Bundle | null;
}

type Handle = { kind: "vertex" | "mid"; k: number };
interface Drag extends Handle {
  x: number; y: number; moved: boolean;
  axis: number; value: number; origin: [number, number]; geo: SnapGeo;
  cursor: Cursor | null; world: V3 | null;
}

function setPoints3(geo: THREE.BufferGeometry, pts: V3[]) {
  const a = new Float32Array(pts.length * 3);
  pts.forEach((p, k) => { a[3 * k] = p[0]; a[3 * k + 1] = p[1]; a[3 * k + 2] = p[2]; });
  geo.setAttribute("position", new THREE.BufferAttribute(a, 3));
  geo.computeBoundingSphere();
}

export function attachVertexOverlay(ctx: Ctx): () => void {
  const { host, canvas, scene, camera, requestRender } = ctx;
  const group = new THREE.Group();
  group.name = "vertex-edit";
  scene.add(group);
  const mk = (size: number, opacity: number) => {
    const geo = new THREE.BufferGeometry();
    const mat = new THREE.PointsMaterial({ size, sizeAttenuation: false, depthTest: false, transparent: true, opacity });
    const pts = new THREE.Points(geo, mat);
    pts.renderOrder = 31;
    group.add(pts);
    return { geo, mat, pts };
  };
  const outlineGeo = new THREE.BufferGeometry();
  const outlineMat = new THREE.LineBasicMaterial({ depthTest: false, transparent: true, opacity: 0.75 });
  const outline = new THREE.Line(outlineGeo, outlineMat);
  outline.renderOrder = 30;
  const dragGeo = new THREE.BufferGeometry();
  const dragMat = new THREE.LineDashedMaterial({ depthTest: false, transparent: true, opacity: 0.95, dashSize: 1, gapSize: 0.5 });
  const dragLine = new THREE.Line(dragGeo, dragMat);
  dragLine.renderOrder = 30;
  group.add(outline, dragLine);
  const mids = mk(7, 0.55);
  const verts = mk(9, 0.95);
  const hot = mk(14, 0.6);
  const labelEl = document.createElement("div");
  labelEl.className = "vp-point-marker";
  const label = new CSS2DObject(labelEl);
  label.visible = false;
  group.add(label);

  const readout = document.createElement("div");
  readout.className = "vp-draw-readout";
  readout.hidden = true;
  host.appendChild(readout);

  let frame: VertexFrame | null = null;
  let midWorld: (V3 | null)[] = [];
  let hover: Handle | null = null;
  let drag: Drag | null = null;
  let blocked: { handle: Handle; x: number; y: number; moved: boolean } | null = null;

  const active = () => !!vertexTarget() && !tool() && !facePicking() && !transformPlacement() && !pointPickMode();

  function colours() {
    const accent = new THREE.Color(cssVar("--al-focus") || "#d98b4f");
    const text = new THREE.Color(cssVar("--al-text") || "#ddd");
    outlineMat.color = accent; dragMat.color = accent;
    verts.mat.color = accent; mids.mat.color = text; hot.mat.color = text;
  }

  function outlinePoints(world: V3[], closed: boolean): V3[] {
    return closed && world.length ? [...world, world[0]] : world;
  }

  /** Handles from the draft (not the preview bundle), so they follow an edit at once. */
  function rebuild() {
    const t = vertexTarget(), prim = targetPrimitive();
    frame = t && prim && active() ? vertexFrame(draft.parts[t.i], prim, names().names) : null;
    group.visible = !!frame;
    if (!frame || !prim) {
      midWorld = [];
      readout.hidden = true;
      label.visible = false;
      canvas.style.cursor = drag ? canvas.style.cursor : "";
      return requestRender();
    }
    const w = frame.world, closed = closedOutline(prim);
    midWorld = w.map((p, k) => {
      const q = closed ? w[(k + 1) % w.length] : w[k + 1];
      return q ? ([0, 1, 2].map((c) => (p[c] + q[c]) / 2) as V3) : null;
    });
    setPoints3(outlineGeo, outlinePoints(w, closed));
    setPoints3(verts.geo, w);
    setPoints3(mids.geo, midWorld.filter((p): p is V3 => !!p));
    const k = pickedVertex();
    const hotAt: V3[] = [];
    if (k !== null && w[k]) hotAt.push(w[k]);
    if (hover && !drag) {
      const h = hover.kind === "vertex" ? w[hover.k] : midWorld[hover.k];
      if (h) hotAt.push(h);
    }
    setPoints3(hot.geo, hotAt);
    label.visible = k !== null && !!w[k];
    if (label.visible) { labelEl.textContent = `P${k! + 1}`; label.position.set(...w[k!]); }
    requestRender();
  }

  /** The handle under the pointer: a point first, then an edge's "+". */
  function handleAt(e: PointerEvent): Handle | null {
    if (!frame) return null;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const v = new THREE.Vector3();
    const dist = (p: V3) => {
      v.set(...p).project(camera);
      if (v.z > 1) return Infinity;
      return Math.hypot((v.x + 1) / 2 * r.width - mx, (1 - v.y) / 2 * r.height - my);
    };
    let best: Handle | null = null, d0 = VERTEX_PX;
    for (let k = 0; k < frame.world.length; k++) {
      const d = dist(frame.world[k]);
      if (d < d0) { d0 = d; best = { kind: "vertex", k }; }
    }
    if (best) return best;
    d0 = MID_PX;
    for (let k = 0; k < midWorld.length; k++) {
      const p = midWorld[k];
      const d = p ? dist(p) : Infinity;
      if (d < d0) { d0 = d; best = { kind: "mid", k }; }
    }
    return best;
  }

  function placeReadout(e: PointerEvent, text: string) {
    readout.textContent = text;
    const r = host.getBoundingClientRect();
    readout.hidden = false;
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const w = readout.offsetWidth, h = readout.offsetHeight;
    readout.style.left = `${x + 14 + w > r.width ? Math.max(0, x - 14 - w) : x + 14}px`;
    readout.style.top = `${y + 14 + h > r.height ? Math.max(0, y - 14 - h) : y + 14}px`;
  }

  function wcsOrigin(axis: number): [number, number] {
    const p = plane();
    if (AXES.indexOf(p.normal) !== axis) return [0, 0];
    try {
      const o: [number, number] = [evaluate(p.originU, names().names), evaluate(p.originV, names().names)];
      return o.every(Number.isFinite) ? o : [0, 0];
    } catch { return [0, 0]; }
  }

  function beginDrag(e: PointerEvent, h: Handle) {
    if (!frame?.dragSupported) return;
    const at = h.kind === "vertex" ? frame.world[h.k] : midWorld[h.k];
    if (!at) return;
    // a sheet moves in its own plane; a wire point on the plane parallel to the WCS through it
    const axis = frame.planeAxis ?? AXES.indexOf(plane().normal);
    const value = frame.planeValue ?? at[axis];
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const others = frame.world.filter((p, k) => !(h.kind === "vertex" && k === h.k) && Math.abs(p[axis] - value) < 1e-6);
    drag = {
      ...h, x: e.clientX, y: e.clientY, moved: false, axis, value, origin: wcsOrigin(axis),
      geo: snapGeometry(ctx.bundle(), axis, value), cursor: null, world: null,
    };
    // the edited shape's own other points snap too (a wire's are not in the snap geometry)
    drag.geo = { ...drag.geo, points: [...drag.geo.points, ...others.map((p) => ({ u: p[u], v: p[v], kind: "corner" as const }))] };
  }

  function dragTo(e: PointerEvent) {
    if (!drag || !frame) return;
    const prim = targetPrimitive();
    if (!prim) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) <= 4) return;
    drag.moved = true;
    const c = planeSnap(e, { canvas, camera, axis: drag.axis, value: drag.value, origin: drag.origin, geo: drag.geo, points: [], free: e.altKey });
    drag.cursor = c;
    if (!c) { drag.world = null; return; }
    const world: V3 = [0, 0, 0];
    world[drag.axis] = drag.value; world[(drag.axis + 1) % 3] = c.u; world[(drag.axis + 2) % 3] = c.v;
    drag.world = world;
    const w = [...frame.world];
    if (drag.kind === "vertex") w[drag.k] = world;
    else w.splice(drag.k + 1, 0, world);
    setPoints3(dragGeo, outlinePoints(w, closedOutline(prim)));
    dragLine.computeLineDistances();
    const span = Math.max(1e-3, ...[0, 1, 2].map((k) => Math.max(...w.map((p) => p[k])) - Math.min(...w.map((p) => p[k]))));
    dragMat.dashSize = span / 40; dragMat.gapSize = span / 80;
    dragLine.visible = true;
    setPoints3(hot.geo, [world]);
    const [un, vn] = planeAxes(AXES[drag.axis]);
    const what = drag.kind === "vertex" ? `P${drag.k + 1}` : `new point after P${drag.k + 1}`;
    const snapText = c.snap ? ` · ${c.snap}` : e.altKey ? " · Alt: snapping off" : "";
    placeReadout(e, `${what} · ${un} ${fmt(c.u)}  ${vn} ${fmt(c.v)}  ${AXES[drag.axis]} ${fmt(drag.value)}${snapText}`);
    requestRender();
  }

  function endDrag(e: PointerEvent) {
    const d = drag, t = vertexTarget(), prim = targetPrimitive();
    drag = null;
    dragLine.visible = false;
    if (!d || !t || !prim || !frame) { rebuild(); return; }
    if (!d.moved) {
      if (d.kind === "vertex") pickVertex(d.k);
      else {
        const mid = edgeMidpoint(prim, d.k, names().names);
        if (mid) insertVertexAt(t, d.k, mid);
      }
    } else if (d.world) {
      if (d.kind === "vertex") {
        moveVertexTo(t, d.k, storedPoint(prim, frame.map, d.world, prim.points[d.k] as (string | number)[], frame.planeAxis === undefined ? d.axis : undefined));
        pickVertex(d.k);
      } else insertVertexAt(t, d.k, storedPoint(prim, frame.map, d.world));
    }
    readout.hidden = true;
    hover = handleAt(e);
    rebuild();
  }

  const onDown = (e: PointerEvent) => {
    if (!active() || e.button !== 0 || e.ctrlKey || e.metaKey) return;
    const h = handleAt(e);
    if (!h) return;
    // the handle takes the press: no orbit, no part pick
    e.stopImmediatePropagation();
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    if (!frame?.dragSupported) {
      blocked = { handle: h, x: e.clientX, y: e.clientY, moved: false };
      canvas.style.cursor = "not-allowed";
      placeReadout(e, t("designer.vertexDragTiltedUnsupported"));
      return;
    }
    beginDrag(e, h);
  };
  const onMove = (e: PointerEvent) => {
    if (drag) { dragTo(e); return; }
    if (blocked) {
      if (Math.hypot(e.clientX - blocked.x, e.clientY - blocked.y) > 4) blocked.moved = true;
      canvas.style.cursor = "not-allowed";
      placeReadout(e, t("designer.vertexDragTiltedUnsupported"));
      return;
    }
    if (!active() || e.buttons) return;
    const h = handleAt(e);
    const changed = h?.kind !== hover?.kind || h?.k !== hover?.k;
    hover = h;
    canvas.style.cursor = h ? (frame?.dragSupported ? (h.kind === "vertex" ? "grab" : "copy") : "not-allowed") : "";
    if (h && frame) {
      const prim = targetPrimitive();
      const p = h.kind === "vertex" ? frame.world[h.k] : midWorld[h.k];
      const pos = p ? p.map(fmt).join(", ") : "";
      placeReadout(e, !frame.dragSupported
        ? t("designer.vertexDragTiltedUnsupported")
        : h.kind === "vertex"
          ? `P${h.k + 1} (${pos}) mm · drag to move · click, then Delete removes`
          : `+ between P${h.k + 1} and P${(prim && closedOutline(prim) ? (h.k + 1) % frame.world.length : h.k + 1) + 1} · click or drag to insert`);
    } else readout.hidden = true;
    if (changed) rebuild();
  };
  const onUp = (e: PointerEvent) => {
    if (blocked && e.button === 0) {
      const b = blocked;
      blocked = null;
      e.stopImmediatePropagation();
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      if (!b.moved) {
        const target = vertexTarget(), prim = targetPrimitive();
        if (target && prim) {
          if (b.handle.kind === "vertex") pickVertex(b.handle.k);
          else {
            const mid = edgeMidpoint(prim, b.handle.k, names().names);
            if (mid) insertVertexAt(target, b.handle.k, mid);
          }
        }
      }
      readout.hidden = true;
      hover = handleAt(e);
      rebuild();
      return;
    }
    if (!drag || e.button !== 0) return;
    e.stopImmediatePropagation();
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    endDrag(e);
  };
  const onLeave = () => { if (!drag && !blocked) { readout.hidden = true; if (hover) { hover = null; rebuild(); } } };
  const onKey = (e: KeyboardEvent) => {
    if (!vertexTarget()) return;
    const t = e.target as HTMLElement | null;
    if (t?.matches?.("input, textarea, select") || t?.closest?.(".dialog, .scrim, .rb-pop, [role=menu]")) return;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation();
      if (drag || blocked) { drag = null; blocked = null; dragLine.visible = false; readout.hidden = true; rebuild(); }
      else if (pickedVertex() !== null) pickVertex(null);
      else stopVertexEdit();
    } else if ((e.key === "Delete" || e.key === "Backspace") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // while editing points these keys edit the points, never delete the part
      e.preventDefault(); e.stopImmediatePropagation();
      const k = pickedVertex(), target = vertexTarget();
      if (k !== null && target && !drag) deleteVertex(target, k);
    }
  };
  canvas.addEventListener("pointerdown", onDown, true);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp, true);
  canvas.addEventListener("pointerleave", onLeave);
  window.addEventListener("keydown", onKey, true);

  const dispose = createRoot((d) => {
    createEffect(on([vertexTarget, pickedVertex, () => { const t = vertexTarget(); return t ? JSON.stringify(draft.parts?.[t.i]) : ""; },
      names, theme, tool, facePicking, transformPlacement, pointPickMode], () => {
      colours();
      if (!vertexTarget()) { drag = null; blocked = null; hover = null; dragLine.visible = false; }
      rebuild();
    }));
    return d;
  });

  return () => {
    dispose();
    canvas.removeEventListener("pointerdown", onDown, true);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp, true);
    canvas.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("keydown", onKey, true);
    readout.remove();
    labelEl.remove();
    scene.remove(group);
    for (const g of [outlineGeo, dragGeo, mids.geo, verts.geo, hot.geo]) g.dispose();
    for (const m of [outlineMat, dragMat, mids.mat, verts.mat, hot.mat]) m.dispose();
    requestRender();
  };
}
