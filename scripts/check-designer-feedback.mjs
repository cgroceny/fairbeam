// Designer feedback regressions with the real Solid stores,
// without a DOM or solver: component folders (rename, ungroup, delete, one undo step each), the
// tree's "Add a lumped port" start (boundsPortTarget), framing a new port or resistor, and a
// ribbon geometry tab taking a result drawn in the 3D view off it. Plus source contracts for the
// wiring the browser run checks by hand (menus, F2, the ribbon).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
const built = await build({
  root, configFile: false, logLevel: 'silent', resolve: { conditions: ['browser'] },
  plugins: [{
    name: 'feedback-entry',
    resolveId(id) { if (id.endsWith('feedback-entry')) return '\0feedback-entry'; },
    load(id) {
      if (id !== '\0feedback-entry') return;
      return ['designer/store', 'designer/componentOps', 'designer/context', 'designer/resultFocus', 'workspace', 'runner/store', 'designer/portPlacement'].map((path, i) =>
        `export * as m${i} from ${JSON.stringify(`${root}src/${path}.ts`)};`).join('\n');
    },
  }],
  build: { write: false, minify: false, lib: { entry: 'feedback-entry', formats: ['es'] } },
});
const code = (Array.isArray(built) ? built[0] : built).output[0].code;
const { m0: store, m1: ops, m2: context, m3: focus, m4: workspace, m5: runner, m6: placement } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };

// ------------------------------------------------------------------ #2 components: pure path rules
eq(ops.inComponent('antenna/feed', 'antenna'), true, 'a subfolder is inside its parent');
eq(ops.inComponent('antennas', 'antenna'), false, 'a prefix of a name is not a parent');
eq(ops.inComponent(undefined, 'antenna'), false, 'top-level parts are in no folder');
eq(ops.inComponent('antenna', ''), false, 'the top level is not a folder');
eq(ops.renamedComponent('antenna/feed/pin', 'antenna/feed', 'probe'), 'antenna/probe/pin', 'rename keeps the parent and the rest');
eq(ops.renamedComponent('antenna', 'antenna', ' radiator '), 'radiator', 'rename trims');
eq(ops.renamedComponent('antenna', 'antenna', 'a/b'), 'a b', 'a slash does not add a level');
eq(ops.renamedComponent('ground', 'antenna', 'x'), 'ground', 'other folders are left alone');
eq(ops.ungroupedComponent('antenna/feed', 'antenna/feed'), 'antenna', 'ungroup moves the parts up one level');
eq(ops.ungroupedComponent('antenna/feed/pin', 'antenna/feed'), 'antenna/pin', 'subfolders move up with them');
eq(ops.ungroupedComponent('antenna', 'antenna'), '', 'ungrouping a top folder puts its parts at the top level');
eq(ops.componentMembers([{ component: 'a' }, {}, { component: 'a/b' }, { component: 'ab' }], 'a'), [0, 2], 'members include subfolders only');

// ------------------------------------------------------------------ #2 components on the design (undoable)
const design = {
  schema: 'fairbeam.design/1', model: { id: 'feedback', name: 'Feedback' }, params: [],
  materials: [{ name: 'copper', kind: 'metal' }, { name: 'fr4', kind: 'dielectric', eps_r: 4.3 }],
  parts: [
    { name: 'ground', material: 'copper', component: 'board', primitives: [{ kind: 'box', start: [-40, -40, 0], stop: [40, 40, 0] }] },
    { name: 'substrate', material: 'fr4', component: 'board', primitives: [{ kind: 'box', start: [-40, -40, 0], stop: [40, 40, 1.6] }] },
    { name: 'patch', material: 'copper', component: 'antenna/radiator', primitives: [{ kind: 'box', start: [-15, -12, 1.6], stop: [15, 12, 1.6] }] },
    { name: 'wire', material: 'copper', primitives: [{ kind: 'box', start: [60, 0, 5], stop: [61, 1, 5] }] },
  ],
  ports: [], resistors: [], simulation: { f_min: 1, f_max: 3, boundaries: 'MUR' }, mesh: {}, far_field: { enabled: false },
};
const events = [];
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.window = { dispatchEvent: (event) => events.push(event) };
store.setDraft(structuredClone(design));
store.setFile({ id: 'feedback', file: 'feedback', hash: '1', design });
workspace.setAppMode('design');
runner.setPreviewActive(true);
const components = () => store.draft.parts.map((p) => p.component ?? '');

