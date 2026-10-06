// Bundle validation on open. A bundle comes from disk, a drag-and-drop or the run server, so it is
// untrusted input: this checks the schema prefix, the keys the viewer cannot work without and the
// consistency of the numeric arrays, and repairs what can be repaired (dropping a broken far-field
// entry, results with mismatched arrays, a surface-current plane of the wrong size, ...). The viewer
// then opens the repaired bundle and lists every problem in a banner instead of crashing.
// Pure TypeScript without DOM access, so scripts/check-bundles.mjs can fuzz it in Node.
import type { Bundle } from "../types";
import { ENC_F32, ENC_I16 } from "./sparams.ts";
import { currentSchema, schemaFamily } from "./legacy.ts";
import { portGroupProblem } from "./portGroups.ts";
// messages shown in the UI (load errors and warnings), in the language of the moment
import { t as msg } from "../i18n/index.ts";

export interface Validation {
  /** repaired bundle, or null when it cannot be opened at all */
  bundle: Bundle | null;
  /** reasons the bundle was refused */
  errors: string[];
  /** problems that were repaired or ignored; the bundle opens with these listed */
  warnings: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** geometry coordinates in drawing units (mm): finite and within ±1e6 (1 km). Larger values are
 * garbage and would make mesh/hatch/dimension loops explode. */
const LIMIT = 1e6;
const isCoord = (v: unknown): v is number => isNum(v) && Math.abs(v) < LIMIT;
const isVec3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(isCoord);
const isBox = (v: unknown) => Array.isArray(v) && v.length === 2 && isVec3(v[0]) && isVec3(v[1]);
const isMatrix4 = (v: unknown) => {
  if (!Array.isArray(v) || v.length !== 4 || v.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(isCoord))) return false;
  const m = v as number[][];
  if (m[3].some((x, i) => Math.abs(x - (i === 3 ? 1 : 0)) > 1e-12)) return false;
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return Number.isFinite(det) && det !== 0;
};
const isMinMax = (v: unknown) => isObj(v) && isVec3(v.min) && isVec3(v.max);
const isPt2 = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(isCoord);
const exactLocalKinds = new Set(["box", "cylinder", "cylindricalshell", "sphere", "polygon", "linpoly", "curve", "wire", "rotpoly", "polyhedron"]);
/** geometry the 3D view and the drawing rebuild exactly: each kind needs its own fields */
function primitiveOk(q: unknown): boolean {
  if (!isObj(q) || !isBox(q.bbox) || typeof q.kind !== "string") return false;
  switch (q.kind) {
    case "box":
      return isVec3(q.start) && isVec3(q.stop);
    case "cylinder":
      return isVec3(q.start) && isVec3(q.stop) && isCoord(q.radius) && (q.radius as number) > 0;
    case "cylindricalshell":
      // radius: the middle of the wall; the inner radius (radius - width / 2) must not be negative
      return isVec3(q.start) && isVec3(q.stop) && isCoord(q.radius) && isCoord(q.shell_width) &&
        (q.shell_width as number) > 0 && (q.radius as number) - (q.shell_width as number) / 2 >= -1e-9;
    case "sphere":
      return isVec3(q.center) && isCoord(q.radius) && (q.radius as number) > 0;
    case "polygon":
    case "linpoly":
      return [0, 1, 2].includes(q.normal as number) && isCoord(q.elevation) && Array.isArray(q.points) && q.points.length >= 3 && q.points.every(isPt2) && (q.length === undefined || isCoord(q.length));
    case "curve":
    case "wire":
      return Array.isArray(q.points) && q.points.length >= 2 && q.points.length <= 100_000 && q.points.every(isVec3) &&
        (q.radius === undefined || (isCoord(q.radius) && (q.radius as number) >= 0));
    case "rotpoly":
      // a full turn about a principal axis; the profile stays on the near side of the axis
      return [0, 1, 2].includes(q.axis as number) && isVec3(q.origin) && Array.isArray(q.points) && q.points.length >= 3 &&
        q.points.length <= 100_000 && q.points.every((p) => isPt2(p) && (p as number[])[0] >= -1e-9);
    case "polyhedron": {
      const v = q.vertices, f = q.faces;
      if (!Array.isArray(v) || v.length < 4 || v.length > 100_000 || !v.every(isVec3) || !Array.isArray(f) || f.length < 4 || f.length > 200_000) return false;
      return f.every((face) => Array.isArray(face) && face.length >= 3 && face.every((i) => Number.isInteger(i) && i >= 0 && i < v.length));
    }
    case "transformed":
      return isMatrix4(q.matrix) && isObj(q.primitive) && q.primitive.kind !== "transformed" &&
        exactLocalKinds.has(String(q.primitive.kind)) && q.exact === true && primitiveOk(q.primitive);
    default:
      return true; // bbox fallback ("exact: false") or a future kind: drawn from its bbox
  }
}
/** text fields shown in panels, the drawing title block and exports: coerce to strings */
function str(o: Obj, key: string, fallback = "") {
  const v = o[key];
  if (typeof v !== "string") o[key] = v === null || v === undefined || typeof v === "object" ? fallback : String(v);
}

