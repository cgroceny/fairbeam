// Synthetic Ludwig-3/codec/schema controls. No native imports, build, browser or propagation.
// node --experimental-strip-types scripts/check-ludwig.mjs
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {complexFieldPort, readComplexFarField, ludwigGrids, ludwigReadouts, normalizeLudwigReference} from '../src/lib/ludwig.ts';
import {effectiveQuantity, quantityAvailability, quantityGrid, quantityMax, quantityOffsetDb, quantityRange, quantityUnit} from '../src/lib/farfieldQuantity.ts';
import {validateBundle} from '../src/lib/validate.ts';
import {registerPortProjection} from '../src/lib/portProcessingMetadata.ts';
import {resultDataTable} from '../src/designer/resultData.ts';
import {farfieldCsv, patternCsv} from '../src/export/csv.ts';
import {selectedPatternFigure} from '../src/drawing/charts.ts';
import {supportsPatternMetrics} from '../src/lib/patternMetrics.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.env.FAIRBEAM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const raw = JSON.parse(execFileSync(python, ['python/tests/test_farfield_fields.py', '--json'], {cwd: root, encoding: 'utf8'}));
const baseline = JSON.parse(readFileSync(new URL('../public/projects/helix-axial.json', import.meta.url), 'utf8'));
const bundle = ff => {const b = structuredClone(baseline); b.results.farfield = [structuredClone(ff)]; return b;};
const named = name => raw.find(ff => ff.name === name);
let checks = 0;
const near = (got, want, tolerance = .001) => { checks++; assert.ok(Number.isFinite(got) && Math.abs(got - want) <= tolerance, `${got} ≈ ${want} ± ${tolerance}`); };
const ok = (value, message) => { checks++; assert.ok(value, message); };
const same = (got, want) => { checks++; assert.deepEqual(got, want); };

for (const ff of raw) {
  const b = bundle(ff), v = validateBundle(b);
  same(v.errors, []);
  ok(v.bundle.results.farfield[0].fields, `${ff.name}: codec and metadata accepted`);
  ok(readComplexFarField(ff), `${ff.name}: exact Python writer payload admitted`);
}
const linear = named('linear-x'), b = bundle(linear), g = ludwigGrids(linear);
for (let i = 0; i < 3; i++) for (let j = 0; j < linear.phi.length; j++) {
  near(g.co[i][j], 10); near(g.cross[i][j], -50); near(g.xpd[i][j], 60);
  const rotated = ludwigGrids(linear, 90);
  near(rotated.co[i][j], -50); near(rotated.cross[i][j], 10); near(rotated.xpd[i][j], -60);
  const halfway = ludwigGrids(linear, 45);
  near(halfway.co[i][j], 10 - 10 * Math.log10(2)); near(halfway.cross[i][j], halfway.co[i][j]); near(halfway.xpd[i][j], 0);
}
for (const q of ['co', 'cross', 'xpd']) {
  ok(quantityAvailability(b, linear, q).ok);
  same(quantityGrid(b, linear, q, 90), ludwigGrids(linear, 90)[q]);
  same(quantityUnit(q), q === 'xpd' ? 'dB' : 'dBi');
}
same(quantityMax(b, linear, 'xpd'), 60); same(quantityRange('xpd'), 120); same(quantityOffsetDb(b, linear, 'xpd'), null);
same(quantityMax(b, linear, 'co'), linear.dmax_dbi); same(quantityOffsetDb(b, linear, 'cross'), 0);
same(normalizeLudwigReference(210), 30); same(normalizeLudwigReference(-30), 150);
ok(Number.isNaN(normalizeLudwigReference(NaN)));
ok(ludwigGrids(linear, Infinity).co.flat().every(Number.isNaN));
const c = ludwigGrids(named('circular'), 37);
near(c.co[0][0], 10 - 10 * Math.log10(2)); near(c.cross[0][0], c.co[0][0]); near(c.xpd[0][0], 0);
near(ludwigGrids(named('in-phase')).co[0][1], -50); // destructive interference survives complex rotation
near(ludwigGrids(named('in-phase')).cross[0][1], 10);
ok(c.cross[0][0] > -50, 'circular polarization is not cross-polar-zero at beam center');
for (const name of ['complex', 'phase', 'tiny', 'huge']) {
  const ff = named(name), out = ludwigGrids(ff, 23), ref = ludwigGrids(named('complex'), 23);
  for (let i = 0; i < 3; i++) for (let j = 0; j < ff.phi.length; j++) {
    for (const q of ['co', 'cross', 'xpd']) near(out[q][i][j], ref[q][i][j], .003);
    near(10 ** (out.co[i][j] / 10) + 10 ** (out.cross[i][j] / 10), 10, .002);
  }
}
const mirrored = ludwigGrids(named('mirror'));
near(mirrored.co[0][0] - g.co[0][0], 10 * Math.log10(2), 1e-8);
near(mirrored.xpd[0][0], g.xpd[0][0]);
same(ludwigGrids(named('zero')).co.flat().every(Number.isNaN), true);
same(ludwigReadouts(named('zero')), {peak: null, boresight: null});
const low = ludwigGrids(named('low'));
near(low.xpd[0][1], 0); ok(Number.isNaN(low.xpd[0][2]), 'weak field masked before cut interpolation');
ok(Number.isNaN(low.co[0][3]), 'zero field is not a numeric floor');
ok(Number.isFinite(low.co[0][4]), 'weak nonzero co field may be floored');
ok(g.co[3].every(Number.isNaN), 'south pole singularity is explicitly missing');
ok(ludwigReadouts(linear).boresight !== null);
const noPole = structuredClone(linear); noPole.theta[0] = 5;
same(ludwigReadouts(noPole).boresight, null);
const cropped = structuredClone(named('croppable'));
cropped.theta.shift(); cropped.directivity_dbi.shift(); cropped.fields.shape[0]--;
for (const key of ['e_theta_re', 'e_theta_im', 'e_phi_re', 'e_phi_im'])
  cropped.fields[key] = Buffer.from(cropped.fields[key], 'base64').subarray(cropped.phi.length * 2).toString('base64');
