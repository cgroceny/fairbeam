// Synthetic numerical controls only: no browser, app server, FDTD solver or filesystem writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { postprocessPorts, portProcessingEligibility } from '../src/lib/portPostprocess.ts';
import { portProcessingInfo, originalPortResult, hasComplexPortReference, hasMixedPortCoordinates, primaryPortLabel } from '../src/lib/portProcessingMetadata.ts';
import { createPortProcessingSession } from '../src/designer/resultSessionState.ts';
import { mappedPairLabel, physicalPortNumber, reflectionAtPort, sMatrix } from '../src/lib/sparams.ts';
import { sweep } from '../src/lib/rf.ts';
import { bundleMetrics, summaryTable } from '../src/designer/runSummary.ts';
import { mismatchAt } from '../src/lib/farfieldQuantity.ts';
import { activeResultDataTable, resultDataTable, resultDataCsv } from '../src/designer/resultData.ts';
import { parseCsv } from '../src/export/csv.ts';
import { parseTouchstoneNPort, touchstoneNPort, touchstoneS1p } from '../src/export/touchstone.ts';
import { exportResultTouchstone } from '../src/designer/resultTouchstone.ts';
import { validateBundle } from '../src/lib/validate.ts';
import { matchesResultIndex } from '../src/lib/resultIdentity.ts';
import { portProcessingBrowserFixture } from './fixtures/port-postprocessing-browser.mjs';

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
// Admit the exact browser fixture before a browser is ever launched. An analytic
// circuit with run:null has no CPU/GPU run provenance for the index to assert.
const geometry = JSON.parse(readFileSync(new URL('../public/projects/branchline-coupler.json', import.meta.url)));
const browserFixture = portProcessingBrowserFixture(geometry, c);
const admitted = validateBundle(browserFixture);
assert.ok(admitted.bundle, JSON.stringify(admitted.errors));
assert.equal(admitted.bundle.run, null);
const browserIndex = { file: 'synthetic-ports.json', model: admitted.bundle.model.id, created: admitted.bundle.created };
assert.ok(matchesResultIndex(browserIndex, admitted.bundle), 'actual validated synthetic fixture is admitted without invented run engine');
assert.equal(matchesResultIndex({ ...browserIndex, engine: 'CPU' }, admitted.bundle), false, 'invented CPU provenance rejects this no-run fixture');
assert.equal(matchesResultIndex({ ...browserIndex, created: 'different-result-date' }, admitted.bundle), false, 'known artifact timestamp remains part of identity');
assert.equal(matchesResultIndex({ ...browserIndex, model: 'different-design' }, admitted.bundle), false, 'physical source design identity remains required');
const browserMatrix = sMatrix(admitted.bundle);
assert.deepEqual(browserMatrix.ports.map(p => physicalPortNumber(browserMatrix, p)), c.physical_ports, 'validation preserves physical ports 7,2,19');
assert.equal(portProcessingEligibility(admitted.bundle).error, null, 'exact admitted fixture retains its complete physical matrix');
const incompleteBrowser = portProcessingBrowserFixture(geometry, c);
delete incompleteBrowser.results.sparams.s['1,2'];
const admittedIncomplete = validateBundle(incompleteBrowser).bundle;
assert.ok(admittedIncomplete, 'incomplete browser control is viewable');
assert.equal(portProcessingEligibility(admittedIncomplete).error, 'matrix', 'incomplete browser control remains ineligible for transformation');
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
  const exported = resultDataCsv(table), expected = [table.header, ...table.rows.map(row => row.map(value => String(value ?? '')))];
  assert.ok(exported.includes('\r\n'), 'actual result CSV uses CRLF record terminators');
  assert.deepEqual(parseCsv(exported), expected, 'CRLF parsing preserves the exact final provenance header and cells');
  assert.deepEqual(parseCsv(exported.replaceAll('\r\n', '\n')), expected, 'LF parsing retains the same fields');
}
// Record terminators are not cell content; commas, escaped quotes, spaces and empty
// trailing cells remain content and must not be stripped by a broad trim workaround.
assert.deepEqual(parseCsv('label,last\r\n"x,y"," a ""quoted"" value "\r\nempty,\r\n'),
  [['label','last'],['x,y',' a "quoted" value '],['empty','']]);
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
  [b=>b.results.sparams.z_ref=[{real:35,imag:10},50,90],'reference'],
  [b=>b.results.ports['7'].z_ref=50,'reference'],
  [b=>b.results.frequency[1]=b.results.frequency[0],'frequency'],
]) { const b=structuredClone(circuit); edit(b); assert.equal(portProcessingEligibility(b).error,error); assert.equal(postprocessPorts(b,options(b,75)).bundle,null); }
const allMissing=structuredClone(one); allMissing.results.sparams.s['1,1'].re.fill(NaN);
assert.equal(postprocessPorts(allMissing,options(allMissing,75)).error,'noSamples');
assert.equal(postprocessPorts(one,options(one,75,{7:1e100})).error,'settings');
assert.deepEqual(circuit,untouched);

