// Generate CST macros for every bundle in public/projects/index.json and run static sanity checks.
//
//   node --experimental-strip-types scripts/gen-cst-examples.mjs
//
// Writes examples/cst/<bundle-stem>.bas. Exits non-zero if any check fails. The checks are static
// (no CST available): VBA structure, history block shape, quoting, numbers, solid bookkeeping and
// curve references.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cstMacro, DEFAULT_CST_OPTIONS } from "../src/export/cst.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projects = join(root, "public", "projects");
const outDir = join(root, "examples", "cst");
mkdirSync(outDir, { recursive: true });

const EPS = 1e-9;
const SOLID_OBJECTS = new Set(["Brick", "Cylinder", "Sphere", "CoverCurve", "ExtrudeCurve", "STL"]);

/** Independent list of the primitives the exporter should turn into solids, as their bundle bbox. */
function exportable(bundle) {
  const out = [];
  for (const part of bundle.parts) {
    if (!(part.type === "Metal" || part.type === "ConductingSheet" || (part.type === "Material" && part.material))) continue;
    for (const p of part.primitives) {
      let ok = false;
      if (p.kind === "box") {
        ok = p.start.filter((v, i) => Math.abs(v - p.stop[i]) < EPS).length <= 1;
      } else if (p.kind === "polygon" || p.kind === "linpoly") {
        const pts = p.points.filter((q, i, a) => i === 0 || Math.abs(q[0] - a[i - 1][0]) > EPS || Math.abs(q[1] - a[i - 1][1]) > EPS);
        let area = 0;
        pts.forEach(([x0, y0], i) => {
          const [x1, y1] = pts[(i + 1) % pts.length];
          area += x0 * y1 - x1 * y0;
        });
        ok = pts.length >= 3 && Math.abs(area) > EPS;
      } else if (p.kind === "cylinder" || p.kind === "cylindricalshell") {
        const d = p.stop.map((v, i) => v - p.start[i]);
        ok = d.filter((v) => Math.abs(v) > EPS).length === 1 && p.radius > EPS;
      } else if (p.kind === "sphere") {
        ok = p.radius > EPS;
      } else if (p.kind === "polyhedron") {
        ok = true; // written as an STL file and imported with the STL object
      }
      if (ok) out.push({ part: part.name, bbox: p.bbox });
    }
  }
  return out;
}

const UNIT_M = { m: 1, cm: 1e-2, mm: 1e-3, um: 1e-6, nm: 1e-9 };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nums = (lits) => lits.map(Number);

/** Strings of a VBA statement: `"a ""b"""` -> ['a "b"']. Returns null when quoting is unbalanced. */
function stringLiterals(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "'") break; // comment
    if (line[i] !== '"') {
      i++;
      continue;
    }
    let s = "";
    i++;
    for (;;) {
      if (i >= line.length) return null;
      if (line[i] === '"') {
        if (line[i + 1] === '"') {
          s += '"';
          i += 2;
          continue;
        }
        i++;
        break;
      }
      s += line[i++];
    }
    out.push(s);
  }
  return out;
}

function withBalance(stmts, where, errors) {
  let depth = 0;
  for (const s of stmts) {
    const t = s.trim();
    if (/^With\s+\S/.test(t)) depth++;
    else if (/^End\s+With$/.test(t)) {
      depth--;
      if (depth < 0) errors.push(`${where}: End With without With`);
    }
  }
  if (depth > 0) errors.push(`${where}: ${depth} unclosed With`);
}

