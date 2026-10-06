// Checks for the visual designer: the browser and the server must agree, and the designer's
// shapes must survive every consumer of a bundle.
//
//   node --experimental-strip-types scripts/check-designer.mjs
//
// 1. Expression parity: the shared expressions in python/tests/fixtures/designer_parity.json,
//    evaluated by src/designer/expr.ts and by python/fairbeam/design.py (spawned), against the
//    fixture's values; also plain NaN / Infinity numbers, refused on both sides.
// 2. Check parity: every fixture case (an edit of the blank design) through src/designer/checks.ts
//    and python/fairbeam/design_checks.py: the TypeScript checks must equal the Python ones for the
//    cheap codes, and both the fixture's expectations. The two CHEAP code lists must match.
// 2c. One end-criterion policy (checks.ts, design_checks.py and the Solver field agree), numeric
//    parameter limits (checks.ts parseLimit) and the mesh cell count of src/designer/meshStats.ts
//    (intervals between lines, the server's total_cells); the time estimate stays on openEMS's own
//    "FDTD cells" (the line product), the unit of the MCells/s rates it divides by.
// 2a. Instant-preview parity: src/designer/geometry.ts (quickBundle) reproduces design.py's resolved
//    shapes (cones, tori, wires, cut sheets, transforms) and waveguide ports for the fixture's
//    "geometry" designs.
// 2b. The material library: src/designer/materials.ts equals python/tests/fixtures/material_library.json.
// 3. The bundle kinds the designer adds (cylindricalshell, sphere, rotpoly; wire) through
//    validateBundle, the 3D geometry, the technical drawing, the isometric view, the CST macro and
//    the fabrication export.
//
// Python: $FAIRBEAM_PYTHON, else ~/opt/openEMS/venv/bin/python (Windows: the repository's
// .venv\Scripts\python.exe, docs/WINDOWS.md), else python3 (Windows: python). The design modules
// need only the standard library, so no openEMS is required.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { evaluate, paramKeyError, PY_KEYWORDS } from "../src/designer/expr.ts";
import { CHEAP, EFFICIENCY_POINTS_DEFAULT, EFFICIENCY_POINTS_MAX, EFFICIENCY_POINTS_MIN, END_DB_MAX, END_DB_MIN, EXPLANATIONS, designChecks, mergeChecks, parseLimit } from "../src/designer/checks.ts";
import { estimateTime, meshCells, meshStats } from "../src/designer/meshStats.ts";
import { validateBundle } from "../src/lib/validate.ts";
import { geometryKey, primitiveGeometry } from "../src/scene/geometry.ts";
import { transformOutline } from "../src/scene/transformOutline.ts";
import { technicalDrawing } from "../src/drawing/drawing.ts";
import { isoModel } from "../src/drawing/iso.ts";
import { cstMacro, DEFAULT_CST_OPTIONS } from "../src/export/cst.ts";
import { fabModel } from "../src/fab/layers.ts";
import { designMaterial, MATERIAL_LIBRARY } from "../src/designer/materials.ts";
import { cleanUserMaterials, designMaterialFromUser, exportUserMaterials, importUserMaterials, upsertByName, userMaterialFromDesign } from "../src/designer/userMaterials.ts";
import { discSegments, quickBundle } from "../src/designer/geometry.ts";
import { paramValues } from "../src/designer/expr.ts";
import { applyTransform, displacesOriginal, portsAtShapes, transformPart } from "../src/designer/transformModel.ts";
import { checkAction } from "../src/designer/checkActions.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
let failures = 0;
const check = (cond, where, msg) => {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL ${where}: ${msg}`);
  }
};

const fx = JSON.parse(readFileSync(join(root, "python/tests/fixtures/designer_parity.json"), "utf8"));
const win = process.platform === "win32";
const venv = win ? join(root, ".venv", "Scripts", "python.exe") : join(homedir(), "opt/openEMS/venv/bin/python");
const python = process.env.FAIRBEAM_PYTHON ?? (existsSync(venv) ? venv : win ? "python" : "python3");
const py = JSON.parse(execFileSync(python, [join(root, "python/tests/designer_fixture.py")], {
  // path.delimiter: ";" on Windows, where ":" would also split the drive letter (E:\...)
  env: { ...process.env, PYTHONPATH: [join(root, "python"), join(root, "python/tests")].join(delimiter) },
  maxBuffer: 64 << 20,
}).toString());

// ---- 1. expressions
fx.expressions.forEach((e, i) => {
  const where = `expression ${JSON.stringify(e.expr)}`;
  let ts;
  try {
    ts = { value: evaluate(e.expr, fx.names) };
  } catch (err) {
    ts = { error: err.message };
  }
  const p = py.expressions[i];
  const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  if (e.error) {
    check("error" in ts, where, `TypeScript gives ${ts.value}, expected an error`);
    check("error" in p, where, `Python gives ${p.value}, expected an error`);
  } else if (e.exact) {
    // the shared number rule: the same double on both sides (no tolerance)
    check("value" in ts && ts.value === e.value, where, `TypeScript: ${ts.value ?? ts.error}, expected exactly ${e.value}`);
    check("value" in p && p.value === e.value, where, `Python: ${p.value ?? p.error}, expected exactly ${e.value}`);
  } else {
    check("value" in ts && close(ts.value, e.value), where, `TypeScript: ${ts.value ?? ts.error}, expected ${e.value}`);
    check("value" in p && close(p.value, e.value), where, `Python: ${p.value ?? p.error}, expected ${e.value}`);
  }
});
// plain numbers (NaN and Infinity: strings in the fixture, as JSON has neither), given to the
// evaluator and as a parameter default (paramValues here, check_design in Python)
fx.numbers.forEach((n, i) => {
  const where = `number ${n.number}`;
  const x = Number(n.number);
  let ts;
  try {
    ts = { value: evaluate(x, {}) };
  } catch (err) {
    ts = { error: err.message };
  }
  const tsDefault = paramValues([{ key: "q", default: x }]).errors.q;
  const p = py.numbers[i];
  if (n.error) {
    check("error" in ts && "error" in p, where, `TypeScript gives ${ts.value}, Python ${p.value}, expected an error`);
    check(tsDefault !== undefined && p.default_error !== undefined, where, `as a default: TypeScript ${tsDefault ?? "accepts it"}, Python ${p.default_error ?? "accepts it"}`);
  } else {
    check(ts.value === n.value && p.value === n.value, where, `TypeScript ${ts.value ?? ts.error}, Python ${p.value ?? p.error}, expected ${n.value}`);
    check(tsDefault === undefined && p.default_error === undefined, where, `as a default: TypeScript ${tsDefault}, Python ${p.default_error}`);
  }
});

// parameter keys and in-order resolution: paramValues / paramKeyError here, resolve_names /
// check_design in Python. Keys such as __proto__ or toString are ordinary names on both sides (the
// maps are prototype-free), and both refuse the same keys (Python keywords, non-ASCII, reserved).
const sameMap = (a, b) => JSON.stringify(Object.keys(a).map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).map((k) => [k, b[k]]));
const show = (m) => JSON.stringify(Object.keys(m).map((k) => [k, m[k]]));
fx.params.forEach((e, i) => {
  const where = `params '${e.name}'`;
  const p = py.params[i];
  const refused = e.params.map((q, k) => [k, paramKeyError(q.key)]).filter(([, err]) => err).map(([k]) => k);
  if (e.key_error !== undefined) {
    check(JSON.stringify(refused) === JSON.stringify([e.key_error]), where, `TypeScript refuses keys ${JSON.stringify(refused)}, expected [${e.key_error}]`);
    check(p.key_error === `params[${e.key_error}].key`, where, `Python: ${p.key_error ?? "accepts the keys"}, expected params[${e.key_error}].key`);
    return;
  }
  check(!refused.length, where, `TypeScript refuses keys ${JSON.stringify(refused)}`);
  const ts = paramValues(e.params);
  check(Object.getPrototypeOf(ts.names) === null && Object.getPrototypeOf(ts.errors) === null, where, "paramValues maps must have no prototype");
  check(sameMap(ts.names, e.values), where, `TypeScript values ${show(ts.names)}, expected ${show(e.values)}`);
  check(JSON.stringify(Object.keys(ts.errors)) === JSON.stringify(e.errors ?? []), where, `TypeScript errors ${Object.keys(ts.errors)}, expected ${e.errors ?? "none"}`);
  check(p.key_error === undefined, where, `Python refuses ${p.key_error}`);
  if (p.key_error !== undefined) return;
  check(sameMap(p.values, e.values), where, `Python values ${show(p.values)}, expected ${show(e.values)}`);
  check(JSON.stringify(p.errors) === JSON.stringify(e.errors ?? []), where, `Python errors ${p.errors}, expected ${e.errors ?? "none"}`);
  if (e.errors?.length) {
    const first = e.params.findIndex((q) => q.key === e.errors[0]);
    check(p.resolve_error === `params[${first}].expr`, where, `resolve_names stops at ${p.resolve_error ?? "nothing"}, expected params[${first}].expr`);
  } else {
    check(p.resolved !== undefined && sameMap(p.resolved, e.values), where, `resolve_names gives ${p.resolved ? show(p.resolved) : p.resolve_error}`);
  }
});
check(JSON.stringify([...PY_KEYWORDS].sort()) === JSON.stringify(py.keywords), "PY_KEYWORDS", `expr.ts lists different keywords from Python's keyword.kwlist: ${py.keywords.filter((k) => !PY_KEYWORDS.has(k))} / ${[...PY_KEYWORDS].filter((k) => !py.keywords.includes(k))}`);

// ---- 2. checks
const tsCheap = [...CHEAP].sort();
check(JSON.stringify(tsCheap) === JSON.stringify(py.cheap), "CHEAP", `checks.ts and design_checks.py cover different codes: ${tsCheap.filter((c) => !py.cheap.includes(c))} / ${py.cheap.filter((c) => !tsCheap.includes(c))}`);
// Read the authority directly so unused/new codes are checked too, beyond fixture coverage.
const explanations = JSON.parse(execFileSync(python, ["-c",
  "import ast,json,pathlib,sys; tree=ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')); print(json.dumps(next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='EXPLANATIONS' for t in n.targets))))",
  join(root, "python/fairbeam/design_checks.py")], {
  env: { ...process.env, PYTHONPATH: join(root, "python") },
}).toString());
check(JSON.stringify(Object.keys(EXPLANATIONS).sort()) === JSON.stringify(tsCheap), "explanations", "the TS table must cover exactly CHEAP");
for (const code of CHEAP) check(EXPLANATIONS[code] === explanations[code], code, "Python and TypeScript explanation text differs");
// Inspect the literal code argument in emitter calls and polygon return pairs.
const source = readFileSync(join(root, "src/designer/checks.ts"), "utf8");
const emitted = new Set([
  ...source.matchAll(/\b(?:error|warn)\([^,\n]+,\s*"([a-z-]+)"/g),
  ...source.matchAll(/\badd\([^,\n]+,[^,\n]+,\s*"([a-z-]+)"/g),
  ...source.matchAll(/return\s*\[\["([a-z-]+)"/g),
].map((match) => match[1]));
for (const code of emitted) check(Boolean(EXPLANATIONS[code]), code, "an emitted TypeScript code needs an explanation");
const key = (c) => `${c.severity}|${c.code}|${c.path}`;
fx.cases.forEach((c, i) => {
  const where = `case '${c.name}'`;
  const pyKeys = py.cases[i].checks.map(key).sort();
  const want = [...c.expect].sort();
  check(JSON.stringify(pyKeys) === JSON.stringify(want), where, `Python: ${pyKeys.join(", ") || "none"}; expected ${want.join(", ") || "none"}`);
  const live = designChecks(py.cases[i].design);
  for (const item of [...live, ...py.cases[i].checks]) check(item.explain === explanations[item.code], where, `missing or incorrect explanation for ${item.code}`);
  const tsKeys = live.map(key).sort();
  // fix buttons: Python's are the fixture's; the browser offers the same where it can (the probe port
  // for a design without one needs the resolved geometry: only the server's, merged by mergeChecks)
  const pyFixes = Object.fromEntries(py.cases[i].checks.filter((k) => k.fix).map((k) => [key(k), k.fix]));
  check(JSON.stringify(pyFixes) === JSON.stringify(c.fixes ?? {}), where, `Python fixes ${JSON.stringify(pyFixes)}; expected ${JSON.stringify(c.fixes ?? {})}`);
  const serverOnlyFix = new Set(["no-port"]);
  const tsFixes = Object.fromEntries(live.filter((k) => k.fix).map((k) => [key(k), k.fix]));
  const wantTsFixes = Object.fromEntries(Object.entries(c.fixes ?? {}).filter(([k]) => CHEAP.has(k.split("|")[1]) && !serverOnlyFix.has(k.split("|")[1])));
  check(JSON.stringify(tsFixes) === JSON.stringify(wantTsFixes), where, `TypeScript fixes ${JSON.stringify(tsFixes)}; expected ${JSON.stringify(wantTsFixes)}`);
  const wantCheap = want.filter((k) => CHEAP.has(k.split("|")[1]));
  check(JSON.stringify(tsKeys) === JSON.stringify(wantCheap), where, `TypeScript: ${tsKeys.join(", ") || "none"}; expected ${wantCheap.join(", ") || "none"}`);
  const pyCheap = pyKeys.filter((k) => CHEAP.has(k.split("|")[1]));
  check(JSON.stringify(tsKeys) === JSON.stringify(pyCheap), where, `TypeScript and Python disagree: ${tsKeys.join(", ")} / ${pyCheap.join(", ")}`);
});

// the merged list: a live check takes the server's fix for the same code and field (the probe port of a
// design without a port), keeps its own, and the server's stale check for a CHEAP code is still dropped
{
  const noPort = py.cases.find((c) => c.name === "no port");
  const live = designChecks(noPort.design);
  check(live.length === 1 && !live[0].fix, "merge", "the live no-port check has no fix of its own");
  const merged = mergeChecks(live, noPort.checks);
  check(merged.length === 1 && JSON.stringify(merged[0].fix) === JSON.stringify(noPort.checks[0].fix), "merge", "the live no-port check takes the server's fix");
  check(!live[0].fix, "merge", "the live check is not modified");
  const other = mergeChecks(live, [{ ...noPort.checks[0], path: "ports[3]" }]);
  check(other.length === 1 && !other[0].fix, "merge", "a fix for another field is not taken");
  const tan = py.cases.find((c) => c.name === "a loss tangent given outside the band");
  const own = mergeChecks(designChecks(tan.design), [{ ...tan.checks[0], fix: { label: "stale", set: {} } }]);
  check(own.length === 1 && own[0].fix.label === "Give tan δ at f0", "merge", "a live fix wins over the server's");
}

// ---- 2c. one end-criterion policy, numeric parameter limits and the mesh cell count (#88)
{
  // read the constants from the source, as for EXPLANATIONS (importing fairbeam needs openEMS)
  const pyEnd = JSON.parse(execFileSync(python, ["-c",
    "import ast,json,pathlib,sys; tree=ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')); v={t.id: ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) for t in n.targets if isinstance(t,ast.Name) and t.id.startswith('END_DB_')}; print(json.dumps([v['END_DB_MIN'], v['END_DB_MAX']]))",
    join(root, "python/fairbeam/design_checks.py")]).toString());
  check(JSON.stringify(pyEnd) === JSON.stringify([END_DB_MIN, END_DB_MAX]), "end criterion", `checks.ts ${END_DB_MIN}..${END_DB_MAX}, design_checks.py ${pyEnd.join("..")}`);
  const dialog = readFileSync(join(root, "src/designer/SimSettingsDialog.tsx"), "utf8");
  check(/min=\{END_DB_MIN\} max=\{END_DB_MAX\}/.test(dialog), "end criterion", "the Solver field's min / max are the checks' policy");
  // efficiency over the band: one range for the number of frequencies (design.py and checks.ts)
  const designPy = readFileSync(join(root, "python/fairbeam/design.py"), "utf8");
  const effDefault = designPy.match(/^EFFICIENCY_POINTS_DEFAULT = (\d+)$/m);
  const effRange = designPy.match(/^EFFICIENCY_POINTS_MIN, EFFICIENCY_POINTS_MAX = (\d+), (\d+)$/m);
  const pyEff = [effDefault?.[1], effRange?.[1], effRange?.[2]].map(Number);
  check(JSON.stringify(pyEff) === JSON.stringify([EFFICIENCY_POINTS_DEFAULT, EFFICIENCY_POINTS_MIN, EFFICIENCY_POINTS_MAX]), "efficiency points",
    `checks.ts ${EFFICIENCY_POINTS_DEFAULT} (${EFFICIENCY_POINTS_MIN}..${EFFICIENCY_POINTS_MAX}), design.py ${pyEff[0]} (${pyEff[1]}..${pyEff[2]})`);
  check(/min=\{EFFICIENCY_POINTS_MIN\} max=\{EFFICIENCY_POINTS_MAX\}/.test(dialog), "efficiency points", "the Monitors points field's min / max are the checks' policy");
  const endKeys = (v) => designChecks({ ...py.cases[0].design, simulation: { ...py.cases[0].design.simulation, end_criteria_db: v } })
    .filter((c) => c.code === "end-criterion").map(key);
  for (const [v, ok] of [[-5, false], [0, false], [-301, false], [Number.NaN, false], [-10, true], [-40, true], [-60, true], [-300, true]])
    check(ok ? endKeys(v).length === 0 : endKeys(v).join() === "error|end-criterion|simulation.end_criteria_db", `end criterion ${v} dB`, ok ? "is allowed" : "is an error");

  // parameter limits: numbers or empty; an expression is refused (the dock keeps the old limit)
  for (const [v, want] of [["", undefined], ["5", 5], [7, 7], [" -2.5 ", -2.5], ["1e3", 1000]]) {
    const r = parseLimit(v);
    check("value" in r && r.value === want, `limit ${JSON.stringify(v)}`, `${JSON.stringify(r)}, expected ${want}`);
  }
  for (const v of ["W/2", "abc", "Infinity", "5 mm", Number.NaN]) check("error" in parseLimit(v), `limit ${JSON.stringify(v)}`, "is refused");

  // cells are the intervals between mesh lines, as the server's mesh.total_cells counts them
  check(meshCells([53, 55, 37]) === 101088, "meshCells", `53 × 55 × 37 lines: ${meshCells([53, 55, 37])}, expected 101088`);
  check(meshCells([157, 181, 37]) === 1010880, "meshCells", `157 × 181 × 37 lines: ${meshCells([157, 181, 37])}, expected 1010880`);
  const lines = (n, step) => Array.from({ length: n }, (_, k) => k * step);
  const bundleOf = (nx, ny, nz) => ({
    units: { length_m: 1e-3 }, solver: { excitation: { f_min: 1e9, f_max: 3e9 }, max_timesteps: 60000 },
    mesh: { x: lines(nx, 1), y: lines(ny, 1), z: lines(nz, 0.5), total_cells: (nx - 1) * (ny - 1) * (nz - 1) },
  });
  for (const [nx, ny, nz, cells] of [[53, 55, 37, 101088], [157, 181, 37, 1010880]]) {
    const b = bundleOf(nx, ny, nz);
    const s = meshStats(b);
    check(s && s.cells === cells && s.cells === b.mesh.total_cells && s.lines.join() === `${nx},${ny},${nz}`, `meshStats ${nx}×${ny}×${nz}`,
      `${s?.lines.join(" × ")} lines, ${s?.cells} cells; expected ${cells} (the server's total_cells)`);
    // the time estimate divides by openEMS's MCells/s, which counts the line product ("FDTD cells")
    const e = estimateTime(b);
    check(s && s.nodes === nx * ny * nz && e && Math.abs(e.seconds[1] - (s.nodes * e.timesteps[1]) / (e.mcps * 1e6)) < 1e-9 * e.seconds[1],
      `estimateTime ${nx}×${ny}×${nz}`, "the solver-time estimate uses openEMS's FDTD cell count (the line product)");
  }
  // the run cannot end before the excitation pulse does: a mesh with 12 µm cells (a timestep of 31 fs) needs ~58000
  // steps for the pulse alone, so a 60000 limit is reached before the fields decay, and the estimate says so
  {
    const fine = bundleOf(53, 55, 37);
    fine.mesh.auto = { timestep_s: 38.8e-15 };
    const e = estimateTime(fine);
    check(e && e.capped && e.timesteps[0] === 60000, "estimateTime pulse", `${JSON.stringify(e?.timesteps)} capped=${e?.capped}`);
    const coarse = bundleOf(53, 55, 37);
    coarse.mesh.auto = { timestep_s: 4.0e-13 };
    const c = estimateTime(coarse);
    check(c && !c.capped && c.timesteps[0] < 60000 && c.timesteps[1] <= 60000, "estimateTime coarse", `${JSON.stringify(c?.timesteps)}`);
  }
}

// ---- 2a. the instant preview (src/designer/geometry.ts) reproduces design.py's resolved shapes
{
  const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  const same = (a, b) => Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i])) : near(a, b);
  fx.geometry?.forEach((g, i) => {
    const where = `preview '${g.name}'`;
    const want = py.geometry[i];
    const qb = quickBundle(want.design, paramValues(want.design.params).names, null);
    check(qb !== null, where, "the preview builds");
    if (!qb) return;
    for (const group of want.groups ?? []) {
      const p = qb.ports.find((p) => p.number === group.number);
      check(JSON.stringify(p?.group) === JSON.stringify(group.group), where, "all physical feeds and signs survive the instant preview");
      const reopened = validateBundle(JSON.parse(JSON.stringify(qb)));
      check(reopened.bundle && JSON.stringify(reopened.bundle.ports.find((p) => p.number === group.number).group) === JSON.stringify(group.group), where, "bundle reopen preserves the group");
      const bad = structuredClone(qb);
      bad.ports.find((p) => p.number === group.number).group.members[0].polarity = 0;
      check(validateBundle(bad).bundle === null, where, "malformed groups are refused rather than reduced to one feed");
      const missingNumber = structuredClone(qb); delete missingNumber.ports[0].number;
      check(validateBundle(missingNumber).bundle === null, where, "a grouped port cannot silently change its logical result key");
      const doc = technicalDrawing({ ...qb, generator: { version: "test" }, created: "2026-01-01" });
      check(doc.notes.some((note) => note.includes("2") && note.includes("physical feed")), where, "drawing identifies the logical and physical reference resistances");
      let refused = false;
      try { cstMacro(qb); } catch { refused = true; }
      check(refused, where, "unsupported grouped-port macro export refuses to discard the group");
    }
    for (const w of want.waveguides) {
      const t = qb.ports.find((p) => p.number === w.number);
      check(t && t.type === "waveguide" && t.mode === w.mode && near(t.a, w.a) && near(t.b, w.b) && near(t.f_cutoff / 1e9, w.f_cutoff_ghz), where,
        `waveguide port ${w.number}: ${JSON.stringify(t)} vs ${JSON.stringify(w)}`);
    }
    for (const wp of want.parts) {
      const part = qb.parts.find((p) => p.name === wp.name);
      check(part && part.primitives.length === wp.prims.length, where, `${wp.name}: ${part?.primitives.length} shapes, Python ${wp.prims.length}`);
      if (!part) continue;
      wp.prims.forEach((q, k) => {
        const t = part.primitives[k];
        if (!t) return;
        check(same(t.bbox, q.bbox), where, `${wp.name}[${k}] bbox ${JSON.stringify(t.bbox)} vs ${JSON.stringify(q.bbox)}`);
        check(t.priority === q.priority, where, `${wp.name}[${k}] priority ${t.priority} vs ${q.priority}`);
        if (q.kind === "cone" || q.kind === "torus") {
          check(t.kind === "rotpoly" && t.axis === q.axis && same(t.origin, q.origin) && same(t.points, q.profile), where,
            `${wp.name}[${k}] ${q.kind}: ${JSON.stringify(t)} vs ${JSON.stringify(q)}`);
        } else if (q.kind === "wire") {
          check(t.kind === "wire" && near(t.radius, q.radius) && same(t.points, q.points), where, `${wp.name}[${k}] wire ${JSON.stringify(t)} vs ${JSON.stringify(q)}`);
        } else if (q.kind === "box") {
          check(t.kind === "box" && same(t.start, q.start) && same(t.stop, q.stop), where, `${wp.name}[${k}] box ${JSON.stringify(t)} vs ${JSON.stringify(q)}`);
        } else if (q.kind === "cylinder") {
          const shell = q.inner_radius > 0;
          check(t.kind === (shell ? "cylindricalshell" : "cylinder") && same(t.start, q.start) && same(t.stop, q.stop)
            && near(t.radius, shell ? (q.radius + q.inner_radius) / 2 : q.radius)
            && (!shell || near(t.shell_width, q.radius - q.inner_radius)), where, `${wp.name}[${k}] cylinder ${JSON.stringify(t)} vs ${JSON.stringify(q)}`);
        } else if (q.kind === "sphere") {
          check(t.kind === "sphere" && same(t.center, q.center) && near(t.radius, q.radius), where, `${wp.name}[${k}] sphere ${JSON.stringify(t)} vs ${JSON.stringify(q)}`);
        } else if (q.kind === "polyhedron") {
          // vertices as resolved; the bundle lists the triangles (each polygon face fanned, outward)
          const tris = q.faces.reduce((n, f) => n + f.length - 2, 0);
          check(t.kind === "polyhedron" && same(t.vertices, q.vertices) && t.faces.length === tris && t.faces.every((f) => f.length === 3), where,
            `${wp.name}[${k}] polyhedron: ${t.faces?.length} triangles, expected ${tris}`);
          const vol = t.faces.reduce((v, [i, j, l]) => { const [P, Q, R] = [t.vertices[i], t.vertices[j], t.vertices[l]];
            return v + P[0] * (Q[1] * R[2] - Q[2] * R[1]) - P[1] * (Q[0] * R[2] - Q[2] * R[0]) + P[2] * (Q[0] * R[1] - Q[1] * R[0]); }, 0);
          check(vol > 0, where, `${wp.name}[${k}] polyhedron triangles face outward (volume ${vol})`);
        } else if (q.kind === "polygon" || q.kind === "linpoly") {
          check(t.kind === q.kind && t.normal === q.normal && near(t.elevation, q.elevation) && same(t.points, q.points)
            && (q.kind !== "linpoly" || near(t.length, q.length)), where, `${wp.name}[${k}] polygon ${JSON.stringify(t)} vs ${JSON.stringify(q)}`);
        }
      });
    }
    if (g.name.startsWith("flat circles, rings and tubes")) {
      // zero-length cylinders are polygon sheets (design.resolve_primitive), a ring two half rings; the
      // exporter turns a full circle of a regular polygon back into a CST Circle
      const discs = qb.parts.find((p) => p.name === "discs");
      check(discs.primitives.slice(0, 6).every((p) => p.kind === "polygon") && discs.primitives.length === 4 * (1 + 2 + 1 + 2 + 1), where,
        `flat circles are polygons, a ring has two halves, a real cylinder stays one: ${discs.primitives.map((p) => p.kind).join(",")}`);
      check(discs.primitives.some((p) => p.kind === "cylinder"), where, "the one-millimetre-long cylinder stays a cylinder");
      const { text } = cstMacro({ ...qb, generator: { version: "test" }, created: "2026-01-01", parts: [discs] }, DEFAULT_CST_OPTIONS);
      // the two full circles of each instance (the rings' half rings stay polygons), 4 instances: mirrored and copied
      check((text.match(/With Circle/g) ?? []).length === 2 * 4, where, `CST circles for the flat discs: ${(text.match(/With Circle/g) ?? []).length}`);
    }
    if (g.name === "all shapes moved before and after copy transforms") {
      const moved = qb.parts.find((p) => p.name === "moved");
      check(moved.primitives.length === 36 && moved.primitives.every((p) => p.exact), where, "moves preserve the four copy instances of nine exact shapes");
    }
    if (g.name === "move CST coordinates") {
      const moved = qb.parts.find((p) => p.name === "move_cst");
      const { text, warnings } = cstMacro({ ...qb, generator: { version: "test" }, created: "2026-01-01", parts: [moved] }, DEFAULT_CST_OPTIONS);
      check(moved.primitives.length === 2, where, "move adds no copies");
      check(text.includes('.Xrange ""11"", ""14""') && text.includes('.Yrange ""-18"", ""-14""') && text.includes('.Zrange ""33"", ""38""'), where, "CST brick uses moved bounds");
      check(text.includes('.Center ""12"", ""-17"", ""34""'), where, "CST sphere uses moved center");
      check(!warnings.some((w) => /approx|move_cst|non-finite/i.test(w)), where, `CST has no moved-shape fallback: ${warnings.join(" | ")}`);
      const invalid = structuredClone(want.design);
      invalid.parts.at(-1).transforms[0].offset[1] = "missing_parameter";
      check(quickBundle(invalid, paramValues(invalid.params).names, null) === null, where, "invalid move expression has no preview");
      check(designChecks(invalid).some((c) => c.code === "expr" && c.path === `parts[${invalid.parts.length - 1}].transforms[0].offset[1]`), where, "invalid move expression identifies its offset field");
    }
    if (g.name.startsWith("rotate all shapes")) {
      const part = qb.parts.at(-1), count = g.name.endsWith("z") ? 72 : 18;
      check(part.primitives.length === count && part.primitives.every((p) => p.exact), where, "ordered rotations retain exact primitives and expected copy count");
    }
    if (g.name === "rotate CST coordinates") {
      const { text, warnings } = cstMacro({ ...qb, generator: { version: "test" }, created: "2026-01-01", parts: [qb.parts.at(-1)] }, DEFAULT_CST_OPTIONS);
      check(text.includes('.Xrange ""-3"", ""0""') && text.includes('.Yrange ""3"", ""5""') && text.includes('.Zrange ""4"", ""8""'), where, "CST rotated brick remaps its bounds");
      check(text.includes('.Center ""-3"", ""6"", ""7""'), where, "CST rotated sphere uses its exact center");
      check(!warnings.some((w) => /approx|rotate_cst|non-finite/i.test(w)), where, `CST has no rotation fallback: ${warnings.join(" | ")}`);
    }
  });
}

// Transform dialogs derive previews without editing; shape commits detach only the selected shape.
{
  const d = structuredClone(py.geometry[0].design);
  const i = d.parts.length - 1, original = d.parts[i];
  original.component = "antenna/feed"; original.color = "#abcdef";
  original.cuts = [{ start: [0, 0, 0], stop: [1, 1, 0] }];
  original.primitives[1].label = "Selected tube";
  const sibling = structuredClone(original.primitives[0]);
  d.parts.push({ ...structuredClone(original), name: `${original.name}_shape` });
  const before = JSON.stringify(d), prior = structuredClone(original.transforms);
  const selectedSource = original.primitives[1], selectedBefore = JSON.stringify(selectedSource);
  const move = { type: "move", offset: [10, 20, 30] };
  const target = { type: "primitive", i, j: 1 };
  const previewPart = transformPart(d, target, move);
  const preview = quickBundle({ ...d, parts: [previewPart] }, paramValues(d.params).names, null);
  check(preview !== null && preview.parts[0].primitives.length === 4, "shape preview", "one shape with its four prior instances previews");
  check(JSON.stringify(d) === before, "shape preview", "preview does not mutate the draft");
  check(JSON.stringify(previewPart.transforms) === JSON.stringify([...prior, move]), "shape preview", "the move follows prior transforms");
  check(JSON.stringify(previewPart.cuts) === JSON.stringify(original.cuts), "shape preview", "cuts remain before transforms");
  const at = applyTransform(d, target, move), detached = d.parts[at];
  check(at === d.parts.length - 1 && detached.name === `${original.name}_shape_2`, "shape move", "detaches with a collision-free name");
  check(detached.label === "Selected tube" && detached.material === original.material && detached.component === original.component && detached.color === original.color,
    "shape move", "retains shape label, material, component and color");
  check(original.primitives.length === 8 && JSON.stringify(original.primitives[0]) === JSON.stringify(sibling) && JSON.stringify(original.transforms) === JSON.stringify(prior),
    "shape move", "siblings and their prior transform sequence stay unchanged");
  check(JSON.stringify(detached.cuts) === JSON.stringify(original.cuts) && JSON.stringify(detached.transforms) === JSON.stringify([...prior, move]), "shape move", "detached shape retains cuts and appends the move");
  detached.cuts[0].start[0] = 123;
  detached.transforms[0].offset[0] = 456;
  detached.primitives[0].label = "Edited detached shape";
  check(original.cuts[0].start[0] === 0 && JSON.stringify(original.transforms) === JSON.stringify(prior) && JSON.stringify(selectedSource) === selectedBefore,
    "shape move", "later detached edits cannot alias original cuts, transforms or primitive references");
  const count = d.parts.length;
  check(applyTransform(d, { type: "primitive", i: at, j: 0 }, move) === at && d.parts.length === count, "shape move", "a sole shape stays in its existing part");
  check(applyTransform(d, { type: "part", i }, move) === i && d.parts.length === count && d.parts[i].primitives.length === 8, "part move", "whole-part move keeps siblings together");

  const reject = (transforms) => quickBundle({ ...d, parts: [{ ...d.parts[i], transforms }] }, paramValues(d.params).names, null) === null;
  for (const copies of [-1, 1.5, 1001, 1e12]) check(reject([{ type: "translate", copies, step: [1, 0, 0] }]), "transform preview", `rejects ${copies} copies`);
  check(reject([{ type: "translate", copies: 500, step: [1, 0, 0] }, { type: "mirror", plane: "x" }]), "transform preview", "rejects combined mirror expansion above 1001 instances");
  check(reject([{ type: "mirror", plane: "x" }, { type: "translate", copies: 500, step: [1, 0, 0] }]), "transform preview", "rejects combined translation expansion above 1001 instances");
  for (const offset of [[], [1, 2], [1, 2, 3, 4], null]) check(reject([{ type: "move", offset }]), "transform preview", `rejects malformed offset ${JSON.stringify(offset)}`);
  const rotation = { type: "rotate", axis: "z", center: [1, 2, 3], angle: 90 };
  const sphere = { kind: "sphere", center: [3, 5, 7], radius: 1 };
  for (const angle of [45, 89.999, -135]) {
    const general = quickBundle({ ...d, parts: [{ ...d.parts[i], cuts: [], primitives: [sphere], transforms: [{ ...rotation, angle }] }] }, paramValues(d.params).names, null);
    const primitive = general?.parts[0].primitives[0];
    check(primitive?.kind === "transformed" && primitive.exact === true && primitive.primitive.kind === "sphere",
      "rotation preview", `keeps ${angle}° as an exact transformed sphere`);
    const radians = angle * Math.PI / 180;
    const center = rotation.center;
    const expected = [center[0] + Math.cos(radians) * (sphere.center[0] - center[0]) - Math.sin(radians) * (sphere.center[1] - center[1]),
      center[1] + Math.sin(radians) * (sphere.center[0] - center[0]) + Math.cos(radians) * (sphere.center[1] - center[1]), sphere.center[2]];
    const m = primitive?.matrix;
    const mappedCenter = m && [0, 1, 2].map((k) => m[k][0] * sphere.center[0] + m[k][1] * sphere.center[1] + m[k][2] * sphere.center[2] + m[k][3]);
    check(mappedCenter && mappedCenter.every((v, k) => Math.abs(v - expected[k]) < 1e-9), "rotation matrix", `${angle}° maps its center exactly`);
    const accepted = { ...d, parts: [{ ...d.parts[i], transforms: [{ ...rotation, angle }] }] };
    check(!designChecks(accepted).some((c) => c.code === "rotation-angle"), "rotation checks", "allows exact arbitrary-angle transforms");
  }
  const fractionalArray = quickBundle({ ...d, parts: [{ ...d.parts[i], cuts: [], primitives: [sphere],
    transforms: [{ ...rotation, angle: 0.5, copies: 360 }] }] }, paramValues(d.params).names, null);
  const lastCopy = fractionalArray?.parts[0].primitives[360];
  const lastCenter = lastCopy?.matrix && [0, 1, 2].map((k) => lastCopy.matrix[k][0] * sphere.center[0] + lastCopy.matrix[k][1] * sphere.center[1] + lastCopy.matrix[k][2] * sphere.center[2] + lastCopy.matrix[k][3]);
  check(fractionalArray?.parts[0].primitives.length === 361 && lastCenter?.every((v, k) => Math.abs(v - [-1, -1, 7][k]) < 1e-9),
    "fractional rotation copies", "copy 360 retains 360 × 0.5° rather than reducing the copy index modulo 360");
  for (const copies of [-1, 1.5, 1001, 1e12]) check(reject([{ ...rotation, copies }]), "rotation preview", `rejects ${copies} rotation copies`);
  check(reject([{ ...rotation, copies: 500 }, { type: "mirror", plane: "x" }]), "rotation preview", "rejects combined circular array and mirror overflow");
  check(reject([{ type: "mirror", plane: "x" }, { ...rotation, copies: 500 }]), "rotation preview", "rejects combined mirror and circular array overflow");
  check(reject([{ ...rotation, center: [1, 2] }]), "rotation preview", "rejects malformed center");
  const rotatedCenters = (tr) => quickBundle({ ...d, parts: [{ ...d.parts[i], cuts: [], primitives: [sphere], transforms: [tr] }] }, paramValues(d.params).names, null)?.parts[0].primitives.map((p) => p.center);
  for (const [axis, expected] of [["x", [3, -2, 6]], ["y", [5, 5, 1]], ["z", [-2, 4, 7]]]) {
    check(JSON.stringify(rotatedCenters({ ...rotation, axis })) === JSON.stringify([expected]), "rotation axes", `right-handed quarter turn about off-origin ${axis} axis`);
  }
  check(JSON.stringify(rotatedCenters({ ...rotation, angle: -270 })) === JSON.stringify(rotatedCenters(rotation)) && JSON.stringify(rotatedCenters({ ...rotation, angle: 450 })) === JSON.stringify(rotatedCenters(rotation)), "rotation angles", "negative and wrapped quarter turns agree");
  check(JSON.stringify(rotatedCenters({ ...rotation, copies: 3 })) === JSON.stringify([[3, 5, 7], [-2, 4, 7], [-1, -1, 7], [4, 0, 7]]), "circular array", "keeps the original followed by each quarter turn");
  check(rotatedCenters({ ...rotation, angle: 1e308, copies: 1000 })?.every((center) => JSON.stringify(center) === JSON.stringify(sphere.center)),
    "rotation angles", "reduces huge finite quarter-turn counts before multiplying copies");
  const crowded = { ...d.parts[i], cuts: [], primitives: Array.from({ length: 3 }, () => sphere), transforms: [{ ...rotation, copies: 1000 }] };
  check(quickBundle({ ...d, parts: [crowded, { ...crowded, name: "second" }] }, paramValues(d.params).names, null) === null,
    "rotation preview", "rejects total expanded primitives above 5000 across parts");
}

// Uniform scaling keeps every primitive exact, composes in world coordinates, and uses cumulative
// powers for copies. Mirror planes may be offset from the origin and all transform coordinates are expressions.
{
  const d = structuredClone(py.geometry[0].design);
  const names = { ...paramValues(d.params).names, S: 2, O: 1 };
  const part = (primitives, transforms) => ({ name: "scale_check", material: d.materials.find((m) => m.kind === "metal").name,
    primitives, transforms, cuts: [] });
  const sphere = { kind: "sphere", center: [3, 5, 7], radius: 1 };
  const scaled = quickBundle({ ...d, parts: [part([sphere], [{ type: "scale", factors: ["S", "S", "S"], origin: ["O", 1, 1] }])] }, names, null);
  const sp = scaled?.parts[0].primitives[0];
  check(sp?.kind === "sphere" && JSON.stringify(sp.center) === JSON.stringify([5, 9, 13]) && sp.radius === 2
    && JSON.stringify(sp.bbox) === JSON.stringify([[3, 7, 11], [7, 11, 15]]), "uniform scale", "expression factors and origin scale center, radius and bbox exactly in place");
  const copied = quickBundle({ ...d, parts: [part([sphere], [{ type: "scale", factors: [2, 2, 2], origin: [1, 1, 1], copies: 2 }])] }, names, null);
  check(JSON.stringify(copied?.parts[0].primitives.map((p) => [p.center, p.radius])) === JSON.stringify([
    [[3, 5, 7], 1], [[5, 9, 13], 2], [[9, 17, 25], 4],
  ]), "scale copies", "keeps original then adds the first and second cumulative factor powers");
  const composed = quickBundle({ ...d, parts: [part([sphere], [
    { type: "rotate", axis: "z", center: [0, 0, 0], angle: 90 },
    { type: "scale", factors: [2, 2, 2], origin: [1, 1, 1] },
    { type: "mirror", plane: "x", point: ["O", 0, 0], keep: false },
  ])] }, names, null);
  const cp = composed?.parts[0].primitives[0];
  check(cp?.kind === "sphere" && JSON.stringify(cp.center) === JSON.stringify([13, 5, 13]) && cp.radius === 2,
    "composed scale and mirror", "rotation, off-origin scaling and offset mirror compose in order");

  const shapeSet = [
    { kind: "box", start: [0, 0, 0], stop: [1, 2, 3] },
    { kind: "cylinder", axis: "z", center: [0, 0], radius: 2, inner_radius: 1, range: [0, 3] },
    sphere,
    { kind: "polygon", normal: "z", elevation: 2, points: [[0, 0], [1, 0], [0, 1]] },
    { kind: "linpoly", normal: "z", elevation: 2, length: 3, points: [[0, 0], [1, 0], [0, 1]] },
    { kind: "cone", axis: "z", center: [0, 0], bottom_radius: 2, top_radius: 1, range: [0, 3] },
    { kind: "torus", axis: "z", center: [0, 0, 0], major_radius: 3, minor_radius: 1 },
    { kind: "wire", points: [[0, 0, 0], [0, 0, 1]], radius: 0.5 },
  ];
  const allScaled = quickBundle({ ...d, parts: [part(shapeSet, [{ type: "scale", factors: [2, 2, 2], origin: [0, 0, 0] }])] }, names, null)?.parts[0].primitives;
  check(allScaled?.length === shapeSet.length && allScaled.every((p) => p.exact), "scale primitive coverage", "all primitive kinds remain exact under uniform scale");
  check(JSON.stringify(allScaled?.[0].bbox) === JSON.stringify([[0, 0, 0], [2, 4, 6]])
    && allScaled[1].radius === 3 && allScaled[1].shell_width === 2 && allScaled[2].radius === 2
    && allScaled[3].elevation === 4 && JSON.stringify(allScaled[3].points) === JSON.stringify([[0, 0], [2, 0], [0, 2]])
    && allScaled[4].length === 6 && allScaled[4].elevation === 4
    && JSON.stringify(allScaled[5].points) === JSON.stringify([[0, 0], [4, 0], [2, 6], [0, 6]])
    && allScaled[6].points.every(([r, h], k) => Math.abs(r - 2 * (shapeSet[6].major_radius + shapeSet[6].minor_radius * Math.cos((2 * Math.PI * k) / 64))) < 1e-9 && Math.abs(h - 2 * shapeSet[6].minor_radius * Math.sin((2 * Math.PI * k) / 64)) < 1e-9)
    && allScaled[7].radius === 1, "scale dimensions", "cylinder, sphere, extrusion, cone, torus and wire dimensions scale with coordinates");

  const reject = (tr) => quickBundle({ ...d, parts: [part([sphere], [tr])] }, names, null) === null;
  check(reject({ type: "scale", factors: [2, 3, 2], origin: [0, 0, 0] }), "scale preview", "refuses nonuniform scale");
  check(reject({ type: "scale", factors: [2, 2, 2], origin: [0, 0, 0], copies: 1.5 }), "scale preview", "refuses fractional scale copies");
  check(reject({ type: "scale", factors: [2, 2, 2], origin: [0, 0, 0], copies: 1001 }), "scale preview", "refuses excessive scale copies");
  const badScale = { ...d, parts: [part([sphere], [{ type: "scale", factors: [2, 3, 2], origin: [0, 0, 0] }])] };
  check(designChecks(badScale).some((c) => c.code === "scale" && c.path === "parts[0].transforms[0].factors"), "scale checks", "reports nonuniform scale at factors");
  const badMirror = { ...d, parts: [part([sphere], [{ type: "mirror", plane: "x", point: [0, "missing_parameter", 0] }])] };
  check(designChecks(badMirror).some((c) => c.code === "expr" && c.path === "parts[0].transforms[0].point[1]"), "mirror point checks", "reports an invalid mirror point expression at its coordinate");
  const offsetMirror = quickBundle({ ...d, parts: [part([sphere], [{ type: "mirror", plane: "x", point: [2, 0, 0], keep: false }])] }, names, null);
  check(JSON.stringify(offsetMirror?.parts[0].primitives[0].center) === JSON.stringify([1, 5, 7]), "mirror point", "reflects across x = point[x] when keep is false");
}

// the number of sides of a flat circle (design.disc_segments) is the same in the browser and on the server
for (const d of py.discs) check(discSegments(d.radius) === d.segments, "flat circle", `radius ${d.radius}: ${discSegments(d.radius)} sides in TypeScript, ${d.segments} in Python`);

// ---- 2b. the material library: src/designer/materials.ts equals the shared fixture (Python's
// fairbeam/materials.py is pinned to the same file by python/tests/test_materials.py)
{
  const lib = JSON.parse(readFileSync(join(root, "python/tests/fixtures/material_library.json"), "utf8")).library;
  check(JSON.stringify(MATERIAL_LIBRARY) === JSON.stringify(lib), "material library",
    `materials.ts differs from the fixture: ${MATERIAL_LIBRARY.map((m) => m.id).join(",")} / ${lib.map((m) => m.id).join(",")}`);
  const ro = designMaterial(MATERIAL_LIBRARY.find((m) => m.id === "ro4003c"), "sub");
  check(JSON.stringify(ro) === JSON.stringify({ name: "sub", kind: "dielectric", eps_r: 3.38, tan_d: 0.0027, tan_d_freq: 10, library: "ro4003c" }),
    "material library", `a copy into the design: ${JSON.stringify(ro)}`);
}

// ---- 2d. My materials (src/designer/userMaterials.ts): the same validation as python/fairbeam/usermaterials.py
// (the shared fixture), save and pick give the same material, an import skips bad entries
{
  const fxu = JSON.parse(readFileSync(join(root, "python/tests/fixtures/user_materials.json"), "utf8"));
  const res = cleanUserMaterials(fxu.raw);
  check(JSON.stringify(res.materials) === JSON.stringify(fxu.kept) && res.skipped.length === fxu.skipped, "user materials",
    `validation differs from the fixture: kept ${res.materials.map((m) => m.id)}, skipped ${res.skipped.length}`);
  const designs = [
    { name: "sub", kind: "dielectric", eps_r: 3.66, tan_d: 0.004, tan_d_freq: 10, color: "#aabbcc" },
    { name: "Brass", kind: "metal", conductivity: 1.5e7, thickness: 0.05 },
    { name: "pec", kind: "metal" },
    { name: "string numbers", kind: "dielectric", eps_r: "2.5", tan_d: "0.01" },
  ];
  for (const m of designs) {
    const saved = userMaterialFromDesign(m, "u-test");
    const back = "entry" in saved ? designMaterialFromUser(saved.entry, m.name) : null;
    const want = { ...m, ...(m.eps_r !== undefined ? { eps_r: Number(m.eps_r), tan_d: Number(m.tan_d) } : {}) };
    check(back !== null && JSON.stringify(back) === JSON.stringify(want), "user materials", `save then pick gives ${JSON.stringify(back)} for ${JSON.stringify(m)}`);
  }
  check("why" in userMaterialFromDesign({ name: "p", kind: "dielectric", eps_r: "eps_sub", tan_d: 0 }, "u-x"), "user materials", "a parameter expression is not saved");
  const one = userMaterialFromDesign(designs[0], "u-1").entry;
  check(upsertByName([one], { ...one, id: "u-2", eps_r: 4 }).list.length === 1, "user materials", "saving a name again updates the entry");
  const imp = importUserMaterials(exportUserMaterials(res.materials), [one]);
  check(imp.added === 3 && imp.list.length === 4 && new Set(imp.list.map((m) => m.id)).size === 4, "user materials", "an export imports with fresh ids");
  const mixed = importUserMaterials(JSON.stringify({ materials: fxu.raw.materials }), []);
  check(mixed.added === fxu.kept.length && mixed.skipped.length === fxu.skipped, "user materials", `an import skips the bad entries: ${mixed.added} added, ${mixed.skipped.length} skipped`);
  const dup = importUserMaterials(exportUserMaterials([one]), [one]);
  check(dup.list.map((m) => m.name).join("|") === "sub|sub 2", "user materials", "an imported name in use gets a number");
  const broken = importUserMaterials("{oops", []);
  check(broken.added === 0 && broken.skipped.length === 1, "user materials", "damaged JSON imports nothing");
}

// ---- 3. the designer's bundle kinds through every consumer
const index = JSON.parse(readFileSync(join(root, "public/projects/index.json"), "utf8"));
const patch = JSON.parse(readFileSync(join(root, "public/projects", index.projects.find((p) => /patch/.test(p.file))?.file ?? index.projects[0].file), "utf8"));
const bb = (lo, hi) => [lo, hi];
// exactly what python/fairbeam/geometry.py writes (pinned by python/tests/test_geometry.py)
// a via-like tube through the example's substrate
const slab = patch.parts.find((p) => p.type === "Material").bbox;
const [z0, z1] = [slab[0][2], slab[1][2]];
const tube = { kind: "cylindricalshell", start: [5, 5, z0], stop: [5, 5, z1], radius: 0.8, shell_width: 0.4, priority: 10, bbox: bb([4, 4, z0], [6, 6, z1]), exact: true };
const ball = { kind: "sphere", center: [-8, 6, 4], radius: 1.5, priority: 10, bbox: bb([-9.5, 4.5, 2.5], [-6.5, 7.5, 5.5]), exact: true };
const side = { kind: "cylindricalshell", start: [-10, -12, 3], stop: [10, -12, 3], radius: 1, shell_width: 0.5, priority: 10, bbox: bb([-10, -13.25, 1.75], [10, -10.75, 4.25]), exact: true };
// the designer's cone and torus: CSXCAD rotational polygons (python/tests/test_geometry.py pins the export)
const cone = { kind: "rotpoly", axis: 2, origin: [10, -8, z1], points: [[0, 0], [3, 0], [0, 6]], priority: 10, bbox: bb([7, -11, z1], [13, -5, z1 + 6]), exact: true };
const ringPts = Array.from({ length: 64 }, (_, k) => [6 + Math.cos((2 * Math.PI * k) / 64), Math.sin((2 * Math.PI * k) / 64)].map((x) => Math.round(x * 1e6) / 1e6));
const ring = { kind: "rotpoly", axis: 0, origin: [0, 0, 20], points: ringPts, priority: 10, bbox: bb([-1, -7, 13], [1, 7, 27]), exact: true };
// the designer's thin wire: the bundle's existing kind (CSXCAD Wire)
const mono = { kind: "wire", points: [[-12, 12, z1], [-12, 12, z1 + 20]], radius: 0.5, priority: 10, bbox: bb([-12.5, 11.5, z1 - 0.5], [-11.5, 12.5, z1 + 20.5]), exact: true };
const synthetic = structuredClone(patch);
synthetic.name = "designer shapes (synthetic)";
synthetic.parts.push(
  { name: "tube", type: "Metal", bbox: tube.bbox, primitives: [tube] },
  { name: "ball", type: "Metal", bbox: ball.bbox, primitives: [ball] },
  { name: "side", type: "Metal", bbox: side.bbox, primitives: [side] },
  { name: "cone", type: "Metal", bbox: cone.bbox, primitives: [cone] },
  { name: "ring", type: "Metal", bbox: ring.bbox, primitives: [ring] },
  { name: "mono", type: "Metal", bbox: mono.bbox, primitives: [mono] },
);
{
  const v = validateBundle(structuredClone(synthetic));
  check(v.bundle !== null && v.errors.length === 0, "validateBundle", v.errors.join("; "));
  const kinds = (v.bundle?.parts ?? []).flatMap((p) => p.primitives.map((q) => q.kind));
  check(kinds.includes("cylindricalshell") && kinds.includes("sphere") && kinds.filter((k) => k === "rotpoly").length === 2, "validateBundle", `keeps the new kinds (got ${kinds.join(", ")})`);
  for (const bad of [{ ...tube, shell_width: 2 }, { ...tube, shell_width: 0 }, { ...ball, radius: 0 }, { ...ball, center: [0, 0] },
    { ...cone, axis: 3 }, { ...cone, points: [[-1, 0], [3, 0], [0, 6]] }, { ...cone, points: [[0, 0], [3, 0]] }, { ...cone, origin: [0, 0] }]) {
    const b = structuredClone(patch);
    b.parts.push({ name: "bad", type: "Metal", bbox: bad.bbox, primitives: [bad] });
    const r = validateBundle(b);
    const kept = (r.bundle?.parts ?? []).find((p) => p.name === "bad")?.primitives ?? [];
    check(!kept.some((q) => q.kind === bad.kind), "validateBundle", `refuses a broken ${bad.kind}: ${JSON.stringify(bad)}`);
  }
}
check(primitiveGeometry(mono) !== null, "3D geometry", "the wire has a geometry (a tube)");
{
  // a polyhedron: quad faces are fanned into triangles (2 per quad), the bbox is the vertices' extent
  const cube = { kind: "polyhedron", priority: 10, exact: true, bbox: [[0, 0, 0], [2, 3, 4]],
    vertices: [[0, 0, 0], [2, 0, 0], [2, 3, 0], [0, 3, 0], [0, 0, 4], [2, 0, 4], [2, 3, 4], [0, 3, 4]],
    faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]] };
  const g = primitiveGeometry(cube);
  check(g !== null && g.getAttribute("position").count === 12 * 3, "3D geometry", `a hexahedron of 6 quad faces is 12 triangles (${g?.getAttribute("position").count / 3})`);
  g.computeBoundingBox();
  check(JSON.stringify([g.boundingBox.min.toArray(), g.boundingBox.max.toArray()]) === JSON.stringify(cube.bbox), "3D geometry", "polyhedron bbox is the vertices' extent");
  check(geometryKey({ ...cube, priority: 3 }) === geometryKey(cube) && geometryKey({ ...cube, vertices: cube.vertices.map((v, i) => i === 6 ? [2, 3, 5] : v) }) !== geometryKey(cube),
    "3D geometry", "geometryKey follows the polyhedron's vertices and ignores its priority");
  const bundle = structuredClone(patch);
  bundle.parts.push({ name: "solid", type: "Metal", bbox: cube.bbox, primitives: [cube] });
  check((validateBundle(bundle).bundle?.parts ?? []).some((p) => p.name === "solid"), "validateBundle", "keeps a valid polyhedron");
}
for (const prim of [tube, ball, side, cone, ring, mono]) {
  const outline = transformOutline(prim);
  const positions = outline?.getAttribute("position");
  check(!!positions && positions.count > 0 && [...positions.array].every(Number.isFinite),
    "transform preview", `${prim.kind} has visible finite outline segments, including smooth closed surfaces`);
  outline?.dispose();
}
for (const prim of [tube, ball, side, cone, ring]) {
  const g = primitiveGeometry(prim);
  check(g !== null, "3D geometry", `${prim.kind} has a geometry`);
  if (!g) continue;
  g.computeBoundingBox();
  const got = [g.boundingBox.min.toArray(), g.boundingBox.max.toArray()];
  // the tessellated surface lies within the exact bbox and touches it (to the chord error of 48 segments)
  const ok = [0, 1].every((s) => [0, 1, 2].every((a) => Math.abs(got[s][a] - prim.bbox[s][a]) < 0.01 * Math.max(1, Math.abs(prim.bbox[1][a] - prim.bbox[0][a]))));
  check(ok, "3D geometry", `${prim.kind} bbox ${JSON.stringify(got)} vs ${JSON.stringify(prim.bbox)}`);
  if (prim.kind === "cylindricalshell") {
    // a tube has a bore: no vertex nearer the axis than the inner radius
    const pos = g.getAttribute("position");
    let rmin = Infinity;
    const [a, c] = [new THREE.Vector3(...prim.start), new THREE.Vector3(...prim.stop)];
    const line = new THREE.Line3(a, c);
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      line.closestPointToPoint(p, false, q);
      rmin = Math.min(rmin, p.distanceTo(q));
    }
    check(Math.abs(rmin - (prim.radius - prim.shell_width / 2)) < 1e-6, "3D geometry", `tube bore radius ${rmin}`);
  }
}
{
  const r = technicalDrawing(synthetic, { sheet: "A3", date: "2026-01-01" });
  check(!/NaN|undefined/.test(r.svg), "drawing", "no NaN/undefined in the SVG");
  const circles = (r.svg.match(/<circle /g) ?? []).length;
  const baseCircles = (technicalDrawing(patch, { sheet: "A3", date: "2026-01-01" }).svg.match(/<circle /g) ?? []).length;
  // top view: tube (outer + bore) and sphere; front and side views: the sphere; the side tube end-on in one view (outer + bore)
  // cone: a circle in the top view; ring (axis x): a circle with its hole in the side view
  check(circles - baseCircles >= 10, "drawing", `tube, sphere, cone and torus drawn as circles (${circles - baseCircles} more circles than the patch alone)`);
  const iso = isoModel(synthetic);
  check(iso.faces.every((f) => f.pts.every((p) => p.every(Number.isFinite))), "isometric", "finite faces");
  check(iso.faces.filter((f) => f.role !== "approx").length > isoModel(patch).faces.length + 20, "isometric", "tube and sphere drawn with faces, not bounding boxes");
  check(!iso.faces.some((f) => f.role === "approx"), "isometric", "no bounding-box fallback");
  check(iso.lines.some((l) => l.a[0] === -12 && l.b[2] === z1 + 20), "isometric", "the wire is drawn as its polyline");
}
{
  const { text, warnings } = cstMacro(synthetic, DEFAULT_CST_OPTIONS);
  check(!warnings.some((w) => /tube|sphere|cylindricalshell|non-finite/i.test(w)), "CST", `no warnings about the new shapes: ${warnings.join(" | ")}`);
  check(text.includes('.OuterRadius ""1""') && text.includes('.InnerRadius ""0.6""'), "CST", "the tube is a Cylinder with outer 1 / inner 0.6");
  check(text.includes('.OuterRadius ""1.25""') && text.includes('.InnerRadius ""0.75""') && text.includes('.Axis ""x""'), "CST", "the side tube is an x Cylinder, outer 1.25 / inner 0.75");
  check(text.includes("With Sphere") && text.includes('.CenterRadius ""1.5""') && text.includes('.Center ""-8"", ""6"", ""4""'), "CST", "the sphere is a CST Sphere");
  check(!warnings.some((w) => /^mono: thin wire/.test(w)) && text.includes("Curvewire") && text.includes("ConvertToSolidShape"), "CST", `the wire is a swept Curvewire solid, not skipped: ${warnings.join(" | ")}`);
  check(!warnings.some((w) => /cone|ring|revolution/i.test(w)), "CST", `no warnings about the cone and the torus: ${warnings.join(" | ")}`);
  check(text.includes("With Cone") && text.includes('.BottomRadius ""3""') && text.includes('.TopRadius ""0""') && text.includes(`.Zrange ""${z1}"", ""${z1 + 6}""`), "CST", "the cone is a CST Cone");
  check(text.includes("With Torus") && text.includes('.OuterRadius ""7""') && text.includes('.InnerRadius ""5""') && text.includes('.Zcenter ""20""'), "CST", "the ring is a CST Torus");
}
{
  const f = fabModel(synthetic);
  check(f.available, "fab", `available (${f.reason})`);
  const via = f.drills.find((d) => d.kind === "via" && Math.abs(d.x - 5) < 1e-9 && Math.abs(d.y - 5) < 1e-9);
  check(!!via && Math.abs(via.d - 2) < 1e-9, "fab", `the vertical tube through the substrate is a 2 mm via (${JSON.stringify(via)})`);
  check(f.warnings.some((w) => /ball.*sphere/.test(w)), "fab", `the sphere is skipped with a warning: ${f.warnings.join(" | ")}`);
  check(f.warnings.some((w) => /side.*slanted or horizontal/.test(w)), "fab", "the horizontal tube is skipped with a warning");
  check(f.warnings.some((w) => /mono.*thin wire/.test(w)), "fab", "the wire is skipped with a warning");
  check(f.warnings.some((w) => /cone.*solid of revolution/.test(w)) && f.warnings.some((w) => /ring.*solid of revolution/.test(w)), "fab", "cone and torus are skipped with a warning");
}


