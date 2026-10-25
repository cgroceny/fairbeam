// Pure cross-language schema, model appearance, identity and export controls.
// Does not start a server, browser, native library or solver.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { resolvedDatasheet, datasheetAppearance } from "../src/designer/dispersion.ts";
import { evaluate, paramKeyError, paramValues } from "../src/designer/expr.ts";
import { mapExpressions, parameterUses, pathOwner, renameParameter } from "../src/designer/paramRefs.ts";
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
// Enforce the stdlib-only bridge on developer machines too: an installed native
// SDK must not hide an accidental eager package import that fails in web CI.
const py = JSON.parse(execFileSync(python, ["-I", "-S", join(root, "python/tests/wideband_fixture.py")], {
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

// Run the actual store rename/use/delete closures with only reactive/history/message boundaries
// replaced. AST extraction avoids importing the app, bundling, a browser, or a server.
const storeText = readFileSync(join(root, "src/designer/store.ts"), "utf8");
const storeAst = parse(storeText, { sourceType: "module", plugins: ["typescript"] });
const selectedFunctions = ["paramKeyProblem", "renameParam", "ownerText", "paramUsers", "removeParam"];
const functionSources = selectedFunctions.map(name => {
  const declaration = storeAst.program.body.map(n => n.type === "ExportNamedDeclaration" ? n.declaration : n)
    .find(n => n?.type === "FunctionDeclaration" && n.id?.name === name);
  assert.ok(declaration, `production store function ${name} exists`);
  return storeText.slice(declaration.start, declaration.end);
});
const lifecycle = structuredClone(py.blank);
lifecycle.params.push({ key: "lower", default: 4, label: "lower" }, { key: "lower_extra", default: 8 });
lifecycle.materials.push({ ...structuredClone(fixture.base), name: "lower", dispersion: {
  model: "djordjevic-sarkar", m1: "lower", m2: "lower + lower_extra", n_poles: 8,
} });
const materialIndex = lifecycle.materials.length - 1;
const cornerPaths = ["m1", "m2"].map(key => `materials[${materialIndex}].dispersion.${key}`);
assert.deepEqual(parameterUses(lifecycle, "lower"), cornerPaths, "both DS corner expressions are parameter uses");
const visited = [];
mapExpressions(lifecycle, path => { visited.push(path); });
assert.ok(!visited.some(path => /\.dispersion\.(model|n_poles)$/.test(path)), "model discriminant and pole count are not expressions");
const unsupported = structuredClone(lifecycle);
unsupported.materials[materialIndex].dispersion.model = "unknown-model";
assert.deepEqual(parameterUses(unsupported, "lower"), [], "unknown model payloads are not traversed as DS expressions");
const messages = [], edits = [], states = [structuredClone(lifecycle)];
let selected = { type: "param", i: lifecycle.params.findIndex(p => p.key === "lower") };
const dependencies = {
  draft: lifecycle, parameterUses, pathOwner, renameParameter, paramKeyError,
  parameterErrorTitle: v => v, unwrap: v => v,
  t: (key, values) => key === "checks.place.material" ? values.name : JSON.stringify({ key, ...values }),
  setMessage: v => messages.push(v),
  selection: () => selected, setSelection: v => { selected = v; },
  edit: callback => { callback(lifecycle); edits.push(structuredClone(lifecycle)); },
};
const store = new Function(...Object.keys(dependencies), stripTypeScriptTypes(functionSources.join("\n")) +
  ";return {renameParam,paramUsers,removeParam};")(...Object.values(dependencies));
const parameterIndex = lifecycle.params.findIndex(p => p.key === "lower");
assert.deepEqual(store.paramUsers("lower"), { count: 2, places: ["lower"] });
assert.equal(store.removeParam(parameterIndex), false, "actual store delete refuses a parameter used only in DS corners");
assert.equal(edits.length, 0, "refused deletion does not edit the design");
assert.equal(JSON.parse(messages.at(-1).text).count, 2);
assert.equal(store.renameParam(parameterIndex, "corner"), null);
assert.equal(edits.length, 1, "rename remains one store edit");
assert.deepEqual(parameterUses(lifecycle, "lower"), []);
assert.deepEqual(parameterUses(lifecycle, "corner"), cornerPaths);
assert.deepEqual(lifecycle.materials[materialIndex].dispersion,
  { model: "djordjevic-sarkar", m1: "corner", m2: "corner + lower_extra", n_poles: 8 });
assert.equal(lifecycle.materials[materialIndex].name, "lower", "material names are not parameter expressions");
assert.equal(lifecycle.params[parameterIndex].label, "lower", "parameter labels stay unchanged");
states.push(structuredClone(lifecycle));
assert.equal(store.removeParam(parameterIndex), false, "renamed corner parameter remains protected");
lifecycle.materials[materialIndex].dispersion.m1 = 4;
assert.deepEqual(parameterUses(lifecycle, "corner"), [cornerPaths[1]], "m2 alone still protects the parameter");
assert.equal(store.removeParam(parameterIndex), false);
states.push(structuredClone(lifecycle));
lifecycle.materials[materialIndex].dispersion.m2 = 12;
assert.equal(store.removeParam(parameterIndex), true, "actual store delete succeeds once both uses are replaced");
assert.ok(!lifecycle.params.some(p => p.key === "corner"));
assert.deepEqual(selected, { type: "design" }, "deleting the selected parameter clears its selection");
states.push(structuredClone(lifecycle));
const dangling = structuredClone(states[0]);
dangling.params = dangling.params.filter(p => p.key !== "lower");
states.push(dangling); // External/malformed edits must still fail closed in both implementations.
const stateResults = JSON.parse(execFileSync(python, ["-I", "-S", join(root, "python/tests/wideband_fixture.py"), "--designs"], {
  env: { ...process.env, PYTHONPATH: join(root, "python") }, input: JSON.stringify(states), encoding: "utf8",
}));
for (const [i, state] of states.entries()) {
  const names = paramValues(state.params).names;
  const material = state.materials[materialIndex], result = stateResults[i].materials[0];
  if (i === states.length - 1) {
    assert.ok(result.error, "Python rejects externally removed corner parameter");
    assert.throws(() => resolvedDatasheet(material, v => evaluate(v, names)));
  } else {
    const resolved = resolvedDatasheet(material, v => evaluate(v, names));
    for (const key of ["eps_r", "tan_d", "tan_d_freq"]) near(resolved[key], result.input[key]);
    for (const key of ["m1", "m2"]) near(resolved[key], result.input.dispersion[key]);
    assert.equal(result.input.dispersion.n_poles, material.dispersion.n_poles);
    assert.equal(resolved.m1, 4); assert.equal(resolved.m2, 12);
  }
  assert.deepEqual(designChecks(state).filter(c => c.path.startsWith("materials."))
    .map(c => `${c.severity}|${c.code}|${c.path}`).sort(), stateResults[i].checks,
  `lifecycle ${i}: TS/Python diagnostics parity`);
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
console.log(`wideband materials: ${fixture.cases.length} shared input/check cases; 5 edited-design parity states; production rename/use/delete closures, DS-only traversal, datasheet appearance, library copy, bundle/export warning and EN/TR controls passed`);
