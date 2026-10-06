// Hands-on fixes: "Run a Python model" on Start, the Boolean's selection requirements, the Transform
// dialog (live preview, a reason for a disabled OK), and Color… from the right-click menus.
// The real Solid stores, without a DOM or solver.
//
//   node scripts/check-hands-on.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
const modules = ['designer/store.ts', 'designer/booleanUi.ts', 'designer/colors.ts', 'runner/store.ts', 'runner/startPython.ts', 'workspace.ts', 'designer/ColorPopover.tsx'];
const built = await build({
  root, configFile: false, logLevel: 'silent', resolve: { conditions: ['browser'] }, css: { postcss: {} },
  plugins: [solid(), {
    name: 'hands-on-entry',
    resolveId(id) { if (id.endsWith('hands-on-entry')) return '\0hands-on-entry'; },
    load(id) {
      if (id !== '\0hands-on-entry') return;
      return modules.map((path, i) => `export * as m${i} from ${JSON.stringify(`${root}src/${path}`)};`).join('\n');
    },
  }],
  build: { write: false, minify: false, cssCodeSplit: false, lib: { entry: 'hands-on-entry', formats: ['es'] } },
});
const chunk = (Array.isArray(built) ? built[0] : built).output.find((o) => o.type === 'chunk');
const stub = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, querySelector: () => null, getElementById: () => null };
globalThis.window = { ...stub, document: stub };
globalThis.document = stub;
globalThis.requestAnimationFrame = () => 1;
const { m0: store, m1: booleans, m2: colors, m3: runner, m4: start, m5: workspace, m6: popover } =
  await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
const source = (path) => readFileSync(`${root}src/${path}`, 'utf8');

// ---- (a) Run a Python model on Start: only the user's own models have a Run panel
runner.setModels([
  { key: 'dipole', file: 'dipole.py', kind: 'python', readonly: true, model: { id: 'dipole', name: 'Dipole' }, params: [] },
  { key: 'broken', file: 'broken.py', kind: 'python', error: 'boom', readonly: false, params: [] },
  { key: 'x.design', file: 'x.design.json', kind: 'design', readonly: false, model: { id: 'x', name: 'X' }, params: [] },
  { key: 'mine', file: 'mine.py', kind: 'python', readonly: false, model: { id: 'mine', name: 'Mine' }, params: [] },
]);
assert.deepEqual(start.runnablePythonModels().map((m) => m.key), ['mine'], 'bundled, broken and design entries are not runnable from Start');
runner.setModels([{ key: 'dipole', file: 'dipole.py', kind: 'python', readonly: true, model: { id: 'dipole', name: 'Dipole' }, params: [] }]);
workspace.setAppMode('home');
await start.runPythonFromStart();
assert.equal(start.pythonHint(), true, 'no model of the user: Start explains instead of doing nothing');
assert.equal(workspace.appMode(), 'home', 'and stays on Start');
runner.setModels([
  { key: 'blade', file: 'blade.py', kind: 'python', readonly: false, model: { id: 'blade', name: 'Blade' }, params: [] },
  { key: 'mine', file: 'mine.py', kind: 'python', readonly: false, model: { id: 'mine', name: 'Mine' }, params: [] },
]);
start.setPythonHint(false);
await start.runPythonFromStart();
assert.equal(workspace.appMode(), 'home', 'with Python models of the user, the header button opens none of them by itself');
assert.equal(start.pythonHint(), true, 'and Start asks to choose one');
assert.match(source('home/Home.tsx'), /home\.python\.choose/, 'Start shows the choose note');
const toggle = source('runner/RunToggle.tsx');
assert.match(toggle, /appMode\(\) === "home"\) \{ void runPythonFromStart\(\)/, 'the header button uses the Start path');
assert.match(source('home/Home.tsx'), /id="home-python-hint"/, 'Start shows the explanation');

