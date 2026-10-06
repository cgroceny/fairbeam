// Run context checks (#87): the Examples' "Run again" loads the SELECTED result's model and
// parameters (also when the Run panel already edits that model with another result's values), the
// toolbar and Start entry points keep their behavior, and the app-wide file drop ignores drags that
// carry no files (a navigation-tree part) while a real file drop still opens once. Bundles the real
// browser stores in memory, like check-start.mjs, so Solid uses its browser signals.
//
//   node scripts/check-run-context.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
const built = await build({
  root, configFile: false, logLevel: 'silent', resolve: { conditions: ['browser'] },
  plugins: [{
    name: 'run-context-entry',
    resolveId(id) { if (id.endsWith('run-context-entry')) return '\0run-context-entry'; },
    load(id) {
      if (id !== '\0run-context-entry') return;
      return ['runner/store', 'state', 'workspace', 'runner/api', 'lib/fileDrop', 'runner/examples'].map((path, i) =>
        `export * as m${i} from ${JSON.stringify(`${root}src/${path}.ts`)};`).join('\n');
    },
  }],
  build: { write: false, minify: false, lib: { entry: 'run-context-entry', formats: ['es'] } },
});
const code = (Array.isArray(built) ? built[0] : built).output[0].code;
const { m0: runner, m1: state, m2: workspace, m3: { api }, m4: drop, m5: examples } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const src = (path) => readFileSync(`${root}${path}`, 'utf8');
const fixture = (file) => JSON.parse(src(`public/projects/${file}.json`));
let checks = 0;
const ok = (fn) => { fn(); checks++; };

// ------------------------------------------------------------------ Run again (review 02-01)
const it3 = fixture('sierpinski-monopole--iterations-3');
const it0 = fixture('sierpinski-monopole--iterations-0');
const dipole = fixture('dipole');
const entry = (key, b) => ({ key, kind: 'python', readonly: true, model: b.model, params: b.model.params.map((p) => ({
  key: p.key, default: p.default, minimum: null, maximum: null,
  type: typeof p.default === 'string' ? 'str' : typeof p.default === 'boolean' ? 'bool' : p.key === 'iterations' ? 'int' : 'float',
})) });
runner.setModels([entry('dipole', dipole), entry('sierpinski_monopole', it3)]);
runner.setServerState('online');
let previews = 0;
api.preview = async (key) => { previews++; return { bundle: { ...structuredClone(key === 'dipole' ? dipole : it3), preview: true } }; };
workspace.setAppMode('results');

// what ModelPanel's "Run again" does: the model of the selected result, with that result
const runAgain = async () => {
  const b = state.bundle();
  const m = examples.exampleSourceFor(runner.models(), b.model.id) ?? examples.designFor(runner.models(), b.model.id);
  assert.ok(m, 'the selected result has a model to run again');
  await runner.openRunPanelFrom(m.key, b);
};
const form = () => ({ key: runner.modelKey(), iterations: runner.values.iterations, height: runner.values.height });

state.openBundle(it3, 'sierpinski-monopole--iterations-3.json');
await runAgain();
ok(() => assert.deepEqual(form(), { key: 'sierpinski_monopole', iterations: '3', height: '48' }, 'iterations=3: Run again loads 3'));
ok(() => assert.equal(runner.runOpen(), true));
// the review's step 2: the panel stays open, the project picker selects iterations=0, Run again
state.openBundle(it0, 'sierpinski-monopole--iterations-0.json');
await runAgain();
ok(() => assert.deepEqual(form(), { key: 'sierpinski_monopole', iterations: '0', height: '48' }, 'iterations=0 after 3: Run again loads 0'));
state.openBundle(it3, 'sierpinski-monopole--iterations-3.json');
await runAgain();
ok(() => assert.equal(runner.values.iterations, '3', 'and back: 3 after 0'));
ok(() => assert.equal(state.bundle().model.params.find((p) => p.key === 'iterations').value, 3, 'the result stays on screen'));
ok(() => assert.equal(previews, 0, 'Run again shows the result itself, no preview'));
ok(() => assert.equal(runner.previewActive(), false));
ok(() => assert.equal(runner.paramPayload().iterations, 3, "a run would submit the selected result's iterations"));

// in-progress edits survive a normal close/reopen of the Run panel (the toolbar path) ...
runner.setValue('height', '50');
runner.closeRunPanel();
await runner.openRunPanel();
ok(() => assert.deepEqual(form(), { key: 'sierpinski_monopole', iterations: '3', height: '50' }, 'toolbar reopen keeps edits'));
// ... also when another result of the same model is displayed: only Run again refreshes
state.openBundle(it0, 'sierpinski-monopole--iterations-0.json');
runner.closeRunPanel();
await runner.openRunPanel();
ok(() => assert.deepEqual(form(), { key: 'sierpinski_monopole', iterations: '3', height: '50' }, 'toolbar keeps the same-model form'));
await runAgain();
ok(() => assert.deepEqual(form(), { key: 'sierpinski_monopole', iterations: '0', height: '48' }, 'explicit Run again refreshes'));