same(cropped.fields.scale, 1); same(cropped.fields.power_peak, 2); // max individual component remains; total-power peak was lost
same(readComplexFarField(cropped), null);
ok(ludwigGrids(cropped).co.flat().every(Number.isNaN), 'cropped peak cannot inflate retained scalar D=6.99 into co=10 dBi');
const old = structuredClone(linear); delete old.fields;
ok(!quantityAvailability(bundle(old), old, 'co').ok); same(effectiveQuantity(bundle(old), old, 'co'), 'directivity');
ok(quantityGrid(bundle(old), old, 'xpd').flat().every(Number.isNaN), 'missing XPD never becomes scalar directivity');

const corruptions = [
  ff => ff.fields.schema = 'fairbeam.farfield-fields/2', ff => ff.fields.encoding = 'f32le-base64',
  ff => ff.fields.f += 1, ff => ff.fields.mirror_planes = 2, ff => delete ff.mirror_planes,
  ff => ff.fields.basis = 'cartesian', ff => ff.fields.normalization = 'matched-incident-waves',
  ff => ff.fields.radius_m = 0, ff => ff.fields.phase_center_m = [0, 0, NaN],
  ff => delete ff.fields.power_peak, ff => ff.fields.power_peak = 2,
  ff => ff.fields.shape[1]++, ff => ff.fields.scale = Infinity, ff => ff.fields.scale = -1,
  ff => ff.fields.scale = 0, ff => ff.theta[1] = ff.theta[0], ff => ff.phi[0] = -1,
  ff => ff.fields.e_theta_re += 'AAAA', ff => ff.fields.e_theta_re = ff.fields.e_theta_re.slice(4),
  ff => ff.fields.e_phi_im = ' '.repeat(ff.fields.e_phi_im.length),
  ff => { const v = Buffer.from(ff.fields.e_theta_re, 'base64'); v.writeInt16LE(-32768, 0); ff.fields.e_theta_re = v.toString('base64'); },
  ff => { for (const k of ['e_theta_re', 'e_theta_im', 'e_phi_re', 'e_phi_im']) ff.fields[k] = Buffer.alloc(ff.theta.length * ff.phi.length * 2).toString('base64'); },
];
for (const corrupt of corruptions) {
  const ff = structuredClone(linear); corrupt(ff);
  same(readComplexFarField(ff), null);
  const v = validateBundle(bundle(ff));
  same(v.errors, []); ok(!v.bundle.results.farfield[0].fields); ok(v.warnings.length > 0);
}
const tooMany = bundle(linear); tooMany.results.farfield = Array.from({length: 17}, () => structuredClone(linear));
const checked = validateBundle(tooMany);
same(checked.bundle.results.farfield.filter(ff => ff.fields).length, 16);
same(checked.bundle.results.farfield.length, 17); // invalid optional storage cannot erase valid scalar evidence
const perPort = bundle(linear); perPort.results.farfield = Array.from({length: 32}, (_, i) => ({...structuredClone(linear), port: i < 16 ? 1 : 2}));
perPort.ports = [structuredClone(baseline.ports[0]), {...structuredClone(baseline.ports[0]), number: 2, excite: false}];
perPort.results.ports['2'] = structuredClone(perPort.results.ports['1']);
perPort.results.sparams = {ports: [1, 2], excited: [1, 2], complete: true};
same(validateBundle(perPort).bundle.results.farfield.filter(ff => ff.fields).length, 32);
for (const id of [0, -1, 1.5, '1', null, 999]) {
  const wrong = bundle(linear); wrong.results.farfield[0].port = id;
  same(complexFieldPort(wrong, wrong.results.farfield[0]), null);
  ok(!validateBundle(wrong).bundle.results.farfield[0].fields, `invalid/unknown port ${id} drops only optional fields`);
}
const missingIdentity = bundle(linear); delete missingIdentity.ports[0].number;
ok(!validateBundle(missingIdentity).bundle.results.farfield[0].fields, 'legacy auto-number repair cannot establish field provenance');
const absentExcitation = bundle(linear); delete absentExcitation.ports[0].excite;
ok(validateBundle(structuredClone(absentExcitation)).bundle.results.farfield[0].fields, "explicit S-parameter excitation metadata can identify the source");
delete absentExcitation.results.sparams;
ok(!validateBundle(absentExcitation).bundle.results.farfield[0].fields);
const duplicateIdentity = bundle(linear); duplicateIdentity.ports.push(structuredClone(duplicateIdentity.ports[0]));
ok(!validateBundle(duplicateIdentity).bundle.results.farfield[0].fields);
const mixedIdentity = bundle(linear); mixedIdentity.results.farfield = Array.from({length: 17}, (_, i) => ({...structuredClone(linear), ...(i % 2 ? {port: 1} : {})}));
same(validateBundle(mixedIdentity).bundle.results.farfield.filter(ff => ff.fields).length, 16, 'omitted and explicit original port share one budget');
const noncontiguous = structuredClone(perPort);
noncontiguous.ports[0].number = 3; noncontiguous.ports[1].number = 7;
noncontiguous.results.sparams.port_numbers = [7, 3];
noncontiguous.results.sparams.excited = [1]; noncontiguous.results.sparams.complete = false;
noncontiguous.results.ports = {'7': structuredClone(baseline.results.ports['1'])};
noncontiguous.results.farfield = [{...structuredClone(linear), port: 7}];
same(complexFieldPort(noncontiguous, noncontiguous.results.farfield[0]), 7);
ok(validateBundle(noncontiguous).bundle.results.farfield[0].fields, 'matrix index maps to noncontiguous physical port');
const wrongColumn = structuredClone(noncontiguous); wrongColumn.results.farfield[0].port = 3;
ok(!validateBundle(wrongColumn).bundle.results.farfield[0].fields, 'unexcited physical port cannot borrow a field');
const ambiguous = structuredClone(perPort); ambiguous.results.farfield = [structuredClone(linear)];
ok(!validateBundle(ambiguous).bundle.results.farfield[0].fields, 'omitted port is rejected when multiple driven ports are declared');
const filteredModel = bundle(linear); delete filteredModel.results.sparams;
filteredModel.ports.push({...structuredClone(filteredModel.ports[0]), number: 2, excite: true, start: []});
ok(!validateBundle(filteredModel).bundle.results.farfield[0].fields, 'dropping invalid geometry cannot turn original ambiguous excitation into a unique source');
const source = bundle(linear), projected = structuredClone(source);
projected.ports[0].number = 99; projected.results.ports = {};
registerPortProjection(projected, {source, settings: {referenceOhm: 50, delayPs: {}}, physicalPorts: [1],
  sourceReferences: [50], missingSamples: 0, description: 'synthetic network-only view', channels: [], primaryIndex: 1});
