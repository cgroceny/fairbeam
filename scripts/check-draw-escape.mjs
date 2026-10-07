// Esc and Enter paths for the three drawing tools and their work-plane dialog defaults: with no point
// Esc leaves the tool and Enter opens the tool's shape dialog; after points Esc removes the last one
// (the first one too, staying in the tool) and a second Esc leaves; a re-armed tool starts with no
// points. The hint, the 3D view's key handler and docs/DESIGNER.md say the same.
//   node scripts/check-draw-escape.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
const modules = ['designer/store.ts', 'designer/draw.ts', 'designer/dialogs/shapes.ts'];
const built = await build({
  root, configFile: false, logLevel: 'silent', resolve: { conditions: ['browser'] }, css: { postcss: {} },
  plugins: [solid(), {
    name: 'draw-escape-entry',
    resolveId(id) { if (id.endsWith('draw-escape-entry')) return '\0draw-escape-entry'; },
    load(id) {
      if (id !== '\0draw-escape-entry') return;
      return modules.map((path, i) => `export * as m${i} from ${JSON.stringify(`${root}src/${path}`)};`).join('\n');
    },
  }],
  build: { write: false, minify: false, cssCodeSplit: false, lib: { entry: 'draw-escape-entry', formats: ['es'] } },
});
const chunk = (Array.isArray(built) ? built[0] : built).output.find((o) => o.type === 'chunk');
const stub = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, querySelector: () => null };
globalThis.window = { ...stub, document: stub };
globalThis.document = stub;
globalThis.requestAnimationFrame = () => 1;
const { m0: store, m1: draw, m2: shapes } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);

let checks = 0;
const eq = (got, want, message) => { checks++; assert.equal(got, want, message); };
const ok = (value, message) => { checks++; assert.ok(value, message); };

// ---- the decisions
for (const tool of ['brick', 'cylinder', 'polygon']) {
  eq(draw.drawEscapeAction(tool, 0, false), 'leave', `${tool}: Esc with no point leaves the tool`);
  eq(draw.drawEscapeAction(tool, 1, false), 'step-back', `${tool}: Esc after a point steps back`);
  eq(draw.drawEscapeAction(tool, 0, true), 'step-back', `${tool}: height Esc returns to the base`);
  eq(draw.drawEnterAction(tool, 0), 'open-dialog', `${tool}: Enter before the first point opens the shape dialog`);
  const kind = draw.toolShape(tool);
  eq(kind, tool === 'brick' ? 'box' : tool, `${tool}: its shape dialog kind`);
  const expected = shapes.defaultPrimitive(kind);
  ok(expected, `${tool}: default primitive exists`);
  draw.setShapeRequest(null);
  eq(shapes.openShapeDialog(kind), true, `${tool}: dialog opens`);
  checks++; assert.deepEqual(draw.shapeRequest().prim, expected, `${tool}: dialog uses defaultPrimitive on the work plane`);
  eq(draw.shapeRequest().drawn, false, `${tool}: dialog request is not a drawn shape`);
  draw.setShapeRequest(null); // Esc in this dialog only clears its request; it cannot place geometry.
}
eq(draw.drawEnterAction('polygon', 3), 'finish', 'Enter closes a polygon of three points');
eq(draw.drawEnterAction('polygon', 2), 'none', 'not one of two');
eq(draw.drawEnterAction('brick', 1), 'none', 'Enter after a brick corner does nothing');
eq(draw.drawEscapeAction(null, 0, false), 'none', 'no active tool ignores Esc');
eq(draw.drawEnterAction(null, 0), 'none', 'no active tool ignores Enter');

// ---- cancel() as Esc runs it, on the real tool state
const design = {
  schema: 'fairbeam.design/1', model: { id: 'check', name: 'Check' }, params: [], materials: [{ name: 'copper', kind: 'metal' }],
  parts: [], ports: [], resistors: [], simulation: { f_min: 1, f_max: 2, boundaries: 'MUR' }, mesh: { mode: 'auto' }, far_field: { enabled: false },
};
store.setDraft(structuredClone(design));
store.setFile({ file: 'check', hash: '1', design });
draw.startTool('polygon');
draw.place(0, 0); draw.place(4, 0); draw.place(4, 3);
eq(draw.points().length, 3, 'three corners placed');
draw.cancel();
eq(draw.points().length, 2, 'Esc removes the last point');
draw.cancel(); draw.cancel();
eq(draw.points().length, 0, 'Esc on the first point clears it');
eq(draw.tool(), 'polygon', 'and stays in the tool');
draw.cancel();
eq(draw.tool(), null, 'a second Esc leaves the tool');
// leaving keeps nothing: the next time the tool is armed it starts at 0 points
draw.startTool('polygon');
for (let k = 0; k < 6; k++) draw.place(k, k * k);
draw.startTool(null);
draw.startTool('polygon');
eq(draw.points().length, 0, 'a re-armed tool shows no points of an earlier attempt');
// the height step: Esc goes back to the base, then removes points
draw.startTool('brick');
draw.place(0, 0); draw.place(3, 2);
eq(draw.heightStep(), true, 'two corners: the height step');
draw.cancel();
eq(draw.heightStep(), false, 'Esc leaves the height step');
eq(draw.points().length, 1, 'back to the first corner');
draw.cancel(); draw.cancel();
eq(draw.tool(), null, 'then the corner, then the tool');
eq(draw.points().length, 0);

// ---- the wiring: the 3D view's keys, the hint and the docs say the same
const overlay = readFileSync(`${root}src/scene/drawOverlay.ts`, 'utf8');
ok(/drawEscapeAction\(tool\(\), points\(\)\.length, heightStep\(\)\) !== "none"\) cancel\(\)/.test(overlay), 'Esc in the 3D view runs cancel()');
ok(/drawEnterAction\(active, points\(\)\.length\)/.test(overlay) && /openShapeDialog\(toolShape\(active\)\); startTool\(null\)/.test(overlay), 'Enter before the first point opens the shape dialog');
ok(!/action === "open-dialog"\) \{\s*const activeTool/.test(overlay), 'Esc no longer opens the shape dialog');
const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, 'utf8'));
const tr = JSON.parse(readFileSync(`${root}src/i18n/tr.json`, 'utf8'));
for (const tool of ['brick', 'cylinder', 'polygon']) {
  ok(/Enter before the first click opens/.test(en[`draw.hint.${tool}`]) && !/Esc before/.test(en[`draw.hint.${tool}`]), `${tool} hint: Enter opens the dialog`);
  ok(/İlk tıklamadan önce Enter/.test(tr[`draw.hint.${tool}`]), `${tool} hint (tr)`);
}
ok(/Esc with no point stops drawing/.test(en['draw.baseStep']), 'the hint says how Esc leaves');
const doc = readFileSync(`${root}docs/DESIGNER.md`, 'utf8');
ok(/Escape with no point placed stops\s+drawing/.test(doc) && /Enter before the first click opens the tool's\s+shape dialog/.test(doc), 'DESIGNER.md describes Esc and Enter');
console.log(`check-draw-escape: ${checks} checks passed`);
