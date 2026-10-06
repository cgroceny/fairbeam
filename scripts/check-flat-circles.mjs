// Flat circles and cuts beyond rectangles in the designer's instant preview (src/designer/geometry.ts):
// a zero-length cylinder is a polygon sheet, a ring two half rings, round and polygon cuts clip sheets,
// polygons and flat circles in 2D. The same cases are compared with design.py in check-designer.mjs
// (python/tests/fixtures/designer_parity.json); this one checks the numbers and the guards.
//
//   node --experimental-strip-types scripts/check-flat-circles.mjs
import assert from 'node:assert/strict';
import { discHalves, discRing, discSegments, quickBundle, resolveCuts, worldBoxes } from '../src/designer/geometry.ts';
import { designChecks } from '../src/designer/checks.ts';

const area = (r) => Math.abs(r.reduce((s, a, k) => { const b = r[(k + 1) % r.length]; return s + a[0] * b[1] - a[1] * b[0]; }, 0)) / 2;
const design = (...parts) => ({
  schema: 'fairbeam.design/1', model: { id: 't', name: 'T' }, params: [],
  simulation: { f_min: 1, f_max: 3, boundaries: 'MUR' },
  materials: [{ name: 'copper', kind: 'metal' }], parts, ports: [], resistors: [], mesh: { mode: 'auto' },
});
const build = (...parts) => quickBundle(design(...parts), {}, null);
const sheet = (name, prims, extra = {}) => ({ name, material: 'copper', primitives: prims, ...extra });
const disc = (r, ri = 0, c = [0, 0], at = 1) => ({ kind: 'cylinder', axis: 'z', center: c, radius: r, inner_radius: ri, range: [at, at] });
const polyArea = (n, r) => 0.5 * n * r * r * Math.sin(2 * Math.PI / n);
const sum = (b) => b.parts[0].primitives.reduce((s, p) => s + area(p.points), 0);

// the sag rule
assert.equal(discSegments(0.5), 64); assert.equal(discSegments(1e-6), 64);
for (const r of [0.5, 3, 10, 40, 150]) {
  const n = discSegments(r);
  assert.equal(n % 2, 0); assert.ok(n >= 64 && n <= 512);
  assert.ok(r * (1 - Math.cos(Math.PI / n)) <= 0.01 * (1 + 1e-9), `sag at ${r}`);
}
assert.ok(discSegments(100) > discSegments(10));
assert.equal(discRing(0, 0, 5).length, discSegments(5));
const halves = discHalves(0, 0, 8, 5);
assert.equal(halves.length, 2);
assert.equal(halves[0].length, discSegments(8) + 2);

// a flat circle, a ring and a real cylinder
let b = build(sheet('d', [disc(10, 0, [3, -2]), disc(8, 5, [30, 0]), { kind: 'cylinder', axis: 'z', center: [0, 0], radius: 1, range: [0, 0.5] }]));
const prims = b.parts[0].primitives;
assert.deepEqual(prims.map((p) => p.kind), ['polygon', 'polygon', 'polygon', 'cylinder']);
const n10 = discSegments(10), n8 = discSegments(8);
assert.equal(prims[0].points.length, n10);
assert.ok(Math.abs(area(prims[0].points) - polyArea(n10, 10)) < 1e-6);
assert.ok(Math.abs(area(prims[1].points) + area(prims[2].points) - (polyArea(n8, 8) - polyArea(n8, 5))) < 1e-6);
for (const p of prims.slice(0, 3)) assert.ok(p.exact && p.normal === 2 && p.elevation === 1);
for (const [u, v] of prims[0].points) assert.ok(Math.abs(Math.hypot(u - 3, v + 2) - 10) < 1e-9);

// a circle in another plane: x-axis cylinder centres are (y, z)
b = build(sheet('w', [{ kind: 'cylinder', axis: 'x', center: [1, 2], radius: 3, range: [5, 5] }]));
assert.deepEqual([b.parts[0].primitives[0].kind, b.parts[0].primitives[0].normal, b.parts[0].primitives[0].elevation], ['polygon', 0, 5]);

// round hole in a rectangular sheet; rectangles alone keep exact boxes
b = build(sheet('p', [{ kind: 'box', start: [-10, -8, 1], stop: [10, 8, 1] }], { cuts: [{ kind: 'circle', normal: 'z', elevation: 1, center: [2, 1], radius: 3 }] }));
assert.ok(b.parts[0].primitives.every((p) => p.kind === 'polygon'));
assert.ok(Math.abs(sum(b) - (320 - polyArea(discSegments(3), 3))) < 1e-6);
b = build(sheet('p', [{ kind: 'box', start: [-10, -5, 1], stop: [10, 5, 1] }], { cuts: [{ start: [-1, -3, 1], stop: [1, 3, 1] }] }));
assert.equal(b.parts[0].primitives.length, 4); assert.ok(b.parts[0].primitives.every((p) => p.kind === 'box'));

