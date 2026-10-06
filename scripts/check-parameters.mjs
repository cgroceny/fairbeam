// Load the designer store before run effects: this order used to trigger a circular-import TDZ.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
const built = await build({
  root, configFile: false, logLevel: 'silent', resolve: { conditions: ['browser'] },
  plugins: [{
    name: 'parameters-check-entry',
    resolveId(id) { if (id.endsWith('parameters-check-entry')) return '\0parameters-check-entry'; },
    load(id) {
      if (id !== '\0parameters-check-entry') return;
      return ['designer/store', 'runner/designRun', 'designer/dockState'].map((path, i) =>
        `export * as m${i} from ${JSON.stringify(`${root}src/${path}.ts`)};`).join('\n');
    },
  }],
  build: { write: false, minify: false, lib: { entry: 'parameters-check-entry', formats: ['es'] } },
});
const code = (Array.isArray(built) ? built[0] : built).output[0].code;
const { m0: store, m1: run, m2: dock } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
assert.equal(store.file(), null);
assert.equal(run.designDockTab, dock.designDockTab);
dock.openParametersTab();
assert.equal(run.designDockTab(), 'parameters');
const frames = [];
globalThis.requestAnimationFrame = (fn) => frames.push(fn);
dock.setDesignDockTab('checks');
store.focusPath('params[2].min');
assert.equal(dock.designDockTab(), 'parameters');
assert.equal(dock.parameterRanges(), true);
assert.deepEqual(store.selection(), { type: 'param', i: 2 });
let focused = false;
globalThis.document = { getElementById: (id) => {
  assert.equal(id, store.fieldId('params[2].min'));
  return { parentElement: null, scrollIntoView() {}, focus() { focused = true; } };
} };
frames.shift()();
assert.equal(focused, true);
console.log('parameters: store-first initialization, shared dock hook and range field focus passed');
