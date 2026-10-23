// Pure command-line integration: no browser, server, solver, network or files written.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plotQuantities } from '../src/charts/plotQuantities.ts';
import { quantityDomain } from '../src/charts/quantityAxes.ts';
import { compareSParams, compareSParamQuantities, phaseComparisonGrid, traces } from '../src/compare/series.ts';
import { comparedResultDataTable, copyResultData, resultDataCsv, resultDataTable } from '../src/designer/resultData.ts';
import { formatForView, groupDelayAperture, readGroupDelayAperture, readResultDataFormat, writeGroupDelayAperture, writeResultDataFormat, GROUP_DELAY_APERTURE_KEY, RESULT_DATA_FORMAT_KEY } from '../src/designer/resultDataPreference.ts';

let assertions = 0;
const eq = (a, b, why) => { assertions++; assert.deepEqual(a, b, why); };
const near = (a, b, why) => { assertions++; assert.ok(Number.isFinite(a) && Math.abs(a - b) < 1e-10, `${why}: ${a} != ${b}`); };
const wave = (grid, delay, ripple = 0) => ({
  re: grid.map((f, i) => .5 * Math.cos((-360 * delay * f + ripple * Math.sin(i * Math.PI / 2)) * Math.PI / 180)),
  im: grid.map((f, i) => .5 * Math.sin((-360 * delay * f + ripple * Math.sin(i * Math.PI / 2)) * Math.PI / 180)),
});
const fixture = (name, grid, ripple = 0) => {
  const a = wave(grid, .2, ripple), b = wave(grid, .6, ripple);
  return { name, model: { id: name, name, params: [] }, ports: [{ number: 1, excite: true }, { number: 2, excite: false }],
    results: { frequency: grid.map(f => f * 1e9), bands: [], farfield: [], signals: {},
      ports: { '1': { s11_re: a.re, s11_im: a.im, zin_re: grid.map(() => 50), zin_im: grid.map(() => 0), z_ref: 50 } },
      sparams: { ports: [1, 2], z_ref: [50, 50], excited: [1], s: { '1,1': a, '2,1': b } } } };
};
const grid = Array.from({ length: 31 }, (_, i) => 1 + i / 20);
const a = fixture('A', grid), b = fixture('B', grid.map(f => f + .025)), pairs = [[1, 1], [2, 1]];
for (const format of ['gd', 'phase_unwrapped']) for (const aperturePoints of [3, 11]) {
  const options = { format, pairs, aperturePoints };
  const source = a.results.sparams.s['2,1'];
  const plot = plotQuantities([{ id: '2,1', label: 'S21', color: '--al-series-1', x: grid, ...source }], format, 'db', options)[0];
  eq(plot.key, format, 'new format has its own chart quantity');
  eq(plot.series[0].x, grid, 'single run uses its original grid');
  eq(quantityDomain(plot), undefined, 'continuous phase and delay are not clamped to wrapped-phase ticks');
  const table = resultDataTable(a, 'sparams', undefined, options);
  plot.series[0].y.forEach((v, i) => near(v, table.rows[i][2], 'plotted selected S21 equals numeric export'));
  if (format === 'gd') plot.series[0].y.forEach(v => near(v, .6, 'analytical S21 delay remains .6 ns'));
  else near(plot.series[0].y.at(-1) - plot.series[0].y[0], -360 * .6 * (grid.at(-1) - grid[0]), 'continuous phase retains full span');

  const compared = compareSParamQuantities(traces(a, [b]), pairs, format, 'db', options)[0];
  const exported = comparedResultDataTable([{ file: 'a.json', bundle: a }, { file: 'b.json', bundle: b }], 'sparams', undefined, options);
  eq(exported.rows.map(r => r[0]), compared.series[0].x, 'plot and export use the same union grid');
  eq(exported.header.length, 5, 'two requested pairs from each run keep identity');
  for (let s = 0; s < compared.series.length; s++) compared.series[s].y.forEach((v, i) => {
    if (Number.isFinite(v)) near(v, exported.rows[i][s + 1], 'compared plotted value equals exported value');
    else eq(exported.rows[i][s + 1], null, 'no extrapolated numeric cell');
  });
  eq(exported.rows[0][3], null, 'later-starting reference has blank cells before its range');
  assert.ok(!/NaN|Infinity/.test(resultDataCsv(exported))); assertions++;
}

const noisy = fixture('Noise', grid, 1.5);
const delays = points => resultDataTable(noisy, 'sparams', undefined, { format: 'gd', pairs: [[2, 1]], aperturePoints: points }).rows.map(r => r[1]);
const rms = ys => Math.sqrt(ys.slice(6, -6).reduce((sum, y) => sum + (y - .6) ** 2, 0) / (ys.length - 12));
assert.ok(rms(delays(11)) < rms(delays(3)), 'aperture changes the numeric derivative'); assertions++;
eq(resultDataTable(noisy, 'sparams', undefined, { format: 'phase_unwrapped', aperturePoints: 3 }),
  resultDataTable(noisy, 'sparams', undefined, { format: 'phase_unwrapped', aperturePoints: 11 }), 'aperture does not smooth or change phase');