/** Coerce an array to numbers in place: finite numbers stay, anything else ("NaN", null, strings)
 * becomes NaN, which the charts skip. Returns how many entries were not finite numbers. */
function numeric(arr: unknown[]): number {
  let bad = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!isNum(v)) {
      bad++;
      arr[i] = typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : NaN;
    }
  }
  return bad;
}

export function validateBundle(raw: unknown): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (): Validation => ({ bundle: null, errors, warnings });

  if (!isObj(raw)) {
    errors.push(msg("validate.notObject"));
    return fail();
  }
  const b = raw as Obj;
  const rawSchema = String(b.schema ?? "");
  // a bundle with the older schema id opens as before; its id becomes the current one (src/lib/legacy.ts)
  const schema = String(currentSchema(rawSchema));
  if (!schemaFamily(schema, "fairbeam.project/")) {
    errors.push(msg("validate.notBundle", { schema: schema || "missing" }));
    return fail();
  }
  if (schema !== "fairbeam.project/1") warnings.push(msg("validate.newerSchema", { schema }));
  b.schema = schema;

  // ---- keys the viewer cannot work without
  if (!isObj(b.model) || typeof b.model.id !== "string") errors.push(msg("validate.noModelId"));
  if (!Array.isArray(b.parts)) errors.push(msg("validate.noParts"));
  const mesh = b.mesh;
  if (!isObj(mesh)) errors.push(msg("validate.noMesh"));
  else
    for (const ax of ["x", "y", "z"] as const) {
      const lines = mesh[ax];
      if (!Array.isArray(lines) || lines.length < 2) errors.push(msg("validate.meshLines", { ax }));
      else if (numeric(lines) || !lines.every(isCoord)) errors.push(msg("validate.meshNumbers", { ax }));
      else if (lines.length > 20000) errors.push(msg("validate.meshTooMany", { ax, lines: lines.length }));
    }
  if (!isMinMax(b.domain)) errors.push(msg("validate.noDomain"));
  if (!isObj(b.solver) || !isObj((b.solver as Obj).excitation)) errors.push(msg("validate.noSolver"));
  if (errors.length) return fail();

  // ---- repairable parts
  const model = b.model as Obj;
  str(model, "name", String(model.id));
  str(model, "description");
  if (model.reference !== undefined) str(model, "reference");
  if (!Array.isArray(model.params)) {
    if (model.params !== undefined) warnings.push(msg("validate.paramsNotList"));
    model.params = [];
  }
  model.params = (model.params as unknown[]).filter((p) => isObj(p) && typeof p.key === "string");
  for (const p of model.params as Obj[]) {
    str(p, "label", p.key as string);
    str(p, "unit");
    str(p, "description");
    for (const k of ["value", "default"]) if (!isNum(p[k]) && typeof p[k] !== "string") p[k] = String(p[k] ?? "");
    for (const k of ["minimum", "maximum"]) if (!isNum(p[k])) p[k] = null;
  }
  str(b, "name", String(model.name));
  str(b, "created");
  if (!isObj(b.generator)) b.generator = {};
  const gen = b.generator as Obj;
  str(gen, "name", "fairbeam");
  str(gen, "version", "?");
  str(gen, "python", "?");
  for (const k of ["openems", "csxcad"]) if (gen[k] !== null && typeof gen[k] !== "string") gen[k] = null;
  if (!isObj(b.units)) b.units = { length: "mm", length_m: 1e-3, frequency: "Hz" };
  else {
    // the length unit scales every exported coordinate; an absurd or non-numeric one would make
    // the exports throw (non-finite coordinates), so fall back to millimetres
    const u = b.units as Obj;
    if (!isNum(u.length_m) || u.length_m < 1e-9 || u.length_m > 1e3) {
      u.length = "mm";
      u.length_m = 1e-3;
      warnings.push(msg("validate.unitsMalformed"));
    }
  }
  const solver = b.solver as Obj;
  str(solver, "engine", "openEMS");
  str(solver, "method", "FDTD");
  const ex = solver.excitation as Obj;
  str(ex, "type", "gaussian-derivative");
  if (!isNum(ex.f_min) || !isNum(ex.f_max) || (ex.f_max as number) <= (ex.f_min as number)) {
    const fr = isObj(b.results) && Array.isArray(b.results.frequency) ? (b.results.frequency as unknown[]).filter(isNum) : [];
    if (fr.length > 1) {
      ex.f_min = Math.min(...fr);
      ex.f_max = Math.max(...fr);
      warnings.push(msg("validate.bandMalformed"));
    } else {
      errors.push(msg("validate.noBand"));
      return fail();
    }
  }
  if (!isNum(solver.end_criteria_db)) solver.end_criteria_db = -40;
  if (!isNum(solver.max_timesteps)) solver.max_timesteps = 0;
  if (!isObj(solver.boundaries)) {
    warnings.push(msg("validate.noBoundaries"));
    solver.boundaries = {};
  }
  for (const k of ["x-", "x+", "y-", "y+", "z-", "z+"]) str(solver.boundaries as Obj, k, "?");

  const parts = b.parts as unknown[];
  const keptParts = parts.filter((p, i) => {
    const ok = isObj(p) && typeof p.name === "string" && Array.isArray(p.primitives) && isBox(p.bbox);
    if (!ok) {
      warnings.push(msg("validate.partMalformed", { part: isObj(p) && typeof p.name === "string" ? `"${p.name}"` : `#${i + 1}` }));
      return false;
    }
    const prims = p.primitives as unknown[];
    const good = prims.filter(primitiveOk);
    if (good.length < prims.length) warnings.push(msg("validate.primitives", { part: String(p.name), n: prims.length - good.length }));
    p.primitives = good;
    if (p.label !== undefined) str(p, "label", p.name as string);
    str(p, "type", "Metal");
    if (p.material !== undefined && !(isObj(p.material) && isNum(p.material.eps_r))) {
      warnings.push(msg("validate.material", { part: String(p.name) }));
      delete p.material;
    } else if (isObj(p.material)) for (const k of ["tan_d", "tan_d_freq"]) if (p.material[k] !== null && !isNum(p.material[k])) p.material[k] = null;
    if (p.conductor !== undefined && !(isObj(p.conductor) && isNum(p.conductor.conductivity) && (p.conductor.thickness === null || isNum(p.conductor.thickness)))) {
      warnings.push(msg("validate.conductor", { part: String(p.name) }));
      delete p.conductor;
    }
    return true;
  });
  b.parts = keptParts;
  if (!Array.isArray(b.ports)) {
    if (b.ports !== undefined) warnings.push(msg("validate.portsNotList"));
    b.ports = [];
  } else {
    const all = b.ports as unknown[];
    for (const [i, p] of all.entries()) if (isObj(p) && "group" in p) {
      const problem = portGroupProblem(p, `ports[${i}]`);
      const members = isObj(p.group) && Array.isArray(p.group.members) ? p.group.members : [];
      if (problem || !isVec3(p.start) || !isVec3(p.stop) || !isNum(p.R) || p.R <= 0
          || !isNum(p.number) || !Number.isInteger(p.number) || p.number < 1
          || all.some((other) => other !== p && isObj(other) && other.number === p.number)
          || !["x", "y", "z"].includes(p.direction as string)
          || members.some((m) => !isObj(m) || !isVec3(m.start) || !isVec3(m.stop))
          || [p, ...members].some((feed) => feed.start["xyz".indexOf(feed.direction)] === feed.stop["xyz".indexOf(feed.direction)]))
        return { bundle: null, errors: [msg("validate.groupedPort", { n: i + 1 })], warnings };
    }
    b.ports = all.filter((p) => isObj(p) && isVec3(p.start) && isVec3(p.stop) && isNum(p.R) && ["x", "y", "z"].includes(p.direction as string));
    if ((b.ports as unknown[]).length < all.length) warnings.push(msg("validate.ports", { n: all.length - (b.ports as unknown[]).length }));
    (b.ports as Obj[]).forEach((p, i) => { if (!isNum(p.number)) p.number = i + 1; });
  }
  for (const k of ["nf2ff_box", "focus"] as const) if (b[k] != null && !isMinMax(b[k])) (warnings.push(msg("validate.keyMalformed", { key: k })), (b[k] = null));
  if (isObj(b.nf2ff_box) && b.nf2ff_box.faces !== undefined) {
    const f = b.nf2ff_box.faces;
    if (!(Array.isArray(f) && f.length === 6 && f.every((v) => typeof v === "boolean"))) delete b.nf2ff_box.faces;
  }
  if (b.nf2ff_center != null && !isVec3(b.nf2ff_center)) b.nf2ff_center = null;
  if (b.half_space != null && !(isObj(b.half_space) && isNum(b.half_space.position))) (warnings.push(msg("validate.halfSpace")), (b.half_space = null));
  b.half_space ??= null;
  if (!isNum((mesh as Obj).total_cells)) (mesh as Obj).total_cells = ((mesh as Obj).x as unknown[]).length * ((mesh as Obj).y as unknown[]).length * ((mesh as Obj).z as unknown[]).length;
  if (b.run != null && !isObj(b.run)) (warnings.push(msg("validate.runStats")), (b.run = null));
  b.run ??= null;
  if (isObj(b.run)) {
    const run = b.run as Obj;
    if (!Array.isArray(run.energy_trace)) run.energy_trace = [];
    if (!Array.isArray(run.log_tail)) run.log_tail = [];
    if (!isObj(run.host)) run.host = { os: "?", machine: "?", cpu: null };
  }

  // ---- results: arrays must agree with the frequency axis
  if (b.results != null) {
    const r = b.results;
    const dropResults = (why: string) => {
      warnings.push(msg("validate.resultsIgnored", { why }));
      b.results = null;
    };
    if (!isObj(r)) dropResults(msg("validate.resultsNotObject"));
    else if (!Array.isArray(r.frequency) || r.frequency.length < 2) dropResults(msg("validate.noFrequency"));
    else {
      const n = r.frequency.length;
      const badF = numeric(r.frequency);
      if (badF) warnings.push(msg("validate.badFrequency", { n: badF }));
      const ports = isObj(r.ports) ? r.ports : {};
      let good = 0;
      for (const [key, pr] of Object.entries(ports)) {
        const fields = ["s11_re", "s11_im", "zin_re", "zin_im"] as const;
        const ok = isObj(pr) && fields.every((f) => Array.isArray(pr[f]));
        const lengths = ok ? fields.map((f) => (pr[f] as unknown[]).length) : [];
        if (!ok || lengths.some((l) => l !== n)) {
          warnings.push(msg("validate.portDropped", { port: key, why: ok ? msg("validate.portLengths", { lengths: [...new Set(lengths)].join("/"), n }) : msg("validate.portArraysMissing") }));
          delete ports[key];
          continue;
        }
        const bad = fields.reduce((m, f) => m + numeric(pr[f] as unknown[]), 0);
        if (bad) warnings.push(msg("validate.portNonNumeric", { port: key, n: bad }));
        if (!isNum(pr.z_ref)) pr.z_ref = 50;
        if (pr.z_ref_f !== undefined && !(Array.isArray(pr.z_ref_f) && pr.z_ref_f.length === n)) {
          warnings.push(msg("validate.portZref", { port: key }));
          delete pr.z_ref_f;
        } else if (Array.isArray(pr.z_ref_f)) numeric(pr.z_ref_f);
        good++;
      }
      r.ports = ports;
      if (!good && Object.keys(isObj(r.ports) ? r.ports : {}).length === 0 && !isObj(r.sparams)) dropResults(msg("validate.noPortData"));
      else {
        if (!Array.isArray(r.bands)) r.bands = [];
        r.bands = (r.bands as unknown[]).filter((x) => isObj(x) && isNum(x.f_center) && isNum(x.f_lo) && isNum(x.f_hi));
        if (!Array.isArray(r.farfield)) r.farfield = [];
        r.farfield = (r.farfield as unknown[]).filter((ff, i) => {
          const ok =
            isObj(ff) && isNum(ff.f) && Array.isArray(ff.theta) && Array.isArray(ff.phi) && Array.isArray(ff.directivity_dbi) &&
            ff.directivity_dbi.length === ff.theta.length &&
            (ff.directivity_dbi as unknown[]).every((row) => Array.isArray(row) && row.length === (ff.phi as unknown[]).length);
          if (!ok) {
            warnings.push(msg("validate.ffGrid", { n: i + 1 }));
            return false;
          }
          const bad = numeric(ff.theta as unknown[]) + numeric(ff.phi as unknown[]) + (ff.directivity_dbi as unknown[][]).reduce((m, row) => m + numeric(row), 0);
          if (bad) warnings.push(msg("validate.ffNonNumeric", { n: i + 1, bad }));
          if (!isNum(ff.dmax_dbi)) ff.dmax_dbi = Math.max(...(ff.directivity_dbi as number[][]).flat().filter(Number.isFinite), -100);
          if (ff.rad_efficiency !== null && !isNum(ff.rad_efficiency)) ff.rad_efficiency = null;
          if (ff.qa_warnings !== undefined && !(Array.isArray(ff.qa_warnings) && ff.qa_warnings.every((w) => typeof w === "string"))) delete ff.qa_warnings;
          if (ff.cp !== undefined) {
            const cp = ff.cp;
            const grid = (g: unknown) => Array.isArray(g) && g.length === (ff.theta as unknown[]).length &&
              g.every((row) => Array.isArray(row) && row.length === (ff.phi as unknown[]).length);
            const pt = (x: unknown) => isObj(x) && isNum(x.rhcp_dbi) && isNum(x.lhcp_dbi) && isNum(x.axial_ratio_db);
            if (!(isObj(cp) && grid(cp.rhcp_dbi) && grid(cp.lhcp_dbi) && grid(cp.axial_ratio_db) && pt(cp.peak) && pt(cp.boresight))) {
              warnings.push(msg("validate.ffCircular", { n: i + 1 }));
              delete ff.cp;
            } else for (const k of ["rhcp_dbi", "lhcp_dbi", "axial_ratio_db"]) for (const row of cp[k] as unknown[][]) numeric(row);
          }
          return true;
        });
        const sig = r.signals;
        if (isObj(sig) && "time_ns" in sig) {
          const keys = ["time_ns", "u_inc", "u_ref"] as const;
          const ok = keys.every((k) => Array.isArray(sig[k])) && keys.every((k) => (sig[k] as unknown[]).length === (sig.time_ns as unknown[]).length);
          if (!ok) {
            warnings.push(msg("validate.portSignals"));
            r.signals = {};
          } else keys.forEach((k) => numeric(sig[k] as unknown[]));
        } else if (!isObj(sig)) r.signals = {};
        // compact element patterns: both encodings are read (docs/BUNDLE.md#element-pattern-encodings)
        const ep = r.element_patterns;
        if (isObj(ep) && "encoding" in ep) {
          if (ep.encoding !== ENC_F32 && ep.encoding !== ENC_I16) {
            warnings.push(msg("validate.elementEncoding", { encoding: JSON.stringify(ep.encoding), known: `${ENC_I16}, ${ENC_F32}` }));
            delete r.element_patterns;
          } else if (ep.encoding === ENC_I16 && Array.isArray(ep.ports)) {
            const noScale = (ep.ports as unknown[]).reduce<number>((m, p) =>
              m + (isObj(p) && Array.isArray(p.fields) ? (p.fields as unknown[]).filter((e) => !isObj(e) || !isNum(e.scale)).length : 0), 0);
            if (noScale) warnings.push(msg("validate.elementScale", { count: noScale }));
          }
        }
      }
    }
  } else b.results = null;

  // ---- optional surface-current maps
  if (b.fields != null) {
    const fs = b.fields;
    if (!isObj(fs) || !Array.isArray(fs.planes)) {
      warnings.push(msg("validate.currentsMalformed"));
      delete b.fields;
    } else {
      fs.planes = (fs.planes as unknown[]).filter((pl, i) => {
        const ok =
          isObj(pl) && Number.isInteger(pl.nu) && Number.isInteger(pl.nv) && Array.isArray(pl.frequencies) &&
          (pl.frequencies as unknown[]).every((fr) => isObj(fr) && Array.isArray(fr.values) && fr.values.length === (pl.nu as number) * (pl.nv as number));
        if (!ok) warnings.push(msg("validate.currentPlane", { plane: isObj(pl) && pl.name ? `"${pl.name}"` : i + 1 }));
        return ok;
      });
      // the driven port of the recording run (#90); anything but a port number is unknown, not port 1
      if (fs.port !== undefined && !(Number.isInteger(fs.port) && (fs.port as number) > 0)) {
        warnings.push(msg("validate.currentsPort"));
        delete fs.port;
      }
      // no usable plane left: no current result (the layer and the ribbon action stay unavailable)
      if (!(fs.planes as { frequencies: unknown[] }[]).some((pl) => pl.frequencies.length)) delete b.fields;
    }
  }

  // ---- optional E/H field maps on cut planes
  if (b.field_planes != null) {
    if (!Array.isArray(b.field_planes)) {
      warnings.push(msg("validate.planesMalformed"));
      delete b.field_planes;
    } else {
      b.field_planes = (b.field_planes as unknown[]).filter((m, i) => {
        const ok = isObj(m) && (m.quantity === "E" || m.quantity === "H") && [0, 1, 2].includes(m.axis as number) &&
          Number.isInteger(m.nu) && Number.isInteger(m.nv) && (m.nu as number) > 1 && (m.nv as number) > 1 &&
          isNum(m.f) && isNum(m.position_mm) && Array.isArray(m.u_range) && Array.isArray(m.v_range) &&
          Array.isArray(m.magnitude) && m.magnitude.length === m.nv &&
          (m.magnitude as unknown[]).every((row) => Array.isArray(row) && row.length === m.nu);
        if (!ok) warnings.push(msg("validate.fieldPlane", { n: i + 1 }));
        // the optional complex components: a bad one costs the phase and the animation, not the map
        if (ok && (m as Record<string, unknown>).phasor !== undefined && !validPhasor(m as Record<string, unknown>)) {
          warnings.push(msg("validate.fieldPlanePhasor", { n: i + 1 }));
          delete (m as Record<string, unknown>).phasor;
        }
        return ok;
      });
      if (!(b.field_planes as unknown[]).length) delete b.field_planes;
    }
  }

  return { bundle: b as unknown as Bundle, errors, warnings };
}

/** A field-plane map's phasor (docs/BUNDLE.md "field_planes"): the components its map needs, a
 * positive peak and exactly nu · nv · components · 2 int8 values of base64. */
function validPhasor(m: Record<string, unknown>): boolean {
  const p = m.phasor;
  if (!isObj(p) || !Array.isArray(p.components) || typeof p.data !== "string" || !(isNum(p.peak) && (p.peak as number) > 0)) return false;
  const want = m.component === "x" || m.component === "y" || m.component === "z" ? [m.component] : ["x", "y", "z"];
  const have = p.components as unknown[];
  if (have.length !== want.length || !want.every((c, k) => have[k] === c)) return false;
  const text = p.data as string;
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return false;
  const bytes = (text.length / 4) * 3 - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0);
  return bytes === (m.nu as number) * (m.nv as number) * want.length * 2;
}

/** One-line summary for a banner: the first problems and how many more. */
export function summarize(problems: string[], max = 3): string {
  const shown = problems.slice(0, max).join(" ");
  return problems.length > max ? msg("validate.more", { shown, n: problems.length - max }) : shown;
}
