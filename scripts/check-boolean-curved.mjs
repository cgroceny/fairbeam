// Booleans with curved shapes (src/designer/booleanParts.ts, booleanCurved.ts): Add and Insert for every
// shape kind, Subtract as cut-outs (void shapes) with the exact coaxial cases, Intersect where it is exact
// and the specific refusals. python/tests/test_boolean_curved.py and test_boolean_live.py check the Python
// build against the same cases (scripts/boolean-parity-cases.mjs).
import assert from 'node:assert/strict';
import { booleanOverlap, booleanPreview, booleanResult, livePrimitives, materialiseBoolean } from '../src/designer/booleanParts.ts';
import { ringArea } from '../src/designer/polygonClip.ts';
import { evaluate } from '../src/designer/expr.ts';

const near = (x, y, what, tol = 1e-9) => assert.ok(Math.abs(x - y) <= tol, `${what}: ${x} vs ${y}`);
const part = (name, primitives, extra = {}) => ({ name, material: 'Cu', primitives, ...extra });
const box = (start, stop, extra = {}) => ({ kind: 'box', start, stop, ...extra });
const cyl = (axis, center, radius, range, extra = {}) => ({ kind: 'cylinder', axis, center, radius, range, ...extra });
const design = (...parts) => ({ materials: [{ name: 'Cu', kind: 'metal' }, { name: 'FR4', kind: 'dielectric', eps_r: 4.3 }], parts });
const tetra = { kind: 'polyhedron', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], faces: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]] };
const KINDS = {
  cylinder: cyl('z', [5, 5], 1, [0, 3]),
  tube: { ...cyl('z', [5, 5], 1, [0, 3]), inner_radius: 0.5 },
  cone: { kind: 'cone', axis: 'z', center: [5, 5], bottom_radius: 1, top_radius: 0.4, range: [0, 3] },
  sphere: { kind: 'sphere', center: [5, 5, 2], radius: 1 },
  torus: { kind: 'torus', axis: 'z', center: [5, 5, 2], major_radius: 2, minor_radius: 0.5 },
  wire: { kind: 'wire', points: [[5, 5, 0], [5, 5, 3], [6, 5, 4]], radius: 0.2 },
  polyhedron: tetra,
};
const volumeBox = (p) => p.start.reduce((v, x, i) => v * Math.abs(p.stop[i] - x), 1);
const cellVolume = (p) => Math.PI * (p.radius ** 2 - (p.inner_radius ?? 0) ** 2) * Math.abs(p.range[1] - p.range[0]);
const base = () => part('A', [box([0, 0, 0], [10, 10, 4])]);

// ---------------------------------------------------------------- Add: every kind, every mix
for (const [name, shape] of Object.entries(KINDS)) {
  const r = booleanResult(design(base(), part('B', [shape])), {}, 0, 1, 'add');
  assert.ok(r.parts, `add with ${name}: ${r.error}`);
  const prims = r.parts[0].primitives;
  assert.equal(prims.length, 2, `add with ${name} keeps both shapes`);
  assert.equal(prims[0].kind, 'box');
  assert.equal(prims[1].kind, shape.kind, `${name} keeps its kind`);
  assert.equal(prims.some((p) => p.void), false);
  assert.equal(r.parts.length, 1, 'B is merged into A');
  assert.equal(r.parts[0].booleanHistory.live, true);
}
{
  // bricks and polygons are united, the curved shapes concatenated; the priority is shared
  const A = part('A', [box([0, 0, 0], [4, 4, 2], { priority: 7 }), cyl('z', [1, 1], 0.5, [2, 5], { priority: 7 })]);
  const B = part('B', [box([3, 0, 0], [8, 4, 2], { priority: 7 }), { ...KINDS.sphere, priority: 7 }]);
  const r = materialiseBoolean({ operation: 'add', A, B }, {});
  assert.equal(r.filter((p) => p.kind === 'box').length, 1, 'the two bricks unite into one');
  near(volumeBox(r.find((p) => p.kind === 'box')), 8 * 4 * 2, 'united volume');
  assert.deepEqual(r.map((p) => p.priority), [7, 7, 7], 'every shape keeps the shared priority');
  assert.deepEqual(r.map((p) => p.kind), ['box', 'cylinder', 'sphere']);
  assert.match(booleanResult(design(part('A', [box([0, 0, 0], [1, 1, 1])]), { ...part('B', [KINDS.sphere]), material: 'FR4' }), {}, 0, 1, 'add').error, /same material/);
  // transforms are baked in: a mirrored copy of the cylinder
  const mirrored = materialiseBoolean({ operation: 'add', A: part('A', [KINDS.cylinder], { transforms: [{ type: 'mirror', plane: 'x', keep: true }] }), B: part('B', [KINDS.torus]) }, {});
  assert.deepEqual(mirrored.map((p) => p.kind), ['cylinder', 'cylinder', 'torus']);
  assert.deepEqual(mirrored[1].center, [-5, 5]);
  near(mirrored[2].major_radius, 2, 'torus major radius survives'); near(mirrored[2].minor_radius, 0.5, 'torus minor radius survives');
}

