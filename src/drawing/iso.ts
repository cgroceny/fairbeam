// Isometric line view: faces of the exact primitives, back-face culled and painted back to front
// (dielectrics opaque white with thin outlines, metals light grey with thick outlines).

import { withoutVoids } from "../lib/voidParts.ts";
import type { Bundle, Primitive, Vec3 } from "../types";
import { primitiveGeometry } from "../scene/geometry.ts";
import { affinePoint, polyPoint3, roleOf, type Role } from "./geometry.ts";
import type { Pt } from "./svg.ts";

const S2 = Math.SQRT2;
const S6 = Math.sqrt(6);
const S3 = Math.sqrt(3);
/** Direction towards the viewer: from (+x, −y, +z). */
export const CAM: Vec3 = [1 / S3, -1 / S3, 1 / S3];

export const isoPt = (p: Vec3): Pt => [(p[0] + p[1]) / S2, (-p[0] + p[1] + 2 * p[2]) / S6];
export const isoDepth = (p: Vec3) => p[0] * CAM[0] + p[1] * CAM[1] + p[2] * CAM[2];

export interface IsoFace {
  pts: Vec3[];
  role: Role;
  depth: number;
  /** edges to stroke (index pairs into pts); undefined = the whole outline */
  stroke?: [number, number][];
  sheet: boolean;
  /** face of a part made of many primitives (fractals): drawn with a thinner outline */
  dense?: boolean;
}

export interface IsoEdge {
  a: Vec3;
  b: Vec3;
  role: Role;
}

export interface IsoModel {
  faces: IsoFace[];
  /** silhouette lines of curved surfaces */
  lines: IsoEdge[];
  /** every geometric edge, visible or not (for the optional dashed hidden-edge layer) */
  edges: IsoEdge[];
  ground: Vec3[] | null;
}

let EDGES: IsoEdge[] = [];
const ringEdges = (ring: Vec3[], role: Role) => ring.forEach((p, i) => EDGES.push({ a: p, b: ring[(i + 1) % ring.length], role }));

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const EPS = 1e-9;

function boxFaces(lo: Vec3, hi: Vec3, role: Role, out: IsoFace[]) {
  const e = [0, 1, 2].map((i) => hi[i] - lo[i]);
  const zero = e.map((x) => Math.abs(x) < EPS);
  const nz = zero.filter(Boolean).length;
  const corner = (i: number, j: number, k: number): Vec3 => [i ? hi[0] : lo[0], j ? hi[1] : lo[1], k ? hi[2] : lo[2]];
  if (nz >= 2) return;
  if (nz === 0) {
    for (const [i, j, k, di, dj, dk] of [
      [0, 0, 0, 1, 0, 0], [0, 1, 0, 1, 0, 0], [0, 0, 1, 1, 0, 0], [0, 1, 1, 1, 0, 0],
      [0, 0, 0, 0, 1, 0], [1, 0, 0, 0, 1, 0], [0, 0, 1, 0, 1, 0], [1, 0, 1, 0, 1, 0],
      [0, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 1], [0, 1, 0, 0, 0, 1], [1, 1, 0, 0, 0, 1],
    ]) EDGES.push({ a: corner(i, j, k), b: corner(i + di, j + dj, k + dk), role });
  }
  if (nz === 1) {
    const a = zero.indexOf(true);
    const b1 = (a + 1) % 3;
    const b2 = (a + 2) % 3;
    const q = (s: number, t: number): Vec3 => {
      const p: Vec3 = [...lo];
      p[b1] = s ? hi[b1] : lo[b1];
      p[b2] = t ? hi[b2] : lo[b2];
      return p;
    };
    out.push({ pts: [q(0, 0), q(1, 0), q(1, 1), q(0, 1)], role, depth: 0, sheet: true });
    ringEdges([q(0, 0), q(1, 0), q(1, 1), q(0, 1)], role);
    return;
  }
  const quads: [Vec3[], Vec3][] = [
    [[corner(0, 0, 0), corner(0, 1, 0), corner(0, 1, 1), corner(0, 0, 1)], [-1, 0, 0]],
    [[corner(1, 0, 0), corner(1, 1, 0), corner(1, 1, 1), corner(1, 0, 1)], [1, 0, 0]],
    [[corner(0, 0, 0), corner(1, 0, 0), corner(1, 0, 1), corner(0, 0, 1)], [0, -1, 0]],
    [[corner(0, 1, 0), corner(1, 1, 0), corner(1, 1, 1), corner(0, 1, 1)], [0, 1, 0]],
    [[corner(0, 0, 0), corner(1, 0, 0), corner(1, 1, 0), corner(0, 1, 0)], [0, 0, -1]],
    [[corner(0, 0, 1), corner(1, 0, 1), corner(1, 1, 1), corner(0, 1, 1)], [0, 0, 1]],
  ];
  for (const [pts, nrm] of quads) if (dot(nrm, CAM) > EPS) out.push({ pts, role, depth: 0, sheet: false });
}

