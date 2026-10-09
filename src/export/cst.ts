// CST-compatible VBA macro generator.
//
// Every modelling step is wrapped in AddToHistory so the result is a normal, parametric-rebuildable
// CST history (the same way the GUI records it). Written against the documented CST VBA object
// model (Units, Material, Brick, Polygon, CoverCurve, ExtrudeCurve, Cylinder, Sphere, WCS, Component,
// Solid, DiscretePort, Background, Boundary, Monitor, Solver) using the forms CST 2020+ records in
// its history list. Shapes marked "check after the history rebuild" in the macro (solids of revolution, wires,
// sheared transforms) use less common commands.
//
// Only erasable TypeScript syntax is used (no enums/namespaces/parameter properties) so the file
// also runs directly under `node --experimental-strip-types` (see scripts/gen-cst-examples.mjs).

import type { Bundle, Matrix4Rows, Part, PolygonPrim, Primitive, Vec3 } from "../types";
import { Symbols, type DesignParam } from "./cstParams.ts";
import { APP_VERSION } from "../lib/appVersion.ts";

export interface CstOptions {
  component: string;
  mergeParts: boolean;
  farfieldMonitors: boolean;
  includePorts: boolean;
  solverSettings: boolean;
}

export const DEFAULT_CST_OPTIONS: CstOptions = {
  component: "fairbeam",
  mergeParts: true,
  farfieldMonitors: true,
  includePorts: true,
  solverSettings: true,
};

const AXIS = ["x", "y", "z"] as const;
const EPS = 1e-9;
const FACES = ["x-", "x+", "y-", "y+", "z-", "z+"] as const;
const FACE_CST = ["Xmin", "Xmax", "Ymin", "Ymax", "Zmin", "Zmax"] as const;

/** Numeric literal; CST evaluates these strings, so exponent notation ("1e-07") is accepted. */
const n = (v: number) => {
  if (!Number.isFinite(v)) throw new Error(`non-finite value ${v}`);
  const r = Math.abs(v) < 1e-12 ? 0 : Number(v.toPrecision(10));
  return String(r);
};
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const safe = (s: string) => s.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "part";
/** Free text for comments and history titles: single line, plain ASCII (the .bas is read as ANSI). */
const ascii = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[·•–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim();
const finite = (...vals: number[]) => vals.every((v) => Number.isFinite(v));

class Macro {
  lines: string[] = [];
  warnings: string[] = [];
  raw(s = "") {
    this.lines.push(s);
  }
  comment(s: string) {
    this.lines.push(`    ' ${ascii(s)}`);
  }
  /** One AddToHistory block. Each body line is a VBA statement executed by the CST history. */
  history(title: string, body: string[]) {
    this.lines.push("    sCommand = \"\"");
    for (const b of body) this.lines.push(`    sCommand = sCommand + ${q(b)} + vbLf`);
    this.lines.push(`    AddToHistory ${q(ascii(title))}, sCommand`);
    this.lines.push("");
  }
}

/** Allocates names that are unique within one namespace (CST names compared case-insensitively). */
class Names {
  used = new Set<string>();
  constructor(reserved: string[] = []) {
    for (const r of reserved) this.used.add(r.toLowerCase());
  }
  take(base: string): string {
    let s = base;
    for (let k = 2; this.used.has(s.toLowerCase()); k++) s = `${base}_${k}`;
    this.used.add(s.toLowerCase());
    return s;
  }
}

interface Ctx {
  m: Macro;
  comp: string;
  /** bundle length unit -> CST length unit */
  scale: number;
  /** CST length unit name (m, cm, mm, um, nm) */
  unit: string;
  /** extent of exported geometry and ports, in bundle units (used for background spacing) */
  bbox: [Vec3, Vec3] | null;
  /** companion STL files (polyhedra), written next to the macro; named `<stlBase>_<solid>.stl` */
  files: CstFile[];
  stlBase: string;
  /** the design's parameters (parametric export) and the CST expressions of each exported primitive's fields */
  sym: Symbols | null;
  prims: Map<object, SymPrim>;
}

/** CST expression text of the numeric fields of one primitive (null: write the number). */
type E = string | null;
interface SymPrim {
  box?: { start: E[]; stop: E[] };
  poly?: { points: [E, E][]; elevation: E; length: E };
  cyl?: { radius: E; range: [E, E]; center: [E, E] };
  sphere?: { center: E[]; radius: E };
}

/** A coordinate: the expression when the design has one, else the number in the CST unit. */
const cx = (ctx: Ctx, v: number, e?: E) => (e ? e : c(ctx, v));

/** A companion file of the macro: a polyhedron as an ASCII STL, written next to the .bas. */
export interface CstFile { name: string; data: string }

/** Constant at the top of the macro, and the helper that finds the STL folder at run time. */
export const STL_FOLDER_CONST = "STL_FOLDER";

/** Coordinate literal in the CST length unit. */
const c = (ctx: Ctx, v: number) => n(v * ctx.scale);

function grow(ctx: Ctx, lo: number[], hi: number[]) {
  if (!ctx.bbox) ctx.bbox = [[lo[0], lo[1], lo[2]], [hi[0], hi[1], hi[2]]];
  else for (let i = 0; i < 3; i++) {
    ctx.bbox[0][i] = Math.min(ctx.bbox[0][i], lo[i]);
    ctx.bbox[1][i] = Math.max(ctx.bbox[1][i], hi[i]);
  }
}

const LENGTH_UNITS: [string, number][] = [["m", 1], ["cm", 1e-2], ["mm", 1e-3], ["um", 1e-6], ["nm", 1e-9]];

/** CST length unit for the bundle; unknown drawing units are rescaled to mm. */
function lengthUnit(b: Bundle): { unit: string; scale: number } {
  const lm = b.units?.length_m;
  if (!(typeof lm === "number" && lm > 0)) return { unit: "mm", scale: 1 };
  const hit = LENGTH_UNITS.find(([, v]) => Math.abs(lm / v - 1) < 1e-9);
  return hit ? { unit: hit[0], scale: 1 } : { unit: "mm", scale: lm / 1e-3 };
}

/**
 * What CST cannot hold but fairbeam's CST macro import (python/fairbeam/cst_import.py) needs for an
 * exact round trip: the openEMS port / resistor boxes (CST discrete ports are lines), waveguide
 * ports (written as CST waveguide ports too), the boundary types and the automatic mesh settings. A comment, so CST
 * ignores it; the import uses a record only where it agrees with the CST commands next to it.
 */
const MESH_LINES_PER_RECORD = 40;

function data(m: Macro, record: Record<string, unknown>) {
  m.raw(`    ' fairbeam-data: ${JSON.stringify(record)}`);
}

function withBlock(obj: string, props: [string, ...string[]][], create = true): string[] {
  const out = [`With ${obj}`, "     .Reset"];
  for (const [k, ...vals] of props) out.push(`     .${k} ${vals.join(", ")}`);
  if (create) out.push("     .Create");
  out.push("End With");
  return out;
}

function rgb(hex: string): [string, string, string] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return ["0.5", "0.5", "0.5"];
  return [m[1], m[2], m[3]].map((h) => (parseInt(h, 16) / 255).toFixed(3)) as [string, string, string];
}

/**
 * Local working plane for normal axis n: W = e_n, U = e_(n+1)%3, hence V = W x U = e_(n+2)%3, i.e.
 * CSXCAD's in-plane order (x: U=y,V=z; y: U=z,V=x; z: U=x,V=y), right-handed for every axis.
 * Order Normal -> Origin -> UVector is the order CST records for "set wcs properties"; SetUVector
 * last makes the final frame independent of the previously active local WCS.
 */
function wcsFor(ctx: Ctx, normal: number, elevation: number, elevationExpr?: E): string[] {
  const nv = [0, 0, 0];
  nv[normal] = 1;
  const uv = [0, 0, 0];
  uv[(normal + 1) % 3] = 1;
  const o = [0, 0, 0];
  o[normal] = elevation;
  return [
    'WCS.ActivateWCS "local"',
    `WCS.SetNormal ${nv.map((v) => q(n(v))).join(", ")}`,
    `WCS.SetOrigin ${o.map((v, i) => q(i === normal ? cx(ctx, v, elevationExpr) : c(ctx, v))).join(", ")}`,
    `WCS.SetUVector ${uv.map((v) => q(n(v))).join(", ")}`,
  ];
}

/** Drops repeated vertices (incl. an explicit closing vertex); null if fewer than 3 or zero area. */
function cleanPolygon(pts: [number, number][]): [number, number][] | null {
  const same = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
  const out: [number, number][] = [];
  for (const p of pts) {
    if (!finite(p[0], p[1])) return null;
    if (!out.length || !same(out[out.length - 1], p)) out.push(p);
  }
  while (out.length > 1 && same(out[0], out[out.length - 1])) out.pop();
  if (out.length < 3) return null;
  let area = 0;
  out.forEach(([x0, y0], i) => {
    const [x1, y1] = out[(i + 1) % out.length];
    area += x0 * y1 - x1 * y0;
  });
  return Math.abs(area) > EPS ? out : null;
}

/** Closed polygon curve item `curve:name` (the closing LineTo back to the first point is required). */
function polygonCurve(ctx: Ctx, curve: string, name: string, pts: [number, number][], ex?: [E, E][]): string[] {
  const body = ["With Polygon", "     .Reset", `     .Name ${q(name)}`, `     .Curve ${q(curve)}`];
  const at = (i: number) => `${q(cx(ctx, pts[i][0], ex?.[i][0]))}, ${q(cx(ctx, pts[i][1], ex?.[i][1]))}`;
  pts.forEach((_p, i) => body.push(`     .${i === 0 ? "Point" : "LineTo"} ${at(i)}`));
  body.push(`     .LineTo ${at(0)}`, "     .Create", "End With");
  return body;
}

/** cleanPolygon that also says which of the given points it kept (their expressions follow them). */
function cleanPolygonIdx(pts: [number, number][]): { pts: [number, number][]; idx: number[] } | null {
  const same = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
  const idx: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (!finite(pts[i][0], pts[i][1])) return null;
    if (!idx.length || !same(pts[idx[idx.length - 1]], pts[i])) idx.push(i);
  }
  while (idx.length > 1 && same(pts[idx[0]], pts[idx[idx.length - 1]])) idx.pop();
  const kept = idx.map((i) => pts[i]);
  return kept.length >= 3 ? { pts: kept, idx } : null;
}