// ---------------------------------------------------------------- Insert: A whole, B above it
for (const [name, shape] of Object.entries(KINDS)) {
  const d = design(base(), part('B', [shape]));
  const r = booleanResult(d, {}, 0, 1, 'insert');
  assert.ok(r.parts, `insert of ${name}: ${r.error}`);
  assert.equal(r.parts.length, 2, 'B stays');
  assert.deepEqual(r.parts[0].primitives, base().primitives, `A stays whole under ${name}`);
  assert.equal(r.parts[1].primitives[0].priority, 10.5, `${name} is lifted half a step above A (metal 10)`);
  assert.equal(d.parts[1].primitives[0].priority, undefined, 'the source part is not touched');
}
{
  const high = part('B', [{ ...KINDS.sphere, priority: 12 }]);
  assert.equal(booleanResult(design(base(), high), {}, 0, 1, 'insert').parts[1].primitives[0].priority, 12, 'a higher priority stays');
  const dielectric = { ...base(), material: 'FR4' };
  assert.equal(booleanResult(design(dielectric, { ...part('B', [KINDS.sphere]), material: 'FR4' }), {}, 0, 1, 'insert').parts[1].primitives[0].priority, 0.5, 'above a dielectric (0)');
  // bricks only keeps the exact A − B
  const plain = booleanResult(design(base(), part('B', [box([2, 2, 2], [4, 4, 6])])), {}, 0, 1, 'insert');
  assert.ok(plain.parts[0].primitives.length > 1 && plain.parts[1].primitives[0].priority === undefined);
}

// ---------------------------------------------------------------- the overlap prompt
{
  const hole = part('B', [cyl('z', [5, 5], 1, [-1, 5])]);
  assert.equal(booleanOverlap(base(), hole, {}), true, 'a cylinder through a brick overlaps it');
  assert.equal(booleanOverlap(base(), part('B', [cyl('z', [30, 5], 1, [-1, 5])]), {}), false, 'a distant cylinder does not');
  // bounding boxes overlap, the shapes do not: a sphere in the corner of a cone's box
  assert.equal(booleanOverlap(part('S', [{ kind: 'sphere', center: [0, 0, 0], radius: 1 }]), part('T', [cyl('z', [1.6, 1.6], 1, [-1, 1])]), {}), false, 'only the bounding boxes touch');
  assert.equal(booleanOverlap(part('S', [{ kind: 'sphere', center: [0, 0, 0], radius: 1.2 }]), part('T', [cyl('z', [1.6, 0], 1, [-1, 1])]), {}), true);
  for (const shape of Object.values(KINDS)) assert.equal(booleanOverlap(part('A', [box([0, 0, 0], [10, 10, 10])]), part('B', [shape]), {}), true, `${shape.kind} inside a brick`);
  // a sheet and a solid never prompt, two sheets in one plane do
  assert.equal(booleanOverlap(part('S', [box([0, 0, 2], [10, 10, 2])]), hole, {}), false);
  assert.equal(booleanOverlap(part('S', [box([0, 0, 2], [10, 10, 2])]), part('T', [{ kind: 'polygon', normal: 'z', elevation: 2, points: [[1, 1], [5, 1], [3, 4]] }]), {}), true);
  // a live nested result keeps prompting through its cut-outs
  const subtracted = booleanResult(design(base(), hole), {}, 0, 1, 'subtract').parts[0];
  assert.equal(booleanOverlap(subtracted, part('C', [box([4, 4, 1], [6, 6, 2])]), {}), true);
}

