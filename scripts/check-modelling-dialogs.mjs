// Modelling dialogs (issue #89): WCS-aware defaults for every Shapes button, the dialog's shared
// geometry validation, the zero-height circle wording, the transform dialog's feed note and the
// port dialog's Start → Stop summary. The real Solid stores, without a DOM or solver.
//
//   node scripts/check-modelling-dialogs.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
const modules = ['designer/store.ts', 'designer/draw.ts', 'designer/dialogs/shapes.ts', 'designer/dialogs/TransformDialog.tsx', 'designer/ContextMenu.tsx', 'designer/checks.ts', 'designer/transforms.ts', 'designer/transformModel.ts'];
const built = await build({
  root, configFile: false, logLevel: 'silent', resolve: { conditions: ['browser'] }, css: { postcss: {} },
  plugins: [solid(), {
    name: 'modelling-dialogs-entry',
    resolveId(id) { if (id.endsWith('modelling-dialogs-entry')) return '\0modelling-dialogs-entry'; },
    load(id) {
      if (id !== '\0modelling-dialogs-entry') return;
      return modules.map((path, i) => `export * as m${i} from ${JSON.stringify(`${root}src/${path}`)};`).join('\n');
    },
  }],
  build: { write: false, minify: false, cssCodeSplit: false, lib: { entry: 'modelling-dialogs-entry', formats: ['es'] } },
});
const chunk = (Array.isArray(built) ? built[0] : built).output.find((o) => o.type === 'chunk');
// Solid's event delegation touches the document when the components' modules load.
const stub = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, querySelector: () => null };
globalThis.window = { ...stub, document: stub };
globalThis.document = stub;
globalThis.requestAnimationFrame = () => 1; // the instant preview is not under test
const { m0: store, m1: draw, m2: shapes, m3: transformDialog, m4: contextMenu, m5: checks, m6: transforms, m7: transformModel } =
  await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);

const design = {
  schema: 'fairbeam.design/1', model: { id: 'check', name: 'Check' }, params: [{ key: 'h', default: 1.5 }],
  materials: [{ name: 'copper', kind: 'metal' }],
  parts: [{ name: 'brick', material: 'copper', primitives: [{ kind: 'box', start: [-5, -5, 0], stop: [5, 5, 5] }] }],
  ports: [{ number: 1, type: 'lumped', R: 50, direction: 'z', start: [0, 0, 0], stop: [0, 0, 1] }],
  resistors: [], simulation: { f_min: 1, f_max: 2, boundaries: 'MUR' }, mesh: { mode: 'auto', cells_per_wavelength: 20 }, far_field: { enabled: false },
};
store.setDraft(structuredClone(design));
store.setFile({ file: 'check', hash: '1', design });
const noErrors = (prim) => checks.designChecks({ ...structuredClone(design), parts: [{ name: 'p', material: 'copper', primitives: [prim] }] })
  .filter((c) => c.severity === 'error');