/** 3D bounds of an in-plane polygon (bundle units). */
function planeBounds(normal: number, elevation: number, pts: [number, number][], length = 0): [number[], number[]] {
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  const u = (normal + 1) % 3;
  const v = (normal + 2) % 3;
  lo[normal] = Math.min(elevation, elevation + length);
  hi[normal] = Math.max(elevation, elevation + length);
  lo[u] = Math.min(...pts.map((p) => p[0]));
  hi[u] = Math.max(...pts.map((p) => p[0]));
  lo[v] = Math.min(...pts.map((p) => p[1]));
  hi[v] = Math.max(...pts.map((p) => p[1]));
  return [lo, hi];
}

/**
 * What a rotational profile (radial, axial) is in CST terms: a cone or frustum (a trapezoid or
 * triangle with one side on the axis and the other two normal to it), a torus (a regular polygon
 * of 16 or more sides clear of the axis, as the designer writes it: the CST torus is the smooth one
 * it approximates), or null.
 */
export function revolvedShape(points: [number, number][]):
  | { type: "cone"; h0: number; h1: number; rb: number; rt: number }
  | { type: "torus"; rc: number; hc: number; rho: number }
  | null {
  const tol = 1e-6 * Math.max(1, ...points.map(([r, h]) => Math.max(Math.abs(r), Math.abs(h))));
  const hs = [...new Set(points.map((p) => p[1]))].sort((x, y) => x - y);
  const levels = hs.filter((h, i) => i === 0 || h - hs[i - 1] > tol);
  if (levels.length === 2 && points.length <= 4) {
    const [h0, h1] = levels;
    const at = (h: number) => points.filter((p) => Math.abs(p[1] - h) <= tol).map((p) => p[0]);
    const r0 = at(h0), r1 = at(h1);
    // each level holds its axis point (r = 0) and at most one rim point
    const ok = (rs: number[]) => rs.some((r) => Math.abs(r) <= tol) && rs.length <= 2;
    if (ok(r0) && ok(r1) && points.every((p) => p[0] >= -tol)) {
      const rb = Math.max(...r0), rt = Math.max(...r1);
      if (rb > tol || rt > tol) return { type: "cone", h0, h1, rb, rt };
    }
    return null;
  }
  if (points.length >= 16) {
    const rc = points.reduce((s, p) => s + p[0], 0) / points.length;
    const hc = points.reduce((s, p) => s + p[1], 0) / points.length;
    const d = points.map(([r, h]) => Math.hypot(r - rc, h - hc));
    const rho = d.reduce((s, x) => s + x, 0) / d.length;
    const round = d.every((x) => Math.abs(x - rho) <= Math.max(tol * 10, 1e-4 * rho));
    // the bundle keeps 6 decimals: so does the torus read back from it
    const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
    if (round && rho > 0 && rc - rho > tol) return { type: "torus", rc: r6(rc), hc: r6(hc), rho: r6(rho) };
  }
  return null;
}


/**
 * A flat polygon that is a regular N-gon on a circle (N >= 64, even): its centre, radius, or null.
 * Radial spread within 1e-6 relative (or the bundle's 6-decimal rounding) and equal angular steps.
 */
export function regularCircle(pts: [number, number][]): { cu: number; cv: number; r: number } | null {
  const N = pts.length;
  if (N < 64 || N % 2 !== 0) return null;
  const cu = pts.reduce((a, p) => a + p[0], 0) / N;
  const cv = pts.reduce((a, p) => a + p[1], 0) / N;
  const d = pts.map((p) => Math.hypot(p[0] - cu, p[1] - cv));
  const r = d.reduce((a, x) => a + x, 0) / N;
  if (!(r > EPS)) return null;
  if (d.some((x) => Math.abs(x - r) > Math.max(1e-6 * r, 1e-6))) return null;
  const ang = pts.map((p) => Math.atan2(p[1] - cv, p[0] - cu));
  const step = (2 * Math.PI) / N;
  const wrap = (x: number) => {
    while (x > Math.PI) x -= 2 * Math.PI;
    while (x <= -Math.PI) x += 2 * Math.PI;
    return x;
  };
  const first = wrap(ang[1] - ang[0]);
  const sign = first > 0 ? 1 : -1;
  const tol = Math.max(1e-5, 2e-6 / r);
  for (let i = 0; i < N; i++) if (Math.abs(wrap(ang[(i + 1) % N] - ang[i]) - sign * step) > tol) return null;
  // the bundle keeps 6 decimals: so does the circle read back from it
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
  return { cu: r6(cu), cv: r6(cv), r: r6(r) };
}

const IDENTITY_TOL = 1e-9;

/**
 * Decomposition of the affine map world = A * local + t (bundle matrix, row-major, column vectors) into
 * the steps CST can apply to a shape about the global origin, in this order:
 * mirror (local x -> -x, if det < 0), scale (|factors|), rotate about x, then y, then z (degrees,
 * right-handed), translate. rotation(angles) = Rz(az) * Ry(ay) * Rx(ax). `matrix3` is set instead
 * (and `rotation`, `scale` are null) when the columns are not orthogonal (a shear).
 */
export interface AffineSteps {
  mirrorX: boolean;
  scale: Vec3 | null;
  angles: Vec3 | null;
  translate: Vec3 | null;
  shear: boolean;
}

export function decomposeAffine(M: Matrix4Rows): AffineSteps | null {
  const A = [0, 1, 2].map((i) => [0, 1, 2].map((j) => M[i][j]));
  const t = [M[0][3], M[1][3], M[2][3]] as Vec3;
  if (!finite(...A.flat(), ...t)) return null;
  const col = (j: number) => [A[0][j], A[1][j], A[2][j]];
  const s = [0, 1, 2].map((j) => Math.hypot(...col(j)));
  const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  const sMax = Math.max(...s);
  if (!(Math.min(...s) > 1e-12 * Math.max(1, sMax)) || Math.abs(det) < 1e-12 * sMax ** 3) return null;
  const translate = t.some((v) => Math.abs(v) > IDENTITY_TOL) ? t : null;
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const shear = [[0, 1], [0, 2], [1, 2]].some(([i, j]) => Math.abs(dot(col(i), col(j))) > 1e-9 * s[i] * s[j]);
  if (shear) return { mirrorX: false, scale: null, angles: null, translate, shear: true };
  const mirrorX = det < 0;
  // R = Q * d with Q the unit columns and d = diag(-1,1,1) for a reflection
  const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (A[i][j] / s[j]) * (mirrorX && j === 0 ? -1 : 1)));
  const sy = -R[2][0];
  const beta = Math.asin(Math.max(-1, Math.min(1, sy)));
  let alpha: number, gamma: number;
  if (Math.abs(Math.cos(beta)) > 1e-9) {
    alpha = Math.atan2(R[2][1], R[2][2]);
    gamma = Math.atan2(R[1][0], R[0][0]);
  } else {
    gamma = 0;
    alpha = Math.atan2(-R[1][2], R[1][1]);
  }
  const deg = [alpha, beta, gamma].map((x) => {
    const v = (x * 180) / Math.PI;
    return Math.abs(v) < 1e-9 ? 0 : v;
  }) as Vec3;
  const scale = s.some((v) => Math.abs(v - 1) > IDENTITY_TOL) ? ([s[0], s[1], s[2]] as Vec3) : null;
  return { mirrorX, scale, angles: deg.some((v) => v !== 0) ? deg : null, translate, shear: false };
}

/**
 * The `Transform` history blocks for one shape: [title suffix, body lines]. As CST records them, the
 * settings come first and `.Transform "Shape", "<how>"` (which executes it) is last; every rotation
 * is its own single-axis step, so the order (x, then y, then z) never depends on how CST combines
 * several angles. All are about the global origin, where the shape was created.
 */
function transformBlocks(ctx: Ctx, full: string, st: AffineSteps, M: Matrix4Rows): [string, string[]][] {
  const zero = `${q("0")}, ${q("0")}, ${q("0")}`;
  const block = (how: string, props: string[], free = true) => ["With Transform", "     .Reset", `     .Name ${q(full)}`, ...props,
    ...(free ? ['     .Origin "Free"', `     .Center ${zero}`] : []),
    '     .MultipleObjects "False"', '     .GroupObjects "False"', '     .Repetitions "1"', '     .MultipleSelection "False"',
    `     .Transform "Shape", ${q(how)}`, "End With"];
  const out: [string, string[]][] = [];
  if (st.shear) {
    const cols = [0, 1, 2].flatMap((j) => [0, 1, 2].map((i) => q(n(M[i][j]))));
    out.push(["matrix", block("Matrix", [`     .Matrix ${cols.join(", ")}`, `     .Vector ${[0, 1, 2].map((i) => q(c(ctx, M[i][3]))).join(", ")}`], false)]);
    return out;
  }
  if (st.mirrorX) out.push(["mirror x", block("Mirror", [`     .PlaneNormal ${q("1")}, ${q("0")}, ${q("0")}`])]);
  if (st.scale) out.push(["scale", block("Scale", [`     .ScaleFactor ${st.scale.map((v) => q(n(v))).join(", ")}`])]);
  if (st.angles) {
    ["x", "y", "z"].forEach((ax, k) => {
      if (st.angles![k] === 0) return;
      const ang = [0, 1, 2].map((i) => q(i === k ? n(st.angles![k]) : "0"));
      out.push([`rotate ${ax}`, block("Rotate", [`     .Angle ${ang.join(", ")}`])]);
    });
  }
  if (st.translate) out.push(["translate", block("Translate", [`     .Vector ${st.translate.map((v) => q(c(ctx, v))).join(", ")}`, '     .UsePickedPoints "False"', '     .InvertPickedPoints "False"'], false)]);
  return out;
}


/** Triangles of a polyhedron (faces fanned), wound counter-clockwise seen from outside (checked by the signed volume). */
export function polyhedronTriangles(vertices: Vec3[], faces: number[][]): [Vec3, Vec3, Vec3][] {
  const tris: [Vec3, Vec3, Vec3][] = [];
  for (const f of faces) for (let k = 1; k + 1 < f.length; k++) tris.push([vertices[f[0]], vertices[f[k]], vertices[f[k + 1]]]);
  const vol = tris.reduce((s, [a, b, c0]) => s + (a[0] * (b[1] * c0[2] - b[2] * c0[1]) - a[1] * (b[0] * c0[2] - b[2] * c0[0]) + a[2] * (b[0] * c0[1] - b[1] * c0[0])), 0);
  return vol < 0 ? tris.map(([a, b, c0]) => [a, c0, b] as [Vec3, Vec3, Vec3]) : tris;
}