/** Front-facing triangles of a closed polyhedron (faces fanned; outward by the centroid), stroking
 * only feature edges: an edge between two coplanar triangles (a quad's diagonal) is not drawn. */
function polyhedronFaces(verts: Vec3[], polys: number[][], role: Role, out: IsoFace[]) {
  const c = [0, 1, 2].map((i) => verts.reduce((s, v) => s + v[i], 0) / verts.length) as Vec3;
  const tris: { t: [number, number, number]; n: Vec3 }[] = [];
  for (const f of polys) for (let k = 1; k + 1 < f.length; k++) {
    let t: [number, number, number] = [f[0], f[k], f[k + 1]];
    const [a, b, d] = t.map((i) => verts[i]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n);
    if (len < EPS) continue;
    n = n.map((x) => x / len) as Vec3;
    if (dot(n, [a[0] - c[0], a[1] - c[1], a[2] - c[2]]) < 0) {
      n = n.map((x) => -x) as Vec3;
      t = [t[0], t[2], t[1]];
    }
    tris.push({ t, n });
  }
  const key = (i: number, j: number) => (i < j ? `${i},${j}` : `${j},${i}`);
  const normals = new Map<string, Vec3[]>();
  for (const { t, n } of tris) for (const [i, j] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
    const k = key(i, j);
    normals.set(k, [...(normals.get(k) ?? []), n]);
  }
  const feature = (i: number, j: number) => {
    const ns = normals.get(key(i, j)) ?? [];
    return ns.length !== 2 || dot(ns[0], ns[1]) < 1 - 1e-6;
  };
  for (const [k] of normals) {
    const [i, j] = k.split(",").map(Number);
    if (feature(i, j)) EDGES.push({ a: verts[i], b: verts[j], role });
  }
  for (const { t, n } of tris) {
    if (dot(n, CAM) <= EPS) continue;
    const stroke = ([[0, 1], [1, 2], [2, 0]] as [number, number][]).filter(([p, q]) => feature(t[p], t[q]));
    out.push({ pts: t.map((i) => verts[i]), role, depth: 0, sheet: false, stroke });
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function faceUnit(pts: Vec3[]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const length = Math.hypot(...n) || 1;
  return n.map((x) => x / length) as Vec3;
}

/** Draw transformed flat-faced solids while retaining each source face ring, including concave caps. */
function transformedFaces(vertices: Vec3[], sourceFaces: number[][], role: Role, out: IsoFace[]) {
  if (!vertices.length || !sourceFaces.length) return;
  const polys = sourceFaces.map((f) => [...f]);
  let volume6 = 0;
  for (const f of polys) for (let i = 1; i + 1 < f.length; i++) {
    const a = vertices[f[0]], b = vertices[f[i]], c = vertices[f[i + 1]];
    volume6 += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  if (volume6 < -EPS) for (const f of polys) f.reverse();
  const normals = polys.map((f) => faceUnit(f.map((i) => vertices[i])));
  const adjacent = new Map<string, { a: number; b: number; faces: number[] }>();
  polys.forEach((f, fi) => f.forEach((a, i) => {
    const b = f[(i + 1) % f.length], id = a < b ? `${a},${b}` : `${b},${a}`;
    const edge = adjacent.get(id) ?? { a: Math.min(a, b), b: Math.max(a, b), faces: [] };
    edge.faces.push(fi);
    adjacent.set(id, edge);
  }));
  const isFeature = (edge: { faces: number[] }) => {
    if (edge.faces.length !== 2) return true;
    return dot(normals[edge.faces[0]], normals[edge.faces[1]]) < 1 - 1e-6;
  };
  for (const edge of adjacent.values()) EDGES.push({ a: vertices[edge.a], b: vertices[edge.b], role });
  polys.forEach((f, fi) => {
    if (dot(normals[fi], CAM) <= EPS) return;
    const stroke = f.flatMap((a, i) => {
      const b = f[(i + 1) % f.length], id = a < b ? `${a},${b}` : `${b},${a}`;
      const edge = adjacent.get(id)!;
      const at = f.indexOf(edge.a), bt = f.indexOf(edge.b);
      return isFeature(edge) ? [[at, bt] as [number, number]] : [];
    });
    out.push({ pts: f.map((i) => vertices[i]), role, depth: 0, sheet: false, stroke });
  });
}

/** Tessellated curved primitives retain their actual transformed surface, including shell openings. */
function transformedMesh(prim: Extract<Primitive, { kind: "transformed" }>, role: Role, out: IsoFace[], lines: IsoEdge[]) {
  const geometry = primitiveGeometry(prim);
  if (!geometry) return;
  const position = geometry.getAttribute("position");
  if (!position) { geometry.dispose(); return; }
  const vertices: Vec3[] = [];
  const unique = new Map<string, number>();
  const vertex = (index: number) => {
    const p: Vec3 = [position.getX(index), position.getY(index), position.getZ(index)];
    const key = p.map((x) => Math.round(x * 1e8)).join(",");
    const old = unique.get(key);
    if (old !== undefined) return old;
    const id = vertices.length;
    vertices.push(p);
    unique.set(key, id);
    return id;
  };
  const index = geometry.getIndex();
  const count = index?.count ?? position.count;
  const triangles: [number, number, number][] = [];
  for (let i = 0; i + 2 < count; i += 3) {
    const a = vertex(index ? index.getX(i) : i);
    const b = vertex(index ? index.getX(i + 1) : i + 1);
    const c = vertex(index ? index.getX(i + 2) : i + 2);
    triangles.push([a, b, c]);
  }
  geometry.dispose();

  const normals = triangles.map(([ia, ib, ic]) => {
    const a = vertices[ia], b = vertices[ib], c = vertices[ic];
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = cross(ab, ac), length = Math.hypot(...n) || 1;
    return n.map((x) => x / length) as Vec3;
  });
  const edgeKey = (a: number, b: number) => a < b ? `${a},${b}` : `${b},${a}`;
  const edges = new Map<string, { a: number; b: number; faces: number[] }>();
  triangles.forEach((t, fi) => [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]].forEach(([a, b]) => {
    const id = edgeKey(a, b), edge = edges.get(id) ?? { a: Math.min(a, b), b: Math.max(a, b), faces: [] };
    edge.faces.push(fi);
    edges.set(id, edge);
  }));
  triangles.forEach((t, fi) => {
    if (dot(normals[fi], CAM) > EPS) out.push({ pts: t.map((i) => vertices[i]), role, depth: 0, sheet: false, stroke: [] });
  });
  for (const edge of edges.values()) {
    const facing = edge.faces.map((i) => dot(normals[i], CAM) > EPS);
    const boundary = edge.faces.length === 1;
    if (boundary || (facing.some(Boolean) && facing.some((x) => !x))) {
      const line = { a: vertices[edge.a], b: vertices[edge.b], role };
      lines.push(line);
      EDGES.push(line);
      continue;
    }
    // Keep hard rims (such as a shell's annular end) while suppressing tessellation seams.
    if (edge.faces.length === 2 && dot(normals[edge.faces[0]], normals[edge.faces[1]]) < 0.9) {
      EDGES.push({ a: vertices[edge.a], b: vertices[edge.b], role });
    }
  }
}

function transformedPrimitive(prim: Extract<Primitive, { kind: "transformed" }>, role: Role, out: IsoFace[], lines: IsoEdge[]) {
  const source = prim.primitive;
  const map = (p: Vec3) => affinePoint(prim.matrix, p);
  if (source.kind === "wire" || source.kind === "curve") {
    const points = source.points.map(map);
    for (let i = 1; i < points.length; i++) lines.push({ a: points[i - 1], b: points[i], role });
    return;
  }
  if (source.kind === "polygon") {
    const ring = source.points.map((q) => map(polyPoint3(source.normal, source.elevation, q)));
    if (ring.length >= 3) {
      out.push({ pts: ring, role, depth: 0, sheet: true });
      ringEdges(ring, role);
    }
    return;
  }
  if (source.kind === "linpoly") {
    const len = source.length ?? 0;
    const low = source.elevation + Math.min(0, len), high = source.elevation + Math.max(0, len);
    const bottom = source.points.map((q) => map(polyPoint3(source.normal, low, q)));
    if (Math.abs(len) < EPS) {
      if (bottom.length >= 3) {
        out.push({ pts: bottom, role, depth: 0, sheet: true });
        ringEdges(bottom, role);
      }
      return;
    }
    const top = source.points.map((q) => map(polyPoint3(source.normal, high, q)));
    const n = bottom.length;
    const faces = [Array.from({ length: n }, (_, i) => n - i - 1), Array.from({ length: n }, (_, i) => n + i)];
    for (let i = 0; i < n; i++) faces.push([i, (i + 1) % n, n + (i + 1) % n, n + i]);
    transformedFaces([...bottom, ...top], faces, role, out);
    return;
  }
  if (source.kind === "box") {
    const lo = source.start.map((x, i) => Math.min(x, source.stop[i])) as Vec3;
    const hi = source.start.map((x, i) => Math.max(x, source.stop[i])) as Vec3;
    const vertices = Array.from({ length: 8 }, (_, i): Vec3 => map([0, 1, 2].map((k) => i & (1 << k) ? hi[k] : lo[k]) as Vec3));
    const faces = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]];
    const zero = lo.map((x, i) => Math.abs(hi[i] - x) < EPS).filter(Boolean).length;
    if (zero >= 2) {
      const unique = vertices.filter((p, i) => vertices.findIndex((q) => q.every((x, k) => Math.abs(x - p[k]) < EPS)) === i);
      if (unique.length >= 2) lines.push({ a: unique[0], b: unique.at(-1)!, role });
      return;
    }
    transformedFaces(vertices, faces, role, out);
    return;
  }
  if (source.kind === "polyhedron") {
    transformedFaces(source.vertices.map(map), source.faces, role, out);
    return;
  }
  transformedMesh(prim, role, out, lines);
}

