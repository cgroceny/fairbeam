// Where a design refers to its parameters: every expression field, found by the file format's own
// layout (the same field lists as python/fairbeam/example_design.py _slot_paths, plus the derived
// parameters, the mesh, the monitors, the WCS and the parameter sweep), never by searching all text
// (a solid's name, a label or a description is not an expression). Used to rename a parameter
// everywhere at once and to tell what still uses a parameter before it is deleted. Pure: no Solid,
// no i18n (scripts/check-parameter-rename.mjs runs it in Node).
import { namesIn, renameInExpr } from "./expr.ts";
import type { Design, DesignPart, Expr } from "./types.ts";

/** Called with each expression's JSON path and value; a returned value different from the old one
 * replaces it (only strings can name a parameter: numbers are not visited). */
export type ExprVisit = (path: string, value: string) => Expr | void;

type Obj = Record<string | number, unknown>;

/** Keys below an expression field that hold a word, not an expression (mesh overrides' edge rule). */
const WORDS = new Set(["edge_rule", "quantity", "component", "normal", "kind", "type", "mode", "name", "label", "axis", "plane"]);

/** Every string under obj[key] (a value, a list of values, nested lists or objects). */
function walk(obj: Obj, key: string | number, path: string, visit: ExprVisit) {
  const v = obj[key];
  if (Array.isArray(v)) { v.forEach((_, k) => walk(v as unknown as Obj, k, `${path}[${k}]`, visit)); return; }
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) if (!WORDS.has(k)) walk(v as Obj, k, `${path}.${k}`, visit);
    return;
  }
  if (typeof v !== "string") return;
  const next = visit(path, v);
  if (next !== undefined && next !== v) obj[key] = next;
}

function scan(obj: unknown, path: string, keys: readonly string[], visit: ExprVisit) {
  if (!obj || typeof obj !== "object") return;
  for (const k of keys) if (k in (obj as Obj)) walk(obj as Obj, k, `${path}.${k}`, visit);
}

const GEOMETRY = ["start", "stop", "points", "vertices", "elevation", "length", "range", "radius", "inner_radius", "center",
  "bottom_radius", "top_radius", "major_radius", "minor_radius"] as const;
const TRANSFORM = ["offset", "center", "angle", "copies", "step", "factors", "origin", "point"] as const;
const CUT = ["start", "stop", "center", "radius", "elevation", "points"] as const;
const MATERIAL = ["eps_r", "mu_r", "tan_d", "tan_d_freq", "conductivity", "thickness"] as const;
const MESH = ["lines", "cells_per_wavelength", "pad", "max_ratio", "air_cells_per_wavelength", "overrides"] as const;

/** A solid's expressions, and those of the operands its Boolean history keeps (they are rebuilt
 * from these whenever the parameters change, so they must follow a rename too). */
function part(p: DesignPart, path: string, visit: ExprVisit) {
  (p.primitives ?? []).forEach((pr, j) => scan(pr, `${path}.primitives[${j}]`, GEOMETRY, visit));
  (p.transforms ?? []).forEach((tr, k) => scan(tr, `${path}.transforms[${k}]`, TRANSFORM, visit));
  (p.cuts ?? []).forEach((c, k) => scan(c, `${path}.cuts[${k}]`, CUT, visit));
  const h = p.booleanHistory;
  if (h?.A) part(h.A, `${path}.booleanHistory.A`, visit);
  if (h?.B) part(h.B, `${path}.booleanHistory.B`, visit);
}

/** Visit every expression of the design (and replace the ones `visit` returns a new value for). */
export function mapExpressions(d: Design, visit: ExprVisit): void {
  (d.params ?? []).forEach((p, i) => scan(p, `params[${i}]`, ["expr"], visit));
  scan(d.simulation, "simulation", ["f_min", "f_max"], visit);
  (d.materials ?? []).forEach((m, k) => scan(m, `materials[${k}]`, MATERIAL, visit));
  (d.parts ?? []).forEach((p, i) => part(p, `parts[${i}]`, visit));
  (d.ports ?? []).forEach((p, i) => {
    scan(p, `ports[${i}]`, ["R", "a", "b", "start", "stop", "reference_impedance"], visit);
    (p.group?.members ?? []).forEach((m, j) => scan(m, `ports[${i}].group.members[${j}]`, ["start", "stop"], visit));
  });
  (d.resistors ?? []).forEach((r, i) => scan(r, `resistors[${i}]`, ["R", "L", "C", "start", "stop"], visit));
  scan(d.mesh, "mesh", MESH, visit);
  scan(d.mesh?.automatic, "mesh.automatic", ["overrides"], visit);
  scan(d.far_field, "far_field", ["frequencies", "phase_center"], visit);
  const monitors = (d as Design & { monitors?: { field_planes?: unknown[]; currents?: unknown } }).monitors;
  (monitors?.field_planes ?? []).forEach((pl, k) => scan(pl, `monitors.field_planes[${k}]`, ["position", "frequencies"], visit));
  scan(monitors, "monitors", ["currents"], visit);
  scan(d.wcs, "wcs", ["origin"], visit);
  (d.parameter_sweep?.sequences ?? []).forEach((s, q) => (s.axes ?? []).forEach((a, k) =>
    scan(a, `parameter_sweep.sequences[${q}].axes[${k}]`, ["start", "stop", "steps", "list"], visit)));
}

/** Rename parameter `from` to `to` in place: its key, every expression that names it (as a whole
 * name, through the expression tokenizer) and the parameter sweep's axes. */
export function renameParameter(d: Design, from: string, to: string): void {
  for (const p of d.params ?? []) if (p.key === from) p.key = to;
  mapExpressions(d, (_, v) => renameInExpr(v, from, to));
  for (const s of d.parameter_sweep?.sequences ?? []) for (const a of s.axes ?? []) if (a.key === from) a.key = to;
}

/** The JSON paths of the fields that use parameter `key` (expressions naming it, sweep axes over it). */
export function parameterUses(d: Design, key: string): string[] {
  const out: string[] = [];
  mapExpressions(d, (path, v) => { if (namesIn(v).has(key)) out.push(path); });
  (d.parameter_sweep?.sequences ?? []).forEach((s, q) => (s.axes ?? []).forEach((a, k) => {
    if (a.key === key) out.push(`parameter_sweep.sequences[${q}].axes[${k}].key`);
  }));
  return out;
}

/** What a field path belongs to, for naming it to the user: a solid (also for its Boolean
 * operands), a port, a resistor, a parameter, a material, or a design-wide section. */
export type PathOwner =
  | { kind: "part" | "port" | "resistor" | "param" | "material"; index: number }
  | { kind: "simulation" | "mesh" | "far_field" | "monitors" | "wcs" | "parameter_sweep" };

export function pathOwner(path: string): PathOwner | null {
  const m = /^(parts|ports|resistors|params|materials)\[(\d+)\]/.exec(path);
  if (m) {
    const kind = ({ parts: "part", ports: "port", resistors: "resistor", params: "param", materials: "material" } as const)[m[1] as "parts"];
    return { kind, index: Number(m[2]) };
  }
  const head = /^(simulation|mesh|far_field|monitors|wcs|parameter_sweep)\b/.exec(path);
  return head ? { kind: head[1] as "simulation" } : null;
}
