import { withoutVoids } from "../lib/voidParts.ts";
import { lumpedLabel } from "../lumped.ts";
// Fabrication model of a printed design: dielectric stack, copper layers (merged outlines per
// layer), board outline, drill hits (probe feeds, vias), edge-launch ports and lumped parts.
// Pure TS (Node + browser). Units: mm.
//
// Rules
// - Dielectric slabs: Material boxes (or z-extruded polygons) with a z extent.
// - Copper: horizontal metal sheets (zero-thickness boxes, z-normal polygons, or metal thinner
//   than 0.1 mm) lying on a slab face. Top-most face = F_Cu (L1), bottom-most = B_Cu, faces in
//   between = In1_Cu, In2_Cu, … from the top.
// - Drills: z-directed ports with no in-plane extent that cross a slab (probe feeds → plated hole
//   with a clearance ring in the copper at the lower end), metal z-cylinders (and tubes) crossing a slab
//   (vias, plated, their own diameter).
// - Anything else (vertical sheets, bulky metal, metal in the air) is not a board feature: skipped
//   with a warning, and when no copper is left the export is unavailable with the reason.

import type { Bundle, Primitive, Vec3, Matrix4Rows, CylinderPrim, ShellPrim } from "../types";
import { portFeedEntries } from "../lib/portGroups.ts";
import { area, bboxOf, isRectilinear, overlaps, rectilinearUnion, snap, toRegions, ccw, type Region, type Ring } from "./polygon.ts";

export interface FabOptions {
  /** probe-feed drill diameter (mm); 1.3 fits an SMA centre pin (1.27 mm) */
  probeDrillMm: number;
  /** clearance (anti-pad) diameter around probe holes in the lower copper (mm); ≈ SMA PTFE 4.1 mm */
  antipadMm: number;
  /** copper thickness assumed for fabrication (µm); the simulation used zero-thickness PEC */
  copperUm: number;
}

export const DEFAULT_FAB_OPTIONS: FabOptions = { probeDrillMm: 1.3, antipadMm: 4.2, copperUm: 35 };

export interface Slab {
  name: string;
  epsR: number | null;
  tanD: number | null;
  z0: number;
  z1: number;
  outline: Ring;
}

export interface CopperLayer {
  /** KiCad-style name: F_Cu, In1_Cu, …, B_Cu */
  name: string;
  /** 1-based index from the top, and the X2 position keyword */
  index: number;
  side: "Top" | "Inr" | "Bot";
  z: number;
  regions: Region[];
  /** clearance circles cut into this layer (anti-pads) */
  clearances: { x: number; y: number; d: number }[];
  parts: string[];
  /** true when overlapping non-rectilinear shapes were kept as separate (overlapping) regions */
  overlapping: boolean;
}

export interface Drill {
  x: number;
  y: number;
  d: number;
  plated: boolean;
  kind: "probe" | "via";
  port?: number;
  from: string;
  to: string;
}

export interface EdgePort {
  number: number;
  R: number;
  x: number;
  y: number;
  width: number;
  layer: string;
  edge: "left" | "right" | "bottom" | "top";
}

export interface FabModel {
  available: boolean;
  reason: string | null;
  warnings: string[];
  notes: string[];
  slabs: Slab[];
  outline: Region[];
  board: [number, number, number, number];
  layers: CopperLayer[];
  drills: Drill[];
  edgePorts: EdgePort[];
  components: { label: string; type: string; value: string; x: number; y: number; layer: string; span: number }[];
  options: FabOptions;
}

const THIN = 0.1; // mm: metal thinner than this counts as a copper sheet
const TOL = 1e-4; // mm: z matching tolerance

