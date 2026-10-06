import * as THREE from "three";
import { createEffect, createRoot } from "solid-js";
import { booleanFlash, booleanPreviewGeometry, FLASH_MS, operandBToken } from "../designer/booleanPreview";
import { theme } from "../state";
import { cssVar } from "../lib/cssvar";
import { primitiveGeometry } from "./geometry";
import type { Primitive } from "../types";

/**
 * The Boolean set-up in the 3D view (designer/booleanPreview.ts): translucent A and B, the common
 * volume drawn through everything, and the result as a ghost outline. Not pickable; theme-aware.
 */
export function attachBooleanOverlay(scene: THREE.Scene, requestRender: () => void): () => void {
  const group = new THREE.Group();
  group.name = "boolean-preview";
  scene.add(group);
  const clear = () => {
    for (const child of [...group.children]) {
      const o = child as THREE.Mesh | THREE.LineSegments;
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
      group.remove(o);
    }
  };
  const add = (prims: Primitive[], color: string, fill: number, edge: number, through: boolean, order: number, dashed = false) => {
    for (const p of prims) {
      const g = primitiveGeometry(p);
      if (!g) continue;
      if (fill > 0) {
        const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fill, depthWrite: false,
          depthTest: !through, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
        mesh.renderOrder = order;
        mesh.raycast = () => {};
        group.add(mesh);
      }
      const edges = new THREE.EdgesGeometry(g, 20);
      const material = dashed
        ? new THREE.LineDashedMaterial({ color, transparent: true, opacity: edge, depthTest: false, depthWrite: false, dashSize: 0.6, gapSize: 0.35 })
        : new THREE.LineBasicMaterial({ color, transparent: true, opacity: edge, depthTest: !through, depthWrite: false });
      const line = new THREE.LineSegments(edges, material);
      if (dashed) {
        const box = new THREE.Box3().setFromBufferAttribute(g.getAttribute("position") as THREE.BufferAttribute);
        const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z, 0.01);
        (material as THREE.LineDashedMaterial).dashSize = span / 16;
        (material as THREE.LineDashedMaterial).gapSize = span / 32;
        line.computeLineDistances();
      }
      line.renderOrder = order + 1;
      line.raycast = () => {};
      group.add(line);
      if (fill <= 0) g.dispose();
    }
  };
  const dispose = createRoot((dispose) => {
    createEffect(() => {
      theme();
      const view = booleanPreviewGeometry();
      clear();
      if (view) {
        add(view.a, cssVar("--al-3d-bool-a"), 0.3, 0.95, false, 30);
        // a candidate B keeps its own mesh: its colour is drawn over it
        add(view.b, cssVar(operandBToken(view.operation)), view.candidate ? 0.45 : 0.3, 0.95, view.candidate, 32);
        add(view.intersection, cssVar("--al-3d-bool-both"), 0.6, 1, true, 34);
        add(view.result, cssVar("--al-3d-bool-result"), 0.08, 0.95, true, 36, true);
        add(view.resultCut, cssVar("--al-3d-cutout"), 0.3, 1, true, 38);
      }
      requestRender();
    });
    return dispose;
  });
  // the region a Subtract just removed pulses in the cut-out colour, through everything, then fades out
  const flashGroup = new THREE.Group();
  flashGroup.name = "boolean-flash";
  scene.add(flashGroup);
  let frame = 0;
  const clearFlash = () => {
    cancelAnimationFrame(frame);
    for (const child of [...flashGroup.children]) {
      const o = child as THREE.Mesh | THREE.LineSegments;
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
      flashGroup.remove(o);
    }
  };
  const disposeFlash = createRoot((dispose) => {
    createEffect(() => {
      theme();
      const flash = booleanFlash();
      clearFlash();
      if (flash) {
        const color = cssVar("--al-3d-cutout");
        const materials: THREE.Material[] = [];
        for (const p of flash.shapes) {
          const g = primitiveGeometry(p);
          if (!g) continue;
          const fill = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
          const mesh = new THREE.Mesh(g, fill);
          mesh.renderOrder = 40; mesh.raycast = () => {};
          const edge = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
          const line = new THREE.LineSegments(new THREE.EdgesGeometry(g, 20), edge);
          line.renderOrder = 41; line.raycast = () => {};
          flashGroup.add(mesh, line);
          materials.push(fill, edge);
        }
        const start = performance.now();
        const tick = () => {
          const t = (performance.now() - start) / FLASH_MS;
          // three pulses, fading over the last third
          const level = t >= 1 ? 0 : Math.abs(Math.sin(t * Math.PI * 3)) * Math.min(1, (1 - t) * 3);
          materials.forEach((m, k) => { (m as THREE.MeshBasicMaterial).opacity = k % 2 ? 0.4 + 0.6 * level : 0.65 * level; });
          requestRender();
          if (t < 1) frame = requestAnimationFrame(tick);
        };
        tick();
      }
      requestRender();
    });
    return dispose;
  });
  return () => { dispose(); clear(); scene.remove(group); disposeFlash(); clearFlash(); scene.remove(flashGroup); requestRender(); };
}