/** A solid of revolution (cone, torus): the visible quads of the turned profile (no strokes), the
 * silhouette where a strip turns away from the viewer and the visible part of every sharp rim. */
function revolvedFaces(points: [number, number][], axis: number, origin: Vec3, role: Role, out: IsoFace[], lines: IsoEdge[]) {
  const N = 48;
  const e1 = (axis + 1) % 3, e2 = (axis + 2) % 3;
  let area = 0;
  points.forEach(([r0, h0], i) => { const [r1, h1] = points[(i + 1) % points.length]; area += r0 * h1 - r1 * h0; });
  const sign = area >= 0 ? 1 : -1;
  const P = (r: number, h: number, k: number): Vec3 => {
    const t = (2 * Math.PI * k) / N, p: Vec3 = [...origin];
    p[axis] += h; p[e1] += r * Math.cos(t); p[e2] += r * Math.sin(t);
    return p;
  };
  const n = points.length;
  // visible[i][k]: the quad of edge i between angles k and k + 1 faces the viewer (null: no quad)
  const visible: (boolean[] | null)[] = points.map(([r0, h0], i) => {
    const [r1, h1] = points[(i + 1) % n];
    const len = Math.hypot(r1 - r0, h1 - h0);
    if (len < EPS || (Math.abs(r0) < EPS && Math.abs(r1) < EPS)) return null;
    const nr = (sign * (h1 - h0)) / len, nh = (-sign * (r1 - r0)) / len;
    return Array.from({ length: N }, (_, k) => {
      const t = (2 * Math.PI * (k + 0.5)) / N, nrm: Vec3 = [0, 0, 0];
      nrm[axis] = nh; nrm[e1] = nr * Math.cos(t); nrm[e2] = nr * Math.sin(t);
      return dot(nrm, CAM) > EPS;
    });
  });
  for (let i = 0; i < n; i++) {
    const vis = visible[i];
    if (!vis) continue;
    const [r0, h0] = points[i], [r1, h1] = points[(i + 1) % n];
    for (let k = 0; k < N; k++) {
      if (vis[k]) out.push({ pts: [P(r0, h0, k), P(r1, h1, k), P(r1, h1, k + 1), P(r0, h0, k + 1)], role, depth: 0, sheet: false, stroke: [] });
      if (vis[k] !== vis[(k + 1) % N]) lines.push({ a: P(r0, h0, k + 1), b: P(r1, h1, k + 1), role });
    }
  }
  // sharp rims (a corner of the profile off the axis): drawn where a strip next to them is visible
  for (let i = 0; i < n; i++) {
    const [r, h] = points[i];
    if (r < EPS) continue;
    const [ra, ha] = points[(i - 1 + n) % n], [rb, hb] = points[(i + 1) % n];
    const da = [r - ra, h - ha], db = [rb - r, hb - h];
    const cos = (da[0] * db[0] + da[1] * db[1]) / (Math.hypot(...da) * Math.hypot(...db) || 1);
    if (cos > Math.cos((20 * Math.PI) / 180)) continue;
    for (let k = 0; k < N; k++) {
      EDGES.push({ a: P(r, h, k), b: P(r, h, k + 1), role });
      if (visible[(i - 1 + n) % n]?.[k] || visible[i]?.[k]) lines.push({ a: P(r, h, k), b: P(r, h, k + 1), role });
    }
  }
}

