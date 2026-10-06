// The cheap design checks, run in the browser on every edit for instant feedback. A mirror of
// python/fairbeam/design_checks.py (the authority, run by the server with every preview and save):
// same codes, paths and severities, so the Checks list can merge the two. The checks that need the
// resolved geometry or the preview bundle (a floating feed, a hidden part, the mesh size) come
// only from the server. scripts/check-designer.mjs compares both sides on shared cases.
import { evaluate, nameMap, namesIn } from "./expr.ts";
import { portFeedEntries, portGroupProblem } from "../lib/portGroups.ts";
import type { Axis, Design, DesignFieldPlane, DesignPart, DesignPrimitive, Expr } from "./types.ts";

/** "info": nothing is wrong, the build does something the drawing does not show (server only) */
export type Severity = "error" | "warning" | "info";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface CheckFix { label: string; set: Record<string, JsonValue> }
export interface Check {
  severity: Severity;
  /** JSON path of the field, e.g. "parts[1].primitives[0].radius" */
  path: string;
  code: string;
  message: string;
  /** Why this check matters and how to resolve it. */
  explain?: string;
  /** an edit the Checks list offers as a button (JSON path -> new value; a value may be a whole
   * object or list, e.g. the port a fix adds) */
  fix?: CheckFix;
}

/** Codes this file covers; for these the live result replaces the server's (possibly stale) one.
 * `port-at-null` stays server-only on both sides: the patch/substrate/ground test needs resolved
 * geometry, so the browser keeps the server warning and its conditional explanation intact. */
export const CHEAP = new Set([
  "expr", "param-range", "part-name-duplicate", "part-empty", "brick-flat", "brick-inverted", "radius",
  "inner-radius", "cylinder-length", "polygon-points", "polygon-area", "polygon-self-intersect",
  "linpoly-length", "polyhedron", "polyhedron-flat", "copies", "mu-r", "eps-r", "tan-d", "tan-d-freq", "f-min", "f-order", "f-ratio", "ff-band", "nf2ff-pec",
  "cells-per-wavelength", "end-criterion", "port-length", "port-volume", "port-r", "port-reference", "port-overlap", "no-port",
  "no-metal", "resistor-r", "resistor-length", "component-path", "cone-radii", "cone-length", "torus-radii",
  "wire-points", "wg-mode", "wg-size", "wg-cutoff", "wg-aperture", "cut-sheet", "boolean-transform-angle", "sheet-transform-angle", "scale", "mesh-lines",
  "monitor-efficiency", "field-plane", "conductivity", "metal-thickness", "tan-d-band",
]);

/** Keep CHEAP wording in sync with Python EXPLANATIONS (checked by check-designer). */
export const EXPLANATIONS: Readonly<Record<string, string>> = {
  "port-reference": "A complex power-wave reference is supported only on lumped ports and must contain exactly real and imag expressions. It is separate from the physical source resistance.",
  "mesh-lines": "Manual mesh lines need at least two finite, strictly increasing coordinates on each axis. Correct the line list or switch to automatic mesh.",
  "boolean-transform-angle": "A live Boolean needs axis-aligned operands so its result stays exact. Use quarter-turn rotations for its operands, or materialise the Boolean before applying an arbitrary angle.",
  "sheet-transform-angle": "Zero-thickness metal sheets must stay parallel to the solver's coordinate planes. A lossy sheet must also keep its original plane normal because openEMS uses local CSXCAD bounding-box axes to set tangential loss. Rotate within the sheet plane, or give the metal finite thickness and refine the mesh.",
  "scale": "Every primitive remains exact only under positive uniform scaling. Use the same positive factor on x, y and z; nonuniform or nonpositive factors are unsupported.",
  "expr": "This value cannot be evaluated, so the geometry or simulation setting is unknown. Enter a valid number or expression and check its parameter names.",
  "param-range": "The parameter limits or default disagree, so edits and sweeps cannot use a consistent range. Put the minimum below the maximum and keep the default within those limits.",
  "part-name-duplicate": "Two solids share a name, which makes selection and geometry references ambiguous. Give each solid a unique name.",
  "part-empty": "This solid contains no shapes and contributes no geometry to the simulation. Add a shape or remove the unused solid.",
  "brick-flat": "The brick has no area because two or more dimensions are zero. Give it extent along at least two axes; one zero dimension is allowed for a sheet.",
  "brick-inverted": "A minimum coordinate is above its maximum, so the shape bounds are reversed. Swap the coordinates or correct the expressions that set them.",
  "radius": "An invalid radius prevents the shape from being built. Use a positive radius; a cone may have one zero radius for a sharp tip.",
  "inner-radius": "The tube needs a wall between its inner and outer radii. Set the inner radius to zero for a solid cylinder or to a positive value smaller than the outer radius.",
  "cylinder-length": "The cylinder axis has no valid length, so it cannot define a volume. Separate its endpoints or put the range minimum below the maximum.",
  "polygon-points": "A polygon needs at least three distinct vertices to enclose an area. Add or move points to form a closed outline.",
  "polygon-area": "The polygon points lie on a line, so the shape has no area. Move a vertex away from that line to give the outline a width.",
  "polygon-self-intersect": "The outline crosses itself, so its inside and outside are ambiguous. Reorder or move the vertices until only neighboring edges meet.",
  "linpoly-length": "A zero extrusion length leaves a flat polygon instead of a solid. Enter a nonzero length if you intended a volume, or keep it flat intentionally.",
  "copies": "The copy count is invalid or produces more geometry than the designer allows. Use a whole number of zero or more and reduce combined transforms to at most 1000 copies.",
  "mu-r": "Relative permeability must be positive in the isotropic loss-free material model. Magnetic loss and dispersion are not represented.",
  "eps-r": "Relative permittivity below one is outside the dielectric model supported here. Use a value of at least one from the material data at your operating frequency.",
  "tan-d": "A negative loss tangent describes gain instead of a passive dielectric. Use zero for a lossless material or a positive loss tangent from its data sheet.",
  "tan-d-freq": "The loss model needs a positive reference frequency to interpret the loss tangent. Enter the frequency in GHz at which the material's loss tangent was specified.",
  "tan-d-band": "openEMS models dielectric loss as a constant conductivity, so the loss tangent is exact only at the frequency given with it and scales as that frequency over f elsewhere. A datasheet value at 10 GHz used for a 2.45 GHz antenna makes its loss about four times too high. Give the frequency the design works at, for example f0, or leave the field empty for the band center.",
  "conductivity": "A metal's conductivity must be positive to describe a lossy conductor. Enter it in S/m (copper 5.8e7, aluminium 3.5e7, gold 4.1e7), or leave it empty for a perfect conductor.",
  "metal-thickness": "A lossy metal sheet is modeled with a finite thickness, which must be positive. Enter the copper thickness in mm (0.035 for 1 oz copper), or leave it empty for the default 0.035 mm.",
  "f-min": "The simulated band must start above zero for the excitation and frequency results to be meaningful. Set a positive minimum frequency in GHz.",
  "f-order": "An empty or reversed frequency band cannot define the simulation. Set the maximum frequency above the minimum.",
  "f-ratio": "A very wide band combines a fine mesh with a long simulation time. Narrow the band to the frequencies you need or split it into separate runs.",
  "nf2ff-pec": "The far-field box leaves out a face that lies on a PEC or PMC boundary (the wall mirrors it), so enabling that face has no effect. Turn the face off to match what is simulated; ground-plane and half-space models skip the face on the ground.",
  "ff-band": "A far-field result outside the simulated band is not reliable. Move this frequency into the band or expand the simulation band to include it.",
  "cells-per-wavelength": "Too few cells cannot accurately represent the changing electromagnetic fields. Set a positive resolution, usually at least 15 cells per wavelength, and check convergence with a finer mesh.",
  "end-criterion": "The stop threshold measures how far the field energy has decayed below its peak, in dB. Fairbeam accepts -10 to -300 dB, because a run stopped above -10 dB has not meaningfully decayed. Use about -40 dB for a quick look and -60 dB for accurate S-parameters and efficiency.",
  "port-length": "The port has no length along its excitation direction, so it cannot drive or measure the intended field. Separate start and stop on that axis; an excited waveguide port needs at least a mesh cell between excitation and probe.",
  "port-volume": "A lumped port with width in both transverse directions fills a volume instead of the intended feed gap. Make it a line or sheet by matching start and stop on at least one transverse axis.",
  "port-r": "The port impedance must be positive to define a physical load and meaningful S-parameters. Enter a positive resistance in ohms, commonly 50.",
  "port-overlap": "Overlapping ports drive or measure the same region and can interfere with each other. Move or resize the ports so their bounds do not touch or overlap.",
  "no-port": "Without a port the design has no excitation or S-parameter measurement. Add a suitable lumped or waveguide port and connect it to the intended feed.",
  "no-metal": "There is no metal solid to carry the antenna current in this design. Add a conductor or assign a metal material to the intended conducting solid.",
  "resistor-r": "A zero or negative resistance does not define the passive resistor expected here. Enter a positive resistance in ohms.",
  "resistor-length": "The resistor has no extent along its current direction, so it cannot bridge a gap. Separate its endpoints on the selected direction axis.",
  "component-path": "An empty folder name makes the component hierarchy ambiguous. Use nonempty names separated by slashes, such as antenna/feed, or leave the whole path empty.",
  "cone-radii": "With both radii zero the cone collapses to a line and has no volume. Give at least one end a positive radius.",
  "cone-length": "The cone needs a positive axial length to define a volume. Put its range minimum below its maximum.",
  "torus-radii": "The tube radius reaches or crosses the torus axis, creating an unsupported shape. Make the minor radius smaller than the major radius and keep both positive.",
  "polyhedron": "A polyhedron is a closed solid. It needs at least 4 vertices and 4 faces, and every face lists at least 3 different vertex numbers that exist (0 up to the number of vertices minus 1).",
  "polyhedron-flat": "All the vertices lie in one plane on some axis, so the solid has no thickness. Move at least one vertex off that plane.",
  "wire-points": "The wire has no path unless it contains at least two distinct points. Add an endpoint or move a point away from the others.",
  "wg-mode": "The waveguide excitation needs a supported rectangular TE mode. Enter TEmn with single-digit indices, such as TE10, and do not use TE00.",
  "wg-size": "A waveguide needs a positive width and height to define its mode field. Set both a and b to positive dimensions in millimeters.",
  "wg-cutoff": "Below cutoff the selected mode does not propagate, so its S-parameters are not meaningful there. Raise the band above cutoff or enlarge the guide to lower cutoff.",
  "wg-aperture": "The port cross-section does not match the dimensions used to calculate its mode field. Adjust the port bounds or a and b so the aperture and mode dimensions agree.",
  "cut-sheet": "A rectangle cut must lie in the plane of the sheet it removes material from. Make start and stop equal on exactly one axis and give the other two axes a positive extent.",
  "monitor-efficiency": "The efficiency over the band is computed from the far-field box after the run, so it needs the far field and a usable number of frequencies. Turn the far field on and use a whole number of frequencies from 3 to 201; 21 is usually enough.",
  "field-plane": "A field plane records E or H at a few frequencies inside the simulated band, and each map adds to the run's memory and result size. Give each plane one to four frequencies within the band and use at most four planes."
};

