// Vertex editing model (#66): world positions under part transforms, stored points back from the
// world, midpoints for insertion and the minimum point counts.
//   node --experimental-strip-types scripts/check-vertex-model.mjs (also run by check:boolean)
import assert from "node:assert/strict";
import { edgeMidpoint, insertVertex, moveVertex, removeVertex, storedPoint, vertexFrame } from "../src/designer/vertexModel.ts";

const poly = { kind: "polygon", normal: "z", elevation: "h", points: [[0, 0], ["W", 0], ["W", 4]] };
const part = (prim, transforms) => ({ name: "p", material: "Cu", primitives: [prim], ...(transforms ? { transforms } : {}) });

// untransformed: world = local, the sheet's plane is z = h
let f = vertexFrame(part(poly), poly, { h: 1.5, W: 10 });
assert.deepEqual(f.world, [[0, 0, 1.5], [10, 0, 1.5], [10, 4, 1.5]]);
assert.equal(f.planeAxis, 2);
assert.equal(f.planeValue, 1.5);
assert.deepEqual(storedPoint(poly, f.map, [3, 2, 1.5]), [3, 2]);
assert.equal(f.dragSupported, true);

// moved and quarter-turned about z: handles where the part is drawn, stored points in its own frame
const turned = part(poly, [{ type: "move", offset: [5, 0, 0] }, { type: "rotate", axis: "z", center: [0, 0, 0], angle: 90 }]);
f = vertexFrame(turned, poly, { h: 1.5, W: 10 });
assert.deepEqual(f.world.map((p) => p.map((x) => Math.round(x * 1e9) / 1e9)), [[0, 5, 1.5], [0, 15, 1.5], [-4, 15, 1.5]]);
assert.deepEqual(storedPoint(poly, f.map, [-2, 10, 1.5]), [5, 2]);

// a copy array edits the original (the first instance)
const arrayed = part(poly, [{ type: "translate", copies: 2, step: [20, 0, 0] }]);
assert.deepEqual(vertexFrame(arrayed, poly, { h: 0, W: 10 }).world[1], [10, 0, 0]);

// a mirrored sheet (x normal) maps its elevation too
const side = { kind: "polygon", normal: "x", elevation: 2, points: [[0, 0], [1, 0], [1, 1]] };
f = vertexFrame(part(side, [{ type: "mirror", plane: "x", keep: false }]), side, {});
assert.equal(f.planeAxis, 0);
assert.equal(f.planeValue, -2);
assert.deepEqual(storedPoint(side, f.map, [-2, 0.5, 0.25]), [0.5, 0.25]);

// General rotation preserves exact world points and local-coordinate editing, but a tilted sheet
// cannot be dragged on a WCS-axis plane without leaving its own plane.
const tilted = part(poly, [{ type: "rotate", axis: "x", center: [0, 0, 0], angle: 30 }]);
f = vertexFrame(tilted, poly, { h: 1.5, W: 10 });
assert.equal(f.dragSupported, false);
assert.equal(f.planeAxis, undefined);
assert.deepEqual(f.world[0].map((x) => Math.round(x * 1e9) / 1e9), [0, -0.75, 1.299038106]);
assert.deepEqual(storedPoint(poly, f.map, f.world[1]).map((x) => Math.round(x * 1e9) / 1e9), [10, 0]);

// A general in-plane rotation still has a WCS z drag plane and remains safely draggable.
const inPlane = part(poly, [{ type: "rotate", axis: "z", center: [0, 0, 0], angle: 30 }]);
f = vertexFrame(inPlane, poly, { h: 1.5, W: 10 });
assert.equal(f.dragSupported, true);
assert.equal(f.planeAxis, 2);
assert.equal(f.planeValue, 1.5);

// wires: 3D points; the coordinate the drag plane holds keeps its expression
const wire = { kind: "wire", radius: 0.5, points: [[0, 0, "L"], [0, 0, 0], [4, 0, 0]] };
f = vertexFrame(part(wire), wire, { L: 8 });
assert.deepEqual(f.world[0], [0, 0, 8]);
assert.equal(f.planeAxis, undefined);
assert.deepEqual(storedPoint(wire, f.map, [1, 2, 8], wire.points[0], 2), [1, 2, "L"]);

// Preserve a wire's local z expression under an in-plane general rotation. When no local
// coordinate remains fixed on the selected WCS plane, keep the exact preview by storing numbers.
const spunWire = part(wire, [{ type: "rotate", axis: "z", center: [0, 0, 0], angle: 30 }]);
f = vertexFrame(spunWire, wire, { L: 8 });
assert.equal(f.dragSupported, true);
assert.deepEqual(storedPoint(wire, f.map, [1, 2, 8], wire.points[0], 2), [1.866025, 1.232051, "L"]);
assert.ok(storedPoint(wire, f.map, [1, 2, 8], wire.points[0], 0).every((x) => typeof x === "number"));

// midpoints: polygons close, wires do not
assert.deepEqual(edgeMidpoint(poly, 2, { W: 10 }), [5, 2]);
assert.equal(edgeMidpoint(wire, 2, { L: 8 }), null);
assert.deepEqual(edgeMidpoint(wire, 0, { L: 8 }), [0, 0, 4]);

// insert, move, remove; minimums refused
const p = JSON.parse(JSON.stringify(poly));
insertVertex(p, 0, [5, 0]);
assert.deepEqual(p.points, [[0, 0], [5, 0], ["W", 0], ["W", 4]]);
moveVertex(p, 1, [5, -1]);
assert.deepEqual(p.points[1], [5, -1]);
assert.equal(removeVertex(p, 1), true);
assert.equal(removeVertex(p, 0), false);
assert.equal(p.points.length, 3);
const w = JSON.parse(JSON.stringify(wire));
assert.equal(removeVertex(w, 1), true);
assert.equal(removeVertex(w, 0), false);

// an unevaluable point gives no frame instead of NaN handles
assert.equal(vertexFrame(part(poly), poly, {}), null);
console.log("Vertex model: transformed frames, stored points, midpoints and minimum counts passed");