// ---------------------------------------------------------------- Subtract: cut-outs, every kind
for (const [name, shape] of Object.entries(KINDS)) {
  const r = booleanResult(design(base(), part('B', [shape])), {}, 0, 1, 'subtract');
  assert.ok(r.parts, `subtract ${name}: ${r.error}`);
  assert.equal(r.parts.length, 1, 'B is consumed');
  const prims = r.parts[0].primitives;
  assert.equal(prims.length, 2);
  assert.deepEqual(prims[0], base().primitives[0], `A is kept whole under ${name}`);
  assert.equal(prims[1].void, true, `${name} is a cut-out`);
  assert.equal(prims[1].kind, shape.kind);
  assert.equal(prims[1].priority, undefined, 'a cut-out takes its priority from its host in the build');
  assert.equal(r.parts[0].booleanHistory.live, true);
}
{
  // priorities of the host stay on its solid shapes only
  const r = materialiseBoolean({ operation: 'subtract', A: part('A', [box([0, 0, 0], [10, 10, 4], { priority: 7 })]), B: part('B', [KINDS.sphere]) }, {});
  assert.equal(r[0].priority, 7); assert.equal(r[1].priority, undefined);
  // two subtractions in a row add their cut-outs, and the result is live: the parameter moves the second
  const first = booleanResult(design(base(), part('B1', [cyl('z', [3, 3], 1, [-1, 5])])), {}, 0, 1, 'subtract').parts[0];
  const second = booleanResult(design(first, part('B2', [cyl('z', ['c', 7], 1, [-1, 5])])), { c: 3 }, 0, 1, 'subtract').parts[0];
  assert.deepEqual(second.primitives.map((p) => !!p.void), [false, true, true]);
  // the cut-out keeps its own expression (it follows the parameter and shows it in Properties), numbers only where it had to be trimmed
  assert.deepEqual(livePrimitives(second, { c: 6 })[2].center, ['c', 7], 'the cut-out keeps its expression');
  assert.equal(evaluate(livePrimitives(second, { c: 6 })[2].center[0], { c: 6 }), 6, 'live at another value');
  // a part with a cut-out of its own cannot be subtracted, or added to
  assert.match(booleanResult(design(base(), second), { c: 3 }, 0, 1, 'subtract').error, /cut-out of its own/);
  assert.match(booleanResult(design(second, part('C', [cyl('z', [9, 9], 0.2, [0, 1])])), { c: 3 }, 0, 1, 'add').error, /cut-out from an earlier Subtract/);
  // a transformed copy of the cut: every copy cuts
  const copies = materialiseBoolean({ operation: 'subtract', A: part('A', [box([0, 0, 0], [30, 10, 4])]), B: part('B', [cyl('z', [5, 5], 1, [-1, 5])], { transforms: [{ type: 'translate', copies: 2, step: [10, 0, 0] }] }) }, {});
  assert.deepEqual(copies.filter((p) => p.void).map((p) => p.center[0]), [5, 15, 25]);
  // a brick cut by a brick inside it (a closed cavity, no prism along an axis is smaller): the brick whole and the cut-out, like a curved cutter
  assert.deepEqual(materialiseBoolean({ operation: 'subtract', A: base(), B: part('B', [box([2, 2, 1], [4, 4, 2])]) }, {}).map((p) => p.kind + (p.void ? ' (cut-out)' : '')), ['box', 'box (cut-out)']);
  // a polygon is cut by a cylinder
  const outer = part('P', [{ kind: 'linpoly', normal: 'z', elevation: 0, length: 2, points: [[0, 0], [10, 0], [10, 10], [0, 10]] }]);
  assert.deepEqual(materialiseBoolean({ operation: 'subtract', A: outer, B: part('C', [cyl('z', [5, 5], 1, [-1, 3])]) }, {}).map((p) => p.kind), ['linpoly', 'cylinder']);
}
{
  // a sheet: a cut-out cuts it when a face lies on it (measured with openEMS); a face off by rounding is made exact
  const ground = part('G', [box([0, 0, 1.6], [20, 20, 1.6])]);
  const cut = (shape) => materialiseBoolean({ operation: 'subtract', A: ground, B: part('V', [shape]) }, {})[1];
  const crossing = cut(cyl('z', [5, 5], 1, [0, 3]));
  assert.deepEqual(crossing.range, [0, 3], 'a cylinder already through the sheet stays');
  assert.deepEqual(cut(cyl('z', [5, 5], 1, [1.6, 5])).range, [1.6, 5], 'a cylinder standing on the sheet stays as it is');
  assert.deepEqual(cut(cyl('z', [5, 5], 1, [-2, 1.6])).range, [-2, 1.6], 'one hanging below it too');
  assert.deepEqual(cut(cyl('z', [5, 5], 1, [1.6 + 1e-12, 5])).range, [1.6, 5], 'a face off by rounding lies exactly on the sheet');
  assert.deepEqual(cut(cyl('z', [5, 5], 1, [-2, 1.6 - 1e-12])).range, [-2, 1.6]);
  assert.deepEqual(cut(cyl('z', [5, 5], 1, [1.7, 5])).range, [1.7, 5], 'a gap stays: the check says it cuts nothing');
  assert.equal(materialiseBoolean({ operation: 'subtract', A: ground, B: part('V', [box([1, 1, 1.6 + 1e-13], [3, 3, 4]), { kind: 'sphere', center: [15, 15, 9], radius: 1 }]) }, {})[1].start[2], 1.6, 'a brick as well (with a curved shape along: bricks alone are refused against a sheet)');
  const cone = cut({ kind: 'cone', axis: 'z', center: [5, 5], bottom_radius: 1, top_radius: 0.5, range: [0, 1.6] });
  assert.deepEqual([cone.range, cone.top_radius], [[0, 1.6], 0.5], 'a cone keeps its range and taper');
  assert.equal(cut({ kind: 'sphere', center: [5, 5, 1.6], radius: 1 }).center[2], 1.6, 'a sphere centred on the sheet is left alone');
  // a flat shape cuts nothing from a solid; a sheet mixed with a solid is refused
  assert.match(booleanResult(design(part('A', [cyl('z', [0, 0], 3, [0, 3])]), part('B', [box([-1, -1, 1], [1, 1, 1])])), {}, 0, 1, 'subtract').error, /removes nothing/);
  assert.match(booleanResult(design(part('A', [box([0, 0, 0], [4, 4, 0]), cyl('z', [0, 0], 1, [0, 3])]), part('B', [cyl('z', [2, 2], 0.5, [-1, 1])])), {}, 0, 1, 'subtract').error, /mixes sheets and volumes/);
  // the preview shows the result and says nothing is wrong
  const view = booleanPreview(ground, part('V', [cyl('z', [5, 5], 1, [1.6, 5])]), 'subtract', {});
  assert.equal(view.error, undefined); assert.equal(view.result.filter((p) => p.void).length, 1);
}