/** The end-criterion policy (design_checks.py END_DB_MIN / END_DB_MAX, the Solver field's min and
 * max): simulation.end_criteria_db is a number of dB from -300 (the lowest a run accepts) to -10.
 * Above -10 dB a run stops before the fields have meaningfully decayed; this is Fairbeam's limit
 * for usable results, not a physical one. An error blocks the run. */
export const END_DB_MIN = -300;
export const END_DB_MAX = -10;

/** Efficiency over the band (monitors.efficiency.points; design.py EFFICIENCY_POINTS_*): the number
 * of frequencies, a whole number in this range, 21 when absent. It needs the far field. */
export const EFFICIENCY_POINTS_DEFAULT = 21;
export const EFFICIENCY_POINTS_MIN = 3;
export const EFFICIENCY_POINTS_MAX = 201;

/** E/H field maps on cut planes (monitors.field_planes; design.py FIELD_PLANES_MAX /
 * FIELD_PLANE_FREQS_MAX): at most this many planes, each at one to this many frequencies. */
export const FIELD_PLANES_MAX = 4;
export const FIELD_PLANE_FREQS_MAX = 4;

/** A parameter's min / max as typed in the Parameters dock. Limits are plain numbers (the design
 * format stores numbers, and design.py passes them to Sweep / Optimize as they are): "" clears the
 * limit, a number sets it, anything else (an expression such as W/2) is refused and the old limit
 * stays. */
export function parseLimit(v: Expr): { value: number | undefined } | { error: string } {
  if (typeof v === "number") return Number.isFinite(v) ? { value: v } : { error: "a limit must be a finite number" };
  const t = v.trim();
  if (t === "") return { value: undefined };
  const n = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : NaN;
  return Number.isFinite(n) ? { value: n } : { error: `limits are plain numbers: "${t}" is not one` };
}

