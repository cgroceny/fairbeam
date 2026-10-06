// The Boolean UI against the real Solid stores (no DOM or solver): the toast says what happened, Subtract of
// bricks stays compact and undoes in one step, an Insert follows later edits of the inserted shape (no collision
// bar, no stacked history), and the refusals are shown before anything is applied.
//
//   node scripts/check-boolean-ui.mjs
import assert from 'node:assert/strict';
import { build } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
const modules = ['designer/store.ts', 'designer/booleanUi.ts'];
const built = await build({
  root, configFile: false, logLevel: 'silent', resolve: { conditions: ['browser'] }, css: { postcss: {} },
  plugins: [solid(), {
    name: 'boolean-ui-entry',
    resolveId(id) { if (id.endsWith('boolean-ui-entry')) return '\0boolean-ui-entry'; },
    load(id) {
      if (id !== '\0boolean-ui-entry') return;
      return modules.map((path, i) => `export * as m${i} from ${JSON.stringify(`${root}src/${path}`)};`).join('\n');
    },
  }],
  build: { write: false, minify: false, cssCodeSplit: false, lib: { entry: 'boolean-ui-entry', formats: ['es'] } },
});
const chunk = (Array.isArray(built) ? built[0] : built).output.find((o) => o.type === 'chunk');
const stub = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, querySelector: () => null, getElementById: () => null };
globalThis.window = { ...stub, document: stub };
globalThis.document = stub;
globalThis.requestAnimationFrame = () => 1;
const { m0: store, m1: booleans } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);

const box = (start, stop) => ({ kind: 'box', start, stop });
const base = (parts) => ({
  schema: 'fairbeam.design/1', model: { id: 'check', name: 'Check' }, params: [],
  materials: [{ name: 'copper', kind: 'metal' }],
  parts, ports: [], resistors: [], simulation: { f_min: 1, f_max: 2, boundaries: 'MUR' }, mesh: { mode: 'auto', cells_per_wavelength: 20 }, far_field: { enabled: false },
});
const open = (parts) => { const d = base(parts); store.setDraft(structuredClone(d)); store.setFile({ file: 'check', hash: '1', design: d }); store.setMessage(null); };
const part = (name, primitives, extra = {}) => ({ name, material: 'copper', primitives, ...extra });

// ---- Subtract: one undo step, the toast counts the shapes and says what became of B
open([part('brick', [box([0, 0, 0], [10, 10, 4])]), part('pocket', [box([3, 3, 2], [7, 7, 5])])]);
assert.equal(booleans.runBoolean('subtract', 0, 1), true);
assert.equal(store.draft.parts.length, 1, 'B is gone as a solid');
assert.deepEqual(store.draft.parts[0].primitives.map((p) => !!p.void), [false, true], 'a pocket: the brick and a cut-out');
assert.match(store.message().text, /Subtract: brick − pocket → 'brick' \(2 shapes\)\. brick lost 32 mm³ \(the volume it shared with pocket\)\. pocket stays in 'brick' as an exact cut-out/, 'the toast says which solid lost which volume');
store.undo();
assert.deepEqual(store.draft.parts.map((p) => p.name), ['brick', 'pocket'], 'one undo restores both');

// ---- a notch: one shape, said so; Add of a part says which solid it went into
open([part('plate', [box([0, 0, 1], [10, 6, 1])]), part('notch', [box([6, 3, 1], [12, 8, 1])])]);
booleans.runBoolean('subtract', 0, 1);
assert.equal(store.draft.parts[0].primitives.length, 1);
assert.match(store.message().text, /→ 'plate' \(1 shape\)/);
open([part('tab', [box([0, 0, 0], [2, 2, 0])]), part('ground', [box([1, 1, 0], [4, 4, 0])])]);
booleans.runBoolean('add', 0, 1);
assert.match(store.message().text, /Add: tab ∪ ground → 'tab' \(\d+ shapes?\)\. ground is now part of 'tab', which keeps the material copper/);

