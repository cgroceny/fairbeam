// Exercise check navigation with the real Solid stores, without a DOM or solver.
import assert from 'node:assert/strict';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
const built = await build({
  root, configFile: false, logLevel: 'silent', resolve: { conditions: ['browser'] },
  plugins: [{
    name: 'check-focus-entry',
    resolveId(id) { if (id.endsWith('check-focus-entry')) return '\0check-focus-entry'; },
    load(id) {
      if (id !== '\0check-focus-entry') return;
      return ['designer/store', 'state', 'workspace', 'runner/store'].map((path, i) =>
        `export * as m${i} from ${JSON.stringify(`${root}src/${path}.ts`)};`).join('\n');
    },
  }],
  build: { write: false, minify: false, lib: { entry: 'check-focus-entry', formats: ['es'] } },
});
const code = (Array.isArray(built) ? built[0] : built).output[0].code;
const { m0: store, m1: state, m2: workspace, m3: runner } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const design = {
  schema: 'fairbeam.design/1', model: { id: 'check', name: 'Check' }, params: [],
  materials: [{ name: 'copper', kind: 'metal' }],
  parts: [
    { name: 'sheet', material: 'copper', primitives: [{ kind: 'box', start: [0, 0, 0], stop: [10, 20, 0] }] },
    { name: 'bad', material: 'copper', primitives: [{ kind: 'sphere', center: [0, 0, 0], radius: 'unknown' }] },
  ],
  ports: [{ number: 1, type: 'lumped', R: 50, direction: 'z', start: [2, 3, 0], stop: [2, 3, 1] }],
  resistors: [], simulation: { f_min: 1, f_max: 2, boundaries: 'MUR' }, mesh: {}, far_field: { enabled: false },
};
store.setDraft(design);
store.setFile({ file: 'check', hash: '1', design });
workspace.setAppMode('design');
runner.setPreviewActive(true);
const frames = [], events = [];
globalThis.requestAnimationFrame = (fn) => frames.push(fn);
globalThis.window = { dispatchEvent: (event) => events.push(event) };
state.setCenterView('drawing');
state.setHiddenParts('sheet', true);
store.focusPath('parts[0].primitives[0].stop[2]', { frame: true, focus: false });
assert.equal(state.centerView(), '3d');
assert.equal(store.highlightedPart(), 'sheet');
assert.equal(state.hiddenParts.sheet, false);
assert.equal(events.length, 0, 'wait for the viewport to mount after leaving Drawing');
assert.equal(frames.length, 1);
frames.shift()();
assert.deepEqual(events[0].detail.bounds, [[0, 0, 0], [10, 20, 0]], 'unrelated invalid geometry must not prevent fitting a sheet');
assert.equal(events[0].detail.reason, 'check');
store.focusPath('ports[0].start', { frame: true, focus: false });
frames.shift()();
assert.deepEqual(store.selection(), { type: 'port', i: 0 });
// The camera shows the port with the conductor it touches (#92); the selection outline stays exact.
assert.deepEqual(events[1].detail.bounds, [[0, 0, 0], [10, 20, 1]]);
assert.deepEqual(store.selectionBounds({ type: 'port', i: 0 }), [[2, 3, 0], [2, 3, 1]]);
store.setDraft('ports', 0, 'stop', [2, 3, 2]);
assert.equal(frames.length, 0, 'editing after a check click must not move the camera again');
assert.equal(events.length, 2);
store.focusPath('parts[1].primitives[0].radius', { frame: true, focus: false });
assert.equal(frames.length, 0, 'unresolved geometry must not send non-finite bounds');
assert.equal(store.selectionBounds({ type: 'simulation' }), null);