function check(text, bundle, files = []) {
  const errors = [];
  const lines = text.split("\r\n");
  if (lines[lines.length - 1] !== "") errors.push("missing final CRLF");
  if (/[\r\n]/.test(text.replace(/\r\n/g, ""))) errors.push("bare CR or LF line ending");
  for (const bad of [/NaN/, /undefined/, /Infinity/, /\bnull\b/, /\[object/]) {
    if (bad.test(text)) errors.push(`output contains '${bad.source}'`);
  }
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(text)) errors.push("non-ASCII character in output");
  if (!lines.includes("Option Explicit")) errors.push("missing Option Explicit");
  if (lines.filter((l) => /^Sub Main\b/.test(l)).length !== 1) errors.push("expected exactly one Sub Main");
  if (lines.filter((l) => l === "End Sub").length !== 1) errors.push("expected exactly one End Sub");

  const blocks = [];
  const top = [];
  let cur = null;
  lines.forEach((raw, idx) => {
    const ln = idx + 1;
    let l = raw.trim();
    if (!l || l.startsWith("'")) return;
    // the STL path is built at run time: `"..FileName """ + sStlDir + "name.stl"""` is one literal here
    if (l.includes('" + sStlDir + "')) l = l.replace('" + sStlDir + "', "<STLDIR>");
    const lits = stringLiterals(l);
    if (lits === null) {
      errors.push(`line ${ln}: unbalanced quotes`);
      return;
    }
    if (l === 'sCommand = ""') {
      if (cur) errors.push(`line ${ln}: history block started inside block '${cur.start}'`);
      cur = { start: ln, body: [], title: null };
    } else if (l.startsWith("sCommand = sCommand + ")) {
      if (!cur) errors.push(`line ${ln}: sCommand appended outside a history block`);
      else if (!/^sCommand = sCommand \+ ".*" \+ vbLf$/.test(l) || lits.length !== 1) errors.push(`line ${ln}: malformed sCommand line`);
      else cur.body.push({ s: lits[0], ln });
    } else if (l.startsWith("AddToHistory ")) {
      if (!cur) errors.push(`line ${ln}: AddToHistory without sCommand = ""`);
      else if (!/^AddToHistory ".*", sCommand$/.test(l) || lits.length !== 1) errors.push(`line ${ln}: malformed AddToHistory`);
      else {
        cur.title = lits[0];
        cur.end = ln;
        blocks.push(cur);
      }
      cur = null;
    } else {
      if (cur) errors.push(`line ${ln}: statement inside history block '${cur.start}' before AddToHistory`);
      top.push(l);
    }
    // history body strings must themselves be balanced VBA lines
    if (l.startsWith("sCommand = sCommand + ") && lits && lits.length === 1 && stringLiterals(lits[0]) === null) {
      errors.push(`line ${ln}: unbalanced quotes inside history command`);
    }
  });
  if (cur) errors.push(`history block at line ${cur.start} never reaches AddToHistory`);
  withBalance(top, "top level", errors);

  const titles = new Map();
  for (const b of blocks) titles.set(b.title, (titles.get(b.title) ?? 0) + 1);
  for (const [t, k] of titles) if (k > 1) errors.push(`history title used ${k} times: '${t}'`);

  // ---- per-block semantics
  const solids = new Set(); // "comp:name" currently alive
  const materials = new Set(["PEC", "Vacuum"]);
  const needMaterial = new Set(); // STL solids still without their Solid.ChangeMaterial
  const geometry = []; // global bbox of every created solid, in creation order (CST length unit)
  let unitM = null;
  // working coordinate system as CST would hold it: local frame W=N, U, V=W x U
  const wcs = { local: false, N: [0, 0, 1], O: [0, 0, 0], U: [1, 0, 0] };
  const toGlobal = (u, v, w = 0) => {
    if (!wcs.local) return [u, v, w];
    const V = cross(wcs.N, wcs.U);
    return [0, 1, 2].map((i) => wcs.O[i] + u * wcs.U[i] + v * V[i] + w * wcs.N[i]);
  };
  const boxOf = (pts) => [0, 1, 2].map((i) => [Math.min(...pts.map((p) => p[i])), Math.max(...pts.map((p) => p[i]))]);
  let created = 0;
  for (const b of blocks) {
    const where = `block '${b.title}' (line ${b.start})`;
    if (!b.body.length) errors.push(`${where}: empty`);
    withBalance(b.body.map((x) => x.s), where, errors);

    const polygons = new Map(); // "curve:name" -> local points
    const newCurves = new Set();
    let obj = null;
    let props = {};
    const flush = () => {
      if (!obj) return;
      if (obj === "Polygon") {
        if (!props.Name || !props.Curve) errors.push(`${where}: Polygon without .Name/.Curve`);
        else {
          if (!newCurves.has(props.Curve)) errors.push(`${where}: Polygon curve '${props.Curve}' not created with Curve.NewCurve`);
          polygons.set(`${props.Curve}:${props.Name}`, (props.points ?? []).map((p) => p.split(",").map(Number)));
        }
        const pts = props.points ?? [];
        if (pts.length < 4 || pts[0] !== pts[pts.length - 1]) errors.push(`${where}: polygon not closed`);
      }
      if (obj === "Material" && props.Name) materials.add(props.Name);
      if (SOLID_OBJECTS.has(obj)) {
        const full = `${props.Component}:${props.Name}`;
        if (!props.Name || !props.Component) errors.push(`${where}: ${obj} without .Name/.Component`);
        else if (solids.has(full.toLowerCase())) errors.push(`${where}: duplicate solid name '${full}'`);
        solids.add(full.toLowerCase());
        created++;
        if (obj === "STL") needMaterial.add(full.toLowerCase());
        else if (!props.Material || !materials.has(props.Material)) errors.push(`${where}: undefined material '${props.Material}'`);
        if (obj === "CoverCurve" || obj === "ExtrudeCurve") {
          if (!props.Curve || !polygons.has(props.Curve)) errors.push(`${where}: ${obj} curve '${props.Curve}' does not match a Polygon in this block`);
          else {
            const t = obj === "ExtrudeCurve" ? Number(props.Thickness) : 0;
            if (obj === "ExtrudeCurve" && !(t > 0)) errors.push(`${where}: ExtrudeCurve thickness must be positive`);
            const loc = polygons.get(props.Curve);
            geometry.push(boxOf(loc.flatMap(([u, v]) => [toGlobal(u, v, 0), toGlobal(u, v, t)])));
          }
        } else if (obj === "STL") {
          const name = (props.FileName ?? "").replace("<STLDIR>", "");
          const f = files.find((x) => x.name === name);
          if (!f) { errors.push(`${where}: STL file '${name}' was not written`); geometry.push([[NaN, NaN], [NaN, NaN], [NaN, NaN]]); }
          else {
            if (!/^solid /.test(f.data) || !/endsolid /.test(f.data)) errors.push(`${where}: '${name}' is not an ASCII STL`);
            const v = [...f.data.matchAll(/vertex (\S+) (\S+) (\S+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
            if (!v.length || v.length % 3) errors.push(`${where}: '${name}' has ${v.length} vertices (not a multiple of 3)`);
            if (props.ScaleToUnit !== "True" || props.ImportFileUnits !== (Object.keys(UNIT_M).find((k) => UNIT_M[k] === unitM) ?? "?")) errors.push(`${where}: STL import units do not match the project unit`);
            geometry.push(boxOf(v));
          }
        } else if (obj === "Brick") {
          geometry.push(["X", "Y", "Z"].map((a) => nums(props[`${a}range`] ?? [NaN, NaN])));
        } else if (obj === "Sphere") {
          const r = Number(props.CenterRadius);
          geometry.push((props.Center ?? [NaN, NaN, NaN]).map((v) => [Number(v) - r, Number(v) + r]));
        } else if (obj === "Cylinder") {
          const ax = "xyz".indexOf(props.Axis);
          const r = Number(props.OuterRadius);
          if (!(Number(props.InnerRadius) >= 0 && Number(props.InnerRadius) < r)) errors.push(`${where}: Cylinder inner radius ${props.InnerRadius} not in [0, ${r})`);
          geometry.push(["X", "Y", "Z"].map((a, i) =>
            i === ax ? nums(props[`${a}range`] ?? [NaN, NaN]) : [Number(props[`${a}center`]) - r, Number(props[`${a}center`]) + r]));
        }
      }
      obj = null;
      props = {};
    };
    for (const { s, ln } of b.body) {
      const t = s.trim();
      const lits = stringLiterals(t) ?? [];
      let mm;
      if ((mm = /^With (\w+)$/.exec(t))) {
        flush();
        obj = mm[1];
      } else if (t === "End With") flush();
      else if (obj && (mm = /^\.(\w+)\b/.exec(t))) {
        const key = mm[1];
        if (["Name", "Component", "Material", "FileName", "ScaleToUnit", "ImportFileUnits", "Curve", "Thickness", "Axis", "OuterRadius", "InnerRadius", "CenterRadius"].includes(key) || /center$/.test(key)) props[key] = lits[0];
        if (key === "Center") props.Center = lits;
        if (/range$/.test(key)) props[key] = lits;
        if (obj === "Units" && key === "SetUnit" && lits[0] === "Length") unitM = UNIT_M[lits[1]] ?? null;
        if (key === "Point" || key === "LineTo") (props.points ??= []).push(lits.join(","));
        for (const v of lits) if (/^-?\d/.test(v) && !Number.isFinite(Number(v))) errors.push(`line ${ln}: bad number '${v}'`);
      } else if (/^Curve\.NewCurve /.test(t)) newCurves.add(lits[0]);
      else if (/^WCS\.ActivateWCS /.test(t)) wcs.local = lits[0] === "local";
      else if (/^WCS\.SetNormal /.test(t)) wcs.N = nums(lits);
      else if (/^WCS\.SetOrigin /.test(t)) wcs.O = nums(lits);
      else if (/^WCS\.SetUVector /.test(t)) wcs.U = nums(lits);
      else if (/^Solid\.Add /.test(t)) {
        const [a, bb] = lits;
        if (!solids.has(a?.toLowerCase()) || !solids.has(bb?.toLowerCase())) errors.push(`line ${ln}: Solid.Add on unknown solid (${a}, ${bb})`);
        solids.delete(bb?.toLowerCase());
      } else if (/^Solid\.ChangeMaterial /.test(t)) {
        const [a, mat] = lits;
        if (!needMaterial.delete(a?.toLowerCase())) errors.push(`line ${ln}: Solid.ChangeMaterial on '${a}', which is not an imported STL solid awaiting a material`);
        if (!materials.has(mat)) errors.push(`line ${ln}: Solid.ChangeMaterial to undefined material '${mat}'`);
      } else if (/^Solid\.Rename /.test(t)) {
        const [a, nn] = lits;
        const compName = a?.split(":")[0];
        if (!solids.has(a?.toLowerCase())) errors.push(`line ${ln}: Solid.Rename of unknown solid '${a}'`);
        if (nn?.includes(":")) errors.push(`line ${ln}: Solid.Rename new name must not contain a component`);
        if (solids.has(`${compName}:${nn}`.toLowerCase())) errors.push(`line ${ln}: Solid.Rename to existing name '${nn}'`);
        solids.delete(a?.toLowerCase());
        solids.add(`${compName}:${nn}`.toLowerCase());
      } else if (obj === null && !/^(WCS\.|Component\.New |Solver\.|ChangeSolverType )/.test(t)) {
        errors.push(`line ${ln}: unexpected history statement '${t}'`);
      }
    }
    flush();
  }

  if (needMaterial.size) errors.push(`STL solids without a material: ${[...needMaterial].join(", ")}`);
  const expected = exportable(bundle);
  if (created !== expected.length) errors.push(`created ${created} solids, expected ${expected.length} exportable primitives`);
  // round trip: every solid, mapped back through its WCS, must cover exactly its primitive's bbox
  if (unitM === null) errors.push("length unit not set or unknown");
  else {
    const scale = (bundle.units?.length_m ?? 1e-3) / unitM;
    expected.forEach(({ part, bbox }, k) => {
      const g = geometry[k];
      if (!g) return;
      for (let i = 0; i < 3; i++) {
        const want = [bbox[0][i] * scale, bbox[1][i] * scale];
        if (Math.abs(g[i][0] - want[0]) > 1e-6 || Math.abs(g[i][1] - want[1]) > 1e-6) {
          errors.push(`solid #${k + 1} (${part}) axis ${"xyz"[i]}: [${g[i]}] != bbox [${want}]`);
        }
      }
    });
  }
  return { errors, blocks: blocks.length, solids: created, finalSolids: solids.size, lines: lines.length - 1 };
}

const index = JSON.parse(readFileSync(join(projects, "index.json"), "utf8"));
let failed = 0;
for (const entry of index.projects) {
  const bundle = JSON.parse(readFileSync(join(projects, entry.file), "utf8"));
  const stem = entry.file.replace(/\.json$/i, "");
  const { text, warnings, files } = cstMacro(bundle, DEFAULT_CST_OPTIONS, { macroBase: stem });
  const out = join(outDir, `${stem}.bas`);
  writeFileSync(out, text);
  for (const f of files) writeFileSync(join(outDir, f.name), f.data);
  const r = check(text, bundle, files);
  const status = r.errors.length ? "FAIL" : "ok";
  console.log(
    `${status.padEnd(4)} ${stem}: ${r.lines} lines, ${r.blocks} history blocks, ${r.solids} solids created ` +
      `(${r.finalSolids} after merge), ${warnings.length} warnings`,
  );
  for (const w of warnings) console.log(`       warning: ${w}`);
  for (const e of r.errors.slice(0, 40)) console.log(`       error: ${e}`);
  if (r.errors.length > 40) console.log(`       ... ${r.errors.length - 40} more errors`);
  if (r.errors.length) failed++;
}
// ---- synthetic edge cases (not written to disk): every normal axis, negative LinPoly length,
// repeated closing vertex, cylinder, name collisions, non-mm unit, unsupported/degenerate primitives
const bb = (lo, hi) => [lo, hi];
const synthetic = {
  ...JSON.parse(readFileSync(join(projects, index.projects[0].file), "utf8")),
  name: "synthetic \u00b7 \"quoted\"\nname",
  units: { length: "cm", length_m: 0.01, frequency: "Hz" },
  parts: [
    { name: "PEC", type: "Material", color: "#ff0000", bbox: bb([0, 0, 0], [1, 1, 1]),
      material: { eps_r: 2, kappa: 0, mu_r: 1, tan_d: null, tan_d_freq: null, isotropic: true },
      primitives: [{ kind: "box", start: [0, 0, 0], stop: [1, 1, 1], priority: 0, bbox: bb([0, 0, 0], [1, 1, 1]), exact: true }] },
    { name: "a b", type: "Metal", bbox: bb([0, 0, 0], [1, 1, 1]), primitives: [
      { kind: "polygon", normal: 0, elevation: 2, points: [[0, 0], [1, 0], [1, 3], [0, 0]], priority: 1, bbox: bb([2, 0, 0], [2, 1, 3]), exact: true },
      { kind: "polygon", normal: 2, elevation: -1, points: [[0, 0], [2, 0], [2, 1]], priority: 1, bbox: bb([0, 0, -1], [2, 1, -1]), exact: true },
      { kind: "linpoly", normal: 1, elevation: 5, length: -2, points: [[0, 0], [1, 0], [1, 4]], priority: 1, bbox: bb([0, 3, 0], [4, 5, 1]), exact: true },
      { kind: "cylinder", start: [1, 2, 3], stop: [1, 2, -3], radius: 0.5, priority: 1, bbox: bb([0.5, 1.5, -3], [1.5, 2.5, 3]), exact: true },
      { kind: "polygon", normal: 2, elevation: 0, points: [[0, 0], [1, 1], [2, 2]], priority: 1, bbox: bb([0, 0, 0], [2, 2, 0]), exact: true },
      { kind: "bbox", source_kind: "Sphere", priority: 1, bbox: bb([0, 0, 0], [1, 1, 1]), exact: false },
      // designer shapes: a tube (radius = middle of the wall) along y and a sphere
      { kind: "cylindricalshell", start: [3, -1, 2], stop: [3, 4, 2], radius: 0.75, shell_width: 0.5, priority: 1, bbox: bb([2, -1, 1], [4, 4, 3]), exact: true },
      { kind: "sphere", center: [5, 5, 5], radius: 1.5, priority: 1, bbox: bb([3.5, 3.5, 3.5], [6.5, 6.5, 6.5]), exact: true },
    ] },
    { name: "a_b_1", type: "Metal", bbox: bb([0, 0, 0], [1, 1, 0]), primitives: [
      { kind: "box", start: [0, 0, 7], stop: [1, 1, 7], priority: 1, bbox: bb([0, 0, 7], [1, 1, 7]), exact: true }] },
    { name: "a-b", type: "ConductingSheet", bbox: bb([0, 0, 0], [0, 1, 1]), primitives: [
      { kind: "box", start: [4, 0, 0], stop: [4, 1, 1], priority: 1, bbox: bb([4, 0, 0], [4, 1, 1]), exact: true }] },
  ],
};
{
  const { text, warnings } = cstMacro(synthetic, { ...DEFAULT_CST_OPTIONS, component: "my:comp" });
  const r = check(text, synthetic);
  const wantWarn = ["degenerate polygon", "Sphere", "conducting sheet"];
  for (const w of wantWarn) if (!warnings.some((x) => x.includes(w))) r.errors.push(`self-test: expected a warning about '${w}'`);
  if (!text.includes('.Name ""PEC_2""')) r.errors.push("self-test: material named PEC must be renamed");
  // the tube (middle radius 0.75, wall 0.5) is outer 1 / inner 0.5; the sphere keeps its radius
  if (!text.includes('.OuterRadius ""1""') || !text.includes('.InnerRadius ""0.5""')) r.errors.push("self-test: the tube must be a Cylinder with an inner radius");
  if (!text.includes("With Sphere") || !text.includes('.CenterRadius ""1.5""')) r.errors.push("self-test: the sphere must be a CST Sphere");
  console.log(`${(r.errors.length ? "FAIL" : "ok").padEnd(4)} self-test: ${r.solids} solids, ${warnings.length} warnings`);
  for (const e of r.errors.slice(0, 40)) console.log(`       error: ${e}`);
  if (r.errors.length) {
    writeFileSync(join(outDir, "_selftest-failed.bas"), text);
    failed++;
  }
}

if (failed) {
  console.error(`${failed} bundle(s) failed the CST macro checks`);
  process.exit(1);
}
