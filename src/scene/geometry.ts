import * as THREE from "three";
import { validColor } from "../designer/colors.ts";
import type { Bundle, Part, Primitive, Vec3 } from "../types";
import { ghostHostName, isGhostPart, partKind } from "./partKind.ts";
import type { PartKind } from "./partKind.ts";
export { partKind, isGhostPart, ghostHostName };
export type { PartKind };

export interface PartObject {
  part: Part;
  kind: PartKind;
  group: THREE.Group;
  meshes: THREE.Mesh[];
  edges: THREE.LineSegments[];
}

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

/** Local XY(Z) -> world, following CSXCAD's in-plane order: u = e[(n+1)%3], v = e[(n+2)%3], w = e[n]. */
function planeBasis(n: number, elevation: number): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeBasis(AXES[(n + 1) % 3], AXES[(n + 2) % 3], AXES[n]);
  const t = new THREE.Matrix4().makeTranslation(AXES[n].clone().multiplyScalar(elevation));
  return t.multiply(m);
}

function shapeFrom(points: [number, number][]): THREE.Shape {
  const s = new THREE.Shape();
  points.forEach(([a, b], i) => (i === 0 ? s.moveTo(a, b) : s.lineTo(a, b)));
  s.closePath();
  return s;
}

function reverseTriangleWinding(geometry: THREE.BufferGeometry): void {
  const index = geometry.getIndex();
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) {
      const b = index.getX(i + 1), c = index.getX(i + 2);
      index.setX(i + 1, c);
      index.setX(i + 2, b);
    }
    index.needsUpdate = true;
    return;
  }
  // Non-indexed surfaces keep per-face attributes, so swap the second and third vertex in every
  // triangle across each attribute (including the inverse-transpose normals from applyMatrix4).
  for (const attr of Object.values(geometry.attributes)) {
    const array = attr.array as unknown as { [index: number]: number };
    for (let i = 0; i + 2 < attr.count; i += 3) for (let k = 0; k < attr.itemSize; k++) {
      const bIndex = (i + 1) * attr.itemSize + k, cIndex = (i + 2) * attr.itemSize + k;
      const b = array[bIndex]; array[bIndex] = array[cIndex]; array[cIndex] = b;
    }
    attr.needsUpdate = true;
  }
}

