// Synthetic numerical controls only: no browser, app server, FDTD solver or filesystem writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { postprocessPorts, portProcessingEligibility } from '../src/lib/portPostprocess.ts';
import { portProcessingInfo, originalPortResult } from '../src/lib/portProcessingMetadata.ts';
import { createPortProcessingSession } from '../src/designer/resultSessionState.ts';
import { physicalPortNumber, reflectionAtPort, sMatrix } from '../src/lib/sparams.ts';
import { sweep } from '../src/lib/rf.ts';
import { bundleMetrics } from '../src/designer/runSummary.ts';
import { mismatchAt } from '../src/lib/farfieldQuantity.ts';
import { activeResultDataTable, resultDataTable } from '../src/designer/resultData.ts';
import { parseTouchstoneNPort, touchstoneNPort, touchstoneS1p } from '../src/export/touchstone.ts';

let checks = 0;
function near(a, b, eps = 2e-12) { checks++; assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`); }
function matrixBundle(f, refs, matrices, ids = refs.map((_, i) => i + 1)) {
  const n = refs.length, s = {};
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) s[`${i + 1},${j + 1}`] = { re: matrices.map(m => m[i][j][0]), im: matrices.map(m => m[i][j][1]) };
  return { name: 'Synthetic circuit control', created: '2026-10-24T00:00:00Z', model: { id: 'synthetic', name: 'Synthetic', params: [] },
    generator: { version: 'test', openems: null }, solver: { engine: 'test', method: 'synthetic', end_criteria_db: -30 }, mesh: { total_cells: 0 }, run: null,
    ports: ids.map((number, i) => ({ number, excite: i === 0, type: 'lumped', R: refs[i], direction: 'z' })),
    results: { frequency: f, bands: [], farfield: [], signals: {},
      ports: Object.fromEntries(ids.map((id, i) => [id, { z_ref: refs[i], s11_re: s[`${i+1},${i+1}`].re, s11_im: s[`${i+1},${i+1}`].im, zin_re: f.map(() => 123456), zin_im: f.map(() => -98765) }])),
      sparams: { ports: refs.map((_, i) => i + 1), port_numbers: ids, z_ref: refs, excited: [1], complete: true, method: 'synthetic', qa: { passivity_max: 0.9 }, s } } };
}
const options = (b, referenceOhm, delays = {}) => ({ referenceOhm, delayPs: Object.fromEntries(b.ports.map(p => [p.number, delays[p.number] ?? 0])) });
const transform = (b, settings) => { const result = postprocessPorts(b, settings); assert.equal(result.error, null); assert.ok(result.bundle); return result.bundle; };
const c = JSON.parse(readFileSync(new URL('./fixtures/port-postprocess-circuit.json', import.meta.url)));
const circuit = matrixBundle(c.frequency_hz, c.source_references_ohm, c.source, c.physical_ports);
const untouched = structuredClone(circuit);
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
freeze(circuit); // The actual transformation must also succeed when every raw object is immutable.
const processed = transform(circuit, options(circuit, c.target_reference_ohm));
const p = sMatrix(processed);
for (let k = 0; k < c.frequency_hz.length; k++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
  const v = p.get(i + 1, j + 1); near(v.re[k], c.target[k][i][j][0]); near(v.im[k], c.target[k][i][j][1]);
}
assert.deepEqual(circuit, untouched, 'all original arrays, powers and metadata remain byte-for-byte equivalent');
assert.equal(originalPortResult(processed), circuit);
assert.deepEqual(p.ports.map(index => physicalPortNumber(p, index)), [7, 2, 19]);
assert.equal(p.passivity, null, 'old QA is never presented as recalculated QA');
assert.equal(processed.results.farfield, circuit.results.farfield);
near(mismatchAt(processed, c.frequency_hz[1], 7), mismatchAt(circuit, c.frequency_hz[1], 7));

// One-port known impedances, exact open/short and active reflection: no passivity clipping.
for (const [zr, zi] of [[25, 0], [50, 0], [100, 30], [5, -80], [-20, 0]]) {
  const den = (zr + 50) ** 2 + zi ** 2;
  const gamma = [(zr*zr + zi*zi - 2500)/den, 100*zi/den];
  const b = matrixBundle([1e9], [50], [[[gamma]]], [7]);
  const out = transform(b, options(b, 75)), s = sweep(out), smith = reflectionAtPort(out, 1);
  near(s.zRe[0], zr); near(s.zIm[0], zi); near(s.zRe[0], smith.zRe[0]); near(s.zIm[0], smith.zIm[0]);
  const d = (zr + 75) ** 2 + zi ** 2;
  near(s.s11Re[0], (zr*zr + zi*zi - 75*75)/d); near(s.s11Im[0], 150*zi/d);
  if (zr < 0) assert.ok(Math.hypot(s.s11Re[0], s.s11Im[0]) > 1);
}
for (const gamma of [1, -1]) {
  const b = matrixBundle([1e9], [50], [[[[gamma, 0]]]]);
  near(sMatrix(transform(b, options(b, 75))).get(1, 1).re[0], gamma);
}

// Feed correction must precede renormalization. The known complex circuit below is dressed
// with unequal one-way feed delays at its source references; remove them then compare to
// the independent target-reference circuit solve. Reversing the order fails this control.
const delays = [31, 77, -18], dressed = structuredClone(circuit);
for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < c.frequency_hz.length; k++) {
  const [re, im] = c.source[k][i][j], phase = -2 * Math.PI * c.frequency_hz[k] * (delays[i] + delays[j]) * 1e-12;
  const v = dressed.results.sparams.s[`${i+1},${j+1}`];
  v.re[k] = re*Math.cos(phase)-im*Math.sin(phase); v.im[k] = re*Math.sin(phase)+im*Math.cos(phase);
}
const removed = transform(dressed, options(dressed, 75, Object.fromEntries(c.physical_ports.map((id, i) => [id, delays[i]]))));
for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < c.frequency_hz.length; k++) {
  const v = sMatrix(removed).get(i+1,j+1); near(v.re[k], c.target[k][i][j][0]); near(v.im[k], c.target[k][i][j][1]);
}

// Lossless matched-through invariants, signs and reflected double delay; do not symmetrize.
const through = matrixBundle([0, 1e9, 2e9], [50, 50], Array(3).fill([[[0,0],[1,0]],[[1,0],[0,0]]]), [7,19]);
const extended = transform(through, options(through, 50, { 7: 125, 19: 0 }));
near(sMatrix(extended).get(2,1).re[1], Math.SQRT1_2); near(sMatrix(extended).get(2,1).im[1], Math.SQRT1_2);
const reflected = matrixBundle([1e9], [50], [[[[0.5, 0]]]], [19]);
const reflectedOut = transform(reflected, options(reflected, 50, {19: 125}));
near(sMatrix(reflectedOut).get(1,1).re[0], 0); near(sMatrix(reflectedOut).get(1,1).im[0], 0.5);
const nonreciprocal = structuredClone(through); nonreciprocal.results.sparams.s['1,2'].re.fill(0.2);
const nonreciprocalOut = transform(nonreciprocal, options(nonreciprocal, 75));
assert.notEqual(sMatrix(nonreciprocalOut).get(1,2).re[1], sMatrix(nonreciprocalOut).get(2,1).re[1]);

// Exported numbers, all derived plots/summary and physical-port comments use one projection.
const networkText = touchstoneNPort(processed, 'synthetic test');
assert.match(networkText, /Postprocessed:/); assert.match(networkText, /1 -> 7, 2 -> 2, 3 -> 19/);
const parsed = parseTouchstoneNPort(networkText, 3);
assert.equal(parsed.z0, 75);
for (let k = 0; k < 3; k++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
  near(parsed.s[k][i][j][0], c.target[k][i][j][0], 6e-8); near(parsed.s[k][i][j][1], c.target[k][i][j][1], 6e-8);
}
const one = matrixBundle([1e9,2e9,3e9], [50], [[[[.5,0]]],[[[.2,0]]],[[[.5,0]]]], [7]);
const oneOut = transform(one, options(one, 75)), sw = sweep(oneOut), sm = sMatrix(oneOut);
assert.match(touchstoneS1p(oneOut, 'synthetic test'), /Postprocessed:/);
near(sw.s11Re[1], 0); assert.equal(bundleMetrics(oneOut).f0, 2e9);
near(bundleMetrics(oneOut).s11MinDb, Math.min(...sw.s11Db));
for (const view of ['sparams','smith','impedance','vswr','table','summary']) {
  const table = resultDataTable(oneOut, view, undefined, { format:'re_im' });
  assert.equal(table.header.at(-1), 'Port processing'); assert.ok(table.rows.every(r => r.at(-1).includes('Postprocessed:')));
}
near(resultDataTable(oneOut,'sparams',undefined,{format:'re_im'}).rows[1][1], sm.get(1,1).re[1]);
near(resultDataTable(oneOut,'impedance').rows[1][1], sw.zRe[1]);
near(resultDataTable(oneOut,'vswr').rows[1][1], sw.vswr[1]);
const comparedSummary = activeResultDataTable(oneOut,'summary',undefined,[{file:'a',bundle:oneOut},{file:'b',bundle:one}]);
assert.equal(comparedSummary.header.at(-1), 'Port processing'); assert.match(comparedSummary.rows[0].at(-1),/Postprocessed:/);
assert.equal(comparedSummary.rows[1].at(-1),'Original stored result');

// A gap contaminates the full coupled sample, not adjacent frequencies or the raw source.
const gap = structuredClone(circuit); gap.results.sparams.s['2,3'].re[1] = NaN;
const gapOut = transform(gap, options(gap,75));
assert.equal(portProcessingInfo(gapOut).missingSamples,1);
for (const pair of sMatrix(gapOut).pairs) { assert.ok(Number.isNaN(sMatrix(gapOut).get(...pair).re[1])); assert.ok(Number.isFinite(sMatrix(gapOut).get(...pair).re[0])); }
assert.equal(touchstoneNPort(gapOut),null, 'Touchstone refuses missing complex samples rather than writing invented values');
// Exact singular transform: g=(75-50)/(75+50)=0.2, so S=5 makes I-gS=0.
// The adjacent valid sample survives; the singular frequency does not become zero or infinity.
const singular = matrixBundle([1e9,2e9], [50], [[[[.1,0]]],[[[5,0]]]], [7]);
const singularOut = transform(singular,options(singular,75));
assert.ok(Number.isFinite(sMatrix(singularOut).get(1,1).re[0]));
assert.ok(Number.isNaN(sMatrix(singularOut).get(1,1).re[1]));
assert.equal(portProcessingInfo(singularOut).missingSamples,1);
const allSingular = matrixBundle([1e9], [50], [[[[5,0]]]], [7]);
assert.equal(postprocessPorts(allSingular,options(allSingular,75)).error,'noSamples');
const splitBand = matrixBundle([1e9,2e9,3e9], [50], [[[[.2,0]]],[[[NaN,0]]],[[[.2,0]]]], [7]);
const splitOut = transform(splitBand, options(splitBand,75));
assert.equal(splitOut.results.bands.length,2,'missing data never bridge a matched band');
assert.ok(splitOut.results.bands[0].edge_hi && splitOut.results.bands[1].edge_lo);

// Session isolation, replacement identity, failed Apply and reset. No filename/global state.
const session = createPortProcessingSession(), sameNameOther = structuredClone(one);
assert.equal(session.apply(one, options(one,75)),null);
assert.notEqual(session.project(one),one); assert.equal(session.project(sameNameOther),sameNameOther);
const saved = session.project(one);
assert.equal(session.apply(one,options(one,-1)),'settings'); assert.equal(session.project(one),saved);
assert.equal(session.apply(one,{referenceOhm:75,delayPs:{1:0}}),'settings');
session.reset(one); assert.equal(session.project(one),one); session.dispose();
assert.deepEqual(one.ports[0].R,50);
assert.equal(transform(one,options(one,50)),one,'identity keeps original source identity');
const legacy = structuredClone(one); delete legacy.results.sparams;
const legacyOut = transform(legacy, options(legacy, 75));
assert.equal(physicalPortNumber(sMatrix(legacyOut), 1), 7);
near(sweep(legacyOut).s11Re[1], 0);
for (const malformed of [undefined, null, {}, {s:{}}, {ports:[1],z_ref:[50],s:{'1,1':{re:[.1],im:[0]}}}]) {
  const b = structuredClone(legacy); b.results.sparams = malformed;
  assert.equal(portProcessingEligibility(b).error,'matrix','an explicitly supplied invalid matrix must never fall back to another reflection');
  assert.equal(postprocessPorts(b,options(b,75)).bundle,null);
}
const oneAgain = transform(oneOut,options(one,75));
near(sweep(oneAgain).s11Re[0],sw.s11Re[0]); // reapply always starts from raw, not compounded output
const settingsCopy = options(one,75,{7:10}), own = transform(one,settingsCopy);
settingsCopy.delayPs[7]=999;
assert.equal(portProcessingInfo(own).settings.delayPs[7],10);

for (const [edit, error] of [
  [b=>b.reference={phaseKnown:false},'phase'],
  [b=>delete b.results.sparams.s['1,2'],'matrix'],
  [b=>b.results.sparams.complete=false,'matrix'],
  [b=>b.results.sparams.port_numbers=[7,7,19],'mapping'],
  [b=>delete b.results.sparams.ports,'mapping'],
  [b=>delete b.results.sparams.z_ref,'reference'],
  [b=>b.results.ports['7'].z_ref_f=[35,35,35],'reference'],
  [b=>b.ports[0].type='waveguide','reference'],
  [b=>b.ports[0].reference_impedance={real:50,imag:10},'reference'],
  [b=>b.results.ports['7'].z_ref=50,'reference'],
  [b=>b.results.frequency[1]=b.results.frequency[0],'frequency'],
]) { const b=structuredClone(circuit); edit(b); assert.equal(portProcessingEligibility(b).error,error); assert.equal(postprocessPorts(b,options(b,75)).bundle,null); }
const allMissing=structuredClone(one); allMissing.results.sparams.s['1,1'].re.fill(NaN);
assert.equal(postprocessPorts(allMissing,options(allMissing,75)).error,'noSamples');
assert.equal(postprocessPorts(one,options(one,75,{7:1e100})).error,'settings');
assert.deepEqual(circuit,untouched);
console.log(`PASS port postprocessing: ${checks} numeric comparisons plus mapping, provenance, gaps, refusal, raw identity and session controls; no browser or solver.`);