// A probe feed between a ground plane and a patch frames the patch (the smallest metal it touches),
// not the whole ground and not the dielectric; a feed touching no metal keeps its own box.
store.setDraft({
  ...design,
  materials: [{ name: 'copper', kind: 'metal' }, { name: 'fr4', kind: 'dielectric', epsilon: 4.3 }],
  parts: [
    { name: 'ground', material: 'copper', primitives: [{ kind: 'box', start: [-40, -40, 0], stop: [40, 40, 0] }] },
    { name: 'substrate', material: 'fr4', primitives: [{ kind: 'box', start: [-40, -40, 0], stop: [40, 40, 1.6] }] },
    { name: 'patch', material: 'copper', primitives: [{ kind: 'box', start: [-15, -12, 1.6], stop: [15, 12, 1.6] }] },
  ],
  ports: [
    { number: 1, type: 'lumped', R: 50, direction: 'z', start: [5, 0, 0], stop: [5, 0, 1.6] },
    { number: 2, type: 'lumped', R: 50, direction: 'z', start: [60, 0, 5], stop: [60, 0, 6] },
  ],
});
store.focusPath('ports[0].start', { frame: true, focus: false });
frames.shift()();
assert.deepEqual(events.at(-1).detail.bounds, [[-15, -12, 0], [15, 12, 1.6]], 'feed framed with its patch');
assert.deepEqual(store.selectionBounds({ type: 'port', i: 0 }), [[5, 0, 0], [5, 0, 1.6]], 'exact port selection bounds');
store.focusPath('ports[1].start', { frame: true, focus: false });
frames.shift()();
assert.deepEqual(events.at(-1).detail.bounds, [[60, 0, 5], [60, 0, 6]], 'no touching metal: the port alone');
assert.equal(frames.length, 0, 'one frame request per check click');

// Source contract for the keyboard/screen-reader parts of #92 (the browser run checks behaviour):
// each custom radio group takes the shared arrow keys and is one Tab stop (a roving tabindex on
// every radio); a check row names its severity in text; the dock tab and status bar count notes.
const { readFileSync } = await import('node:fs');
const src = (path) => readFileSync(`${root}src/${path}`, 'utf8');
for (const [file, label] of [['components/Header.tsx', 'Screen'], ['editor/NewModelDialog.tsx', 'Model kind'], ['designer/DesignPane.tsx', 'Port type']]) {
  const text = src(file);
  // the label is a literal or a translated key (t("…")) whose English text is `label`
  const en = JSON.parse(src('i18n/en.json'));
  const hit = [...text.matchAll(/role="radiogroup" aria-label=(?:"([^"]*)"|\{t\("([^"]+)"\)\})/g)]
    .find((m) => m[1] === label || (m[2] !== undefined && en[m[2]] === label));
  const at = hit ? hit.index : -1;
  assert.ok(at >= 0, `${file}: ${label} group`);
  const group = text.slice(at, text.indexOf('</div>', at));
  assert.match(group.slice(0, group.indexOf('>')), /onKeyDown=\{radioGroupKeys\}/, `${label}: arrow keys`);
  const radios = group.split('role="radio"').slice(1);
  assert.ok(radios.length >= 2 && radios.every((r) => /^[^>]*tabindex=\{/.test(r)), `${label}: roving tabindex on every radio`);
}
// severity words and the notes count are translated keys (src/i18n/en.json has the English)
const enText = JSON.parse(src('i18n/en.json'));
assert.match(src('designer/DesignPane.tsx'), /<span class="visually-hidden">\{t\(SEVERITY\[c\.severity\]\)\}: <\/span>/, 'check rows name their severity');
assert.match(src('designer/DesignPane.tsx'), /info: "props\.checks\.severity\.info"/, 'the info severity has its own word');
assert.equal(enText['props.checks.severity.info'], 'Note', 'the info severity reads Note');
assert.match(src('designer/RunDock.tsx'), /t\("status\.checks\.notes", \{ count: notes\(\) \}\)/, 'Checks tab counts notes');
assert.deepEqual(enText['status.checks.notes'], { one: '{count} note', other: '{count} notes' }, 'notes are counted in words');
assert.match(src('designer/StatusBar.tsx'), /severity === "info"/, 'status bar counts notes');
console.log('Check focus: sheet and port selection, isolated bounds, feed context framing, reveal, Drawing switch, one-shot frame, radio groups and severity names passed.');