/** ASCII STL of triangles; coordinates are written as given (the caller scales them to the CST unit). */
export function asciiStl(name: string, tris: [Vec3, Vec3, Vec3][]): string {
  const out = [`solid ${name}`];
  for (const [a, b, c0] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c0[0] - a[0], c0[1] - a[1], c0[2] - a[2]];
    const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
    const len = Math.hypot(nx, ny, nz) || 1;
    out.push(`  facet normal ${n(nx / len)} ${n(ny / len)} ${n(nz / len)}`, "    outer loop", ...[a, b, c0].map((p) => `      vertex ${n(p[0])} ${n(p[1])} ${n(p[2])}`), "    endloop", "  endfacet");
  }
  out.push(`endsolid ${name}`);
  return out.join("\n") + "\n";
}

/**
 * A polyhedron reaches CST as an STL file next to the macro (CST has no polyhedron command): the
 * macro imports it with the STL object (CST help: VBA > Import/Export > STL Object; the object has no
 * material, so Solid.ChangeMaterial follows). `sStlDir` is found at run time by the macro's helper.
 */
function polyhedronStl(ctx: Ctx, vertices: Vec3[], faces: number[][], bbox: [Vec3, Vec3], part: Part, solid: string, mat: string): string | null {
  const { m, comp } = ctx;
  const label = ascii(part.name);
  const ok = vertices.every((v) => finite(...v)) && faces.every((f) => f.length >= 3 && f.every((i) => Number.isInteger(i) && i >= 0 && i < vertices.length));
  if (!ok) {
    m.warnings.push(`${label}: polyhedron skipped (non-finite coordinates or a face with a missing vertex)`);
    return null;
  }
  const scaled = vertices.map((v) => [v[0] * ctx.scale, v[1] * ctx.scale, v[2] * ctx.scale] as Vec3);
  const tris = polyhedronTriangles(scaled, faces);
  const file = `${ctx.stlBase}_${solid}.stl`;
  ctx.files.push({ name: file, data: asciiStl(solid, tris) });
  const id = ctx.files.length;
  m.comment(`${label}: polyhedron (${faces.length} faces, ${tris.length} triangles) imported from ${file}`);
  m.lines.push("    sCommand = \"\"");
  const put = (s: string) => m.lines.push(`    sCommand = sCommand + ${s} + vbLf`);
  put(q("With STL"));
  put(q("     .Reset"));
  put(`${q('     .FileName "')} + sStlDir + ${q(`${file}"`)}`);
  put(q(`     .Id ${q(String(id))}`));
  put(q(`     .Name ${q(solid)}`));
  put(q(`     .Component ${q(comp)}`));
  put(q('     .ScaleToUnit "True"'));
  put(q(`     .ImportFileUnits ${q(ctx.unit)}`));
  put(q('     .ImportToActiveCoordinateSystem "False"'));
  put(q("     .Read"));
  put(q("End With"));
  m.lines.push(`    AddToHistory ${q(`import polyhedron: ${comp}:${solid}`)}, sCommand`);
  m.lines.push("");
  m.history(`change material: ${comp}:${solid}`, [`Solid.ChangeMaterial ${q(`${comp}:${solid}`)}, ${q(mat)}`]);
  grow(ctx, bbox[0], bbox[1]);
  return solid;
}

/** Shape commands for one primitive; returns the created solid name (without component) or null. */
function primitiveCommands(ctx: Ctx, prim: Primitive, part: Part, solid: string, mat: string): string | null {
  const { m, comp } = ctx;
  const full = `${comp}:${solid}`;
  const label = ascii(part.name);
  switch (prim.kind) {
    case "box": {
      if (!finite(...prim.start, ...prim.stop)) break;
      const lo = prim.start.map((v, i) => Math.min(v, prim.stop[i]));
      const hi = prim.start.map((v, i) => Math.max(v, prim.stop[i]));
      const zero = lo.map((v, i) => Math.abs(hi[i] - v) < EPS);
      const nz = zero.filter(Boolean).length;
      // expressions of the lower and upper end along each axis (the design's start / stop, whichever is smaller)
      const sb = ctx.prims.get(prim)?.box;
      const loE = [0, 1, 2].map((i) => (sb ? (prim.start[i] <= prim.stop[i] ? sb.start[i] : sb.stop[i]) : null));
      const hiE = [0, 1, 2].map((i) => (sb ? (prim.start[i] <= prim.stop[i] ? sb.stop[i] : sb.start[i]) : null));
      if (nz === 0) {
        m.history(`define brick: ${full}`, withBlock("Brick", [
          ["Name", q(solid)], ["Component", q(comp)], ["Material", q(mat)],
          ["Xrange", q(cx(ctx, lo[0], loE[0])), q(cx(ctx, hi[0], hiE[0]))],
          ["Yrange", q(cx(ctx, lo[1], loE[1])), q(cx(ctx, hi[1], hiE[1]))],
          ["Zrange", q(cx(ctx, lo[2], loE[2])), q(cx(ctx, hi[2], hiE[2]))],
        ]));
        grow(ctx, lo, hi);
        return solid;
      }
      if (nz === 1) {
        // zero-thickness box -> sheet (CST bricks must have volume)
        const ax = zero.indexOf(true);
        const u = (ax + 1) % 3;
        const v = (ax + 2) % 3;
        const pts: [number, number][] = [[lo[u], lo[v]], [hi[u], lo[v]], [hi[u], hi[v]], [lo[u], hi[v]]];
        const exPts: [E, E][] = [[loE[u], loE[v]], [hiE[u], loE[v]], [hiE[u], hiE[v]], [loE[u], hiE[v]]];
        sheet(ctx, ax, lo[ax], pts, solid, mat, sb ? { elevation: loE[ax], pts: exPts } : undefined);
        grow(ctx, lo, hi);
        return solid;
      }
      m.warnings.push(`${label}: line- or point-like box skipped (zero area)`);
      return null;
    }
    case "polygon":
    case "linpoly": {
      const cleaned = cleanPolygon(prim.points);
      const pts = cleaned;
      if (!pts || !finite(prim.elevation, prim.length ?? 0)) {
        m.warnings.push(`${label}: degenerate polygon skipped (fewer than 3 distinct points or zero area)`);
        return null;
      }
      const len = prim.kind === "linpoly" ? prim.length ?? 0 : 0;
      if (prim.kind === "linpoly" && Math.abs(len) < EPS) m.warnings.push(`${label}: zero-length extrusion exported as a sheet`);
      // the expressions of the points that cleanPolygon kept
      const sp = ctx.prims.get(prim)?.poly;
      const kept = sp ? cleanPolygonIdx(prim.points) : null;
      const exPts = sp && kept ? kept.idx.map((i) => sp.points[i]) : undefined;
      if (Math.abs(len) < EPS) sheet(ctx, prim.normal, prim.elevation, pts, solid, mat, sp ? { elevation: sp.elevation, pts: exPts } : undefined);
      else extrude(ctx, prim, pts, len, solid, mat, sp ? { elevation: sp.elevation, length: sp.length, pts: exPts } : undefined);
      const [lo, hi] = planeBounds(prim.normal, prim.elevation, pts, len);
      grow(ctx, lo, hi);
      return solid;
    }
    case "cylinder":
    case "cylindricalshell": {
      // a tube (CSXCAD CylindricalShell: radius = middle of the wall) is a CST Cylinder with an inner radius
      const outer = prim.kind === "cylinder" ? prim.radius : prim.radius + prim.shell_width / 2;
      const inner = prim.kind === "cylinder" ? 0 : Math.max(0, prim.radius - prim.shell_width / 2);
      if (!finite(...prim.start, ...prim.stop, outer, inner)) break;
      const d = prim.stop.map((v, i) => v - prim.start[i]);
      const axis = d.findIndex((v, i) => Math.abs(v) > EPS && d.every((w, j) => j === i || Math.abs(w) < EPS));
      const what = prim.kind === "cylinder" ? "cylinder" : "tube";
      if (axis < 0 || !(outer > EPS) || !(inner < outer)) {
        m.warnings.push(`${label}: ${what} skipped (CST Cylinder needs an x/y/z axis, non-zero length and radius)`);
        return null;
      }
      const a = AXIS[axis];
      const others = [0, 1, 2].filter((i) => i !== axis);
      const range = [prim.start[axis], prim.stop[axis]].sort((x, y) => x - y);
      const sc = prim.kind === "cylinder" ? ctx.prims.get(prim)?.cyl : undefined;
      // the design's range is [lower, upper] already (sorted by the build); the check in symbolize() holds it to the numbers
      m.history(`define ${what === "tube" ? "cylinder (tube)" : "cylinder"}: ${full}`, withBlock("Cylinder", [
        ["Name", q(solid)], ["Component", q(comp)], ["Material", q(mat)],
        ["OuterRadius", q(cx(ctx, outer, sc?.radius))], ["InnerRadius", q(inner > EPS ? c(ctx, inner) : "0")], ["Axis", q(a)],
        [`${a.toUpperCase()}range`, q(cx(ctx, range[0], sc?.range[0])), q(cx(ctx, range[1], sc?.range[1]))],
        [`${AXIS[others[0]].toUpperCase()}center`, q(cx(ctx, prim.start[others[0]], sc?.center[0]))],
        [`${AXIS[others[1]].toUpperCase()}center`, q(cx(ctx, prim.start[others[1]], sc?.center[1]))],
        ["Segments", q("0")],
      ]));
      const lo = [0, 0, 0];
      const hi = [0, 0, 0];
      lo[axis] = range[0];
      hi[axis] = range[1];
      for (const o of others) {
        lo[o] = prim.start[o] - outer;
        hi[o] = prim.start[o] + outer;
      }
      grow(ctx, lo, hi);
      return solid;
    }
    case "sphere": {
      if (!finite(...prim.center, prim.radius)) break;
      if (!(prim.radius > EPS)) {
        m.warnings.push(`${label}: sphere of zero radius skipped`);
        return null;
      }
      m.history(`define sphere: ${full}`, withBlock("Sphere", [
        ["Name", q(solid)], ["Component", q(comp)], ["Material", q(mat)],
        ["Axis", q("z")], ["CenterRadius", q(cx(ctx, prim.radius, ctx.prims.get(prim)?.sphere?.radius))], ["TopRadius", q("0")], ["BottomRadius", q("0")],
        ["Center", ...[0, 1, 2].map((i) => q(cx(ctx, prim.center[i], ctx.prims.get(prim)?.sphere?.center[i])))],
        ["Segments", q("0")],
      ]));
      grow(ctx, prim.center.map((v) => v - prim.radius), prim.center.map((v) => v + prim.radius));
      return solid;
    }
    case "rotpoly": {
      if (!finite(...prim.origin, ...prim.points.flat())) break;
      const a = AXIS[prim.axis];
      const others = [0, 1, 2].filter((i) => i !== prim.axis);
      const shape = revolvedShape(prim.points);
      if (shape?.type === "cone") {
        const o = prim.origin, [h0, h1] = [o[prim.axis] + shape.h0, o[prim.axis] + shape.h1];
        const centers = others.map((i): [string, string] => [`${AXIS[i].toUpperCase()}center`, q(c(ctx, o[i]))]);
        const common: [string, string][] = [["Name", q(solid)], ["Component", q(comp)], ["Material", q(mat)]];
        if (Math.abs(shape.rb - shape.rt) < EPS) {
          // equal radii: a CST Cone needs them to differ, so a Cylinder
          m.history(`define cylinder: ${full}`, withBlock("Cylinder", [...common,
            ["OuterRadius", q(c(ctx, shape.rb))], ["InnerRadius", q("0")], ["Axis", q(a)],
            [`${a.toUpperCase()}range`, q(c(ctx, h0)), q(c(ctx, h1))], ...centers, ["Segments", q("0")]]));
        } else {
          m.history(`define cone: ${full}`, withBlock("Cone", [...common,
            ["BottomRadius", q(c(ctx, shape.rb))], ["TopRadius", q(c(ctx, shape.rt))], ["Axis", q(a)],
            [`${a.toUpperCase()}range`, q(c(ctx, h0)), q(c(ctx, h1))], ...centers, ["Segments", q("0")]]));
        }
      } else if (shape?.type === "torus") {
        const ctr = [...prim.origin];
        ctr[prim.axis] += shape.hc;
        m.history(`define torus: ${full}`, withBlock("Torus", [
          ["Name", q(solid)], ["Component", q(comp)], ["Material", q(mat)],
          ["OuterRadius", q(c(ctx, shape.rc + shape.rho))], ["InnerRadius", q(c(ctx, shape.rc - shape.rho))], ["Axis", q(a)],
          ["Xcenter", q(c(ctx, ctr[0]))], ["Ycenter", q(c(ctx, ctr[1]))], ["Zcenter", q(c(ctx, ctr[2]))],
          ["Segments", q("0")],
        ]));
      } else {
        // any other profile: CST Rotate (pointlist), the (radial, axial) points turned a full 360 degrees
        // about the line through origin along the axis. Rvector is the radial direction of the profile
        // plane (axis+1), Zvector the axis.
        const pr = cleanPolygon(prim.points);
        if (!pr) {
          m.warnings.push(`${label}: degenerate solid of revolution skipped (fewer than 3 distinct profile points or zero area)`);
          return null;
        }
        const rv = [0, 0, 0], zv = [0, 0, 0];
        rv[others[0]] = 1;
        zv[prim.axis] = 1;
        const body = ["With Rotate", "     .Reset", `     .Name ${q(solid)}`, `     .Component ${q(comp)}`, `     .Material ${q(mat)}`,
          '     .Mode "Pointlist"', '     .StartAngle "0.0"', '     .Angle "360.0"', '     .Height "0.0"', '     .RadiusRatio "1.0"', '     .NSteps "0"',
          `     .Origin ${prim.origin.map((v) => q(c(ctx, v))).join(", ")}`,
          `     .Rvector ${rv.map((v) => q(String(v))).join(", ")}`, `     .Zvector ${zv.map((v) => q(String(v))).join(", ")}`];
        pr.forEach(([r, h], i) => body.push(`     .${i === 0 ? "Point" : "LineTo"} ${q(c(ctx, r))}, ${q(c(ctx, h))}`));
        body.push(`     .LineTo ${q(c(ctx, pr[0][0]))}, ${q(c(ctx, pr[0][1]))}`, '     .SplitClosedEdges "True"', '     .SegmentedProfile "False"', '     .SimplifySolid "True"', '     .UseAdvancedSegmentedRotation "True"', "     .Create", "End With");
        m.comment(`${label}: general solid of revolution as CST Rotate (profile plane = radial axis ${AXIS[others[0]]}, axis ${a}); check after the history rebuild`);
        m.history(`define rotate: ${full}`, ['WCS.ActivateWCS "global"', ...body]);
      }
      grow(ctx, prim.bbox[0], prim.bbox[1]);
      return solid;
    }
    case "curve":
    case "wire": {
      const pts = prim.points;
      if (!pts || pts.length < 2 || !finite(...pts.flat(), prim.radius ?? 0)) {
        m.warnings.push(`${label}: thin ${prim.kind} with fewer than 2 finite points skipped`);
        return null;
      }
      const rad = prim.radius ?? 0;
      const curve = `${solid}_curve`;
      const wire = `${solid}_wire`;
      const lo = [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i])) - rad);
      const hi = [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i])) + rad);
      const poly = [`Curve.NewCurve ${q(curve)}`, 'WCS.ActivateWCS "global"', "With Polygon3D", "     .Reset", `     .Name ${q(solid)}`, `     .Curve ${q(curve)}`,
        ...pts.map((p) => `     .Point ${p.map((v) => q(c(ctx, v))).join(", ")}`), "     .Create", "End With"];
      if (rad > EPS) {
        // a solid-model curve wire of the radius, converted to a solid so it can be united like any other shape
        m.comment(`${label}: wire of radius ${n(rad)} exported as a CST curve wire converted to a solid (Wire.ConvertToSolidShape); check after the history rebuild`);
        m.history(`define wire: ${full}`, [...poly,
          "With Wire", "     .Reset", `     .Name ${q(wire)}`, '     .Type "Curvewire"', `     .Curve ${q(`${curve}:${solid}`)}`, `     .Radius ${q(c(ctx, rad))}`,
          '     .SolidWireModel "True"', `     .Material ${q(mat)}`, '     .Termination "natural"', "     .Add", "End With",
          "With Wire", "     .Reset", `     .Name ${q(wire)}`, `     .SolidName ${q(full)}`, `     .Material ${q(mat)}`, '     .KeepWire "False"', "     .ConvertToSolidShape", "End With"]);
        grow(ctx, lo, hi);
        return solid;
      }
      // zero radius: a plain CST curve wire (not a solid, so it is not united with its part)
      m.comment(`${label}: zero-radius ${prim.kind} exported as a CST curve wire (PEC), not a solid`);
      m.history(`define wire: ${comp}:${wire}`, [...poly,
        "With Wire", "     .Reset", `     .Name ${q(wire)}`, '     .Type "Curvewire"', `     .Curve ${q(`${curve}:${solid}`)}`, '     .Radius "0.0"',
        '     .SolidWireModel "False"', '     .Material "PEC"', '     .Termination "natural"', "     .Add", "End With"]);
      grow(ctx, lo, hi);
      return null;
    }
    case "polyhedron":
      return polyhedronStl(ctx, prim.vertices, prim.faces, prim.bbox, part, solid, mat);
    case "transformed": {
      if (prim.primitive.kind === "polyhedron") {
        // the STL is written with the transform applied (a mirror turns the faces inside out: flipped back)
        const M = prim.matrix;
        const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
        if (!(Math.abs(det) > 1e-12) || !M.every((r) => r.every(Number.isFinite))) {
          m.warnings.push(`${label}: transformed polyhedron skipped (singular or non-finite matrix)`);
          return null;
        }
        const vs = prim.primitive.vertices.map((v) => [0, 1, 2].map((i) => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2] + M[i][3]) as Vec3);
        return polyhedronStl(ctx, vs, prim.primitive.faces, prim.bbox, part, solid, mat);
      }
      const st = decomposeAffine(prim.matrix);
      if (!st) {
        m.warnings.push(`${label}: transformed ${prim.primitive.kind} skipped (singular or non-finite matrix)`);
        return null;
      }
      const saved = ctx.bbox ? ([[...ctx.bbox[0]], [...ctx.bbox[1]]] as [Vec3, Vec3]) : null;
      const made = primitiveCommands(ctx, prim.primitive, part, solid, mat);
      ctx.bbox = saved;
      if (!made) return null;
      if (st.shear) m.warnings.push(`${label}: transformed ${prim.primitive.kind} has a shear (non-orthogonal matrix); exported with CST Transform "Matrix" (check after the history rebuild)`);
      else if (st.mirrorX) m.warnings.push(`${label}: transformed ${prim.primitive.kind} contains a reflection; exported as a Mirror about the local x = 0 plane, then scale, rotation and translation`);
      for (const [what, body] of transformBlocks(ctx, full, st, prim.matrix)) m.history(`transform ${what}: ${full}`, body);
      grow(ctx, prim.bbox[0], prim.bbox[1]);
      return solid;
    }
    case "bbox":
      m.warnings.push(`${label}: ${prim.transformed ? "transformed" : "unsupported"} primitive '${ascii(prim.source_kind)}' skipped`);
      return null;
  }
  m.warnings.push(`${label}: primitive with non-finite coordinates skipped`);
  return null;
}

