import * as THREE from "three";
import type { Primitive } from "../types.ts";
import { primitiveGeometry } from "./geometry.ts";

/** Smooth closed surfaces have no sharp edges; use their mesh as a ghost wire outline. */
export function transformOutline(primitive: Primitive): THREE.BufferGeometry | null {
  const geometry = primitiveGeometry(primitive);
  if (!geometry) return null;
  const edges = new THREE.EdgesGeometry(geometry, 20);
  const outline = edges.getAttribute("position").count ? edges : new THREE.WireframeGeometry(geometry);
  if (outline !== edges) edges.dispose();
  geometry.dispose();
  return outline;
}
