// Analytic synthetic controls only: no browser, server, solver or build.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeCut, thetaCut, samplePattern, patternMetrics } from '../src/lib/patternMetrics.ts';
import { resultDataTable } from '../src/designer/resultData.ts';
import { compareCuts, traces } from '../src/compare/series.ts';
import { selectedPatternFigure, lineChartSvg } from '../src/drawing/charts.ts';
import { quantityGrid } from '../src/lib/farfieldQuantity.ts';
const near = (a, b, message, tolerance = 1e-10) => assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);
const theta = [0, 30, 60, 90, 120, 150, 180];
const phi = Array.from({ length: 36 }, (_, i) => i * 10);
const rad = Math.PI / 180;
const asymmetric = theta.map(t => phi.map(p => 20 * Math.cos(t * rad) + 5 * Math.sin(t * rad) * Math.cos(p * rad)));
const before = structuredClone(asymmetric);
const cone = thetaCut(theta, phi, asymmetric, 60);
const metrics = patternMetrics(cone, theta, phi, asymmetric);
for (const quantity of ['axial_ratio', 'unknown_future_quantity']) {
  const noLobes = patternMetrics(cone, theta, phi, asymmetric, false, quantity);
  assert.equal(noLobes.peak, null); assert.equal(noLobes.hpbw.reason, 'quantity');
  assert.equal(noLobes.sll.reason, 'quantity'); assert.equal(noLobes.frontBack.reason, 'quantity');
}
near(metrics.peak.theta, 60, 'conical peak has the chosen theta');
near(metrics.peak.phi, 0, 'asymmetric conical peak azimuth');
near(metrics.frontBack.value, 20 + 5 * Math.sqrt(3), 'F/B uses theta120 phi180, not theta60 phi180');
const lowerCone = patternMetrics(thetaCut(theta, phi, asymmetric, 120), theta, phi, asymmetric);
near(lowerCone.frontBack.value, -20 + 5 * Math.sqrt(3), 'F/B may be negative when the actual antipode is stronger');
assert.ok(Math.abs(metrics.frontBack.value - 5 * Math.sqrt(3)) > 19, 'same-theta opposite-phi shortcut would fail');
assert.deepEqual(asymmetric, before, 'sampling never changes the source');
assert.equal(thetaCut(theta, phi, asymmetric, 120, true).angle.length, 0, 'half-space lower hemisphere is not invented');
assert.equal(thetaCut([0, 45, 90], phi, asymmetric.slice(0, 3), 100).angle.length, 0, 'no theta extrapolation');
assert.equal(thetaCut(theta, [0], theta.map(() => [1]), 60).angle.length, 0, 'one azimuth does not imply circular coverage');
assert.equal(thetaCut([0, 30, 30], phi, asymmetric.slice(0, 3), 20).angle.length, 0, 'duplicate theta refused');
for (const p of [[0, 360], [0, 90, 90], [-1, 90], [90, 0]]) assert.equal(thetaCut(theta, p, asymmetric, 60).angle.length, 0, 'invalid phi grid refused');

const irregularPhi = [0, 11, 23, 200, 350];
const linear = [[0, 11, 23, 200, 350], [10, 21, 33, 210, 360]];
near(samplePattern([0, 90], irregularPhi, linear, 45, 17), 22, 'two-axis adjacent interpolation');
near(samplePattern([0, 90], irregularPhi, linear, 45, 355), 180, 'actual periodic seam span');
near(samplePattern([0, 90], irregularPhi, linear, 0, 23), 23, 'exact samples retained');
const gap = structuredClone(linear); gap[0][1] = NaN;
assert.ok(Number.isNaN(samplePattern([0, 90], irregularPhi, gap, 45, 17)), 'adjacent phi gap is not crossed');
assert.ok(Number.isNaN(samplePattern([0, 90], irregularPhi, gap, 45, 11)), 'adjacent theta gap is not crossed');
near(samplePattern([0, 90], irregularPhi, gap, 90, 11), 21, 'unrelated row gap does not hide an exact valid sample');

const seam = theta.map(() => phi.map(p => -Math.abs(p - 180) / 10));
const seamMetrics = patternMetrics(thetaCut(theta, phi, seam, 90), theta, phi, seam);
near(seamMetrics.hpbw.value, 60, 'HPBW straddles the ±180 seam');
near(seamMetrics.peak.angle, -180, 'duplicate seam endpoint is not a competing maximum');

const ph = Array.from({ length: 12 }, (_, i) => i * 30);
const lobes = [0, -3, -20, -15, -25, -30, -35, -30, -25, -15, -20, -3];
const grid = theta.map(() => [...lobes]);
const measure = (g, half = false) => patternMetrics(thetaCut(theta, ph, g, 90, half), theta, ph, g, half);
near(measure(grid).hpbw.value, 60, 'analytic piecewise-linear -3 dB crossings');
near(measure(grid).sll.value, -15, 'separate local maxima outside main-lobe minima');
near(measure(grid).frontBack.value, 35, 'equatorial antipode');
const deep = theta.map(() => [0, -3, -60, -45, -60, -65, -70, -65, -60, -45, -60, -3]);
assert.deepEqual(measure(deep).sll, { value: null, reason: 'floor' }, 'explicit peak−40 floor does not substitute zero for a -45 dB sidelobe');
const outside = structuredClone(grid); outside[3][4] = NaN;
near(measure(outside).hpbw.value, 60, 'gap outside main lobe does not alter its resolved width');
assert.equal(measure(outside).sll.reason, 'gap', 'missing other angular samples prevent a global SLL estimate');
const inside = structuredClone(grid); inside[3][1] = NaN;
assert.equal(measure(inside).hpbw.reason, 'gap', 'gap inside main lobe blocks width');
const missingBack = structuredClone(grid); missingBack[3][6] = NaN;
assert.equal(measure(missingBack).frontBack.reason, 'antipode', 'missing antipode is not a huge F/B');
assert.equal(measure(grid, true).frontBack.reason, 'halfSpace', 'no back direction in half-space');
const flat = theta.map(() => ph.map(() => 0));
assert.equal(measure(flat).hpbw.reason, 'ambiguous', 'isotropic no unique peak');
const equal = structuredClone(grid); equal[3][6] = 0;
assert.equal(measure(equal).frontBack.reason, 'ambiguous', 'equal opposing peaks not called front/back');
const partial = analyzeCut([10, 30, 60], ph, grid.slice(0, 3), { kind: 'elevation', angle: 17 });
assert.ok(partial.angle.includes(-10), 'first negative theta sample retained without zenith');
assert.ok(Number.isNaN(partial.value[partial.angle.indexOf(0)]), 'missing zenith remains an explicit gap');