/**
 * Each profile gets its own curve (`<solid>_curve`), so curve item references can never collide
 * and do not depend on whether CoverCurve/ExtrudeCurve with Delete "True" removes only the item or
 * the whole (then empty) curve. Curve.NewCurve is what the GUI records for "new curve".
 */
function profileCommands(ctx: Ctx, normal: number, elevation: number, pts: [number, number][], solid: string, ex?: { elevation?: E; pts?: [E, E][] }) {
  const curve = `${solid}_curve`;
  // a regular many-sided polygon is a circle: a true CST Circle (Segments 0) instead of an N-gon
  // (not when its points are expressions: they stay a polygon that follows the parameters)
  const circ = ex?.pts?.some((p) => p[0] || p[1]) ? null : regularCircle(pts);
  const item = circ
    ? ["With Circle", "     .Reset", `     .Name ${q(solid)}`, `     .Curve ${q(curve)}`, `     .Radius ${q(c(ctx, circ.r))}`,
       `     .Xcenter ${q(c(ctx, circ.cu))}`, `     .Ycenter ${q(c(ctx, circ.cv))}`, '     .Segments "0"', "     .Create", "End With"]
    : polygonCurve(ctx, curve, solid, pts, ex?.pts);
  return {
    ref: `${curve}:${solid}`,
    body: [`Curve.NewCurve ${q(curve)}`, ...wcsFor(ctx, normal, elevation, ex?.elevation), ...item],
  };
}

function sheet(ctx: Ctx, normal: number, elevation: number, pts: [number, number][], solid: string, mat: string, ex?: { elevation?: E; pts?: [E, E][] }) {
  const { ref, body } = profileCommands(ctx, normal, elevation, pts, solid, ex);
  ctx.m.history(`define sheet: ${ctx.comp}:${solid}`, [
    ...body,
    "With CoverCurve",
    "     .Reset",
    `     .Name ${q(solid)}`,
    `     .Component ${q(ctx.comp)}`,
    `     .Material ${q(mat)}`,
    `     .Curve ${q(ref)}`,
    '     .DeleteCurve "True"',
    "     .Create",
    "End With",
    'WCS.ActivateWCS "global"',
  ]);
}

