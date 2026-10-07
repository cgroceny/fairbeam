// The work coordinate system (WCS): four actions (align with a face, transform, align with global,
// show), u/v/w naming while a local WCS is active, exit of the drawing mode after a finished shape, and
// the WCS saved with the design. No DOM or solver:
//   node scripts/check-wcs.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { build } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
const modules = ['designer/store.ts', 'designer/draw.ts', 'designer/localFrame.ts'];
const built = await build({
  root, configFile: false, logLevel: 'silent', resolve: { conditions: ['browser'] }, css: { postcss: {} },
  plugins: [solid(), {
    name: 'wcs-entry', resolveId(id) { if (id.endsWith('wcs-entry')) return '\0wcs-entry'; },
    load(id) { if (id === '\0wcs-entry') return modules.map((p, i) => `export * as m${i} from ${JSON.stringify(`${root}src/${p}`)};`).join('\n'); },
  }],
  build: { write: false, minify: false, cssCodeSplit: false, lib: { entry: 'wcs-entry', formats: ['es'] } },
});
const chunk = (Array.isArray(built) ? built[0] : built).output.find((o) => o.type === 'chunk');
const stub = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, querySelector: () => null };
globalThis.window = { ...stub, document: stub }; globalThis.document = stub; globalThis.requestAnimationFrame = () => 1;
const { m0: store, m1: draw, m2: frame } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);

let checks = 0;
const eq = (got, want, message) => { checks++; assert.deepEqual(got, want, message); };
const ok = (value, message) => { checks++; assert.ok(value, message); };
const AXES = ['x', 'y', 'z'];

// ------------------------------------------------------------------ orientations: all 24, exact
const unit = (axis, sign = 1) => [0, 1, 2].map((i) => (i === axis ? sign : 0));
const matmul = (a, b) => a.map((row) => [0, 1, 2].map((j) => row.reduce((sum, x, k) => sum + x * b[k][j], 0)));
// basis [u, v, w] as a matrix with u, v, w as columns
const asMatrix = ([u, v, w]) => [0, 1, 2].map((r) => [u[r], v[r], w[r]]);
const fromMatrix = (m) => [0, 1, 2].map((c) => [m[0][c], m[1][c], m[2][c]]);
const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
// right-handed rotation about local axis a by q quarter turns, as a matrix in the WCS' own coordinates
const localRotation = (a, q) => {
  const [c, s] = [[1, 0], [0, 1], [-1, 0], [0, -1]][((q % 4) + 4) % 4];
  if (a === 'u') return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (a === 'v') return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
};
const seen = new Set();
const all = [];
for (const normal of AXES) for (const flip of [false, true]) for (const angle of [0, 90, 180, 270]) {
  const basis = frame.frameBasis(normal, { angle, flip });
  const matrix = asMatrix(basis);
  eq(det(matrix), 1, `${normal}/${angle}/${flip ? 'flip' : 'plain'} is a proper rotation`);
  seen.add(JSON.stringify(basis));
  all.push({ normal, angle, flip, basis });
  eq(frame.orientationOfBasis(basis), { normal, angle, flip }, 'orientationOfBasis inverts frameBasis');
  eq(basis[2], unit(AXES.indexOf(normal), flip ? -1 : 1), 'w is the normal axis, negative when flipped');
}
eq(seen.size, 24, 'the 24 axis-aligned proper rotations are all distinct and all reachable');
eq(frame.frameBasis('z', { angle: 0 }), [[1, 0, 0], [0, 1, 0], [0, 0, 1]], 'global: u, v, w are x, y, z');
for (const { normal, angle, flip, basis } of all) for (const about of ['u', 'v', 'w']) for (const q of [-1, 1, 2, 3, 4]) {
  const next = frame.rotateOrientation(normal, { angle, flip }, about, q);
  ok(next, `rotating ${normal}/${angle}/${flip} about ${about} by ${q * 90} stays axis aligned`);
  const expected = fromMatrix(matmul(asMatrix(basis), localRotation(about, q)));
  eq(frame.frameBasis(next.normal, next), expected, `rotation about own ${about} by ${q * 90}: new axes = old axes composed with the turn`);
}
// the common moves from the global WCS
const from = (about, q) => { const r = frame.rotateOrientation('z', { angle: 0 }, about, q); return frame.frameBasis(r.normal, r); };
eq(from('w', 1), [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], 'rotate 90 about w: u = y, v = -x');
eq(from('u', -1), [[1, 0, 0], [0, 0, -1], [0, 1, 0]], 'rotate -90 about u: w = +y (a front plane)');
eq(from('u', 1)[2], [0, -1, 0], 'rotate +90 about u: w = -y (a flipped frame)');
eq(from('v', 1)[2], [1, 0, 0], 'rotate +90 about v: w = +x');
eq(frame.rotateOrientation('z', { angle: 0 }, 'u', 4), { normal: 'z', angle: 0, flip: false }, 'a full turn is the identity');
eq(frame.wcsAxisName('z', 'z'), 'w', 'z is w on the xy plane'); eq(frame.wcsAxisName('x', 'z'), 'u', 'x is u on the xy plane');
eq(frame.wcsAxisName('y', 'x', true), 'U', 'y is u on the yz plane (uppercase on request)'); eq(frame.wcsAxisName('x', 'x'), 'w', 'x is w on the yz plane');