eq(ops.renameComponent('antenna', 'radiating'), 'radiating', 'rename returns the new path');
eq(components(), ['board', 'board', 'radiating/radiator', ''], 'the folder and its subfolders are renamed');
ok(/Renamed component antenna to radiating/.test(store.message()?.text ?? ''), 'rename says what happened');
store.undo();
eq(components(), ['board', 'board', 'antenna/radiator', ''], 'one undo step restores the names');
eq(ops.renameComponent('antenna/radiator', 'board'), 'antenna/board', 'a subfolder renames in place');
store.undo();
eq(ops.renameComponent('antenna', 'antenna'), null, 'the same name changes nothing');
eq(ops.renameComponent('missing', 'x'), null, 'an unknown folder changes nothing');
ops.renameComponent('antenna/radiator', 'x');
store.undo();
ops.renameComponent('antenna', 'board');
eq(components(), ['board', 'board', 'board/radiator', ''], 'renaming onto an existing folder merges');
ok(/merged/.test(store.message()?.text ?? ''), 'a merge is announced');
store.undo();

ops.ungroupComponent('antenna/radiator');
eq(components(), ['board', 'board', 'antenna', ''], 'ungroup: the patch moves to antenna');
store.undo();
ops.ungroupComponent('board');
eq(components(), ['', '', 'antenna/radiator', ''], 'ungroup at the top: parts to the top level');
eq(store.draft.parts.filter((p) => 'component' in p).length, 1, 'no empty component strings are left behind');
store.undo();

store.setSelection({ type: 'part', i: 2 });
ops.deleteComponent('board');
eq(store.draft.parts.map((p) => p.name), ['patch', 'wire'], 'delete removes every part of the folder');
eq(store.selection(), { type: 'part', i: 0 }, 'the selected part keeps its selection after the parts before it went');
ok(/Deleted component board and its 2 solids/.test(store.message()?.text ?? ''), 'delete names what went');
store.undo();
eq(store.draft.parts.map((p) => p.name), ['ground', 'substrate', 'patch', 'wire'], 'one undo brings the parts back');
store.setSelection({ type: 'primitive', i: 0, j: 0 });
ops.deleteComponent('board');
eq(store.selection(), { type: 'design' }, 'a selection inside the deleted folder goes to the design');
store.undo();

// ------------------------------------------------------------------ #2 "Add a lumped port" from the tree
const t = context.boundsPortTarget(2);
eq(t.fromBounds, true, 'the start is marked as a face centre');
eq(t.point, [0, 0, 1.6], 'the patch face centre');
eq(t.normal, [0, 0, -1], 'facing the ground plane below');
eq(t.targets.map((x) => [x.part, x.side, +x.distance.toFixed(6)]), [['ground', 'behind', 1.6]], 'the ground plane is offered, not the dielectric');
eq(t.targets[0].point, [0, 0, 0], 'the other end on the ground plane, straight below');
const g = context.boundsPortTarget(0);
eq([g.normal, g.targets.map((x) => x.part)], [[0, 0, 1], ['patch']], 'from the ground plane the patch is in front');
eq(context.boundsPortTarget(1), null, 'no port on a dielectric');
const lone = context.boundsPortTarget(3);
eq([lone.normal, lone.targets.length], [[0, 0, 1], 0], 'no metal across the face: a stub along +axis');