const EPS = 1e-9;
const AXES: Axis[] = ["x", "y", "z"];
const g = (v: number) => String(Number(v.toPrecision(6)));
const inPlane = (n: number) => [(n + 1) % 3, (n + 2) % 3];
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function designChecks(d: Design): Check[] {
  const out: Check[] = [];
  const add = (severity: Severity, path: string, code: string, message: string, fix?: CheckFix) =>
    out.push({ severity, path, code, message, explain: EXPLANATIONS[code], ...(fix ? { fix } : {}) });
  const error = (path: string, code: string, message: string) => add("error", path, code, message);
  const warn = (path: string, code: string, message: string, fix?: CheckFix) => add("warning", path, code, message, fix);
  for (const [i, port] of (d.ports ?? []).entries()) {
    const problem = portGroupProblem(port, `ports[${i}]`);
    if (problem) { error(problem.path, "expr", problem.message); return out; }
  }
  const names = nameMap(); // prototype-free: a parameter may be called __proto__ or toString
  const failed = new Set<string>();

  const ev = (path: string, expr: Expr | undefined | null, optional = false): number | null => {
    if (expr === undefined || expr === null || expr === "") {
      if (!optional) error(path, "expr", "needs a value");
      return null;
    }
    try {
      return evaluate(expr, names);
    } catch (e) {
      if ([...namesIn(expr)].some((n) => failed.has(n))) return null;
      error(path, "expr", (e as Error).message);
      return null;
    }
  };
  const vec = (path: string, v: unknown, n = 3): number[] | null => {
    if (!Array.isArray(v) || v.length !== n) {
      error(path, "expr", `expected a list of ${n} values`);
      return null;
    }
    const r = v.map((x, k) => ev(`${path}[${k}]`, x as Expr));
    return r.some((x) => x === null) ? null : (r as number[]);
  };

  const folders: unknown = d.components === undefined ? [] : d.components;
  const validFolder = (path: unknown) => typeof path === "string" && !!path.trim() && path.split("/").every((segment) => !!segment.trim());
  if (!Array.isArray(folders)) error("components", "component-path", "components must be a list of non-empty folder paths");
  else folders.forEach((path, i) => { if (!validFolder(path)) error(`components[${i}]`, "component-path", "component must be a non-empty folder path such as 'antenna/feed'"); });
  d.parts.forEach((part, i) => { if (part.component !== undefined && typeof part.component !== "string") error(`parts[${i}].component`, "component-path", "component must be a folder path such as 'antenna/feed' or empty"); });
  if (out.length) return out;

  d.ports.forEach((port, i) => {
    if (!("reference_impedance" in port)) return;
    const ref: unknown = port.reference_impedance;
    const path = `ports[${i}].reference_impedance`;
    if (!ref || typeof ref !== "object" || Array.isArray(ref) || Object.keys(ref).length !== 2 || !("real" in ref) || !("imag" in ref))
      error(path, "port-reference", "reference_impedance needs exactly real and imag");
    else if ((port.type ?? "lumped") !== "lumped")
      error(path, "port-reference", "complex reference is supported on lumped ports only");
  });
  if (out.length) return out;

  // ---- parameters
  (d.params ?? []).forEach((p, i) => {
    const w = `params[${i}]`;
    if (p.expr !== undefined) {
      const v = ev(`${w}.expr`, p.expr);
      if (v === null) failed.add(p.key);
      else names[p.key] = v;
      return;
    }
    if (!isNum(p.default)) return;
    names[p.key] = p.default;
    const lo = p.min, hi = p.max;
    if (isNum(lo) && isNum(hi) && lo > hi) error(`${w}.max`, "param-range", `the minimum ${g(lo)} is above the maximum ${g(hi)}`);
    else if (isNum(lo) && p.default < lo) error(`${w}.default`, "param-range", `the default ${g(p.default)} is below the minimum ${g(lo)}`);
    else if (isNum(hi) && p.default > hi) error(`${w}.default`, "param-range", `the default ${g(p.default)} is above the maximum ${g(hi)}`);
  });

  // ---- materials
  const given = (v: Expr | undefined | null) => v !== undefined && v !== null && !(typeof v === "string" && !v.trim());
  const lossAt: { w: string; k: number; tan: number; f: number }[] = []; // tan δ and its frequency, for the band check below
  for (const [k, m] of (d.materials ?? []).entries()) {
    const w = `materials.${m.name}`;
    if (m.kind === "metal") {
      // lossy metal (design.py metal_loss): an empty conductivity is a perfect conductor
      if (given(m.conductivity)) {
        const sigma = ev(`${w}.conductivity`, m.conductivity);
        if (sigma !== null && sigma <= 0) error(`${w}.conductivity`, "conductivity", `σ = ${g(sigma)} S/m: the conductivity must be > 0 (leave it empty for a perfect conductor)`);
        if (given(m.thickness)) {
          const t = ev(`${w}.thickness`, m.thickness);
          if (t !== null && t <= 0) error(`${w}.thickness`, "metal-thickness", "the sheet thickness must be > 0 mm");
        }
      }
      continue;
    }
    if (m.kind !== "dielectric") continue;
    const mu = ev(`${w}.mu_r`, m.mu_r ?? 1);
    if (mu !== null && mu <= 0) error(`${w}.mu_r`, "mu-r", "relative permeability must be > 0");
    const eps = ev(`${w}.eps_r`, m.eps_r ?? 1);
    if (eps !== null && eps < 1) error(`${w}.eps_r`, "eps-r", `εr = ${g(eps)} is below 1 (vacuum)`);
    const tan = ev(`${w}.tan_d`, m.tan_d ?? 0);
    if (tan !== null && tan < 0) error(`${w}.tan_d`, "tan-d", `tan δ = ${g(tan)} is negative (a material with gain)`);
    if (m.tan_d_freq !== undefined && m.tan_d_freq !== null) {
      const f = ev(`${w}.tan_d_freq`, m.tan_d_freq);
      if (f !== null && f <= 0) error(`${w}.tan_d_freq`, "tan-d-freq", "the loss tangent frequency must be > 0");
      if (f !== null && f > 0 && tan !== null && tan > 0) lossAt.push({ w, k, tan, f });
    }
  }

  // ---- parts and their shapes
  const primitive = (pr: DesignPrimitive, wp: string) => {
    if (pr.kind === "box") {
      const a = vec(`${wp}.start`, pr.start), c = vec(`${wp}.stop`, pr.stop);
      if (!a || !c) return;
      const flat = [0, 1, 2].filter((k) => Math.abs(c[k] - a[k]) < EPS);
      for (let k = 0; k < 3; k++) {
        if (a[k] - c[k] >= EPS) {
          const X = AXES[k].toUpperCase();
          error(`${wp}.stop[${k}]`, "brick-inverted", `${X}min (${g(a[k])}) is above ${X}max (${g(c[k])})`);
        }
      }
      if (flat.length > 1) {
        const ax = flat.map((k) => AXES[k].toUpperCase()).join(" and ");
        error(`${wp}.stop[${flat[flat.length - 1]}]`, "brick-flat", `zero size along ${ax}: a brick needs extent in at least two directions (one zero is a sheet)`);
      }
    } else if (pr.kind === "cylinder") {
      const r = ev(`${wp}.radius`, pr.radius);
      const ri = "inner_radius" in pr ? ev(`${wp}.inner_radius`, pr.inner_radius, true) : 0;
      if (r !== null && r <= 0) error(`${wp}.radius`, "radius", "the radius must be > 0");
      if (ri !== null && (ri < 0 || (r !== null && r > 0 && ri >= r))) error(`${wp}.inner_radius`, "inner-radius", "the inner radius must be 0 (solid) or between 0 and the outer radius");
      if ("axis" in pr) {
        vec(`${wp}.center`, pr.center, 2);
        const rg = vec(`${wp}.range`, pr.range, 2);
        if (rg && rg[1] - rg[0] < -EPS) {
          // equal ends are fine: a flat circle (a disc or ring), built as a polygon sheet
          const A = pr.axis.toUpperCase();
          error(`${wp}.range[1]`, "cylinder-length", `${A}min (${g(rg[0])}) must be below ${A}max (${g(rg[1])})`);
        }
      } else {
        const a = vec(`${wp}.start`, pr.start), c = vec(`${wp}.stop`, pr.stop);
        if (a && c && [0, 1, 2].every((k) => Math.abs(a[k] - c[k]) < EPS)) error(`${wp}.stop`, "cylinder-length", "the axis start and stop are the same point");
      }
    } else if (pr.kind === "sphere") {
      vec(`${wp}.center`, pr.center);
      const r = ev(`${wp}.radius`, pr.radius);
      if (r !== null && r <= 0) error(`${wp}.radius`, "radius", "the radius must be > 0");
    } else if (pr.kind === "cone") {
      vec(`${wp}.center`, pr.center, 2);
      const rb = ev(`${wp}.bottom_radius`, pr.bottom_radius);
      const rt = ev(`${wp}.top_radius`, pr.top_radius ?? 0);
      for (const [r, key] of [[rb, "bottom_radius"], [rt, "top_radius"]] as const) if (r !== null && r < 0) error(`${wp}.${key}`, "radius", "the radius must be >= 0 (0: a sharp tip)");
      if (rb !== null && rt !== null && rb <= 0 && rt <= 0 && rb > -EPS && rt > -EPS) error(`${wp}.bottom_radius`, "cone-radii", "both radii are 0: the cone has no volume");
      const rg = vec(`${wp}.range`, pr.range, 2);
      if (rg && rg[1] - rg[0] < EPS) {
        const A = pr.axis.toUpperCase();
        error(`${wp}.range[1]`, "cone-length", `${A}min (${g(rg[0])}) must be below ${A}max (${g(rg[1])})`);
      }
    } else if (pr.kind === "wire") {
      const r = ev(`${wp}.radius`, pr.radius);
      if (r !== null && r <= 0) error(`${wp}.radius`, "radius", "the radius must be > 0");
      if (!Array.isArray(pr.points)) {
        error(`${wp}.points`, "wire-points", "a wire needs at least 2 distinct points");
        return;
      }
      const xyz = pr.points.map((q, k) => vec(`${wp}.points[${k}]`, q));
      if (xyz.some((q) => q === null)) return;
      const p0 = xyz[0] as number[];
      if (xyz.length < 2 || xyz.every((q) => Math.hypot(q![0] - p0[0], q![1] - p0[1], q![2] - p0[2]) < EPS)) error(`${wp}.points`, "wire-points", "a wire needs at least 2 distinct points");
    } else if (pr.kind === "polyhedron") {
      const need = "a polyhedron needs at least 4 vertices and 4 faces";
      if (!Array.isArray(pr.vertices) || pr.vertices.length < 4) { error(`${wp}.vertices`, "polyhedron", need); return; }
      const xyz = pr.vertices.map((q, k) => vec(`${wp}.vertices[${k}]`, q));
      const faces = pr.faces;
      if (!Array.isArray(faces) || faces.length < 4) { error(`${wp}.faces`, "polyhedron", need); return; }
      for (let k = 0; k < faces.length; k++) {
        const f = faces[k];
        if (!Array.isArray(f) || f.length < 3 || !f.every((i) => Number.isInteger(i))) { error(`${wp}.faces[${k}]`, "polyhedron", "a face is a list of at least 3 vertex indices"); return; }
        const bad = f.find((i) => i < 0 || i >= pr.vertices.length);
        if (bad !== undefined) { error(`${wp}.faces[${k}]`, "polyhedron", `vertex index ${bad} is out of range (0 to ${pr.vertices.length - 1})`); return; }
        if (new Set(f).size < 3) { error(`${wp}.faces[${k}]`, "polyhedron", "a face needs at least 3 different vertices"); return; }
      }
      if (xyz.every((q) => q !== null)) {
        const pts = xyz as number[][];
        if ([0, 1, 2].some((k) => Math.max(...pts.map((q) => q[k])) - Math.min(...pts.map((q) => q[k])) < EPS))
          error(`${wp}.vertices`, "polyhedron-flat", "all vertices lie in one plane on an axis: the polyhedron has no volume");
      }
    } else if (pr.kind === "torus") {
      vec(`${wp}.center`, pr.center);
      const big = ev(`${wp}.major_radius`, pr.major_radius);
      const small = ev(`${wp}.minor_radius`, pr.minor_radius);
      for (const [r, key] of [[big, "major_radius"], [small, "minor_radius"]] as const) if (r !== null && r <= 0) error(`${wp}.${key}`, "radius", "the radius must be > 0");
      if (big !== null && small !== null && big > 0 && big <= small) error(`${wp}.minor_radius`, "torus-radii", `the tube radius (${g(small)}) must be below the major radius (${g(big)}): the tube would cross the axis`);
    } else {
      ev(`${wp}.elevation`, pr.elevation ?? 0);
      if (!Array.isArray(pr.points)) {
        error(`${wp}.points`, "polygon-points", "a polygon needs at least 3 distinct points");
        return;
      }
      const uv = pr.points.map((q, k) => vec(`${wp}.points[${k}]`, q, 2));
      if (pr.kind === "linpoly") {
        const len = ev(`${wp}.length`, pr.length);
        if (len !== null && Math.abs(len) < EPS) warn(`${wp}.length`, "linpoly-length", "zero extrusion length: this is a flat polygon");
      }
      if (uv.some((q) => q === null)) return;
      for (const [code, msg] of polygonProblems(uv as number[][])) error(`${wp}.points`, code, msg);
    }
  };

  const quietNumber = (value: Expr | undefined): number | null => {
    if (value === undefined) return null;
    try { return evaluate(value, names); } catch { return null; }
  };
  const metalSheetNormal = (pr: DesignPrimitive): [number, number, number] | null => {
    if (pr.kind === "box") {
      const a = pr.start.map(quietNumber), c = pr.stop.map(quietNumber);
      if (a.some((v) => v === null) || c.some((v) => v === null)) return null;
      const flat = [0, 1, 2].filter((k) => Math.abs((c[k] as number) - (a[k] as number)) < 1e-12);
      if (flat.length !== 1) return null;
      return [0, 1, 2].map((k) => k === flat[0] ? 1 : 0) as [number, number, number];
    }
    if (pr.kind === "polygon" || pr.kind === "linpoly") {
      if (pr.kind === "linpoly") {
        const length = quietNumber(pr.length);
        if (length === null || Math.abs(length) >= 1e-12) return null;
      }
      const axis = AXES.indexOf(pr.normal);
      return axis < 0 ? null : [0, 1, 2].map((k) => k === axis ? 1 : 0) as [number, number, number];
    }
    return null;
  };
  const checkMetalSheetTransform = (part: DesignPart, partIndex: number, primitive: DesignPrimitive, primitiveIndex: number, lossy: boolean) => {
    const initial = metalSheetNormal(primitive);
    if (!initial) return;
    type Normal = { v: [number, number, number]; affine: boolean; path?: string };
    let normals: Normal[] = [{ v: initial, affine: false }];
    for (const [k, tr] of (part.transforms ?? []).entries()) {
      if (tr.type === "rotate") {
        const axis = AXES.indexOf(tr.axis), degrees = quietNumber(tr.angle);
        const rawCopies = tr.copies === undefined ? 0 : quietNumber(tr.copies);
        if (rawCopies === null) continue;
        const copies = Math.round(rawCopies);
        if (axis < 0 || degrees === null || copies < 0 || copies > 1000 || Math.abs(copies - rawCopies) > EPS) continue;
        const quarter = Math.abs(degrees / 90 - Math.round(degrees / 90)) <= 1e-9;
        const angles = copies === 0 ? [1] : Array.from({ length: copies + 1 }, (_, copy) => copy);
        const next: Normal[] = [];
        for (const item of normals) for (const copy of angles) {
          const angle = ((degrees % 360) * copy) % 360, radians = angle * Math.PI / 180;
          const c = Math.cos(radians), s = Math.sin(radians), v = item.v;
          const rotated: [number, number, number] = axis === 0 ? [v[0], c*v[1]-s*v[2], s*v[1]+c*v[2]]
            : axis === 1 ? [c*v[0]+s*v[2], v[1], -s*v[0]+c*v[2]]
              : [c*v[0]-s*v[1], s*v[0]+c*v[1], v[2]];
          const changed = copy !== 0 || copies === 0;
          const affine = item.affine || (!quarter && changed);
          next.push({ v: rotated, affine,
            path: changed && affine ? `parts[${partIndex}].transforms[${k}].angle` : item.path });
          if (next.length >= 1001) break;
        }
        normals = next.slice(0, 1001);
      } else if (tr.type === "mirror") {
        const axis = AXES.indexOf(tr.plane);
        if (axis < 0) continue;
        const next: Normal[] = [];
        for (const item of normals) {
          if (tr.keep !== false) next.push(item);
          const v = [...item.v] as [number, number, number]; v[axis] = -v[axis];
          next.push({ ...item, v });
          if (next.length >= 1001) break;
        }
        normals = next.slice(0, 1001);
      } // move, translate and positive uniform scale do not change the normal or affine status
      if (!normals.length) return;
    }
    const reported = new Set<string>();
    for (const item of normals) {
      if (!item.affine) continue; // legacy quarter turns are baked into the local primitive
      const norm = Math.hypot(...item.v);
      if (!Number.isFinite(norm) || norm === 0) continue;
      const axis = [0, 1, 2].reduce((best, k) => Math.abs(item.v[k]) > Math.abs(item.v[best]) ? k : best, 0);
      const aligned = Math.abs(Math.abs(item.v[axis]) - norm) <= 1e-9 * norm;
      if (aligned && (!lossy || axis === initial.findIndex((v) => v !== 0))) continue;
      const message = aligned
        ? "this lossy zero-thickness metal sheet changes its local normal under the transform; openEMS may select the wrong tangential conductivity direction. Keep the original normal or model it as finite-thickness metal"
        : "this zero-thickness metal sheet is tilted relative to the Yee grid; keep its normal axis-aligned or give it finite thickness and refine the mesh";
      const path = item.path ?? `parts[${partIndex}].primitives[${primitiveIndex}]`;
      const signature = `${path}|${message}`;
      if (!reported.has(signature)) { reported.add(signature); error(path, "sheet-transform-angle", message); }
    }
  };

  const seen = new Set<string>();
  const checkBooleanOperandTransforms = (operand: DesignPart, path: string) => {
    (operand.transforms ?? []).forEach((tr, k) => {
      if (tr.type !== "rotate") return;
      const angle = ev(`${path}.transforms[${k}].angle`, tr.angle);
      if (angle !== null && Math.abs(angle / 90 - Math.round(angle / 90)) > 1e-9)
        error(`${path}.transforms[${k}].angle`, "boolean-transform-angle", "live Boolean operands must stay axis-aligned (quarter turns are allowed)");
    });
    const history = operand.booleanHistory;
    if (history?.live) {
      checkBooleanOperandTransforms(history.A, `${path}.booleanHistory.A`);
      checkBooleanOperandTransforms(history.B, `${path}.booleanHistory.B`);
    }
  };
  (d.parts ?? []).forEach((pt, i) => {
    const w = `parts[${i}]`;
    if (seen.has(pt.name)) error(`${w}.name`, "part-name-duplicate", `another solid is already called '${pt.name}'`);
    seen.add(pt.name);
    if (!pt.primitives.length) warn(w, "part-empty", "this solid has no shapes");
    const comp = pt.component;
    if (typeof comp === "string" && comp !== "" && comp.split("/").some((seg) => !seg.trim()))
      warn(`${w}.component`, "component-path", `component '${comp}' has an empty folder name (write folders as 'antenna/feed')`);
    pt.primitives.forEach((pr, j) => {
      primitive(pr, `${w}.primitives[${j}]`);
      const material = (d.materials ?? []).find((m) => m.name === pt.material);
      if (material?.kind === "metal" && given(material.conductivity)) checkMetalSheetTransform(pt, i, pr, j, true);
      else if (material?.kind === "metal") checkMetalSheetTransform(pt, i, pr, j, false);
    });
    (pt.cuts ?? []).forEach((c, k) => {
      const wc = `${w}.cuts[${k}]`;
      if (c.kind === "circle") {
        vec(`${wc}.center`, c.center, 2);
        ev(`${wc}.elevation`, c.elevation ?? 0);
        const r = ev(`${wc}.radius`, c.radius);
        if (r !== null && r <= 0) error(`${wc}.radius`, "radius", "the radius must be > 0");
        return;
      }
      if (c.kind === "polygon") {
        ev(`${wc}.elevation`, c.elevation ?? 0);
        if (!Array.isArray(c.points)) { error(`${wc}.points`, "polygon-points", "a polygon needs at least 3 distinct points"); return; }
        const uv = c.points.map((q, m) => vec(`${wc}.points[${m}]`, q, 2));
        if (uv.every((q) => q !== null)) for (const [code, msg] of polygonProblems(uv as number[][])) error(`${wc}.points`, code, msg);
        return;
      }
      const a = vec(`${wc}.start`, c.start), b = vec(`${wc}.stop`, c.stop);
      if (!a || !b) return;
      const flat = [0, 1, 2].filter((q) => Math.abs(b[q] - a[q]) < EPS);
      if (flat.length !== 1) {
        error(`${wc}.stop`, "cut-sheet", "a cut is a rectangle on a plane: min = max on exactly one axis (the plane of the sheets it cuts)");
        return;
      }
      for (let q = 0; q < 3; q++) {
        if (a[q] - b[q] >= EPS) {
          const X = AXES[q].toUpperCase();
          error(`${wc}.stop[${q}]`, "brick-inverted", `${X}min (${g(a[q])}) is above ${X}max (${g(b[q])})`);
        }
      }
    });
    let count = 1;
    (pt.transforms ?? []).forEach((tr, k) => {
      const wt = `${w}.transforms[${k}]`;
      if (tr.type === "move") {
        vec(`${wt}.offset`, tr.offset);
      } else if (tr.type === "rotate") {
        vec(`${wt}.center`, tr.center);
        ev(`${wt}.angle`, tr.angle);
        const n = ev(`${wt}.copies`, tr.copies ?? 0);
        if (n === null) return;
        if (Math.abs(n - Math.round(n)) > 1e-9 || n < 0) {
          error(`${wt}.copies`, "copies", "the number of copies must be a whole number >= 0");
          return;
        }
        count *= Math.round(n) + 1;
        if (count > 1001) error(`${wt}.copies`, "copies", "at most 1000 copies of a solid");
      } else if (tr.type === "translate") {
        const n = ev(`${wt}.copies`, tr.copies);
        vec(`${wt}.step`, tr.step);
        if (n === null) return;
        if (Math.abs(n - Math.round(n)) > 1e-9 || n < 0) {
          error(`${wt}.copies`, "copies", "the number of copies must be a whole number >= 0");
          return;
        }
        count *= Math.round(n) + 1;
        if (count > 1001) error(`${wt}.copies`, "copies", "at most 1000 copies of a solid");
      } else if (tr.type === "scale") {
        const factors = vec(`${wt}.factors`, tr.factors);
        vec(`${wt}.origin`, tr.origin);
        if (factors) {
          if (factors.some((f) => f <= 0) || Math.max(...factors) - Math.min(...factors) > 1e-12 * Math.max(1, ...factors.map(Math.abs)))
            error(`${wt}.factors`, "scale", "scale requires three equal positive factors to preserve exact primitive geometry");
        }
        const n = ev(`${wt}.copies`, tr.copies ?? 0);
        if (n === null) return;
        if (Math.abs(n - Math.round(n)) > 1e-9 || n < 0) {
          error(`${wt}.copies`, "copies", "the number of copies must be a whole number >= 0");
          return;
        }
        count *= Math.round(n) + 1;
        if (count > 1001) error(`${wt}.copies`, "copies", "at most 1000 copies of a solid");
      } else if (tr.type === "mirror") {
        if (tr.point !== undefined) vec(`${wt}.point`, tr.point);
        if (tr.keep !== false) {
          count *= 2;
          if (count > 1001) error(`${wt}.plane`, "copies", "at most 1000 copies of a solid");
        }
      }
    });
    if (pt.booleanHistory?.live) {
      checkBooleanOperandTransforms(pt.booleanHistory.A, `${w}.booleanHistory.A`);
      checkBooleanOperandTransforms(pt.booleanHistory.B, `${w}.booleanHistory.B`);
    }
  });
  const metals = new Set((d.materials ?? []).filter((m) => m.kind === "metal").map((m) => m.name));
  if (!(d.parts ?? []).some((p) => metals.has(p.material))) error("parts", "no-metal", "the design has no metal solid: nothing to excite or radiate");

  // ---- simulation, mesh, far field
  const s = d.simulation ?? ({} as Design["simulation"]);
  const f0 = ev("simulation.f_min", s.f_min ?? 1);
  const f1 = ev("simulation.f_max", s.f_max ?? 3);
  let band: [number, number] | null = null;
  if (f0 !== null && f0 <= 0) error("simulation.f_min", "f-min", "f min must be > 0");
  else if (f0 !== null && f1 !== null) {
    if (f0 >= f1) error("simulation.f_max", "f-order", `f max (${g(f1)} GHz) must be above f min (${g(f0)} GHz)`);
    else {
      band = [f0, f1];
      if (f1 / f0 > 50) warn("simulation.f_max", "f-ratio", `f max / f min = ${Math.round(f1 / f0)}: a band this wide needs a very long run and a fine mesh`);
    }
  }
  // a loss tangent given outside the band: openEMS applies it as a constant conductivity, so at f
  // the loss is tan δ · f_ref / f (design_checks.py loss_band)
  if (band) for (const { w, k, f } of lossAt) {
    if (f >= band[0] && f <= band[1]) continue;
    // the one-click fix: the design frequency when the design has an f0 parameter inside the band,
    // else the band center (design_checks.py loss_band)
    const center = (band[0] + band[1]) / 2;
    const f0Design = (d.params ?? []).some((p) => p.key === "f0") && names.f0 !== undefined && names.f0 >= band[0] && names.f0 <= band[1];
    const fix: CheckFix = f0Design
      ? { label: "Give tan δ at f0", set: { [`materials[${k}].tan_d_freq`]: "f0" } }
      : { label: `Give tan δ at the band center (${g(center)} GHz)`, set: { [`materials[${k}].tan_d_freq`]: g(center) } };
    warn(`${w}.tan_d_freq`, "tan-d-band", `tan δ holds at ${g(f)} GHz only, outside the band (${g(band[0])} to ${g(band[1])} GHz): openEMS applies it as a constant conductivity, so at the band center the loss is ${(f / ((band[0] + band[1]) / 2)).toFixed(2)} times the given tan δ. Give the frequency the design works at (e.g. f0), or leave it empty for the band center`, fix);
  }
  if (s.end_criteria_db !== undefined) {
    const end = s.end_criteria_db;
    if (!isNum(end)) error("simulation.end_criteria_db", "end-criterion", `the end criterion is a number of dB from ${END_DB_MIN} to ${END_DB_MAX}`);
    else if (end > END_DB_MAX) error("simulation.end_criteria_db", "end-criterion", `${g(end)} dB is above the ${END_DB_MAX} dB limit: the run would stop before the field energy has decayed by ${-END_DB_MAX} dB (-40 quick, -60 accurate)`);
    else if (end < END_DB_MIN) error("simulation.end_criteria_db", "end-criterion", `${g(end)} dB is below the ${END_DB_MIN} dB limit that runs accept`);
  }
  const rawMesh = d.mesh ?? ({} as Design["mesh"]);
  if (rawMesh.mode === "manual") {
    const resolved: Partial<Record<Axis, number[]>> = {};
    for (const axis of AXES) {
      const lines = rawMesh.lines?.[axis];
      if (!Array.isArray(lines)) { error(`mesh.lines.${axis}`, "mesh-lines", "manual mesh needs a line list for each axis"); continue; }
      const values = lines.map((line, i) => ev(`mesh.lines.${axis}[${i}]`, line));
      if (values.some((v) => v === null)) continue;
      const nums = values as number[];
      resolved[axis] = nums;
      if (nums.length < 2) error(`mesh.lines.${axis}`, "mesh-lines", "manual mesh needs at least two lines per axis");
      for (let i = 1; i < nums.length; i++) if (!(nums[i] > nums[i - 1])) {
        error(`mesh.lines.${axis}`, "mesh-lines", "manual mesh lines must be sorted and strictly unique"); break;
      }
    }
    const extents: [number, number][] = AXES.map((a) => [resolved[a]?.[0] ?? Infinity, resolved[a]?.at(-1) ?? -Infinity]);
    const include = (point: number[]) => point.forEach((v, k) => { if (Number.isFinite(v)) { extents[k][0] = Math.min(extents[k][0], v); extents[k][1] = Math.max(extents[k][1], v); } });
    const number = (v: Expr) => { try { return evaluate(v, names); } catch { return NaN; } };
    // Coordinate bounds are conservative; the server checks the resolved geometry after transforms.
    // A transformed part is left to the server: its drawn coordinates are not where it is built.
    for (const part of d.parts ?? []) if (!part.transforms?.length) for (const pr of part.primitives ?? []) {
      if ("start" in pr && "stop" in pr) { include(pr.start.map(number)); include(pr.stop.map(number)); }
      else if (pr.kind === "polygon" || pr.kind === "linpoly") {
        const k = AXES.indexOf(pr.normal), u = (k + 1) % 3, v = (k + 2) % 3;
        for (const p of pr.points) {
          const q = [0, 0, 0]; q[k] = number(pr.elevation); q[u] = number(p[0]); q[v] = number(p[1]); include(q);
          if (pr.kind === "linpoly") { q[k] += number(pr.length); include(q); }
        }
      } else if (pr.kind === "cylinder" || pr.kind === "cone") {
        const k = AXES.indexOf(pr.axis), u = (k + 1) % 3, v = (k + 2) % 3;
        const r = pr.kind === "cylinder" ? number(pr.radius) : Math.max(number(pr.bottom_radius), number(pr.top_radius));
        for (const z of pr.range) for (const sign of [-1, 1]) { const q = [0, 0, 0]; q[k] = number(z); q[u] = number(pr.center[0]) + sign * r; q[v] = number(pr.center[1]) + sign * r; include(q); }
      } else if (pr.kind === "sphere" || pr.kind === "torus") {
        const c = pr.center.map(number); const r = pr.kind === "sphere" ? number(pr.radius) : number(pr.major_radius) + number(pr.minor_radius);
        include(c.map((v) => v-r)); include(c.map((v) => v+r));
      } else if (pr.kind === "wire") for (const p of pr.points) include(p.map(number));
      else if (pr.kind === "polyhedron") for (const p of pr.vertices) include(p.map(number));
    }
    for (const axis of AXES) {
      const lines = resolved[axis]; if (!lines?.length) continue;
      if (extents[AXES.indexOf(axis)][0] < lines[0] - 1e-6 || extents[AXES.indexOf(axis)][1] > lines.at(-1)! + 1e-6)
        error(`mesh.lines.${axis}`, "expr", `manual mesh extent must contain the model on ${axis}`);
    }
    (d.ports ?? []).flatMap((port, i) => portFeedEntries(port, `ports[${i}]`)).forEach(([w, port]) => { for (const end of ["start", "stop"] as const) {
      const coords = port[end].map((v) => { try { return evaluate(v, names); } catch { return NaN; } });
      AXES.forEach((axis, k) => { const lines = resolved[axis]; if (lines && Number.isFinite(coords[k]) && !lines.some((line) => Math.abs(line-coords[k]) <= 1e-6)) error(`${w}.${end}[${k}]`, "expr", `port ${end} coordinate must lie on a manual ${axis} mesh line (within 1e-6 mm)`); });
    }});
  }
  const mesh = rawMesh.mode === "manual" ? {} : rawMesh.mode === "design" ? { ...rawMesh.overrides } : rawMesh;
  const cpw = rawMesh.mode === "design" && mesh.cells_per_wavelength == null ? null : ev("mesh.cells_per_wavelength", mesh.cells_per_wavelength ?? 20);
  if (cpw !== null && cpw <= 0) error("mesh.cells_per_wavelength", "cells-per-wavelength", "cells per wavelength must be > 0");
  else if (cpw !== null && cpw < 10) warn("mesh.cells_per_wavelength", "cells-per-wavelength", `${g(cpw)} cells per wavelength is coarse; FDTD needs about 15 or more for usable accuracy`);
  if (mesh.pad !== undefined && mesh.pad !== null) {
    const pad = ev("mesh.pad", mesh.pad);
    if (pad !== null && pad < 0) error("mesh.pad", "expr", "pad must be >= 0");
  }
  if (mesh.edge_rule !== undefined && mesh.edge_rule !== "thirds" && mesh.edge_rule !== "edge") error("mesh.edge_rule", "expr", "edge rule must be thirds or edge");
  if (mesh.max_ratio !== undefined) {
    const ratio = ev("mesh.max_ratio", mesh.max_ratio);
    if (ratio !== null && (!Number.isFinite(ratio) || ratio <= 1)) error("mesh.max_ratio", "expr", "maximum cell ratio must be finite and > 1");
  }
  if (mesh.air_cells_per_wavelength !== undefined && mesh.air_cells_per_wavelength !== null) {
    const airCpw = ev("mesh.air_cells_per_wavelength", mesh.air_cells_per_wavelength);
    if (airCpw !== null && (airCpw <= 0 || (cpw !== null && airCpw > cpw)))
      error("mesh.air_cells_per_wavelength", "cells-per-wavelength", "air cells per wavelength must be > 0 and no greater than the metal and dielectric setting");
  }
  const ff = d.far_field ?? { enabled: true };
  if (ff.enabled !== false) {
    if (ff.phase_center !== undefined) {
      if (!Array.isArray(ff.phase_center) || ff.phase_center.length !== 3) error("far_field.phase_center", "expr", "expected a list of 3 values");
      else {
        const center = ff.phase_center.map((v, k) => ev(`far_field.phase_center[${k}]`, v));
        if (center.some((v) => v !== null && !Number.isFinite(v))) error("far_field.phase_center", "expr", "phase center coordinates must be finite");
      }
    }
    if (ff.faces !== undefined && (!Array.isArray(ff.faces) || ff.faces.length !== 6 || !ff.faces.every((v) => typeof v === "boolean") || !ff.faces.some(Boolean)))
      error("far_field.faces", "expr", "faces is 6 true/false flags (x-, x+, y-, y+, z-, z+), at least one true");
    else if (ff.faces !== undefined) {
      const bounds = d.simulation?.boundaries;
      const walls = Array.isArray(bounds) ? bounds : bounds === undefined ? [] : Array(6).fill(bounds);
      ["x-", "x+", "y-", "y+", "z-", "z+"].forEach((name, k) => {
        if (ff.faces![k] && String(walls[k] ?? "").toUpperCase() === "PEC")
          warn(`far_field.faces[${k}]`, "nf2ff-pec", `the far-field box face ${name} is on, but that boundary is PEC: the box skips a face on a PEC wall`);
      });
    }
    (ff.frequencies ?? []).forEach((f, k) => {
      const v = ev(`far_field.frequencies[${k}]`, f);
      if (v !== null && band && !(band[0] - 1e-9 <= v && v <= band[1] + 1e-9)) error(`far_field.frequencies[${k}]`, "ff-band", `${g(v)} GHz is outside the simulated band ${g(band[0])}–${g(band[1])} GHz`);
    });
  }
  const eff = (d as Design & { monitors?: { efficiency?: { points?: unknown } } }).monitors?.efficiency;
  if (eff && typeof eff === "object" && !Array.isArray(eff)) {
    const n = eff.points === undefined ? EFFICIENCY_POINTS_DEFAULT : eff.points;
    if (!(isNum(n) && Number.isInteger(n) && n >= EFFICIENCY_POINTS_MIN && n <= EFFICIENCY_POINTS_MAX))
      error("monitors.efficiency.points", "monitor-efficiency", `the number of frequencies is a whole number from ${EFFICIENCY_POINTS_MIN} to ${EFFICIENCY_POINTS_MAX}`);
    if (ff.enabled === false) error("monitors.efficiency", "monitor-efficiency", "the efficiency over the band needs the far field: turn the far field on or remove this monitor");
  }
  // field planes (the position against the simulation domain is a server check: field-plane-position)
  const planes = (d as Design & { monitors?: { field_planes?: DesignFieldPlane[] } }).monitors?.field_planes ?? [];
  if (planes.length > FIELD_PLANES_MAX) error("monitors.field_planes", "field-plane", `${planes.length} field planes: use at most ${FIELD_PLANES_MAX} (each map adds to the run's memory and result)`);
  planes.forEach((pl, k) => {
    const w = `monitors.field_planes[${k}]`;
    ev(`${w}.position`, pl.position);
    const freqs = pl.frequencies ?? [];
    if (!freqs.length) error(`${w}.frequencies`, "field-plane", "a field plane needs at least one frequency");
    else if (freqs.length > FIELD_PLANE_FREQS_MAX) error(`${w}.frequencies`, "field-plane", `${freqs.length} frequencies: a field plane records at most ${FIELD_PLANE_FREQS_MAX}`);
    freqs.forEach((f, j) => {
      const v = ev(`${w}.frequencies[${j}]`, f);
      if (v !== null && band && !(band[0] - 1e-9 <= v && v <= band[1] + 1e-9)) error(`${w}.frequencies[${j}]`, "field-plane", `${g(v)} GHz is outside the simulated band ${g(band[0])}–${g(band[1])} GHz`);
    });
  });

  // ---- ports and resistors
  const ports = d.ports ?? [];
  if (!ports.length) error("ports", "no-port", "the design has no port: nothing is excited and there is no S11; add a port before running");
  else if (!ports.some((po) => po.excite !== false)) error("ports", "no-port", "no port is excited: mark at least one port as excited (driven) before running");
  const boxes: [number, number[][], number][] = [];
  ports.flatMap((port, i) => portFeedEntries(port, `ports[${i}]`).map(([w, po]) => ({ i, w, po }))).forEach(({ i, w, po }) => {
    const wg = po.type === "waveguide";
    let size: [number, number] | null = null;
    if (wg) {
      const mode = wgMode(po.mode ?? "TE10");
      if (!mode) error(`${w}.mode`, "wg-mode", `'${po.mode}' is not a rectangular waveguide mode: write TEmn, e.g. TE10 (openEMS excites TE modes only)`);
      const wa = ev(`${w}.a`, po.a), wb = ev(`${w}.b`, po.b);
      if (wa !== null && wa <= 0) error(`${w}.a`, "wg-size", "the waveguide width a must be > 0");
      if (wb !== null && wb <= 0) error(`${w}.b`, "wg-size", "the waveguide height b must be > 0");
      if (wa !== null && wb !== null && wa > 0 && wb > 0) {
        size = [wa, wb];
        if (mode && band) {
          const fc = wgCutoffGHz(mode[0], mode[1], wa, wb), name = `TE${mode[0]}${mode[1]}`;
          if (fc >= band[1]) error(`${w}.a`, "wg-cutoff", `the ${name} mode is cut off in the whole band: its cut-off is ${Number(fc.toPrecision(4))} GHz, above f max ${g(band[1])} GHz (widen the guide or raise the band)`);
          else if (fc > band[0]) warn(`${w}.a`, "wg-cutoff", `below the ${name} cut-off (${Number(fc.toPrecision(4))} GHz) the mode does not propagate: the S-parameters under ${Number(fc.toPrecision(4))} GHz are not meaningful (raise f min above it)`);
        }
      }
    } else if (w === `ports[${i}]`) {
      const r = ev(`${w}.R`, po.R ?? 50);
      if (r !== null && r <= 0) error(`${w}.R`, "port-r", "the port impedance must be > 0 Ω");
      if (po.reference_impedance) {
        const re = ev(`${w}.reference_impedance.real`, po.reference_impedance.real);
        ev(`${w}.reference_impedance.imag`, po.reference_impedance.imag);
        if (re !== null && re <= 0) error(`${w}.reference_impedance.real`, "port-r", "power-wave reference real part must be > 0 Ω");
      }
    }
    const a = vec(`${w}.start`, po.start), c = vec(`${w}.stop`, po.stop);
    if (!a || !c) return;
    const k = AXES.indexOf(po.direction);
    if (wg) {
      if (Math.abs(c[k] - a[k]) < EPS && po.excite !== false) error(`${w}.stop[${k}]`, "port-length", `an excited waveguide port needs a length along ${po.direction}: the excitation is at start, the mode probes at stop (a cell or more further)`);
      if (size) {
        const [u, v] = inPlane(k), du = Math.abs(c[u] - a[u]), dv = Math.abs(c[v] - a[v]);
        if (Math.abs(du - size[0]) > 1e-6 * Math.max(1, size[0]) || Math.abs(dv - size[1]) > 1e-6 * Math.max(1, size[1]))
          warn(`${w}.stop`, "wg-aperture", `the port spans ${g(du)} × ${g(dv)} mm across ${po.direction} but the mode is set for a = ${g(size[0])} (along ${AXES[u]}) × b = ${g(size[1])} (along ${AXES[v]}): the excited field would not fit the guide`);
      }
    } else if (Math.abs(c[k] - a[k]) < EPS) error(`${w}.stop[${k}]`, "port-length", `the port has no length along its direction ${po.direction}: start and stop must differ in ${po.direction}`);
    else {
      const [u, v] = inPlane(k);
      if (Math.abs(c[u] - a[u]) >= EPS && Math.abs(c[v] - a[v]) >= EPS)
        warn(`${w}.stop`, "port-volume", `the port has extent across its direction in both ${AXES[u]} and ${AXES[v]} (a volume); a lumped port is a line (a probe) or a sheet (a strip feed)`);
    }
    const box = [[0, 1, 2].map((q) => Math.min(a[q], c[q])), [0, 1, 2].map((q) => Math.max(a[q], c[q]))];
    for (const [j, o, otherK] of boxes) {
      const atEnd = (axis: number, bounds: number[][]) => {
        const lo = Math.max(box[0][axis], o[0][axis]), hi = Math.min(box[1][axis], o[1][axis]);
        return hi - lo <= EPS && Math.min(...bounds.map((end) => Math.abs(lo - end[axis]))) <= EPS;
      };
      if ([0, 1, 2].every((q) => box[0][q] <= o[1][q] + EPS && o[0][q] <= box[1][q] + EPS)
          && (j !== i || !(atEnd(k, box) && atEnd(otherK, o))))
        error(`${w}.start`, "port-overlap", `port ${po.number} overlaps port ${ports[j].number}`);
    }
    boxes.push([i, box, k]);
  });
  (d.resistors ?? []).forEach((re, i) => {
    const w = `resistors[${i}]`;
    if (![re.R, re.L, re.C].some((v) => v !== undefined)) error(`${w}.R`, "resistor-r", "at least one R, L or C value is required");
    for (const key of ["R", "L", "C"] as const) {
      if (re[key] === undefined) continue;
      const value = ev(`${w}.${key}`, re[key]);
      if (value !== null && value <= 0) error(`${w}.${key}`, "resistor-r", key === "R" ? "the resistance must be > 0 Ω" : "lumped values must be > 0");
    }
    if (re.topology !== undefined && !["parallel", "series"].includes(re.topology)) error(`${w}.topology`, "resistor-r", "topology must be parallel or series");
    const a = vec(`${w}.start`, re.start), c = vec(`${w}.stop`, re.stop);
    const k = AXES.indexOf(re.direction);
    if (a && c && Math.abs(c[k] - a[k]) < EPS) error(`${w}.stop[${k}]`, "resistor-length", `the resistor has no length along its direction ${re.direction}`);
  });
  return out;
}

