// Ideal circuit controls only: no server, browser, native worker or EM solver.
import assert from 'node:assert/strict';
import { synthesizeMatches, matchedImpedance, matchingSweep, reflection, matchComponents } from '../src/lib/matching.ts';
let checks = 0;
const close = (a, b, tol = 1e-10) => { assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`); checks++; };
// Independent direct L/C evaluation from component values (source to load).
function componentCascade(n, load, f) {
  let z = { ...load };
  for (const c of matchComponents(n).toReversed()) {
    const w = 2 * Math.PI * f;
    const x = c.kind === 'L' ? w * c.value : -1 / (w * c.value);
    if (c.location === 'series') z.im += x;
    else {
      const den = z.re ** 2 + z.im ** 2;
      const yr = z.re / den, yi = -z.im / den - 1 / x, y2 = yr ** 2 + yi ** 2;
      z = { re: yr / y2, im: -yi / y2 };
    }
  }
  return z;
}
for (const r of [5, 25, 50, 100, 300]) for (const im of [-150, -30, 0, 20, 200]) {
  const load = { re: r, im }, all = synthesizeMatches(load, 50, 2e9);
  assert.ok(all.length); checks++;
  for (const n of all) {
    const z = matchedImpedance(n, load, n.f0); close(z.re, 50); close(z.im, 0);
    const g = reflection(z, 50); close(g.re, 0); close(g.im, 0);
    for (const c of matchComponents(n)) { assert.ok(Number.isFinite(c.value) && c.value > 0); checks++; }
    for (const f of [.5e9, 1.3e9, 2e9, 3.7e9]) {
      const q = matchedImpedance(n, load, f);
      assert.ok(q && q.re > 0); checks++;
      if (n.topology !== 'quarter-wave') {
        const independent = componentCascade(n, load, f); close(q.re, independent.re); close(q.im, independent.im);
      }
    }
  }
}
const low = synthesizeMatches({ re: 25, im: 0 }, 50, 1e9);
assert.equal(low.filter(n => n.topology === 'shunt-input').length, 2);
assert.equal(low.filter(n => n.topology === 'series-input').length, 0);
close(low.find(n => n.x > 0).x, 25); close(low.find(n => n.x > 0).b, .02);
const line = low.find(n => n.topology === 'quarter-wave'); close(line.lineZ, Math.sqrt(1250));
for (const multiple of [2, 4]) { const z = matchedImpedance(line, { re: 25, im: 0 }, multiple * 1e9); close(z.re, 25); close(z.im, 0); }
assert.ok(!synthesizeMatches({ re: 25, im: 1e-12 }, 50, 1e9).some(n => n.topology === 'quarter-wave'), 'no silent reactive-load approximation for a line');
assert.equal(synthesizeMatches({ re: 50, im: 0 }, 50, 1e9).filter(n => n.topology === 'shunt-input').length, 1, 'duplicate zero-element solution removed');
for (const load of [{ re: 0, im: 20 }, { re: -1, im: 0 }, { re: Infinity, im: 0 }, { re: 50, im: NaN }]) assert.deepEqual(synthesizeMatches(load, 50, 1e9), []);
for (const f of [0, -1, NaN, Infinity]) assert.equal(matchedImpedance(low[0], { re: 25, im: 0 }, f), null);
assert.equal(matchedImpedance(low[0], { re: NaN, im: 0 }, 1e9), null, 'missing input stays a gap');
const bundle = { ports: [{ number: 7, excite: true }], results: { frequency: [1e9, 2e9, 3e9],
  ports: { '7': { z_ref: 50, s11_re: [-1/3, -1/3, -1/3], s11_im: [0, 0, 0], zin_re: [25,25,25], zin_im: [0,0,0] } } } };
assert.ok(matchingSweep(bundle), 'physical port 7 is still a single-port circuit');
assert.equal(matchingSweep({ ...bundle, reference: { phaseKnown: false } }), null);
assert.equal(matchingSweep({ ...bundle, ports: [...bundle.ports, { number: 8 }] }), null);
assert.equal(matchingSweep({ ...bundle, ports: [{ ...bundle.ports[0], reference_impedance: { real: 50, imag: 2 } }] }), null);
const changed = structuredClone(bundle); changed.results.ports['7'].z_ref_f = [50, 60, 70];
assert.equal(matchingSweep(changed), null, 'waveguide frequency reference is not silently frozen');
changed.results.ports['7'].z_ref_f = [50,50,50]; assert.ok(matchingSweep(changed));
changed.results.ports['7'].z_ref_f = [50,50]; assert.equal(matchingSweep(changed), null, 'malformed reference alignment cannot fall back to a constant');
changed.results.ports['7'].z_ref_f = [50,50,50];
changed.results.frequency = [1e9,1e9,2e9]; assert.equal(matchingSweep(changed), null);
changed.results.frequency = [1e9,2e9,3e9]; changed.results.ports['7'].zin_re[1] = NaN;
assert.ok(matchingSweep(changed), 'a missing individual sample is a gap rather than an invented load');
console.log(`matching: ${checks} ideal circuit comparisons passed; no EM qualification`);