// ---- T14: every Shapes button opens the dialog, with WCS defaults and the selected part
for (const kind of ['box', 'cylinder', 'sphere', 'polygon', 'linpoly', 'cone', 'torus', 'wire']) assert.ok(shapes.DIALOG_KINDS.includes(kind), `${kind} has a dialog`);
const scale = store.designScale();
// The WCS origin carries the elevation: shapes are described in the WCS' own coordinates, the new part keeps the
// transform that places it, so every default sits on the local plane at 0 and follows the normal.
const wcsAt = (normal, k, elevation) => ({ normal, origin: [0, 1, 2].map((i) => (i === k ? elevation : 0)), angle: 0 });
for (const [normal, k] of [['z', 2], ['x', 0], ['y', 1]]) {
  for (const elevation of [15, 'h']) {
    draw.setWcs(wcsAt(normal, k, elevation));
    draw.setHeight(0);
    const cone = shapes.defaultPrimitive('cone');
    assert.equal(cone.axis, normal, `cone axis along the WCS normal ${normal}`);
    assert.deepEqual(cone.center, [0, 0]);
    assert.equal(cone.range[0], 0, `cone starts on the plane (${normal} = ${elevation})`);
    assert.equal(cone.range[1], scale, 'cone length from the design when the WCS height is 0');
    assert.deepEqual(noErrors(cone), [], `default cone (${normal}, ${elevation}) passes the checks`);

    const torus = shapes.defaultPrimitive('torus');
    assert.equal(torus.axis, normal);
    const lift = scale / 20;
    assert.equal(torus.center[k], lift, 'the torus rests on the plane');
    assert.deepEqual(torus.center.filter((_, i) => i !== k), [0, 0], 'the torus is centred on the WCS origin');
    assert.deepEqual(noErrors(torus), [], `default torus (${normal}, ${elevation}) passes the checks`);

    const wire = shapes.defaultPrimitive('wire');
    assert.equal(wire.points.length, 2);
    assert.equal(wire.points[0][k], 0, 'the wire starts on the plane');
    for (const p of wire.points) assert.deepEqual(p.filter((_, i) => i !== k), [0, 0], 'the wire runs along the WCS normal');
    assert.deepEqual(noErrors(wire), [], `default wire (${normal}, ${elevation}) passes the checks`);

    draw.setShapeRequest(null);
    assert.equal(shapes.openShapeDialog('cone'), true);
    const request = draw.shapeRequest();
    assert.equal(request.frameNormal, normal, 'the dialog knows the WCS normal (u, v, w labels)');
    assert.deepEqual(request.frameTransforms, [{ type: 'move', offset: wcsAt(normal, k, elevation).origin }], 'the new part keeps the WCS translation, parameter expression included');
    draw.setShapeRequest(null);
  }
}
draw.setWcs(wcsAt('x', 0, 15));
draw.setHeight(2);
assert.deepEqual(shapes.defaultPrimitive('cone').range, [0, 2], 'a WCS height sets the cone length');
assert.deepEqual(shapes.defaultPrimitive('wire').points.map((p) => p[0]), [0, 2], 'a WCS height sets the wire length');
draw.setHeight(0);
draw.resetWcsToGlobal();

store.setSelection({ type: 'part', i: 0 });
const undoBefore = store.canUndo();
for (const kind of ['cone', 'torus', 'wire']) {
  draw.setShapeRequest(null);
  assert.equal(shapes.openShapeDialog(kind), true, `${kind} opens a dialog`);
  const req = draw.shapeRequest();
  assert.equal(req.into, -1, `${kind} is offered as a NEW solid even with a solid selected`);
  assert.equal(req.drawn, false);
  assert.equal(req.prim.kind, kind);
}
assert.equal(store.draft.parts.length, 1, 'opening the dialogs adds nothing (Cancel creates nothing)');
assert.equal(store.draft.parts[0].primitives.length, 1);
assert.equal(store.canUndo(), undoBefore, 'opening the dialogs records no undo step');
draw.setShapeRequest(null);
store.setSelection({ type: 'design' });
shapes.openShapeDialog('torus');
assert.equal(draw.shapeRequest().into, -1, 'without a selected part the shape goes into a new part');
draw.setShapeRequest(null);

// OK: one edit, the new shape selected, one undo removes it
const torus = shapes.defaultPrimitive('torus');
draw.insertShape(torus, { into: 0 });
assert.equal(store.draft.parts[0].primitives.length, 2);
assert.deepEqual(store.selection(), { type: 'primitive', i: 0, j: 1 }, 'OK selects the new shape');
store.undo();
assert.equal(store.draft.parts[0].primitives.length, 1, 'one undo removes the added shape');
draw.insertShape(shapes.defaultPrimitive('wire'), { into: -1, name: 'wire' });
assert.equal(store.draft.parts.length, 2);
assert.deepEqual(store.selection(), { type: 'primitive', i: 1, j: 0 });
store.undo();
assert.equal(store.draft.parts.length, 1, 'one undo removes the new wire part');

