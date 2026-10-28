import assert from 'node:assert/strict';
import { strictElementPatternsAt, MATCHED_PATTERN_NORMALIZATION } from '../src/lib/patternAdmission.ts';
import { encodeI16Grids } from '../src/lib/sparams.ts';
import { originalPortResult, registerPortProjection } from '../src/lib/portProcessingMetadata.ts';

const values = [[1, 0, -1, 0, 2, 0, -2, 0, 1], Array(9).fill(0), Array(9).fill(0), Array(9).fill(0)];
const encoded = encodeI16Grids(values);
const field = f => ({ f, scale: encoded.scale, ...Object.fromEntries(['e_theta_re', 'e_theta_im', 'e_phi_re', 'e_phi_im'].map((key, i) => [key, encoded.texts[i]])) });
const sample = () => ({ units: { length_m: .001 }, nf2ff_center: [0, 0, 0],
  solver: { boundaries: Object.fromEntries(['x-', 'x+', 'y-', 'y+', 'z-', 'z+'].map(k => [k, 'PML_8'])) },
  ports: [{ number: 7, start: [6, -1, 0], stop: [8, 1, 0] }, { number: 2, start: [1, 0, -1], stop: [3, 0, 1] }],
  results: { frequency: [1e9, 2e9], element_patterns: {
  normalization: MATCHED_PATTERN_NORMALIZATION, basis: 'matched-incident-waves', radius_m: 2, mirror_planes: 0,
  phase_center: [0, 0, 0], decimation: 1, encoding: 'i16le-base64-scaled', shape: [3, 3], theta: [0, 90, 180], phi: [0, 120, 240], frequencies: [1e9, 2e9],
  ports: [{ port: 2, position: [2, 0, 0], fields: [field(1e9), field(2e9)] }, { port: 7, position: [7, 0, 0], fields: [field(1e9), field(2e9)] }],
} } });
let cases = 0;
const admitted = strictElementPatternsAt(sample(), 1e9);
assert.equal(admitted.ok, true);
assert.deepEqual(admitted.set.elements.map(e => e.port), [2, 7]);
assert.equal(admitted.radiusM, 2);
assert.deepEqual(admitted.positions.get(7), [7, 0, 0]);
assert.ok(Math.abs(admitted.set.elements[0].eThetaRe[0][0] - 1) <= 2 / 32767);
cases++;
function refuses(edit, reason, frequency = 1e9) {
  const b = sample(); edit(b.results.element_patterns, b);
  assert.deepEqual(strictElementPatternsAt(b, frequency), { ok: false, reason }); cases++;
}
refuses(p => { delete p.basis; }, 'basis');
refuses(p => { p.normalization = 'independent runs'; }, 'basis');
for (const radius of [0, -1, NaN, Infinity]) refuses(p => { p.radius_m = radius; }, 'metadata');
refuses(p => { delete p.mirror_planes; }, 'metadata');
refuses(p => { p.mirror_planes = 0.5; }, 'metadata');
refuses(p => { p.phase_center = [0, NaN, 0]; }, 'metadata');
refuses(p => { p.decimation = 0; }, 'metadata');
refuses(p => { p.encoding = 'guess'; }, 'metadata');
refuses(p => { p.theta = [0, 0, 180]; }, 'grid');
refuses(p => { p.theta = [1, 90, 180]; }, 'grid');
refuses(p => { p.theta = [0, 45, 90]; }, 'grid');
refuses(p => { p.phi = [0, 180, 360]; }, 'grid');
refuses(p => { p.shape = [9, 1]; }, 'grid');
refuses(p => { p.frequencies = [1e9, 1e9]; }, 'frequency');
refuses(() => {}, 'frequency', 1e9 + 1); // Never inherit display reader's 1 MHz proximity.
refuses(p => { p.ports[0].fields[0].f = 2e9; }, 'frequency');
refuses(p => { p.ports[0].fields.pop(); }, 'frequency');
refuses(p => { p.ports[0].port = 7; }, 'ports');
refuses(p => { p.ports[0].position = [0, 0]; }, 'ports');
refuses((p, b) => { b.ports[0].number = 2; }, 'ports');
refuses(p => { p.ports.pop(); }, 'ports');
refuses(p => { p.ports[0].fields[0].scale = -1; }, 'fields');
refuses(p => { p.ports[0].fields[0].e_phi_im = '!!!!'; }, 'fields');
refuses(p => { p.ports[0].fields[0].e_theta_re = Buffer.alloc(2).toString('base64'); }, 'fields');
refuses(p => { const v = Buffer.alloc(18); v.writeInt16LE(-32768); p.ports[0].fields[0].e_theta_im = v.toString('base64'); }, 'fields');
refuses(p => { p.encoding = 'f32le-base64'; for (const port of p.ports) for (const f of port.fields) for (const key of ['e_theta_re', 'e_theta_im', 'e_phi_re', 'e_phi_im']) {
  const v = Buffer.alloc(36); v.writeFloatLE(Infinity); f[key] = v.toString('base64');
} }, 'fields');
refuses(p => { p.frequencies = Array.from({ length: 65 }, (_, i) => 1e9 + i); }, 'budget');
const mirrored = sample(); mirrored.results.element_patterns.theta = [0, 45, 90]; mirrored.results.element_patterns.mirror_planes = 1;
mirrored.solver.boundaries['z-'] = 'PEC';
assert.equal(strictElementPatternsAt(mirrored, 1e9).ok, true); cases++;
const zero = sample(); for (const p of zero.results.element_patterns.ports) p.fields[0].scale = 0;
assert.equal(strictElementPatternsAt(zero, 1e9).ok, true); // Valid encoding; downstream power denominator remains unavailable.
cases++;
// Missing or conflicting physical metadata must not be replaced with view defaults.
for (const edit of [b => delete b.nf2ff_center, b => b.nf2ff_center = null, b => b.nf2ff_center = [1e-12, 0, 0],
  b => delete b.units, b => b.units.length_m = 0, b => b.units.length_m = Infinity,
  b => delete b.solver, b => delete b.solver.boundaries['x-'], b => b.solver.boundaries['x-'] = '?',
  b => b.solver.boundaries['x-'] = true, b => b.solver.boundaries['x-'] = 'PERIODIC_TEST',
  b => b.solver.boundaries['z-'] = 'PEC']) refuses((_, b) => edit(b), 'metadata');
