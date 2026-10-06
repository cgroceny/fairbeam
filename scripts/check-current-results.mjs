// Current results (issue #90): the Post-processing Currents action is offered only for a run with
// surface-current maps, and each stored map names the one driven port of the run that recorded it.
// Covers fields.port validation and its export/import round trip, the legacy fallback (the single
// port flagged `excite`, else unknown, never port 1) and the ribbon's routing with the real Solid
// stores. No DOM or solver.
//
//   node scripts/check-current-results.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
const modules = ['lib/validate.ts', 'scene/fields.ts', 'designer/navModel.ts', 'designer/ribbonResults.ts',
  'designer/resultFocus.ts', 'workspace.ts', 'runner/designRun.ts', 'designer/mainTabsState.ts', 'designer/layoutState.ts'];
const built = await build({
  root, configFile: false, logLevel: 'silent', resolve: { conditions: ['browser'] }, css: { postcss: {} },
  plugins: [solid(), {
    name: 'current-results-entry',
    resolveId(id) { if (id.endsWith('current-results-entry')) return '\0current-results-entry'; },
    load(id) {
      if (id !== '\0current-results-entry') return;
      return modules.map((path, i) => `export * as m${i} from ${JSON.stringify(`${root}src/${path}`)};`).join('\n');
    },
  }],
  build: { write: false, minify: false, cssCodeSplit: false, lib: { entry: 'current-results-entry', formats: ['es'] } },
});
const chunk = (Array.isArray(built) ? built[0] : built).output.find((o) => o.type === 'chunk');
const stub = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, querySelector: () => null, documentElement: {} };
const storage = new Map();
globalThis.window = { ...stub, document: stub, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
globalThis.document = stub;
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
globalThis.requestAnimationFrame = () => 1;
globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) }); // no run server
const { m0: validate, m1: fields, m2: navModel, m3: ribbon, m4: focus, m5: workspace, m6: designRun, m7: mainTabs, m8: layout } =
  await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);