// ---- a refusal is shown before anything is applied, with the reason, and the design is untouched
open([part('sheet', [box([0, 0, 1], [4, 4, 1])]), part('brick', [box([1, 1, 0], [3, 3, 2])])]);
const before = JSON.stringify(store.draft);
assert.equal(booleans.runBoolean('add', 0, 1), false);
assert.match(booleans.booleanNotice(), /^Add cannot combine a sheet with a volume/);
assert.equal(JSON.stringify(store.draft), before, 'nothing applied');
// a sheet minus a thick brick is allowed: the brick's cross-section cuts it
assert.equal(booleans.runBoolean('subtract', 0, 1), true);
assert.equal(store.draft.parts.length, 1);
assert.match(store.message().text, /sheet lost 4 mm² \(the area it shared with brick\)/, 'a sheet cut by a volume says how much area it lost');
assert.equal(store.message().tone, 'good');

// ---- Insert follows later edits of the inserted shape: no collision bar, no stacked history
open([part('block', [box([0, 0, 0], [10, 10, 4])]), part('pin', [box([3, 3, 0], [5, 5, 4])])]);
assert.equal(booleans.runBoolean('insert', 0, 1), true);
assert.deepEqual(store.draft.parts.map((p) => p.name), ['block', 'pin']);
store.edit((d) => { d.parts[1].primitives[0].start = [6, 6, 0]; d.parts[1].primitives[0].stop = [8, 8, 4]; });
assert.equal(booleans.automaticOverlap(), null, 'moving the inserted shape raises no collision bar');
assert.deepEqual(store.draft.parts[0].booleanHistory.B.primitives[0].start, [6, 6, 0], 'the Boolean follows the inserted shape');
assert.equal(store.draft.parts[0].booleanHistory.live, true, 'and stays live');
assert.equal(store.draft.parts[0].booleanHistory.A.booleanHistory, undefined, 'one history, not a stack');
const cut = store.draft.parts[0].primitives.filter((p) => !p.void);
const volume = cut.reduce((s, p) => s + (p.kind === 'linpoly' ? Math.abs(p.points.reduce((a, q, i, all) => a + q[0] * all[(i + 1) % all.length][1] - all[(i + 1) % all.length][0] * q[1], 0)) / 2 * p.length : p.start.reduce((v, x, i) => v * (p.stop[i] - x), 1)), 0);
assert.ok(Math.abs(volume - (400 - 16)) < 1e-9, `the block is cut where the pin now is (${volume})`);
store.undo();
assert.deepEqual(store.draft.parts[1].primitives[0].start, [3, 3, 0], 'one undo takes the pin and the cut back together');
assert.deepEqual(store.draft.parts[0].booleanHistory.B.primitives[0].start, [3, 3, 0]);

// ---- the Boolean keys: with a solid selected, a key starts the operation with it as A; the next pick is B; Enter applies
const select = (i) => store.setSelection({ type: 'part', i });
open([part('brick', [box([0, 0, 0], [10, 10, 4])]), part('brick2', [box([3, 3, 2], [7, 7, 5])])]);
select(0);
assert.equal(booleans.booleanKeysActive(), true, 'a solid is selected and there is a second one: the keys are the Boolean now');
for (const [op, symbol] of [['add', '+'], ['subtract', '-'], ['intersect', '*'], ['insert', '/']]) {
  booleans.setBooleanPending(null);
  assert.equal(booleans.booleanShortcut(op), true, `${symbol} starts ${op}`);
  assert.deepEqual({ ...booleans.booleanPending() }, { a: 0, operation: op }, `${op}: A is the selected solid, B still to be picked`);
}
booleans.setBooleanPending(null);
booleans.booleanShortcut('subtract');
booleans.acceptBooleanPick(1);
assert.equal(booleans.booleanPending().b, 1);
assert.equal(booleans.booleanPending().a, 0);
booleans.applyPendingBoolean();
assert.equal(booleans.booleanPending(), null);
assert.deepEqual(store.draft.parts.map((p) => p.name), ['brick'], 'brick − brick2: brick is what is left');
assert.deepEqual(store.draft.parts[0].primitives.map((p) => !!p.void), [false, true], 'brick2 is a cut-out of brick');
assert.match(store.message().text, /^Subtract: brick − brick2/);
// the order is first selected − picked, whatever was selected before: brick2 selected, then brick, then −
open([part('brick', [box([0, 0, 0], [10, 10, 4])]), part('brick2', [box([3, 3, 2], [7, 7, 5])])]);
select(1); select(0);
booleans.booleanShortcut('subtract');
assert.deepEqual({ ...booleans.booleanPending() }, { a: 0, operation: 'subtract' }, 'earlier selections never turn into B');
// a shape of a part stands for its part
booleans.setBooleanPending(null);
store.setSelection({ type: 'primitive', i: 1, j: 0 });
booleans.booleanShortcut('subtract');
assert.equal(booleans.booleanPending().a, 1);
// nothing to combine: the key keeps its other use (zoom)
booleans.setBooleanPending(null);
store.setSelection({ type: 'design' });
assert.equal(booleans.booleanKeysActive(), false); assert.equal(booleans.booleanShortcut('subtract'), false);
open([part('only', [box([0, 0, 0], [1, 1, 1])])]);
select(0);
assert.equal(booleans.booleanKeysActive(), false); assert.equal(booleans.booleanShortcut('subtract'), false);

