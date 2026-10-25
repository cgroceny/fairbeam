// Pure controls: finite samples must produce finite chart coordinates, even when
// derivative roundoff is much smaller than the display's tick precision.
import assert from 'node:assert/strict';
import { extent, niceDomain, ticks } from '../src/charts/scale.ts';
import { analyzeSParameterPhase } from '../src/lib/sparamPhase.ts';

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
console.log(`Chart scales: ${cases.length} constant, tiny-span and analytical-delay controls passed.`);