/** Geometry for one primitive, or null for zero-area primitives (lines/points). */
export function primitiveGeometry(prim: Primitive): THREE.BufferGeometry | null {
  if (prim.kind === "transformed") {
    const g = primitiveGeometry(prim.primitive);
    if (!g) return null;
    const m = prim.matrix;
    const transform = new THREE.Matrix4().set(
      m[0][0], m[0][1], m[0][2], m[0][3], m[1][0], m[1][1], m[1][2], m[1][3],
      m[2][0], m[2][1], m[2][2], m[2][3], m[3][0], m[3][1], m[3][2], m[3][3],
    );
    g.applyMatrix4(transform);
    if (transform.determinant() < 0) reverseTriangleWinding(g);
    return g;
  }
  switch (prim.kind) {
    case "box":
    case "bbox": {
      const [a, b] = prim.kind === "box" ? [prim.start, prim.stop] : prim.bbox;
      const lo = a.map((v, i) => Math.min(v, b[i]));
      const d = a.map((v, i) => Math.abs(b[i] - v));
      const c = lo.map((v, i) => v + d[i] / 2);
      const zero = d.map((v) => v < 1e-9);
      const nZero = zero.filter(Boolean).length;
      let g: THREE.BufferGeometry;
      if (nZero === 0) g = new THREE.BoxGeometry(d[0], d[1], d[2]);
      else if (nZero === 1) {
        const n = zero.indexOf(true);
        g = new THREE.PlaneGeometry(d[(n + 1) % 3], d[(n + 2) % 3]);
        g.applyMatrix4(planeBasis(n, 0));
      } else return null;
      g.translate(c[0], c[1], c[2]);
      return g;
    }
    case "polygon": {
      const g = new THREE.ShapeGeometry(shapeFrom(prim.points));
      g.applyMatrix4(planeBasis(prim.normal, prim.elevation));
      return g;
    }
    case "linpoly": {
      const len = prim.length ?? 0;
      if (Math.abs(len) < 1e-9) {
        const g = new THREE.ShapeGeometry(shapeFrom(prim.points));
        g.applyMatrix4(planeBasis(prim.normal, prim.elevation));
        return g;
      }
      const g = new THREE.ExtrudeGeometry(shapeFrom(prim.points), { depth: Math.abs(len), bevelEnabled: false });
      g.applyMatrix4(planeBasis(prim.normal, prim.elevation + Math.min(0, len)));
      return g;
    }
    case "cylinder":
    case "cylindricalshell": {
      const a = new THREE.Vector3(...prim.start);
      const b = new THREE.Vector3(...prim.stop);
      const dir = b.clone().sub(a);
      let g: THREE.BufferGeometry;
      if (prim.kind === "cylinder") g = new THREE.CylinderGeometry(prim.radius, prim.radius, dir.length(), 48, 1);
      else {
        // a tube: the wall's cross-section (a closed rectangle) turned about the axis
        const ro = prim.radius + prim.shell_width / 2;
        const ri = Math.max(0, prim.radius - prim.shell_width / 2);
        const h = dir.length() / 2;
        g = new THREE.LatheGeometry([new THREE.Vector2(ri, -h), new THREE.Vector2(ro, -h), new THREE.Vector2(ro, h), new THREE.Vector2(ri, h), new THREE.Vector2(ri, -h)], 48);
      }
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
      const mid = a.add(b).multiplyScalar(0.5);
      g.translate(mid.x, mid.y, mid.z);
      return g;
    }
    case "sphere": {
      const g = new THREE.SphereGeometry(prim.radius, 48, 24);
      g.translate(prim.center[0], prim.center[1], prim.center[2]);
      return g;
    }
    case "curve":
    case "wire": {
      const pts = prim.points.map((p) => new THREE.Vector3(...p));
      if (pts.length < 2) return null;
      const path = new THREE.CurvePath<THREE.Vector3>();
      for (let i = 1; i < pts.length; i++) if (pts[i].distanceTo(pts[i - 1]) > 1e-9) path.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
      if (!path.curves.length) return null;
      return new THREE.TubeGeometry(path, Math.min(4000, path.curves.length * 2), wireRadius(prim), 16, false);
    }
    case "rotpoly":
      return revolve(prim.points, prim.axis, prim.origin, 48);
    case "polyhedron": {
      // flat-shaded triangles (faces fanned from their first vertex)
      const pos: number[] = [];
      for (const f of prim.faces) {
        for (let k = 1; k + 1 < f.length; k++) for (const i of [f[0], f[k], f[k + 1]]) pos.push(...prim.vertices[i]);
      }
      if (!pos.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      return g;
    }
  }
}

/** Fields that do not change a primitive's geometry: the drawing priority, whether the exporter could
 * draw it exactly (the material is chosen in buildParts), the thin-metal flag and the source location. */
const NON_GEOMETRY = new Set(["priority", "exact", "sheet", "where"]);

/** The cache key: every other field, keys sorted. The browser's quick bundle and the server bundle list
 * the same primitive's fields in a different order (and the server adds `sheet`), so the raw JSON
 * never matched and every edit rebuilt all geometry twice. */
export function geometryKey(prim: Primitive): string {
  const rec = prim as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rec).sort()) if (!NON_GEOMETRY.has(k) && rec[k] !== undefined) out[k] = rec[k];
  return JSON.stringify(out);
}

/** Viewport-scoped geometry cache. Entries live only while used by the current bundle. */
export class SceneGeometryCache {
  private entries = new Map<string, { geometry: THREE.BufferGeometry; edges: THREE.EdgesGeometry }>();
  private used = new Set<string>();
  private owned = new WeakSet<THREE.BufferGeometry>();
  private rebuilding = false;

  beginRebuild(): void {
    this.used.clear();
    this.rebuilding = true;
  }

  get(prim: Primitive): { geometry: THREE.BufferGeometry; edges: THREE.EdgesGeometry } | null {
    const key = geometryKey(prim);
    let entry = this.entries.get(key);
    if (!entry) {
      const geometry = primitiveGeometry(prim);
      if (!geometry) return null;
      entry = { geometry, edges: new THREE.EdgesGeometry(geometry, 25) };
      this.entries.set(key, entry);
      this.owned.add(geometry);
      this.owned.add(entry.edges);
    }
    if (this.rebuilding) this.used.add(key);
    return entry;
  }