// ------------------------------------------------------------------ #1 a new port or resistor is framed
events.length = 0;
store.addPort();
eq(store.draft.ports.length, 0, 'opening create-port does not mutate the model');
eq(store.feedCreation(), 'lumped', 'the deliberate discrete-port form opens');
eq(events.length, 0, 'opening the form does not move the camera');
store.createFeed({ type: 'lumped', number: 1, R: 50, start: [0, 0, 0], stop: [0, 0, 1.6], direction: 'z' });
eq(store.feedCreation(), null, 'successful Create closes the form');
eq(store.selection(), { type: 'port', i: 0 }, 'the new port is selected');
eq(events.length, 1, 'one frame request for the new port');
eq(events[0].type, 'fairbeam:frame-added', 'the viewport event');
eq(store.draft.ports[0].start, [0, 0, 0], 'the new port starts on the ground plane');
eq(store.draft.ports[0].stop, [0, 0, 1.6], 'and ends on the patch: across the gap, not floating');
eq(events[0].detail.bounds, [[-15, -12, 0], [15, 12, 1.6]], 'framed with the smallest metal it touches (the patch)');
eq(events[0].detail.label, 'port 1', 'the announcement names the port');
store.setSelection({ type: 'part', i: 2 });
store.addPort();
store.createFeed({ type: 'lumped', number: 2, R: 50, start: [0, 0, 0], stop: [0, 0, 1.6], direction: 'z' });
eq([store.draft.ports[1].start, store.draft.ports[1].stop, store.draft.ports[1].direction], [[0, 0, 0], [0, 0, 1.6], 'z'], 'a selected patch: across its gap to the ground plane');
store.undo();
store.setSelection({ type: 'part', i: 1 });
store.addPort();
store.createFeed({ type: 'lumped', number: 2, R: 50, start: [0, 0, 0], stop: [0, 0, 1.6], direction: 'z' });
eq(store.draft.ports[1].stop, [0, 0, 1.6], 'a dielectric selected: the nearest gap of the design');
store.undo();
events.length = 1;
const B = (a, b) => [a, b];
eq(placement.portPlacement([B([0, 0, 0], [10, 10, 0]), B([2, 2, 1], [8, 8, 1])]), { start: [5, 5, 0], stop: [5, 5, 1], direction: 'z' }, 'two stacked sheets: across the gap at the centre of the overlap');
eq(placement.portPlacement([B([0, 0, 0], [10, 10, 0]), B([20, 0, 0], [30, 10, 0])]), { start: [10, 5, 0], stop: [20, 5, 0], direction: 'x' }, 'side by side: across the gap along x');
eq(placement.portPlacement([B([0, 0, 0], [10, 10, 0]), B([20, 0, 5], [30, 10, 5])], 1), { start: [10, 5, 5], stop: [20, 5, 5], direction: 'x' }, 'no metal across: from the anchor edge to the nearest metal');
eq(placement.portPlacement([B([0, 0, 0], [10, 10, 0])]), null, 'one metal part: the old default stays');
eq(placement.portPlacement([]), null, 'no metal: the old default stays');
eq(placement.portPlacement([B([0, 0, 0], [10, 10, 1]), B([5, 5, 0.5], [8, 8, 2])]), null, 'overlapping metal has no gap');
store.setSelection({ type: 'port', i: 0 });
store.addResistor();
eq(store.draft.resistors.length, 0, 'opening the element form does not install a default resistor');
eq(store.feedCreation(), 'element', 'the element configuration form opens');
store.setFeedCreation(null);
eq(store.draft.resistors.length, 0, 'cancel leaves no element');
store.addResistor();
store.createFeed({ C: 1e-12, start: [0, 0, 0], stop: [0, 1, 0], direction: 'y' });
eq(store.draft.resistors[0].R, undefined, 'capacitor-only load is preserved');
eq(events.length, 2, 'a new resistor is framed too');
store.setSelection({ type: 'port', i: 0 });
store.duplicateSelected();
eq(events.length, 3, 'a duplicated port is framed');
store.setDraft('ports', 0, 'stop', [0, 0, 2]);
eq(events.length, 3, 'editing does not move the camera');
workspace.setAppMode('results');
store.addWaveguidePort();
eq(store.feedCreation(), 'waveguide', 'waveguide action opens setup');
store.setFeedCreation(null);
eq(events.length, 3, 'nothing is framed outside the designer');
workspace.setAppMode('design');

// ------------------------------------------------------------------ #3 design and results views stay apart
focus.focusResult({ file: 'run.json', view: 'pattern3d', f: 2.4e9 });
eq(focus.leaveResultsFor('post'), false, 'Post-processing keeps the pattern');
eq(focus.resultFocus()?.view, 'pattern3d', 'still shown');
eq(focus.leaveResultsFor('model'), true, 'a geometry tab clears it');
eq(focus.resultFocus(), null, 'back to the geometry');
focus.focusResult({ file: 'run.json', view: 'currents', f: 2.4e9 });
focus.leaveResultsFor('home');
eq(focus.resultFocus(), null, 'surface currents go too');
focus.focusResult({ file: 'run.json', view: 'sparams' });
eq(focus.leaveResultsFor('model'), false, 'a result tab of the main area is a separate document and stays');
focus.focusResult(null);

