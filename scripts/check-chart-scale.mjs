// Pure controls: finite samples must produce finite chart coordinates, even when
// derivative roundoff is much smaller than the display's tick precision.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extent, niceDomain, ticks, tickLabel } from '../src/charts/scale.ts';
import { analyzeSParameterPhase } from '../src/lib/sparamPhase.ts';

// A synchronous regression in ticks must fail this check, not hang its test runner.
if (!process.argv.includes('--bounded-scale-worker')) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url), '--bounded-scale-worker'],
    { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  process.stdout.write(result.stdout);
  process.exit(0);
}

const cases = [
  ['positive constant', [.6, .6, .6]], ['negative constant', [-.6, -.6]], ['zero', [0, 0]],
  ['positive tiny span', [.6 - 1e-14, .6, .6 + 1e-14]],
  ['negative tiny span', [-.6 - 1e-14, -.6, -.6 + 1e-14]],
  ['zero tiny span', [-1e-14, 0, 1e-14]], ['ordinary range', [-4, 0, 6]],
];
const f = Array.from({ length: 41 }, (_, i) => 1 + i * .05);
for (const delay of [.6, -.6, 0]) {
  const a = analyzeSParameterPhase(f, f.map(x => .5 * Math.cos(-2 * Math.PI * delay * x)),
    f.map(x => .5 * Math.sin(-2 * Math.PI * delay * x)), { aperturePoints: 5 });
  a.delayNs.forEach(value => assert.ok(Math.abs(value - delay) < 1e-10));
  cases.push([`actual ${delay} ns derivative`, a.delayNs]);
}
for (const [name, values] of cases) {
  const [lo, hi] = extent([values]), pad = (hi - lo) * .06 || 1;
  const domain = niceDomain(lo - pad, hi + pad);
  assert.ok(domain.every(Number.isFinite) && domain[1] > domain[0], `${name}: finite increasing domain`);
  assert.ok(domain[0] <= lo && domain[1] >= hi, `${name}: every sample remains in the chart`);
  const labels = ticks(...domain);
  assert.ok(labels.length >= 2 && labels.every(Number.isFinite), `${name}: finite visible ticks`);
  assert.ok(labels.every((v, i) => !i || v > labels[i - 1]), `${name}: distinct ordered ticks`);
  values.forEach(value => {
    const position = (value - domain[0]) / (domain[1] - domain[0]);
    assert.ok(Number.isFinite(position) && position >= 0 && position <= 1, `${name}: finite in-bounds coordinate`);
  });
}
assert.deepEqual(niceDomain(-3, 7), [-4, 8], 'ordinary nice-domain rounding stays unchanged');
assert.deepEqual(ticks(-3, 7), [-2, 0, 2, 4, 6]);
assert.deepEqual(ticks(0, 1), [0, .2, .4, .6, .8, 1]);
const extremeCases = [
  ['adjacent positive doubles', 1, 1 + Number.EPSILON],
  ['adjacent negative doubles', -1 - Number.EPSILON, -1],
  ['large offset and tiny relative span', 1e20, 1e20 + 16384],
  ['subnormal underflow', 0, Number.MIN_VALUE],
  ['signed subnormals', -Number.MIN_VALUE, Number.MIN_VALUE],
  ['wide finite extremes', -Number.MAX_VALUE, Number.MAX_VALUE],
  ['large constant', 1e100, 1e100],
  ['largest constant', Number.MAX_VALUE, Number.MAX_VALUE],
  ['smallest constant', -Number.MAX_VALUE, -Number.MAX_VALUE],
];
for (const [name, lo, hi] of extremeCases) {
  const values = ticks(lo, hi);
  assert.ok(values.length <= 1001 && values.every(Number.isFinite), `${name}: bounded finite ticks`);
  assert.ok(values.every((v, i) => !i || v > values[i - 1]), `${name}: distinct increasing ticks`);
  const domain = niceDomain(lo, hi);
  assert.ok(domain.every(Number.isFinite) && domain[1] > domain[0], `${name}: finite increasing domain`);
  assert.ok(domain[0] <= lo && domain[1] >= hi, `${name}: all finite input retained`);
}
for (const count of [0, -1, .5, NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
  const values = ticks(0, 1, count);
  assert.ok(values.length >= 2 && values.length <= 1001 && values.every(Number.isFinite), `count ${count}: bounded result`);
}
for (const [lo, hi] of [[NaN, 1], [0, Infinity], [-Infinity, 0], [Infinity, -Infinity], [2, 1]]) {
  assert.deepEqual(ticks(lo, hi), [], 'invalid domain has no fabricated finite data ticks');
  assert.deepEqual(niceDomain(lo, hi), [-1, 1], 'invalid or empty extent has a finite display fallback');
}
const labelCases = [
  ['Ludwig narrow Y range', [6.98968, 6.9897, 6.98972, 6.98974, 6.98976], .00002],
  ['small negative range', [-.00006, -.00004, -.00002, 0], .00002],
  ['very small scale', [0, 2e-14, 4e-14, 6e-14], 2e-14],
  ['tiny span around nonzero', [.6, .6 + 2e-14, .6 + 4e-14], 2e-14],
  ['adjacent doubles', [1, 1 + Number.EPSILON], Number.EPSILON],
  ['subnormal labels', [0, Number.MIN_VALUE, 2 * Number.MIN_VALUE, 3 * Number.MIN_VALUE], Number.MIN_VALUE],
  ['large offsets', [1e20, 1e20 + 16384, 1e20 + 32768], 16384],
];
for (const [name, values, step] of labelCases) {
  const labels = values.map(value => tickLabel(value, step));
  assert.equal(new Set(labels).size, values.length, `${name}: each tick has a distinct label`);
  assert.ok(labels.every(value => Number.isFinite(Number(value))), `${name}: every label is a finite number`);
  for (let i = 1; i < labels.length; i++) assert.ok(Number(labels[i]) > Number(labels[i - 1]), `${name}: labels keep numerical order`);
}
assert.equal(tickLabel(6.9897, .00002), '6.98970', 'the actual Ludwig step gets five decimals');
assert.equal(tickLabel(.2, .2), '0.2', 'ordinary labels stay unchanged');
console.log(`Chart scales: ${cases.length} constant/tiny-span/analytical-delay, ${extremeCases.length} extreme-domain, 7 count, 5 invalid-domain and ${labelCases.length} distinct-label controls passed within the 5 s process bound.`);
