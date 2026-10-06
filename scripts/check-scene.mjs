// Focused synthetic checks for the 3D far-field mesh.
// Run: node --experimental-strip-types scripts/check-scene.mjs
import assert from "node:assert/strict";
import * as THREE from "three";
import { patternMesh } from "../src/scene/pattern.ts";

const theta = [0, 45, 90, 135];
const phi = [0, 90, 180, 270];
const values = theta.map(() => phi.map(() => 10));
values[1][1] = -5; // half radius
values[2][2] = NaN; // missing samples collapse to the centre
const ff = { theta, phi, directivity_dbi: values, dmax_dbi: 10 };
const center = new THREE.Vector3(2, -3, 4);
const stops = [new THREE.Color(0, 0, 0), new THREE.Color(1, 1, 1)];

function checkPattern(halfSpace, rows) {
  const group = patternMesh(ff, center, 8, stops, halfSpace);
  const surface = group.children[0].geometry;
  const wire = group.children[1].geometry;
  const pos = surface.getAttribute("position").array;
  const colors = surface.getAttribute("color").array;
  const indices = surface.getIndex().array;
  const lines = wire.getAttribute("position").array;
  assert.equal(pos.length, rows * (phi.length + 1) * 3);
  assert.equal(colors.length, pos.length);
  assert.equal(indices.length, (rows - 1) * phi.length * 6);
  assert.ok(indices instanceof Uint16Array);
  assert.equal(lines.length, (rows * phi.length + phi.length * (rows - 1)) * 6);
  assert.ok(lines instanceof Float32Array);
  assert.deepEqual([...indices.slice(0, 6)], [0, 5, 1, 1, 5, 6]);

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j <= phi.length; j++) {
      const sample = values[i][j % phi.length];
      const t = Number.isFinite(sample) ? Math.max(0, (sample - (10 - 30)) / 30) : 0;
      const th = THREE.MathUtils.degToRad(theta[i]);
      const ph = THREE.MathUtils.degToRad(phi[j % phi.length]);
      const r = 8 * t;
      const k = (i * (phi.length + 1) + j) * 3;
      const expected = [center.x + r * Math.sin(th) * Math.cos(ph), center.y + r * Math.sin(th) * Math.sin(ph), center.z + r * Math.cos(th)].map(Math.fround);
      assert.deepEqual([...pos.slice(k, k + 3)], expected, `sample ${i},${j}`);
      assert.deepEqual([...colors.slice(k, k + 3)], [t, t, t].map(Math.fround), `colour ${i},${j}`);
      assert.ok(expected.every(Number.isFinite));
    }
    const first = i * (phi.length + 1) * 3;
    assert.deepEqual([...pos.slice(first, first + 3)], [...pos.slice(first + phi.length * 3, first + (phi.length + 1) * 3)], `seam row ${i}`);
  }
  assert.deepEqual([...pos.slice((2 * (phi.length + 1) + 2) * 3, (2 * (phi.length + 1) + 2) * 3 + 3)], [...center.toArray()]);
  assert.deepEqual([...lines.slice(0, 6)], [...pos.slice(0, 6)], "first iso-line follows the first surface edge");
  assert.ok([...pos, ...colors, ...lines].every(Number.isFinite));
  return { vertices: pos.length / 3, triangles: indices.length / 3, isoSegments: lines.length / 6 };
}

const half = checkPattern(true, 3);
const full = checkPattern(false, 4);

// Empty angle axes cannot make a surface. A single axis sample still has its original iso-line.
for (const sparse of [
  { theta: [], phi: [0, 90], directivity_dbi: [] },
  { theta: [0, 90], phi: [], directivity_dbi: [[], []] },
  { theta: [135], phi: [0, 90], directivity_dbi: [[10, 10]], halfSpace: true },
]) {
  assert.equal(patternMesh({ ...sparse, dmax_dbi: 10 }, center, 8, stops, sparse.halfSpace ?? false).children.length, 0);
}
for (const [grid, expectedLines] of [
  [{ theta: [45], phi: [0, 90], directivity_dbi: [[10, 10]] }, 2],
  [{ theta: [0, 90], phi: [0], directivity_dbi: [[10], [10]] }, 3],
  [{ theta: [45, 45], phi: [0, 90], directivity_dbi: [[10, 10], [10, 10]] }, 4],
  [{ theta: [0, 90], phi: [0, 0], directivity_dbi: [[10, 10], [10, 10]] }, 5],
]) {
  const group = patternMesh({ ...grid, dmax_dbi: 10 }, center, 8, stops, false);
  const surface = group.children[0].geometry;
  assert.equal(surface.getAttribute("position").count, grid.theta.length * (grid.phi.length + 1));
  assert.equal(group.children[1].geometry.getAttribute("position").count, expectedLines * 2);
  assert.ok([...surface.getAttribute("position").array].every(Number.isFinite));
}

// Index 65535 is reserved in WebGL's 16-bit element array, so exactly 65536 vertices need Uint32.
const largeTheta = Array.from({ length: 256 }, (_, i) => i * 180 / 255);
const largePhi = Array.from({ length: 255 }, (_, i) => i * 360 / 255);
const large = patternMesh({ theta: largeTheta, phi: largePhi, dmax_dbi: 10, directivity_dbi: largeTheta.map(() => largePhi.map(() => 10)) }, center, 8, stops, false);
const largeIndex = large.children[0].geometry.getIndex().array;
assert.ok(largeIndex instanceof Uint32Array);
assert.equal(largeIndex.length, 255 * 255 * 6);
assert.equal(Math.max(...largeIndex.slice(-6)), 65535);

console.log(`scene pattern: half ${half.vertices} vertices/${half.triangles} triangles/${half.isoSegments} iso-segments; full ${full.vertices}/${full.triangles}/${full.isoSegments}; large ${largeIndex.length} Uint32 indices; OK`);