// 4. Display colors: part over material over theme; the CST macro carries them, invalid values are dropped.
{
  const { resolveColor, validColor } = await import("../src/designer/colors.ts");
  check(resolveColor({ color: "#112233" }, { color: "#445566" }, "#abcdef") === "#112233", "colors", "part color wins");
  check(resolveColor({}, { color: "#445566" }, "#abcdef") === "#445566", "colors", "material color next");
  check(resolveColor(undefined, undefined, "#abcdef") === "#abcdef", "colors", "theme color last");
  check(resolveColor({ color: "red" }, { color: "#12" }, "#abcdef") === "#abcdef", "colors", "invalid colors are ignored");
  const base = py.geometry.find((g) => g.design.parts.length >= 1 && g.design.materials.length).design;
  const d = structuredClone(base);
  const mi = d.materials.findIndex((m) => m.name === d.parts[0].material);
  const noColor = quickBundle(structuredClone(base), paramValues(base.params).names, null);
  check(noColor.parts.every((p) => p.color === undefined), "colors", "a design without colors is unchanged");
  d.materials[mi].color = "#ff0000";
  const withMat = quickBundle(d, paramValues(d.params).names, null);
  check(withMat.parts[0].color === "#ff0000", "colors", "material color reaches the bundle part");
  d.parts[0].color = "#00ff00";
  const withPart = quickBundle(d, paramValues(d.params).names, null);
  check(withPart.parts[0].color === "#00ff00", "colors", "part color overrides the material color");
  const diel = withPart.parts.findIndex((p) => p.type === "Material" && p.material && !p.conductor);
  if (diel >= 0) {
    const { text } = cstMacro({ ...withPart, generator: { version: "test" }, created: "2026-01-01", parts: [withPart.parts[diel]] }, DEFAULT_CST_OPTIONS);
    check(/\.Colour ""\d(\.\d+)?"", ""\d(\.\d+)?"", ""\d(\.\d+)?""/.test(text), "colors", "CST material carries .Colour");
  }
  // the CST importer reads .Colour back as #rrggbb (python/tests/test_cst_import.py)
}