// ---------------------------------------------------------------- exact coaxial cases
{
  const through = materialiseBoolean({ operation: 'subtract', A: part('A', [cyl('z', [1, 2], 5, [0, 10])]), B: part('B', [cyl('z', [1, 2], 2, [-1, 20])]) }, {});
  assert.deepEqual(through, [{ kind: 'cylinder', axis: 'z', center: [1, 2], radius: 5, inner_radius: 2, range: [0, 10] }], 'cylinder − coaxial cylinder = tube');
  const blind = materialiseBoolean({ operation: 'subtract', A: part('A', [cyl('x', [1, 2], 5, [0, 10])]), B: part('B', [cyl('x', [1, 2], 2, [-1, 6])]) }, {});
  near(blind.reduce((v, p) => v + cellVolume(p), 0), Math.PI * (25 * 10 - 4 * 6), 'a blind bore removes exactly its volume', 1e-9);
  assert.ok(blind.every((p) => !p.void), 'no cut-out needed');
  const offset = materialiseBoolean({ operation: 'subtract', A: part('A', [cyl('z', [1, 2], 5, [0, 10])]), B: part('B', [cyl('z', [1.5, 2], 2, [-1, 20])]) }, {});
  assert.equal(offset.length, 2); assert.equal(offset[1].void, true, 'an off-axis bore is a cut-out');
  const tubes = materialiseBoolean({ operation: 'intersect', A: part('A', [cyl('y', [0, 0], 5, [0, 10]), { ...cyl('y', [0, 0], 8, [0, 10]), inner_radius: 6 }]), B: part('B', [{ ...cyl('y', [0, 0], 7, [3, 20]), inner_radius: 2 }]) }, {});
  near(tubes.reduce((v, p) => v + cellVolume(p), 0), Math.PI * ((25 - 4) * 7 + (49 - 36) * 7), 'coaxial cylinders and tubes intersected');
  const empty = materialiseBoolean({ operation: 'intersect', A: part('A', [cyl('y', [0, 0], 1, [0, 1])]), B: part('B', [{ ...cyl('y', [0, 0], 4, [0, 1]), inner_radius: 2 }]) }, {});
  assert.deepEqual(empty, [], 'a rod inside a tube bore has nothing in common');
}