// ---- (b) Boolean: a message for every missing requirement
const design = {
  schema: 'fairbeam.design/1', model: { id: 'check', name: 'Check' }, params: [],
  materials: [{ name: 'copper', kind: 'metal' }],
  parts: [{ name: 'a', material: 'copper', primitives: [{ kind: 'box', start: [0, 0, 0], stop: [4, 4, 4] }] }],
  ports: [], resistors: [], simulation: { f_min: 1, f_max: 2, boundaries: 'MUR' }, mesh: { mode: 'auto', cells_per_wavelength: 20 }, far_field: { enabled: false },
};
store.setDraft(structuredClone(design));
store.setFile({ file: 'check', hash: '1', design });
store.setSelection({ type: 'part', i: 0 });
booleans.setBooleanNotice('');
booleans.armBoolean('subtract');
assert.match(booleans.booleanNotice(), /needs two solids/, 'one solid: the Boolean says it needs a second');
assert.equal(booleans.booleanPending(), null);
store.edit((d) => { d.parts.push({ name: 'b', material: 'copper', primitives: [{ kind: 'box', start: [2, 2, 2], stop: [6, 6, 6] }] }); });
store.setSelection({ type: 'design' });
booleans.armBoolean('subtract');
assert.match(booleans.booleanNotice(), /Select a solid/, 'nothing selected: asks for A');
store.setSelection({ type: 'part', i: 0 });
booleans.armBoolean('subtract');
assert.deepEqual({ ...booleans.booleanPending() }, { a: 0, operation: 'subtract' }, 'A selected: waits for B');
booleans.setBooleanPending(null);
const workspaceSource = source('designer/DesignWorkspace.tsx');
assert.match(workspaceSource, /disabled=\{draft\.parts\.length < 2\}/, 'the ribbon items are disabled with one solid');
assert.match(workspaceSource, /else if \(i >= 0 && !booleanPending\(\)\) setBooleanNotice\(""\)/, 'selecting a solid clears the stale notice');
assert.match(source('designer/ContextMenu.tsx'), /disabled=\{draft\.parts\.length < 2\}/, 'the right-click Boolean items too');

// ---- (c)(d) Transform dialog: live preview and an explicit non-mutating refresh
const dialog = source('designer/dialogs/TransformDialog.tsx');
assert.match(dialog, /createSignal<PreviewState>\("pending"\)/, 'the preview starts pending and is built automatically');
assert.match(dialog, /PREVIEW_DEBOUNCE_MS = 150/, 'debounced about 150 ms');
assert.match(dialog, /setTimeout\(\(\) => untrack/, 'the outline is rebuilt after the pause');
assert.match(dialog, /t\("transform\.preview\.button"\)/, 'Preview is an explicit refresh');
assert.match(dialog, /t\("transform\.preview\.fixFields"\) : problems\(\)\.map\(checkMessage\)\[0\]/, 'inline field errors receive a concise status; other problems retain their explanation');
assert.match(dialog, /disabled=\{!canApply\(\)\}/, 'Apply requires a current, valid preview');
assert.match(dialog, /transform\.uniform/, 'scale has a same-factor-on-all-axes switch');
assert.match(workspaceSource, /ribbon\.transform\.selectFirst/, 'the disabled ribbon Transform says why');

// ---- (e) Color… from the right-click menus: one undo step for a whole component
store.setDraft(structuredClone(design));
store.edit((d) => {
  d.parts = ['p', 'q', 'r'].map((name) => ({ name, material: 'copper', primitives: [{ kind: 'box', start: [0, 0, 0], stop: [1, 1, 1] }] }));
});
const before = store.canUndo();
store.setColors('parts', [0, 2], '#AA3355');
assert.deepEqual(store.draft.parts.map((p) => p.color), ['#aa3355', undefined, '#aa3355']);
store.undo();
assert.deepEqual(store.draft.parts.map((p) => p.color), [undefined, undefined, undefined], 'one undo reverts every solid of the component');
assert.equal(store.canUndo(), before);
popover.setColorRequest(null);
popover.openColor({ kind: 'materials', indices: [0], label: 'copper', x: 1, y: 2 });
assert.equal(popover.colorRequest().kind, 'materials');
popover.setColorRequest(null);
assert.match(colors.themeColor(true), /^#[0-9a-f]{6}$/, 'the default color falls back to a valid one without a DOM');
assert.match(source('designer/ContextMenu.tsx'), /contextMenu\.color/, 'solid menu (also the 3D view menu)');
assert.match(source('designer/NavTree.tsx'), /kind:"parts",indices:parts\(\)/, 'component folder menu sets all its solids');
assert.match(source('designer/NavTree.tsx'), /kind:"materials"/, 'material menu');

// Imported Python stays attached through documentation changes, but never describes edited geometry.
const linkedDesign = { ...structuredClone(design), python_source_model: 'source_model', python_source_hash: 'a'.repeat(64) };
store.setDraft(linkedDesign);
store.setFile({ file: 'linked.design.json', hash: '2', design: linkedDesign });
store.edit((d) => { d.model.name = 'Documented source'; d.model.description = 'Notes only'; });
assert.equal(store.draft.python_source_model, 'source_model', 'renaming/documenting preserves the editable source');
store.edit((d) => { d.parts[0].primitives[0].stop[0] = 9; });
assert.equal(store.draft.python_source_model, undefined, 'geometry edits detach the imported source');
assert.equal(store.draft.python_source_hash, undefined, 'the old source hash is detached too');
store.undo();
assert.equal(store.draft.python_source_model, 'source_model', 'undo restores the source link with its geometry');
assert.equal(store.draft.python_source_hash, 'a'.repeat(64));
store.redo();
assert.equal(store.draft.python_source_model, undefined, 'redo detaches the source again');

console.log('Hands-on fixes: Start Python model, Boolean requirements, Transform live preview, Color… menus and imported source edit/undo lifecycle passed.');