/** (m, n) of a rectangular waveguide mode "TEmn" (design.wg_mode), or null. */
export function wgMode(mode: unknown): [number, number] | null {
  const m = typeof mode === "string" ? /^TE(\d)(\d)$/.exec(mode) : null;
  return !m || (m[1] === "0" && m[2] === "0") ? null : [Number(m[1]), Number(m[2])];
}

/** Cut-off (GHz) of the TE_mn mode of an a × b mm air-filled guide (design.wg_cutoff_ghz). */
export function wgCutoffGHz(m: number, n: number, a: number, b: number): number {
  return (299.792458 / 2) * Math.hypot(m / a, n / b);
}

/** Fewer than 3 distinct points, zero area or self-intersections (design_checks.polygon_problems). */
export function polygonProblems(uv: number[][]): [string, string][] {
  const pts: number[][] = [];
  for (const q of uv) if (!pts.length || Math.abs(q[0] - pts[pts.length - 1][0]) > EPS || Math.abs(q[1] - pts[pts.length - 1][1]) > EPS) pts.push(q);
  if (pts.length > 1 && Math.abs(pts[0][0] - pts[pts.length - 1][0]) <= EPS && Math.abs(pts[0][1] - pts[pts.length - 1][1]) <= EPS) pts.pop();
  const r9 = (x: number) => Math.round(x * 1e9) / 1e9;
  if (new Set(pts.map(([x, y]) => `${r9(x)},${r9(y)}`)).size < 3) return [["polygon-points", "a polygon needs at least 3 distinct points"]];
  const [x0, y0] = pts[0];
  let far = pts[0], best = -1;
  for (const q of pts) {
    const dd = (q[0] - x0) ** 2 + (q[1] - y0) ** 2;
    if (dd > best) { best = dd; far = q; }
  }
  const [fx, fy] = far;
  const span2 = (fx - x0) ** 2 + (fy - y0) ** 2;
  if (pts.every(([x, y]) => Math.abs((fx - x0) * (y - y0) - (fy - y0) * (x - x0)) <= 1e-9 * span2)) return [["polygon-area", "the polygon has zero area (its points are on one line)"]];
  const n = pts.length;
  if (n <= 400) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (j === i + 1 || (i === 0 && j === n - 1)) continue;
        if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return [["polygon-self-intersect", `the outline crosses itself (edges ${i + 1}–${i + 2} and ${j + 1}–${((j + 1) % n) + 1})`]];
      }
    }
  }
  return [];
}

