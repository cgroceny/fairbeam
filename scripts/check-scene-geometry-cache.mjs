// Focused regression for the viewport's resolved-primitive geometry cache.
import assert from "node:assert/strict";
import * as THREE from "three";
import { SceneGeometryCache, primitiveGeometry } from "../src/scene/geometry.ts";

const shape = {
  kind: "linpoly", normal: 2, elevation: 1.25, length: 2.5,
  points: [[0, 0], [4, 0], [3, 2], [0, 3]],
  priority: 1, bbox: [[0, 0, 1.25], [4, 3, 3.75]], exact: true,
};
const polygon = { ...shape, kind: "polygon", length: undefined };

const disposed = new Map();
const watched = new WeakSet();
function watch(result) {
  assert.ok(result, "non-degenerate primitive has cached geometry");
  assert.ok(result.geometry?.isBufferGeometry, "cache result exposes mesh geometry");
  assert.ok(result.edges?.isBufferGeometry, "cache result exposes edge geometry");
  for (const geometry of [result.geometry, result.edges]) {
    if (!watched.has(geometry)) {
      watched.add(geometry);
      disposed.set(geometry, 0);
      geometry.addEventListener("dispose", () => disposed.set(geometry, disposed.get(geometry) + 1));
    }
  }
  return result;
}
const cache = new SceneGeometryCache();
function build(prim) {
  cache.beginRebuild();
  const result = cache.get(prim);
  cache.endRebuild();
  return result && watch(result);
}
function assertDifferent(a, b, label) {
  assert.ok(a && b, `${label}: both results exist`);
  assert.notEqual(a.geometry, b.geometry, `${label}: mesh geometry invalidated`);
  assert.notEqual(a.edges, b.edges, `${label}: edge geometry invalidated`);
}
function arrays(g) {
  return {
    position: Array.from(g.attributes.position.array),
    index: g.index ? Array.from(g.index.array) : null,
  };
}
function assertDrawParity(prim, result, label) {
  const fresh = primitiveGeometry(prim);
  assert.ok(fresh, `${label}: fresh geometry exists`);
  assert.deepEqual(arrays(result.geometry), arrays(fresh), `${label}: cached draw data matches fresh geometry`);
  const freshEdges = new THREE.EdgesGeometry(fresh, 25);
  assert.deepEqual(arrays(result.edges), arrays(freshEdges), `${label}: cached edges match fresh geometry`);
  fresh.dispose();
  freshEdges.dispose();
}

const initial = build(shape);
assertDrawParity(shape, initial, "initial linpoly");
const cloneHit = build(structuredClone(shape));
assert.equal(cloneHit.geometry, initial.geometry, "identical resolved primitive clone reuses mesh geometry");
assert.equal(cloneHit.edges, initial.edges, "identical resolved primitive clone reuses edge geometry");
cache.beginRebuild();
const copyA = cache.get(structuredClone(shape));
const copyB = cache.get(structuredClone(shape));
cache.endRebuild();
assert.equal(copyA.geometry, copyB.geometry, "same-bundle copies share triangulation");
assert.equal(copyA.edges, copyB.edges, "same-bundle copies share edge geometry");

const changes = [
  ["point edit", { ...shape, points: [[0, 0], [4.2, 0], [3, 2], [0, 3]] }],
  ["normal edit", { ...shape, normal: 1 }],
  ["elevation edit", { ...shape, elevation: 1.5 }],
  ["positive extrusion", { ...shape, length: 3 }],
  ["negative extrusion", { ...shape, length: -2.5 }],
  ["transformed resolved points", { ...shape, elevation: 4, points: [[1, 2], [5, 2], [4, 4], [1, 5]] }],
  ["polygon sheet", polygon],
];
let previous = initial;
for (const [label, prim] of changes) {
  const next = build(prim);
  assertDifferent(previous, next, label);
  assertDrawParity(prim, next, label);
  previous = next;
}

const mutable = structuredClone(shape);
const beforeMutation = build(mutable);
mutable.points[1][0] += 0.75;
const afterMutation = build(mutable);
assertDifferent(beforeMutation, afterMutation, "in-place point mutation");
assertDrawParity(mutable, afterMutation, "in-place point mutation");
mutable.points[1][0] -= 0.75;
const reverted = build(mutable);
assertDifferent(afterMutation, reverted, "exact return to prior content");
assertDrawParity(mutable, reverted, "exact return to prior content");

assert.equal(build({ kind: "wire", points: [[0, 0, 0]], priority: 1, bbox: [[0, 0, 0], [0, 0, 0]], exact: true }), null, "degenerate primitive returns null");

// Keep rebuilding unique resolved shapes. Every old cache entry must be evicted and disposed once.
for (let i = 0; i < 24; i++) {
  const prim = { ...shape, elevation: 10 + i, points: shape.points.map(([x, y]) => [x + i / 10, y]) };
  const result = build(prim);
  assertDrawParity(prim, result, `edit cycle ${i}`);
}
// the browser's quick bundle and the server bundle list a primitive's fields in a different order, and
// the server adds `sheet`: the same shape must reuse its geometry, a changed shape must not
{
  const quick = { kind: "box", start: [0, 0, 0], stop: [4, 3, 0.035], priority: 10, bbox: [[0, 0, 0], [4, 3, 0.035]], exact: true };
  const server = { priority: 10, bbox: [[0, 0, 0], [4, 3, 0.035]], kind: "box", exact: true, sheet: true, stop: [4, 3, 0.035], start: [0, 0, 0] };
  cache.beginRebuild();
  const a = cache.get(quick), b = cache.get(server);
  const c = cache.get({ ...server, stop: [4, 3.5, 0.035], bbox: [[0, 0, 0], [4, 3.5, 0.035]] });
  const d = cache.get({ ...quick, exact: false, priority: 1 });
  cache.endRebuild();
  watch(a); watch(c);
  assert.equal(a.geometry, b.geometry, "field order and the sheet flag do not miss the cache");
  assert.equal(a.geometry, d.geometry, "priority and exact do not change the geometry");
  assert.notEqual(a.geometry, c.geometry, "a changed extent builds new geometry");
}
for (const [geometry, count] of disposed) {
  assert.ok(count <= 1, "evicted cached geometry is disposed at most once");
}
const current = build(shape);
const liveBeforeDispose = [current.geometry, current.edges];
cache.dispose();
for (const geometry of liveBeforeDispose) assert.equal(disposed.get(geometry), 1, "dispose frees current cache geometry once");
for (const count of disposed.values()) assert.equal(count, 1, "all cached geometries disposed exactly once");

console.log("scene geometry cache: reuse, invalidation, draw parity, eviction, and disposal verified");
