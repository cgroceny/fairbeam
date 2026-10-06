import assert from "node:assert/strict";
import { extrudeFace } from "../src/designer/faceExtrude.ts";

const part = (primitive) => ({ name: "source", material: "Cu", primitives: [primitive] });
const face = (axis, sign, value, tris, partName = "source") => ({ part: partName, axis, sign, value, centre: [0, 0, value], tris });
const rect = (z, x0 = 0, y0 = 0, x1 = 10, y1 = 5) => [
  [x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y0, z], [x1, y1, z], [x0, y1, z],
];

const substrate = part({ kind: "box", start: [0, 0, 0], stop: [10, 5, 1.6] });
const bottom = extrudeFace(face(2, -1, 0, rect(0)), substrate, "0.035", 0.035, "Ground", "Copper", "antenna");
assert.deepEqual(bottom.primitives[0], { kind: "box", start: [0, 0, -0.035], stop: [10, 5, 0] });
assert.equal(bottom.primitives[0].start[2] <= bottom.primitives[0].stop[2], true);
assert.equal(bottom.component, "antenna");
const symbolic = extrudeFace(face(2, -1, 0, rect(0), "combined"), { name: "combined", material: "Cu", primitives: substrate.primitives, transforms: [{ type: "translate", copies: 2, step: [12, 0, 0] }] }, "t_cu", 0.035, "Ground2", "Cu");
assert.equal(symbolic.primitives[0].start[2], "0 - (t_cu)");
assert.deepEqual(symbolic.primitives[0].stop, [10, 5, 0]);
const inward = extrudeFace(face(2, 1, 1.6, rect(1.6)), substrate, "-0.2", -0.2, "Inward", "Cu");
assert.ok(Math.abs(inward.primitives[0].start[2] - 1.4) < 1e-12);
assert.deepEqual(inward.primitives[0].stop, [10, 5, 1.6]);

const triangle = { kind: "polygon", normal: "z", elevation: 0, points: [[0, 0], [10, 0], [0, 5]] };
const sheet = extrudeFace(face(2, 1, 0, [[0, 0, 0], [10, 0, 0], [0, 5, 0]]), part(triangle), "T", 0, "Sheet", "Cu");
assert.equal(sheet.primitives[0].kind, "polygon");
assert.equal(sheet.primitives[0].elevation, 0);
assert.equal(sheet.primitives[0].points.length, 3);
const cap = extrudeFace(face(2, 1, 0, rect(0)), part({ kind: "linpoly", normal: "z", elevation: 0, length: 2, points: [[0, 0], [10, 0], [10, 5], [0, 5]] }), "H", 2, "Cap", "Cu");
assert.equal(cap.primitives[0].kind, "linpoly");
assert.equal(cap.primitives[0].length, "H");
assert.deepEqual(cap.primitives[0].points, [[0, 0], [10, 0], [10, 5], [0, 5]]);

const sideTris = [[0, 0, 0], [10, 0, 0], [10, 0, 2], [0, 0, 0], [10, 0, 2], [0, 0, 2]];
const side = extrudeFace(face(1, -1, 0, sideTris), part({ kind: "linpoly", normal: "z", elevation: 0, length: 2, points: [[0, 0], [10, 0], [10, 5], [0, 5]] }), "d", 0.5, "Side", "Cu");
assert.deepEqual(side.primitives[0].points, [[0, 0], [0, 10], [2, 10], [2, 0]]);
assert.equal(side.primitives[0].normal, "y");
assert.equal(side.primitives[0].length, "-(d)");

// A six-vertex concave L polygon triangulated without replacing it with its bounding rectangle.
const concaveTris = [
  [0, 0, 0], [4, 0, 0], [4, 1, 0], [0, 0, 0], [4, 1, 0], [1, 1, 0],
  [0, 0, 0], [1, 1, 0], [1, 4, 0], [0, 0, 0], [1, 4, 0], [0, 4, 0],
];
const concave = extrudeFace(face(2, 1, 0, concaveTris), part({ kind: "polygon", normal: "z", elevation: 0, points: [] }), 1, 1, "L", "Cu");
assert.equal(concave.primitives[0].points.length, 6);
assert.deepEqual(concave.primitives[0].points, [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]]);

assert.throws(() => extrudeFace(face(2, 1, 0, rect(0)), part({ kind: "sphere", center: [0, 0, 0], radius: 2 }), 1, 1, "bad", "Cu"), /unsupported face extrusion source: sphere/);
assert.throws(() => extrudeFace(face(2, 1, 0, rect(0)), part({ kind: "cylinder", axis: "z", center: [0, 0], radius: 2, range: [0, 3] }), 1, 1, "bad", "Cu"), /unsupported face extrusion source: cylinder/);
console.log("Face extrusion: box ground, signed thickness, sheets, polygon caps/sides, concavity and rejection passed");