  endRebuild(): void {
    this.rebuilding = false;
    for (const [key, entry] of this.entries) {
      if (this.used.has(key)) continue;
      entry.geometry.dispose();
      entry.edges.dispose();
      this.entries.delete(key);
    }
  }

  owns(geometry: THREE.BufferGeometry): boolean { return this.owned.has(geometry); }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.geometry.dispose();
      entry.edges.dispose();
    }
    this.entries.clear();
    this.used.clear();
    this.rebuilding = false;
  }
}

/**
 * A solid of revolution: the closed (radial, axial) profile turned about the line through `origin`
 * along axis `axis` in `segments` steps. Normals are sharp across the profile's corners (a cone's rim
 * stays crisp) and smooth around the axis. Edges on the axis (radius 0) add nothing.
 */
export function revolve(points: [number, number][], axis: number, origin: Vec3, segments: number): THREE.BufferGeometry | null {
  const e1 = (axis + 1) % 3, e2 = (axis + 2) % 3;
  let area = 0;
  points.forEach(([r0, h0], i) => { const [r1, h1] = points[(i + 1) % points.length]; area += r0 * h1 - r1 * h0; });
  const sign = area >= 0 ? 1 : -1; // outward normal of edge (dr, dh) is sign * (dh, -dr)
  const pos: number[] = [], nrm: number[] = [];
  const P = (r: number, h: number, t: number) => { const p = [...origin]; p[axis] += h; p[e1] += r * Math.cos(t); p[e2] += r * Math.sin(t); return p; };
  const N = (nr: number, nh: number, t: number) => { const n = [0, 0, 0]; n[axis] = nh; n[e1] = nr * Math.cos(t); n[e2] = nr * Math.sin(t); return n; };
  for (let i = 0; i < points.length; i++) {
    const [r0, h0] = points[i], [r1, h1] = points[(i + 1) % points.length];
    if (Math.abs(r0) < 1e-12 && Math.abs(r1) < 1e-12) continue;
    const len = Math.hypot(r1 - r0, h1 - h0);
    if (len < 1e-12) continue;
    const nr = (sign * (h1 - h0)) / len, nh = (-sign * (r1 - r0)) / len;
    for (let k = 0; k < segments; k++) {
      const t0 = (2 * Math.PI * k) / segments, t1 = (2 * Math.PI * (k + 1)) / segments;
      const q = [P(r0, h0, t0), P(r1, h1, t0), P(r1, h1, t1), P(r0, h0, t1)];
      const n = [N(nr, nh, t0), N(nr, nh, t0), N(nr, nh, t1), N(nr, nh, t1)];
      for (const j of [0, 1, 2, 0, 2, 3]) { pos.push(...q[j]); nrm.push(...n[j]); }
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

/** Display radius of a thin wire: its own radius, or (a CSXCAD Curve has none) a fraction of its extent. */
export function wireRadius(prim: { points: Vec3[]; radius?: number }): number {
  if (prim.radius && prim.radius > 0) return prim.radius;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of prim.points) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
  return Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 250, 1e-3);
}

export interface SceneColors {
  /** the cut-out token (--al-3d-cutout), for void ghosts */
  cut?: string;
  metal: string;
  dielectric: string;
  port: string;
  edge: string;
  domain: string;
  nf2ff: string;
  ground: string;
  grid: string;
  gridMajor: string;
}

export function buildParts(b: Bundle, colors: SceneColors, env: THREE.Texture | null, xray: boolean, cache?: SceneGeometryCache): PartObject[] {
  return b.parts.map((part) => {
    const kind = partKind(part);
    const group = new THREE.Group();
    group.name = part.name;
    const ghost = isGhostPart(part);
    const hostName = ghostHostName(part);
    const color = ghost ? (colors.cut || "#d9534f") : validColor(part.color) ?? (kind === "metal" ? colors.metal : kind === "dielectric" ? colors.dielectric : "#888888");
    // Zero-thickness metal lies exactly on dielectric faces. Seen straight on (the Top, Front and
    // Right views) the slope term of the polygon offset is zero and one unit is not enough to win
    // the depth test, so the traces flickered away: pull metal forward and push dielectrics back.
    const material = ghost
      // a cut-out: a clearly blue translucent fill over copper and dielectric alike (pulled forward, so a face lying on its
      // host's still shows it); the through-everything pass and the outline below keep it visible when it is hidden inside
      ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 })
      : kind === "metal"
        ? new THREE.MeshStandardMaterial({
            color, metalness: 0.9, roughness: 0.34, envMap: env, envMapIntensity: 1.0,
            side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
          })
        : new THREE.MeshStandardMaterial({
            color, metalness: 0, roughness: 0.75, envMap: env, envMapIntensity: 0.4,
            transparent: true, opacity: xray ? 0.38 : 0.9, depthWrite: !xray, side: THREE.DoubleSide,
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4,
          });
    const meshes: THREE.Mesh[] = [];
    const edges: THREE.LineSegments[] = [];
    const edgeMat = ghost
      ? new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, depthTest: false, depthWrite: false })
      : new THREE.LineBasicMaterial({ color: colors.edge, transparent: true, opacity: kind === "metal" ? 0.45 : 0.3 });
    for (const prim of part.primitives) {
      const cached = cache?.get(prim);
      const g = cached?.geometry ?? (cache ? null : primitiveGeometry(prim));
      if (!g) continue;
      // shapes the exporter could only approximate by their bounding box are drawn as wireframes
      const mesh = new THREE.Mesh(g, prim.exact ? material : new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.6 }));
      mesh.userData.part = hostName;
      mesh.userData.primitive = prim;
      mesh.userData.metal = !ghost && kind !== "dielectric";
      mesh.renderOrder = kind === "dielectric" ? 2 : 1;
      group.add(mesh);
      meshes.push(mesh);
      const e = new THREE.LineSegments(cached?.edges ?? new THREE.EdgesGeometry(g, 25), edgeMat);
      e.userData.part = hostName;
      if (ghost) {
        e.renderOrder = 4; mesh.renderOrder = 3;
        // the part of the cut-out hidden inside its host or behind other solids: a faint fill drawn through everything
        const through = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
        through.userData.part = hostName; through.renderOrder = 3; through.raycast = () => {};
        group.add(through);
      }
      group.add(e);
      edges.push(e);
    }
    return { part, kind, group, meshes, edges };
  });
}