// ---------------------------------------------------------------- Intersect
{
  const trim = (R, K) => materialiseBoolean({ operation: 'intersect', A: part('A', [R]), B: part('B', [K]) }, {});
  const tube = trim({ ...cyl('z', [2, 3], 4, [0, 10]), inner_radius: 1 }, box([-5, -5, 2], [10, 10, 7]));
  assert.deepEqual(tube, [{ ...cyl('z', [2, 3], 4, [2, 7]), inner_radius: 1 }], 'a tube trimmed across its axis');
  const cone = trim({ kind: 'cone', axis: 'x', center: [0, 0], bottom_radius: 4, top_radius: 1, range: [0, 12] }, box([3, -9, -9], [8, 9, 9]));
  assert.deepEqual(cone, [{ kind: 'cone', axis: 'x', center: [0, 0], bottom_radius: 3.25, top_radius: 2, range: [3, 8] }], 'a cone becomes a frustum');
  assert.deepEqual(trim({ ...cyl('z', [2, 3], 4, [0, 10]), inner_radius: 1 }, box([-5, -5, 20], [10, 10, 30])), [], 'nothing in common above it');
  // a cylinder along a common axis: the cylinder itself when the clip leaves its ring, else a 64-gon prism
  const whole = trim(cyl('z', [5, 5], 3, [0, 4]), box([-9, -9, 1], [19, 19, 3]));
  assert.deepEqual(whole, [cyl('z', [5, 5], 3, [1, 3])], 'the ring is untouched: a native cylinder');
  const cut = trim(cyl('z', [5, 5], 3, [0, 4]), { kind: 'linpoly', normal: 'z', elevation: 1, length: 2, points: [[4, 0], [10, 0], [10, 6], [4, 6]] });
  assert.ok(cut.every((p) => p.kind === 'linpoly'));
  const area = cut.reduce((s, p) => s + ringArea(p.points), 0);
  let exact = 0; // the true area of the disc cut by x >= 4 and y <= 6, by integration
  for (let i = 0, n = 40000; i < n; i++) {
    const x = 4 + (4 * (i + 0.5)) / n, h = Math.sqrt(9 - (x - 5) ** 2);
    exact += (Math.min(6, 5 + h) - (5 - h)) * (4 / n);
  }
  assert.ok(area < exact && area > exact * 0.996, `the clipped 64-gon keeps the disc's area within its sagitta (${area} vs ${exact})`);
  near(Math.max(...cut.flatMap((p) => p.points.map((q) => q[1]))), 6, 'bounded by the polygon', 1e-9);
  assert.ok(cut.flatMap((p) => p.points).every(([x, y]) => (x - 5) ** 2 + (y - 5) ** 2 <= 9 + 1e-9), 'every vertex is on or inside the circle');
  // a cylinder through a brick clip along its axis (the brick's own axis is free)
  const sheetErr = booleanResult(design(part('A', [cyl('z', [5, 5], 3, [0, 4])]), part('B', [box([0, 0, 1], [10, 10, 1])])), {}, 0, 1, 'intersect');
  assert.match(sheetErr.error, /sheet with a volume/);
  // shapes inside a brick stay, shapes far away leave nothing
  for (const shape of [KINDS.sphere, KINDS.torus, KINDS.wire, KINDS.polyhedron, KINDS.cone]) {
    const inside = trim(shape, box([-1, -1, -1], [11, 11, 11]));
    assert.equal(inside.length, 1, `${shape.kind} inside a brick stays`); assert.equal(inside[0].kind, shape.kind);
    assert.deepEqual(trim(shape, box([20, 20, 20], [30, 30, 30])), [], `${shape.kind} far from the brick`);
  }
}
{
  const refuse = (A, B) => booleanResult(design(part('A', [A]), part('B', [B])), {}, 0, 1, 'intersect').error;
  const sphere = KINDS.sphere, hole = cyl('z', [5, 5], 1, [-3, 8]);
  const m1 = refuse(sphere, hole);
  assert.match(m1, /Intersect of A \(a sphere\) and B \(a cylinder\) is not supported/);
  assert.match(m1, /Subtract the part you do not want/, 'says what to do instead');
  assert.match(refuse(cyl('z', [0, 0], 2, [-3, 3]), cyl('x', [0, 0], 1, [-3, 3])), /Intersect of A \(a cylinder\) and B \(a cylinder\).*do not share one axis/);
  assert.match(refuse(sphere, box([5, 0, 0], [20, 20, 20])), /Intersect of A \(a sphere\) and B \(a brick\).*general solid intersection/);
  assert.match(refuse(tetra, { kind: 'cone', axis: 'z', center: [0.3, 0.3], bottom_radius: 1, top_radius: 0.2, range: [0, 3] }), /a polyhedron\) and B \(a cone\)/);
  assert.match(refuse(KINDS.tube, KINDS.sphere), /a tube/);
  for (const message of [m1, refuse(KINDS.torus, KINDS.wire)]) assert.ok(!/unsupported/.test(message) && /instead/i.test(message), 'never a generic message');
}
console.log('boolean curved shapes (add, insert, subtract cut-outs, coaxial, intersect, refusals) passed');
