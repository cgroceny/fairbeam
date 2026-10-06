import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { exportResultTouchstone } from '../src/designer/resultTouchstone.ts';
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
assert.equal(offered.name, 'unsafe__result.s1p');
const parsed1 = parseTouchstone(new TextDecoder().decode(await downloaded()));
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

const incomplete = bundle(2);
delete incomplete.results.sparams.s['2,1'];
await assert.rejects(() => exportResultTouchstone(one, 'bad', [
  { file: 'ok.json', bundle: one }, { file: 'incomplete.json', bundle: incomplete },
]), /incomplete or invalid S21/);
const inconsistent = structuredClone(one);
inconsistent.results.ports['1'].s11_re = [0.9, ...inconsistent.results.ports['1'].s11_re.slice(1)];
await assert.rejects(() => exportResultTouchstone(inconsistent, 'bad'), /sweep and matrix S11 data disagree/);
console.log('Result Touchstone checks passed');