function extrude(ctx: Ctx, prim: PolygonPrim, pts: [number, number][], len: number, solid: string, mat: string, ex?: { elevation?: E; length?: E; pts?: [E, E][] }) {
  // ExtrudeCurve extrudes along +W of the profile's plane; a negative openEMS length is handled by
  // moving the profile to the far end so the thickness is always positive.
  const base = len < 0 ? prim.elevation + len : prim.elevation;
  // the same, over the parameters: the far end is elevation + length, the thickness -length
  const baseE: E = len < 0 && (ex?.elevation || ex?.length) ? `(${ex.elevation ?? c(ctx, prim.elevation)}) + (${ex.length ?? c(ctx, len)})` : ex?.elevation ?? null;
  const thickE: E = ex?.length ? (len < 0 ? `-(${ex.length})` : ex.length) : null;
  const { ref, body } = profileCommands(ctx, prim.normal, base, pts, solid, { elevation: baseE, pts: ex?.pts });
  ctx.m.history(`define extrusion: ${ctx.comp}:${solid}`, [
    ...body,
    "With ExtrudeCurve",
    "     .Reset",
    `     .Name ${q(solid)}`,
    `     .Component ${q(ctx.comp)}`,
    `     .Material ${q(mat)}`,
    `     .Thickness ${q(cx(ctx, Math.abs(len), thickE))}`,
    '     .Twistangle "0"',
    '     .Taperangle "0"',
    '     .DeleteProfile "True"',
    `     .Curve ${q(ref)}`,
    "     .Create",
    "End With",
    'WCS.ActivateWCS "global"',
  ]);
}

function boundaryCst(kind: string | undefined, face: string, m: Macro): string {
  if (kind === "PEC") return "electric";
  if (kind === "PMC") return "magnetic";
  if (kind === "MUR" || (kind ?? "").startsWith("PML")) return "expanded open";
  m.warnings.push(`boundary ${face}: unknown openEMS type '${ascii(String(kind))}', exported as open`);
  return "expanded open";
}

/** End points of a lumped port/element as a line along its current direction through the centre of
 * the (possibly sheet-shaped) openEMS box: CST discrete ports and lumped elements are lines. */
function axisLine(start: Vec3, stop: Vec3, direction: "x" | "y" | "z"): [Vec3, Vec3] {
  const k = "xyz".indexOf(direction);
  const mid = start.map((v, i) => (v + stop[i]) / 2) as Vec3;
  const a = [...mid] as Vec3;
  const bb = [...mid] as Vec3;
  a[k] = start[k];
  bb[k] = stop[k];
  return [a, bb];
}

/** Extra Boolean steps a bundle cannot carry (it holds no design history). */
export interface ParametricDesign {
  params?: DesignParam[];
  parts?: { name: string; material?: string; primitives?: any[]; transforms?: unknown[]; cuts?: unknown[]; booleanHistory?: unknown; void?: boolean }[];
  materials?: { name: string; eps_r?: unknown; tan_d?: unknown }[];
  ports?: { number?: number; type?: string; R?: unknown; start?: unknown[]; stop?: unknown[]; direction?: string }[];
  simulation?: { f_min?: unknown; f_max?: unknown };
}

export interface CstExtras {
  /** the design the bundle was built from: its parameters become CST parameters and the geometry is written over them */
  parametric?: ParametricDesign;
  /** the macro's file name without ".bas": the companion STL files are named `<macroBase>_<solid>.stl` */
  macroBase?: string;
  /** Solid.Insert pairs: `host` keeps everything, `tool` is cut out of it but stays (a Boolean Insert by priority) */
  inserts?: { host: string; tool: string }[];
}

/** The Insert pairs of a design: a part made by a Boolean Insert whose operands were not all flat
 * polygon / box shapes (so the result keeps A whole and B stays a separate part named like history.B). */
export function cstInsertPairs(design: { parts: { name: string; primitives?: unknown[]; booleanHistory?: { operation: string; A: { primitives?: { kind: string }[] }; B: { name: string; primitives?: { kind: string }[] } } }[] }): { host: string; tool: string }[] {
  const flat = (ps: { kind: string }[] | undefined) => (ps ?? []).every((q) => q.kind === "box" || q.kind === "polygon" || q.kind === "linpoly");
  const out: { host: string; tool: string }[] = [];
  for (const part of design.parts) {
    const h = part.booleanHistory;
    if (!h || h.operation !== "insert" || (flat(h.A.primitives) && flat(h.B.primitives))) continue;
    if (design.parts.some((o) => o.name === h.B.name && o !== part)) out.push({ host: part.name, tool: h.B.name });
  }
  return out;
}

const overlaps = (a: [Vec3, Vec3], b: [Vec3, Vec3]) => [0, 1, 2].every((i) => a[0][i] <= b[1][i] + EPS && b[0][i] <= a[1][i] + EPS);

const usesParams = (S: Symbols, o: unknown): boolean =>
  typeof o === "string" ? S.isSymbolic(o) : Array.isArray(o) ? o.some((x) => usesParams(S, x)) : o && typeof o === "object" ? Object.values(o).some((x) => usesParams(S, x)) : false;

/**
 * Pairs the bundle's primitives with the design's, by part name and position, and records the CST expression of
 * every field that is a parameter expression. Only plain parts are paired (no transforms, cuts or Boolean result:
 * the bundle holds their result, not their expressions) and only when the expression's value is the number the
 * bundle holds; everything else is written as numbers, and listed in the notes.
 */
function symbolize(ctx: Ctx, d: ParametricDesign, b: Bundle) {
  const S = ctx.sym!;
  for (const bp of b.parts) {
    // a void (cut-out) part "<host> (cut)" holds the design part's void shapes; the host part holds the others
    const hostName = bp.void && bp.name.endsWith(" (cut)") ? bp.name.slice(0, -" (cut)".length) : bp.name;
    const dp = d.parts?.find((x) => x.name === hostName);
    if (!dp) continue;
    const dprims = (dp.primitives ?? []).filter((x: any) => !!x?.void === !!bp.void);
    const where = ascii(bp.name);
    if (dp.transforms?.length || dp.cuts?.length || dp.booleanHistory || dprims.length !== bp.primitives.length) {
      if (usesParams(S, dp)) S.numeric.push(`${where}: transforms, cut-outs and Boolean results are written as numbers (the bundle holds their result)`);
      continue;
    }
    bp.primitives.forEach((prim, i) => {
      const dq = dprims[i];
      const w = `${where} #${i + 1}`;
      const f = (e: unknown, want: number, what: string): E => S.field(e, want, `${w} ${what}`);
      const fv = (es: unknown, want: number[], what: string): E[] => want.map((v, k) => f(Array.isArray(es) ? es[k] : undefined, v, `${what}[${k}]`));
      let sp: SymPrim | null = null;
      if (prim.kind === "box" && dq?.kind === "box") {
        sp = { box: { start: fv(dq.start, prim.start, "start"), stop: fv(dq.stop, prim.stop, "stop") } };
      } else if ((prim.kind === "polygon" || prim.kind === "linpoly") && dq?.kind === prim.kind && "xyz".indexOf(dq.normal) === prim.normal && Array.isArray(dq.points) && dq.points.length === prim.points.length) {
        sp = { poly: {
          points: prim.points.map((pt, k) => [f(dq.points[k]?.[0], pt[0], `points[${k}][0]`), f(dq.points[k]?.[1], pt[1], `points[${k}][1]`)] as [E, E]),
          elevation: f(dq.elevation, prim.elevation, "elevation"),
          length: prim.kind === "linpoly" ? f(dq.length, prim.length ?? 0, "length") : null,
        } };
      } else if (prim.kind === "cylinder" && dq?.kind === "cylinder" && !(Number(dq.inner_radius) > 0) && Array.isArray(dq.center) && Array.isArray(dq.range) && "xyz".indexOf(dq.axis) >= 0) {
        const axis = "xyz".indexOf(dq.axis);
        const others = [0, 1, 2].filter((k) => k !== axis);
        const vs = [prim.start[axis], prim.stop[axis]].sort((x, y) => x - y);
        const r0 = S.value(dq.range[0]), r1 = S.value(dq.range[1]);
        const lowFirst = r0 !== null && r1 !== null ? r0 <= r1 : true;
        const [lo, hi] = lowFirst ? [dq.range[0], dq.range[1]] : [dq.range[1], dq.range[0]];
        // the design's centre is in CSXCAD's in-plane order (axis y: z, x); the export's is x, z
        const cen = axis === 1 ? [dq.center[1], dq.center[0]] : [dq.center[0], dq.center[1]];
        sp = { cyl: {
          radius: f(dq.radius, prim.radius, "radius"),
          range: [f(lo, vs[0], "range[0]"), f(hi, vs[1], "range[1]")],
          center: [f(cen[0], prim.start[others[0]], "center"), f(cen[1], prim.start[others[1]], "center")],
        } };
      } else if (prim.kind === "sphere" && dq?.kind === "sphere") {
        sp = { sphere: { center: fv(dq.center, prim.center, "center"), radius: f(dq.radius, prim.radius, "radius") } };
      } else if (usesParams(S, dq)) {
        S.numeric.push(`${w}: a ${ascii(String(dq?.kind))} is written as numbers (its expressions are not exported)`);
      }
      if (sp) ctx.prims.set(prim, sp);
    });
  }
}

export interface CstParameter { key: string; name: string; value: number; expression?: string }

/** Shared diagnostic identity; the dialog translates it while the macro keeps English comments. */
export const finitePortWarning = (number: number): string =>
  `port ${number}: finite-width source exported as an axial line; transverse size is not preserved. Recheck the feed model.`;