// ------------------------------------------------------------------ moving along u, v, w keeps expressions
eq(frame.moveOrigin([0, 0, 0], 'z', { angle: 0 }, [1, 2, 3]), [1, 2, 3], 'move along u, v, w of the global WCS');
eq(frame.moveOrigin([0, 0, 'h'], 'z', { angle: 90 }, [1, 0, 'a']), [0, 1, 'h + a'], 'a turned WCS: u is y; parameter expressions stay');
eq(frame.moveOrigin([0, 0, 0], 'z', { angle: 0, flip: true }, [0, 0, 'h']), [0, 0, '-(h)'], 'a flipped WCS: w is -z');

// ------------------------------------------------------------------ Transform WCS: move first, then u, v, w turns
const globalWcs = { normal: 'z', origin: [0, 0, 0], angle: 0 };
const names = { h: 1.5 };
eq(frame.transformedWcs(globalWcs, [1, 2, 3], [0, 0, 0], names), { wcs: { normal: 'z', origin: [1, 2, 3], angle: 0 } }, 'move only');
const turned = frame.transformedWcs(globalWcs, [1, 0, 0], [0, 0, 90], names).wcs;
eq([turned.angle, turned.origin], [90, [1, 0, 0]], 'the move uses the axes before the turns');
eq(frame.transformedWcs(globalWcs, [0, 0, 0], [0, 0, 45], names), { error: 'angle' }, 'only quarter turns');
eq(frame.transformedWcs(globalWcs, ['nope', 0, 0], [0, 0, 0], names), { error: 'value' }, 'an unknown name is refused');
eq(frame.transformedWcs(globalWcs, [0, 0, 0], ['h', 0, 0], { h: 90 }), frame.transformedWcs(globalWcs, [0, 0, 0], [90, 0, 0], {}), 'a turn given as an expression equals the typed number');
const stepped = frame.transformedWcs(globalWcs, [0, 0, 0], [90, 90, 0], {}).wcs; // about u, then about the new v
eq(frame.frameBasis(stepped.normal, stepped), (() => {
  const m = matmul(matmul(asMatrix(frame.frameBasis('z', { angle: 0 })), localRotation('u', 1)), localRotation('v', 1));
  return fromMatrix(m);
})(), 'turns apply in order u, v, w, each about the axes the previous turn left');

// ------------------------------------------------------------------ the WCS in the design file
const design = {
  schema: 'fairbeam.design/1', model: { id: 'wcs', name: 'WCS' }, params: [{ key: 'h', default: 1.6 }],
  materials: [{ name: 'copper', kind: 'metal' }, { name: 'FR4', kind: 'dielectric', eps_r: 4.3 }],
  parts: [{ name: 'sub', material: 'FR4', primitives: [{ kind: 'box', start: [-20, -10, 0], stop: [20, 10, 'h'] }] }],
  ports: [], resistors: [], simulation: { f_min: 1, f_max: 2, boundaries: 'MUR' }, mesh: { mode: 'auto', cells_per_wavelength: 20 }, far_field: { enabled: false },
};
store.setDraft(structuredClone(design)); store.setFile({ file: 'wcs', hash: '1', design }); store.setSelection({ type: 'design' });
draw.setConfirmShapes(true);
ok(draw.wcsIsGlobal(), 'a design without a WCS (every design saved before this) opens with the global WCS');
eq(draw.plane().normal, 'z', 'global: the xy plane'); eq(draw.axisName('x'), 'x', 'global: x, y, z as before'); eq(draw.axisName('z', true), 'Z', 'global: uppercase x, y, z');
ok(!('wcs' in JSON.parse(JSON.stringify(store.draft))), 'the global WCS adds nothing to the file');