// Complex references: independent physical load formula, including the short's non-(-1)
// power reflection and the finite-load conjugate match. Z recovery must undo -j Im(Zref).
const divide = (a,b) => { const d=b[0]**2+b[1]**2; return [(a[0]*b[0]+a[1]*b[1])/d,(a[1]*b[0]-a[0]*b[1])/d]; };
for (const target of [[75,25],[10,-80]]) for (const load of [[75,-25],[10,80],[0,0],[120,31],[-20,10]]) {
  const native = divide([load[0]-50,load[1]],[load[0]+50,load[1]]);
  const b = matrixBundle([1e9],[50],[[[native]]],[19]);
  const out = transform(b,{...options(b,target[0]),referenceImagOhm:target[1]});
  const g = sMatrix(out).get(1,1), expected = divide([load[0]-target[0],load[1]+target[1]],[load[0]+target[0],load[1]+target[1]]);
  near(g.re[0],expected[0]); near(g.im[0],expected[1]);
  near(sweep(out).zRe[0],load[0]); near(sweep(out).zIm[0],load[1]);
  assert.ok(hasComplexPortReference(out)); assert.ok(Number.isNaN(sweep(out).vswr[0]));
  assert.equal(resultDataTable(out,'vswr').rows.length,0); assert.equal(resultDataTable(out,'smith').rows.length,0);
  near(resultDataTable(out,'impedance').rows[0][1],load[0]);
  assert.equal(touchstoneNPort(out),null); assert.equal(touchstoneS1p(out),null);
  await assert.rejects(exportResultTouchstone(out,'complex-control'),/Touchstone/,'complex reference must fail before any download path');
}
const open = matrixBundle([1e9],[50],[[[[1,0]]]],[7]);
const complexOpen = transform(open,{...options(open,75),referenceImagOhm:25});
near(sMatrix(complexOpen).get(1,1).re[0],1); near(sMatrix(complexOpen).get(1,1).im[0],0);
assert.ok(Number.isNaN(sweep(complexOpen).zRe[0]),'an exact open has valid S and no finite Z');
assert.equal(activeResultDataTable(one,'smith',undefined,[{file:'raw',bundle:one},{file:'complex',bundle:complexOpen}]).rows.length,0);

// Independent nonsymmetric nodal circuit solves at unequal real source references and a
// common complex target. No production transform or inverse generates these expectations.
const nodal = JSON.parse(readFileSync(new URL('./fixtures/port-power-wave.json',import.meta.url)));
const nb = matrixBundle(nodal.frequency_hz,nodal.source_references_ohm,nodal.source,nodal.physical_ports);
const nbSnapshot = structuredClone(nb); freeze(nb);
const complexN = transform(nb,{...options(nb,75),referenceImagOhm:25});
const cn = sMatrix(complexN);
nodal.target.forEach((matrix,k)=>matrix.forEach((row,i)=>row.forEach((z,j)=>{
  near(cn.get(i+1,j+1).re[k],z[0]); near(cn.get(i+1,j+1).im[k],z[1]);
})));
assert.notEqual(cn.get(1,2).re[0],cn.get(2,1).re[0],'measured nonreciprocity is never symmetrized');
assert.deepEqual(nb,nbSnapshot); assert.equal(complexN.results.farfield,nb.results.farfield);

