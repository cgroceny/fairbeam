// Pure cross-language schema, model appearance, identity and export controls.
// Does not start a server, browser, native library or solver.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolvedDatasheet, datasheetAppearance } from "../src/designer/dispersion.ts";
import { evaluate, paramValues } from "../src/designer/expr.ts";
import { designChecks } from "../src/designer/checks.ts";
import { quickBundle } from "../src/designer/geometry.ts";
import { cleanUserMaterial, userMaterialFromDesign, designMaterialFromUser } from "../src/designer/userMaterials.ts";
import { validateBundle } from "../src/lib/validate.ts";
import { cstMacro, DEFAULT_CST_OPTIONS } from "../src/export/cst.ts";
import en from "../src/i18n/en.json" with { type: "json" };
import tr from "../src/i18n/tr.json" with { type: "json" };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const venv = win ? join(root, ".venv/Scripts/python.exe") : join(homedir(), "opt/openEMS/venv/bin/python");
const python = process.env.FAIRBEAM_PYTHON || (existsSync(venv) ? venv : win ? "python" : "python3");
const py = JSON.parse(execFileSync(python, [join(root, "python/tests/wideband_fixture.py")], {
  env: { ...process.env, PYTHONPATH: join(root, "python") }, encoding: "utf8",
}));
const fixture = JSON.parse(readFileSync(join(root, "python/tests/fixtures/wideband_materials.json"), "utf8"));
const near = (a, b) => assert.ok(Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(b)), `${a} ≈ ${b}`);
for (const [i, test] of fixture.cases.entries()) {
  const material = { ...structuredClone(fixture.base), ...test.patch };
  if (test.valid) {
    const input = resolvedDatasheet(material, v => evaluate(v, fixture.names));
    for (const key of ["eps_r", "tan_d", "tan_d_freq"]) near(input[key], py.cases[i].input[key]);
    const appearance = datasheetAppearance(material, v => evaluate(v, fixture.names), input.tan_d_freq);
    near(appearance.eps_r, input.eps_r); near(appearance.tan_d, input.tan_d);
    assert.equal(appearance.dispersion.source.appearance_only, true);
    assert.equal(appearance.dispersion.eps_poles, undefined, "quick preview never invents a solver fit");
  } else assert.throws(() => resolvedDatasheet(material, v => evaluate(v, fixture.names)), test.name);
  const design = structuredClone(py.blank);
  design.params.push(...Object.entries(fixture.names).filter(([key]) => !design.params.some(p => p.key === key)).map(([key, value]) => ({ key, default: value })));
  design.materials.push(material);
  const checks = designChecks(design).filter(c => c.path.startsWith("materials.Laminate")).map(c => `${c.severity}|${c.code}|${c.path}`).sort();
  assert.deepEqual(checks, py.cases[i].checks, `${test.name}: TS/Python check parity`);
}
const material = structuredClone(fixture.base);
const saved = cleanUserMaterial({ id: "laminate", ...material });
assert.ok("entry" in saved);
const copied = designMaterialFromUser(saved.entry);
assert.deepEqual(userMaterialFromDesign(copied, "laminate").entry, saved.entry);
copied.dispersion.m1 = 5;
assert.equal(saved.entry.dispersion.m1, 4, "editing a copy cannot mutate the library");
assert.ok("why" in userMaterialFromDesign({ ...material, dispersion: { model: "djordjevic-sarkar", m1: "parameter" } }, "laminate"));
const design = structuredClone(py.blank);
design.materials.push(material);
design.parts.push({ name: "Laminate", material: "Laminate", primitives: [{ kind: "box", start: [0, 0, 0], stop: [1, 2, 3] }] });
const preview = quickBundle(design, paramValues(design.params).names, null);
assert.ok(preview);
const part = preview.parts.find(p => p.name === "Laminate");
assert.equal(part.material.dispersion.model, "djordjevic-sarkar");
assert.equal(part.material.dispersion.source.appearance_only, true);
validateBundle(preview);
assert.equal(part.material.dispersion.model, "djordjevic-sarkar", "validation retains model identity");
const macro = cstMacro(preview, DEFAULT_CST_OPTIONS);
assert.ok(macro.warnings.some(s => s.includes("Laminate") && s.includes("frequency-dependent") && s.includes("poles are not written")), "unsupported CST dispersion must be explicit");
for (const [key, text] of Object.entries(en).filter(([key]) => key.startsWith("props.material.ds") || key.startsWith("checks.msg.dispersion") || key.startsWith("checks.explain.dispersion"))) {
  assert.equal(typeof tr[key], "string", `${key}: TR translation`);
  assert.deepEqual([...text.matchAll(/\{\w+\}/g)].map(m => m[0]).sort(), [...tr[key].matchAll(/\{\w+\}/g)].map(m => m[0]).sort(), key);
}
console.log(`wideband materials: ${fixture.cases.length} shared input/check cases; datasheet appearance, library copy, bundle/export warning and EN/TR controls passed`);
