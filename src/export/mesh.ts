import { withoutVoids } from "../lib/voidParts.ts";
import * as THREE from "three";
import type { Bundle, Part, Primitive } from "../types";
import { primitiveGeometry } from "../scene/geometry.ts";

export function validateMeshPrimitive(primitive: Primitive): void {
  if (primitive.kind === "bbox" || !primitive.exact) throw new Error("Approximate geometry cannot be exported as a mesh");
  const finite = (value: unknown): boolean => typeof value === "number" ? Number.isFinite(value) : Array.isArray(value) ? value.every(finite) : value && typeof value === "object" ? Object.values(value).every(finite) : true;
  if (!finite(primitive)) throw new Error("Mesh geometry contains non-finite coordinates");
  if (primitive.kind === "transformed") {
    validateMeshPrimitive(primitive.primitive);
    const matrix = primitive.matrix;
    if (matrix.length !== 4 || matrix.some(row => row.length !== 4) || matrix[3].some((value, index) => value !== (index === 3 ? 1 : 0))) throw new Error("Mesh export requires an affine transform");
    if (new THREE.Matrix4().set(...matrix.flat() as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]).determinant() === 0) throw new Error("Mesh transform is singular");
  }
}

export function validMeshGeometry(geometry: THREE.BufferGeometry): boolean {
  const positions = geometry.getAttribute("position"), index = geometry.getIndex();
  if (!positions || positions.count < 3) return false;
  for (const value of positions.array) if (!Number.isFinite(value)) return false;
  const count = index?.count ?? positions.count;
  if (count % 3 !== 0) return false;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let hasArea = false;
  for (let offset = 0; offset < count; offset += 3) {
    const vertices = [offset, offset + 1, offset + 2].map(i => index ? index.getX(i) : i);
    if (vertices.some(i => !Number.isInteger(i) || i < 0 || i >= positions.count)) return false;
    a.fromBufferAttribute(positions, vertices[0]); b.fromBufferAttribute(positions, vertices[1]); c.fromBufferAttribute(positions, vertices[2]);
    if (b.sub(a).cross(c.sub(a)).lengthSq() > 0) hasArea = true;
  }
  return hasArea;
}

/** Caller owns the returned geometry. All primitives must resolve; no bbox fallback or partial export. */
export function exportGeometry(primitive: Primitive): THREE.BufferGeometry {
  validateMeshPrimitive(primitive);
  const geometry = primitiveGeometry(primitive);
  if (!geometry) throw new Error("A solid has no exportable mesh geometry");
  if (!validMeshGeometry(geometry)) {
    geometry.dispose(); throw new Error("A solid has invalid mesh vertices");
  }
  return geometry;
}

/** Default thickness of a metal sheet when the user asks for solids: 1 oz copper. */
export const DEFAULT_SHEET_THICKNESS_UM = 35;
/** The sheet thicknesses the export dialog accepts (µm): 1 µm to 5 mm. */
export const SHEET_THICKNESS_UM = { min: 1, max: 5000 } as const;

export interface MeshOptions {
  /** Thickness (micrometres) given to zero-thickness sheets; 0 or absent keeps them flat, two-sided surfaces. */
  sheetThicknessUm?: number;
}

/** Sheet thickness in drawing units, 0 when sheets stay surfaces. */
export function sheetThicknessUnits(b: Pick<Bundle, "units">, options: MeshOptions = {}): number {
  const um = options.sheetThicknessUm ?? 0;
  if (!Number.isFinite(um) || um < 0) throw new Error("Invalid sheet thickness");
  return um * 1e-6 / b.units.length_m;
}

const triangleVertices = (g: THREE.BufferGeometry): THREE.Vector3[][] => {
  const position = g.getAttribute("position"), index = g.getIndex();
  const count = index?.count ?? position.count;
  const out: THREE.Vector3[][] = [];
  for (let o = 0; o + 2 < count; o += 3) out.push([0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(o + k) : o + k)));
  return out;
};

/** The plane of a geometry whose triangles are all coplanar (a sheet); null for anything with volume. */
export function sheetPlane(g: THREE.BufferGeometry): { normal: THREE.Vector3; centroid: THREE.Vector3 } | null {
  const tris = triangleVertices(g);
  if (!tris.length) return null;
  g.computeBoundingBox();
  const diagonal = g.boundingBox!.min.distanceTo(g.boundingBox!.max), tol = 1e-5 * Math.max(1e-9, diagonal);
  let normal: THREE.Vector3 | null = null, origin: THREE.Vector3 | null = null;
  for (const [a, b, c] of tris) {
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    if (n.length() > 1e-12 * Math.max(1e-12, diagonal * diagonal)) { normal = n.normalize(); origin = a; break; }
  }
  if (!normal || !origin) return null;
  const centroid = new THREE.Vector3();
  for (const t of tris) for (const v of t) { if (Math.abs(v.clone().sub(origin).dot(normal)) > tol) return null; centroid.add(v); }
  return { normal, centroid: centroid.multiplyScalar(1 / (tris.length * 3)) };
}