// a polygon sheet with a rectangle cut and a polygon cut; a miss keeps the polygon as drawn
b = build(sheet('t', [{ kind: 'polygon', normal: 'z', elevation: 1, points: [[19, 19], [31, 19], [31, 31], [19, 31]] }],
  { cuts: [{ start: [20, 20, 1], stop: [22, 22, 1] }, { kind: 'polygon', normal: 'z', elevation: 1, points: [[25, 25], [28, 25], [28, 28]] }] }));
assert.ok(Math.abs(sum(b) - (144 - 4 - 4.5)) < 1e-9, `area ${sum(b)}`);
const pts = [[19, 19], [31, 19], [19, 31]];
b = build(sheet('t', [{ kind: 'polygon', normal: 'z', elevation: 1, points: pts }], { cuts: [{ start: [0, 0, 1], stop: [1, 1, 1] }] }));
assert.deepEqual(b.parts[0].primitives.map((p) => p.points), [pts]);

// a hole in a flat circle; a cut in another plane changes nothing; a cut that removes everything leaves none
b = build(sheet('pad', [disc(10)], { cuts: [{ kind: 'circle', normal: 'z', elevation: 1, center: [0, 0], radius: 3 }] }));
assert.ok(Math.abs(sum(b) - (polyArea(discSegments(10), 10) - polyArea(discSegments(3), 3))) < 1e-6);
b = build(sheet('p', [{ kind: 'box', start: [-10, -8, 1], stop: [10, 8, 1] }], { cuts: [{ kind: 'circle', normal: 'x', elevation: 0, center: [0, 1], radius: 1 }] }));
assert.equal(b.parts[0].primitives.length, 1);
b = build(sheet('p', [disc(5)], { cuts: [{ kind: 'circle', normal: 'z', elevation: 1, center: [0, 0], radius: 9 }] }), sheet('q', [{ kind: 'box', start: [0, 0, 0], stop: [1, 1, 1] }]));
assert.equal(b.parts[0].primitives.length, 0);

// transforms carry the pieces
b = build(sheet('d', [disc(4, 0, [2, 0])], { transforms: [{ type: 'mirror', plane: 'x', keep: true }, { type: 'translate', copies: 1, step: [0, 20, 0] }] }));
assert.equal(b.parts[0].primitives.length, 4); assert.ok(b.parts[0].primitives.every((p) => p.kind === 'polygon'));

// resolveCuts guards
assert.throws(() => resolveCuts([{ start: [0, 0, 0], stop: [1, 1, 1] }], {}), /not a sheet/);
assert.throws(() => resolveCuts([{ kind: 'circle', center: [0, 0], radius: -1 }], {}), /radius/);
assert.throws(() => resolveCuts([{ kind: 'polygon', points: [[0, 0], [1, 1]] }], {}), /3 points/);
// a Boolean of bricks cannot take pieces that are polygons: a clear message from the box route
assert.throws(() => worldBoxes(sheet('p', [{ kind: 'box', start: [0, 0, 1], stop: [4, 4, 1] }], { cuts: [{ kind: 'circle', normal: 'z', elevation: 1, center: [2, 2], radius: 1 }] }), {}), /round or polygon cut/);

// checks: a flat circle is fine, an inverted range and bad cuts are errors
const codes = (part) => designChecks(design(part)).map((c) => `${c.severity}|${c.code}|${c.path}`);
assert.ok(!codes(sheet('d', [disc(3)])).some((c) => c.includes('cylinder-length')));
assert.ok(codes(sheet('d', [{ ...disc(3), range: [1, 0] }])).includes('error|cylinder-length|parts[0].primitives[0].range[1]'));
const bad = codes(sheet('p', [{ kind: 'box', start: [0, 0, 0], stop: [1, 1, 0] }], { cuts: [
  { kind: 'circle', normal: 'z', elevation: 0, center: [0, 0], radius: 0 },
  { kind: 'polygon', normal: 'z', elevation: 0, points: [[0, 0], [1, 1]] },
  { kind: 'polygon', normal: 'z', elevation: 0, points: [[0, 0], [2, 2], [4, 4]] },
  { start: [0, 0, 0], stop: [1, 1, 1] }] }));
for (const want of ['error|radius|parts[0].cuts[0].radius', 'error|polygon-points|parts[0].cuts[1].points', 'error|polygon-area|parts[0].cuts[2].points', 'error|cut-sheet|parts[0].cuts[3].stop']) assert.ok(bad.includes(want), `${want} in ${bad.join(', ')}`);
console.log('Flat circles and cuts: sag rule, polygon sheets and rings, round/polygon/rectangle cuts, transforms and guards passed.');