// ---- T15: the dialog refuses what the Checks list would flag, with the shared validator
const line = { kind: 'polygon', normal: 'x', elevation: 15, points: [[-2.5, -2.5], [2.5, -2.5], [0, -2.5]] };
assert.deepEqual(shapes.checkedShapeProblems(line), ['The polygon has zero area (its points are on one line).']);
assert.deepEqual(shapes.checkedShapeProblems({ ...line, kind: 'linpoly', length: 2 }), ['The polygon has zero area (its points are on one line).'], 'extrusions too');
assert.match(shapes.checkedShapeProblems({ kind: 'polygon', normal: 'z', elevation: 0, points: [[0, 0], [2, 2], [2, 0], [0, 2]] })[0], /crosses itself/);
assert.deepEqual(shapes.checkedShapeProblems({ kind: 'polygon', normal: 'z', elevation: 0, points: [[0, 0], [1, 1], [2, 2]] }), ['The polygon has zero area (its points are on one line).'], 'collinear, not just equal rows');
assert.deepEqual(shapes.checkedShapeProblems({ kind: 'polygon', normal: 'z', elevation: 'h', points: [[0, 0], ['h', 0], [0, 'h * 2']] }), [], 'valid expressions pass');
assert.deepEqual(shapes.checkedShapeProblems({ kind: 'linpoly', normal: 'y', elevation: 0, length: 'h', points: [[0, 0], [3, 0], [3, 3], [0, 3]] }), [], 'a valid extrusion passes');
assert.deepEqual(shapes.checkedShapeProblems({ kind: 'polygon', normal: 'z', elevation: 0, points: [[0, 0], ['nope', 0], [0, 1]] }), [], 'values that do not evaluate are left to the dialog message');
assert.match(shapes.checkedShapeProblems({ kind: 'torus', axis: 'z', center: [0, 0, 0], major_radius: 1, minor_radius: 2 })[0], /tube radius/);
assert.match(shapes.checkedShapeProblems({ kind: 'cone', axis: 'z', center: [0, 0], bottom_radius: 0, top_radius: 0, range: [0, 1] })[0], /no volume/);
assert.match(shapes.checkedShapeProblems({ kind: 'wire', points: [[0, 0, 0], [0, 0, 0]], radius: 0.1 })[0], /2 distinct points/);
assert.deepEqual(shapes.checkedShapeProblems({ kind: 'box', start: [0, 0, 0], stop: [0, 0, 0] }), [], 'bricks keep the dialog\'s own messages');
const dialogSource = readFileSync(`${root}src/designer/dialogs/ShapeDialog.tsx`, 'utf8');
assert.match(dialogSource, /checkedShapeProblems\(q\)/, 'ShapeDialog refuses OK on the shared validator');