same(complexFieldPort(projected, linear), null);
ok(quantityAvailability(projected, linear, 'co').ok, 'view-only network transformations retain original radiation provenance');
same(quantityGrid(projected, linear, 'co', 23), quantityGrid(source, linear, 'co', 23));
// Exercise both allocation guards independently of the 16-frequency guard.
const overGrid = structuredClone(linear);
overGrid.theta = Array.from({length: 257}, (_, i) => i * 180 / 256);
overGrid.phi = Array.from({length: 256}, (_, i) => i * 360 / 256);
overGrid.fields.shape = [257, 256];
same(readComplexFarField(overGrid), null);
const full = structuredClone(linear);
full.theta = Array.from({length: 256}, (_, i) => i * 180 / 255);
full.phi = Array.from({length: 256}, (_, i) => i * 360 / 256);
full.directivity_dbi = full.theta.map(() => full.phi.map(() => -50));
full.directivity_dbi[0][0] = 10;
full.fields.shape = [256, 256]; full.fields.scale = 1;
const bytes = Buffer.alloc(65536 * 2);
for (const key of ['e_theta_re', 'e_theta_im', 'e_phi_re', 'e_phi_im']) full.fields[key] = bytes.toString('base64');
bytes.writeInt16LE(32767, 0); full.fields.e_theta_re = bytes.toString('base64');
ok(readComplexFarField(full), 'single frequency at cell boundary is admitted');
const cellBudget = bundle(full); cellBudget.results.farfield = Array.from({length: 5}, () => structuredClone(full));
same(validateBundle(cellBudget).bundle.results.farfield.filter(ff => ff.fields).length, 4);
// Pure exports consume the chosen reference explicitly, with units, gaps and bounds retained.
for (const q of ['co', 'cross', 'xpd']) {
  const table = resultDataTable(b, 'pattern', linear.f, {patternQuantity: q, ludwigReferenceDeg: 45});
  const valueIndex = table.header.findIndex(h => h === `${q === 'co' ? 'Ludwig-3 co-polar' : q === 'cross' ? 'Ludwig-3 cross-polar' : 'Cross-polar discrimination (XPD)'} (${q === 'xpd' ? 'dB' : 'dBi'})`);
  ok(valueIndex >= 0, `export names ${q} and its unit`);
  near(table.rows[0][valueIndex], q === 'xpd' ? 0 : 10 - 10 * Math.log10(2));
  same(table.rows[0][table.header.indexOf('Ludwig reference (deg)')], 45);
  same(table.rows.at(-1)[valueIndex], null, 'missing south pole stays an empty cell');
  ok(table.rows[0].includes('Stored physical-space Dmax and native power_peak; mirror correction applied once; int16 relative phase'));
  const cuts = resultDataTable(b, 'pattern', linear.f, {patternQuantity: q, ludwigReferenceDeg: 90, patternCut: {kind: 'conical', angle: 90}});
  same(cuts.rows[0][cuts.header.indexOf('Ludwig reference (deg)')], 90);
  if (q === 'xpd') {
    same(cuts.rows[0][cuts.header.indexOf('HPBW estimate (deg)')], null);
    same(cuts.rows[0][cuts.header.indexOf('HPBW status')], 'quantity');
  }
  for (const projection of ['cartesian', 'polar']) {
    const svg = selectedPatternFigure(b, linear, {kind: 'conical', angle: 90}, q, projection, {ludwigReferenceDeg: 45});
    ok(svg?.includes('Reference alpha=45 deg.'));
    ok(svg.includes('power_peak') && svg.includes('peak-20 dB') && svg.includes('+/-60 dB'));
    ok(!/\b(?:NaN|Infinity)\b/.test(svg), 'masked samples do not become invalid SVG coordinates');
    if (q === 'xpd') ok(svg.includes('HPBW/SLL/F/B do not apply'));
  }
}
same(supportsPatternMetrics('co'), true); same(supportsPatternMetrics('cross'), true); same(supportsPatternMetrics('xpd'), false);
const exported = patternCsv(linear, 90);
ok(exported.includes('ludwig_co_dBi,ludwig_cross_dBi,xpd_dB,Ludwig reference (deg)'));
const exportRow = exported.split('\n')[1].split(',');
near(Number(exportRow[3]), -50); near(Number(exportRow[4]), 10); near(Number(exportRow[5]), -60); same(Number(exportRow[6]), 90);
ok(exported.split('\n').find(row => row.startsWith('180,'))?.includes(',,,,90,'), 'masked raw CSV values are empty, not NaN');
const summaryCsv = farfieldCsv(b, 45);
ok(summaryCsv.includes('ludwig_boresight_xpd_dB') && summaryCsv.includes(',45,Ludwig-3;'));
const oldExport = structuredClone(linear); delete oldExport.fields;
same(patternCsv(oldExport, 45), patternCsv(oldExport, 0));
ok(!farfieldCsv(bundle(oldExport), 45).includes('Ludwig reference'));
console.log(`PASS ${checks} synthetic Ludwig-3/codec/schema/export controls; no antenna/native measurement or browser test.`);
