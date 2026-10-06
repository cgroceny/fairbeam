import * as THREE from "three";
import { createEffect, createRoot } from "solid-js";
import { previewGeometry, transformSourceGeometry, transformGuide } from "../designer/transforms";
import { theme } from "../state";
import { cssVar } from "../lib/cssvar";
import { primitiveGeometry } from "./geometry";
import { transformOutline } from "./transformOutline";

/** Disposable, non-pickable dialog outlines in world coordinates. */
export function attachTransformOverlay(scene: THREE.Scene, requestRender: () => void): () => void {
  const group = new THREE.Group();
  group.name = "transform-preview";
  scene.add(group);
  const clear = () => {
    for (const child of [...group.children]) {
      const line = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
      line.geometry.dispose(); line.material.dispose(); group.remove(line);
    }
  };
  const dispose = createRoot((dispose) => {
    createEffect(() => {
      theme();
      clear();
      const color = cssVar("--al-3d-transform");
      for (const primitive of previewGeometry()) {
        // Flat PCB transformations stay coplanar: draw the *real* transformed surface over the
        // opaque source, with depth disabled. No world-coordinate offset, including for sheets.
        const surface = primitiveGeometry(primitive);
        if (surface) {
          const ghost = new THREE.Mesh(surface, new THREE.MeshBasicMaterial({color,
            side:THREE.DoubleSide, transparent:true, opacity:0.22, depthTest:false, depthWrite:false}));
          ghost.renderOrder = 19; group.add(ghost);
        }
        const edges = transformOutline(primitive);
        if (!edges) continue;
        const span = Math.max(...primitive.bbox[1].map((v, k) => v - primitive.bbox[0][k]), 0.01);
        const material = new THREE.LineDashedMaterial({ color: cssVar("--al-3d-transform"),
          dashSize: span / 24, gapSize: span / 48, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
        const line = new THREE.LineSegments(edges, material);
        line.computeLineDistances(); line.renderOrder = 20;
        group.add(line);
      }
      for (const primitive of transformSourceGeometry()) {
        const edges = transformOutline(primitive);
        if (!edges) continue;
        const reference = new THREE.LineSegments(edges,new THREE.LineBasicMaterial({color:cssVar("--al-text-3"),transparent:true,opacity:0.9,depthTest:false,depthWrite:false}));
        reference.renderOrder=22;group.add(reference);
      }
      const guide = transformGuide();
      if (guide && previewGeometry().length) {
        const radius = Math.max(1,...previewGeometry().flatMap(p => p.bbox.flatMap(q => q.map((x,k) => Math.abs(x-guide.point[k]))))) * 1.15;
        const {axis,point} = guide, u=(axis+1)%3,v=(axis+2)%3;
        const points:number[] = [];
        const segment=(a:number[],b:number[])=>points.push(...a,...b);
        if (guide.kind === "axis") {
          const a=[...point],b=[...point];a[axis]-=radius;b[axis]+=radius;segment(a,b);
          // A cross in the normal plane locates the rotation center even in a face-on view.
          for(const k of [u,v]) {const a=[...point],b=[...point];a[k]-=radius/12;b[k]+=radius/12;segment(a,b);}
        } else {
          const corners=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([a,b])=>{const p=[...point];p[u]+=a*radius;p[v]+=b*radius;return p;});
          corners.forEach((a,k)=>segment(a,corners[(k+1)%4]));
          segment(corners[0],corners[2]);segment(corners[1],corners[3]);
        }
        const reference = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position",new THREE.Float32BufferAttribute(points,3)),
          new THREE.LineBasicMaterial({color,transparent:true,opacity:0.65,depthTest:false,depthWrite:false}));
        reference.renderOrder=21;group.add(reference);
      }
      requestRender();
    });
    return dispose;
  });
  return () => { dispose(); clear(); scene.remove(group); requestRender(); };
}