function segmentsCross(p1: number[], p2: number[], p3: number[], p4: number[]): boolean {
  const orient = (a: number[], b: number[], c: number[]) => {
    const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return Math.abs(v) < 1e-12 ? 0 : v > 0 ? 1 : -1;
  };
  const onSeg = (a: number[], b: number[], c: number[]) =>
    Math.min(a[0], b[0]) - EPS <= c[0] && c[0] <= Math.max(a[0], b[0]) + EPS && Math.min(a[1], b[1]) - EPS <= c[1] && c[1] <= Math.max(a[1], b[1]) + EPS;
  const o1 = orient(p1, p2, p3), o2 = orient(p1, p2, p4), o3 = orient(p3, p4, p1), o4 = orient(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4 && o1 * o2 <= 0 && o3 * o4 <= 0) return true;
  return (o1 === 0 && onSeg(p1, p2, p3)) || (o2 === 0 && onSeg(p1, p2, p4)) || (o3 === 0 && onSeg(p3, p4, p1)) || (o4 === 0 && onSeg(p3, p4, p2));
}

/** Live checks plus the server's checks for what only the server can tell (a floating feed, a
 * hidden part, the mesh, a failed build), errors first. */
export function mergeChecks(live: Check[], server: Check[]): Check[] {
  // a live check takes the server's fix when only the server can make it (the probe port a design
  // without one needs comes from the resolved geometry), matched by code and field
  const fixes = new Map(server.filter((c) => c.fix).map((c) => [`${c.code}|${c.path}`, c.fix!]));
  const all = [...live.map((c) => (c.fix || !fixes.has(`${c.code}|${c.path}`) ? c : { ...c, fix: fixes.get(`${c.code}|${c.path}`) })),
    ...server.filter((c) => !CHEAP.has(c.code))];
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return all.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
