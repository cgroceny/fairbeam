import * as THREE from "three";
import { primitiveGeometry } from "../scene/geometry";
import { quickBundle } from "./geometry";
import { draft, names } from "./store";

/** Resolve each source shape separately: copies and cut fragments still select their source. */
export function pickedShape(i: number, ray: THREE.Raycaster): number | undefined {
  const part = draft.parts[i];
  if (!part) return;
  let best = Infinity, index: number | undefined;
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  part.primitives.forEach((shape, j) => {
    const b = quickBundle({ ...draft, ports: [], parts: [{ ...part, primitives: [shape] }] }, names().names, null);
    for (const primitive of b?.parts[0]?.primitives ?? []) {
      const geometry = primitiveGeometry(primitive);
      if (!geometry) continue;
      const hit = ray.intersectObject(new THREE.Mesh(geometry, material), false)[0];
      if (hit && hit.distance < best) { best = hit.distance; index = j; }
      geometry.dispose();
    }
  });
  material.dispose();
  return index;
}