// Mixed-mode known ideal through. Differential V=Vp-Vn, I=(Ip-In)/2 -> 2Z;
// common V=(Vp+Vn)/2, I=Ip+In -> Z/2. The 2-port through is an exact modal short/open.
const modalThrough = transform(through,{...options(through,50),mixedPairs:[[7,19]]}), mt = sMatrix(modalThrough);
assert.deepEqual(mt.zRef,[100,25]); assert.deepEqual(mt.ports.map(p=>physicalPortNumber(mt,p)),[null,null]);
for (let k=0;k<3;k++) { near(mt.get(1,1).re[k],-1); near(mt.get(2,2).re[k],1); near(mt.get(1,2).re[k],0); near(mt.get(2,1).re[k],0); }
assert.match(primaryPortLabel(modalThrough),/^Sdd11/); assert.match(mappedPairLabel(mt,[2,1]),/^Scd11/);
assert.ok(hasMixedPortCoordinates(modalThrough)); near(sweep(modalThrough).zRe[0],0);
assert.deepEqual(modalThrough.results.ports,through.results.ports,'modal coordinates do not replace physical-port evidence');
const annotated=structuredClone(circuit);
annotated.ports[0].reference_impedance={real:20,imag:-150};
annotated.results.ports['7'].power_wave_reference={real:20,imag:-150,gamma_re:[999,999,999],gamma_im:[999,999,999]};
assert.equal(portProcessingEligibility(annotated).error,null,'optional chip matching annotation is not native S normalization');
for (const pairs of [[],[[7,19]]]) {
  const out=transform(annotated,{...options(annotated,75),referenceImagOhm:25,mixedPairs:pairs});
  assert.equal(Object.hasOwn(out.results.ports['7'],'power_wave_reference'),false,'stale chip gamma cannot leak into a transformed view');
  assert.equal(annotated.results.ports['7'].power_wave_reference.gamma_re[0],999,'raw annotation remains immutable');
}
const four=matrixBundle([1e9],[50,50,50,50],[[[[0,0],[1,0],[0,0],[0,0]],[[1,0],[0,0],[0,0],[0,0]],[[0,0],[0,0],[0,0],[1,0]],[[0,0],[0,0],[1,0],[0,0]]]], [7,2,19,5]);
const fourMode=sMatrix(transform(four,{...options(four,50),mixedPairs:[[7,2],[19,5]]}));
assert.deepEqual(fourMode.zRef,[100,100,25,25]);
for(let i=0;i<4;i++)for(let j=0;j<4;j++) { near(fourMode.get(i+1,j+1).re[0],i===j?(i<2?-1:1):0); near(fourMode.get(i+1,j+1).im[0],0); }

