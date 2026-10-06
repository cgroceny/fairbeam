// Camera framing for rendered images: where to put the camera so the model fills the picture with a
// small margin, for any angle, aspect ratio and projection. Plain vectors, no renderer, so
// scripts/check-render.mjs can test it.
import * as THREE from "three";
import { VIEW_DIRECTIONS, type ViewName } from "../scene/cameraViews.ts";
import type { RenderProjection } from "./options.ts";

export interface Framing {
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  projection: RenderProjection;
  /** perspective: vertical field of view in degrees */
  fov: number;
  /** orthographic: half the visible height in drawing units (the width follows from the aspect) */
  halfHeight: number;
  near: number;
  far: number;
}

/** The camera's snapshot of the live view ("current view"): where it is and what it looks at. */
export interface ViewState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  /** the viewport's own projection is always perspective today, kept for completeness */
  projection?: RenderProjection;
}

export const FRAME_MARGIN = 1.08;
export const DEFAULT_FOV = 32;

const UP = new THREE.Vector3(0, 0, 1);

function corners(box: THREE.Box3): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) out.push(new THREE.Vector3(x, y, z));
  return out;
}

/** Camera basis for a view direction (camera - target), Z up. */
function basis(direction: THREE.Vector3, up: THREE.Vector3) {
  const back = direction.clone().normalize();
  const right = new THREE.Vector3().crossVectors(up, back);
  if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
  right.normalize();
  const upv = new THREE.Vector3().crossVectors(back, right).normalize();
  return { back, right, up: upv };
}

/**
 * Fit `box` into a picture of the given aspect (width / height) seen along `direction` (from the
 * target towards the camera). The result is tight: the nearest limit of the box touches the margin,
 * and the box is centred in the picture, not only its bounding sphere.
 */
export function frameBox(box: THREE.Box3, direction: THREE.Vector3, aspect: number, projection: RenderProjection, fov = DEFAULT_FOV, margin = FRAME_MARGIN): Framing {
  const cs = corners(box);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-9);
  const { back, right, up } = basis(direction, UP);
  const tanV = Math.tan(THREE.MathUtils.degToRad(fov) / 2), tanH = tanV * aspect;
  const target = centre.clone();
  let distance = radius / Math.sin(THREE.MathUtils.degToRad(fov) / 2);
  let halfHeight = radius;
  const rel = (c: THREE.Vector3) => c.clone().sub(target);

  if (projection === "orthographic") {
    // centre the projected extents, then size the picture to the larger of the two
    const xs = cs.map((c) => rel(c).dot(right)), ys = cs.map((c) => rel(c).dot(up));
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    target.addScaledVector(right, cx).addScaledVector(up, cy);
    const w = (Math.max(...xs) - Math.min(...xs)) / 2 * margin, h = (Math.max(...ys) - Math.min(...ys)) / 2 * margin;
    halfHeight = Math.max(h, w / aspect, 1e-9);
    distance = radius * 3;
  } else {
    for (let i = 0; i < 6; i++) {
      // the distance at which every corner is inside the picture, then shift to centre the extents
      let d = 0;
      for (const c of cs) {
        const r = rel(c);
        const z = r.dot(back);
        d = Math.max(d, z + Math.abs(r.dot(right)) * margin / tanH, z + Math.abs(r.dot(up)) * margin / tanV);
      }
      distance = Math.max(d, radius * 0.05);
      const nx: number[] = [], ny: number[] = [];
      for (const c of cs) {
        const r = rel(c);
        const depth = Math.max(distance - r.dot(back), 1e-9);
        nx.push(r.dot(right) / (depth * tanH)); ny.push(r.dot(up) / (depth * tanV));
      }
      const mx = (Math.min(...nx) + Math.max(...nx)) / 2, my = (Math.min(...ny) + Math.max(...ny)) / 2;
      if (Math.abs(mx) < 1e-6 && Math.abs(my) < 1e-6) break;
      target.addScaledVector(right, mx * tanH * distance).addScaledVector(up, my * tanV * distance);
    }
  }
  const position = target.clone().addScaledVector(back, distance);
  return {
    position, target, up: UP.clone(), projection, fov, halfHeight,
    near: Math.max(distance - radius * 2.2, distance * 0.02),
    far: distance + radius * 6,
  };
}

/** A preset angle's direction (camera minus target). */
export function angleDirection(angle: ViewName): THREE.Vector3 {
  return new THREE.Vector3(...VIEW_DIRECTIONS[angle]).normalize();
}

/** The live camera as a framing: the same picture height at the target, in either projection. */
export function frameFromView(view: ViewState, box: THREE.Box3, projection: RenderProjection): Framing {
  const position = new THREE.Vector3(...view.position), target = new THREE.Vector3(...view.target);
  const distance = Math.max(position.distanceTo(target), 1e-9);
  const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-9);
  const reach = target.distanceTo(box.getCenter(new THREE.Vector3())) + radius;
  return {
    position, target, up: new THREE.Vector3(...view.up), projection, fov: view.fov,
    halfHeight: distance * Math.tan(THREE.MathUtils.degToRad(view.fov) / 2),
    near: Math.max(distance - reach * 1.2, distance * 0.01),
    far: distance + reach * 4,
  };
}

/** A three.js camera set up from a framing at the given aspect. */
export function cameraFromFraming(f: Framing, aspect: number): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  if (f.projection === "orthographic") {
    const h = f.halfHeight, w = h * aspect;
    camera = new THREE.OrthographicCamera(-w, w, h, -h, f.near, f.far);
  } else {
    camera = new THREE.PerspectiveCamera(f.fov, aspect, f.near, f.far);
  }
  camera.up.copy(f.up);
  camera.position.copy(f.position);
  camera.lookAt(f.target);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}