// ---- brick − brick2 really removes brick2's volume from brick, and brick2 − brick the opposite one
const volumeOf = (prims) => prims.filter((p) => !p.void).reduce((v, p) => v + p.start.reduce((x, k, i) => x * Math.abs(p.stop[i] - k), 1), 0);
open([part('brick', [box([0, 0, 0], [10, 10, 4])]), part('brick2', [box([5, 0, 0], [15, 10, 4])])]);
booleans.runBoolean('subtract', 0, 1);
assert.equal(volumeOf(store.draft.parts[0].primitives), 5 * 10 * 4, 'brick − brick2 keeps the part of brick that brick2 does not cover');
assert.match(store.message().text, /brick lost 200 mm³/);
open([part('brick', [box([0, 0, 0], [10, 10, 4])]), part('brick2', [box([5, 0, 0], [15, 10, 4])])]);
booleans.runBoolean('subtract', 1, 0);
assert.equal(volumeOf(store.draft.parts[0].primitives), 5 * 10 * 4, 'brick2 − brick keeps the other part');
assert.deepEqual(store.draft.parts[0].primitives[0].start, [10, 0, 0]);
assert.match(store.message().text, /brick2 lost 200 mm³ \(the volume it shared with brick\)/);
// a cutter that touches nothing says so (a warning), instead of leaving the user guessing
open([part('brick', [box([0, 0, 0], [10, 10, 4])]), part('far', [box([20, 20, 0], [25, 25, 4])])]);
booleans.runBoolean('subtract', 0, 1);
assert.match(store.message().text, /far does not overlap brick, so nothing was removed from brick/);
assert.equal(store.message().tone, 'warn');

// ---- a parametric cutter stays parametric: the cut-out keeps its expressions and follows the parameter
{
  const d = base([part('plate', [box([0, 0, 0], [20, 20, 4])]), part('cutter', [box(['sx', 5, 1], ['sx+w', 15, 3])])]);
  d.params = [{ key: 'sx', default: 4 }, { key: 'w', default: 6 }];
  store.setDraft(structuredClone(d)); store.setFile({ file: 'check', hash: '1', design: d }); store.setMessage(null);
  assert.equal(booleans.runBoolean('subtract', 0, 1), true);
  const cutout = () => store.draft.parts[0].primitives.find((p) => p.void);
  assert.deepEqual([cutout().start, cutout().stop], [['sx', 5, 1], ['sx+w', 15, 3]], 'the cut-out keeps the expressions it was built from');
  store.edit((x) => { x.params.find((q) => q.key === 'sx').default = 8; x.params.find((q) => q.key === 'w').default = 3; });
  assert.deepEqual([cutout().start, cutout().stop], [['sx', 5, 1], ['sx+w', 15, 3]], 'and still has them after a parameter changes');
  assert.equal(store.draft.parts[0].booleanHistory.live, true, 'the result stays live');
  // a notch reaching out of the plate is trimmed in numbers, and moves with the parameter
  const e = base([part('plate', [box([0, 0, 0], [20, 20, 4])]), part('slot', [box(['sx', 5, 1], ['sx+w', 30, 3])])]);
  e.params = [{ key: 'sx', default: 4 }, { key: 'w', default: 6 }];
  store.setDraft(structuredClone(e)); store.setFile({ file: 'check', hash: '2', design: e });
  booleans.runBoolean('subtract', 0, 1);
  store.edit((x) => { x.params.find((q) => q.key === 'sx').default = 9; });
  const slot = store.draft.parts[0].primitives.find((p) => p.void);
  assert.ok(slot, 'the slot is still a cut-out');
  assert.equal(Number(slot.start[0]), 9, 'the slot moved with the parameter');
}

console.log('Boolean UI: toast, one undo step, refusal before applying, Insert following edits, the Boolean keys, removed volume and parametric cut-outs passed.');