// ---- ports do not follow transforms (a 30°-rotated dipole ran with |S11| of 0 dB): the Transform
// panel names the ports that sit on the moved shapes and offers to select them (transformModel.ts)
{
  const w = "Transform ports";
  const d = { ports: [
    { type: "lumped", number: 1, R: "50", start: ["feed", 0, 0], stop: ["feed", 0, "h"], direction: "z" },
    { type: "lumped", number: 2, R: "50", start: [40, 0, 0], stop: [40, 0, 3], direction: "z" },
    { type: "waveguide", number: 3, start: ["bad +", 0, 0], stop: [0, 0, 1], direction: "z" },
  ] };
  const names = { feed: -6, h: 1.524 };
  const patch = [[-16, -20, 1.524], [16, 20, 1.524]];       // the patch sheet, z = h
  const ground = [[-30, -30, 0], [30, 30, 0]];
  const hits = (boxes) => portsAtShapes(d, boxes, names).map((p) => p.number);
  check(JSON.stringify(hits([patch])) === "[1]", w, "port 1 stands on the patch (its upper end), port 2 is far away, port 3 does not evaluate");
  check(JSON.stringify(hits([ground])) === "[1]", w, "its lower end lies on the ground plane");
  check(hits([[[100, 100, 100], [110, 110, 110]]]).length === 0, w, "a shape far from every port affects none");
  check(JSON.stringify(portsAtShapes(d, [[[39.9999999, -1, 0], [41, 1, 3]]], names).map((p) => p.index)) === "[1]", w, "the result carries the port's index (for Select)");
  check(hits([[[-6.5, -1, 0.5], [-5.5, 1, 1]]]).length === 0, w, "a box that only lies between the two ends touches neither");
  const grouped = { ports: [{ ...d.ports[1], group: { connection: "parallel", members: [{ start: [60, 0, 0], stop: [60, 0, 3], direction: "z" }] } }] };
  check(JSON.stringify(portsAtShapes(grouped, [[[59, -1, 3], [61, 1, 3]]], names).map((p) => p.number)) === "[2]", w, "an additional feed of a grouped port on the moved shape names that port");
  // which transforms leave no original in place
  const mv = { type: "move", offset: [1, 0, 0] };
  check(displacesOriginal(mv), w, "a move displaces");
  check(!displacesOriginal({ type: "translate", copies: 2, step: [1, 0, 0] }), w, "copies keep the original");
  check(displacesOriginal({ type: "rotate", axis: "y", center: [0, 0, 0], angle: 30, copies: 0 }), w, "a rotation without copies displaces");
  check(displacesOriginal({ type: "rotate", axis: "y", center: [0, 0, 0], angle: 30 }), w, "a rotation without a copies field displaces");
  check(!displacesOriginal({ type: "rotate", axis: "y", center: [0, 0, 0], angle: 30, copies: 3 }), w, "a rotation with copies keeps the original");
  check(displacesOriginal({ type: "rotate", axis: "y", center: [0, 0, 0], angle: 30, copies: "0" }), w, "a copies text of zero is no copy");
  check(displacesOriginal({ type: "scale", factors: [2, 2, 2], origin: [0, 0, 0] }), w, "a scale in place displaces");
  check(!displacesOriginal({ type: "scale", factors: [2, 2, 2], origin: [0, 0, 0], copies: 1 }), w, "a scale with a copy keeps the original");
  check(displacesOriginal({ type: "mirror", plane: "x", keep: false }), w, "a mirror without the original displaces");
  check(!displacesOriginal({ type: "mirror", plane: "x", keep: true }) && !displacesOriginal({ type: "mirror", plane: "x" }), w, "a mirror keeping the original does not");
  // the dialog: the memo of the boolean, the metal parts only, a warning with a Select button per port
  const dlg = readFileSync(join(root, "src/designer/dialogs/TransformDialog.tsx"), "utf8");
  check(/createMemo\(\(\) => displacesOriginal\(transform\(\)\)\)/.test(dlg), w, "typing in a field does not rebuild the bounds");
  check(/p\.type === "Metal"\)\.map\(\(p\) => p\.bbox\)/.test(dlg) && /portsAtShapes\(baseline, boxes, names\(\)\.names\)/.test(dlg), w, "the metal shapes' bounds against the ports");
  check(/role="alert"/.test(dlg) && /setSelection\(\{ type: "port", i: p\.index \}\)/.test(dlg) && /t\("transform\.ports\.select", \{ n: p\.number \}\)/.test(dlg), w, "a prominent warning with a button that selects the port");
  const en = JSON.parse(readFileSync(join(root, "src/i18n/en.json"), "utf8"));
  const tr = JSON.parse(readFileSync(join(root, "src/i18n/tr.json"), "utf8"));
  for (const k of ["transform.ports.title", "transform.ports.body", "transform.ports.select"]) check(en[k] && tr[k], w, `${k} in both languages`);
  check(/no longer span the feed gap/.test(en["transform.ports.body"].other) && /\{ports\}/.test(en["transform.ports.body"].other), w, "the warning names the ports");
}

