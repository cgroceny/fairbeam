// Face alignment (#66): face candidates from ray hits and the quarter-turn and move transforms
// that put one face against or flush with another.
//   node --experimental-strip-types scripts/check-face-align.mjs (also run by check:boolean)
import assert from "node:assert/strict";
import * as THREE from "three";
import { faceAlignTransforms, resolveFaceCandidate } from "../src/designer/faceAlign.ts";
import { maps, pt } from "../src/designer/geometry.ts";
import { primitiveGeometry } from "../src/scene/geometry.ts";

function hit(primitive, origin, direction, part = "p") {
  const mesh = new THREE.Mesh(primitiveGeometry(primitive), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.userData = { primitive, part };
  mesh.updateMatrixWorld();
  const dir = new THREE.Vector3(...direction).normalize();
  return [new THREE.Raycaster(new THREE.Vector3(...origin), dir).intersectObject(mesh)[0], dir];
}
const face = (...args) => resolveFaceCandidate(...hit(...args));

// a box's top face: exact value and centre, facing +z
const top = face({ kind: "box", exact: true, start: [0, 0, 0], stop: [2, 4, 6] }, [1, 1, 20], [0, 0, -1], "A");
assert.equal(top.part, "A");
assert.equal(top.axis, 2);
assert.equal(top.sign, 1);
assert.equal(top.value, 6);
assert.deepEqual(top.centre, [1, 2, 6]);
assert.ok(top.tris.length >= 6);

// a sheet faces the viewer; a cylinder cap is flat, its side curved; spheres are curved
const sheetBelow = face({ kind: "box", exact: true, start: [0, 0, 1], stop: [5, 5, 1] }, [2, 2, -9], [0, 0, 1]);
assert.equal(sheetBelow.sign, -1);
assert.equal(sheetBelow.value, 1);
const cap = face({ kind: "cylinder", exact: true, start: [0, 0, 0], stop: [0, 0, 3], radius: 2 }, [0.5, 0.5, 9], [0, 0, -1]);
assert.equal(cap.value, 3);
assert.deepEqual(cap.centre.map((x) => Math.round(x * 1e3) / 1e3), [0, 0, 3]);
assert.equal(face({ kind: "cylinder", exact: true, start: [0, 0, 0], stop: [0, 0, 3], radius: 2 }, [9, 0.3, 1.5], [-1, 0, 0]), "curved");
assert.equal(face({ kind: "sphere", exact: true, center: [0, 0, 0], radius: 2 }, [9, 0, 0], [-1, 0, 0]), "curved");

// The geometry carries the exact wrapper matrix, while the local primitive metadata stays local.
// A quarter-turned box cap remains alignable and derives its world centre from hit geometry.
const ry90 = [[0, 0, 1, 0], [0, 1, 0, 0], [-1, 0, 0, 0], [0, 0, 0, 1]];
const wrap = (primitive, matrix) => ({
  kind: "transformed", primitive: { priority: 0, bbox: [[0, 0, 0], [1, 1, 1]], exact: true, ...primitive },
  matrix, priority: 0, bbox: [[-10, -10, -10], [10, 10, 10]], exact: true,
});
const turnedBox = face(wrap({ kind: "box", start: [0, 0, 0], stop: [2, 4, 6] }, ry90), [20, 2, -1], [-1, 0, 0]);
assert.equal(turnedBox.axis, 0);
assert.equal(turnedBox.value, 6);
assert.deepEqual(turnedBox.centre, [6, 2, -1]);

// A general rotation makes the same box face unsupported instead of assigning it a false WCS plane.
const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
const ry30 = [[c30, 0, s30, 0], [0, 1, 0, 0], [-s30, 0, c30, 0], [0, 0, 0, 1]];
const tiltedCenter = [c30 + 6 * s30, 2, -s30 + 6 * c30];
const tiltedNormal = [s30, 0, c30];
assert.equal(face(wrap({ kind: "box", start: [0, 0, 0], stop: [2, 4, 6] }, ry30),
  tiltedCenter.map((x, k) => x + tiltedNormal[k] * 10), tiltedNormal.map((x) => -x)), "slanted");

// Cylinder cap/side classification follows the transformed source axis, not its local axis number.
const turnedCylinder = wrap({ kind: "cylinder", start: [0, 0, 0], stop: [0, 0, 3], radius: 2 }, ry90);
const turnedCap = face(turnedCylinder, [9, 0, 0], [-1, 0, 0]);
assert.equal(turnedCap.axis, 0);
assert.equal(turnedCap.value, 3);
assert.deepEqual(turnedCap.centre.map((x) => Math.round(x * 1e3) / 1e3), [3, 0, 0]);
assert.equal(face(turnedCylinder, [1, 0, 9], [0, 0, -1]), "curved");
const turnedRotpoly = wrap({ kind: "rotpoly", axis: 2, origin: [0, 0, 0], points: [[0, 0], [2, 0], [2, 3], [0, 3]] }, ry90);
assert.equal(face(turnedRotpoly, [9, 0, 0], [-1, 0, 0]).axis, 0);
assert.equal(face(turnedRotpoly, [1, 0, 9], [0, 0, -1]), "curved");
const [invalidMetaHit, invalidMetaRay] = hit({ kind: "box", exact: true, start: [0, 0, 0], stop: [2, 4, 6] }, [1, 1, 20], [0, 0, -1]);
invalidMetaHit.object.userData.primitive = wrap({ kind: "box", start: [0, 0, 0], stop: [2, 4, 6] },
  [[0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]);
assert.equal(resolveFaceCandidate(invalidMetaHit, invalidMetaRay), "slanted");

// world bounds of a box after the part's transforms
const bounds = (start, stop, transforms) => {
  const m = maps(transforms, {})[0], a = pt(m, start), b = pt(m, stop);
  return [a.map((x, k) => Math.round(Math.min(x, b[k]) * 1e9) / 1e9), a.map((x, k) => Math.round(Math.max(x, b[k]) * 1e9) / 1e9)];
};
const src = { part: "A", axis: 2, sign: 1, value: 2, centre: [1, 1, 2], tris: [] }; // top of [0,0,0]-[2,2,2]
const wall = { part: "B", axis: 0, sign: -1, value: 10, centre: [10, 5, 5], tris: [] }; // -x face of a wall at x = 10

// against, centred: turn +z to +x (+90 about y about the face centre), then move onto the wall
let t = faceAlignTransforms(src, wall, "against", true);
assert.deepEqual(t[0], { type: "rotate", axis: "y", center: [1, 1, 2], angle: 90, copies: 0 });
assert.deepEqual(bounds([0, 0, 0], [2, 2, 2], t), [[8, 4, 4], [10, 6, 6]]);

// flush, not centred: the face points -x like the wall's and lies in x = 10
t = faceAlignTransforms(src, wall, "flush", false);
assert.equal(t[0].angle, -90);
assert.deepEqual(bounds([0, 0, 0], [2, 2, 2], t), [[10, 0, 1], [12, 2, 3]]); // turned about the face centre, not re-centred

// parallel faces: no turn, only the move; opposite facing for "flush" is a half turn
const floorTop = { part: "S", axis: 2, sign: 1, value: 1.6, centre: [0, 0, 1.6], tris: [] };
const bottom = { part: "A", axis: 2, sign: -1, value: 5, centre: [1, 1, 5], tris: [] }; // bottom of [0,0,5]-[2,2,7]
t = faceAlignTransforms(bottom, floorTop, "against", false);
assert.deepEqual(t, [{ type: "move", offset: [0, 0, -3.4] }]);
assert.deepEqual(bounds([0, 0, 5], [2, 2, 7], t), [[0, 0, 1.6], [2, 2, 3.6]]);
t = faceAlignTransforms(bottom, floorTop, "flush", false);
assert.equal(Math.abs(t[0].angle), 180);
assert.deepEqual(bounds([0, 0, 5], [2, 2, 7], t), [[0, 0, -0.4], [2, 2, 1.6]]);
// already aligned: nothing to do
assert.deepEqual(faceAlignTransforms({ ...bottom, value: 1.6, centre: [1, 1, 1.6] }, floorTop, "against", false), []);
console.log("Face alignment: face candidates, quarter turns, against/flush and centring passed");
