#!/usr/bin/env node
// Bundle validation and robustness: every committed bundle must validate cleanly, and malformed
// variants of them (truncated arrays, "NaN" strings, missing sections, wrong schema, random garbage)
// must either be refused with a reason or open repaired, and then survive the code paths the viewer
// runs on open (sweep, pattern cuts, S-matrix, drawing, CST macro, figures, CSV/Touchstone).
// Usage: node --experimental-strip-types scripts/check-bundles.mjs   (part of npm run check:exports)
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBundle } from "../src/lib/validate.ts";
import { patternCut, sweep } from "../src/lib/rf.ts";
import { sMatrix } from "../src/lib/sparams.ts";
import { technicalDrawing } from "../src/drawing/drawing.ts";
import { figureSet } from "../src/drawing/charts.ts";
import { cstMacro, DEFAULT_CST_OPTIONS } from "../src/export/cst.ts";
import { touchstoneS1p } from "../src/export/touchstone.ts";
import { sweepCsv } from "../src/export/csv.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projects = join(root, "public", "projects");
let checks = 0;
let failed = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) {
    failed++;
    console.log(`FAIL ${msg}`);
  }
};

/** what the viewer derives from a bundle right after opening it; must not throw */
function exercise(b, label) {
  try {
    sweep(b);
    for (const ff of b.results?.farfield ?? []) patternCut(ff.theta, ff.phi, ff.directivity_dbi, 0, !!b.half_space);
    sMatrix(b);
    return true;
  } catch (e) {
    console.log(`  ${label}: ${e.stack?.split("\n").slice(0, 3).join(" | ")}`);
    return false;
  }
}
/** user-triggered exports (drawing view, CST dialog, figures, data): these run behind a panel error
 * boundary or a try/catch in the app, so a throw is contained; we count them rather than fail */