// ------------------------------------------------------------------ banners belong to their moment
// a success banner clears on the next unrelated selection change or edit, an error banner on the next
// edit (the fixed expression), a "Duplicated ..." banner on undo; an action's own selection change or
// edit (the same task) leaves the banner it just showed
{
  const later = () => new Promise((resolve) => setTimeout(resolve, 0));
  store.setSelection({ type: 'design' });
  store.setMessage({ tone: 'good', text: 'Done.' });
  store.setSelection({ type: 'part', i: 0 });
  ok(store.message()?.text === 'Done.', 'the action that shows a banner may change the selection after it');
  await later();
  store.setSelection({ type: 'part', i: 1 });
  eq(store.message(), null, 'a success banner clears when the selection changes later');
  store.setMessage({ tone: 'warn', text: 'Careful.' });
  await later();
  store.setSelection({ type: 'design' });
  ok(store.message()?.text === 'Careful.', 'a warning stays until it is dealt with');
  store.setMessage(null);
  store.setMessage({ tone: 'critical', text: 'The expression is not valid.' });
  store.edit((d) => { d.model.name = 'Fixed'; }, 'model.name');
  ok(store.message()?.text === 'The expression is not valid.', 'the action that shows an error may edit after it');
  await later();
  store.edit((d) => { d.model.name = 'Fixed again'; }, 'model.name');
  eq(store.message(), null, 'an error banner clears at the next edit');
  store.edit((d) => { d.model.name = 'Copy'; }, 'model.name');
  store.setMessage({ tone: 'good', text: 'Duplicated the shape.' });
  await later();
  store.undo();
  eq(store.message(), null, 'the Duplicated banner clears after undo');
  store.undo();
  store.undo();
}

// ------------------------------------------------------------------ source contracts (the wiring)
const src = (path) => readFileSync(`${root}src/${path}`, 'utf8');
const workspaceSrc = src('designer/DesignWorkspace.tsx');
const choose = workspaceSrc.slice(workspaceSrc.indexOf('function chooseTab'), workspaceSrc.indexOf('export function resetRibbonLayout'));
ok(/leaveResultsFor\(t\)/.test(choose), 'choosing a ribbon tab leaves a result drawn in 3D');
const tree = src('designer/NavTree.tsx');
// the menu labels are translated keys: the tree calls t("key"), en.json holds the English
const enText = JSON.parse(src('i18n/en.json'));
for (const [key, label] of [['tree.menu.renameComponent', 'Rename component ('], ['tree.menu.ungroupComponent', 'Ungroup component'], ['tree.menu.deleteComponent', 'Delete component and ']]) {
  const text = enText[key];
  ok(tree.includes(`t("${key}"`) && [text].flat().flatMap((v) => typeof v === 'string' ? [v] : Object.values(v)).some((v) => v.startsWith(label)), `folder menu: ${label}`);
}
ok(/openContext\(\{selection:a\.sel,trigger,x,y,\.\.\.boundsPortTarget\(a\.sel\.i\)\}\)/.test(tree), 'the tree menu starts a port on the part face');
ok(/matchesShortcut\("rename", e\) && r\.action\.kind === "folder"/.test(tree), 'F2 renames a focused folder');
ok(/aria-haspopup=\{geometry \|\| a\.kind === "folder"/.test(tree), 'folder rows announce their menu');
const menu = src('designer/ContextMenu.tsx');
ok(/selectAddedFeed\(\{ type: "port", i: draft\.ports\.length - 1 \}\); props\.close\(\)/.test(menu), 'a port from the menu is framed');
ok(/\.\.\.boundsPortTarget\(i\)/.test(src('scene/Viewport.tsx')), 'the menu key in the 3D view offers a port too');

console.log(`check-designer-feedback: ${checks} checks passed (components, tree port start, framing new feeds, design/results separation, banners).`);
process.exit(0);
