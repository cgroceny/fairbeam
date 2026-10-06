import assert from "node:assert/strict";
import * as THREE from "three";
import { resolvePointCandidate } from "../src/designer/pointGeometry.ts";
import { primitiveGeometry } from "../src/scene/geometry.ts";

function hit(primitive, origin, direction) {
  const geometry = primitiveGeometry(primitive);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.userData.primitive = primitive;
  mesh.updateMatrixWorld();
  return new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction)).intersectObject(mesh)[0];
}
const box = hit({ kind: "box", exact: true, start: [0, 0, 0], stop: [10, 20, 30] }, [2, 3, 40], [0, 0, -1]);
assert.deepEqual(resolvePointCandidate(box, "face", "A").point, [5, 10, 30]);
assert.equal(resolvePointCandidate(box, "face", "A").kind, "face centre");
assert.equal(resolvePointCandidate(box, "align-source", "A").kind, "vertex");
const cylinder = hit({ kind: "cylinder", exact: true, start: [0, 0, 0], stop: [0, 0, 10], radius: 4 }, [1, 1, 20], [0, 0, -1]);
assert.deepEqual(resolvePointCandidate(cylinder, "face", "B").point, [0, 0, 10]);
assert.equal(resolvePointCandidate(cylinder, "face", "B").kind, "circle centre");
box.object.userData.primitive.exact = false;
assert.equal(resolvePointCandidate(box, "face", "C").kind, "triangle centre");
console.log("Point candidates: box face, cylinder cap, alignment vertex and honest fallback passed");
await import("./check-vertex-model.mjs");
await import("./check-face-align.mjs");