function exportsOk(b) {
  try {
    technicalDrawing(b, { sheet: "A3", date: "2026-01-01" });
    cstMacro(b, { ...DEFAULT_CST_OPTIONS });
    if (b.results) {
      figureSet(b);
      if (sweep(b)) {
        touchstoneS1p(b);
        sweepCsv(b);
      }
    }
    return true;
  } catch {
    return false;
  }
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const files = readdirSync(projects).filter((f) => f.endsWith(".json") && f !== "index.json");
const studies = join(projects, "studies");
for (const d of readdirSync(studies, { withFileTypes: true })) {
  if (d.isDirectory()) for (const f of readdirSync(join(studies, d.name))) if (f.endsWith(".json")) files.push(`studies/${d.name}/${f}`);
}

// 1. every committed bundle validates without errors or warnings and survives the open path
for (const f of files) {
  const raw = JSON.parse(readFileSync(join(projects, f), "utf8"));
  const v = validateBundle(clone(raw));
  ok(v.bundle && !v.errors.length, `${f}: refused: ${v.errors.join(" ")}`);
  ok(!v.warnings.length, `${f}: warnings: ${v.warnings.join(" ")}`);
  if (v.bundle) {
    ok(exercise(v.bundle, f), `${f}: open path threw`);
    ok(exportsOk(v.bundle), `${f}: an export threw on a valid bundle`);
  }
}

// 2. targeted malformations of the patch antenna (single port, far field, signals)
const base = JSON.parse(readFileSync(join(projects, "patch-antenna.json"), "utf8"));
const port = Object.keys(base.results.ports)[0];
const cases = [
  ["wrong schema", (b) => (b.schema = "something/2"), "refused"],
  ["not an object", () => "text", "refused"],
  ["mesh.x missing", (b) => delete b.mesh.x, "refused"],
  ["mesh.y has strings", (b) => (b.mesh.y[1] = "abc"), "refused"],
  ["parts missing", (b) => delete b.parts, "refused"],
  ["results missing", (b) => delete b.results, "open"],
  ["S11 truncated", (b) => b.results.ports[port].s11_re.splice(10), "open-warn"],
  ["Zin with NaN strings", (b) => { b.results.ports[port].zin_re[3] = "NaN"; b.results.ports[port].zin_im[5] = null; }, "open-warn"],
  ["frequency truncated", (b) => b.results.frequency.splice(100), "open-warn"],
  ["far field row truncated", (b) => b.results.farfield[0].directivity_dbi[4].pop(), "open-warn"],
  ["far field NaN strings", (b) => (b.results.farfield[0].directivity_dbi[2][3] = "NaN"), "open-warn"],
  ["dmax missing", (b) => delete b.results.farfield[0].dmax_dbi, "open"],
  ["signals mismatched", (b) => b.results.signals.u_ref?.splice(5), "open-warn"],
  ["bands not a list", (b) => (b.results.bands = "none"), "open"],
  ["a part without primitives", (b) => delete b.parts[0].primitives, "open-warn"],
  ["a primitive without bbox", (b) => delete b.parts[0].primitives[0].bbox, "open"],
  ["ports not a list", (b) => (b.ports = {}), "open-warn"],
  ["boundaries missing", (b) => delete b.solver.boundaries, "open-warn"],
  ["model.params garbage", (b) => (b.model.params = 5), "open-warn"],
  ["run garbage", (b) => (b.run = "x"), "open-warn"],
  ["half_space garbage", (b) => (b.half_space = { axis: "z" }), "open-warn"],
  // fuzz #274 regression: an absurd length unit made every exported coordinate non-finite (CST macro threw)
  ["units.length_m huge", (b) => (b.units.length_m = 1e308), "open-warn"],
  ["units.length_m zero", (b) => (b.units.length_m = 0), "open-warn"],
  ["units.length_m string", (b) => (b.units.length_m = "mm"), "open-warn"],
];
for (const [name, mutate, expect] of cases) {
  let b = clone(base);
  const r = mutate(b);
  if (typeof r === "string" && name === "not an object") b = r;
  let v;
  try {
    v = validateBundle(b);
  } catch (e) {
    ok(false, `case "${name}": validateBundle threw ${e.message}`);
    continue;
  }
  if (expect === "refused") ok(!v.bundle && v.errors.length, `case "${name}": expected refusal`);
  else {
    ok(!!v.bundle, `case "${name}": expected to open, got ${v.errors.join(" ")}`);
    if (expect === "open-warn") ok(v.warnings.length > 0, `case "${name}": expected a warning`);
    if (v.bundle) {
      ok(exercise(v.bundle, name), `case "${name}": open path threw after repair`);
      ok(exportsOk(v.bundle), `case "${name}": an export threw after repair`);
    }
  }
}

// 3. surface-current plane with the wrong map size (a bundle with fields, if any is committed)
const withFields = files.map((f) => [f, JSON.parse(readFileSync(join(projects, f), "utf8"))]).find(([, b]) => b.fields?.planes?.length);
if (withFields) {
  const b = clone(withFields[1]);
  b.fields.planes[0].frequencies[0].values.splice(7);
  const v = validateBundle(b);
  ok(v.bundle && v.warnings.some((w) => w.includes("Surface-current plane")), `fields: expected the short plane to be dropped (${withFields[0]})`);
}

// 3b. element patterns: the int16 bundles open cleanly (section 1); an unknown encoding or a missing
// int16 scale is reported, and the float32 backward-compatibility fixture's section still validates
{
  const arr = JSON.parse(readFileSync(join(projects, "patch-array-4x1.json"), "utf8"));
  const fx = JSON.parse(readFileSync(join(root, "examples/fixtures/element-patterns-f32.json"), "utf8"));
  const b32 = clone(arr);
  b32.results.element_patterns = fx.results.element_patterns;
  const v32 = validateBundle(b32);
  ok(v32.bundle && !v32.warnings.length && v32.bundle.results.element_patterns?.encoding === "f32le-base64", `element patterns: float32 section: ${v32.warnings.join(" ")}`);
  const unk = clone(arr);
  unk.results.element_patterns.encoding = "f64le-base64";
  const vu = validateBundle(unk);
  ok(vu.bundle && !vu.bundle.results.element_patterns && vu.warnings.some((w) => w.includes("unknown encoding")), "element patterns: unknown encoding not reported");
  const ns = clone(arr);
  delete ns.results.element_patterns.ports[1].fields[0].scale;
  const vn = validateBundle(ns);
  ok(vn.bundle && vn.warnings.some((w) => w.includes("no valid scale")) && exercise(vn.bundle, "missing scale"), "element patterns: missing scale not reported");
}

// 4. random fuzz: replace random nodes with garbage; must never throw, and repaired bundles survive
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const garbage = [null, "NaN", "", [], {}, -1, 1e308, "abc", [1, "x"], { a: 1 }];
function paths(o, prefix = [], out = [], depth = 0) {
  if (depth > 5 || o === null || typeof o !== "object") return out;
  const keys = Array.isArray(o) ? [...Array(Math.min(o.length, 3)).keys()] : Object.keys(o);
  for (const k of keys) {
    out.push([...prefix, k]);
    paths(o[k], [...prefix, k], out, depth + 1);
  }
  return out;
}
const allPaths = paths(base);
let opened = 0;
let refused = 0;
let exportThrows = 0;
for (let i = 0; i < 300; i++) {
  const b = clone(base);
  for (let m = 0; m < 3; m++) {
    const p = allPaths[Math.floor(rnd() * allPaths.length)];
    let o = b;
    for (const k of p.slice(0, -1)) o = o?.[k];
    if (o && typeof o === "object") o[p[p.length - 1]] = garbage[Math.floor(rnd() * garbage.length)];
  }
  let v;
  try {
    v = validateBundle(b);
  } catch (e) {
    ok(false, `fuzz #${i}: validateBundle threw ${e.message}`);
    continue;
  }
  if (v.bundle) {
    opened++;
    ok(exercise(v.bundle, `fuzz #${i}`), `fuzz #${i}: open path threw after repair (${v.warnings.length} warnings)`);
    if (!exportsOk(v.bundle)) exportThrows++;
  } else refused++;
}
console.log(`fuzz: 300 malformed bundles, ${opened} opened repaired, ${refused} refused with a reason; ${exportThrows} would make an export throw`);
ok(exportThrows === 0, `fuzz: ${exportThrows} repaired bundles made an export throw`);
console.log(`${checks} bundle checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