// Explicit sums/differences against the independent 3-port target circuit. P7,P19 is
// canonical pair1,3, not pair1,2. Reversing it flips D-to-other signs but not DD or CC.
const mixed = transform(circuit,{...options(circuit,75),mixedPairs:[[7,19]]}), mm=sMatrix(mixed);
const flipped = sMatrix(transform(circuit,{...options(circuit,75),mixedPairs:[[19,7]]}));
assert.deepEqual(mm.zRef,[150,37.5,75]); assert.deepEqual(mm.ports.map(p=>physicalPortNumber(mm,p)),[null,null,2]);
for (let k=0;k<c.frequency_hz.length;k++) for(let q=0;q<2;q++) {
  const a=c.target[k], expected=[
    [(a[0][0][q]-a[0][2][q]-a[2][0][q]+a[2][2][q])/2,(a[0][0][q]+a[0][2][q]-a[2][0][q]-a[2][2][q])/2,(a[0][1][q]-a[2][1][q])*Math.SQRT1_2],
    [(a[0][0][q]-a[0][2][q]+a[2][0][q]-a[2][2][q])/2,(a[0][0][q]+a[0][2][q]+a[2][0][q]+a[2][2][q])/2,(a[0][1][q]+a[2][1][q])*Math.SQRT1_2],
    [(a[1][0][q]-a[1][2][q])*Math.SQRT1_2,(a[1][0][q]+a[1][2][q])*Math.SQRT1_2,a[1][1][q]]];
  for(let i=0;i<3;i++)for(let j=0;j<3;j++) {
    const values=q===0?'re':'im'; near(mm.get(i+1,j+1)[values][k],expected[i][j]);
    near(flipped.get(i+1,j+1)[values][k],expected[i][j]*(i===0?-1:1)*(j===0?-1:1));
  }
}
const mixedComplex=transform(nb,{...options(nb,75),referenceImagOhm:25,mixedPairs:[[7,19]]});
assert.deepEqual(sMatrix(mixedComplex).zRefImag,[50,12.5,25]);
assert.equal(touchstoneNPort(mixedComplex),null); assert.ok(Number.isNaN(sweep(mixedComplex).vswr[0]));
const mixedGap=transform(gap,{...options(gap,75),mixedPairs:[[7,19]]});
assert.equal(portProcessingInfo(mixedGap).missingSamples,1); assert.ok(Number.isNaN(sMatrix(mixedGap).get(1,2).re[1]));
for(const pairs of [[[7,7]],[[7,19],[19,2]],[[7,99]],[[7]],[[7,19,2]],[['7',19]],null]) {
  assert.equal(postprocessPorts(circuit,{...options(circuit,75),mixedPairs:pairs}).error,'pairs');
}
for (const invalid of [NaN,Infinity,null,'25']) assert.equal(postprocessPorts(circuit,{...options(circuit,75),referenceImagOhm:invalid}).error,'settings');
// The primary reflection and summary must describe D1, not a stale physical S11.
const mixedData=resultDataTable(mixed,'sparams',undefined,{format:'re_im'});
assert.match(mixedData.header[1],/^Re Sdd11/); near(mixedData.rows[0][1],mm.get(1,1).re[0]);
near(sweep(mixed).s11Re[0],mm.get(1,1).re[0]);
const modalSummary=summaryTable([{file:'modal',label:'Modal',bundle:mixed},{file:'raw',label:'Raw',bundle:circuit}],{deltas:true});
assert.equal(modalSummary.header.filter(header=>header==='Network reflection').length,1,'the modal coordinate label has one semantic column');
const networkReflectionColumn=modalSummary.header.indexOf('Network reflection');
assert.match(modalSummary.rows[0][networkReflectionColumn],/^Sdd11/); assert.equal(modalSummary.rows[1][networkReflectionColumn],'S11');
assert.equal(modalSummary.rows[1][modalSummary.header.indexOf('Δ |Network reflection| min (dB)')],null,'unlike coordinates cannot imply improvement');

// Independent limited Touchstone2 decoder for the exported Full RI grammar (not the
// application importer, which deliberately does not support modal imports yet).
function decodeModal(text,n,descriptors,ref) {
  assert.match(text,/^\[Version\] 2\.0/m); assert.match(text,/^\[Matrix Format\] Full/m);
  assert.equal(text.match(/^\[Mixed-Mode Order\] (.*)$/m)[1],descriptors);
  assert.deepEqual(text.match(/^\[Reference\] (.*)$/m)[1].split(/\s+/).map(Number),Array(n).fill(ref));
  if(n===2)assert.match(text,/^\[Two-Port Data Order\] 12_21/m);
  const rows=text.split('[Network Data]\n')[1].split('[End]')[0].trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
  rows.forEach(row=>{assert.equal(row.length,1+2*n*n);assert.ok(row.every(Number.isFinite));}); return rows;
}
const modalText=touchstoneNPort(mixed,'synthetic control');
assert.match(modalText,/1 -> 7, 2 -> 2, 3 -> 19/); assert.match(modalText,/D1\(P7-P19\)/);
const modalRows=decodeModal(modalText,3,'D1,3 C1,3 S2',75);
modalRows.forEach((row,k)=>{near(row[0],c.frequency_hz[k]);for(let i=0;i<3;i++)for(let j=0;j<3;j++){
  near(row[1+2*(i*3+j)],mm.get(i+1,j+1).re[k],6e-8); near(row[2+2*(i*3+j)],mm.get(i+1,j+1).im[k],6e-8);
}});
decodeModal(touchstoneNPort(modalThrough),2,'D1,2 C1,2',50);
assert.equal(touchstoneNPort(mixedGap),null);
console.log(`PASS port postprocessing: ${checks} numeric comparisons plus mapping, provenance, gaps, refusal, raw identity and session controls; no browser or solver.`);
