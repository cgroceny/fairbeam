// Pure interval, attribution and highlight geometry controls; no browser, server or solver.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { meshBottlenecks, likelyMeshSources, bottleneckPlane, bottleneckTarget, meshHighlightSegments, meshMatchesGeometry } from "../src/designer/meshBottlenecks.ts";
import { meshStats } from "../src/designer/meshStats.ts";
import { quickBundle } from "../src/designer/geometry.ts";
import { validateBundle } from "../src/lib/validate.ts";
const cases = JSON.parse(readFileSync(new URL("../python/tests/fixtures/mesh_bottlenecks.json", import.meta.url), "utf8"));
const make = x => ({ units: { length_m: 1e-3 }, mesh: { x, y: [-2, 0, 2], z: [-1, 0, 1], total_cells: (x.length - 1) * 4 }, parts: [] });
for (const c of cases) {
  const a = meshBottlenecks(make(c.lines)).axes[0];
  assert.equal(a.minIndex, c.min_index); assert.deepEqual(a.minInterval, c.min_interval);
  assert.equal(a.ratioIndex, c.ratio_index); assert.deepEqual(a.ratioCoordinates, c.ratio_coordinates);
  assert.ok(Math.abs(a.ratio - c.ratio) < 1e-12); assert.equal(a.addedCellsPerLine, 4);
}
const b = make([0, 0.035, 1]);
b.parts = [{ name: "copper", type: "Metal", bbox: [[0, -1, 0], [0.035, 1, 0.2]], primitives: [] }];
assert.deepEqual(likelyMeshSources(b, "x", 0, 1).map(p => p.name), ["copper"]);
assert.deepEqual(bottleneckPlane(b, "x", b.parts[0]), { axis: "z", index: 1 });
const before = structuredClone(b), selected = { source: b, axis: "x", index: 0, intervals: 1 };
assert.deepEqual(bottleneckTarget(b, selected, "z", 1), [0.0175, 0, 0], "all camera target coordinates are derived from the selected strip");
const edgeBox = { ...b, parts: [{ ...b.parts[0], bbox: [[0, 4, 0], [0.035, 6, 0.2]] }] };
assert.deepEqual(bottleneckTarget(edgeBox, { ...selected, source: edgeBox }, "z", 1), [0.0175, 2, 0], "a heuristic candidate center is clamped to the visible strip");
assert.deepEqual(bottleneckPlane(b, "z"), { axis: "y", index: 1 });
assert.deepEqual(bottleneckTarget(b, { source: b, axis: "z", index: 0, intervals: 1 }, "y", 1), [0.0175, 0, -0.5]);
const pts = meshHighlightSegments(b, selected, "z", 1);
assert.equal(pts.length, 24); assert.ok(pts.every(Number.isFinite));
for (let i = 0; i < pts.length; i += 3) { assert.ok([0, 0.035].includes(pts[i])); assert.equal(pts[i + 2], 0); }
assert.equal(meshHighlightSegments(b, { ...selected, intervals: 2 }, "z", 1).length, 30);
assert.deepEqual(meshHighlightSegments(structuredClone(b), selected, "z", 1), [], "another result cannot inherit the prior highlight");
assert.deepEqual(meshHighlightSegments(b, selected, "x", 0), [], "normal to the interval would hide its width");
assert.deepEqual(meshHighlightSegments(b, { ...selected, index: 9 }, "z", 1), []);
assert.deepEqual(b, before, "inspection never edits the mesh or parts");
b.parts.push({ ...b.parts[0], name: "overlap", primitives: [{ kind: "transformed" }] });
assert.equal(likelyMeshSources(b, "x", 0, 1).length, 2, "ambiguous transformed boxes remain candidates, not one asserted cause");
assert.deepEqual(likelyMeshSources(b, "y", 0, 1), [], "no nearby face does not invent a source");
b.parts.push({ ...b.parts[0], name: "void", void: true });
b.parts.push({ ...b.parts[0], name: "translated", bbox: [[10, -1, 0], [10.035, 1, 0.2]],
  primitives: [{ kind: "transformed", bbox: [[0, -1, 0], [0.035, 1, 0.2]] }] });
assert.deepEqual(likelyMeshSources(b, "x", 0, 1).map(p => p.name), ["copper", "overlap"], "void and local pre-transform boxes are not source evidence");
const meters = structuredClone(b); meters.units.length_m = 1; meters.mesh.x = [0, 0.000035, 0.001];
assert.equal(meshBottlenecks(meters).unitMm, 1000);
assert.ok(Math.abs(meshStats(meters).minCell - 0.035) < 1e-12, "drawing coordinates are converted to displayed mm");
for (const x of [[], [0], [0, 0], [1, 0], [0, NaN], [0, Infinity]]) assert.equal(meshBottlenecks(make(x)), null);
assert.equal(meshBottlenecks({ ...make([0, 1]), mesh: { x: [0, 1], y: [0, 1], z: [0, 1], total_cells: 0 } }), null, "placeholder bounds are not an actual mesh");
assert.equal(meshBottlenecks({ ...make([0, 1]), mesh: { x: [0, 1], y: [0, 1], z: [0, 1], total_cells: 1 } }).axes[0].minWidth, 1, "a genuine one-cell axis remains inspectable");
const fine = make([0, 1, 1.0001, ...Array.from({ length: 3999 }, (_, i) => i + 2)]);
assert.equal(meshBottlenecks(fine).axes[0].minIndex, 1);
const finePoints = meshHighlightSegments(fine, { source: fine, axis: "x", index: 1, intervals: 1 }, "z", 1);
assert.equal(finePoints.length, 24);
for (let i = 0; i < finePoints.length; i += 3) assert.ok([1, 1.0001].includes(finePoints[i]), "highlight retains original indices even when display thinning omits index 1");
const design = { model: { id: "mesh-source", name: "Mesh source" }, materials: [{ name: "metal", kind: "metal" }],
  parts: [{ name: "plate", material: "metal", primitives: [{ kind: "box", start: [0, -1, 0], stop: [0.035, 1, 0.2] }] }],
  ports: [], simulation: { f_min: 1, f_max: 2, boundaries: "MUR" } };
const initial = quickBundle(design, {}, null);
assert.ok(initial); assert.equal(meshBottlenecks(initial), null);
const server = { ...initial, mesh: make([0, 0.035, 1]).mesh };
assert.ok(meshMatchesGeometry(server)); assert.equal(likelyMeshSources(server, "x", 0, 1).length, 1);
for (const previous of [server, quickBundle(design, {}, server)]) {
  const quick = quickBundle(design, {}, previous);
  assert.ok(quick); assert.equal(quick.mesh, previous.mesh);
  assert.equal(meshMatchesGeometry(quick), false, "every reuse, including repeated quick previews, is marked");
  assert.deepEqual(likelyMeshSources(quick, "x", 0, 1), [], "old mesh never implicates new geometry");
  const validated = validateBundle(quick).bundle;
  assert.equal(validated, quick); assert.equal(meshMatchesGeometry(validated), false, "viewer validation retains provenance identity");
}
assert.ok(meshMatchesGeometry({ ...server }), "a fresh server object supplies matching geometry again");
console.log("mesh bottlenecks: shared locations, ties, units, original indices, candidates, exact highlight, camera and real quick-preview provenance controls passed");