function lo3(p: { start: Vec3; stop: Vec3 }): Vec3 {
  return p.start.map((v, i) => Math.min(v, p.stop[i])) as Vec3;
}
function hi3(p: { start: Vec3; stop: Vec3 }): Vec3 {
  return p.start.map((v, i) => Math.max(v, p.stop[i])) as Vec3;
}
const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const mappedPoint = (m: Matrix4Rows, p: Vec3): Vec3 => m.slice(0, 3).map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + r[3]) as Vec3;

/** A rotated circular via is still a via when its world axis is vertical. */
function drillPrimitive(q: Primitive): CylinderPrim | ShellPrim | null {
  if (q.kind === "cylinder" || q.kind === "cylindricalshell") return q;
  if (q.kind !== "transformed" || (q.primitive.kind !== "cylinder" && q.primitive.kind !== "cylindricalshell")) return null;
  const p = q.primitive, m = q.matrix;
  const columns = [0, 1, 2].map((k) => [m[0][k], m[1][k], m[2][k]]);
  const lengths = columns.map((c) => Math.hypot(...c)), s = lengths[0];
  if (!(s > 0) || lengths.some((x) => Math.abs(x - s) > 1e-9 * s)
    || columns.some((a, i) => columns.some((b, j) => i !== j && Math.abs(a.reduce((v, x, k) => v + x * b[k], 0)) > 1e-9 * s * s))) return null;
  const common = { ...p, start: mappedPoint(m, p.start), stop: mappedPoint(m, p.stop), radius: p.radius * s, bbox: q.bbox };
  return p.kind === "cylinder" ? common as CylinderPrim : { ...common, shell_width: p.shell_width * s } as ShellPrim;
}

/** Footprint (xy ring) and z range of a primitive, or null if it is not z-aligned planar/prismatic. */
function footprint(q: Primitive, scale: number): { ring: Ring; z0: number; z1: number } | null {
  if (q.kind === "transformed") {
    const m = q.matrix;
    const tolerance = 1e-10 * Math.max(1, ...m.slice(0, 3).flatMap((r) => r.slice(0, 3).map(Math.abs)));
    // Fabrication is planar. Keep exact arbitrary in-plane rotations, but reject tilted boards.
    if ([m[0][2], m[1][2], m[2][0], m[2][1]].some((x) => Math.abs(x) > tolerance)) return null;
    const local = footprint(q.primitive, 1);
    if (!local) return null;
    const ring = ccw(local.ring.map(([x, y]) => {
      const point = mappedPoint(m, [x, y, local.z0]);
      return [point[0] * scale, point[1] * scale];
    }));
    const zs = [local.z0, local.z1].map((z) => (m[2][2] * z + m[2][3]) * scale);
    return Math.abs(area(ring)) > 1e-12 ? { ring, z0: Math.min(...zs), z1: Math.max(...zs) } : null;
  }
  if (q.kind === "box") {
    const a = lo3(q), b = hi3(q);
    if (b[0] - a[0] < 1e-12 || b[1] - a[1] < 1e-12) return null; // vertical sheet
    return { ring: rect(a[0] * scale, a[1] * scale, b[0] * scale, b[1] * scale), z0: a[2] * scale, z1: b[2] * scale };
  }
  if ((q.kind === "polygon" || q.kind === "linpoly") && q.normal === 2) {
    const len = q.kind === "linpoly" ? q.length ?? 0 : 0;
    const ring = ccw(q.points.map(([a, b]) => [a * scale, b * scale]));
    const z0 = Math.min(q.elevation, q.elevation + len) * scale;
    const z1 = Math.max(q.elevation, q.elevation + len) * scale;
    return Math.abs(area(ring)) > 1e-12 ? { ring, z0, z1 } : null;
  }
  return null;
}

/** Union of rings: exact for rectilinear input; non-rectilinear rings that overlap anything are
 * kept as separate regions (Gerber unions overlapping dark regions; the flag goes into notes). */
