// Pure Node/Python math, instant-preview and export contracts. No browser or solver.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { evaluate, namesIn, paramKeyError, paramValues, renameInExpr } from "../src/designer/expr.ts";
import { quickBundle } from "../src/designer/geometry.ts";
import { cstMacro } from "../src/export/cst.ts";
import { fabFiles } from "../src/fab/index.ts";
import { regionArea } from "../src/fab/polygon.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.FAIRBEAM_PYTHON || (process.platform === "win32" ? "python" : "python3");
const payload = JSON.parse(execFileSync(python, ["python/tests/test_inset_patch_starter.py", "--json"], {
  cwd: root, encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" },
}));
let checks = 0;
const close = (a, b) => { checks++; assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${a} != ${b}`); };
const equal = (a, b) => { checks++; assert.deepEqual(a, b); };
const must = (a, message) => { checks++; assert.ok(a, message); };
for (const { design: d, values, parts } of payload) {
  for (const key of ["params", "materials", "parts", "ports", "resistors"]) must(Array.isArray(d[key]), `${key}: Designer collection contract`);
  equal(d.resistors, []); equal(d.ports[0].type, "lumped");
  const { names, errors } = paramValues(d.params);
  equal(Object.keys(errors), []);
  for (const [key, value] of Object.entries(values)) close(names[key], value);
  const qb = quickBundle(d, names, null);
  must(qb, "instant preview must succeed");
  equal(qb.parts.length, 3);
  parts.forEach((part, i) => {
    equal(qb.parts[i].primitives.length, part.prims.length);
    part.prims.forEach((box, j) => {
      const got = qb.parts[i].primitives[j];
      for (const key of ["start", "stop"]) got[key].forEach((v, k) => close(v, box[key][k]));
    });
  });
  equal(qb.ports[0].R, 50);
  close(qb.ports[0].start[2], 0);
  close(qb.ports[0].stop[2], names.h);
  equal(d.far_field.frequencies, ["f0"]);
  close(evaluate(d.far_field.frequencies[0], names), names.f0);
  const b = { ...qb, generator: { version: "test" }, created: "2026-10-23" };
  const cst = cstMacro(b, undefined, { parametric: d });
  must(cst.text.includes("DiscretePort"), "CST must include the feed port");
  must(!cst.text.includes("NaN") && !cst.text.includes("Infinity"), "finite CST geometry");
  // New numerical synthesis functions are not native CST expressions. Export
  // must disclose frozen feed/inset values, never claim full parameter replay.
  const caveats = [...cst.notes, ...cst.warnings].join("\n");
  must(caveats.includes("microstrip_width") && caveats.includes("patch_inset"), "CST must disclose numeric synthesis fallbacks");
  for (const key of ["feed_w", "inset"]) {
    const parameter = cst.parameters.find((p) => p.key === key);
    close(parameter.value, names[key]); equal(parameter.expression, undefined);
  }
  const fab = fabFiles(b);
  must(fab.model.available, "planar inset board must be fabricable");
  equal(fab.model.layers.length, 2);
  equal(fab.model.drills.length, 0);
  equal(fab.model.edgePorts[0].edge, "left");
  equal(fab.model.edgePorts[0].R, 50);
  const top = fab.model.layers.find((layer) => Math.abs(layer.z - names.h) < 1e-8);
  must(top, "top copper layer must exist");
  const area = top.regions.reduce((sum, region) => sum + regionArea(region), 0);
  // Fabrication polygons snap coordinates to 1 nm (Gerber 4.6). Sum the four
  // disjoint rectangles on that actual output grid, not unsnapped analytic area.
  const nm = (x) => Math.round(x * 1e6) / 1e6;
  const rectangle = (x0, x1, y0, y1) => (nm(x1) - nm(x0)) * (nm(y1) - nm(y0));
  const copperArea = rectangle(names.x_in, names.L / 2, -names.W / 2, names.W / 2)
    + 2 * rectangle(-names.L / 2, names.x_in, names.slot_y, names.W / 2)
    + rectangle(names.x_feed, names.x_in, -names.feed_w / 2, names.feed_w / 2);
  close(area, copperArea);
  must(fab.files.some((f) => f.path.endsWith(".gbr")) && fab.files.some((f) => f.path.endsWith(".dxf")), "Gerber and DXF outputs");
}
// Shared evaluator fixture includes wrong arity, domain refusals and coexistence
// with saved bare parameters that use the new call spellings.
const fixture = JSON.parse(readFileSync(resolve(root, "python/tests/fixtures/designer_parity.json"), "utf8"));
for (const row of fixture.expressions.filter((x) => /microstrip_width|patch_inset/.test(x.expr))) {
  if (row.error) { checks++; assert.throws(() => evaluate(row.expr, fixture.names)); }
  else close(evaluate(row.expr, fixture.names), row.value);
}
equal(paramKeyError("microstrip_width"), null);
equal(paramKeyError("patch_inset"), null);
equal([...namesIn("microstrip_width+microstrip_width(50,eps_r,h)+patch_inset")].sort(), ["eps_r", "h", "microstrip_width", "patch_inset"]);
equal(renameInExpr("microstrip_width + microstrip_width(50,eps_r,h)", "microstrip_width", "old_width"),
  "old_width + microstrip_width(50,eps_r,h)");
equal(renameInExpr("patch_inset + patch_inset(50,L,W,f0)", "patch_inset", "old_inset"),
  "old_inset + patch_inset(50,L,W,f0)");
for (const locale of ["en", "tr"]) {
  const texts = JSON.parse(readFileSync(resolve(root, `src/i18n/${locale}.json`), "utf8"));
  for (const key of ["name", "sub", "created"]) must(texts[`templates.insetPatch.${key}`], `${locale} template ${key}`);
  must(/convergence|yakınsama/.test(texts["templates.insetPatch.sub"]), `${locale} synthesis caveat before creation`);
}
console.log(`Inset patch: ${checks} analytical/preview/export checks passed across ${payload.length} designs. No EM simulation or browser run.`);
