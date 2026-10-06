import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { booleanOverlap, booleanResult, materialiseBoolean, livePrimitives } from '../src/designer/booleanParts.ts';
import { computed } from './boolean-parity-cases.mjs';
import { clipPolygons, ringArea } from '../src/designer/polygonClip.ts';

const part = (name, start, stop, material = 'Cu') => ({ name, material, primitives: [{ kind: 'box', start, stop }] });
const design = (...parts) => ({ parts });
const A = part('A', [0, 0, 0], [2, 2, 2]);
const B = part('B', [1, 1, 1], [3, 3, 3]);
const d = design(A, B);
assert.equal(booleanOverlap(A, B, {}), true);
const added = booleanResult(d, {}, 0, 1, 'add');
assert.ok(added.parts);
const union = added.parts[0].primitives;
// the volume of bricks and extruded polygons (cut-outs, the vacuum a brick keeps, are not counted)
const volume = ps => ps.reduce((sum, p) => sum + (p.void ? 0 : p.kind === 'linpoly' ? ringArea(p.points) * p.length : p.start.reduce((v, x, i) => v * (p.stop[i] - x), 1)), 0);
assert.equal(volume(union), 15);
assert.equal(new Set(union.map(p => JSON.stringify([p.start, p.stop]))).size, union.length);
const sub = booleanResult(d, {}, 0, 1, 'subtract');
assert.equal(volume(sub.parts[0].primitives), 7);
const inter = booleanResult(d, {}, 0, 1, 'intersect');
assert.equal(volume(inter.parts[0].primitives), 1);
assert.deepEqual(A.primitives[0].start, [0, 0, 0]);
assert.equal(added.parts[0].booleanHistory.B.booleanHistory, undefined);
const exprA = part('S1', [0, 0, 0], ['W', 2, 0]);
const exprB = part('S2', ['W/2', 0, 0], [3, 1, 0]);
const sheet = booleanResult(design(exprA, exprB), { W: 2 }, 0, 1, 'add');
assert.ok(sheet.parts);
assert.equal(booleanOverlap(exprA, exprB, { W: 2 }), true);
assert.equal(sheet.parts[0].primitives.reduce((s, p) => s + (p.stop[0] - p.start[0]) * (p.stop[1] - p.start[1]), 0), 5);
const inserted = booleanResult(d, {}, 0, 1, 'insert');
assert.equal(inserted.parts.length, 2);
assert.equal(volume(inserted.parts[0].primitives), 7);
assert.equal(volume(inserted.parts[1].primitives), 8);
assert.deepEqual(inserted.parts[0].booleanHistory.A, A);
assert.deepEqual(inserted.parts[0].booleanHistory.B, B);
assert.equal(booleanResult(design(A, part('C', [0, 0, 0], [1, 1, 1], 'Al')), {}, 0, 1, 'add').error.includes('same material'), true);
// transformed operands: exact boxes in world coordinates; the result drops the transforms
const moved = booleanResult(design({ ...A, transforms: [{ type: 'move', offset: [1, 0, 0] }] }, B), {}, 0, 1, 'add');
assert.equal(volume(moved.parts[0].primitives), 8 + 8 - 2);
assert.equal(moved.parts[0].transforms, undefined);
assert.deepEqual(moved.parts[0].booleanHistory.A.transforms, [{ type: 'move', offset: [1, 0, 0] }]);
assert.equal(moved.parts[0].booleanHistory.live, true);
const copies = booleanResult(design({ ...A, transforms: [{ type: 'translate', copies: 1, step: [4, 0, 0] }] }, part('W', [0, 0, 0], [8, 1, 1])), {}, 0, 1, 'subtract');
assert.equal(volume(copies.parts[0].primitives), 16 - 4);
assert.equal(booleanOverlap({ ...A, transforms: [{ type: 'rotate', axis: 'z', center: [0, 0, 0], angle: 90 }] }, part('N', [-1, 0, 0], [0, 1, 1]), {}), true);
// curved shapes are supported now (check-boolean-curved.mjs): a sphere is added whole
assert.deepEqual(booleanResult(design(A, { ...B, primitives: [{ kind: 'sphere', center: [0, 0, 0], radius: 1 }] }), {}, 0, 1, 'add').parts[0].primitives.map((p) => p.kind), ['box', 'sphere']);
console.log('boolean geometry checks passed');
const mixedSheets = { ...exprA, primitives: [...exprA.primitives, { kind: 'box', start: [0, 0, 0], stop: [0, 2, 2] }] };
assert.match(booleanResult(design(mixedSheets, exprB), { W: 2 }, 0, 1, 'add').error, /coplanar/);
const prioritized = { ...A, primitives: [{ ...A.primitives[0], priority: 7 }] };
assert.equal(booleanResult(design(prioritized, B), {}, 0, 1, 'subtract').parts[0].primitives[0].priority, 7);
assert.match(booleanResult(design(prioritized, B), {}, 0, 1, 'add').error, /priority/);