// ---- the feed checks offer to add a port (no one-click fix for "no port" and "floating feed")
{
  const w = "Check actions";
  check(checkAction({ code: "no-port" }, 0) === "add-port", w, "no port: add one");
  check(checkAction({ code: "no-port" }, 2) === null, w, "ports exist but none is excited: switch one on, not another port");
  check(checkAction({ code: "port-floating" }, 1) === "add-port", w, "a floating feed: add a port");
  check(checkAction({ code: "port-in-metal" }, 1) === null && checkAction({ code: "expr" }, 0) === null, w, "other checks have no extra action");
  for (const file of ["src/designer/DesignPane.tsx", "src/designer/RunDialog.tsx"]) {
    const text = readFileSync(join(root, file), "utf8");
    check(/checkAction\(c, draft\.ports\?\.length \?\? 0\)/.test(text) && /t\("contextMenu\.addPort"\)/.test(text), w, `${file}: the button, worded as the menu item`);
  }
  const en = JSON.parse(readFileSync(join(root, "src/i18n/en.json"), "utf8"));
  check(en["contextMenu.addPort"] === "Add a discrete port…", w, "the label");
  // the server's fix for a floating end, worded as asked, comes with the same words in en.json and Turkish
  check(en["checks.fix.port-floating.snap"].startsWith("Move the end onto the nearest metal face ("), w, "'Move the end onto the nearest metal face'");
  check(!JSON.stringify(fx).includes("Snap the end"), w, "no stale 'Snap the end' label in the shared cases");
}

console.log(`check-designer: ${checks} checks, ${failures} failed (${fx.expressions.length} expressions, ${fx.cases.length} cases)`);
process.exit(failures ? 1 : 0);