export function isoModel(bundle: Bundle): IsoModel {
  const b = withoutVoids(bundle);
  EDGES = [];
  const faces: IsoFace[] = [];
  const lines: IsoModel["lines"] = [];
  for (const part of b.parts) {
    const baseRole = roleOf(part);
    const first = faces.length;
    for (const prim of part.primitives) {
      if (prim.kind === "transformed") {
        transformedPrimitive(prim, baseRole, faces, lines);
        continue;
      }
      const role: Role = prim.kind === "bbox" ? "approx" : baseRole;
      if (prim.kind === "box") {
        const lo = prim.start.map((x, i) => Math.min(x, prim.stop[i])) as Vec3;
        const hi = prim.start.map((x, i) => Math.max(x, prim.stop[i])) as Vec3;
        boxFaces(lo, hi, role, faces);
      } else if (prim.kind === "polygon" || prim.kind === "linpoly") {
        const n = prim.normal;
        const ring = prim.points.map((q) => polyPoint3(n, prim.elevation, q));
        if (ring.length < 3) continue;
        const len = prim.kind === "linpoly" ? prim.length ?? 0 : 0;
        if (Math.abs(len) < EPS) {
          faces.push({ pts: ring, role, depth: 0, sheet: true });
          ringEdges(ring, role);
          continue;
        }
        const top = ring.map((p) => {
          const q: Vec3 = [...p];
          q[n] += len;
          return q;
        });
        ringEdges(ring, role);
        ringEdges(top, role);
        ring.forEach((p, i) => EDGES.push({ a: p, b: top[i], role }));
        let area = 0;
        prim.points.forEach(([a0, b0], i) => {
          const [a1, b1] = prim.points[(i + 1) % prim.points.length];
          area += a0 * b1 - a1 * b0;
        });
        const orient = area >= 0 ? 1 : -1;
        const capN: Vec3 = [0, 0, 0];
        capN[n] = Math.sign(len);
        if (dot(capN, CAM) > EPS) faces.push({ pts: top, role, depth: 0, sheet: false });
        if (-dot(capN, CAM) > EPS) faces.push({ pts: ring, role, depth: 0, sheet: false });
        for (let i = 0; i < ring.length; i++) {
          const j = (i + 1) % ring.length;
          const [a0, b0] = prim.points[i];
          const [a1, b1] = prim.points[j];
          const nrm: Vec3 = [0, 0, 0];
          nrm[(n + 1) % 3] = (b1 - b0) * orient;
          nrm[(n + 2) % 3] = -(a1 - a0) * orient;
          if (dot(nrm, CAM) > EPS) faces.push({ pts: [ring[i], ring[j], top[j], top[i]], role, depth: 0, sheet: false });
        }
      } else if (prim.kind === "cylinder" || prim.kind === "cylindricalshell") {
        const d = prim.stop.map((x, i) => x - prim.start[i]);
        const k = d.findIndex((x) => Math.abs(x) > EPS);
        if (d.filter((x) => Math.abs(x) > EPS).length !== 1) {
          boxFaces(prim.bbox[0], prim.bbox[1], "approx", faces);
          continue;
        }
        const a1 = (k + 1) % 3;
        const a2 = (k + 2) % 3;
        const N = 48;
        // a tube: outer wall of the outer radius, an annular cap and the far half of the bore
        const ro = prim.kind === "cylinder" ? prim.radius : prim.radius + prim.shell_width / 2;
        const ri = prim.kind === "cylinder" ? 0 : Math.max(0, prim.radius - prim.shell_width / 2);
        const circ = (base: Vec3, r = ro) =>
          Array.from({ length: N }, (_, i) => {
            const t = (2 * Math.PI * i) / N;
            const p: Vec3 = [...base];
            p[a1] += r * Math.cos(t);
            p[a2] += r * Math.sin(t);
            return p;
          });
        const c0 = circ(prim.start);
        const c1 = circ(prim.stop);
        ringEdges(c0, role);
        ringEdges(c1, role);
        const axisN: Vec3 = [0, 0, 0];
        axisN[k] = Math.sign(d[k]);
        const capUp = dot(axisN, CAM) > EPS;
        if (ri > EPS) {
          const i0 = circ(prim.start, ri);
          const i1 = circ(prim.stop, ri);
          ringEdges(i0, role);
          ringEdges(i1, role);
          const [oc, ic] = capUp ? [c1, i1] : [c0, i0];
          for (let i = 0; i < N; i++) {
            const j = (i + 1) % N;
            faces.push({ pts: [oc[i], oc[j], ic[j], ic[i]], role, depth: 0, sheet: false, stroke: [] });
            // the bore's far side (its inward normal faces the camera) shows through the opening
            const nrm: Vec3 = [0, 0, 0];
            nrm[a1] = -Math.cos((2 * Math.PI * (i + 0.5)) / N);
            nrm[a2] = -Math.sin((2 * Math.PI * (i + 0.5)) / N);
            if (dot(nrm, CAM) > 0) faces.push({ pts: [i0[i], i0[j], i1[j], i1[i]], role, depth: 0, sheet: false, stroke: [] });
          }
        } else if (capUp) faces.push({ pts: c1, role, depth: 0, sheet: false });
        else faces.push({ pts: c0, role, depth: 0, sheet: false });
        const vis = Array.from({ length: N }, (_, i) => {
          const t = (2 * Math.PI * (i + 0.5)) / N;
          const nrm: Vec3 = [0, 0, 0];
          nrm[a1] = Math.cos(t);
          nrm[a2] = Math.sin(t);
          return dot(nrm, CAM) > 0;
        });
        for (let i = 0; i < N; i++) {
          const j = (i + 1) % N;
          if (vis[i]) faces.push({ pts: [c0[i], c0[j], c1[j], c1[i]], role, depth: 0, sheet: false, stroke: [] });
          if (vis[i] !== vis[j]) lines.push({ a: c0[j], b: c1[j], role });
        }
      } else if (prim.kind === "sphere") {
        // visible patches of a latitude/longitude grid (no strokes) and the silhouette: the great
        // circle normal to the viewing direction
        const NU = 32, NV = 16;
        const at = (i: number, j: number): Vec3 => {
          const u = (2 * Math.PI * i) / NU, v = (Math.PI * j) / NV - Math.PI / 2;
          return [prim.center[0] + prim.radius * Math.cos(v) * Math.cos(u), prim.center[1] + prim.radius * Math.cos(v) * Math.sin(u), prim.center[2] + prim.radius * Math.sin(v)];
        };
        for (let i = 0; i < NU; i++) {
          for (let j = 0; j < NV; j++) {
            const q = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
            const mid = at(i + 0.5, j + 0.5);
            const nrm: Vec3 = [mid[0] - prim.center[0], mid[1] - prim.center[1], mid[2] - prim.center[2]];
            if (dot(nrm, CAM) > 0) faces.push({ pts: q, role, depth: 0, sheet: false, stroke: [] });
          }
        }
        const e1: Vec3 = [1 / Math.SQRT2, 1 / Math.SQRT2, 0];
        const e2: Vec3 = [CAM[1] * e1[2] - CAM[2] * e1[1], CAM[2] * e1[0] - CAM[0] * e1[2], CAM[0] * e1[1] - CAM[1] * e1[0]];
        const ring = Array.from({ length: 64 }, (_, i): Vec3 => {
          const t = (2 * Math.PI * i) / 64;
          return [0, 1, 2].map((a) => prim.center[a] + prim.radius * (Math.cos(t) * e1[a] + Math.sin(t) * e2[a])) as Vec3;
        });
        ring.forEach((p, i) => lines.push({ a: p, b: ring[(i + 1) % ring.length], role }));
      } else if (prim.kind === "rotpoly") {
        revolvedFaces(prim.points, prim.axis, prim.origin, role, faces, lines);
      } else if (prim.kind === "polyhedron") {
        polyhedronFaces(prim.vertices, prim.faces, role, faces);
      } else if (prim.kind === "curve" || prim.kind === "wire") {
        // thin wire: drawn as its polyline
        for (let i = 1; i < prim.points.length; i++) lines.push({ a: prim.points[i - 1], b: prim.points[i], role });
      } else {
        boxFaces(prim.bbox[0], prim.bbox[1], "approx", faces);
      }
    }
    if (part.primitives.length > 8) for (let i = first; i < faces.length; i++) faces[i].dense = true;
  }
  for (const f of faces) f.depth = f.pts.reduce((s, p) => s + isoDepth(p), 0) / f.pts.length;
  const sorted = paintOrder(faces);
  faces.length = 0;
  faces.push(...sorted);

  let ground: Vec3[] | null = null;
  if (b.half_space && b.parts.length) {
    const lo = [Infinity, Infinity];
    const hi = [-Infinity, -Infinity];
    for (const p of b.parts) for (const i of [0, 1]) {
      lo[i] = Math.min(lo[i], p.bbox[0][i]);
      hi[i] = Math.max(hi[i], p.bbox[1][i]);
    }
    // a square patch of the (infinite) ground, centred under the structure
    const h = (Math.max(hi[0] - lo[0], hi[1] - lo[1], 1) / 2) * 1.2;
    const cx = (lo[0] + hi[0]) / 2;
    const cy = (lo[1] + hi[1]) / 2;
    const z = b.half_space.position;
    ground = [
      [cx - h, cy - h, z],
      [cx + h, cy - h, z],
      [cx + h, cy + h, z],
      [cx - h, cy + h, z],
    ];
  }
  return { faces, lines, edges: EDGES, ground };
}