// live results: recomputed from the operands at other values, nested results included
const fixture = JSON.parse(readFileSync(new URL('../python/tests/fixtures/boolean_parity.json', import.meta.url), 'utf8'));
assert.deepEqual(JSON.parse(JSON.stringify(computed)), fixture, 'boolean_parity.json is stale: node --experimental-strip-types scripts/boolean-parity-cases.mjs --write');
const [first] = fixture;
assert.notDeepEqual(first.expected[0], first.expected[1]);
const nested = fixture[3].history.A;
assert.deepEqual(livePrimitives(nested, { W: 5, H: 1.5 }), materialiseBoolean(nested.booleanHistory, { W: 5, H: 1.5 }));
assert.deepEqual(livePrimitives({ ...nested, booleanHistory: { ...nested.booleanHistory, live: false } }, { W: 5, H: 1.5 }), nested.primitives);
console.log('boolean transformed operands, parity fixture and live recomputation passed');

// ---- brick − brick (the desktop report): A less exactly the common volume, B removed, exact boxes
{
  const a = part('A', [0, 0, 0], [10, 10, 4]), b = part('B', [5, 5, -2], [15, 15, 6]);
  const res = booleanResult(design(a, b), {}, 0, 1, 'subtract');
  assert.equal(res.parts.length, 1, 'Subtract removes B');
  const prims = res.parts[0].primitives;
  assert.deepEqual(prims.map((p) => p.kind), ['linpoly'], 'brick − brick through the height is one extruded polygon (an L), not a pile of bricks');
  assert.equal(volume(prims), 400 - 5 * 5 * 4, 'A − B = A less the common volume');
  assert.equal(booleanOverlap(res.parts[0], b, {}), false, 'nothing of B is left in the result');
  assert.equal(volume(booleanResult(design(a, b), {}, 1, 0, 'subtract').parts[0].primitives), 800 - 100, 'B − A');
}

