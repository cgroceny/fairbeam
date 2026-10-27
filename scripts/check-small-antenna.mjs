// Independent analytic circuit/geometry controls, not native EM qualification.
import assert from 'node:assert/strict';
import { smallAntennaAnalysis, defaultSmallAntennaOptions, smallAntennaColumns, analyzeSmallAntennaGeometry } from '../src/lib/smallAntenna.ts';
import { postprocessPorts } from '../src/lib/portPostprocess.ts';

let checks = 0;
const eq = (a, b, note) => { assert.deepEqual(a, b, note); checks++; };
const ok = (value, note) => { assert.ok(value, note); checks++; };
const close = (actual, expected, rel = 1e-7) => { assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= rel * Math.max(Math.abs(expected), 1e-12), `${actual} != ${expected} (${rel})`); checks++; };
const f0 = 1e9, R = 50, Q = 20, c0 = 299792458;
const grid = Array.from({ length: 201 }, (_, i) => f0 * (.9 + i * .001));
// Defined directly from series RLC component laws; no implementation derivative reused.
const L = Q * R / (2 * Math.PI * f0), C = 1 / ((2 * Math.PI * f0) ** 2 * L);
const series = f => ({ re: R, im: 2 * Math.PI * f * L - 1 / (2 * Math.PI * f * C) });
const box = (lo, hi, name = 'radiator') => ({ name, type: 'Metal', bbox: [lo, hi], primitives: [{ kind: 'box', start: lo, stop: hi, bbox: [lo, hi], priority: 10, exact: true }] });
function bundle(fn = series, frequency = grid) {
  frequency = [...frequency]; // Each corruption control owns its frequency axis.
  const z = frequency.map(fn);
  // Independent complex (Z-R)/(Z+R), rather than calling the product RF adapter.
  const gamma = z.map(({ re, im }) => { const den = (re + R) ** 2 + im ** 2; return { re: (re ** 2 - R ** 2 + im ** 2) / den, im: 2 * R * im / den }; });
  return {
    schema: 'fairbeam.project/1', name: 'Analytic RLC control', created: 'analytic', model: { id: 'analytic-circuit', name: 'Analytic circuit', params: [] },
    generator: { name: 'Fairbeam', version: 'analytic', openems: null, csxcad: null, python: '' },
    units: { length: 'mm', length_m: .001, frequency: 'Hz' },
    solver: { boundaries: { 'x-': 'MUR', 'x+': 'PML_8', 'y-': 'MUR', 'y+': 'MUR', 'z-': 'MUR', 'z+': 'MUR' }, end_criteria_db: -60, max_timesteps: 20000 },
    parts: [box([-1.5, -2, 0], [1.5, 2, 0])], half_space: null,
    ports: [{ number: 7, type: 'lumped', R, start: [-.1, 0, 0], stop: [.1, 0, 0], direction: 'x', excite: true }],
    run: { converged: true, hit_timestep_limit: false, timesteps: 10000, excitation_timesteps: 1000, final_energy_db: -70,
      energy_trace: [{ timestep: 10000, db: -70 }], threads: 1, host: { os: 'analytic', machine: '', cpu: null }, log_tail: [] },
    results: { frequency, ports: { '7': { z_ref: R, zin_re: z.map(v => v.re), zin_im: z.map(v => v.im), s11_re: gamma.map(v => v.re), s11_im: gamma.map(v => v.im) } },
      farfield: [], bands: [], signals: {} },
  };
}
const fresh = bundle();
const baseline = smallAntennaAnalysis(fresh);
ok(baseline.q.available, `series Q: ${baseline.q.reason}`);
close(baseline.q.f0Hz, f0, 1e-9); close(baseline.q.r0Ohm, R); close(baseline.q.qz, Q, 1e-5);
close(baseline.q.dRdf, 0, 1e-3); close(baseline.q.dXdf, 2 * R * Q / f0, 1e-5);
ok(baseline.bandwidth.predicted.available, `series bandwidth: ${baseline.bandwidth.predicted.reason}`);
ok(baseline.bandwidth.observed.available);
// Closed-form roots of x - 1/x = +/- (s-1)/(Q sqrt(s)).
for (const vswr of [1.5, 2, 3]) {
  const a = smallAntennaAnalysis(fresh, { ...defaultSmallAntennaOptions(fresh), vswr });
  const delta = (vswr - 1) / (Q * Math.sqrt(vswr));
  const lower = (-delta + Math.sqrt(delta ** 2 + 4)) / 2 * f0;
  const upper = (delta + Math.sqrt(delta ** 2 + 4)) / 2 * f0;
  ok(a.bandwidth.predicted.available, `VSWR ${vswr}: ${a.bandwidth.predicted.reason}`);
  close(a.bandwidth.predicted.fraction, delta, 1e-5);
  close(a.bandwidth.observed.lowerHz, lower, 2e-4); close(a.bandwidth.observed.upperHz, upper, 2e-4);
  close(a.bandwidth.observed.hz, upper - lower, .003);
}
// Nonuniform spacings and a root between samples distinguish general differentiation from
// a uniform central-difference shortcut. Changing the absolute scale catches Hz/GHz mistakes.
for (const factor of [1e-6, 1, 1000]) {
  const irregular = Array.from({ length: 201 }, (_, i) => factor * f0 * (.9005 + i * .001 + .00012 * Math.sin(i)));
  const b = bundle(f => series(f / factor), irregular), a = smallAntennaAnalysis(b);
  ok(a.q.available, a.q.reason); close(a.q.f0Hz, factor * f0, 1e-6); close(a.q.qz, Q, 3e-5);
}
// A parallel RLC natural antiresonance has negative dX/df but positive Q.
const Cp = Q / (2 * Math.PI * f0 * R), Lp = 1 / ((2 * Math.PI * f0) ** 2 * Cp);
const parallel = bundle(f => { const conductance = 1 / R, susceptance = 2 * Math.PI * f * Cp - 1 / (2 * Math.PI * f * Lp);
  const den = conductance ** 2 + susceptance ** 2; return { re: conductance / den, im: -susceptance / den }; });