// ------------------------------------------------------------------ painter's order

/** paint order of coplanar faces: metal (sheets, traces) over dielectrics */
const rank = (r: Role) => (r === "metal" ? 1 : 0);

/** Screen point + depth -> 3D (inverse of the isometric projection). */
function unproject(X: number, Y: number, D: number): Vec3 {
  // X = (x + y)/√2, Y = (−x + y + 2z)/√6, D = (x − y + z)/√3 (orthonormal basis)
  const r: Vec3 = [1 / S2, 1 / S2, 0];
  const u: Vec3 = [-1 / S6, 1 / S6, 2 / S6];
  return [r[0] * X + u[0] * Y + CAM[0] * D, r[1] * X + u[1] * Y + CAM[1] * D, r[2] * X + u[2] * Y + CAM[2] * D];
}

function inside(p: Pt, poly: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function segX(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
  const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9 ? [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] : null;
}

/** Screen points covered by both polygons: vertices of one inside the other, then edge crossings. */
function* overlapPoints(A: Pt[], B: Pt[]): Generator<Pt> {
  for (const q of A) if (inside(q, B)) yield q;
  for (const q of B) if (inside(q, A)) yield q;
  for (let a = 0; a < A.length; a++) for (let b = 0; b < B.length; b++) {
    const x = segX(A[a], A[(a + 1) % A.length], B[b], B[(b + 1) % B.length]);
    if (x) yield x;
  }
}
const overlapPoint = (A: Pt[], B: Pt[]) => !overlapPoints(A, B).next().done;

/** Depth of a face's plane under screen point p (NaN when the face is seen edge-on). */
function depthAt(f: { n: Vec3; c: number }, p: Pt): number {
  // n · unproject(p, D) = c is linear in D
  const o = unproject(p[0], p[1], 0);
  const k = dot(f.n, CAM);
  return Math.abs(k) < 1e-9 ? NaN : (f.c - dot(f.n, o)) / k;
}

/**
 * Back-to-front order: where two faces overlap on screen, the one whose plane is farther at a
 * common point is painted first (topological sort, centroid depth breaks ties and cycles).
 */
function paintOrder(faces: IsoFace[]): IsoFace[] {
  const N = faces.length;
  if (N > 3000) return [...faces].sort((a, c) => a.depth - c.depth);
  const info = faces.map((f) => {
    const p2 = f.pts.map(isoPt);
    const xs = p2.map((p) => p[0]);
    const ys = p2.map((p) => p[1]);
    // plane normal (Newell)
    const n: Vec3 = [0, 0, 0];
    f.pts.forEach((p, i) => {
      const q = f.pts[(i + 1) % f.pts.length];
      n[0] += (p[1] - q[1]) * (p[2] + q[2]);
      n[1] += (p[2] - q[2]) * (p[0] + q[0]);
      n[2] += (p[0] - q[0]) * (p[1] + q[1]);
    });
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    const nn: Vec3 = [n[0] / l, n[1] / l, n[2] / l];
    return { p2, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], n: nn, c: dot(nn, f.pts[0]) };
  });
  const after: number[][] = faces.map(() => []); // i -> faces to paint after i
  const indeg = new Array(N).fill(0);
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const A = info[i];
      const B = info[j];
      if (A.bb[0] >= B.bb[2] - 1e-9 || B.bb[0] >= A.bb[2] - 1e-9 || A.bb[1] >= B.bb[3] - 1e-9 || B.bb[1] >= A.bb[3] - 1e-9) continue;
      // same plane (a trace on a substrate face): metal over dielectric, whatever the centroids
      const k = dot(A.n, B.n);
      if (Math.abs(Math.abs(k) - 1) < 1e-9 && Math.abs(A.c - Math.sign(k) * B.c) <= 1e-6 * (1 + Math.abs(A.c))) {
        if (!overlapPoint(A.p2, B.p2)) continue;
        const ri = rank(faces[i].role);
        const rj = rank(faces[j].role);
        if (ri === rj && faces[i].depth === faces[j].depth) continue;
        const first = ri !== rj ? (ri < rj ? i : j) : faces[i].depth < faces[j].depth ? i : j;
        const second = first === i ? j : i;
        after[first].push(second);
        indeg[second]++;
        continue;
      }
      // different planes: compare depths at a point covered by both projections, skipping points
      // on the planes' intersection line (faces that only share an edge need no order)
      let first = -1;
      for (const p of overlapPoints(A.p2, B.p2)) {
        const da = depthAt(A, p);
        const db = depthAt(B, p);
        if (!Number.isFinite(da) || !Number.isFinite(db)) continue;
        if (Math.abs(da - db) <= 1e-6 * (1 + Math.abs(da) + Math.abs(db))) continue;
        first = da < db ? i : j;
        break;
      }
      if (first < 0) continue;
      const second = first === i ? j : i;
      after[first].push(second);
      indeg[second]++;
    }
  }
  // Kahn's algorithm, always taking the farthest available face (centroid depth)
  const out: IsoFace[] = [];
  const done = new Array(N).fill(false);
  const ready = () => {
    let best = -1;
    for (let i = 0; i < N; i++) if (!done[i] && indeg[i] === 0 && (best < 0 || faces[i].depth < faces[best].depth)) best = i;
    if (best < 0) for (let i = 0; i < N; i++) if (!done[i] && (best < 0 || faces[i].depth < faces[best].depth)) best = i; // cycle
    return best;
  };
  for (let k = 0; k < N; k++) {
    const i = ready();
    done[i] = true;
    out.push(faces[i]);
    for (const j of after[i]) indeg[j]--;
  }
  return out;
}