const magnitudeOnly = fixture('Magnitude only', [1.01, 1.02, 1.03]);
magnitudeOnly.reference = { label: 'Magnitude only', phaseKnown: false };
const malformed = fixture('Invalid grid', [1, .9, 1.2]);
const sparse = fixture('Sparse invalid grid', [1.01, , 1.03]);
eq(phaseComparisonGrid([a, sparse]), phaseComparisonGrid([a]), 'sparse invalid reference cannot inject grid points');
for (const format of ['gd', 'phase_unwrapped']) {
  const original = compareSParamQuantities(traces(a, [b]), pairs, format)[0];
  const mixed = compareSParamQuantities(traces(a, [b, magnitudeOnly, malformed]), pairs, format)[0];
  eq(mixed.series.slice(0, 4), original.series, 'unavailable reference grids cannot change valid plotted phase or delay');
  eq(mixed.series.length, 6, 'magnitude-only traces are excluded; invalid complex traces retain warning identity');
  eq(mixed.phaseWarnings.includes('invalidGrid'), true, 'invalid complex source grid has a visible warning');
  eq(mixed.series.slice(4).every(s => s.y.every(Number.isNaN)), true, 'invalid grid is unavailable');
  const table = resultDataTable(magnitudeOnly, 'sparams', undefined, { format });
  eq(table.rows.every(r => r.slice(1).every(v => v === null)), true, 'magnitude-only source never fabricates phase cells');
  const copied = await copyResultData(magnitudeOnly, 'sparams', undefined, undefined, { format });
  eq(copied.ok, false, 'phase export of magnitude-only source is rejected before clipboard access');
  assert.match(copied.message, /phase/i); assertions++;
  eq(formatForView(format, false), 'plot', 'phase-derived format is scoped to S-parameter views');
  eq(resultDataTable(a, 'impedance', undefined, { format }), resultDataTable(a, 'impedance'), 'impedance export does not acquire a phase-derivative format');
}

const invalid = structuredClone(a);
invalid.results.sparams.s['2,1'].re[12] = 0;
invalid.results.sparams.s['2,1'].im[12] = 0;
const gaps = resultDataTable(invalid, 'sparams', undefined, { format: 'gd', pairs: [[2, 1]] });
eq(gaps.rows[12][1], null, 'undefined phase becomes an empty CSV cell');
assert.ok(resultDataCsv(gaps).includes(`${grid[12]},\r\n`)); assertions++;

// A derivative cannot inherit the legacy chart union's relative-frequency coalescing.
const narrowGrid = [1, 1 + 2.5e-10, 1 + 5e-10], narrow = fixture('Narrow grid', narrowGrid);
const roundTripGrid = narrow.results.frequency.map(f => f / 1e9);
eq(phaseComparisonGrid([narrow, narrow]), roundTripGrid, 'distinct close frequencies survive derived comparison');
const narrowPlot = compareSParamQuantities(traces(narrow, [narrow]), [[2, 1]], 'gd')[0];
eq(narrowPlot.series[0].y.every(Number.isFinite), true, 'close-frequency delay remains available');
const narrowCsv = comparedResultDataTable([{ file: 'n1', bundle: narrow }, { file: 'n2', bundle: narrow }], 'sparams', undefined, { format: 'gd', pairs: [[2, 1]] });
eq(narrowCsv.rows.map(r => r[1]), narrowPlot.series[0].y, 'close-frequency plot and export remain identical');

const halfTurn = fixture('Half turn', [0, 1, 2, 3]);
halfTurn.results.sparams.s['2,1'] = { re: [1, -1, -Math.SQRT1_2, 0], im: [0, 0, Math.SQRT1_2, 1] };
const wrappedHalf = compareSParams(traces(halfTurn, []), [[2, 1]], 'phase');
eq(wrappedHalf.series[0].y, [0, -180, 135, 90], 'existing wrapped-phase comparison retains measured half-turn sample');
const derivedHalf = compareSParamQuantities(traces(halfTurn, []), [[2, 1]], 'phase_unwrapped')[0];
eq(Number.isNaN(derivedHalf.series[0].y[1]), true, 'unwrapped direction of exact half-turn remains unavailable');

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const storage = new Map();
try {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) } });
  for (const format of ['gd', 'phase_unwrapped']) { writeResultDataFormat(format); eq(readResultDataFormat(), format, 'new format persists'); }
  for (const value of [3, 5, 11, 21]) { writeGroupDelayAperture(value); eq(groupDelayAperture(), value, 'aperture signal updates'); eq(readGroupDelayAperture(), value, 'aperture persists'); }
  writeGroupDelayAperture(4); eq(groupDelayAperture(), 21, 'UI rejects unavailable aperture');
  storage.set(GROUP_DELAY_APERTURE_KEY, '-3'); eq(readGroupDelayAperture(), 3, 'invalid stored aperture defaults');
  storage.set(RESULT_DATA_FORMAT_KEY, 'unknown'); eq(readResultDataFormat(), 'plot', 'invalid stored format defaults');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('storage blocked'); } });
  eq(readGroupDelayAperture(), 3, 'blocked storage has safe default');
  writeGroupDelayAperture(5); eq(groupDelayAperture(), 5, 'blocked storage does not disable control');
} finally {
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor); else delete globalThis.localStorage;
}
for (const language of ['en', 'tr']) {
  const messages = JSON.parse(readFileSync(new URL(`../src/i18n/${language}.json`, import.meta.url), 'utf8'));
  for (const key of ['chart.q.groupDelay', 'chart.q.unwrappedPhase', 'sparams.apertureAria', 'sparams.phaseAssumption', 'sparams.phaseWarning.phaseStep', 'sparams.phaseWarning.invalidGrid', 'sparams.phaseWarning.invalidSample']) {
    eq(typeof messages[key], 'string', `${language}: required control and diagnostic text exists`);
  }
}
console.log(`S-parameter phase integration: ${assertions} plot/CSV/compare/preference assertions passed`);