const anti = smallAntennaAnalysis(parallel);
ok(anti.q.available, anti.q.reason); ok(anti.q.dXdf < 0); close(anti.q.qz, Q, .001);
ok(anti.bandwidth.predicted.available, anti.bandwidth.predicted.reason);
close(anti.bandwidth.observed.fraction, 1 / (Q * Math.sqrt(2)), .003);
// Complex derivative: the resistance derivative is material, not discarded.
const sloped = bundle(f => ({ re: 50 + 1000 * (f / f0 - 1), im: 2000 * (f / f0 - 1) }),
  Array.from({ length: 101 }, (_, i) => f0 * (.98 + i * .0004)));
const complex = smallAntennaAnalysis(sloped);
ok(complex.q.available); close(complex.q.qz, Math.hypot(1000, 2000) / 100, 1e-8);
close(complex.q.dRdf, 1000 / f0, 1e-8); close(complex.q.dXdf, 2000 / f0, 1e-8);

eq(smallAntennaAnalysis(bundle(f => ({ re: R, im: -1 / (2 * Math.PI * f * C) }))).reason, 'no-resonance', 'untuned RC is not silently given an ideal tuner');
eq(smallAntennaAnalysis(bundle(() => ({ re: R, im: 0 }))).reason, 'flat-resonance');
const broad = smallAntennaAnalysis(bundle(f => ({ re: R, im: 2 * R * (f / f0 - f0 / f) })));
ok(broad.q.available); eq(broad.bandwidth.predicted.reason, 'broad-response');
eq(broad.bandwidth.predicted.hz, null); eq(broad.bandwidth.predicted.fraction, null);
eq(broad.bandwidth.predicted.lowerHz, null); eq(broad.bandwidth.predicted.upperHz, null);
const multi = bundle(f => { const t = f / f0; return { re: R, im: 1e6 * (t - .96) * (t - 1) * (t - 1.04) }; });
const multiple = smallAntennaAnalysis(multi), eligible = multiple.candidates.filter(c => c.available);
ok(eligible.length > 1); eq(multiple.reason, 'choose-resonance'); eq(multiple.selectedCandidateId, null); eq(multiple.q.qz, null);
const explicit = smallAntennaAnalysis(multi, { ...defaultSmallAntennaOptions(multi), resonanceId: eligible[1].id });
ok(explicit.q.available); eq(explicit.selectedCandidateId, eligible[1].id);
const sharp = bundle(f => { const t = f / f0 - 1; return { re: R, im: 50 * (t + 10000 * t ** 3) }; },
  Array.from({ length: 21 }, (_, i) => f0 * (.9 + i * .01)));
