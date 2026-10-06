// Compact Subtract: a box minus a box must not be partitioned into many bricks.
// Sheets give one polygon where possible, prisms on a common axis extruded polygons, otherwise the brick stays
// whole and the cutter becomes an exact vacuum cut-out. The result keeps a later Add or Subtract working, a sheet
// can be cut by a thick brick, an operand with a round cut can be added, every refusal names the operation chosen
// and the toast says what happened. python/tests/test_boolean_compact.py checks the same shapes in the build.
import assert from 'node:assert/strict';
import { appliedText, booleanOverlap, booleanResult } from '../src/designer/booleanParts.ts';
import { ringArea } from '../src/designer/polygonClip.ts';
import { quickBundle } from '../src/designer/geometry.ts';
import { cstMacro } from '../src/export/cst.ts';

const brickPart = (name, start, stop, extra = {}) => ({ name, material: 'Cu', primitives: [{ kind: 'box', start, stop }], ...extra });
const design = (...parts) => ({ parts });
const run = (a, b, op = 'subtract') => booleanResult(design(a, b), {}, 0, 1, op);
const shapesOf = (res) => res.parts[0].primitives;
const kinds = (ps) => ps.map((p) => (p.void ? 'void ' : '') + p.kind);
const near = (x, y, what, tol = 1e-9) => assert.ok(Math.abs(x - y) < tol, `${what}: ${x} vs ${y}`);
/** the area of flat shapes (polygons, sheet bricks) and the volume of solid ones (bricks, extruded polygons); cut-outs are not counted */
const amount = (ps) => ps.reduce((sum, p) => {
  if (p.void) return sum;
  if (p.kind === 'polygon') return sum + ringArea(p.points);
  if (p.kind === 'linpoly') return sum + ringArea(p.points) * p.length;
  const d = [0, 1, 2].map((k) => p.stop[k] - p.start[k]);
  const sheet = d.indexOf(0);
  return sum + (sheet < 0 ? d[0] * d[1] * d[2] : d.filter((_, k) => k !== sheet).reduce((x, y) => x * y, 1));
}, 0);

// an L-notch on a sheet: one polygon; the filler added back is one shape again
let res = run(brickPart('plate', [0, 0, 1], [10, 6, 1]), brickPart('notch', [6, 3, 1], [12, 8, 1]));
assert.deepEqual(kinds(shapesOf(res)), ['polygon'], 'an L-notch on a sheet is one polygon');
near(amount(shapesOf(res)), 60 - 12, 'L area');
const notched = res.parts[0];
res = booleanResult(design(notched, brickPart('filler', [6, 3, 1], [10, 6, 1])), {}, 0, 1, 'add');
assert.equal(shapesOf(res).length, 1, 'adding the filler back: one shape');
near(amount(shapesOf(res)), 60, 'filled area');

// a centred hole in a plate: two pieces at most, exact, named after the plate
res = run(brickPart('plate', [0, 0, 1], [10, 10, 1]), brickPart('hole', [4, 4, 1], [6, 6, 1]));
assert.equal(shapesOf(res).length, 2, 'a centred hole in a sheet needs two pieces');
near(amount(shapesOf(res)), 96, 'plate area');
assert.ok(shapesOf(res).every((p) => /^plate \(part \d of 2\)$/.test(p.label)), 'pieces are named after the plate');
res = run(brickPart('block', [0, 0, 0], [10, 10, 2]), brickPart('drill', [4, 4, -1], [6, 6, 5]));
assert.equal(shapesOf(res).length, 2, 'a hole through a thick plate: two shapes');
near(amount(shapesOf(res)), 200 - 8, 'plate volume');

// a pocket: the brick whole and the cutter as an exact vacuum cut-out
const brick = brickPart('brick', [0, 0, 0], [10, 10, 4]);
res = run(brick, brickPart('pocket', [3, 3, 2], [7, 7, 5]));
assert.deepEqual(kinds(shapesOf(res)), ['box', 'void box'], 'a pocket is the brick plus a cut-out');
assert.deepEqual([...shapesOf(res)[1].start, ...shapesOf(res)[1].stop], [3, 3, 2, 7, 7, 4], 'the cut-out is trimmed to the brick');
assert.equal(shapesOf(res)[1].label, 'pocket (cut-out)');
const pocketed = res.parts[0];
// later operations on it: Add the filler back (one shape), Subtract again (the cut-outs add up), Intersect, Insert
const filled = booleanResult(design(pocketed, brickPart('filler', [3, 3, 2], [7, 7, 4])), {}, 0, 1, 'add');
assert.equal(shapesOf(filled).length, 1, 'filler back into a pocket: one shape');
near(amount(shapesOf(filled)), 400, 'volume after the filler');
assert.deepEqual(kinds(shapesOf(booleanResult(design(pocketed, brickPart('second', [8, 8, -1], [12, 12, 2])), {}, 0, 1, 'subtract'))), ['box', 'void box', 'void box']);
near(amount(shapesOf(booleanResult(design(pocketed, brickPart('slab', [0, 0, 3], [10, 10, 5])), {}, 0, 1, 'intersect'))), 100 - 4 * 4, 'a pocketed brick intersected');
assert.ok(booleanResult(design(pocketed, brickPart('pin', [4, 4, 0], [5, 5, 4])), {}, 0, 1, 'insert').parts, 'Insert into a pocketed brick works');

// a slit cutting a brick in two: two bricks; a brick B does not touch stays one
res = run(brickPart('bar', [0, 0, 0], [10, 6, 2]), brickPart('slit', [4, -1, -1], [5, 7, 3]));
assert.deepEqual(kinds(shapesOf(res)), ['box', 'box']);
near(amount(shapesOf(res)), 120 - 12, 'bar volume');
assert.deepEqual(kinds(shapesOf(run(brickPart('bar', [0, 0, 0], [4, 4, 2]), brickPart('far', [6, 0, 0], [12, 4, 2])))), ['box']);

