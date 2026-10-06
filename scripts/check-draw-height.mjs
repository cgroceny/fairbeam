// Focused base-then-height drawing check; no DOM or solver.
import assert from 'node:assert/strict';
import { build } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
const modules = ['designer/store.ts', 'designer/draw.ts'];
const built = await build({ root, configFile: false, logLevel: 'silent', resolve: { conditions: ['browser'] }, css: { postcss: {} }, plugins: [solid(), {
  name: 'draw-height-entry', resolveId(id) { if (id.endsWith('draw-height-entry')) return '\0draw-height-entry'; }, load(id) {
    if (id !== '\0draw-height-entry') return;
    return modules.map((p, i) => `export * as m${i} from ${JSON.stringify(`${root}src/${p}`)};`).join('\n');
  },
}], build: { write: false, minify: false, cssCodeSplit: false, lib: { entry: 'draw-height-entry', formats: ['es'] } } });
const chunk = (Array.isArray(built) ? built[0] : built).output.find((x) => x.type === 'chunk');
const stub = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, querySelector: () => null };
globalThis.window = { ...stub, document: stub }; globalThis.document = stub; globalThis.requestAnimationFrame = () => 1;
const { m0: store, m1: draw } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
const design = { schema: 'fairbeam.design/1', model: { id: 'height', name: 'Height' }, params: [{ key: 'h', default: 2 }], materials: [{ name: 'copper', kind: 'metal' }], parts: [], ports: [], resistors: [], simulation: { f_min: 1, f_max: 2, boundaries: 'MUR' }, mesh: { mode: 'auto', cells_per_wavelength: 20 }, far_field: { enabled: false } };
store.setDraft(structuredClone(design)); store.setFile({ file: 'height', hash: '1', design }); store.setSelection({ type: 'design' });
draw.setConfirmShapes(true);
for (const normal of ['x', 'y', 'z']) {
  const k = ['x', 'y', 'z'].indexOf(normal);
  // the WCS origin carries the elevation: shapes are local to it and the new part keeps the translation
  draw.setWcs({ normal, origin: [0, 1, 2].map((i) => (i === k ? 10 : 0)), angle: 0 });
  draw.startTool('brick'); draw.place(0, 0); draw.place(4, 3);
  assert.equal(draw.heightStep(), true); assert.deepEqual(draw.points(), [[0, 0], [4, 3]]);
  draw.setHeightDraft('-h'); draw.finishHeight();
  let q = draw.shapeRequest().prim;
  assert.equal(q.kind, 'box'); assert.deepEqual([q.start[k], q.stop[k]], ['-h', 0]);
  assert.deepEqual(draw.shapeRequest().frameTransforms, [{ type: 'move', offset: [0, 1, 2].map((i) => (i === k ? 10 : 0)) }]); assert.equal(draw.tool(), null, 'the drawing mode is left when the shape is finished');
  assert.equal(draw.heightStep(), false); assert.deepEqual(draw.points(), []); draw.setShapeRequest(null);

  draw.startTool('cylinder'); draw.place(0, 0); draw.place(2, 0, { r: 'r' });
  assert.equal(draw.heightStep(), true); draw.setHeightDraft(0); draw.finishHeight();
  // height 0: a flat circle (a zero-length cylinder; the build makes a polygon sheet of it), not a radius-long cylinder
  q = draw.shapeRequest().prim; assert.equal(q.kind, 'cylinder'); assert.deepEqual(q.range, [0, 0]); assert.equal(q.radius, 'r'); draw.setShapeRequest(null);

  draw.startTool('polygon'); draw.place(0, 0); draw.place(3, 0); draw.place(0, 3); draw.commit();
  assert.equal(draw.heightStep(), true); draw.setHeightDraft('h'); draw.finishHeight();
  q = draw.shapeRequest().prim; assert.equal(q.kind, 'linpoly'); assert.equal(q.normal, normal); assert.equal(q.length, 'h'); draw.setShapeRequest(null);
  draw.startTool('polygon'); draw.place(0, 0); draw.place(3, 0); draw.place(0, 3); draw.commit(); draw.setHeightDraft(0); draw.finishHeight();
  q = draw.shapeRequest().prim; assert.equal(q.kind, 'polygon'); draw.setShapeRequest(null);
}
// A typed negative cylinder height is represented with ascending axis range; 0 is a flat circle.
draw.resetWcsToGlobal();
draw.startTool('cylinder'); draw.place(0, 0); draw.place(2, 0); draw.setHeightDraft(-3); draw.commit(); // commit is inert during height step
draw.finishHeight(); assert.deepEqual(draw.shapeRequest().prim.range, [-3, 0]); draw.setShapeRequest(null);
// Esc in the height step restores editable base; brick/cylinder discard the second point, polygon keeps corners.
draw.startTool('brick'); draw.place(0, 0); draw.place(2, 2); draw.cancel(); assert.equal(draw.heightStep(), false); assert.deepEqual(draw.points(), [[0, 0]]);
draw.place(3, 3); draw.cancel(); assert.deepEqual(draw.points(), [[0, 0]]); draw.cancel(); assert.deepEqual(draw.points(), []);
draw.startTool('polygon'); draw.place(0, 0); draw.place(2, 0); draw.place(0, 2); draw.commit(); draw.cancel(); assert.deepEqual(draw.points(), [[0, 0], [2, 0], [0, 2]]);
draw.startTool('polygon'); draw.place(0, 0); draw.place(2, 0); draw.place(0, 2); draw.commit();
draw.finishHeight('-h');
assert.equal(draw.shapeRequest().prim.elevation, '-h');
assert.equal(draw.shapeRequest().prim.length, '-(-h)');
draw.setShapeRequest(null);
// One insertion, one undo.
draw.startTool('brick'); draw.setConfirmShapes(false); draw.place(0, 0); draw.place(2, 2); draw.setHeightDraft(1); draw.finishHeight();
assert.equal(store.draft.parts.length, 1); assert.equal(store.draft.parts[0].primitives.length, 1); store.undo(); assert.equal(store.draft.parts.length, 0);
console.log('Draw height: base/height transitions, signed and zero heights, x/y/z box/cylinder/polygon geometry, cancel and one-step insert/undo passed.');


