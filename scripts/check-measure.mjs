// The Measure tool (src/designer/measure.ts, pointGeometry.ts): the distance and per-axis
// differences, the copied text, and snapping to a vertex, an edge midpoint or a face center of a
// known brick. No DOM.
//   node --experimental-strip-types scripts/check-measure.mjs
import assert from "node:assert/strict";
import * as THREE from "three";
import { bestSnap, copyText, measure } from "../src/designer/measure.ts";
import { resolvePointCandidate } from "../src/designer/pointGeometry.ts";
import { primitiveGeometry } from "../src/scene/geometry.ts";

// the math
const m = measure([1, 2, 3], [4, 6, 15]);
assert.deepEqual([m.dx, m.dy, m.dz], [3, 4, 12]);
assert.equal(m.distance, 13);
assert.equal(measure([5, 5, 5], [5, 5, 5]).distance, 0);
assert.equal(measure([0, 0, 0], [-3, 0, 0]).dx, -3);
// copied text: a decimal point, at most 4 decimals
assert.equal(copyText(2.5), "2.5");
assert.equal(copyText(Math.SQRT2), "1.4142");
assert.equal(copyText(13), "13");

// a known brick 4 x 6 x 8 mm from the origin: click near a corner, near an edge midpoint, near the face center
const brick = { kind: "box", exact: true, start: [0, 0, 0], stop: [4, 6, 8] };
function hit(origin, direction) {
  const mesh = new THREE.Mesh(primitiveGeometry(brick), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.userData = { primitive: brick, part: "p" };
  mesh.updateMatrixWorld();
  return new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction).normalize()).intersectObject(mesh)[0];
}
const snap = (origin, dir) => resolvePointCandidate(hit(origin, dir), "measure", "A");
const near = (a, b) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 1e-6), `${a} vs ${b}`);

const corner = snap([0.3, 0.3, 20], [0, 0, -1]); // top face, next to the corner (0, 0, 8)
assert.equal(corner.kind, "vertex");
near(corner.point, [0, 0, 8]);
const edge = snap([2.1, 0.3, 20], [0, 0, -1]); // next to the midpoint of the top edge y = 0
assert.equal(edge.kind, "edge midpoint");
near(edge.point, [2, 0, 8]);
const centre = snap([2.2, 3.1, 20], [0, 0, -1]); // the middle of the top face
assert.equal(centre.kind, "face centre");
near(centre.point, [2, 3, 8]);
// measuring from the corner to the face center of the top: the snapped points give the exact delta
const d = measure(corner.point, centre.point);
near([d.dx, d.dy, d.dz], [2, 3, 0]);
assert.ok(Math.abs(d.distance - Math.sqrt(13)) < 1e-9);

// bestSnap: the nearest weighted candidate, nulls ignored, nothing for no candidates
assert.equal(bestSnap([null, null], [0, 0, 0]), null);
assert.equal(bestSnap([{ point: [1, 0, 0], kind: "vertex" }, { point: [0.9, 0, 0], kind: "face centre" }], [0, 0, 0]).kind, "vertex");

console.log("check-measure: ok");