// ---- #149: ribbon semantics and the narrow icon-only popup/focus behavior
const workspaceSource = readFileSync(`${root}src/designer/DesignWorkspace.tsx`, 'utf8');
const ribbonCss = readFileSync(`${root}src/styles/ribbon.css`, 'utf8');
assert.match(workspaceSource, /role="tablist"[\s\S]*?<\/div>\s*<button class="rb-minimize"/, 'minimize control is outside the tablist');
assert.match(workspaceSource, /<For each=\{RIBBON_TABS\}>\{\(tab\) => <div class="rb" id=\{`rb-panel-\$\{tab\.key\}`\} role="tabpanel"[\s\S]*?hidden=\{ribbonMinimized\(\) \|\| ribbonTab\(\) !== tab\.key\}/, 'tab controls reference mounted hidden panels while minimized');
assert.match(workspaceSource, /onFocusOut=\{\(e\) => \{ const next = e\.relatedTarget as Node \| null; if \(open\(\) && \(!next \|\| !host\.contains\(next\)\)\) setOpen\(false\); \}\}/, 'folded popup closes when focus leaves');
assert.match(ribbonCss, /\.rb-shell \.rb-wcs > \.rb-pop \{ width: min\(320px, calc\(100vw - 32px\)\); max-height: 60dvh; overflow: auto; \}/, 'Boolean and Pick points popups stay within the viewport');
assert.match(ribbonCss, /data-pop-align="start"\] \.rb-wcs > \.rb-pop \{ left: 0; right: auto; \}/, 'leftmost popup groups anchor to the left');
assert.match(workspaceSource, /g\.dataset\.popAlign = g\.getBoundingClientRect\(\)\.left < 340/, 'popup alignment follows the group viewport position');
assert.match(ribbonCss, /data-density="compact"\] \.rb-btn[^\n]*font-size: max\(11px/, 'compact ribbon buttons preserve the 11px floor');
assert.match(ribbonCss, /data-density="compact"\] \.rb-label \{ font-size: 11px/, 'compact ribbon labels preserve the 11px floor');
assert.match(workspaceSource, /Combine size=\{16\} aria-hidden="true" \/><span>\{t\("ribbon\.tools\.boolean"\)\}<\/span>[\s\S]*?aria-pressed=\{extrudeFacePicking\(\)\}[\s\S]*?<ArrowUpFromLine size=\{16\}/, 'Boolean and Extrude face use distinct icons');
const layoutSource = readFileSync(`${root}src/designer/layoutState.ts`, 'utf8');
assert.match(layoutSource, /next \? "\[data-layout-focus='side-strip'\]" : '\[data-action="collapse-properties"\], \.panel-right button'/, 'collapse and expand move focus between the strip and collapse button');

// ---- T16: WCS / Circle wording: at height 0 a circle is a flat sheet (a polygon), not a radius-long cylinder
assert.match(draw.HINTS.cylinder, /at height 0 the circle is a flat sheet/);
// the WCS note is an i18n key: its English text, and the WCS panel shows it
const enText = JSON.parse(readFileSync(`${root}src/i18n/en.json`, 'utf8'));
assert.match(enText['draw.wcs.heightNote'], /a circle too: a flat circle is built as a regular polygon/);
assert.doesNotMatch(enText['draw.wcs.heightNote'], /cannot be a sheet/);
assert.match(readFileSync(`${root}src/designer/DesignWorkspace.tsx`, 'utf8'), /<p class="note">\{t\("draw\.wcs\.heightNote"\)\}<\/p>/);
assert.match(dialogSource, /flatCircle/);
assert.match(enText['shape.radiusLengthNote'], /Zero length .* makes a flat circle: a sheet built as a regular polygon of \{sides\} sides/);