// ---- polygons: extruded along one axis and flat, mixed with bricks (slabs clipped exactly in 2D)
const lin = (name, points, elevation, length, normal = 'z', extra = {}) => ({ name, material: 'Cu', primitives: [{ kind: 'linpoly', normal, elevation, length, points }], ...extra });
const area = (rings) => rings.reduce((s, r) => s + ringArea(r), 0);
const polyVolume = (ps) => ps.reduce((s, p) => s + (p.kind === 'linpoly' ? ringArea(p.points) * p.length : p.kind === 'box' ? p.start.reduce((v, x, i) => v * (p.stop[i] - x), 1) : 0), 0);
const near = (x, y, what) => assert.ok(Math.abs(x - y) < 1e-9, `${what}: ${x} vs ${y}`);
const simpleCcw = (r) => {
  assert.ok(ringArea(r) > 0, 'counter-clockwise');
  for (let i = 0; i < r.length; i++) for (let j = i + 2; j < r.length; j++) {
    if (i === 0 && j === r.length - 1) continue;
    const [p, q, s, t] = [r[i], r[(i + 1) % r.length], r[j], r[(j + 1) % r.length]];
    const o = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    assert.ok(!(o(p, q, s) * o(p, q, t) < 0 && o(s, t, p) * o(s, t, q) < 0), 'a simple polygon (no crossing edges)');
  }
};
{
  // the 2D clipper: exact areas, hole-free simple polygons
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const holed = clipPolygons([sq(0, 0, 10, 10)], [sq(3, 3, 6, 6)], 'subtract');
  assert.ok(holed.length >= 2, 'a hole splits its surround into simple polygons');
  near(area(holed), 91, 'square minus an inner square');
  holed.forEach(simpleCcw);
  const notch = clipPolygons([[[0, 0], [10, 0], [5, 8]]], [sq(4, -1, 6, 2)], 'subtract');
  assert.equal(notch.length, 1, 'a notch keeps one polygon');
  near(area(notch), 40 - 4, 'triangle minus a notch');
  assert.deepEqual(clipPolygons([sq(0, 0, 1, 1)], [sq(1, 0, 2, 1)], 'union'), [sq(0, 0, 2, 1)], 'edge-sharing squares unite into one rectangle');
  assert.deepEqual(clipPolygons([sq(0, 0, 1, 1)], [sq(0, 0, 1, 1)], 'subtract'), [], 'a shape minus itself is empty');
  // identities on random star polygons (a deterministic generator)
  let seed = 5; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const star = () => { const c = [rnd() * 4, rnd() * 4], n = 3 + Math.floor(rnd() * 8); return Array.from({ length: n }, (_, i) => { const t = 2 * Math.PI * i / n, r = 1 + 3 * rnd(); return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]; }); };
  for (let k = 0; k < 150; k++) {
    const A = [star()], B = rnd() < 0.3 ? [star(), star()] : [star()];
    const aA = area(clipPolygons(A, [], 'union')), aB = area(clipPolygons(B, [], 'union')), aI = area(clipPolygons(A, B, 'intersect'));
    near(area(clipPolygons(A, B, 'union')), aA + aB - aI, `union area identity ${k}`);
    const S = clipPolygons(A, B, 'subtract');
    near(area(S), aA - aI, `subtract area identity ${k}`);
    S.forEach(simpleCcw);
  }
}
{
  // polygon − brick: extruded polygons, cut into slabs where the brick's faces lie
  const p = lin('P', [[0, 0], [10, 0], [10, 10], [0, 10]], 0, 4);
  const through = booleanResult(design(p, part('B', [5, 5, -2], [15, 15, 6])), {}, 0, 1, 'subtract');
  assert.equal(through.parts.length, 1);
  assert.ok(through.parts[0].primitives.every((q) => q.kind === 'linpoly' && q.normal === 'z'), 'the result is extruded polygons');
  near(polyVolume(through.parts[0].primitives), 300, 'polygon − brick through it');
  const partway = booleanResult(design(p, part('B', [5, 5, 1], [15, 15, 3])), {}, 0, 1, 'subtract').parts[0].primitives;
  // partway up it is a pocket: the polygon whole and the brick as a cut-out (2 shapes, fewer than 3 slabs)
  assert.deepEqual(partway.map((q) => q.kind + (q.void ? ' (cut-out)' : '')), ['linpoly', 'box (cut-out)']);
  near(polyVolume(partway.filter((q) => !q.void)), 400, 'the polygon stays whole');
  assert.deepEqual([...partway[1].start, ...partway[1].stop], [5, 5, 1, 10, 10, 3], 'the cut-out is trimmed to the polygon');
  const inter = booleanResult(design(p, { ...part('B', [5, 5, 1], [15, 15, 3]), material: 'Cu' }), {}, 0, 1, 'intersect').parts[0].primitives;
  near(polyVolume(inter), 50, 'polygon ∩ brick');
  const united = booleanResult(design(p, { ...part('B', [5, 5, 1], [15, 15, 3]), material: 'Cu' }), {}, 0, 1, 'add').parts[0].primitives;
  near(polyVolume(united), 400 + 200 - 50, 'polygon ∪ brick');
  // brick − polygon: the brick becomes extruded polygons too
  near(polyVolume(booleanResult(design(part('B', [5, 5, 1], [15, 15, 3]), p), {}, 0, 1, 'subtract').parts[0].primitives), 200 - 50, 'brick − polygon');
}
{
  // polygon − polygon, hole-producing: the surround as simple extruded polygons
  const outer = lin('P', [[0, 0], [10, 0], [10, 10], [0, 10]], 0, 2), hole = lin('Q', [[3, 3], [6, 3.5], [5, 7], [3.2, 6]], -1, 4);
  const res = booleanResult(design(outer, hole), {}, 0, 1, 'subtract').parts[0].primitives;
  assert.ok(res.length >= 2, 'the hole splits the surround');
  near(polyVolume(res), 2 * (100 - ringArea(hole.primitives[0].points)), 'polygon − polygon with a hole');
  res.forEach((q) => simpleCcw(q.points));
  // a live parameter moves the hole
  const live = booleanResult(design(outer, lin('Q', [['c', 'c'], [6, 3.5], [5, 7], [3.2, 6]], -1, 4)), { c: 3 }, 0, 1, 'subtract').parts[0];
  assert.equal(live.booleanHistory.live, true);
  near(polyVolume(livePrimitives(live, { c: 2 })), 2 * (100 - ringArea([[2, 2], [6, 3.5], [5, 7], [3.2, 6]])), 'recomputed at another value');
  // sheets: a polygon sheet minus a rectangular sheet in its plane gives flat polygons
  const sheet = { name: 'S', material: 'Cu', primitives: [{ kind: 'polygon', normal: 'z', elevation: 1, points: [[0, 0], [8, 0], [4, 7]] }] };
  const cut = booleanResult(design(sheet, part('R', [3, -1, 1], [5, 2, 1])), {}, 0, 1, 'subtract').parts[0].primitives;
  assert.ok(cut.every((q) => q.kind === 'polygon' && q.elevation === 1));
  near(area(cut.map((q) => q.points)), 28 - 2 * 2, 'polygon sheet − rectangle');
  assert.match(booleanResult(design(sheet, part('R', [3, -1, 2], [5, 2, 2])), {}, 0, 1, 'subtract').error, /same plane/);
  // a thick brick cuts the sheet with its cross-section at the sheet's plane
  near(area(booleanResult(design(sheet, part('V', [3, -1, 0], [5, 2, 2])), {}, 0, 1, 'subtract').parts[0].primitives.map((q) => q.points)), 28 - 2 * 2, 'polygon sheet − thick brick');
  assert.match(booleanResult(design(sheet, part('V', [3, -1, 0], [5, 2, 2])), {}, 0, 1, 'add').error, /^Add cannot combine a sheet with a volume/);
  // a cylinder is cut out of the polygon as a cut-out; polygons along different axes are refused with the reason
  const cyl = { name: 'C', material: 'Cu', primitives: [{ kind: 'cylinder', axis: 'z', center: [0, 0], radius: 1, range: [0, 1] }] };
  assert.deepEqual(booleanResult(design(outer, cyl), {}, 0, 1, 'subtract').parts[0].primitives.map((p) => p.kind), ['linpoly', 'cylinder']);
  assert.match(booleanResult(design(outer, lin('X', [[0, 0], [2, 0], [2, 2]], 0, 3, 'x')), {}, 0, 1, 'subtract').error, /one common extrusion axis/);
  assert.equal(booleanOverlap(outer, hole, {}), true);
  assert.equal(booleanOverlap(outer, lin('F', [[20, 0], [22, 0], [21, 2]], 0, 2), {}), false);
  // a quarter turn about z keeps the axis: a transformed polygon operand is exact
  const turned = lin('T', [[0, 0], [4, 0], [4, 4], [0, 4]], 0, 2, 'z', { transforms: [{ type: 'rotate', axis: 'z', center: [0, 0, 0], angle: 90 }] });
  near(polyVolume(booleanResult(design(outer, turned), {}, 0, 1, 'subtract').parts[0].primitives), 200, 'the turned square lies outside x ≥ 0');
}
console.log('boolean brick − brick, polygons (clipper identities, holes, slabs, sheets, refusals) passed');
await import("./check-boolean-compact.mjs");
await import("./check-boolean-curved.mjs");
await import("./check-point-geometry.mjs");
