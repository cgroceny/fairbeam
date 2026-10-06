// Focused quickBundle cache regression: compare cached output with a fresh module/cache after edits.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { quickBundle } from "../src/designer/geometry.ts";

const geometryUrl = pathToFileURL(resolve("src/designer/geometry.ts")).href;
let freshId = 0;
async function freshBundle(design, names) {
  const module = await import(`${geometryUrl}?fresh=${freshId++}`);
  return module.quickBundle(design, names, null);
}

const points = Array.from({ length: 768 }, (_, i) => {
  const a = (2 * Math.PI * i) / 768;
  return [String(10 * Math.cos(a)), String(10 * Math.sin(a))];
});
const box = { kind: "box", start: ["w", 0, 0], stop: ["w + 2", 2, 2] };
const polygon = { kind: "polygon", normal: "z", elevation: "h", points };
const sheet = { kind: "box", start: [20, 0, 0], stop: [20, 10, 10] };
const dielectricShape = { kind: "sphere", center: [0, 0, 5], radius: 1 };
const base = {
  schema: "fairbeam.design/1",
  model: { id: "cache-test", name: "Cache test" },
  params: [],
  simulation: { f_min: 1, f_max: 2, boundaries: "PEC" },
  materials: [{ name: "metal", kind: "metal", color: "#888" }, { name: "dielectric", kind: "dielectric", eps_r: 3 }],
  parts: [
    { name: "same part", material: "metal", primitives: [box, polygon, sheet], cuts: [{ start: [20, 4, 4], stop: [20, 6, 6] }] },
    { name: "dielectric part", material: "dielectric", primitives: [dielectricShape] },
  ],
  ports: [], resistors: [], mesh: { mode: "auto", cells_per_wavelength: 20 }, far_field: { enabled: false },
};
const names = { w: 1, h: 3 };
const cloneDesign = (partChanges = {}, materialChanges = {}, dielectricChanges = {}) => ({
  ...base,
  materials: base.materials.map((m) => m.name === "metal" ? { ...m, ...materialChanges }
    : { ...m, ...dielectricChanges }),
  parts: [{ ...base.parts[0], ...partChanges }, base.parts[1]],
});
const json = (v) => JSON.stringify(v);
const assertMatchesFresh = async (label, design, values = names) => {
  const actual = quickBundle(design, values, null);
  const expected = await freshBundle(design, values);
  assert.ok(actual, `${label}: cached quickBundle should build`);
  assert.ok(expected, `${label}: fresh quickBundle should build`);
  assert.equal(json(actual), json(expected), `${label}: cached output differs from fresh output`);
  return actual;
};

const initial = await assertMatchesFresh("initial", base);
const polygonIndex = 1;
const initialPolygonExpansion = initial.parts[0].primitives[polygonIndex];

const irrelevant = cloneDesign({ label: "renamed", color: "#f00" }, { color: "#123" });
const irrelevantResult = await assertMatchesFresh("irrelevant label/color/material value", irrelevant);
assert.equal(irrelevantResult.parts[0].primitives[polygonIndex], initialPolygonExpansion,
  "irrelevant edit should retain the polygon expansion");
const dielectricEdit = cloneDesign({}, {}, { eps_r: 4 });
const dielectricResult = await assertMatchesFresh("dielectric value edit", dielectricEdit);
assert.equal(dielectricResult.parts[1].material.eps_r, 4, "dielectric value should stay fresh");
assert.equal(dielectricResult.parts[1].primitives[0], initial.parts[1].primitives[0],
  "dielectric value edit should retain unchanged geometry");

const boxEdit = cloneDesign({ primitives: [{ ...box, start: ["w", 0, 1], stop: ["w + 2", 2, 3] }, polygon, sheet] });
const boxResult = await assertMatchesFresh("same-part box edit", boxEdit);
assert.equal(boxResult.parts[0].primitives[polygonIndex], initialPolygonExpansion,
  "same-part box edit should reuse the unchanged polygon expansion");

const editedPolygon = { ...polygon, elevation: "h + 1" };
const polygonEdit = cloneDesign({ primitives: [box, editedPolygon, sheet] });
const polygonResult = await assertMatchesFresh("polygon edit", polygonEdit);
assert.notEqual(polygonResult.parts[0].primitives[polygonIndex], initialPolygonExpansion,
  "polygon edit should replace its expansion");

const transformEdit = cloneDesign({ transforms: [{ type: "move", offset: [1, 0, 0] }] });
await assertMatchesFresh("transform edit", transformEdit);

await assertMatchesFresh("relevant parameter edit", base, { w: 4, h: 3 });
const materialKindEdit = cloneDesign({}, { kind: "dielectric", eps_r: 4 });
const kindDesign = { ...materialKindEdit, parts: [{ ...materialKindEdit.parts[0], material: "metal" }] };
// The material object's kind changes while its name stays fixed, invalidating default priorities.
await assertMatchesFresh("material-kind edit", kindDesign);

const undoEquivalent = cloneDesign();
await assertMatchesFresh("undo-equivalent snapshot", undoEquivalent);

// Solid's produce mutates raw objects in place; object identity alone cannot invalidate a cache.
const mutable = structuredClone(base);
await assertMatchesFresh("mutable initial", mutable);
mutable.parts[0].primitives[1].points[0][0] = "11";
await assertMatchesFresh("in-place polygon coordinate", mutable);
mutable.parts[0].primitives[1].points[0][0] = points[0][0];
await assertMatchesFresh("in-place polygon undo", mutable);

console.log("geometry cache: cached output matches fresh output across edits; unchanged polygon expansion reused");
