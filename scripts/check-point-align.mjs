// Point-to-point alignment, camera navigation in pick modes and distinct ribbon icons (0.6.2).
//   node --experimental-strip-types scripts/check-point-align.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { alignOffset, applyPointAlign } from "../src/designer/pointAlign.ts";
import { resolvePointCandidate } from "../src/designer/pointGeometry.ts";
import { primitiveGeometry } from "../src/scene/geometry.ts";

const box = (name, start, stop, extra = {}) => ({ name, material: "Cu", primitives: [{ kind: "box", exact: true, start, stop }], ...extra });
const design = () => ({ parts: [box("brick", [-50, 50, 0], [-27, 63, 0]), box("sub", [-50, 50, 0], [50, 100, 1.6]), box("patch", [-10, 60, 1.6], [10, 80, 1.6])] });

// reported case: A = brick's far corner (-27, 63, 0), B = (-50, 50, 0) -> the brick (the owner of A) moves by B - A
assert.deepEqual(alignOffset([-27, 63, 0], [-50, 50, 0]), [-23, -13, 0]);
// all three axes, float noise removed, no negative zero
assert.deepEqual(alignOffset([1, 2, 3], [4, 6, 3.1]), [3, 4, 0.1]);
// float32 mesh vertices (1.6 as 1.5999999) do not leak into the offset
assert.deepEqual(alignOffset([-27, 63, 5], [-50, 50, Math.fround(1.6)]), [-23, -13, -3.4]);
assert.ok(Object.is(alignOffset([1, 1, 1], [1, 1, 1])[2], 0));

let d = design();
const i = applyPointAlign(d, "brick", alignOffset([-27, 63, 0], [-50, 50, 3]));
assert.equal(i, 0);
assert.deepEqual(d.parts[0].transforms, [{ type: "move", offset: [-23, -13, 3] }]);
assert.deepEqual(d.parts[0].primitives, design().parts[0].primitives, "stored geometry is not baked");
assert.deepEqual(d.parts[1], design().parts[1], "other solids stay where they are");
assert.equal(applyPointAlign(d, "nope", [1, 0, 0]), -1);
// a zero offset adds no transform; a second align stacks a second move (editable in the Transform list)
d = design();
applyPointAlign(d, "sub", [0, 0, 0]);
assert.equal(d.parts[1].transforms, undefined);
applyPointAlign(d, "sub", [1, 0, 0]); applyPointAlign(d, "sub", [0, 2, 0]);
assert.equal(d.parts[1].transforms.length, 2);
// a parametric / Boolean part keeps its expressions and history; only a transform is appended
const live = { name: "slot", material: "Cu", primitives: [{ kind: "box", start: [0, 0, 0], stop: ["L", "W", 0] }], booleanHistory: { operation: "subtract", A: box("a", [0, 0, 0], [1, 1, 0]), B: box("b", [0, 0, 0], [1, 1, 0]), live: true } };
d = { parts: [live] };
applyPointAlign(d, "slot", [5, 0, 0]);
assert.deepEqual(d.parts[0].primitives[0].stop, ["L", "W", 0]);
assert.ok(d.parts[0].booleanHistory.live);
assert.deepEqual(d.parts[0].transforms, [{ type: "move", offset: [5, 0, 0] }]);