refuses(p => { p.phase_center = [0, 0, .001]; }, 'metadata');
refuses(p => { p.mirror_planes = 1; }, 'metadata');
const axes = sample();
Object.assign(axes.solver.boundaries, { 'x-': 'pec', 'x+': 'PMC', 'y-': 0, 'y+': 1, 'z-': 2, 'z+': 3 });
axes.results.element_patterns.mirror_planes = 2;
assert.equal(strictElementPatternsAt(axes, 1e9).ok, true); cases++; // Two faces on one axis count once.
const namedCodes = sample(); Object.assign(namedCodes.solver.boundaries, { 'x-': '0', 'x+': '1', 'y-': 'mur', 'y+': 'PML', 'z-': 'PML_12' });
namedCodes.results.element_patterns.mirror_planes = 1;
assert.equal(strictElementPatternsAt(namedCodes, 1e9).ok, true); cases++;
for (const edit of [b => delete b.ports[0].start, b => b.ports[0].stop = [0, 0], b => b.ports[0].start[0] = NaN,
  b => b.ports[0] = null, b => b.ports[0].stop[0] += .000002]) refuses((_, b) => edit(b), 'ports');
refuses(p => { p.ports[1].position[0] += .000001; }, 'ports');
// Independent exact binary midpoints: these are decimal half ties for Python round(...,6).
for (const [midpoint, expected] of [[.0078125, .007812], [.0234375, .023438], [-.0078125, -.007812], [-.0234375, -.023438],
  [1.2345674, 1.234567], [1.2345676, 1.234568], [Number.MIN_VALUE, 0], [-Number.MIN_VALUE, -0]]) {
  const b = sample(); b.ports[0].start = [midpoint, midpoint, midpoint]; b.ports[0].stop = [...b.ports[0].start];
  b.results.element_patterns.ports[1].position = [expected, expected, expected];
  assert.equal(strictElementPatternsAt(b, 1e9).ok, true); cases++;
}
refuses((p, b) => { b.ports[0].start = [.0078125, 0, 0]; b.ports[0].stop = [.0078125, 0, 0]; p.ports[1].position = [.007813, 0, 0]; }, 'ports');
const rounded = sample(); rounded.ports[0].start = [.149896229, 0, 0]; rounded.ports[0].stop = [.149896229, 0, 0];
rounded.results.element_patterns.ports[1].position = [.149896, 0, 0];
assert.equal(strictElementPatternsAt(rounded, 1e9).ok, true); cases++;
rounded.results.element_patterns.ports[1].position[0] = .149896229;
assert.deepEqual(strictElementPatternsAt(rounded, 1e9), { ok: false, reason: 'ports' }); cases++;
for (const grid of [undefined, [], [0, 2e9], [1e9, 1e9], [2e9, 1e9], [1e9, NaN], [1e9 + 1, 2e9], [1e9, 2e9 - 1]])
  refuses((_, b) => { b.results.frequency = grid; }, 'frequency');
const betweenSamples = sample(); betweenSamples.results.element_patterns.frequencies[0] += 1;
betweenSamples.results.element_patterns.ports.forEach(p => { p.fields[0].f += 1; });
assert.equal(strictElementPatternsAt(betweenSamples, 1e9 + 1).ok, true); cases++; // In-band exact NF2FF frequency need not be an S-grid point.
refuses((p, b) => { p.frequencies[1] = 2e9 + 1; p.ports.forEach(port => { port.fields[1].f = 2e9 + 1; }); }, 'frequency');
const source = sample(), projection = structuredClone(source);
registerPortProjection(projection, { source, settings: { referenceOhm: 75, delayPs: {} }, physicalPorts: [7, 2], sourceReferences: [50, 50],
  missingSamples: 0, description: 'synthetic port projection', channels: [], primaryIndex: 1 });
assert.deepEqual(strictElementPatternsAt(projection, 1e9), { ok: false, reason: 'basis' }); cases++;
assert.equal(strictElementPatternsAt(originalPortResult(projection), 1e9).ok, true); cases++;
console.log(`pattern-admission: ${cases} admission/corruption/boundary controls passed; no native measurements`);