export function cstMacro(b: Bundle, opt: CstOptions = DEFAULT_CST_OPTIONS, extras: CstExtras = {}): { text: string; warnings: string[]; files: CstFile[]; parameters: CstParameter[]; notes: string[] } {
  if (opt.includePorts && b.ports.some((p) => p.group))
    throw new Error("Grouped ports cannot be exported as independent discrete ports. Export geometry without ports instead.");
  const m = new Macro();
  const ghz = (hz: number) => n(hz / 1e9);
  const { unit, scale } = lengthUnit(b);
  // ":" separates component and solid names in CST, so it cannot appear in a component name
  const comp = opt.component.replace(/[:"]/g, "_").trim() || DEFAULT_CST_OPTIONS.component;
  const ctx: Ctx = { m: new Macro(), comp, scale, unit, bbox: null, files: [], stlBase: (extras.macroBase ?? b.model.id).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "model", sym: null, prims: new Map() };
  ctx.m.warnings = m.warnings;
  const pd = extras.parametric;
  const notes: string[] = [];
  if (pd?.params?.length) {
    if (unit === "mm" && scale === 1) {
      ctx.sym = new Symbols(pd.params);
      symbolize(ctx, pd, b);
    } else notes.push(`the design's lengths are in mm but the model is exported in ${unit}: written as numbers`);
  }

  // ---- materials: unique CST names, never shadowing the built-in PEC / Vacuum
  const matNames = new Names(["PEC", "Vacuum"]);
  const matOf = new Map<string, string>();
  // a lossy metal volume is a "Material" with a conductor: a metal, not a dielectric
  const dielectrics = b.parts.filter((p) => p.type === "Material" && p.material && !p.conductor && !p.void);
  for (const p of dielectrics) matOf.set(p.name, matNames.take(safe(p.name)));
  // lossy metals (bundle parts[].conductor): one CST "Lossy metal" per conductivity
  const lossy = new Map<number, string>();
  const lossyColor = new Map<number, string>();
  for (const p of b.parts) {
    if (p.conductor && Number.isFinite(p.conductor.conductivity) && p.conductor.conductivity > 0) {
      const sigma = p.conductor.conductivity;
      if (!lossy.has(sigma)) lossy.set(sigma, matNames.take(safe(`lossy_metal_${n(sigma)}`)));
      matOf.set(p.name, lossy.get(sigma)!);
      if (p.color && !lossyColor.has(sigma)) lossyColor.set(sigma, p.color);
      if (p.conductor.thickness !== null) m.warnings.push(`${ascii(p.name)}: lossy sheet exported as a zero-thickness ${n(sigma)} S/m lossy-metal sheet (its modelled thickness ${n(p.conductor.thickness)} mm is not carried)`);
    } else if (p.type === "Metal") matOf.set(p.name, "PEC");
    else if (p.type === "ConductingSheet") {
      matOf.set(p.name, "PEC");
      m.warnings.push(`${ascii(p.name)}: conducting sheet exported as PEC (finite conductivity/thickness dropped)`);
    }
  }

  // ---- geometry first (into ctx.m), so the background spacing can use the exported extent
  const solidNames = new Names();
  const bases = b.parts.map((p) => solidNames.take(safe(p.name)));
  ctx.m.comment("geometry");
  ctx.m.history(`new component: ${comp}`, [`Component.New ${q(comp)}`]);
  let solidCount = 0;
  /** the solids each host part ended up with, with their bounding boxes (for the void Subtract) */
  const hosts = new Map<string, { solid: string; bbox: [Vec3, Vec3] }[]>();
  b.parts.forEach((part, pi) => {
    if (part.void) return; // vacuum carvers are created and subtracted after every host exists
    const mat = matOf.get(part.name);
    if (!mat) {
      if (part.primitives.length) m.warnings.push(`${ascii(part.name)}: property type '${ascii(part.type)}' has no CST equivalent, skipped`);
      return;
    }
    const base = bases[pi];
    const created: string[] = [];
    const createdBox: [Vec3, Vec3][] = [];
    part.primitives.forEach((prim, i) => {
      const solid = part.primitives.length > 1 ? solidNames.take(`${base}_${i + 1}`) : base;
      const s = primitiveCommands(ctx, prim, part, solid, mat);
      if (s) { created.push(s); createdBox.push(prim.bbox); }
    });
    solidCount += created.length;
    if (opt.mergeParts && created.length > 1) {
      // Solid.Add "comp:target", "comp:tool": the tool is united into the target, which keeps its name.
      // Coplanar zero-thickness sheets (e.g. fractal polygons + bridge patches) unite into one sheet
      // body in the CST modeller, but near-coincident edges are the most likely place for a failure.
      ctx.m.history(`boolean add shapes: ${comp}:${created[0]} (+${created.length - 1})`,
        created.slice(1).map((s) => `Solid.Add ${q(`${comp}:${created[0]}`)}, ${q(`${comp}:${s}`)}`));
    }
    if (opt.mergeParts && created.length >= 1 && created[0] !== base) {
      ctx.m.history(`rename block: ${comp}:${created[0]} to: ${comp}:${base}`, [`Solid.Rename ${q(`${comp}:${created[0]}`)}, ${q(base)}`]);
    }
    if (opt.mergeParts && created.length >= 1) {
      const lo = [0, 1, 2].map((i) => Math.min(...createdBox.map((x) => x[0][i]))) as Vec3;
      const hi = [0, 1, 2].map((i) => Math.max(...createdBox.map((x) => x[1][i]))) as Vec3;
      hosts.set(part.name, [{ solid: created[0] !== base ? base : created[0], bbox: [lo, hi] }]);
    } else hosts.set(part.name, created.map((solid, k) => ({ solid, bbox: createdBox[k] })));
  });

  // ---- void parts (vacuum carvers): a tool solid per overlapped host shape, consumed by Solid.Subtract
  b.parts.forEach((part, pi) => {
    if (!part.void) return;
    const hostName = part.name.endsWith(" (cut)") ? part.name.slice(0, -" (cut)".length) : part.name;
    const targets = hosts.get(hostName);
    if (!targets?.length) {
      m.warnings.push(`${ascii(part.name)}: void has no exported host part '${ascii(hostName)}', skipped`);
      return;
    }
    const saved = ctx.bbox ? ([[...ctx.bbox[0]], [...ctx.bbox[1]]] as [Vec3, Vec3]) : null;
    ctx.m.comment(`void: ${ascii(part.name)} subtracted from ${ascii(hostName)}`);
    for (const target of targets) {
      const tools: string[] = [];
      for (const prim of part.primitives) {
        if (!overlaps(prim.bbox, target.bbox)) continue;
        const tool = solidNames.take(`${bases[pi]}_${tools.length + 1}`);
        const s = primitiveCommands(ctx, prim, part, tool, "Vacuum");
        if (s) tools.push(s);
      }
      for (const tool of tools) {
        ctx.m.history(`boolean subtract shapes: ${comp}:${target.solid} - ${comp}:${tool}`, [
          "With Solid",
          `     .Subtract ${q(`${comp}:${target.solid}`)}, ${q(`${comp}:${tool}`)}`,
          "End With",
        ]);
      }
    }
    ctx.bbox = saved;
  });

  // ---- Boolean Insert by priority: A stays whole, B stays and is cut out of A
  for (const pair of extras.inserts ?? []) {
    const a = hosts.get(pair.host), t = hosts.get(pair.tool);
    if (!a?.length || !t?.length) continue; // B is not an exported part: skipped
    ctx.m.history(`boolean insert shapes: ${comp}:${a[0].solid}, ${comp}:${t[0].solid}`, [
      "With Solid",
      `     .Insert ${q(`${comp}:${a[0].solid}`)}, ${q(`${comp}:${t[0].solid}`)}`,
      "End With",
    ]);
  }

  // ---- header
  m.raw(`' ${ascii(b.name)}`);
  m.raw(`' CST-compatible VBA macro generated by Fairbeam ${ascii(APP_VERSION)} from an openEMS project`);
  m.raw(`' model: ${ascii(b.model.id)}   created: ${ascii(b.created)}`);
  m.raw("'");
  m.raw("' Run in CST: Home > Macros > Run Macro... (a new, empty 3D project is recommended).");
  m.raw("' Every step is added to the history list, so the model can be edited and rebuilt in CST.");
  m.raw("' Please report anything that fails to rebuild.");
  m.raw("'");
  m.raw(`' Exported openEMS mesh lines: X=${b.mesh.x.length}, Y=${b.mesh.y.length}, Z=${b.mesh.z.length}.`);
  m.raw("' CST uses its own mesh; these line counts do not imply mesh or result parity.");
  m.raw("'");
  m.raw("' Comments starting with 'fairbeam-data:' carry the exact openEMS ports, boundaries and mesh");
  m.raw("' settings for Fairbeam's CST macro import; CST ignores them.");
  m.raw("");
  m.raw("Option Explicit");
  if (ctx.files.length) {
    m.raw("");
    m.raw(`' Polyhedra (${ctx.files.length}) are imported from the .stl files written next to this macro.`);
    m.raw(`' Set ${STL_FOLDER_CONST} to the folder that holds them (end it with a backslash or not). Left empty, the macro`);
    m.raw("' looks in the folder of the current CST project (GetProjectPath(\"Root\")) and, if the files are not");
    m.raw("' there, asks for the folder.");
    m.raw(`Const ${STL_FOLDER_CONST} As String = ""`);
  }
  m.raw("");
  m.raw("Sub Main ()");
  m.raw("    Dim sCommand As String");
  if (ctx.files.length) {
    m.raw("    Dim sStlDir As String");
    m.raw("    ' fairbeam-helper: begin");
    m.raw(`    sStlDir = FairbeamStlFolder(${q(ctx.files[0].name)})`);
    m.raw('    If sStlDir = "" Then');
    m.raw('        MsgBox "The .stl files exported with this macro were not found. Put them in one folder and set ' + STL_FOLDER_CONST + ' at the top of the macro to it.", vbExclamation, "Fairbeam"');
    m.raw("        Exit Sub");
    m.raw("    End If");
    m.raw("    ' fairbeam-helper: end");
  }
  m.raw("");

  m.comment("units and frequency range");
  if (scale !== 1) m.comment(`drawing unit ${b.units.length} rescaled to mm (x${n(scale)})`);
  // SetUnit is the CST 2020+ form; older releases record .Geometry/.Frequency/.Time instead.
  m.history("Fairbeam: units", [
    "With Units",
    `     .SetUnit "Length", ${q(unit)}`,
    '     .SetUnit "Frequency", "GHz"',
    '     .SetUnit "Time", "ns"',
    // stated, not left to the project defaults: lumped L and C below are written in nH and pF
    '     .SetUnit "Inductance", "nH"',
    '     .SetUnit "Capacitance", "pF"',
    "End With",
  ]);
  const parameters: CstParameter[] = [];
  const S = ctx.sym;
  if (S) {
    // the design's parameters. A history that CST rebuilds may not StoreParameter (CST refuses it with a warning on every
    // rebuild); MakeSureParameterExists is the command CST names for creating a parameter inside the history
    const lines: string[] = [];
    for (const p of S.params) {
      const name = S.names.get(p.key)!;
      const value = S.values[p.key];
      if (value === undefined) {
        S.numeric.push(`parameter ${p.key}: its value cannot be evaluated, not exported`);
        continue;
      }
      let expression: string | undefined;
      if (p.expr !== undefined) {
        const t = S.text(p.expr);
        if ("s" in t) expression = t.s;
        else S.numeric.push(`parameter ${p.key} = ${p.expr} (${t.why}): stored as its value ${n(value)}`);
      }
      lines.push(`MakeSureParameterExists ${q(name)}, ${q(expression ?? n(value))}`);
      const desc = ascii(p.description || p.label || "");
      if (desc && desc !== p.key) lines.push(`SetParameterDescription ${q(name)}, ${q(desc)}`);
      parameters.push({ key: p.key, name, value, ...(expression ? { expression } : {}) });
    }
    if (lines.length) {
      m.comment(`parameters of the design (CST Parameter List): ${parameters.length}`);
      for (const pr of parameters) if (pr.name !== pr.key) m.comment(`design parameter ${pr.key} is the CST parameter ${pr.name}`);
      m.history("Fairbeam: parameters", lines);
    }
  }
  const fmin = b.solver.excitation.f_min;
  const fmax = b.solver.excitation.f_max;
  if (finite(fmin, fmax) && fmax > fmin) {
    const fE = (e: unknown, want: number, what: string) => (S ? S.field(e, want, `frequency range ${what}`) : null);
    const loE = fE(pd?.simulation?.f_min, Math.max(0, fmin) / 1e9, "f_min");
    const hiE = fE(pd?.simulation?.f_max, fmax / 1e9, "f_max");
    m.history("Fairbeam: frequency range", [`Solver.FrequencyRange ${q(loE ?? ghz(Math.max(0, fmin)))}, ${q(hiE ?? ghz(fmax))}`]);
  } else m.warnings.push("invalid excitation frequency range, CST frequency range not set");

  // CST includes exported port endpoints in its structure box. Count only ports that the
  // emission below accepts, and use the actual line / waveguide plane rather than probe boxes.
  if (opt.includePorts) {
    const used = new Set<number>();
    for (const p of b.ports) {
      if (used.has(p.number)) continue;
      if (p.type === "waveguide") {
        const k = "xyz".indexOf(p.direction), u = (k + 1) % 3, v = (k + 2) % 3;
        if (k < 0 || !finite(...p.start, ...p.stop) || Math.abs(p.stop[u] - p.start[u]) <= EPS || Math.abs(p.stop[v] - p.start[v]) <= EPS) continue;
        const lo = p.start.map((x, i) => i === k ? x : Math.min(x, p.stop[i]));
        const hi = p.start.map((x, i) => i === k ? x : Math.max(x, p.stop[i]));
        grow(ctx, lo, hi);
      } else {
        if (!finite(...p.start, ...p.stop, p.R) || !(Math.hypot(...p.stop.map((v, i) => v - p.start[i])) > EPS)) continue;
        const [a, z] = axisLine(p.start, p.stop, p.direction);
        grow(ctx, a, a); grow(ctx, z, z);
      }
      used.add(p.number);
    }
  }
  m.comment("background and boundaries");
  const bc = b.solver.boundaries;
  const kinds = FACES.map((f) => boundaryCst(bc[f], f, m));
  // Open faces get their space from "expanded open". A closed (electric/magnetic) face sits on the
  // structure bounding box, including ports, so it is pushed out to where openEMS put that wall
  // (e.g. the PEC ground plane of a monopole fed from z=0 while the radiator starts higher up).
  const space = FACES.map((_, k) => {
    if (kinds[k] === "expanded open" || !ctx.bbox || !b.domain) return 0;
    const ax = k >> 1;
    const d = k % 2 === 0 ? ctx.bbox[0][ax] - b.domain.min[ax] : b.domain.max[ax] - ctx.bbox[1][ax];
    if (!Number.isFinite(d)) return 0;
    if (d < -EPS) m.warnings.push(`boundary ${FACES[k]}: structure extends beyond the openEMS domain`);
    return Math.max(0, d);
  });
  m.history("Fairbeam: background", [
    "With Background",
    "     .ResetBackground",
    '     .Type "Normal"',
    '     .Epsilon "1.0"',
    '     .Mu "1.0"',
    ...FACE_CST.map((f, k) => `     .${f}Space ${q(c(ctx, space[k]))}`),
    '     .ApplyInAllDirections "False"',
    "End With",
  ]);
  data(m, { unit_m: b.units?.length_m ?? 1e-3, boundaries: Object.fromEntries(FACES.map((f) => [f, ascii(String(bc[f] ?? "MUR"))])) });
  // the automatic mesh's settings (CST meshes its own way; the import restores the openEMS mesh)
  const auto = b.mesh?.auto?.settings;
  // the mesh lines themselves: exact for a manual mesh (e.g. a converted example's own lines), else
  // as rounded in the bundle (the import snaps them back onto the ports). The import keeps the
  // automatic settings below only when they rebuild these lines; a Python model's own mesh rules
  // don't, and a re-fitted mesh can be many times larger or coarser than the model's. In pieces of
  // MESH_LINES_PER_RECORD per comment (the import joins them): a VBA line stays well under the
  // editors' line length limit (1023 characters in the VBA editor)
  if (auto?.mode === "manual" || b.mesh?.x?.length) {
    const manual = auto?.mode === "manual" && typeof auto.lines === "object" ? auto.lines : null;
    const lines: Partial<Record<"x" | "y" | "z", unknown[]>> = manual || { x: b.mesh.x, y: b.mesh.y, z: b.mesh.z };
    for (const a of ["x", "y", "z"] as const) {
      const vals = lines[a] ?? [];
      for (let i = 0; i < vals.length; i += MESH_LINES_PER_RECORD) data(m, { mesh_lines: { [a]: vals.slice(i, i + MESH_LINES_PER_RECORD) } });
    }
  }
  if (auto && auto.mode !== "manual") {
    const keys = ["cells_per_wavelength", "air_cells_per_wavelength", "pad", "edge_rule", "max_ratio", "dielectric_cells", "metal_cells"];
    const mesh = Object.fromEntries(keys.filter((k) => auto[k] !== undefined && auto[k] !== null).map((k) => [k, auto[k]]));
    if (Object.keys(mesh).length) data(m, { mesh });
  }
  m.history("Fairbeam: boundaries", [
    "With Boundary",
    ...FACE_CST.map((f, k) => `     .${f} ${q(kinds[k])}`),
    '     .Xsymmetry "none"',
    '     .Ysymmetry "none"',
    '     .Zsymmetry "none"',
    "End With",
  ]);

  if (dielectrics.length) m.comment("materials (openEMS loss = constant conductivity, exported as Sigma)");
  for (const p of dielectrics) {
    const mat = p.material!;
    const name = matOf.get(p.name)!;
    if (!finite(mat.eps_r, mat.kappa ?? 0, mat.mu_r || 1)) {
      m.warnings.push(`${ascii(p.name)}: non-finite material data, using vacuum values`);
    }
    const eps = Number.isFinite(mat.eps_r) ? mat.eps_r : 1;
    const mu = Number.isFinite(mat.mu_r) && mat.mu_r ? mat.mu_r : 1;
    const kappa = Number.isFinite(mat.kappa) ? mat.kappa : 0;
    if (mat.isotropic === false) m.warnings.push(`${ascii(p.name)}: anisotropic material exported as an isotropic one with the x component of its permittivity and conductivity (CST anisotropic tensors are not written)`);
    if (mat.dispersion) m.warnings.push(`${ascii(p.name)}: frequency-dependent (${ascii(String(mat.dispersion.model))}) material exported with its constant values${mat.tan_d_freq ? ` at ${ghz(mat.tan_d_freq)} GHz` : ""} (eps_r, and the loss as Sigma); its poles are not written`);
    const [r, g, bl] = rgb(p.color ?? "#6f9a7e");
    const dpart = pd?.parts?.find((x) => x.name === p.name);
    const dmat = pd?.materials?.find((x) => x.name === dpart?.material);
    const epsE = S && dmat ? S.field(dmat.eps_r, eps, `material ${ascii(p.name)} eps_r`) : null;
    if (epsE && kappa > 0) S!.numeric.push(`material ${ascii(p.name)}: the loss (Sigma ${n(kappa)} S/m, from tan d) stays a number while eps_r follows the parameters`);
    // Folder "" keeps the plain name: a material inside a folder is referenced as "folder/name".
    // .Sigma is what CST 2019+ records (older releases: .Kappa).
    const body = [
      "With Material",
      "     .Reset",
      `     .Name ${q(name)}`,
      '     .Folder ""',
      '     .FrqType "all"',
      '     .Type "Normal"',
      `     .SetMaterialUnit "GHz", ${q(unit)}`,
      `     .Epsilon ${q(epsE ?? n(eps))}`,
      `     .Mu ${q(n(mu))}`,
      `     .Sigma ${q(n(kappa))}`,
      '     .TanDGiven "False"',
      `     .Colour ${q(r)}, ${q(g)}, ${q(bl)}`,
      "     .Create",
      "End With",
    ];
    if (mat.tan_d !== null && mat.tan_d_freq) m.comment(`${p.name}: equivalent tan d = ${mat.tan_d} at ${ghz(mat.tan_d_freq)} GHz`);
    m.history(`define material: ${name}`, body);
  }
  if (lossy.size) m.comment("lossy metals (finite conductivity)");
  for (const [sigma, name] of lossy) {
    const [lr, lg, lb] = lossyColor.has(sigma) ? rgb(lossyColor.get(sigma)!) : ["0.8", "0.5", "0.2"];
    m.history(`define material: ${name}`, [
      "With Material",
      "     .Reset",
      `     .Name ${q(name)}`,
      '     .Folder ""',
      '     .FrqType "all"',
      '     .Type "Lossy metal"',
      `     .SetMaterialUnit "GHz", ${q(unit)}`,
      '     .Mu "1"',
      `     .Sigma ${q(n(sigma))}`,
      `     .Colour ${q(lr)}, ${q(lg)}, ${q(lb)}`,
      "     .Create",
      "End With",
    ]);
  }

  m.lines.push(...ctx.m.lines);
  if (!solidCount) m.warnings.push("no exportable geometry");

  if (opt.includePorts && b.ports.length) {
    m.comment("ports (openEMS lumped port -> CST discrete S-parameter port; P1/P2 lie on the port axis)");
    const portNos = new Set<number>();
    for (const p of b.ports) {
      if (p.type === "waveguide") {
        if (finite(...p.start, ...p.stop, p.a ?? NaN, p.b ?? NaN)) {
          data(m, { port: p.number, type: "waveguide", mode: p.mode ?? "TE10", a: p.a, b: p.b, start: p.start, stop: p.stop, direction: p.direction, ...(p.excite === false ? { excite: false } : {}) });
        }
        const k = "xyz".indexOf(p.direction);
        const u = (k + 1) % 3, v = (k + 2) % 3;
        const ok = k >= 0 && finite(...p.start, ...p.stop) && Math.abs(p.stop[u] - p.start[u]) > EPS && Math.abs(p.stop[v] - p.start[v]) > EPS && !portNos.has(p.number);
        if (!ok) {
          m.warnings.push(`port ${p.number}: ${p.mode ?? "TE"} waveguide port skipped (invalid cross-section, direction or duplicate number)`);
          continue;
        }
        portNos.add(p.number);
        const rng = [0, 1, 2].map((i) => (i === k ? [p.start[k], p.start[k]] : [Math.min(p.start[i], p.stop[i]), Math.max(p.start[i], p.stop[i])]));
        // the port feeds along +direction when the probes (stop) lie above the excitation plane (start)
        const orient = `${p.direction}${p.stop[k] >= p.start[k] ? "min" : "max"}`;
        if (!/^TE10$/i.test(p.mode ?? "TE10")) m.warnings.push(`port ${p.number}: mode ${ascii(p.mode ?? "")} requested; the CST waveguide port is exported with 1 mode, which CST calculates itself from the cross-section (mode 1 of a rectangular guide is TE10)`);
        m.history(`define waveguide port: ${p.number}`, [
          "With Port",
          "     .Reset",
          `     .PortNumber ${q(String(p.number))}`,
          '     .Label ""',
          '     .NumberOfModes "1"',
          `     .Orientation ${q(orient)}`,
          '     .Coordinates "Free"',
          ...(["X", "Y", "Z"] as const).map((a, i) => `     .${a}range ${q(c(ctx, rng[i][0]))}, ${q(c(ctx, rng[i][1]))}`),
          '     .PortOnBound "False"',
          '     .ClipPickedPortToBound "False"',
          "     .Create",
          "End With",
        ]);
        continue;
      }
      const len = Math.hypot(...p.stop.map((v, i) => v - p.start[i]));
      if (!finite(...p.start, ...p.stop, p.R) || !(len > EPS) || portNos.has(p.number)) {
        m.warnings.push(`port ${p.number}: skipped (zero length, invalid data or duplicate number)`);
        continue;
      }
      portNos.add(p.number);
      // the end points over the parameters: along the port the design's start / stop, across it their middle
      const dport = S ? pd?.ports?.find((x) => x.number === p.number && x.type !== "waveguide") : undefined;
      const k = "xyz".indexOf(p.direction);
      if (p.start.some((v, i) => i !== k && Math.abs(p.stop[i] - v) > EPS))
        m.warnings.push(finitePortWarning(p.number));
      const pe = (arr: unknown[] | undefined, v: Vec3, w: string): E[] => [0, 1, 2].map((i) => (S ? S.field(arr?.[i], v[i], `port ${p.number} ${w}[${i}]`) : null));
      const sE = dport ? pe(dport.start, p.start, "start") : [null, null, null];
      const tE = dport ? pe(dport.stop, p.stop, "stop") : [null, null, null];
      const [a1] = axisLine(p.start, p.stop, p.direction);
      const mid = (i: number): string => {
        if (!sE[i] && !tE[i]) return c(ctx, a1[i]);
        if (sE[i] && sE[i] === tE[i]) return sE[i]!;
        return `(${cx(ctx, p.start[i], sE[i])} + ${cx(ctx, p.stop[i], tE[i])})/2`;
      };
      const end1 = [0, 1, 2].map((i) => (i === k ? cx(ctx, p.start[i], sE[i]) : mid(i)));
      const end2 = [0, 1, 2].map((i) => (i === k ? cx(ctx, p.stop[i], tE[i]) : mid(i)));
      const rE = S && dport ? S.field(dport.R, p.R, `port ${p.number} R`) : null;
      m.history(`define discrete port: ${p.number}`, [
        "With DiscretePort",
        "     .Reset",
        `     .PortNumber ${q(String(p.number))}`,
        '     .Type "SParameter"',
        '     .Label ""',
        `     .Impedance ${q(rE ?? n(p.R))}`,
        '     .Voltage "1"',
        '     .Current "1"',
        `     .SetP1 "False", ${end1.map((v) => q(v)).join(", ")}`,
        `     .SetP2 "False", ${end2.map((v) => q(v)).join(", ")}`,
        '     .InvertDirection "False"',
        '     .LocalCoordinates "False"',
        '     .Monitor "True"',
        '     .Radius "0.0"',
        '     .Wire ""',
        '     .Position "end1"',
        "     .Create",
        "End With",
      ]);
      data(m, { port: p.number, type: "lumped", R: p.R, start: p.start, stop: p.stop, direction: p.direction, ...(p.excite === false ? { excite: false } : {}) });
    }
  }

  // lumped elements that are not ports (openEMS LumpedElement: R, L, C; series or parallel) -> CST lumped element
  for (const e of b.lumped_elements ?? []) {
    if (!opt.includePorts) break;
    const len = Math.hypot(...e.stop.map((v, i) => v - e.start[i]));
    const vals = { R: e.R, L: e.L, C: e.C };
    const given = (["R", "L", "C"] as const).filter((k) => vals[k] !== undefined && vals[k] !== null);
    const sane = given.length > 0 && given.every((k) => Number.isFinite(vals[k]!) && vals[k]! >= 0) && given.some((k) => vals[k]! > 0);
    if ((e.type !== "resistor" && e.type !== "rlc") || !finite(...e.start, ...e.stop) || !sane || !(len > EPS)) {
      m.warnings.push(`lumped element ${ascii(e.name)}: skipped (unsupported type or invalid data)`);
      continue;
    }
    const series = e.type === "resistor" || e.topology === "series";
    const [p1, p2] = axisLine(e.start, e.stop, e.direction);
    // CST: a zero R, L or C of a circuit is a missing component
    m.history(`define lumped element: ${ascii(e.name)}`, [
      "With LumpedElement",
      "     .Reset",
      `     .SetName ${q(ascii(e.name))}`,
      '     .Folder ""',
      `     .SetType ${q(series ? "RLCSerial" : "RLCParallel")}`,
      `     .SetR ${q(n(e.R ?? 0))}`,
      // the Units block sets nH and pF; the design holds henries and farads
      `     .SetL ${q(n((e.L ?? 0) * 1e9))}`,
      `     .SetC ${q(n((e.C ?? 0) * 1e12))}`,
      `     .SetP1 "False", ${p1.map((v) => q(c(ctx, v))).join(", ")}`,
      `     .SetP2 "False", ${p2.map((v) => q(c(ctx, v))).join(", ")}`,
      '     .SetInvert "False"',
      '     .SetMonitor "True"',
      '     .SetRadius "0.0"',
      '     .Wire ""',
      '     .Position "end1"',
      "     .Create",
      "End With",
    ]);
    if (e.type === "resistor") data(m, { resistor: ascii(e.name), R: e.R, start: e.start, stop: e.stop, direction: e.direction });
    else data(m, { rlc: ascii(e.name), R: e.R, L: e.L, C: e.C, topology: series ? "series" : "parallel", start: e.start, stop: e.stop, direction: e.direction });
    m.warnings.push(`lumped element ${ascii(e.name)}: exported as a CST ${series ? "series" : "parallel"} RLC element (${given.map((k) => `${k} = ${n(vals[k]!)}`).join(", ")}; a zero value is an absent component); openEMS spreads it over a sheet, CST uses a line`);
  }

  const ffs = b.results?.farfield ?? [];
  // a model with a far-field box but no analysed pattern yet (a design's preview): the import turns
  // the far field on again
  if (b.nf2ff_box && !ffs.length) data(m, { far_field: true });
  if (opt.farfieldMonitors && ffs.length) {
    m.comment("far-field monitors at the frequencies analysed in Fairbeam");
    const seen = new Set<string>();
    for (const f of ffs) {
      if (!Number.isFinite(f.f) || f.f <= 0) continue;
      const v = n(Number((f.f / 1e9).toFixed(4)));
      if (seen.has(v)) continue; // identical monitor names would fail
      seen.add(v);
      // .MonitorValue is the current form (.Frequency is the pre-2010 alias).
      m.history(`define farfield monitor: farfield (f=${v})`, [
        "With Monitor",
        "     .Reset",
        `     .Name ${q(`farfield (f=${v})`)}`,
        '     .Domain "Frequency"',
        '     .FieldType "Farfield"',
        `     .MonitorValue ${q(v)}`,
        '     .ExportFarfieldSource "False"',
        '     .UseSubvolume "False"',
        "     .Create",
        "End With",
      ]);
    }
  }

  if (opt.solverSettings) {
    m.comment("time-domain solver: steady-state limit mirrors the openEMS end criterion");
    m.history("Fairbeam: solver type", ['ChangeSolverType "HF Time Domain"']);
    const limit = Number.isFinite(b.solver.end_criteria_db) ? b.solver.end_criteria_db : -40;
    m.history("Fairbeam: time domain solver", ["With Solver", `     .SteadyStateLimit ${q(n(limit))}`, "End With"]);
  }

  for (const w of m.warnings) m.comment(`WARNING: ${w}`);
  m.raw("End Sub");
  if (ctx.files.length) {
    for (const l of [
      "",
      "' fairbeam-helper: begin",
      "' Folder of the companion .stl files, with a trailing backslash; empty if sProbe is not found in it.",
      "Function FairbeamStlFolder(sProbe As String) As String",
      "    Dim sDir As String",
      `    sDir = ${STL_FOLDER_CONST}`,
      '    If sDir = "" Then sDir = GetProjectPath("Root")',
      '    If sDir <> "" And Right(sDir, 1) <> "\\" Then sDir = sDir + "\\"',
      '    If sDir = "" Or Dir(sDir + sProbe) = "" Then',
      '        sDir = InputBox("Folder with the .stl files that belong to this macro:", "Fairbeam", sDir)',
      '        If sDir <> "" And Right(sDir, 1) <> "\\" Then sDir = sDir + "\\"',
      "    End If",
      '    If Dir(sDir + sProbe) = "" Then sDir = ""',
      "    FairbeamStlFolder = sDir",
      "End Function",
      "' fairbeam-helper: end",
    ]) m.raw(l);
  }
  if (S) {
    notes.push(...S.numeric);
    // the report goes into the macro as comments, after the header
    const at = m.lines.findIndex((l) => l === "Option Explicit");
    const info = [`' Parametric export: ${parameters.length} design parameter(s) are CST parameters (Parameter List) and ${S.expressions} geometry field(s) are expressions over them.`,
      ...(notes.length ? [`' Written as numbers (${notes.length}):`, ...notes.map((x) => `'   ${ascii(x)}`)] : []), "'"];
    if (at > 0) m.lines.splice(at, 0, ...info);
  }
  return { text: m.lines.join("\r\n") + "\r\n", warnings: m.warnings, files: ctx.files, parameters, notes };
}
