import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { exportResultTouchstone, exportStem } from '../src/designer/resultTouchstone.ts';
import { parseTouchstone, parseTouchstoneNPort } from '../src/export/touchstone.ts';

const blobs = new Map();
let offered;
globalThis.window = {};
globalThis.document = {
  body: { appendChild() {}, },
  createElement() { return { style: {}, click() { offered = { name: this.download, url: this.href }; }, remove() {} }; },
};
URL.createObjectURL = (blob) => { const url = `blob:test-${blobs.size}`; blobs.set(url, blob); return url; };
URL.revokeObjectURL = () => {};

function bundle(n) {
  const frequency = [1e9, 2e9];
  const common = { generator: { version: 'test', openems: null }, name: 'fixture', model: { id: 'fixture' }, created: 'today', solver: { engine: 'test', method: 'test' }, ports: Array.from({ length: n }, (_, i) => ({ number: i + 1, excite: true, type: 'lumped', R: 50, direction: 'z' })) };
  const matrix = {};
  for (let i = 1; i <= n; i++) for (let j = 1; j <= n; j++) matrix[`${i},${j}`] = { re: [i * 0.1 + j * 0.01, i * 0.2 + j * 0.01], im: [-i * 0.02, j * 0.03] };
  const results = { frequency, ports: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), { z_ref: 50, s11_re: matrix[`${i + 1},${i + 1}`].re, s11_im: matrix[`${i + 1},${i + 1}`].im }])), sparams: { ports: Array.from({ length: n }, (_, i) => i + 1), z_ref: Array(n).fill(50), excited: Array.from({ length: n }, (_, i) => i + 1), s: matrix } };
  return { ...common, results };
}
async function downloaded() { return await blobs.get(offered.url).arrayBuffer(); }
function near(a, b, eps = 6e-8) { assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`); }

const one = bundle(1);
await exportResultTouchstone(one, '../unsafe: result');
assert.equal(offered.name, 'unsafe-result.s1p');
const text1 = new TextDecoder().decode(await downloaded());
// both times in the header in the same form: ISO 8601 local time with the offset
assert.match(text1, /^! Exported: {2}\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/m, 'Exported: local time with the offset');
const stamped = { ...bundle(1), created: '2026-10-06T23:39:26+0300' };
await exportResultTouchstone(stamped, 'stamped');
assert.match(new TextDecoder().decode(await downloaded()), /^! Simulated: 2026-10-06T23:39:26\+03:00 \(/m, 'Simulated: the same form');
const parsed1 = parseTouchstone(text1);
assert.equal(parsed1.z0, 50);
assert.deepEqual(parsed1.f, one.results.frequency);
for (let i = 0; i < 2; i++) { near(parsed1.re[i], one.results.sparams.s['1,1'].re[i]); near(parsed1.im[i], one.results.sparams.s['1,1'].im[i]); }

const two = bundle(2);
await exportResultTouchstone(two, 'single');
assert.equal(offered.name, 'single.s2p');
const parsed2 = parseTouchstoneNPort(new TextDecoder().decode(await downloaded()), 2);
assert.equal(parsed2.z0, 50);
assert.deepEqual(parsed2.f, two.results.frequency);
for (let k = 0; k < 2; k++) for (let i = 1; i <= 2; i++) for (let j = 1; j <= 2; j++) {
  near(parsed2.s[k][i - 1][j - 1][0], two.results.sparams.s[`${i},${j}`].re[k]);
  near(parsed2.s[k][i - 1][j - 1][1], two.results.sparams.s[`${i},${j}`].im[k]);
}

await exportResultTouchstone(one, 'compare', [
  { file: '../same.case.json', bundle: one },
  { file: 'same.case.json', bundle: two },
]);
assert.equal(offered.name, 'compare.zip');
const members = unzipSync(new Uint8Array(await downloaded()));
assert.deepEqual(Object.keys(members).sort(), ['same.case.s1p', 'same.case.s2p']);
const zip1 = parseTouchstone(new TextDecoder().decode(members['same.case.s1p']));
const zip2 = parseTouchstoneNPort(new TextDecoder().decode(members['same.case.s2p']), 2);
assert.deepEqual(zip1.f, one.results.frequency);
assert.deepEqual(zip2.f, two.results.frequency);

// a run label with a value in it: the dot is not an extension; the zip and its files are named alike
assert.equal(exportStem('Dip C · k=0.5126'), 'dip-c-k-0.5126');
assert.equal(exportStem('dip-c--k-0.5126.json'), 'dip-c-k-0.5126', 'a result file: only ".json" goes');
assert.equal(exportStem('  '), 'results');
await exportResultTouchstone(one, 'Dip C · k=0.5126', [
  { file: 'dip-c--k-0.5126.json', bundle: one, label: 'Dip C · k=0.5126' },
  { file: 'dip-c-20261006-233309-95e3b5.json', bundle: one, label: 'Dip C · 23:33' },
  { file: 'dip-c-20261006-233310-aaaaaa.json', bundle: one, label: 'Dip C · 23:33' },
]);
assert.equal(offered.name, 'dip-c-k-0.5126.zip', 'not dip-c--k-0.zip');
assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await downloaded()))).sort(), ['dip-c-23-33-2.s1p', 'dip-c-23-33.s1p', 'dip-c-k-0.5126.s1p'], 'each file after its run label');
await exportResultTouchstone(one, 'Dip C · k=0.5126');
assert.equal(offered.name, 'dip-c-k-0.5126.s1p', 'one run: the same stem');
const views = (await import('node:fs')).readFileSync(new URL('../src/designer/ResultViews.tsx', import.meta.url), 'utf8');
assert.ok(/exportResultTouchstone\(run\.bundle, runLabel\(run\.file\), runs\?\.map\(\(r\) => \(\{ \.\.\.r, label: runLabel\(r\.file\) \}\)\)\)/.test(views), 'Design: named after the run labels');

const incomplete = bundle(2);
delete incomplete.results.sparams.s['2,1'];
await assert.rejects(() => exportResultTouchstone(one, 'bad', [
  { file: 'ok.json', bundle: one }, { file: 'incomplete.json', bundle: incomplete },
]), /incomplete or invalid S21/);
const inconsistent = structuredClone(one);
inconsistent.results.ports['1'].s11_re = [0.9, ...inconsistent.results.ports['1'].s11_re.slice(1)];
await assert.rejects(() => exportResultTouchstone(inconsistent, 'bad'), /sweep and matrix S11 data disagree/);
console.log('Result Touchstone checks passed');