eq(smallAntennaAnalysis(sharp).q.reason, 'unresolved-derivative', '3/5 estimates disagree on an unresolved derivative');
const clustered = bundle(f => { const t = f / f0; return { re: R, im: 1e8 * (t - .999) * (t - 1) * (t - 1.001) }; });
ok(smallAntennaAnalysis(clustered).candidates.some(v => v.reason === 'multiple-resonances'));
const endpoint = bundle(f => ({ re: R, im: (f - grid[0]) / 1e6 }));
eq(smallAntennaAnalysis(endpoint).q.reason, 'edge-resonance');

function changed(mutator, expected, path = a => a.reason) { const b = bundle(); mutator(b); eq(path(smallAntennaAnalysis(b)), expected); }
changed(b => { b.results = null; }, 'no-results');
changed(b => { b.reference = { phaseKnown: false }; }, 'missing-phase');
changed(b => { b.ports.push({ ...b.ports[0], number: 19 }); }, 'not-single-port');
changed(b => { b.results.sparams = { ports: [1, 2], z_ref: [50, 50], s: { '1,1': { re: [0], im: [0] } } }; }, 'not-single-port');
for (const value of [0, -1, Infinity, NaN]) changed(b => { b.results.frequency[1] = value; }, 'invalid-frequency-grid');
changed(b => { b.results.frequency[1] = b.results.frequency[0]; }, 'invalid-frequency-grid');
changed(b => { b.results.frequency.reverse(); }, 'invalid-frequency-grid');
changed(b => { b.results.ports['7'].zin_re.pop(); }, 'invalid-impedance');
changed(b => { b.results.ports['7'].s11_im.pop(); }, 'invalid-impedance');
changed(b => { b.results.ports['7'].z_ref_f = [50]; }, 'invalid-reference');
changed(b => { b.results.ports['7'].z_ref_f = b.results.frequency.map((_, i) => 50 + i); }, 'invalid-reference');
changed(b => { b.ports[0].reference_impedance = { real: 50, imag: 1 }; }, 'invalid-reference');
for (const bad of [NaN, Infinity, -1, 0]) changed(b => { b.results.ports['7'].zin_re[100] = bad; }, false, a => a.q.available);
const hole = bundle(); hole.results.ports['7'].zin_re[90] = NaN;
const holeAnalysis = smallAntennaAnalysis(hole); ok(holeAnalysis.q.available); eq(holeAnalysis.bandwidth.predicted.reason, 'bandwidth-edges');
eq(holeAnalysis.bandwidth.predicted.hz, null); eq(holeAnalysis.bandwidth.predicted.fraction, null);
for (const vswr of [1, 0, -1, NaN, Infinity, true]) eq(smallAntennaAnalysis(fresh, { ...defaultSmallAntennaOptions(fresh), vswr }).bandwidth.predicted.reason, 'invalid-vswr');
eq(smallAntennaAnalysis(fresh, { ...defaultSmallAntennaOptions(fresh), resonanceId: 'stale-run-crossing' }).reason, 'invalid-selection');
const canonical = bundle(), pr = canonical.results.ports['7'];
canonical.results.sparams = { ports: [1], port_numbers: [7], z_ref: [R], excited: [1], s: { '1,1': { re: pr.s11_re, im: pr.s11_im } } };
ok(smallAntennaAnalysis(canonical).q.available, 'physical port 7 is the single canonical matrix port');
canonical.results.sparams.port_numbers = [19]; eq(smallAntennaAnalysis(canonical).reason, 'not-single-port');
const projected = postprocessPorts(fresh, { referenceOhm: 75, delayPs: { 7: 25 } });
eq(projected.error, null); eq(smallAntennaAnalysis(projected.bundle).reason, 'projected-plane');