/** A planar triangle set turned into a closed slab: `lo`..`hi` along the normal, side walls on the outline. */
function slab(g: THREE.BufferGeometry, normal: THREE.Vector3, lo: number, hi: number): THREE.BufferGeometry {
  const tris = triangleVertices(g).map(([a, b, c]) => b.clone().sub(a).cross(c.clone().sub(a)).dot(normal) < 0 ? [a, c, b] : [a, b, c]);
  const pos: number[] = [];
  const push = (v: THREE.Vector3, h: number) => pos.push(v.x + normal.x * h, v.y + normal.y * h, v.z + normal.z * h);
  const key = (v: THREE.Vector3) => `${Math.round(v.x * 1e6)},${Math.round(v.y * 1e6)},${Math.round(v.z * 1e6)}`;
  const edges = new Map<string, { a: THREE.Vector3; b: THREE.Vector3 }>();
  for (const [a, b, c] of tris) {
    push(a, hi); push(b, hi); push(c, hi);
    push(a, lo); push(c, lo); push(b, lo);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const back = `${key(q)}>${key(p)}`;
      if (edges.has(back)) edges.delete(back); else edges.set(`${key(p)}>${key(q)}`, { a: p, b: q });
    }
  }
  // what is left is the outline, each edge in the winding of its triangle (the interior on the left of +normal)
  for (const { a, b } of edges.values()) { push(a, lo); push(b, lo); push(b, hi); push(a, lo); push(b, hi); push(a, hi); }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}

/**
 * Sheets (zero-thickness metal) among `geometries`. With `thickness` > 0 each becomes a closed slab,
 * grown away from the solid it lies on (a trace on a substrate rises above it, a ground plane goes below,
 * so the slab never intrudes into the dielectric); a free or embedded sheet is centred on its plane.
 * With 0 the sheets stay surfaces, flagged `flat` so the writers emit both sides.
 * Geometries that were replaced are disposed here; the returned geometries are the caller's.
 */
export function prepareSheets(geometries: THREE.BufferGeometry[], thickness: number): { geometry: THREE.BufferGeometry; flat: boolean }[] {
  const planes = geometries.map(sheetPlane);
  const solids = geometries.filter((_, i) => !planes[i]).map(g => { g.computeBoundingBox(); return g.boundingBox!.clone(); });
  return geometries.map((geometry, i) => {
    const plane = planes[i];
    if (!plane) return { geometry, flat: false };
    if (!(thickness > 0)) return { geometry, flat: true };
    const eps = Math.max(thickness * 1e-3, 1e-9);
    const inside = (sign: number) => { const p = plane.centroid.clone().addScaledVector(plane.normal, sign * eps); return solids.some(box => box.containsPoint(p)); };
    const above = inside(1), below = inside(-1);
    // `above`: the solid is on the +normal side, so the slab goes to the -normal side, and the reverse
    const [lo, hi] = above && !below ? [-thickness, 0] : below && !above ? [0, thickness] : [-thickness / 2, thickness / 2];
    const solid = slab(geometry, plane.normal, lo, hi);
    geometry.dispose();
    return { geometry: solid, flat: false };
  });
}

export interface MeshItem { part: Part; geometry: THREE.BufferGeometry; flat: boolean }

/** Every primitive of every solid part as validated geometry (sheets handled per `options`). Caller disposes. */
export function meshItems(source: Bundle, options: MeshOptions = {}): MeshItem[] {
  const bundle = withoutVoids(source);
  const thickness = sheetThicknessUnits(bundle, options);
  const owners: Part[] = [], geometries: THREE.BufferGeometry[] = [];
  try {
    for (const part of bundle.parts) for (const primitive of part.primitives) { geometries.push(exportGeometry(primitive)); owners.push(part); }
  } catch (error) { geometries.forEach(g => g.dispose()); throw error; }
  return prepareSheets(geometries, thickness).map((r, i) => ({ part: owners[i], ...r }));
}