// ---- T17: transforms explain that feeds keep their world coordinates
for (const type of ['move', 'rotate', 'mirror', 'translate']) {
  assert.match(transformDialog.feedNote(type, 0, 0), /stay at their world coordinates\.$/, `${type}: general note`);
  assert.match(transformDialog.feedNote(type, 1, 0), /Reposition the design's 1 port separately if it should follow\./);
}
assert.match(transformDialog.feedNote('rotate', 2, 1), /are not rotated or copied .* 2 ports and 1 resistor separately if they/);
assert.match(transformDialog.feedNote('translate', 1, 0), /are not copied with the shapes/);

// Transform request and ghost are draft-free. One Apply-style edit appends one transform;
// the existing history removes it in a single undo.
store.setDraft(structuredClone(design));
store.setSelection({ type: 'part', i: 0 });
const original = JSON.stringify(store.draft.parts[0]);
const undoAtOpen = store.canUndo();
transforms.openTransform('move', { type: 'part', i: 0 });
assert.equal(transforms.transformRequest().target.i, 0);
assert.equal(JSON.stringify(store.draft.parts[0]), original, 'opening Transform does not commit');
transforms.setPreviewGeometry([{ kind: 'box', start: [1, 0, 0], stop: [2, 1, 1], bbox: [[1, 0, 0], [2, 1, 1]] }]);
assert.equal(JSON.stringify(store.draft.parts[0]), original, 'preview ghost does not commit');
assert.equal(store.canUndo(), undoAtOpen, 'preview adds no undo step');
store.edit((d) => transformModel.applyTransform(d, { type: 'part', i: 0 }, { type: 'move', offset: [1, 0, 0] }));
assert.deepEqual(store.draft.parts[0].transforms, [{ type: 'move', offset: [1, 0, 0] }]);
store.undo();
assert.equal(JSON.stringify(store.draft.parts[0]), original, 'one undo removes the committed transform');
transforms.setPreviewGeometry([]);
transforms.setTransformRequest(null);
const transformSource = readFileSync(`${root}src/designer/dialogs/TransformDialog.tsx`, 'utf8');
assert.match(transformSource, /const baseline = JSON\.parse\(JSON\.stringify\(draft\)\) as Design/,
  'the preview baseline is captured when the dialog opens');
assert.match(transformSource, /transformPreview\(baseline, target\(\), transform\(\)\)/,
  'every preview is derived from the open-time baseline');
assert.match(transformSource, /result\?\.parts\.flatMap\(\(p\) => p\.primitives\)/,
  'the preview includes geometry from every component member');
assert.match(transformSource, /onClick=\{previewNow\}[\s\S]*?transform\.preview\.button/,
  'Preview refreshes the outline without submitting the form');
assert.match(transformSource, /disabled=\{!canApply\(\)\}/, 'Apply waits for a current, valid preview');
assert.doesNotMatch(transformSource, /t\("common\.ok"\)/, 'the old Apply + OK action pair is gone');
assert.match(transformSource, /edit\(\(d\) => \{\s*i = applyTransform\(d, target\(\), transform\(\)\);\s*\}\);\s*setSelection\(\{ type: "part", i \}\);\s*props\.onClose\(\);/,
  'Apply commits once, selects the first transformed member, and closes');

// Component previews stay based on the same baseline, even when requested repeatedly. Applying
// one shared scale updates every captured member with one store edit and one undo restores all.
{
  const componentDesign = structuredClone(design);
  componentDesign.parts[0].component = 'antenna/feed';
  componentDesign.parts[0].transforms = [{ type: 'move', offset: [1, 0, 0] }];
  componentDesign.parts.push({ ...structuredClone(componentDesign.parts[0]), name: 'reflector', transforms: [] });
  componentDesign.parts.push({ ...structuredClone(componentDesign.parts[0]), name: 'unrelated', component: 'other', transforms: [] });
  const target = { type: 'component', indices: [0, 1], name: 'antenna/feed' };
  const scale = { type: 'scale', factors: [2, 2, 2], origin: [0, 0, 0] };
  const baselineText = JSON.stringify(componentDesign);
  const first = transformModel.transformPreview(componentDesign, target, scale);
  const repeated = transformModel.transformPreview(componentDesign, target, scale);
  assert.deepEqual(first.parts.map((p) => p.transforms.length), [2, 1], 'the shared transform follows each member’s own prior history');
  assert.deepEqual(repeated.parts, first.parts, 'repeated preview requests do not compound the scale');
  assert.equal(JSON.stringify(componentDesign), baselineText, 'building a component preview does not mutate its baseline');
  assert.deepEqual(first.parts.map((p) => p.name), ['brick', 'reflector'], 'only captured members are previewed');

  store.setDraft(structuredClone(componentDesign));
  store.setFile({ file: 'component-check', hash: '2', design: componentDesign });
  const before = JSON.stringify(store.draft);
  store.edit((d) => transformModel.applyTransform(d, target, scale));
  assert.deepEqual(store.draft.parts.map((p) => p.transforms?.length), [2, 1, 0], 'one Apply appends to every component member');
  store.undo();
  assert.equal(JSON.stringify(store.draft), before, 'one undo restores all members of the component');
}

// ---- T24: the port summary follows Start → Stop
const fmt = (v) => String(Number(v.toPrecision(6)));
const summary = contextMenu.portSummary(0, { here: 'Patch', target: 'Ground plane', axis: 'z', ends: [[0, 0, 0], [0, 0, 1.524]], stubLength: 0.5, fmt });
assert.equal(summary, 'Start on Ground plane → stop on Patch (z 0 → 1.524 mm).');
const stubText = contextMenu.portSummary('stub', { here: 'Patch', target: '', axis: 'z', ends: [[0, 0, 1.524], [0, 0, 2.024]], stubLength: 0.5, fmt });
assert.match(stubText, /^Starts on Patch \(z 1\.524 mm\) and stops 0\.5 mm out of it \(z 2\.024 mm\): no second conductor/);
assert.match(contextMenu.portSummary('custom', { here: 'Patch', target: '', axis: 'z', ends: [[0, 0, 0], [0, 0, 1]], stubLength: 0.5, fmt }), /start and the stop each touch a conductor/);

// ---- a new shape starts as a metal: the metal used last in this design, else the first metal, else a new one
{
  const mats = [{ name: 'FR4', kind: 'dielectric' }, { name: 'copper', kind: 'metal' }, { name: 'silver', kind: 'metal' }];
  assert.equal(shapes.pickShapeMaterial(mats, undefined, 'NEW'), 'copper', 'the first metal, not the dielectric listed before it');
  assert.equal(shapes.pickShapeMaterial(mats, 'silver', 'NEW'), 'silver', 'the metal used last');
  assert.equal(shapes.pickShapeMaterial(mats, 'FR4', 'NEW'), 'copper', 'a dielectric used last is not a default');
  assert.equal(shapes.pickShapeMaterial(mats, 'gone', 'NEW'), 'copper', 'a material that no longer exists: the first metal');
  assert.equal(shapes.pickShapeMaterial([{ name: 'FR4', kind: 'dielectric' }], undefined, 'NEW'), 'NEW', 'no metal: a new one');
}

// ---- drawn and dialog shapes: a NEW solid in the design's metal, whatever is selected
{
  store.setDraft(structuredClone({ ...design, materials: [{ name: 'FR4', kind: 'dielectric', eps_r: 4.3 }, { name: 'copper', kind: 'metal' }, { name: 'silver', kind: 'metal' }] }));
  store.setFile({ file: 'check', hash: '1', design });
  draw.resetWcsToGlobal();
  draw.setHeight(0);
  store.setSelection({ type: 'part', i: 0 });
  const before = store.draft.parts.length;
  draw.setConfirmShapes(false);
  draw.startTool('brick');
  draw.place(0, 0); draw.place(3, 2);
  draw.finishHeight(1);
  assert.equal(store.draft.parts.length, before + 1, 'a drawn brick is a new solid, not part of the selected one');
  assert.equal(store.draft.parts[0].primitives.length, 1, 'the selected solid keeps its shapes');
  assert.equal(store.draft.parts.at(-1).material, 'copper', 'drawn: the first metal, not the dielectric listed first');
  // the metal used last is the next default, from the dialog and from drawing alike
  draw.insertShape(shapes.defaultPrimitive('sphere'), { into: -1, name: 'ball', material: 'silver' });
  assert.equal(shapes.defaultShapeMaterial('NEW'), 'silver', 'the dialog starts with the metal used last');
  draw.startTool('cylinder');
  draw.place(0, 0); draw.place(1, 0);
  draw.finishHeight(1);
  assert.equal(store.draft.parts.at(-1).material, 'silver', 'drawn: the metal used last');
  draw.startTool(null);
  // a design without a metal gets a new copper (the default is never a dielectric)
  store.setDraft(structuredClone({ ...design, materials: [{ name: 'FR4', kind: 'dielectric', eps_r: 4.3 }], parts: [] }));
  draw.insertShape(shapes.defaultPrimitive('box'), { into: -1 });
  assert.deepEqual(store.draft.materials.map((m) => [m.name, m.kind]), [['FR4', 'dielectric'], ['copper', 'metal']]);
  assert.equal(store.draft.parts[0].material, 'copper');
  store.setDraft(structuredClone(design));
}

console.log('Modelling dialogs: WCS defaults, insert/undo, validation, Transform preview/commit/undo, circle height, feed note and port summary passed.');