// Align with face: the top of the substrate, then a side face
const top = { part: 'sub', axis: 2, sign: 1, value: 1.6, centre: [0, 0, 1.6], tris: [] };
draw.alignWcsWithFace(top);
eq(JSON.parse(JSON.stringify(store.draft.wcs)), { normal: 'z', origin: [0, 0, 'h'], angle: 0 }, 'top face: origin at the face centre, w = +z, the face height keeps its expression');
ok(!draw.wcsIsGlobal(), 'a WCS on the top face is local'); eq(draw.axisName('x'), 'u', 'local: x is u'); eq(draw.axisName('z'), 'w', 'local: z is w');
eq(draw.worldToWcs([3, 4, 1.6 + 2]), [3, 4, 2], 'the status bar readout: u, v, w of a world point');
ok(store.dirty(), 'the WCS makes the design unsaved');
const stored = JSON.parse(JSON.stringify(store.draft));
const side = { part: 'sub', axis: 0, sign: -1, value: -20, centre: [-20, 0, 0.8], tris: [] };
draw.alignWcsWithFace(side);
eq(JSON.parse(JSON.stringify(store.draft.wcs)), { normal: 'x', origin: [-20, 0, 0.8], angle: 0, flip: true }, 'x-min face: w = -x');
eq(frame.frameBasis(draw.plane().normal, draw.localFrame()).map((v) => v.join()), ['0,1,0', '0,0,-1', '-1,0,0'].map((s) => s), 'side face basis: u = y, v = -z, w = -x');
eq(draw.worldToWcs([-25, 3, 0.8]).map((x) => x + 0), [3, 0, 5], 'w measures out of the face');
// Esc / undo: one step each
store.undo(); eq(JSON.parse(JSON.stringify(store.draft.wcs)), stored.wcs, 'undo restores the previous WCS');
store.redo(); eq(draw.plane().normal, 'x', 'redo brings the side-face WCS back');
// every face reads naturally: u along +x (+y on faces looking along x), v completes a right-handed set
for (const [axis, sign, u, v, w] of [[1, -1, [1, 0, 0], [0, 0, 1], [0, -1, 0]], [1, 1, [1, 0, 0], [0, 0, -1], [0, 1, 0]], [2, -1, [1, 0, 0], [0, -1, 0], [0, 0, -1]],
  [0, 1, [0, 1, 0], [0, 0, 1], [1, 0, 0]], [2, 1, [1, 0, 0], [0, 1, 0], [0, 0, 1]]]) {
  draw.alignWcsWithFace({ part: 'sub', axis, sign, value: 0, centre: [0, 0, 0], tris: [] });
  eq(frame.frameBasis(draw.plane().normal, draw.localFrame()), [u, v, w], `face ${sign > 0 ? '+' : '-'}${AXES[axis]}: u, v, w = ${[u, v, w].map((a) => a.join()).join(' | ')}`);
}
draw.alignWcsWithFace(side);

// save and reopen: the WCS travels with the design and the draft built from the saved text has it
const saved = JSON.parse(JSON.stringify(store.draft));
store.setDraft(structuredClone(design)); store.setFile({ file: 'wcs', hash: '2', design: saved });
store.setDraft(structuredClone(saved));
eq(JSON.parse(JSON.stringify(store.draft.wcs)), saved.wcs, 'a reopened design keeps its WCS');
ok(!store.dirty(), 'a reopened design with a WCS is not unsaved');
eq([draw.plane().normal, draw.localFrame().flip, draw.localFrame().origin], ['x', true, [-20, 0, 0.8]], 'the drawing tools use the stored WCS');
// the Python side accepts and ignores it
{
  const python = process.env.FAIRBEAM_PYTHON ?? (process.platform === 'win32'
    ? (existsSync(join(root, '.venv', 'Scripts', 'python.exe')) ? join(root, '.venv', 'Scripts', 'python.exe') : 'python')
    : (existsSync(join(root, '.venv', 'bin', 'python')) ? join(root, '.venv', 'bin', 'python') : 'python3'));
  const code = 'import json,sys,types\nfrom pathlib import Path\npkg=types.ModuleType("fairbeam")\npkg.__path__=[str(Path(sys.argv[1])/"python"/"fairbeam")]\nsys.modules.setdefault("fairbeam",pkg)\nfrom fairbeam.design import check_design,resolve_names,resolve_parts\nd=json.load(sys.stdin)\ncheck_design(d)\nprint(len(resolve_parts(d,resolve_names(d,{}))))';
  const r = spawnSync(python, ['-c', code, root], { input: JSON.stringify(saved), encoding: 'utf8', env: { ...process.env, PYTHONPATH: [join(root, 'python'), process.env.PYTHONPATH].filter(Boolean).join(delimiter) } });
  eq([r.status, r.stdout.trim()], [0, '1'], `the server accepts a design that stores a WCS (${r.stderr})`);
}

// Align with global
draw.resetWcsToGlobal();
ok(draw.wcsIsGlobal(), 'Align with global'); ok(!('wcs' in JSON.parse(JSON.stringify(store.draft))), 'the file has no WCS again'); eq(draw.axisName('y'), 'y', 'x, y, z again');

