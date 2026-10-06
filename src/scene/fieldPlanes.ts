// E/H field maps on cut planes (bundle `field_planes`, python/fairbeam/field_planes.py) in the 3D
// view: one semi-transparent textured quad at the plane's true position, coloured on the field ramp
// in dB below the map's maximum or linearly, or by phase, or as the instantaneous field over one
// period (Animate). What is drawn is computed by scene/fieldPlaneModel.ts, which scripts/
// check-field-planes.mjs runs without WebGL; this file only puts it on a quad.
import * as THREE from "three";
import type { FieldPlaneMap } from "../types";
import { effectiveView, fieldPlaneRgba, fieldPlaneValues, type FieldPlaneScale, type FieldPlaneView, type RGB } from "./fieldPlaneModel";

export {
  FIELD_PLANE_DB_RANGE, rampPosition, rampValues, scaleTicks, type FieldPlaneScale, type FieldPlaneView,
} from "./fieldPlaneModel";

/** The ramp's stops as sRGB bytes (what a canvas and a texture flagged sRGB hold). */
export const stopsRgb = (stops: THREE.Color[]): RGB[] => stops.map((c) => {
  const hex = c.getHex();
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255] as RGB;
});

/** The corners of the quad in 3D (drawing units): half a sample beyond the first and last sample
 * so texel centres sit on the sample positions. */
export function planeCorners(m: FieldPlaneMap): [number, number, number][] {
  const hu = (m.u_range[1] - m.u_range[0]) / Math.max(1, m.nu - 1) / 2;
  const hv = (m.v_range[1] - m.v_range[0]) / Math.max(1, m.nv - 1) / 2;
  const uv: [number, number][] = [[m.u_range[0] - hu, m.v_range[0] - hv], [m.u_range[1] + hu, m.v_range[0] - hv],
    [m.u_range[1] + hu, m.v_range[1] + hv], [m.u_range[0] - hu, m.v_range[1] + hv]];
  return uv.map(([a, b]) => {
    const p: [number, number, number] = [0, 0, 0];
    p[m.axis] = m.position_mm;
    p[m.u_axis] = a;
    p[m.v_axis] = b;
    return p;
  });
}

const asView = (v: FieldPlaneView | FieldPlaneScale): FieldPlaneView =>
  typeof v === "string" ? { mode: "magnitude", part: "all", scale: v, phaseDeg: 0 } : v;

function texture(m: FieldPlaneMap, view: FieldPlaneView, ramp: RGB[], target?: THREE.DataTexture, pixels?: Uint8ClampedArray, values?: Float32Array): THREE.DataTexture {
  const rgba = fieldPlaneRgba(m, fieldPlaneValues(m, view, values), view.scale, ramp, false, pixels);
  if (target) {
    target.needsUpdate = true;
    return target;
  }
  // The pixel helper uses clamped writes for exact canvas-color rounding. A Uint8Array view shares
  // those bytes with WebGL while retaining DataTexture's conventional upload type and avoiding a
  // per-frame copy.
  const data = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length);
  const tex = new THREE.DataTexture(data, m.nu, m.nv, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** The map as one textured, semi-transparent quad at its true position, seen from both sides. */
export function fieldPlaneLayer(m: FieldPlaneMap, shown: FieldPlaneView | FieldPlaneScale, stops: THREE.Color[]): THREE.Group {
  const view = asView(shown), ramp = stopsRgb(stops);
  const effective = effectiveView(m, view);
  const pixels = new Uint8ClampedArray(m.nu * m.nv * 4);
  const values = effective.mode === "animate" ? new Float32Array(m.nu * m.nv) : undefined;
  const group = new THREE.Group();
  group.name = "field-plane";
  const pos = new Float32Array(planeCorners(m).flat());
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const map = texture(m, view, ramp, undefined, pixels, values);
  // drawn after the solids without writing depth: the model stays visible through it, and a plane on
  // a metal sheet is pulled forward like the surface-current map (scene/fields.ts)
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    map, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false,
    toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
  }));
  mesh.renderOrder = 3;
  group.add(mesh);
  // the animation redraws the texture in place at another instant of the period
  group.userData.fieldPlaneAnimate = effective.mode === "animate"
    ? (phaseDeg: number) => texture(m, { ...view, phaseDeg }, ramp, map, pixels, values)
    : undefined;
  return group;
}

/** Show another instant of the period on a layer drawn in Animate mode; false when it is not one. */
export function updateFieldPlanePhase(group: THREE.Group, phaseDeg: number): boolean {
  const update = group.userData.fieldPlaneAnimate as ((phaseDeg: number) => void) | undefined;
  update?.(phaseDeg);
  return !!update;
}