// picks: the owning part is recorded; vertex, edge midpoint and face centre are all offered
const prim = { kind: "box", exact: true, start: [0, 0, 0], stop: [2, 4, 6] };
const mesh = new THREE.Mesh(primitiveGeometry(prim), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
mesh.userData = { primitive: prim, part: "brick" };
mesh.updateMatrixWorld();
const cast = (o, dir) => new THREE.Raycaster(new THREE.Vector3(...o), new THREE.Vector3(...dir).normalize()).intersectObject(mesh)[0];
for (const mode of ["align-source", "align-target"]) {
  const corner = resolvePointCandidate(cast([1.95, 0.1, 20], [0, 0, -1]), mode, "A");
  assert.equal(corner.kind, "vertex"); assert.equal(corner.part, "brick");
  assert.deepEqual(corner.point.map((v) => Math.round(v * 1e6) / 1e6), [2, 0, 6]);
  const mid = resolvePointCandidate(cast([1, 0.05, 20], [0, 0, -1]), mode, "A");
  assert.equal(mid.kind, "edge midpoint");
  assert.deepEqual(mid.point.map((v) => Math.round(v * 1e6) / 1e6), [1, 0, 6]);
  const centre = resolvePointCandidate(cast([1, 2, 20], [0, 0, -1]), mode, "A");
  assert.equal(centre.kind, "face centre");
  assert.deepEqual(centre.point.map((v) => Math.round(v * 1e6) / 1e6), [1, 2, 6]);
}
assert.equal(resolvePointCandidate(cast([1.95, 0.1, 20], [0, 0, -1]), "vertex", "A").part, "brick");

// camera: pick modes never take the left button away from the orbit controls (a click is a press and
// release within a few pixels); only drawing does
const viewport = readFileSync(new URL("../src/scene/Viewport.tsx", import.meta.url), "utf8");
const m = viewport.match(/const toolActive = ([^;]+);/);
assert.ok(m, "toolActive in Viewport.tsx");
assert.ok(!/pointPickMode|facePicking|extrudeFacePicking|transformPlacement/.test(m[1]), `toolActive must not include pick modes: ${m[1]}`);
for (const f of ["../src/scene/Viewport.tsx", "../src/scene/drawOverlay.ts"]) {
  assert.match(readFileSync(new URL(f, import.meta.url), "utf8"), /Math\.hypot\(e\.clientX - downAt\.x, e\.clientY - downAt\.y\) > 4/, `${f} ignores a drag as a click`);
}

// icons: one icon, one action (the same action may repeat, e.g. Efficiency on two tabs)
const src = (f) => readFileSync(new URL(`../src/designer/${f}`, import.meta.url), "utf8");
const ws = src("DesignWorkspace.tsx"), pt = src("pointTools.tsx"), tr = src("transformRibbon.ts"), pane = src("DesignPane.tsx");
const uses = [];
for (const r of ws.matchAll(/<RButton icon=\{(\w+)\} label=\{t\("([^"]+)"\)/g)) uses.push([r[1], r[2]]);
for (const r of `${ws}\n${pt}`.matchAll(/<(\w+) size=\{16\} aria-hidden="true" \/><span>\{t\("([^"]+)"\)\}/g)) uses.push([r[1], r[2]]);
for (const r of ws.matchAll(/icon: (\w+) \}/g)) { const line = ws.slice(ws.lastIndexOf("\n", r.index) + 1, r.index); const l = line.match(/label: "([^"]+)"/); if (l) uses.push([r[1], l[1]]); }
for (const r of tr.matchAll(/opItem\("\w+", (\w+), "(\w+)"\)/g)) uses.push([r[1], `ribbon.transform.${r[2]}`]);
uses.push(["Move", "ribbon.transform.transform"]);
const by = new Map();
for (const [icon, label] of uses) { if (!by.has(icon)) by.set(icon, new Set()); by.get(icon).add(label.replace(/^ribbon.(sim|post)./, "ribbon.")); }
assert.ok(uses.length > 50, `found ${uses.length} icon uses`);
for (const [icon, labels] of by) assert.equal(labels.size, 1, `${icon} is used for different actions: ${[...labels].join(", ")}`);
assert.notEqual([...uses].find(([, l]) => l === "pointTools.alignFaces")[0], [...uses].find(([, l]) => l === "ribbon.tools.extrudeFace")[0]);
assert.ok(pane && ws.includes("ArrowUpFromLine"));
console.log(`check-point-align: ok (${uses.length} icon uses, ${by.size} icons)`);
