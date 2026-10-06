import * as THREE from "three";
import type { FarField } from "../types";
import { PATTERN_RANGE_DB } from "./patternRange.ts";
export { PATTERN_RANGE_DB };

/** Piecewise-linear interpolation through a single-hue sequential ramp (low -> high). */
export function rampColor(stops: THREE.Color[], t: number, out = new THREE.Color()): THREE.Color {
  const x = (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return out.copy(stops[i]).lerp(stops[i + 1], x - i);
}

/**
 * 3D pattern surface. Radius and colour both encode dBi (so colour is never the only channel),
 * normalised over the top PATTERN_RANGE_DB dB below `max`. `values` replaces the directivity grid
 * (gain, realized gain, a circular part: lib/farfieldQuantity.ts), with `max` the top of its scale.
 */
export function patternMesh(ff: FarField, center: THREE.Vector3, size: number, stops: THREE.Color[], halfSpace: boolean,
  shown?: { values: number[][]; max: number }): THREE.Group {
  const { theta, phi } = ff;
  const d = shown?.values ?? ff.directivity_dbi;
  const max = shown?.max ?? ff.dmax_dbi;
  const floor = max - PATTERN_RANGE_DB;
  const nt = theta.findLastIndex((t) => !halfSpace || t <= 90.0001) + 1;
  const np = phi.length;
  if (nt === 0 || np === 0) return new THREE.Group();
  const pos = new Float32Array(nt * (np + 1) * 3);
  const col = new Float32Array(nt * (np + 1) * 3);
  const sinTheta = theta.slice(0, nt).map((v) => Math.sin(THREE.MathUtils.degToRad(v)));
  const cosTheta = theta.slice(0, nt).map((v) => Math.cos(THREE.MathUtils.degToRad(v)));
  const sinPhi = phi.map((v) => Math.sin(THREE.MathUtils.degToRad(v)));
  const cosPhi = phi.map((v) => Math.cos(THREE.MathUtils.degToRad(v)));
  const c = new THREE.Color();
  for (let i = 0; i < nt; i++) {
    for (let j = 0; j <= np; j++) {
      const jj = j % np;
      // a missing sample (NaN after validation) collapses to the centre instead of breaking the mesh
      const dv = d[i][jj];
      const t = Number.isFinite(dv) ? Math.max(0, (dv - floor) / PATTERN_RANGE_DB) : 0;
      const r = size * t;
      const k = (i * (np + 1) + j) * 3;
      pos[k] = center.x + r * sinTheta[i] * cosPhi[jj];
      pos[k + 1] = center.y + r * sinTheta[i] * sinPhi[jj];
      pos[k + 2] = center.z + r * cosTheta[i];
      rampColor(stops, t, c);
      col[k] = c.r;
      col[k + 1] = c.g;
      col[k + 2] = c.b;
    }
  }
  const indexCount = Math.max(0, nt - 1) * np * 6;
  const vertexCount = nt * (np + 1);
  // WebGL reserves 65535 as the fixed primitive-restart index for 16-bit elements.
  const idx = vertexCount >= 65536 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  let indexOffset = 0;
  for (let i = 0; i < nt - 1; i++) {
    for (let j = 0; j < np; j++) {
      const a = i * (np + 1) + j;
      const b = a + np + 1;
      idx[indexOffset++] = a;
      idx[indexOffset++] = b;
      idx[indexOffset++] = a + 1;
      idx[indexOffset++] = a + 1;
      idx[indexOffset++] = b;
      idx[indexOffset++] = b + 1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();

  const group = new THREE.Group();
  const surface = new THREE.Mesh(
    g,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0, side: THREE.DoubleSide, transparent: true, opacity: 0.88, depthWrite: false }),
  );
  surface.renderOrder = 3;
  group.add(surface);

  // iso-lines every 15° in θ and 30° in φ keep the shape readable without relying on colour
  const stepT = Math.max(1, Math.round(15 / (theta[1] - theta[0])));
  const stepP = Math.max(1, Math.round(30 / (phi[1] - phi[0])));
  let lineSegments = 0;
  for (let i = 0; i < nt; i += stepT) lineSegments += np;
  for (let j = 0; j < np; j += stepP) lineSegments += Math.max(0, nt - 1);
  const lines = new Float32Array(lineSegments * 6);
  let lineOffset = 0;
  const addSegment = (i0: number, j0: number, i1: number, j1: number) => {
    const a = (i0 * (np + 1) + j0) * 3;
    const b = (i1 * (np + 1) + j1) * 3;
    for (let k = 0; k < 3; k++) {
      lines[lineOffset + k] = pos[a + k];
      lines[lineOffset + 3 + k] = pos[b + k];
    }
    lineOffset += 6;
  };
  for (let i = 0; i < nt; i += stepT) for (let j = 0; j < np; j++) addSegment(i, j, i, j + 1);
  for (let j = 0; j < np; j += stepP) for (let i = 0; i < nt - 1; i++) addSegment(i, j, i + 1, j);
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", new THREE.BufferAttribute(lines, 3));
  const wire = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x0b0b0b, transparent: true, opacity: 0.18, depthWrite: false }));
  wire.renderOrder = 4;
  group.add(wire);
  return group;
}
