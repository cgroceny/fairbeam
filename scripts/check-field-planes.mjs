// E/H field planes (bundle field_planes, a design's monitors.field_planes): validation of the bundle
// section (with its optional phasor), the run tree's 2D/3D Results nodes and their focus, the 2D map
// tab's registration, the ribbon's availability, the colour and readout math of both views (dB, linear,
// phase, the instantaneous field over one period), the structure's outline and the raw-data table.
// No DOM or solver.
//
//   node scripts/check-field-planes.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
const modules = ['lib/validate.ts', 'scene/fieldPlanes.ts', 'designer/navModel.ts', 'designer/ribbonResults.ts',
  'designer/resultFocus.ts', 'designer/resultTabs.ts', 'designer/resultData.ts', 'scene/fieldPlaneModel.ts', 'scene/fieldPlaneClock.ts', 'state.ts',
  'scene/FieldPlaneControls.tsx'];
const built = await build({
  root, configFile: false, logLevel: 'silent', resolve: { conditions: ['browser'] }, css: { postcss: {} },
  plugins: [solid(), {
    name: 'field-planes-entry',
    resolveId(id) { if (id.endsWith('field-planes-entry')) return '\0field-planes-entry'; },
    load(id) {
      if (id !== '\0field-planes-entry') return;
      return modules.map((path, i) => `export * as m${i} from ${JSON.stringify(`${root}src/${path}`)};`).join('\n');
    },
  }],
  // one chunk: lib/download.ts (imported lazily by resultData.ts) shares the i18n layer with the rest
  build: { write: false, minify: false, cssCodeSplit: false, lib: { entry: 'field-planes-entry', formats: ['es'] }, rollupOptions: { output: { inlineDynamicImports: true } } },
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
const { m0: validate, m1: planes, m2: navModel, m3: ribbon, m4: focus, m5: tabs, m6: data, m7: model, m8: clock, m9: state, m10: controls } =
  await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);

const clone = (x) => JSON.parse(JSON.stringify(x));
const patch = JSON.parse(readFileSync(`${root}public/projects/patch-antenna.json`, 'utf8'));
// a 3 x 2 map as python/fairbeam/field_planes.py writes it
const map = (over = {}) => ({
  quantity: 'E', component: 'abs', normal: 'z', axis: 2, u_axis: 0, v_axis: 1, position_mm: 2.5, requested_mm: 2.524,
  f: 2.45e9, u_range: [-10, 10], v_range: [-5, 5], nu: 3, nv: 2, unit: 'V/m',
  normalization: '1 W incident power at the driven port (peak phasor)', max: 1000, magnitude: [[1000, 100, 10], [1, 0, 500]], port: 1,
  ...over,
});
const withMaps = (maps) => ({ ...clone(patch), field_planes: maps });

// ---- 1. the bundle section validates; malformed maps are dropped with a warning
{
  const v = validate.validateBundle(withMaps([map(), map({ quantity: 'H', component: 'y', normal: 'x', axis: 0, u_axis: 1, v_axis: 2, unit: 'A/m', f: 2.5e9 })]));
  assert.ok(v.bundle, 'bundle with field planes validates');
  assert.equal(v.bundle.field_planes.length, 2);
  assert.deepEqual(v.warnings.filter((w) => w.includes('Field-plane')), []);
  const again = validate.validateBundle(JSON.parse(JSON.stringify(v.bundle))); // export → import
  assert.equal(again.bundle.field_planes.length, 2, 'field planes survive export/import');

  const bad = validate.validateBundle(withMaps([map({ nu: 4 }), map({ quantity: 'D' }), map({ magnitude: [[1, 2, 3]] }), map()]));
  assert.equal(bad.bundle.field_planes.length, 1, 'only the well-formed map stays');
  assert.equal(bad.warnings.filter((w) => w.includes('Field-plane map')).length, 3);
  const none = validate.validateBundle(withMaps([map({ nv: 3 })]));
  assert.equal(none.bundle.field_planes, undefined, 'no usable map: no field-plane result');
  assert.equal(validate.validateBundle(withMaps('x')).bundle.field_planes, undefined);
  assert.equal(validate.validateBundle(clone(patch)).bundle.field_planes, undefined, 'older bundles have none');
}

// ---- 2. the run tree: "E-field (z = 2.5 mm, 2.450 GHz)" under 2D/3D Results, with the map index
{
  assert.equal(navModel.fieldPlaneLabel(map()), 'E-field (z = 2.5 mm, 2.450 GHz)');
  assert.equal(navModel.fieldPlaneLabel(map({ quantity: 'H', component: 'y', normal: 'x', position_mm: -1.25, f: 2.5e9 })), 'Hy (x = \u22121.25 mm, 2.500 GHz)');
  assert.ok(navModel.matchesFilter('x = -1.25', navModel.fieldPlaneLabel(map({ quantity: 'H', component: 'y', normal: 'x', position_mm: -1.25, f: 2.5e9 }))), 'a typed hyphen-minus finds the label with the typographic minus');
  const content = navModel.runContent(withMaps([map(), map({ f: 2.5e9 })]));
  assert.deepEqual(content.fieldPlanes, [
    { map: 0, f: 2.45e9, label: 'E-field (z = 2.5 mm, 2.450 GHz)' }, { map: 1, f: 2.5e9, label: 'E-field (z = 2.5 mm, 2.500 GHz)' }]);
  const kids = navModel.runChildren('run.json', content);
  const group = kids.find((n) => n.label === '2D/3D Results');
  assert.ok(group, 'a run with field planes has 2D/3D Results');
  // the legacy patch bundle also has surface currents: both kinds in the one group, currents first
  assert.ok(group.children[0].label.startsWith('Surface current'));
  const fp = group.children.filter((n) => n.action.view === 'fieldplane');
  assert.deepEqual(fp.map((n) => n.label), ['E-field (z = 2.5 mm, 2.450 GHz) · 3D', 'E-field (z = 2.5 mm, 2.500 GHz) · 3D']);
  assert.deepEqual(fp.map((n) => n.id), ['res:run.json:fieldplane:0', 'res:run.json:fieldplane:1'], 'ids are unique per map');
  assert.deepEqual(fp[1].action, { kind: 'result', file: 'run.json', view: 'fieldplane', f: 2.5e9, map: 1 });
  // each map also has its 2D heat map (a main-area tab), listed before its 3D plane
  const fm = group.children.filter((n) => n.action.view === 'fieldmap');
  assert.deepEqual(fm.map((n) => n.label), ['E-field (z = 2.5 mm, 2.450 GHz) · 2D map', 'E-field (z = 2.5 mm, 2.500 GHz) · 2D map']);
  assert.deepEqual(fm.map((n) => n.id), ['res:run.json:fieldmap:0', 'res:run.json:fieldmap:1']);
  assert.deepEqual(fm[1].action, { kind: 'result', file: 'run.json', view: 'fieldmap', f: 2.5e9, map: 1 });
  const order = group.children.filter((n) => n.action.map === 0).map((n) => n.action.view);
  assert.deepEqual(order, ['fieldmap', 'fieldplane'], 'the 2D map comes first');
  // two maps at the same frequency (two planes) still get their own nodes
  const same = navModel.runChildren('r.json', navModel.runContent({ field_planes: [map(), map({ position_mm: 5 })] }));
  assert.deepEqual(same.find((n) => n.label === '2D/3D Results').children.map((n) => n.id),
    ['res:r.json:fieldmap:0', 'res:r.json:fieldplane:0', 'res:r.json:fieldmap:1', 'res:r.json:fieldplane:1']);
  // without maps or currents: no 2D/3D group
  assert.ok(!navModel.runChildren('r.json', navModel.runContent({})).some((n) => n.label === '2D/3D Results'));
  assert.equal(navModel.runContent({ field_planes: 'x' }).fieldPlanes, undefined, 'listed only when there are maps');
}

// ---- 3. the focus: the 3D plane is drawn in the 3D view, the 2D map is a main-area tab
{
  assert.ok(focus.IN_3D.has('fieldplane'));
  assert.equal(tabs.isMainResultView('fieldplane'), false);
  assert.equal(focus.IN_3D.has('fieldmap'), false, 'the 2D map is not drawn in the 3D view');
  assert.equal(tabs.isMainResultView('fieldmap'), true);
  assert.ok(tabs.MAIN_RESULT_VIEWS.includes('fieldmap'));
  assert.equal(tabs.MAIN_TAB_LABELS.fieldmap, 'Field map');
  const opened = tabs.openResultTab(tabs.ONLY_3D, 'fieldmap');
  assert.deepEqual([opened.open, opened.active], [['fieldmap'], 'fieldmap']);
  assert.equal(tabs.closeTab(opened, 'fieldmap').active, '3d');
  assert.equal(ribbon.fieldPlanesAvailability(null).ok, false);
  const none = ribbon.fieldPlanesAvailability(navModel.runContent(clone(patch)));
  assert.equal(none.ok, false);
  assert.match(none.reason, /Simulation › Monitors › Field plane/);
  const some = ribbon.fieldPlanesAvailability(navModel.runContent(withMaps([map(), map()])));
  assert.equal(some.ok, true);
  assert.match(some.reason, /2 maps/);
}

// ---- 4. the 3D layer's colours: dB below the maximum (40 dB range) or linear, and its placement
{
  const m = map();
  assert.equal(planes.FIELD_PLANE_DB_RANGE, 40);
  assert.equal(planes.rampPosition(1000, 1000, 'db'), 1);
  assert.equal(planes.rampPosition(100, 1000, 'db'), 0.5, '-20 dB is half way down a 40 dB scale');
  assert.equal(planes.rampPosition(10, 1000, 'db'), 0, '-40 dB is the bottom');
  assert.equal(planes.rampPosition(1, 1000, 'db'), 0, 'below the range clamps');
  assert.equal(planes.rampPosition(0, 1000, 'db'), 0, 'zero field is the bottom, not NaN');
  assert.equal(planes.rampPosition(500, 1000, 'linear'), 0.5);
  assert.equal(planes.rampPosition(5, 0, 'linear'), 0, 'an all-zero map stays at the bottom');
  assert.deepEqual([...planes.rampValues(m, 'db')].map((x) => +x.toFixed(4)), [1, 0.5, 0, 0, 0, +(1 + 20 * Math.log10(0.5) / 40).toFixed(4)]);
  assert.deepEqual([...planes.rampValues(m, 'linear')].map((x) => +x.toFixed(4)), [1, 0.1, 0.01, 0.001, 0, 0.5]);
  assert.deepEqual(planes.scaleTicks(m, 'db'), ['0 dB', '-10 dB', '-20 dB', '-30 dB', '-40 dB']);
  assert.deepEqual(planes.scaleTicks(m, 'linear'), ['1000', '750', '500', '250', '0']);
  // the quad sits at the plane position, half a sample beyond the outer samples
  assert.deepEqual(planes.planeCorners(m), [[-15, -10, 2.5], [15, -10, 2.5], [15, 10, 2.5], [-15, 10, 2.5]]);
  const x = map({ normal: 'x', axis: 0, u_axis: 1, v_axis: 2, position_mm: 7 });
  assert.deepEqual(planes.planeCorners(x)[0], [7, -15, -10], 'u = y, v = z for an x-normal plane');
  const group = planes.fieldPlaneLayer(m, 'db', [0x493dab, 0xa01101].map((hex) => ({ getHex: () => hex })));
  assert.equal(group.children.length, 1, 'one textured quad');
  assert.equal(group.children[0].material.transparent, true);
  assert.equal(group.children[0].material.map.image.width, 3);
  assert.equal(group.children[0].material.map.image.height, 2);
}

// ---- 5. Copy data / CSV of a map: one row per sample with its coordinates
{
  const b = validate.validateBundle(withMaps([map(), map({ f: 2.5e9 })])).bundle;
  const t = data.resultDataTable(b, 'fieldplane', undefined, { fieldPlane: 1 });
  assert.deepEqual(t.header, ['Map', 'f (GHz)', 'u axis', 'u (mm)', 'v axis', 'v (mm)', 'Magnitude', 'Unit']);
  assert.equal(t.rows.length, 6);
  assert.deepEqual(t.rows[0], [2, 2.5, 'x', -10, 'y', -5, 1000, 'V/m']);
  assert.deepEqual(t.rows[5], [2, 2.5, 'x', 10, 'y', 5, 500, 'V/m']);
  assert.equal(data.resultDataTable(b, 'fieldplane').rows.length, 12, 'every map without a pick');
}

// ---- 6. the phasor: int8 [v][u][component][re, im] against `peak`, validated, decoded, drawn
// signed bytes for the components of `n` pixels: re/im arrays per component, full scale `peak`
const encode = (peak, comps) => {
  const n = comps[0].re.length, bytes = new Int8Array(n * comps.length * 2);
  for (let px = 0; px < n; px++) comps.forEach((c, k) => {
    bytes[(px * comps.length + k) * 2] = Math.round((127 * c.re[px]) / peak);
    bytes[(px * comps.length + k) * 2 + 1] = Math.round((127 * c.im[px]) / peak);
  });
  return Buffer.from(bytes.buffer).toString('base64');
};
// a circularly polarised field in x and y (Ey = j Ex): |E(t)| is the same at every instant
const ex = { re: [100, 0, -100, 50, 0, 25], im: [0, 100, 0, 0, -50, 25] };
const ey = { re: ex.im.map((v) => -v), im: ex.re.slice() };
const ez = { re: [0, 0, 0, 0, 0, 0], im: [0, 0, 0, 0, 0, 0] };
const phasorOf = (comps, names, peak = 100) => ({ components: names, peak, data: encode(peak, comps) });
const circ = () => map({ phasor: phasorOf([ex, ey, ez], ['x', 'y', 'z']) });
{
  const ok = validate.validateBundle(withMaps([circ()]));
  assert.ok(ok.bundle.field_planes[0].phasor, 'a well-formed phasor is kept');
  assert.deepEqual(ok.warnings.filter((w) => w.includes('phase')), []);
  const again = validate.validateBundle(JSON.parse(JSON.stringify(ok.bundle)));
  assert.ok(again.bundle.field_planes[0].phasor, 'the phasor survives export/import');
  const cases = {
    'wrong length': { phasor: { ...phasorOf([ex, ey, ez], ['x', 'y', 'z']), data: encode(100, [ex, ey]) } },
    'wrong components for |E|': { phasor: phasorOf([ex], ['x']) },
    'wrong component for one component': { component: 'z', phasor: phasorOf([ex], ['x']) },
    'not base64': { phasor: { ...phasorOf([ex, ey, ez], ['x', 'y', 'z']), data: '@@@@' } },
    'no peak': { phasor: { ...phasorOf([ex, ey, ez], ['x', 'y', 'z']), peak: 0 } },
    'not an object': { phasor: 'x' },
  };
  for (const [name, over] of Object.entries(cases)) {
    const v = validate.validateBundle(withMaps([map(over)]));
    assert.equal(v.bundle.field_planes.length, 1, `${name}: the map itself stays`);
    assert.equal(v.bundle.field_planes[0].phasor, undefined, `${name}: the phasor is dropped`);
    assert.equal(v.warnings.filter((w) => w.includes('phase data')).length, 1, `${name}: with one warning`);
  }
  const one = validate.validateBundle(withMaps([map({ component: 'z', phasor: phasorOf([ex], ['z']) })]));
  assert.ok(one.bundle.field_planes[0].phasor, 'one component: its own phasor');
}

// ---- 7. decoding and the values of each view
{
  const m = circ();
  const d = model.decodePhasor(m);
  assert.deepEqual(d.components, ['x', 'y', 'z']);
  assert.equal(d.re[0][0], 100, 'the full scale is 127 = peak');
  assert.equal(d.re[0][2], -100, 'negative bytes decode as negative numbers');
  assert.ok(Math.abs(d.im[0][4] + 50) < 0.5, 'a mid value to within one int8 step');
  assert.equal(model.decodePhasor(m), d, 'decoded once');
  assert.equal(model.decodePhasor(map()), null, 'no phasor: null');
  assert.equal(model.hasPhasor(m), true);
  assert.deepEqual(model.partsOf(m), ['all', 'x', 'y', 'z']);
  assert.deepEqual(model.partsOf(map()), ['all']);
  assert.deepEqual(model.partsOf(map({ component: 'z', phasor: phasorOf([ex], ['z']) })), ['all'], 'one component has no picker');
  const view = (over) => ({ mode: 'magnitude', part: 'all', scale: 'db', phaseDeg: 0, ...over });
  // without a phasor only the magnitude (older bundles keep working)
  assert.deepEqual(model.effectiveView(map(), view({ mode: 'animate', part: 'x' })), view({ mode: 'magnitude', part: 'all' }));
  // a part the map lacks becomes "all"; the phase of |E| is that of the strongest component
  assert.equal(model.effectiveView(m, view({ part: 'y' })).part, 'y');
  assert.equal(model.effectiveView(m, view({ part: 'w' })).part, 'all');
  assert.equal(model.effectiveView(map({ phasor: phasorOf([ex, ez, ez], ['x', 'y', 'z']) }), view({ mode: 'phase' })).part, 'x');
  const zwins = map({ phasor: phasorOf([ez, ez, ex], ['x', 'y', 'z']) });
  assert.equal(model.effectiveView(zwins, view({ mode: 'phase' })).part, 'z');
  assert.equal(model.dominantComponent(model.decodePhasor(zwins)), 'z');

  // magnitude: the stored map for |E|, from the phasor for one component
  const mag = model.fieldPlaneValues(m, view());
  assert.deepEqual([mag.kind, mag.ref, mag.component], ['magnitude', 1000, 'all']);
  assert.deepEqual([...mag.values], [1000, 100, 10, 1, 0, 500]);
  const mx = model.fieldPlaneValues(m, view({ part: 'x' }));
  assert.equal(mx.component, 'x');
  assert.ok(Math.abs(mx.values[1] - 100) < 1 && Math.abs(mx.values[5] - Math.hypot(25, 25)) < 1);
  assert.ok(Math.abs(mx.ref - 100) < 1e-3);
  // phase: degrees of one component, -180..180
  const ph = model.fieldPlaneValues(m, view({ mode: 'phase', part: 'x' }));
  assert.equal(ph.kind, 'phase');
  assert.deepEqual([0, 1, 2].map((i) => Math.round(ph.values[i])), [0, 90, 180]);
  assert.equal(Math.round(ph.values[4]), -90);
  assert.equal(Math.round(ph.values[5]), 45);
  assert.ok(ph.amplitude[0] > 99);
  const py = model.fieldPlaneValues(m, view({ mode: 'phase', part: 'y' }));
  assert.deepEqual([0, 1].map((i) => Math.round(py.values[i])), [90, 180], 'Ey = j Ex leads Ex by a quarter turn');

  // animate: Re{F e^(j wt)}. One component is signed and follows re cos - im sin
  const at = (deg, part = 'x') => model.fieldPlaneValues(m, view({ mode: 'animate', part, phaseDeg: deg }));
  const s0 = at(0), s90 = at(90);
  assert.equal(s0.kind, 'signed');
  assert.ok(Math.abs(s0.values[0] - 100) < 1e-3 && Math.abs(s0.values[1]) < 1e-3, 'at wt = 0 the field is the real part');
  assert.ok(Math.abs(s90.values[1] + 100) < 1e-3 && Math.abs(s90.values[0]) < 1e-3, 'a quarter period later it is -imag');
  assert.ok(Math.abs(at(360).values[3] - at(0).values[3]) < 1e-3, 'one full period comes back');
  assert.ok(Math.abs(at(180).values[0] + 100) < 1e-3, 'half a period flips the sign');
  // |E(t)| of a circularly polarised field does not change over the period; of a linear one it is |cos|
  const all = (deg, mp = m) => model.fieldPlaneValues(mp, view({ mode: 'animate', phaseDeg: deg }));
  for (const deg of [0, 37, 90, 145, 270]) {
    assert.equal(all(deg).kind, 'magnitude');
    assert.ok(Math.abs(all(deg).values[0] - 100) < 1e-3 && Math.abs(all(deg).values[5] - all(0).values[5]) < 0.5 && Math.abs(all(0).values[5] - Math.hypot(25, 25)) < 0.5, `|E(t)| is constant at ${deg}`);
  }
  const lin = map({ phasor: phasorOf([ex, ez, ez], ['x', 'y', 'z']) });
  assert.ok(Math.abs(all(60, lin).values[0] - 50) < 1e-3, 'linear polarisation: |E(t)| = |E| cos(wt)');
  assert.ok(Math.abs(all(90, lin).values[0]) < 1e-3);
  assert.ok(Math.abs(all(90, lin).values[1] - 100) < 1e-3, 'where the real part is zero the imaginary one shows');
  // one component map: animate is that component, signed
  const z1 = map({ component: 'z', phasor: phasorOf([ex], ['z']) });
  assert.equal(model.fieldPlaneValues(z1, view({ mode: 'animate', phaseDeg: 0 })).kind, 'signed');
  assert.equal(model.fieldPlaneValues(z1, view({ mode: 'phase' })).component, 'z');
  assert.equal(model.instantaneous(d, 'all', 0).length, 6);
}

// ---- 8. colours: signed, phase (cyclic, fading where it means nothing), the RGBA image and its order
{
  const ramp = [[0, 0, 0], [100, 100, 100], [200, 200, 200]];
  assert.deepEqual(model.sampleRamp(ramp, 0), [0, 0, 0]);
  assert.deepEqual(model.sampleRamp(ramp, 1), [200, 200, 200]);
  assert.deepEqual(model.sampleRamp(ramp, 0.25), [50, 50, 50]);
  assert.deepEqual(model.sampleRamp(ramp, NaN), [0, 0, 0], 'NaN is the bottom');
  assert.deepEqual(model.signedColor(0, 10), model.DIVERGING_STOPS[2], 'zero is the light middle');
  assert.deepEqual(model.signedColor(10, 10), model.DIVERGING_STOPS[4]);
  assert.deepEqual(model.signedColor(-10, 10), model.DIVERGING_STOPS[0]);
  assert.deepEqual(model.signedColor(99, 10), model.DIVERGING_STOPS[4], 'beyond the full scale clamps');
  assert.deepEqual(model.signedColor(5, 0), model.DIVERGING_STOPS[2], 'a zero field stays in the middle');
  assert.deepEqual(model.phaseColor(-180).map(Math.round), model.phaseColor(180).map(Math.round), '-180 and 180 are one colour');
  assert.deepEqual(model.phaseColor(0).map(Math.round), model.phaseColor(360).map(Math.round));
  assert.notDeepEqual(model.phaseColor(0).map(Math.round), model.phaseColor(90).map(Math.round));
  assert.equal(model.phaseWeight(1, 1), 1, 'full colour at the maximum');
  assert.equal(model.phaseWeight(0.1, 1), 1, '-20 dB is still full colour');
  assert.equal(model.phaseWeight(0.01, 1), 0, '-40 dB is grey');
  assert.equal(model.phaseWeight(0, 1), 0);
  assert.ok(model.phaseWeight(10 ** (-34 / 20), 1) > 0 && model.phaseWeight(10 ** (-34 / 20), 1) < 1, 'a fade between');

  const m = circ();
  const fv = model.fieldPlaneValues(m, { mode: 'magnitude', part: 'all', scale: 'db', phaseDeg: 0 });
  const stops = [[0, 0, 255], [255, 0, 0]];
  const up = model.fieldPlaneRgba(m, fv, 'linear', stops);            // row 0 = v_range[0] (the texture's order)
  const down = model.fieldPlaneRgba(m, fv, 'linear', stops, true);    // row 0 = the top of the picture
  assert.equal(up.length, 3 * 2 * 4);
  assert.deepEqual([...up.slice(0, 4)], [255, 0, 0, 255], 'the maximum (1000) is the top of the ramp');
  assert.deepEqual([...down.slice(12, 16)], [255, 0, 0, 255], 'flipped: the first sample is in the last row');
  assert.deepEqual([...down.slice(0, 4)], [...up.slice(12, 16)], 'the two orders are mirror images');
  const reuse = new Uint8ClampedArray(24);
  assert.equal(model.fieldPlaneRgba(m, fv, 'linear', stops, false, reuse), reuse, 'a buffer of the right size is reused');
  // the colour bar
  const bar = model.legendOf(fv, 'db', stops, 5);
  assert.deepEqual(bar.ticks, ['0 dB', '-10 dB', '-20 dB', '-30 dB', '-40 dB']);
  assert.deepEqual(bar.colors[0], [255, 0, 0], 'the maximum on top');
  assert.deepEqual(model.legendOf(fv, 'linear', stops, 5).ticks, ['1000', '750', '500', '250', '0']);
  const sg = model.fieldPlaneValues(m, { mode: 'animate', part: 'x', scale: 'db', phaseDeg: 0 });
  assert.deepEqual(model.legendOf(sg, 'db', stops, 5).ticks, ['100', '50', '0', '−50', '−100'], 'a signed bar runs -peak..peak');
  assert.deepEqual(model.legendOf(model.fieldPlaneValues(m, { mode: 'phase', part: 'x', scale: 'db', phaseDeg: 0 }), 'db', stops, 5).ticks, ['180°', '90°', '0°', '−90°', '−180°']);
  // phase image: grey where the amplitude is far below the maximum
  const phv = model.fieldPlaneValues(m, { mode: 'phase', part: 'x', scale: 'db', phaseDeg: 0 });
  const lowAmp = { ...phv, amplitude: phv.amplitude.map(() => phv.ref * 0.001) };
  assert.deepEqual(model.fieldColor(lowAmp, 0, 'db', stops), [128, 128, 128]);
  assert.deepEqual(model.fieldColor(phv, 0, 'db', stops).map(Math.round), model.phaseColor(0).map(Math.round));
}

// ---- 9. the hover readout
{
  const m = circ();                                            // u -10..10 (3 samples, 10 mm apart), v -5..5 (2 samples)
  assert.deepEqual(model.sampleIndex(m, -10, -5), { i: 0, j: 0 });
  assert.deepEqual(model.sampleIndex(m, 9, 4), { i: 2, j: 1 });
  assert.deepEqual(model.sampleIndex(m, 4, 0), { i: 1, j: 1 }, 'the nearest sample (ties go up)');
  assert.deepEqual(model.sampleIndex(m, 14.9, 0), { i: 2, j: 1 }, 'half a sample beyond the edge is still that sample');
  assert.equal(model.sampleIndex(m, 15.1, 0), null);
  assert.equal(model.sampleIndex(m, 0, -10.1), null);
  assert.deepEqual(model.samplePosition(m, 2, 1), { u: 10, v: 5 });
  const v = (over) => model.fieldPlaneValues(m, { mode: 'magnitude', part: 'all', scale: 'db', phaseDeg: 0, ...over });
  const r = model.readoutAt(m, v(), 1, 0);                     // 100 V/m against a 1000 V/m maximum
  assert.deepEqual([r.u, r.v, r.value, r.kind], [0, -5, 100, 'magnitude']);
  assert.ok(Math.abs(r.db + 20) < 1e-9, '100 of 1000 is -20 dB');
  assert.equal(model.readoutAt(m, v(), 0, 0).db, 0);
  assert.equal(model.readoutAt(m, v(), 1, 1).db, -Infinity, 'a zero field is -inf dB');
  const s = model.readoutAt(m, v({ mode: 'animate', part: 'x', phaseDeg: 180 }), 0, 0);
  assert.equal(s.kind, 'signed');
  assert.ok(Math.abs(s.value + 100) < 1e-3 && s.db === null, 'an instantaneous component: a signed value, no level');
  const p = model.readoutAt(m, v({ mode: 'phase', part: 'x' }), 1, 0);
  assert.equal(Math.round(p.value), 90);
  assert.ok(Math.abs(p.db) < 0.1, 'the phase readout carries the level of its amplitude');
}

// ---- 10. the structure's outline projected onto the plane
{
  const box = (start, stop) => ({ kind: 'box', start, stop, priority: 1, bbox: [start, stop], exact: true });
  const parts = [
    { name: 'sub', type: 'Material', primitives: [box([-20, -10, 0], [20, 10, 1.5])], bbox: [[-20, -10, 0], [20, 10, 1.5]] },
    { name: 'patch', type: 'Metal', primitives: [{ kind: 'polygon', normal: 2, elevation: 1.5, points: [[-5, -4], [5, -4], [5, 4]], priority: 2, bbox: [[-5, -4, 1.5], [5, 4, 1.5]], exact: true }], bbox: [[-5, -4, 1.5], [5, 4, 1.5]] },
    { name: 'pin', type: 'Metal', primitives: [{ kind: 'cylinder', start: [3, 2, 0], stop: [3, 2, 1.5], radius: 0.5, priority: 3, bbox: [[2.5, 1.5, 0], [3.5, 2.5, 1.5]], exact: true }], bbox: [[2.5, 1.5, 0], [3.5, 2.5, 1.5]] },
    { name: 'lossy', type: 'Material', conductor: { conductivity: 5.8e7, thickness: null }, primitives: [box([0, 0, 0], [1, 1, 1]), box([0, 0, 0], [1, 1, 1])], bbox: [[0, 0, 0], [1, 1, 1]] },
    { name: 'wire', type: 'Metal', primitives: [{ kind: 'wire', points: [[0, 0, 0], [0, 0, 5]], radius: 0.1, priority: 1, bbox: [[-0.1, -0.1, 0], [0.1, 0.1, 5]], exact: true }], bbox: [[-0.1, -0.1, 0], [0.1, 0.1, 5]] },
  ];
  const z = model.planeOutline(parts, { axis: 2, u_axis: 0, v_axis: 1 });
  assert.deepEqual(z.map((o) => o.metal), [false, true, true, true, true], 'the dielectric is dashed; a lossy metal volume and a wire are metal; the duplicate box is drawn once');
  assert.deepEqual(z[0].points, [[-20, -10], [20, -10], [20, 10], [-20, 10]], 'a box is its rectangle');
  assert.deepEqual(z[1].points, [[-5, -4], [5, -4], [5, 4]], 'a polygon on the plane axis is itself');
  assert.equal(z[2].points.length, 32, 'a cylinder along the normal is a circle');
  assert.ok(z[2].points.every(([a, b]) => Math.abs(Math.hypot(a - 3, b - 2) - 0.5) < 1e-9));
  assert.deepEqual(z[4].points, [[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1]], 'the rest by its bounding box');
  // an x-normal plane: u = y, v = z
  const x = model.planeOutline(parts.slice(0, 1), { axis: 0, u_axis: 1, v_axis: 2 });
  assert.deepEqual(x[0].points, [[-10, 0], [10, 0], [10, 1.5], [-10, 1.5]]);
  assert.deepEqual(model.planeOutline(undefined, { axis: 2, u_axis: 0, v_axis: 1 }), []);
  assert.equal(model.planeOutline(parts, { axis: 2, u_axis: 0, v_axis: 1 }, 2).length, 2, 'capped');
  // the real patch starter: it has a substrate, a ground plane and a patch
  const real = model.planeOutline(patch.parts, { axis: 2, u_axis: 0, v_axis: 1 });
  assert.ok(real.length >= 3 && real.some((o) => o.metal) && real.some((o) => !o.metal), 'the patch starter projects');
}

// ---- 11. the 3D layer follows the same colours and animates in place
{
  const m = circ();
  const stops = [0x493dab, 0x25cdd0, 0xa01101].map((hex) => ({ getHex: () => hex }));
  const still = planes.fieldPlaneLayer(m, { mode: 'magnitude', part: 'all', scale: 'db', phaseDeg: 0 }, stops);
  assert.equal(planes.updateFieldPlanePhase(still, 90), false, 'a magnitude layer has no instant');
  const moving = planes.fieldPlaneLayer(m, { mode: 'animate', part: 'x', scale: 'db', phaseDeg: 0 }, stops);
  const bytes = () => [...moving.children[0].material.map.image.data];
  const first = bytes();
  assert.equal(planes.updateFieldPlanePhase(moving, 90), true);
  assert.notDeepEqual(bytes(), first, 'the texture is redrawn in place at another instant');
  planes.updateFieldPlanePhase(moving, 0);
  assert.deepEqual(bytes(), first, 'and comes back');
  const nophase = planes.fieldPlaneLayer(map(), { mode: 'animate', part: 'x', scale: 'db', phaseDeg: 0 }, stops);
  assert.equal(planes.updateFieldPlanePhase(nophase, 45), false, 'no phasor: the magnitude, nothing to animate');
  assert.deepEqual(planes.stopsRgb(stops).map((c) => c.join()), ['73,61,171', '37,205,208', '160,17,1']);
}

// ---- 12. the animation clock: steps the period, pauses when nothing shows it
{
  assert.equal(clock.stepPhase(0), 15);
  assert.equal(clock.stepPhase(345), 0, 'wraps at a full period');
  assert.equal(clock.stepPhase(350, 30), 20);
  assert.equal(24 * clock.PHASE_STEP_DEG, 360, 'one period is 24 frames');
  state.setFieldPlaneMode('animate');
  clock.setFieldMapTabOpen(true);
  state.setFieldPlanePlaying(true);
  assert.equal(state.fieldPlanePlaying(), true, 'playing with the 2D tab open in Animate');
  state.setFieldPlaneMode('phase');
  assert.equal(state.fieldPlanePlaying(), false, 'leaving Animate pauses');
  state.setFieldPlaneMode('animate');
  state.setFieldPlanePlaying(true);
  clock.setFieldMapTabOpen(false);
  assert.equal(state.fieldPlanePlaying(), false, 'nothing on screen: paused');
  state.setFieldPlaneMap(0);
  state.setFieldPlanePlaying(true);
  assert.equal(state.fieldPlanePlaying(), true, 'the 3D view alone keeps it going');
  state.setFieldPlanePlaying(false);
  state.setFieldPlaneMap(null);
  state.setFieldPlaneMode('magnitude');
}

// ---- 13. Copy data / CSV with the phasor: English headers, decimal points
{
  const b = validate.validateBundle(withMaps([circ(), map({ f: 2.5e9 })])).bundle;
  const t = data.resultDataTable(b, 'fieldmap', undefined, { fieldPlane: 0 });
  assert.deepEqual(t.header.slice(0, 8), ['Map', 'f (GHz)', 'u axis', 'u (mm)', 'v axis', 'v (mm)', 'Magnitude', 'Unit']);
  assert.deepEqual(t.header.slice(8), ['Re Ex', 'Im Ex', 'Phase Ex (deg)', 'Re Ey', 'Im Ey', 'Phase Ey (deg)', 'Re Ez', 'Im Ez', 'Phase Ez (deg)']);
  assert.equal(t.rows.length, 6);
  assert.equal(t.rows[0][8], 100);
  assert.equal(t.rows[0][10], 0);
  assert.equal(t.rows[1][10], 90, 'the phase of Ex at the second sample');
  assert.equal(t.rows[0][12], 100, 'Im Ey = Re Ex');
  assert.equal(t.rows[0][13], 90, 'Ey leads Ex by 90 degrees');
  const all = data.resultDataTable(b, 'fieldmap');
  assert.equal(all.rows.length, 12);
  assert.equal(all.rows[6].length, all.header.length, 'a map without a phasor keeps the row width');
  assert.deepEqual(all.rows[6].slice(8), Array(9).fill(null), 'and blank phasor cells');
  const csv = data.resultDataCsv(t);
  assert.ok(csv.startsWith('Map,f (GHz),u axis,u (mm),v axis,v (mm),Magnitude,Unit,Re Ex,Im Ex,Phase Ex (deg)'));
  assert.match(csv.split('\r\n')[1], /^1,2\.45,x,-10,y,-5,1000,V\/m,100,0,0,/, 'decimal points');
  // a bundle without a phasor still gives the old columns
  const plain = data.resultDataTable(validate.validateBundle(withMaps([map()])).bundle, 'fieldplane');
  assert.deepEqual(plain.header, ['Map', 'f (GHz)', 'u axis', 'u (mm)', 'v axis', 'v (mm)', 'Magnitude', 'Unit']);
}

// ---- 14. wiring: the tab, its toolbar, the ribbon, the 3D view and the Examples viewer
{
  const read = (p) => readFileSync(`${root}${p}`, 'utf8');
  const en = JSON.parse(read('src/i18n/en.json'));
  const tr = JSON.parse(read('src/i18n/tr.json'));
  assert.match(read('src/designer/MainArea.tsx'), /fieldmap: "mainTabs\.fieldmap"/, 'the tab has its (translated) name');
  assert.equal(en['mainTabs.fieldmap'], 'Field map');
  assert.equal(tr['mainTabs.fieldmap'], 'Alan haritası');
  assert.match(read('src/designer/ResultViews.tsx'), /<Match when=\{props\.view === "fieldmap"\}><FieldMapView b=\{props\.b\} \/><\/Match>/, 'ResultBody draws it');
  assert.match(read('src/designer/ResultViews.tsx'), /fieldPlane: resultFocus\(\)\?\.map/, 'Copy data and CSV follow the shown map');
  assert.match(read('src/designer/ribbonResults.ts'), /action === "fieldmap"[\s\S]*view: "fieldmap"[\s\S]*"main"/, 'the ribbon opens the tab');
  assert.match(read('src/designer/DesignWorkspace.tsx'), /openRibbonResult\("fieldmap"\)/, 'a ribbon button for it');
  assert.match(read('src/designer/NavTree.tsx'), /a\.view === "fieldmap"/, 'the tree marks the shown map');
  assert.match(read('src/scene/Viewport.tsx'), /updateFieldPlanePhase/, 'the 3D view animates the layer');
  assert.match(read('src/components/ModelPanel.tsx'), /setFieldPlaneMap\(/, 'the Examples viewer picks a map');
  state.setFieldPlaneMap(0);
  state.openBundle(clone(patch), 'field-plane-reset.json');
  assert.equal(state.fieldPlaneMap(), null, 'a newly opened bundle starts without a map');
  // the text of what is shown
  const m = circ();
  const label = (view) => controls.valueLabel(m, model.fieldPlaneValues(m, view), view.scale);
  const v = { mode: 'magnitude', part: 'all', scale: 'db', phaseDeg: 0 };
  assert.equal(label(v), '|E| (dB, 0 dB = 1000 V/m)');
  assert.equal(label({ ...v, scale: 'linear' }), '|E| (V/m)');
  assert.equal(label({ ...v, mode: 'phase', part: 'x' }), 'Phase of Ex (degrees)');
  assert.equal(label({ ...v, mode: 'animate', part: 'z' }), 'Ez(t) (V/m)');
  assert.equal(label({ ...v, mode: 'animate' }), '|E(t)| (dB, 0 dB = 1000 V/m)', 'the instantaneous magnitude says so');
  assert.deepEqual(controls.fieldRampRgb().length, 9);
}

console.log('check-field-planes: ok');
