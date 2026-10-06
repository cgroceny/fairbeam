import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findResonances, globalExtrema, isReflectionTrace, nearestFiniteSample, nextMinimum, pickTraceSample } from '../src/charts/markerMath.ts';
import { initialMarkerMode, toggleMarkerMode } from '../src/charts/markerMode.ts';

for (const id of ['s11', '2,2', 'cmp-0-1,1', 'cmp-0']) assert.equal(isReflectionTrace(id), true, id);
for (const id of ['s21', '2,1', 'cmp-0-2,1']) assert.equal(isReflectionTrace(id), false, id);

assert.deepEqual(initialMarkerMode, { active: false, everOpened: false });
const openedMode = toggleMarkerMode(initialMarkerMode);
assert.deepEqual(openedMode, { active: true, everOpened: true });
assert.deepEqual(toggleMarkerMode(openedMode), { active: false, everOpened: true });

const one = findResonances([1, 2, 3, 4, 5], [4, 1, -2, 1, 4], 0);
assert.deepEqual(one.map(({ index, low, high }) => ({ index, low, high })), [{ index: 2, low: 2.3333333333333335, high: 3.6666666666666665 }]);
assert.equal(one[0].percent, (100 * (4 / 3)) / 3);
const asymmetric = findResonances([1, 2, 4, 7], [3, -3, -2, 3], 0)[0];
assert.equal(asymmetric.low, 1.5);
assert.equal(asymmetric.high, 5.2);
assert.ok(Math.abs(asymmetric.percent - 100 * 3.7 / 3.35) < 1e-10);

const two = findResonances([1, 2, 3, 4, 5, 6, 7], [3, -1, 2, -2, 2, -1, 3], 0);
assert.deepEqual(two.map(point => point.index), [1, 3, 5]);
assert.deepEqual(two.map(({ low, high }) => [low, high]), [[1.75, 2.3333333333333335], [3.5, 4.5], [5.666666666666667, 6.25]]);
assert.equal(findResonances([1, 2, 3], [2, 0, 2], 0).length, 0);
// Samples equal to threshold are outside the band; both crossings interpolate exactly at them.
assert.deepEqual(findResonances([0, 1, 2, 3, 4], [2, 0, -2, 0, 2], 0).map(({ low, high, edgeLow, edgeHigh }) => ({ low, high, edgeLow, edgeHigh })), [{ low: 1, high: 3, edgeLow: false, edgeHigh: false }]);
assert.deepEqual(findResonances([1, 2, 3], [-2, -3, 1], 0).map(({ edgeLow, edgeHigh, low, high }) => ({ edgeLow, edgeHigh, low, high })), [{ edgeLow: true, edgeHigh: false, low: 1, high: 2.75 }]);

assert.deepEqual(findResonances([1, 2, 3, 4, 5], [5, 1, 1, 1, 5], 3).map(point => point.index), [2]);
assert.equal(findResonances([1, 2, 3], [2, 2, 2], 3).length, 0);
assert.deepEqual(findResonances([1, 2, 3, 4, 5], [4, 1, NaN, 0, 4], 2).map(({ index, edgeLow, edgeHigh }) => ({ index, edgeLow, edgeHigh })), [{ index: 1, edgeLow: false, edgeHigh: true }, { index: 3, edgeLow: true, edgeHigh: false }]);
// A finite-data gap closes each side as an open bound at its nearest sample.
assert.deepEqual(findResonances([1, 2, 3, 4, 5, 6], [-2, -3, NaN, -4, -5, 2], 0).map(({ low, high, edgeLow, edgeHigh }) => ({ low, high, edgeLow, edgeHigh })), [{ low: 1, high: 2, edgeLow: true, edgeHigh: true }, { low: 4, high: 5.714285714285714, edgeLow: true, edgeHigh: false }]);

// ripple/noise inside one band: one resonance at the deepest minimum, not one per ripple
const ripple = findResonances([1, 2, 3, 4, 5, 6, 7], [0, -12, -15, -13, -16, -12, 0], -10);
assert.equal(ripple.length, 1);
assert.equal(ripple[0].index, 4);
assert.equal(ripple[0].low, 1 + 10 / 12);
assert.equal(ripple[0].high, 6 + 2 / 12);
// still falling at the top of the band: open-ended, reported at the last sample
assert.deepEqual(findResonances([1, 2, 3, 4], [-2, -5, -11, -14], -10).map(({ index, low, high, edgeLow, edgeHigh }) => ({ index, low, high, edgeLow, edgeHigh })), [{ index: 3, low: 2 + 5 / 6, high: 4, edgeLow: false, edgeHigh: true }]);
// stored stepped low-pass: a three-ripple passband from the lowest frequency is one open-ended band
const lowpass = JSON.parse(readFileSync(new URL('../public/projects/lowpass-stepped.json', import.meta.url), 'utf8')).results;
const lp = lowpass.sparams.s['1,1'];
const lpDb = lp.re.map((re, i) => 10 * Math.log10(re * re + lp.im[i] * lp.im[i]));
const lpBands = findResonances(lowpass.frequency, lpDb, -10);
assert.equal(lpBands.length, 1);
assert.equal(lpBands[0].edgeLow, true);
assert.equal(lpBands[0].edgeHigh, false);
assert.equal(lpBands[0].y, Math.min(...lpDb));

assert.deepEqual(nearestFiniteSample([1, NaN, 3], [8, 0, 4], 2), { index: 0, x: 1, y: 8 });
assert.deepEqual(nearestFiniteSample([1, 2, 3], [8, NaN, 4], 2), { index: 0, x: 1, y: 8 });
const placement = pickTraceSample([
  { id: 'a', x: [1, 2, 3], y: [1, NaN, 3] },
  { id: 'b', x: [1.1, 2.1, 3.1], y: [6, 7, 8] },
], 2, 7.2, v => v);
assert.equal(placement?.trace.id, 'b');
assert.deepEqual(placement?.point, { index: 1, x: 2.1, y: 7 });
assert.equal(pickTraceSample([{ id: 'bad', x: [1], y: [NaN] }], 1, 0, v => v), null);
assert.deepEqual(globalExtrema([1, 2, 3, 4], [0, -2, 5, -2]), { min: { index: 1, x: 2, y: -2 }, max: { index: 2, x: 3, y: 5 } });
const waveX = [1, 2, 3, 4, 5, 6, 7];
const waveY = [3, -1, 2, -2, 2, -1, 3];
assert.equal(nextMinimum(waveX, waveY, 1, 1)?.index, 3);
assert.equal(nextMinimum(waveX, waveY, 1, -1)?.index, 5);
assert.equal(nextMinimum([1, 2, 3], [1, 1, 1], 0, 1), null);
assert.equal(nextMinimum([1, 2, 3], [1, -1, 1], 1, 1), null);
const bundle = JSON.parse(readFileSync(new URL('../examples/synthetic/array2x1.json', import.meta.url), 'utf8'));
const reflection = bundle.results.sparams.s['1,1'];
const db = reflection.re.map((re, i) => 20 * Math.log10(Math.hypot(re, reflection.im[i])));
const resonances = findResonances(bundle.results.frequency, db, -10);
assert.ok(resonances.length >= 1);
assert.ok(resonances.some(r => Math.abs(r.x - bundle.results.bands[0].f_center) <= 5e6));
assert.ok(resonances.some(r => Math.abs(r.low - bundle.results.bands[0].f_lo) <= 5e6 && Math.abs(r.high - bundle.results.bands[0].f_hi) <= 5e6));

console.log('Marker mathematics checks passed.');