export function boxLines(min: Vec3, max: Vec3, material: THREE.LineBasicMaterial | THREE.LineDashedMaterial): THREE.LineSegments {
  const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
  g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  const l = new THREE.LineSegments(g, material);
  if (material instanceof THREE.LineDashedMaterial) l.computeLineDistances();
  return l;
}

export { portObject, lumpedObject, waveguidePortObject, updatePortGlyphs } from "./portGlyphs.ts";

/** Mesh lines of the other two axes on a plane through the chosen axis position. */
export function meshPlaneLines(b: Bundle, axis: 0 | 1 | 2, position: number, color: string, opacity: number): THREE.LineSegments {
  const lines = [b.mesh.x, b.mesh.y, b.mesh.z];
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const pts: number[] = [];
  const push = (p: number[]) => pts.push(p[0], p[1], p[2]);
  const at = (uu: number, vv: number) => {
    const p = [0, 0, 0];
    p[axis] = position;
    p[u] = uu;
    p[v] = vv;
    return p;
  };
  const u0 = lines[u][0], u1 = lines[u][lines[u].length - 1];
  const v0 = lines[v][0], v1 = lines[v][lines[v].length - 1];
  for (const uu of lines[u]) { push(at(uu, v0)); push(at(uu, v1)); }
  for (const vv of lines[v]) { push(at(u0, vv)); push(at(u1, vv)); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
}

export function sceneRadius(b: Bundle): { center: THREE.Vector3; radius: number; box: THREE.Box3 } {
  const box = new THREE.Box3();
  const src = b.focus ?? (b.parts.length ? { min: b.parts[0].bbox[0], max: b.parts[0].bbox[1] } : b.domain);
  box.set(new THREE.Vector3(...src.min), new THREE.Vector3(...src.max));
  if (!b.focus) for (const p of b.parts) box.union(new THREE.Box3(new THREE.Vector3(...p.bbox[0]), new THREE.Vector3(...p.bbox[1])));
  const center = box.getCenter(new THREE.Vector3());
  return { center, radius: Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1), box };
}