const bundle = JSON.parse(readFileSync(new URL('../examples/synthetic/array2x1.json', import.meta.url), 'utf8'));
const ff = { ...bundle.results.farfield[0], theta, phi, directivity_dbi: asymmetric, port: 1,
  dmax_dbi: 20, rad_efficiency: 0.5, gain_dbi: 20 + 10 * Math.log10(0.5),
  cp: { rhcp_dbi: asymmetric.map(r => r.map(v => v - 4)), lhcp_dbi: asymmetric.map(r => r.map(v => v - 7)), axial_ratio_db: asymmetric.map(r => r.map(() => 3)) } };
bundle.half_space = false; bundle.results.farfield = [ff];
for (const q of ['directivity', 'gain', 'realized', 'rhcp', 'lhcp']) {
  const selected = { kind: 'conical', angle: 60 };
  const table = resultDataTable(bundle, 'pattern', ff.f, { patternCut: selected, patternQuantity: q, patternPort: 1 });
  const row = table.rows.find(r => r[table.header.indexOf('phi (deg)')] === 0);
  near(row[table.header.findIndex(h => h.endsWith('(dBi)'))], quantityGrid(bundle, ff, q)[2][0], `${q} plotted quantity is exported`);
  if (q === 'rhcp' || q === 'lhcp') near(row[table.header.findIndex(h => h.endsWith('(dBi)'))], asymmetric[2][0] - (q === 'rhcp' ? 4 : 7), `${q} partial directivity is not a fallback`);
  if (q === 'gain') near(row[table.header.findIndex(h => h.endsWith('(dBi)'))], asymmetric[2][0] + 10 * Math.log10(0.5), 'gain uses physical efficiency');
  near(row[table.header.indexOf('Peak / 3D antipode (dB)')], 20 + 5 * Math.sqrt(3), `${q} F/B estimate retained in CSV`);
  for (const projection of ['polar', 'cartesian']) {
    const svg = selectedPatternFigure(bundle, ff, selected, q, projection);
    assert.ok(svg && !/NaN|Infinity/.test(svg), `${q}/${projection} finite figure`);
    assert.ok(svg.includes('3D antipode') && svg.includes('Grid-limited'), 'publication figure carries metric qualification');
    assert.ok(svg.includes('θ = 60°'), 'publication figure names selected conical angle');
    const visible = svg.replace(/<desc>[\s\S]*?<\/desc>/g, '');
    assert.ok(visible.includes('HPBW') && visible.includes('SLL') && visible.includes('F/B') && visible.includes('peak -40 dB'), 'readouts and detection floor remain visible in PDF rendering');
  }
}
const comparison = compareCuts(traces(bundle, []), ff.f, { kind: 'conical', angle: 60 }, ff);
assert.deepEqual(comparison[0].value, cone.value, 'compare reuses the exact same conical cut');
const other = structuredClone(bundle);
other.name = 'SYNTHETIC different radiation grid'; other.model.id = 'synthetic-other-cut';
other.results.farfield[0].f = ff.f * 1.02;
other.results.farfield[0].directivity_dbi = asymmetric.map(row => row.map(v => v - 2));
const pair = compareCuts(traces(bundle, [other]), ff.f, { kind: 'conical', angle: 60 }, ff);
assert.equal(pair.length, 2);
near(Math.max(...pair[0].value) - Math.max(...pair[1].value), 2, 'comparison preserves each grid identity');
assert.ok(pair[1].label.includes('GHz'), 'shifted comparison frequency is explicitly named');
other.results.farfield[0].port = 99;
assert.equal(compareCuts(traces(bundle, [other]), ff.f, { kind: 'conical', angle: 60 }, ff).length, 1, 'missing driven port does not borrow another pattern');
assert.deepEqual(analyzeCut(theta, phi, asymmetric, {kind:'elevation',angle:360}).value,
  analyzeCut(theta, phi, asymmetric, {kind:'elevation',angle:0}).value, '360° is the same plane as 0°');
assert.equal(resultDataTable(bundle, 'pattern').rows.length, theta.length * phi.length, 'unselected standard report data retain full raw grid');
const split = lineChartSvg({ width: 88, height: 60, title: 'SYNTHETIC gap', xLabel: 'deg', yLabel: 'dBi', series: [{label: 'gap', x: [0, 1, 2, 3, 4], y: [0, 1, NaN, 1, 0]}] });
assert.equal((split.match(/stroke-width="0.35"/g) ?? []).length, 2, 'Cartesian figure breaks at nonfinite gaps');
console.log('Pattern cuts: analytic interpolation, antipodes, seam HPBW, sidelobes/floor, gaps/ambiguity, quantities, compare, CSV and publication SVG controls passed. Synthetic data only.');