// ------------------------------------------------------------------ the drawing mode ends with the shape
const shape = { brick: [[0, 0], [4, 3]], cylinder: [[0, 0], [2, 0]], polygon: [[0, 0], [3, 0], [0, 3]] };
for (const confirm of [true, false]) for (const tool of ['brick', 'cylinder', 'polygon']) for (const local of [false, true]) {
  store.setDraft(structuredClone(design)); store.setFile({ file: 'wcs', hash: '1', design }); store.setSelection({ type: 'design' });
  draw.setConfirmShapes(confirm); draw.setShapeRequest(null);
  if (local) draw.alignWcsWithFace(top); else draw.resetWcsToGlobal();
  draw.startTool(tool);
  for (const [u, v] of shape[tool]) draw.place(u, v);
  if (tool === 'polygon') draw.commit();
  eq(draw.tool(), tool, `${tool}: still drawing until the height step is confirmed`);
  ok(draw.heightStep(), `${tool}: the height step`);
  draw.finishHeight(1);
  const label = `${tool}, confirm ${confirm ? 'on' : 'off'}, ${local ? 'local' : 'global'} WCS`;
  eq(draw.tool(), null, `${label}: the mode is left when the shape is finished`);
  eq([draw.heightStep(), draw.points()], [false, []], `${label}: nothing is left half drawn`);
  if (confirm) {
    ok(draw.shapeRequest()?.drawn, `${label}: the dialog opens for the finished shape`);
    eq(!!draw.shapeRequest().frameNormal, local, `${label}: the dialog knows about a local WCS (u, v, w)`);
    draw.setShapeRequest(null);
  } else {
    eq(store.draft.parts.length, 2, `${label}: the new part is added at once`);
    eq(store.selection(), { type: 'primitive', i: 1, j: 0 }, `${label}: and selected`);
    eq(!!store.draft.parts[1].transforms?.length, local, `${label}: it carries the WCS transform only in a local WCS`);
  }
}
// Esc still cancels a shape in progress without leaving a half shape behind
store.setDraft(structuredClone(design)); store.setFile({ file: 'wcs', hash: '1', design });
draw.setConfirmShapes(true); draw.resetWcsToGlobal();
draw.startTool('brick'); draw.place(0, 0); draw.cancel(); eq(draw.points(), [], 'Esc removes the first corner'); eq(draw.tool(), 'brick', 'Esc steps back first'); draw.cancel(); eq(draw.tool(), null, 'a second Esc leaves the mode');

// ------------------------------------------------------------------ the surfaces that must follow the WCS
const src = (file) => readFileSync(join(root, 'src', file), 'utf8');
const ribbon = src('designer/DesignWorkspace.tsx');
const group = ribbon.slice(ribbon.indexOf('<RGroup label={t("ribbon.wcs.group")}'), ribbon.indexOf('<RGroup label={t("ribbon.materials.group")}'));
eq([...group.matchAll(/<RButton /g)].length, 4, 'the WCS group is four buttons');
for (const key of ['ribbon.wcs.face', 'ribbon.wcs.transform', 'ribbon.wcs.global', 'ribbon.wcs.show']) ok(group.includes(`t("${key}")`), `the WCS group has ${key}`);
ok(!/function WcsPanel|LocalFrameControls/.test(ribbon) && !existsSync(join(root, 'src/designer/LocalFrameControls.tsx')), 'the old WCS panel and local-frame form are gone');
ok(/resetWcsToGlobal/.test(src('designer/StatusBar.tsx')) && /status\.wcs\.local/.test(src('designer/StatusBar.tsx')), 'the status bar has a Local WCS badge that resets');
ok(/worldToWcs/.test(src('designer/StatusBar.tsx')) && /worldToWcs/.test(src('scene/Viewport.tsx')), 'the cursor readouts show u, v, w in a local WCS');
ok(/\["u", "v", "w"\]/.test(src('scene/Viewport.tsx')) && /frameBasis/.test(src('scene/Viewport.tsx')), 'the axes gizmo is labelled u, v, w along the WCS axes');
ok(/labelSprite\(names3\[k\]/.test(src('scene/drawOverlay.ts')), 'the work-plane grid and the WCS arrows are labelled u, v, w');
ok(/wcsAxisName/.test(src('designer/dialogs/ShapeDialog.tsx')), 'the shape dialogs name their axes u, v, w');
ok(/axisName\(a\)/.test(src('scene/drawOverlay.ts')), 'the drawing readout and typed-coordinate prompt name the axes u, v');
ok(/startTool\(null\);\s*const frameInfo/.test(src('designer/draw.ts')), 'a finished shape leaves the drawing mode (and drops its points)');

console.log(`check-wcs: ${checks} checks passed`);