// Geometry uses the conservative selected union-box radius in meters, not a mesh radius.
close(baseline.geometry.radiusM, .0025); eq(baseline.geometry.centerM, [0, 0, 0]);
const moved = bundle(); moved.parts = [box([8.5, 18, 30], [11.5, 22, 30])];
const translated = smallAntennaAnalysis(moved); close(translated.geometry.radiusM, .0025); eq(translated.geometry.centerM, [.01, .02, .03]);
eq(translated.reference.ratioReason, 'incomplete-geometry', 'the unshifted feed lies outside the selected geometry');
for (const unit of [0, -1, NaN, Infinity, true]) changed(b => { b.units.length_m = unit; }, 'invalid-units', a => a.geometry.reason);
changed(b => { b.parts[0].bbox = [[2, 0, 0], [1, 1, 0]]; }, 'invalid-bounds', a => a.geometry.reason);
for (const selectedPartIndices of [[], [99], [0, 0], [true], [0.5]]) {
  const a = smallAntennaAnalysis(fresh, { ...defaultSmallAntennaOptions(fresh), selectedPartIndices });
  eq(a.geometry.reason, selectedPartIndices.length ? 'invalid-parts' : 'empty-geometry');
}
const ground = bundle(); ground.parts.push(box([-10, -10, -1], [10, 10, -1], 'finite ground'));
eq(smallAntennaAnalysis(ground, { ...defaultSmallAntennaOptions(ground), selectedPartIndices: [0] }).reference.ratioReason, 'incomplete-geometry');
ground.parts.push({ ...box([-1, -1, -1], [1, 1, 1], 'void'), void: true });
eq(defaultSmallAntennaOptions(ground).selectedPartIndices, [0, 1]);
eq(smallAntennaAnalysis(ground, { ...defaultSmallAntennaOptions(ground), selectedPartIndices: [0, 1, 2] }).geometry.reason, 'invalid-parts');
changed(b => { b.solver.boundaries['x-'] = 'PEC'; }, 'non-free-space', a => a.reference.ratioReason);
changed(b => { b.parts[0].primitives[0].exact = false; }, 'uncertain-geometry', a => a.reference.ratioReason);
changed(b => { b.generator.name = 'unrecorded importer'; }, 'uncertain-geometry', a => a.reference.ratioReason);
changed(b => { b.ports[0].stop = [100, 0, 0]; }, 'incomplete-geometry', a => a.reference.ratioReason);
changed(b => { b.lumped_elements = [{ start: [0, 0, 0], stop: [100, 0, 0] }]; }, 'incomplete-geometry', a => a.reference.ratioReason);
const image = bundle(); image.half_space = { axis: 'z', side: 'min', kind: 'PEC', position: 5 }; image.solver.boundaries['z-'] = 'PEC';
image.parts = [box([0, 0, 5], [6, 0, 9])];
const mirrored = smallAntennaAnalysis(image);
eq(mirrored.geometry.enclosure, 'pec-image'); close(mirrored.geometry.radiusM, .005); eq(mirrored.geometry.centerM, [.003, 0, .005]);
eq(mirrored.geometry.planeM, .005); eq(mirrored.reference.ratioReason, 'image-reference'); eq(mirrored.reference.ratio, null);
const tall = structuredClone(image); tall.half_space.position = 0; tall.parts = [box([0, 0, 0], [0, 0, 10])];
close(smallAntennaAnalysis(tall).geometry.radiusM, .01, 1e-12);
eq(analyzeSmallAntennaGeometry(fresh, { ...defaultSmallAntennaOptions(fresh), enclosure: 'pec-image' }, f0).reason, 'invalid-image-plane');
for (const ka of [.1, .5]) {
  const a = c0 * ka / (2 * Math.PI * f0), b = bundle();
  b.parts = [box([-a * 1000, 0, 0], [a * 1000, 0, 0])];
  const r = smallAntennaAnalysis(b); close(r.geometry.ka, ka, 1e-8); close(r.reference.qChuMcLean, ka === .1 ? 1010 : 10, 1e-8);
  close(r.reference.ratio, Q / (ka === .1 ? 1010 : 10), 1e-5);
}
const large = bundle(); large.parts = [box([-100, 0, 0], [100, 0, 0])];
eq(smallAntennaAnalysis(large).reference.reason, 'not-small');
ok(baseline.reference.ratio < 1, 'a diagnostic ratio is retained below one, not clipped or advertised as a bound verdict');