function mergeRings(rings: Ring[]): { regions: Region[]; overlapping: boolean } {
  const rect = rings.filter(isRectilinear);
  const other = rings.filter((r) => !isRectilinear(r));
  const regions = rectilinearUnion(rect);
  let overlapping = false;
  const kept: Ring[] = [];
  for (const r of other) {
    const hits = [...rect, ...other.filter((o) => o !== r)].some((o) => overlaps(r, o));
    if (hits) overlapping = true;
    kept.push(r.map(([x, y]) => [snap(x), snap(y)] as [number, number]));
  }
  // non-overlapping extras are plain regions; overlapping ones too (Gerber semantics union them)
  regions.push(...toRegions(kept.map(ccw)).map((g) => ({ ...g, depth: 0 })));
  return { regions, overlapping };
}

export function fabModel(bundle: Bundle, opt: Partial<FabOptions> = {}): FabModel {
  const b = withoutVoids(bundle);
  const options = { ...DEFAULT_FAB_OPTIONS, ...opt };
  const warnings: string[] = [];
  const notes: string[] = [];
  const scale = (b.units?.length_m ?? 1e-3) / 1e-3;
  const fail = (reason: string): FabModel => ({
    available: false, reason, warnings, notes, slabs: [], outline: [], board: [0, 0, 0, 0], layers: [], drills: [], edgePorts: [], components: [], options,
  });

  // --- dielectric slabs
  const slabs: Slab[] = [];
  for (const p of b.parts) {
    if (p.type !== "Material" || !p.material) continue;
    for (const q of p.primitives) {
      const f = footprint(q, scale);
      if (!f || f.z1 - f.z0 < 1e-6) continue;
      slabs.push({ name: p.label ?? p.name, epsR: p.material.eps_r, tanD: p.material.tan_d, z0: f.z0, z1: f.z1, outline: f.ring });
    }
  }
  const metals = b.parts.filter((p) => p.type === "Metal" || p.type === "ConductingSheet");
  if (!slabs.length) {
    if (b.parts.some((p) => p.type === "Material" && p.material && p.primitives.some((q) => q.kind === "transformed")))
      return fail("The transformed substrate is not parallel to the XY fabrication plane. Orient the board in XY before exporting fabrication files.");
    return fail(
      metals.length
        ? `No dielectric substrate: ${b.half_space ? "metal over an infinite PEC ground" : "metal in free space"} (${metals.map((m) => m.label ?? m.name).join(", ")}) is not a printed circuit board, so there is nothing to etch.`
        : "The design has no substrate and no metal.",
    );
  }
  const faces = [...new Set(slabs.flatMap((s) => [snap(s.z0), snap(s.z1)]))].sort((x, y) => x - y);
  const top = faces[faces.length - 1];
  const bottom = faces[0];
  const faceOf = (z: number) => faces.find((f) => Math.abs(f - z) <= TOL);

  // --- copper sheets per face
  const byFace = new Map<number, { rings: Ring[]; parts: Set<string> }>();
  for (const p of metals) {
    let used = 0;
    for (const q of p.primitives) {
      const f = footprint(q, scale);
      if (!f) {
        if (q.kind === "sphere") warnings.push(`${p.label ?? p.name}: a sphere is neither a copper layer nor a drill; skipped`);
        else if (q.kind === "rotpoly") warnings.push(`${p.label ?? p.name}: a cone or torus (solid of revolution) is neither a copper layer nor a drill; skipped`);
        else if (q.kind === "wire" || q.kind === "curve") warnings.push(`${p.label ?? p.name}: a thin wire is neither a copper layer nor a drill; skipped`);
        else if (!drillPrimitive(q)) warnings.push(`${p.label ?? p.name}: a ${q.kind} that is not parallel to the board is skipped (not a copper layer)`);
        continue;
      }
      let z: number | undefined;
      if (f.z1 - f.z0 <= THIN) z = faceOf(f.z0) ?? faceOf(f.z1);
      else {
        warnings.push(`${p.label ?? p.name}: metal ${(f.z1 - f.z0).toFixed(3)} mm thick is not a copper sheet; skipped`);
        continue;
      }
      if (z === undefined) {
        warnings.push(`${p.label ?? p.name}: sheet at z = ${f.z0.toFixed(3)} mm is not on a substrate face (air gap?); skipped`);
        continue;
      }
      const e = byFace.get(z) ?? byFace.set(z, { rings: [], parts: new Set() }).get(z)!;
      e.rings.push(f.ring);
      e.parts.add(p.label ?? p.name);
      used++;
    }
    if (!used && p.primitives.length) warnings.push(`${p.label ?? p.name}: no planar copper on the board`);
  }
  if (!byFace.size) return fail("No metal lies flat on the substrate faces, so there is no copper to etch. " + warnings.join(" "));
  if (b.half_space && Math.abs(b.half_space.position * scale - bottom) <= TOL && !byFace.has(bottom)) {
    notes.push("The ground is an infinite PEC boundary in the simulation: no bottom copper is exported. Add a ground plane (and a finite-ground check) before fabricating.");
  }

  const zs = [...byFace.keys()].sort((x, y) => y - x); // top first
  const layers: CopperLayer[] = zs.map((z, i) => {
    const e = byFace.get(z)!;
    const m = mergeRings(e.rings);
    const isTop = Math.abs(z - top) <= TOL;
    const isBot = Math.abs(z - bottom) <= TOL;
    const name = isTop ? "F_Cu" : isBot ? "B_Cu" : `In${i}_Cu`;
    if (m.overlapping) notes.push(`${name}: overlapping non-rectilinear shapes are written as separate overlapping regions (a Gerber viewer shows their union).`);
    return { name, index: i + 1, side: isTop ? "Top" : isBot ? "Bot" : "Inr", z, regions: m.regions, clearances: [], parts: [...e.parts], overlapping: m.overlapping };
  });
  const layerAt = (z: number) => layers.find((l) => Math.abs(l.z - z) <= TOL);

  // --- board outline: union of the slab footprints
  const outline = mergeRings(slabs.map((s) => s.outline)).regions;
  const board = bboxOf(outline.map((g) => g.outer));

  // --- drills and edge ports
  const drills: Drill[] = [];
  const edgePorts: EdgePort[] = [];
  for (const [, feed] of b.ports.flatMap((port) => portFeedEntries(port, ""))) {
    const count = (feed.group?.members.length ?? 0) + 1;
    const port = { ...feed, R: !feed.group ? feed.R : feed.group.connection === "parallel" ? feed.R * count : feed.R / count };
    const a = lo3(port).map((v) => v * scale) as Vec3;
    const c = hi3(port).map((v) => v * scale) as Vec3;
    const dz = c[2] - a[2];
    const planar = c[0] - a[0] < 1e-9 && c[1] - a[1] < 1e-9;
    const x = snap((a[0] + c[0]) / 2);
    const y = snap((a[1] + c[1]) / 2);
    const crosses = slabs.some((s) => a[2] <= s.z0 + TOL && c[2] >= s.z1 - TOL);
    if (port.direction === "z" && planar && crosses && dz > 0) {
      const lower = layerAt(a[2]);
      const upper = layerAt(c[2]);
      drills.push({ x, y, d: options.probeDrillMm, plated: true, kind: "probe", port: port.number, from: upper?.name ?? "top", to: lower?.name ?? "bottom" });
      if (lower) lower.clearances.push({ x, y, d: options.antipadMm });
      notes.push(`P${port.number}: probe feed → ${options.probeDrillMm} mm plated hole at (${x}, ${y}) mm with a ${options.antipadMm} mm clearance in ${lower?.name ?? "the lower copper"} (coaxial connector from below). Adjust to your connector.`);
      continue;
    }
    const edge = Math.abs(x - board[0]) <= TOL ? "left" : Math.abs(x - board[2]) <= TOL ? "right" : Math.abs(y - board[1]) <= TOL ? "bottom" : Math.abs(y - board[3]) <= TOL ? "top" : null;
    if (edge) {
      const width = edge === "left" || edge === "right" ? c[1] - a[1] : c[0] - a[0];
      const lay = layerAt(c[2]) ?? layers[0];
      edgePorts.push({ number: port.number, R: port.R, x, y, width: snap(width), layer: lay.name, edge });
      notes.push(`P${port.number}: edge port on the ${edge} edge at (${x}, ${y}) mm, ${snap(width)} mm wide on ${lay.name}: an edge-launch connector (${port.R} Ω) goes here; no drill.`);
    } else {
      notes.push(`P${port.number}: lumped port at (${x}, ${y}) mm inside the board: the simulated excitation has no fabrication equivalent here; decide how to feed it.`);
    }
  }
  for (const p of metals) for (const raw of p.primitives) {
    const q = drillPrimitive(raw);
    // a vertical cylinder through the substrate is a via; so is a tube (the plated barrel), of its outer diameter
    if (!q) continue;
    const radius = q.kind === "cylinder" ? q.radius : q.radius + q.shell_width / 2;
    const d = q.stop.map((v, i) => v - q.start[i]);
    if (Math.abs(d[0]) > 1e-9 || Math.abs(d[1]) > 1e-9) {
      warnings.push(`${p.label ?? p.name}: a slanted or horizontal cylinder is not a drill; skipped`);
      continue;
    }
    const z0 = Math.min(q.start[2], q.stop[2]) * scale;
    const z1 = Math.max(q.start[2], q.stop[2]) * scale;
    if (!slabs.some((s) => z0 <= s.z0 + TOL && z1 >= s.z1 - TOL)) {
      warnings.push(`${p.label ?? p.name}: a vertical cylinder that does not cross the substrate is skipped`);
      continue;
    }
    drills.push({ x: snap(q.start[0] * scale), y: snap(q.start[1] * scale), d: snap(2 * radius * scale), plated: true, kind: "via", from: layerAt(z1)?.name ?? "top", to: layerAt(z0)?.name ?? "bottom" });
    if (q.kind === "cylindricalshell") notes.push(`${p.label ?? p.name}: a tube through the substrate is drilled as a plated via of its outer diameter, ${snap(2 * radius * scale)} mm.`);
  }

  // --- lumped parts (e.g. the Wilkinson isolation resistor): placement notes
  const components = (b.lumped_elements ?? []).map((e) => {
    const a = lo3(e).map((v) => v * scale) as Vec3;
    const c = hi3(e).map((v) => v * scale) as Vec3;
    const lay = layerAt(c[2]);
    const axis = ({ x: 0, y: 1, z: 2 } as Record<string, number>)[e.direction] ?? 1;
    // one value reads as "100 Ω" before the part type ("a 100 Ω resistor"); an R/L/C combination
    // keeps the full label ("R 50 Ω · C 1e-12 F (parallel)")
    const only = (["R", "L", "C"] as const).filter((key) => e[key] !== undefined);
    const value = only.length === 1 ? `${e[only[0]]} ${only[0] === "R" ? "Ω" : only[0] === "L" ? "H" : "F"}` : lumpedLabel(e);
    return { label: e.label ?? e.name, type: e.type, value, x: snap((a[0] + c[0]) / 2), y: snap((a[1] + c[1]) / 2), layer: lay?.name ?? "F_Cu", span: snap(c[axis] - a[axis]) };
  });
  for (const k of components) notes.push(`${k.label}: place a ${k.value} ${k.type} on ${k.layer} at (${k.x}, ${k.y}) mm across the ${k.span} mm gap (pad spacing; pick the package accordingly).`);

  return { available: true, reason: null, warnings, notes, slabs, outline, board, layers, drills, edgePorts, components, options };
}