// the toolbar still infers from the displayed result when the form edits another model
runner.selectModel('dipole');
state.openBundle(it3, 'sierpinski-monopole--iterations-3.json');
await runner.openRunPanel();
ok(() => assert.deepEqual(form(), { key: 'sierpinski_monopole', iterations: '3', height: '48' }, 'toolbar follows the displayed result'));
ok(() => assert.equal(previews, 0));

// an explicit Start pick previews that model with defaults, whatever is displayed
await runner.openRunPanel('dipole');
ok(() => assert.equal(runner.modelKey(), 'dipole', 'Start pick wins'));
ok(() => assert.equal(previews, 1, 'Start pick previews'));
ok(() => assert.equal(state.bundle().model.id, dipole.model.id));
runner.restoreProject();
ok(() => assert.equal(state.bundle().model.id, it3.model.id, 'closing the preview restores the result'));
runner.invalidatePreview();

// the entry points stay wired: Examples has no Run action; the designer
// header keeps #85's Run dialog for an open design (review 11-01, regression only); Start passes its pick
const panel = src('src/components/ModelPanel.tsx');
ok(() => assert.doesNotMatch(panel, /openRunPanelFrom|Run again|openRunPanel\(/, 'Examples has no Run action'));
const toggle = src('src/runner/RunToggle.tsx');
ok(() => assert.match(toggle, /appMode\(\) === "design" && designFile\(\)\) \{ setRunOpen\(false\); setRunDialogOpen\(true\); return; \}/,
  'designer header Run opens the design Run dialog (#85) and keeps the design preview (#117)'));
ok(() => assert.match(src('src/runner/startPython.ts'), /await openRunPanel\(key\)/, 'Start passes its pick'));

// ------------------------------------------------------------------ file drops (review 03-01)
const PART_DRAG = src('src/designer/NavTree.tsx').match(/const PART_DRAG = "([^"]+)"/)[1];
ok(() => assert.equal(PART_DRAG, 'application/x-fairbeam-part'));
const event = (types, files = []) => {
  const e = { dataTransfer: { types, files }, prevented: false, preventDefault() { this.prevented = true; } };
  e.currentTarget = e.target = {};
  return e;
};
let dragging = false;
const opened = [];
const h = drop.fileDropHandlers((on) => { dragging = on; }, (f) => opened.push(f.name));

// a dragged link is cancelled outside text fields (the browser would navigate away), with no hint
{
  const over = event(['text/uri-list', 'text/plain']);
  h.onDragOver(over);
  ok(() => assert.equal(dragging, false, 'link: no drop hint'));
  ok(() => assert.equal(over.prevented, true, 'link: dragover accepted so the drop can be cancelled'));
  const d = event(['text/uri-list', 'text/plain']);
  h.onDrop(d);
  ok(() => assert.equal(d.prevented, true, 'link: navigation cancelled'));
}
for (const types of [[PART_DRAG], ['text/plain'], []]) {
  const label = types.join(',') || 'no types';
  const over = event(types);
  h.onDragOver(over);
  ok(() => assert.equal(dragging, false, `${label}: no drop hint`));
  ok(() => assert.equal(over.prevented, false, `${label}: dragover left to its target`));
  const d = event(types);
  h.onDrop(d);
  ok(() => assert.equal(d.prevented, false, `${label}: drop left to its target`));
}
ok(() => assert.deepEqual(opened, [], 'internal and text drags open nothing'));
ok(() => assert.equal(drop.carriesFiles(null), false));

for (const name of ['bundle.json', 'measured.s1p']) {
  const file = new File(['{}'], name);
  const over = event(['Files'], [file]);
  h.onDragOver(over);
  ok(() => assert.equal(dragging, true, `${name}: drop hint`));
  ok(() => assert.equal(over.prevented, true, `${name}: accepted`));
  const d = event(['Files'], [file]);
  h.onDrop(d);
  ok(() => assert.equal(dragging, false, `${name}: hint gone after the drop`));
  ok(() => assert.equal(d.prevented, true));
}
ok(() => assert.deepEqual(opened, ['bundle.json', 'measured.s1p'], 'each real file drop opens exactly once'));
h.onDragOver(event(['Files']));
h.onDragLeave(event(['Files']));
ok(() => assert.equal(dragging, false, 'leaving the window hides the hint'));

// App wires the helper (no inline catch-all dragover) and routes bundles vs reference data
const app = src('src/App.tsx');
ok(() => assert.match(app, /fileDropHandlers\(setDragging, \(f\) => \(\/\\\.json\$\/i\.test\(f\.name\) \? openUserProject\(f\) : importReferenceFile\(f\)\)\)/));
ok(() => assert.match(app, /onDragOver=\{drop\.onDragOver\}/));
ok(() => assert.match(app, /onDrop=\{drop\.onDrop\}/));

console.log(`Run context checks passed (${checks}): Run again 3 -> 0 -> 3 loads the selected result, edits kept on reopen, toolbar inference and Start pick unchanged, #85 header path wired; tree/text drags ignored by the file layer, real file drops open once.`);