function withPower(mutator = () => {}) { const b = bundle(); b.results.farfield = [{ f: f0, port: 7, prad_w: .8, pacc_w: 1, rad_efficiency: .8 }]; mutator(b); return b; }
const power = smallAntennaAnalysis(withPower()); ok(power.efficiency.available, power.efficiency.reason); close(power.efficiency.value, .8); close(power.efficiency.raw, .8);
eq(power.efficiency.kind, 'power-ratio'); eq(power.efficiency.port, 7); close(power.efficiency.frequencyHz, f0);
function rejectPower(mutator, expected) { eq(smallAntennaAnalysis(withPower(mutator)).efficiency.reason, expected); }
rejectPower(b => { b.results.farfield[0].f += 1; }, 'efficiency-frequency');
rejectPower(b => { b.results.farfield[0].port = 19; }, 'efficiency-port');
rejectPower(b => { b.results.farfield[0].pacc_w = 0; }, 'efficiency-power');
rejectPower(b => { b.results.farfield[0].pacc_w = true; }, 'efficiency-power');
rejectPower(b => { b.results.farfield[0].prad_w = 1.01; }, 'efficiency-power');
rejectPower(b => { b.results.farfield[0].rad_efficiency = .7; }, 'efficiency-power');
rejectPower(b => { b.results.farfield[0].rad_efficiency_raw = NaN; }, 'efficiency-power');
rejectPower(b => { b.results.farfield[0].qa_warnings = ['unreliable']; }, 'efficiency-quality');
rejectPower(b => { b.run.converged = false; }, 'efficiency-convergence');
rejectPower(b => { b.run.hit_timestep_limit = true; }, 'efficiency-convergence');
rejectPower(b => { b.run.final_energy_db = Infinity; }, 'efficiency-convergence');
rejectPower(b => { b.run.final_energy_db = -20; }, 'efficiency-convergence');
rejectPower(b => { b.run.final_energy_bound_db = -20; }, 'efficiency-convergence');
rejectPower(b => { b.run.excitation_timesteps = -1; }, 'efficiency-convergence');
rejectPower(b => { b.run.port_runs = [{ port: 19, converged: true }]; }, 'efficiency-convergence');
rejectPower(b => { b.run.port_runs = [{ port: 7, converged: true, final_energy_db: NaN }]; }, 'efficiency-convergence');
const norm = smallAntennaAnalysis(withPower(b => { b.results.farfield[0].rad_efficiency = 1; b.results.farfield[0].rad_efficiency_raw = .8; }));
eq(norm.efficiency.available, false); eq(norm.efficiency.reason, 'model-normalized'); eq(norm.efficiency.kind, 'model-normalized'); close(norm.efficiency.raw, .8); eq(norm.efficiency.value, 1);
close(norm.reference.ratio, baseline.reference.ratio, 1e-12, 'no efficiency correction is applied');
rejectPower(b => { b.results.farfield.push({ ...b.results.farfield[0], prad_w: .7, rad_efficiency: .7 }); }, 'efficiency-power');
const efficiencySweep = withPower(b => { b.results.farfield = []; b.results.efficiency = [{ port: 7, f: [f0], prad_w: [.8], pacc_w: [1], rad_efficiency: [.8], reliable: [true], pacc_error: [.01] }]; });
ok(smallAntennaAnalysis(efficiencySweep).efficiency.available);
for (const change of [b => { b.results.efficiency[0].reliable = [false]; }, b => { b.results.efficiency[0].pacc_error = [.11]; }, b => { b.results.efficiency[0].pacc_w = []; }]) {
  const b = structuredClone(efficiencySweep); change(b); eq(smallAntennaAnalysis(b).efficiency.reason, 'efficiency-quality');
}

const columns = smallAntennaColumns(power); eq(columns.header.length, columns.row.length); eq(new Set(columns.header).size, columns.header.length);
const record = Object.fromEntries(columns.header.map((h, i) => [h, columns.row[i]]));
eq(record.small_antenna_qz, power.q.qz); eq(record.small_antenna_f0_hz, power.q.f0Hz); eq(record.small_antenna_radiation_efficiency, .8);
eq(record.small_antenna_efficiency_prad_w, .8); eq(record.small_antenna_efficiency_pacc_w, 1); eq(record.small_antenna_efficiency_final_energy_db, -70);
eq(record.small_antenna_predicted_bw_hz, power.bandwidth.predicted.hz); eq(record.small_antenna_qz_reference_ratio, power.reference.ratio);
const before = structuredClone(fresh); smallAntennaAnalysis(fresh); eq(fresh, before, 'pure analysis does not mutate source');
console.log(`small antenna: ${checks} independent analytic, metadata, refusal, geometry, and export controls passed; no EM solver qualification`);