// a sheet minus a thick brick: the brick's cross-section at the sheet's plane; one that does not reach it cuts nothing
res = run(brickPart('ground', [0, 0, 1], [10, 10, 1]), brickPart('post', [3, 3, 0], [6, 6, 2]));
near(amount(shapesOf(res)), 91, 'sheet − brick');
assert.equal(shapesOf(run(brickPart('ground', [0, 0, 1], [10, 10, 1]), brickPart('post', [3, 3, 2], [6, 6, 3]))).length, 1);

// Add of an operand with a round cut: folded in, not refused (the cut turns the sheet into polygons)
const holed = brickPart('a', [0, 0, 0], [4, 4, 0], { cuts: [{ kind: 'circle', normal: 'z', elevation: 0, center: [2, 2], radius: 1 }] });
res = run(holed, brickPart('b', [3, 0, 0], [7, 4, 0]), 'add');
assert.ok(res.parts, 'an operand with a round cut can be added');
near(amount(shapesOf(res)), 28 - Math.PI, 'union area (the disc is a polygon)', 0.05);
assert.ok(run(holed, brickPart('b', [3, 0, 0], [7, 4, 0]), 'intersect').parts, 'and intersected');

// every refusal says the operation the user chose
const sheet = brickPart('s', [0, 0, 1], [4, 4, 1]), volume = brickPart('v', [1, 1, 0], [3, 3, 2]);
assert.match(run(sheet, volume, 'add').error, /^Add cannot combine a sheet with a volume/);
assert.match(run(sheet, volume, 'intersect').error, /^Intersect cannot combine/);
assert.match(run(brickPart('v', [0, 0, 0], [4, 4, 4]), brickPart('s', [1, 1, 1], [3, 3, 1])).error, /^s has a sheet .*removes nothing from v/);
assert.ok(!/merge/i.test(run(sheet, volume, 'add').error));

// the toast says what happened: which solid the other went into, the shapes of the result, what became of B
const tab = brickPart('tab', [0, 0, 0], [2, 2, 0]), ground = brickPart('ground', [1, 1, 0], [4, 4, 0]);
const text = appliedText('add', tab, ground, run(tab, ground, 'add').parts[0]);
assert.match(text, /tab ∪ ground → 'tab' \(\d+ shapes?\)/);
assert.match(text, /ground is now part of 'tab', which keeps the material Cu/);
assert.match(appliedText('subtract', brick, brickPart('pocket', [3, 3, 2], [7, 7, 5]), pocketed), /\(2 shapes\)\. pocket stays in 'brick' as an exact cut-out/);
assert.match(appliedText('insert', brick, brickPart('pin', [0, 0, 0], [1, 1, 1]), brick), /\(1 shape\)\. pin stays as its own solid/);

// Insert again of the shape an Insert result already follows: the history is refreshed, not stacked, and B stays
const ins = booleanResult(design(brick, brickPart('pin', [3, 3, 0], [5, 5, 4])), {}, 0, 1, 'insert').parts;
assert.equal(ins.length, 2);
const moved = [ins[0], { ...ins[1], primitives: [{ kind: 'box', start: [6, 6, 0], stop: [8, 8, 4] }] }];
const again = booleanResult(design(...moved), {}, 0, 1, 'insert');
assert.equal(again.parts.length, 2, 'the inserted shape stays where it is');
assert.equal(again.parts[0].booleanHistory.A.booleanHistory, undefined, 'the history is not stacked');
assert.deepEqual(again.parts[0].booleanHistory.B.primitives[0].start, [6, 6, 0], 'the history follows the inserted shape');
assert.equal(booleanOverlap(again.parts[0], again.parts[1], {}), false, 'the cut follows the shape: they no longer overlap');

// CST export, the 3D view's bundle: the pocketed brick is the brick plus a vacuum tool Solid.Subtract-ed from it; the L and the
// slit are plain solids; nothing is skipped or warned about
{
  const exported = (parts) => {
    const b = quickBundle({ model: { id: 'c', name: 'C' }, params: [], materials: [{ name: 'Cu', kind: 'metal', color: '#b87333' }], parts, ports: [], simulation: { f_min: 1, f_max: 2, boundaries: 'MUR' } }, {}, null);
    assert.ok(b, 'the bundle builds');
    Object.assign(b, { units: { length: 'mm', length_m: 1e-3 }, generator: { name: 'fairbeam', version: 'test' }, created: '2026-01-01T00:00:00Z', domain: { min: [-20, -20, -20], max: [40, 40, 30] }, mesh: { x: [], y: [], z: [], total_cells: 0 } });
    return { b, ...cstMacro(b) };
  };
  const pocket = exported([pocketed]);
  assert.equal(pocket.b.parts.length, 2, 'the 3D view gets the brick and its cut part');
  assert.equal(pocket.b.parts[1].void, true);
  assert.equal(pocket.text.split(/\r?\n/).filter((l) => l.includes('.Subtract')).length, 1, 'CST: one Solid.Subtract');
  assert.deepEqual(pocket.warnings, []);
  const slit = exported([run(brickPart('bar', [0, 0, 0], [10, 6, 2]), brickPart('slit', [4, -1, -1], [5, 7, 3])).parts[0]]);
  assert.ok(!slit.text.includes('.Subtract') && slit.warnings.length === 0, 'two bricks: no Subtract, no warnings');
  const lshape = exported([notched]);
  assert.deepEqual(lshape.warnings, [], 'an L-shaped sheet exports');
}

console.log('boolean compact Subtract (L-notch, hole, pocket, slit, filler, sheet − brick, round cut, messages, Insert) passed');