/** Binary STL records of `items`; `scale` converts drawing units to millimetres. */
function stlBytes(items: MeshItem[], scale: number): Uint8Array {
  // Write binary records directly: a large JS number[] needs several times the final STL's
  // storage and reallocates as it grows. Fixed chunks also bound the last unused allocation.
  const chunkFacets = 65536, facetBytes = 50;
  const chunks: Uint8Array[] = [];
  let chunk: Uint8Array | undefined, chunkView: DataView | undefined;
  let triangles = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  const emit = (normal: THREE.Vector3, p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3) => {
    if (84 + (triangles + 1) * facetBytes > 200 * 1024 * 1024) throw new Error("STL exceeds the 200 MiB save limit");
    const local = triangles % chunkFacets;
    if (local === 0) {
      chunk = new Uint8Array(chunkFacets * facetBytes);
      chunkView = new DataView(chunk.buffer);
      chunks.push(chunk);
    }
    let cursor = local * facetBytes;
    for (const vector of [normal, p, q, r]) {
      chunkView!.setFloat32(cursor, vector.x, true);
      chunkView!.setFloat32(cursor + 4, vector.y, true);
      chunkView!.setFloat32(cursor + 8, vector.z, true);
      cursor += 12;
    }
    triangles++;
  };
  for (const { geometry, flat } of items) {
    const before = triangles;
    const position = geometry.getAttribute("position"), index = geometry.getIndex();
    const count = index?.count ?? position.count;
    if (count % 3 !== 0) throw new Error("Mesh has incomplete triangles");
    const vertex = (target: THREE.Vector3, offset: number) => {
      target.fromBufferAttribute(position, index ? index.getX(offset) : offset).multiplyScalar(scale);
      target.set(Math.fround(target.x), Math.fround(target.y), Math.fround(target.z));
      if (![target.x, target.y, target.z].every(Number.isFinite)) throw new Error("STL coordinates exceed float32 range");
    };
    for (let offset = 0; offset < count; offset += 3) {
      vertex(a, offset); vertex(b, offset + 1); vertex(c, offset + 2);
      const normal = ab.subVectors(b, a).cross(ac.subVectors(c, a));
      if (normal.lengthSq() === 0) continue; // poles and repeated tessellation vertices
      normal.normalize();
      emit(normal, a, b, c);
      // a sheet has no inside: both faces, so no viewer, slicer or CAD tool culls it
      if (flat) emit(normal.clone().negate(), a, c, b);
    }
    if (triangles === before) throw new Error("A solid has no nondegenerate triangles");
  }
  if (!triangles) throw new Error("The scene has no exportable solids");
  const bytes = new Uint8Array(84 + triangles * 50);
  bytes.set(new TextEncoder().encode(`Fairbeam binary STL | coordinates: millimetres | Z-up | ${items.some(i => i.flat) ? "sheets are two-sided surfaces" : "closed solids"}`));
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles, true);
  let cursor = 84;
  for (const data of chunks) {
    const part = data.subarray(0, Math.min(data.length, bytes.length - cursor));
    bytes.set(part, cursor);
    cursor += part.length;
  }
  return bytes;
}

const stlScale = (bundle: Bundle): number => {
  const scale = bundle.units.length_m * 1000;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("Invalid physical length unit");
  return scale;
};

/** Binary STL of the whole scene: unitless format, coordinates explicitly converted to millimetres, Fairbeam Z-up.
 * Mesh winding already incorporates reflected affine transforms in primitiveGeometry.
 * Zero-thickness sheets are written as two-sided surfaces, or as closed slabs when `sheetThicknessUm` > 0.
 */
export function binaryStl(source: Bundle, options: MeshOptions = {}): Uint8Array {
  const scale = stlScale(source);
  const items = meshItems(source, options);
  try { return stlBytes(items, scale); } finally { items.forEach(i => i.geometry.dispose()); }
}

/** One STL per solid part (a part's primitives share its file); file names are unique and file-system safe. */
export function binaryStlParts(source: Bundle, options: MeshOptions = {}): { name: string; bytes: Uint8Array }[] {
  const scale = stlScale(source);
  const items = meshItems(source, options);
  try {
    const parts = new Map<Part, MeshItem[]>();
    for (const item of items) parts.set(item.part, [...(parts.get(item.part) ?? []), item]);
    const used = new Set<string>();
    return [...parts].map(([part, list]) => {
      // the label the tree shows (Ground plane.stl), else the internal name
      const stem = (part.label || part.name || "solid").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "solid";
      let name = `${stem}.stl`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem}_${n}.stl`;
      used.add(name.toLowerCase());
      return { name, bytes: stlBytes(list, scale) };
    });
  } finally { items.forEach(i => i.geometry.dispose()); }
}