const read = (f) => JSON.parse(readFileSync(`${root}public/projects/${f}`, 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const patch = read('patch-antenna.json');     // single port, surface currents without fields.port (legacy)
const array = read('patch-array-2x1.json');   // two ports, no surface currents
assert.ok(patch.fields?.planes?.length && patch.fields.port === undefined, 'fixture: legacy patch bundle with maps');
assert.ok(!array.fields && array.ports.length === 2, 'fixture: two-port bundle without maps');

// ---- 1. fields.port is validated, survives the package's project.json round trip, legacy stays readable
{
  const b = clone(array);
  b.fields = { ...clone(patch.fields), port: 2 };
  const v = validate.validateBundle(b);
  assert.ok(v.bundle, 'bundle with fields.port validates');
  assert.equal(v.bundle.fields.port, 2);
  const again = validate.validateBundle(JSON.parse(JSON.stringify(v.bundle))); // export → import
  assert.equal(again.bundle.fields.port, 2, 'fields.port survives export/import');
  assert.deepEqual(again.warnings.filter((w) => w.includes('Surface-current')), []);

  for (const bad of [0, -1, 1.5, '2', null]) {
    const c = clone(b);
    c.fields.port = bad;
    const w = validate.validateBundle(c);
    assert.ok(w.bundle?.fields, `invalid fields.port ${JSON.stringify(bad)} keeps the maps`);
    assert.equal(w.bundle.fields.port, undefined, `invalid fields.port ${JSON.stringify(bad)} is dropped, not kept or turned into 1`);
    assert.ok(w.warnings.some((x) => x.includes('driven port')), `invalid fields.port ${JSON.stringify(bad)} is reported`);
  }

  const legacy = validate.validateBundle(clone(patch));
  assert.ok(legacy.bundle?.fields?.planes.length, 'legacy bundle keeps its maps');
  assert.equal(legacy.bundle.fields.port, undefined);

  const empty = clone(patch);
  empty.fields.planes.forEach((pl) => { pl.frequencies = []; });
  assert.equal(validate.validateBundle(empty).bundle.fields, undefined, 'maps without any frequency are no current result');
  const dropped = clone(patch);
  dropped.fields.planes.forEach((pl) => { pl.nu += 1; });
  const d = validate.validateBundle(dropped);
  assert.equal(d.bundle.fields, undefined, 'all planes dropped: no current result');
  assert.ok(d.warnings.some((x) => x.includes('Surface-current plane')));
}

// ---- 2. the legend's excitation: recorded, legacy single excited port, otherwise unknown
{
  const ex = (b) => fields.fieldExcitation(validate.validateBundle(b).bundle);
  const recorded = clone(array);
  recorded.fields = { ...clone(patch.fields), port: 2 };
  assert.deepEqual(ex(recorded), { port: 2, text: 'Port 2 driven, other ports terminated' }, 'multiport, port 2 recorded');
  const three = clone(patch);
  three.ports[0].number = 3;
  three.fields.port = 3;
  assert.deepEqual(ex(three), { port: 3, text: 'Port 3 driven' }, 'single port numbered 3');

  // older bundles: `ports` is the recording build's (a multi-port run's first excited port only)
  assert.deepEqual(ex(clone(patch)), { port: 1, text: 'Port 1 driven' }, 'legacy single-port bundle');
  const legacyArray = clone(array);
  legacyArray.fields = clone(patch.fields);
  legacyArray.ports[0].excite = false;
  legacyArray.ports[1].excite = true;
  assert.equal(ex(legacyArray).port, 2, 'legacy multiport bundle: the one excited port of the recording build');
  for (const flags of [[true, true], [false, false]]) {
    const u = clone(legacyArray);
    u.ports.forEach((p, i) => { p.excite = flags[i]; });
    assert.deepEqual(ex(u), { port: null, text: 'Driven port unknown (not recorded in this result)' }, `legacy ${flags}: unknown, not port 1`);
  }
}

// ---- 3. Currents is available only with maps, with a reason otherwise
{
  const a = ribbon.currentsAvailability;
  assert.equal(a(null).ok, false, 'a run still being read offers no Currents');
  const none = a(navModel.runContent(array));
  assert.equal(none.ok, false, 'a run without maps offers no Currents');
  assert.match(none.reason, /no surface-current maps.*Monitors/);
  const some = a(navModel.runContent(patch));
  assert.equal(some.ok, true);
  assert.match(some.reason, /1 frequency/);
}

// ---- 4. routing: the ribbon never focuses the current view of a run without maps; its plots open
// as main-area tabs (src/designer/MainArea.tsx), the dock follows with its Runs tab (the result views
// are no dock tabs any more) without opening a collapsed dock
{
  workspace.setAppMode('design');
  designRun.setDesignResult({ file: 'array.json', bundle: validate.validateBundle(clone(array)).bundle });
  layout.setBottomDockCollapsed(true);
  assert.equal(ribbon.ribbonCurrents().ok, false);
  ribbon.openRibbonResult('currents');
  assert.equal(focus.resultFocus(), null, 'Currents on a run without maps changes nothing');
  ribbon.openRibbonResult('sparams');
  assert.equal(focus.resultFocus()?.view, 'sparams');
  assert.deepEqual(mainTabs.mainTabs(), { open: ['sparams'], active: 'sparams' }, 'the ribbon opens the S-parameters as a main-area tab');
  assert.equal(designRun.designDockTab(), 'runs', 'the dock shows the Runs tab for a main-area result');
  assert.equal(layout.bottomDockCollapsed(), true, 'a main-area result does not open a collapsed dock');
  ribbon.openRibbonResult('currents');
  assert.equal(focus.resultFocus()?.view, 'sparams', 'Currents keeps the focused S-parameters of a run without maps');
  assert.equal(designRun.designDockTab(), 'runs', 'the refused Currents leaves the dock on the runs');
  assert.equal(mainTabs.mainTabs().active, 'sparams', 'the refused Currents leaves the result tab in front');

  focus.focusResult(null);
  designRun.setDesignResult({ file: 'patch.json', bundle: validate.validateBundle(clone(patch)).bundle });
  assert.equal(ribbon.ribbonCurrents().ok, true);
  ribbon.openRibbonResult('currents');
  assert.deepEqual(focus.resultFocus(), { file: 'patch.json', view: 'currents' }, 'Currents opens the run with maps');
  assert.equal(designRun.designDockTab(), 'runs');
  assert.equal(mainTabs.mainTabs().active, '3d', 'the surface currents bring the 3D view to the front');

  // the 3D pattern: offered for a run with far fields only, toggled on (3D in front) and off again
  const withFf = clone(patch);
  assert.ok(withFf.results.farfield.length, 'fixture: patch bundle with far fields');
  focus.focusResult(null);
  designRun.setDesignResult({ file: 'patch.json', bundle: validate.validateBundle(withFf).bundle });
  mainTabs.activateMainTab('sparams');
  assert.equal(ribbon.ribbonPattern3d().ok, true, 'a run with far fields offers the 3D pattern');
  ribbon.openRibbonResult('pattern3d');
  assert.equal(focus.resultFocus()?.view, 'pattern3d', 'the ribbon shows the 3D pattern');
  assert.equal(focus.resultFocus()?.f, withFf.results.farfield[0].f, 'at the first far-field frequency');
  assert.equal(mainTabs.mainTabs().active, '3d', 'the 3D pattern brings the 3D view to the front');
  ribbon.openRibbonResult('pattern3d');
  assert.equal(focus.resultFocus(), null, 'the same button turns the 3D pattern off (back to the geometry)');
  designRun.setDesignResult({ file: 'array.json', bundle: validate.validateBundle(clone(array)).bundle });
  const noFf = clone(array); noFf.results.farfield = [];
  designRun.setDesignResult({ file: 'nf.json', bundle: validate.validateBundle(noFf).bundle });
  assert.equal(ribbon.ribbonPattern3d().ok, false, 'a run without far fields offers no 3D pattern');
}

console.log('check-current-results: ok');
process.exit(0);
