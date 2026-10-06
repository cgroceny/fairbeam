// Esc paths for the three drawing tools and their work-plane dialog defaults.
//   node scripts/check-draw-escape.mjs
import assert from 'node:assert/strict';
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
const { m1: draw, m2: shapes } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);

let checks = 0;
const eq = (got, want, message) => { checks++; assert.equal(got, want, message); };
for (const tool of ['brick', 'cylinder', 'polygon']) {
  eq(draw.drawEscapeAction(tool, 0, false), 'open-dialog', `${tool}: initial Esc opens defaults`);
  eq(draw.drawEscapeAction(tool, 1, false), 'step-back', `${tool}: Esc after a point steps back`);
  eq(draw.drawEscapeAction(tool, 0, true), 'step-back', `${tool}: height Esc returns to the base`);
  const kind = tool === 'brick' ? 'box' : tool;
  const expected = shapes.defaultPrimitive(kind);
  checks++; assert.ok(expected, `${tool}: default primitive exists`);
  draw.setShapeRequest(null);
  eq(shapes.openShapeDialog(kind), true, `${tool}: dialog opens`);
  checks++; assert.deepEqual(draw.shapeRequest().prim, expected, `${tool}: dialog uses defaultPrimitive on the work plane`);
  eq(draw.shapeRequest().drawn, false, `${tool}: dialog request is not a drawn shape`);
  draw.setShapeRequest(null); // Esc in this dialog only clears its request; it cannot place geometry.
}
eq(draw.drawEscapeAction(null, 0, false), 'none', 'no active tool ignores Esc');
console.log(`check-draw-escape: ${checks} checks passed`);
