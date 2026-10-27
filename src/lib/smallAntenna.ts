/** Sample-derived input-impedance Q at natural X=0 crossings. No field-energy Q,
 * universal antenna bound, or numerical qualification is inferred. Frequencies are Hz.
 * Formula sources and the software screening thresholds are documented in RESULTS.md. */
import type { Bundle, Vec3 } from '../types.ts';
import { sweep, type Sweep } from './rf.ts';
import { hasSParameterPhase, physicalPortNumber, sMatrix } from './sparams.ts';
import { portProcessingInfo } from './portProcessingMetadata.ts';
import { finalEnergy } from './run.ts';

export const SMALL_ANTENNA_REASONS = [
  'no-results', 'projected-plane', 'not-single-port', 'missing-phase', 'invalid-reference',
  'invalid-frequency-grid', 'invalid-impedance', 'insufficient-samples', 'no-resonance',
  'invalid-selection', 'choose-resonance', 'edge-resonance', 'flat-resonance', 'unresolved-derivative',
  'zero-derivative', 'multiple-resonances', 'invalid-vswr', 'broad-response',
  'bandwidth-edges', 'bandwidth-unstable', 'empty-geometry', 'invalid-parts',
  'invalid-bounds', 'invalid-units', 'invalid-enclosure', 'invalid-image-plane',
  'missing-resonance', 'not-small', 'incomplete-geometry', 'uncertain-geometry',
  'non-free-space', 'image-reference', 'unavailable-efficiency', 'efficiency-frequency',
  'efficiency-port', 'efficiency-quality', 'efficiency-power', 'efficiency-convergence',
  'model-normalized',
] as const;
export type SmallAntennaReason = typeof SMALL_ANTENNA_REASONS[number];
export interface SmallAntennaOptions {
  resonanceId: string | null;
  vswr: number;
  selectedPartIndices: readonly number[];
  enclosure: 'finite' | 'pec-image';
}
interface Availability { available: boolean; reason: SmallAntennaReason | null }
export interface SmallAntennaCandidate extends Availability { id: string; f0Hz: number }
export interface SmallAntennaQ extends Availability {
  f0Hz: number | null; r0Ohm: number | null; dRdf: number | null; dXdf: number | null;
  qz: number | null; stencilHz: number[]; q3: number | null; q5: number | null;
}
export interface SmallAntennaBand extends Availability {
  fraction: number | null; hz: number | null; lowerHz: number | null; upperHz: number | null;
}
export interface SmallAntennaGeometry extends Availability {
  parts: { index: number; name: string; selected: boolean; void: boolean }[];
  selectedPartIndices: number[]; excludedPartIndices: number[];
  centerM: Vec3 | null; radiusM: number | null; ka: number | null;
  enclosure: 'finite' | 'pec-image'; planeM: number | null;
}
export interface SmallAntennaAnalysis extends Availability {
  candidates: SmallAntennaCandidate[]; selectedCandidateId: string | null;
  q: SmallAntennaQ;
  bandwidth: { vswr: number; predicted: SmallAntennaBand; observed: SmallAntennaBand };
  geometry: SmallAntennaGeometry;
  reference: Availability & { qChuMcLean: number | null; ratio: number | null; ratioReason: SmallAntennaReason | null };
  efficiency: Availability & { value: number | null; kind: 'power-ratio' | 'model-normalized' | 'unavailable'; raw: number | null; frequencyHz: number | null; port: number | null;
    pradW: number | null; paccW: number | null; qa: string[]; energyDb: number | null; endCriterionDb: number | null };
  provenance: { port: number | null; portType: string | null; plane: 'original-stored' | 'projected' | 'unknown'; source: string; feedMetadata: string };
  assumptions: string[];
}
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const positive = (x: unknown): x is number => finite(x) && x > 0;
const available = (): Availability => ({ available: true, reason: null });
const unavailable = (reason: SmallAntennaReason): Availability => ({ available: false, reason });
const emptyQ = (reason: SmallAntennaReason): SmallAntennaQ => ({ ...unavailable(reason), f0Hz: null, r0Ohm: null,
  dRdf: null, dXdf: null, qz: null, stencilHz: [], q3: null, q5: null });
const emptyBand = (reason: SmallAntennaReason): SmallAntennaBand => ({ ...unavailable(reason), fraction: null, hz: null, lowerHz: null, upperHz: null });
const closeFrequency = (a: number, b: number) => Math.abs(a - b) <= 32 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
const vec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(finite);
const bounds = (v: unknown): v is [Vec3, Vec3] => Array.isArray(v) && v.length === 2 && vec(v[0]) && vec(v[1]) && v[0].every((x, i) => x <= v[1][i]);
const recognizedImage = (b: Bundle) => b.half_space?.axis === 'z' && b.half_space.side === 'min'
  && b.half_space.kind?.toUpperCase() === 'PEC' && finite(b.half_space.position) && b.solver?.boundaries?.['z-']?.toUpperCase() === 'PEC';

export function defaultSmallAntennaOptions(b: Bundle): SmallAntennaOptions {
  return { resonanceId: null, vswr: 2, selectedPartIndices: (b.parts ?? []).flatMap((p, i) => p.void ? [] : [i]),
    enclosure: recognizedImage(b) ? 'pec-image' : 'finite' };
}

/** Explicit malformed matrix metadata cannot fall through the legacy adapter. */
function admittedSweep(b: Bundle): { s: Sweep | null; reason: SmallAntennaReason | null } {
  const fail = (reason: SmallAntennaReason) => ({ s: null, reason });
  if (!b.results) return fail('no-results');
  if (portProcessingInfo(b)) return fail('projected-plane');
  if (!Array.isArray(b.ports) || b.ports.length !== 1 || !Number.isInteger(b.ports[0].number) || b.ports[0].number < 1) return fail('not-single-port');
  if (!hasSParameterPhase(b)) return fail('missing-phase');
  const f = b.results.frequency;
  if (!Array.isArray(f) || !f.every((v, i) => positive(v) && (!i || v > f[i - 1]))) return fail('invalid-frequency-grid');
  const pr = b.results.ports?.[String(b.ports[0].number)];
  if (!pr || ![pr.zin_re, pr.zin_im, pr.s11_re, pr.s11_im].every(a => Array.isArray(a) && a.length === f.length)) return fail('invalid-impedance');
  const m = sMatrix(b);
  if (!m || m.ports.length !== 1 || m.physicalPorts === null || physicalPortNumber(m, m.ports[0]) !== b.ports[0].number
    || (b.results.sparams !== undefined && (m.legacy || b.results.sparams === null))) return fail('not-single-port');
  const reference = b.ports[0].reference_impedance;
  const s = sweep(b);
  if (!s || !positive(s.zRef) || !positive(pr.z_ref) || s.zRef !== pr.z_ref || m.zRef.length !== 1
    || (reference !== undefined && (!finite(reference.imag) || reference.imag !== 0 || reference.real !== s.zRef))
    || (pr.power_wave_reference !== undefined && (pr.power_wave_reference.imag !== 0 || pr.power_wave_reference.real !== s.zRef))
    || (pr.z_ref_f !== undefined && (!Array.isArray(pr.z_ref_f) || pr.z_ref_f.length !== f.length || !pr.z_ref_f.every(v => v === s.zRef)))) return fail('invalid-reference');
  if (f.length < 5) return fail('insufficient-samples');
  if (![s.zRe, s.zIm, s.s11Re, s.s11Im].every(a => Array.isArray(a) && a.length === f.length)) return fail('invalid-impedance');
  return { s, reason: null };
}
const validSample = (s: Sweep, i: number) => positive(s.zRe[i]) && finite(s.zIm[i]) && finite(s.s11Re[i]) && finite(s.s11Im[i]);
interface Crossing { id: string; lo: number; hi: number; f0: number; reason: SmallAntennaReason | null }
function crossings(s: Sweep): Crossing[] {
  const out: Crossing[] = [];
  for (let i = 0; i < s.f.length; i++) {
    if (!validSample(s, i)) continue;
    if (s.zIm[i] === 0) {
      const flat = s.zIm[i - 1] === 0 || s.zIm[i + 1] === 0;
      if (i && s.zIm[i - 1] === 0) continue;
      const edge = i === 0 || i === s.f.length - 1;
      if (flat || edge || (validSample(s, i - 1) && validSample(s, i + 1) && Math.sign(s.zIm[i - 1]) !== Math.sign(s.zIm[i + 1])))
        out.push({ id: `x0:${s.f[i]}:${s.f[i]}`, lo: i, hi: i, f0: s.f[i], reason: flat ? 'flat-resonance' : edge ? 'edge-resonance' : null });
    } else if (i + 1 < s.f.length && validSample(s, i + 1) && s.zIm[i + 1] !== 0 && Math.sign(s.zIm[i]) !== Math.sign(s.zIm[i + 1])) {
      // Scale the interpolation to avoid overflowing a reactance difference.
      const a = Math.abs(s.zIm[i]), b = Math.abs(s.zIm[i + 1]), scale = Math.max(a, b);
      const t = (a / scale) / (a / scale + b / scale);
      out.push({ id: `x0:${s.f[i]}:${s.f[i + 1]}`, lo: i, hi: i + 1, f0: s.f[i] + (s.f[i + 1] - s.f[i]) * t, reason: null });
    }
  }
  return out;
}

/** Lagrange polynomial on normalized nonuniform coordinates, with analytic derivative.
 * Small (3/5 point) stencils are deliberately local; no frequency-gap interpolation. */
function polynomial(xs: number[], ys: number[], origin: number) {
  const scale = xs.at(-1)! - xs[0];
  if (!positive(scale)) return null;
  const t = xs.map(x => (x - origin) / scale), coeff = Array(xs.length).fill(0) as number[];
  for (let i = 0; i < t.length; i++) {
    let term = [1], divisor = 1;
    for (let j = 0; j < t.length; j++) if (i !== j) {
      const next = Array(term.length + 1).fill(0) as number[];
      term.forEach((v, k) => { next[k] -= t[j] * v; next[k + 1] += v; });
      term = next; divisor *= t[i] - t[j];
    }
    if (!finite(divisor) || divisor === 0) return null;
    term.forEach((v, k) => { coeff[k] += v * ys[i] / divisor; });
  }
  if (!coeff.every(finite)) return null;
  return (f: number) => {
    const x = (f - origin) / scale;
    let value = coeff.at(-1)!, derivative = 0;
    for (let i = coeff.length - 2; i >= 0; i--) { derivative = derivative * x + value; value = value * x + coeff[i]; }
    return { value, derivative: derivative / scale };
  };
}
function fittedRoot(s: Sweep, c: Crossing, indices: number[]) {
  if (!indices.every(i => i >= 0 && i < s.f.length && validSample(s, i))) return null;
  const fs = indices.map(i => s.f[i]), r = polynomial(fs, indices.map(i => s.zRe[i]), c.f0), x = polynomial(fs, indices.map(i => s.zIm[i]), c.f0);
  if (!r || !x) return null;
  let lo = s.f[c.lo], hi = s.f[c.hi], root = lo;
  if (lo !== hi) {
    let xl = x(lo).value;
    if (!finite(xl) || !finite(x(hi).value) || Math.sign(xl) === Math.sign(x(hi).value)) return null;
    for (let k = 0; k < 60; k++) {
      root = lo + (hi - lo) / 2;
      const xm = x(root).value;
      if (!finite(xm)) return null;
      if (xm === 0 || closeFrequency(lo, hi)) break;
      if (Math.sign(xm) === Math.sign(xl)) { lo = root; xl = xm; } else hi = root;
    }
  }
  const rr = r(root), xx = x(root), q = root * Math.hypot(rr.derivative, xx.derivative) / (2 * rr.value);
  return positive(rr.value) && [q, rr.derivative, xx.derivative, root].every(finite)
    ? { f0: root, r0: rr.value, dRdf: rr.derivative, dXdf: xx.derivative, q } : null;
}
function qAtCrossing(s: Sweep, c: Crossing, all: Crossing[]): SmallAntennaQ {
  const out = { ...emptyQ(c.reason ?? 'unresolved-derivative'), f0Hz: c.f0 };
  if (c.reason) return out;
  if (c.lo === c.hi ? c.lo < 2 || c.hi > s.f.length - 3 : c.lo < 1 || c.hi > s.f.length - 2) return { ...out, ...unavailable('edge-resonance') };
  const near = Math.abs(s.f[c.lo] - c.f0) <= Math.abs(s.f[c.hi] - c.f0) ? c.lo : c.hi;
  const center = Math.max(2, Math.min(s.f.length - 3, near)), five = [-2, -1, 0, 1, 2].map(j => center + j), three = [center - 1, center, center + 1];
  out.stencilHz = five.map(i => s.f[i]);
  if (!five.every(i => validSample(s, i))) return { ...out, ...unavailable('invalid-impedance') };
  if (all.some(other => other !== c && other.f0 >= out.stencilHz[0] && other.f0 <= out.stencilHz[4])) return { ...out, ...unavailable('multiple-resonances') };
  const q3 = fittedRoot(s, c, three), q5 = fittedRoot(s, c, five);
  if (!q3 || !q5) return out;
  Object.assign(out, { f0Hz: q5.f0, r0Ohm: q5.r0, dRdf: q5.dRdf, dXdf: q5.dXdf, q3: q3.q, q5: q5.q });
  if (!(q5.q > 0) || !(q3.q > 0)) return { ...out, ...unavailable('zero-derivative') };
  const bracket = c.lo === c.hi ? Math.min(s.f[c.lo] - s.f[c.lo - 1], s.f[c.hi + 1] - s.f[c.hi]) : s.f[c.hi] - s.f[c.lo];
  if (Math.abs(q3.q - q5.q) / q5.q > .05 || Math.abs(q3.f0 - q5.f0) > .25 * bracket) return out;
  return { ...out, ...available(), qz: q5.q };
}

function bandwidth(s: Sweep, q: SmallAntennaQ, vswr: number, all: Crossing[], selected: Crossing | null): SmallAntennaAnalysis['bandwidth'] {
  const result = { vswr, predicted: emptyBand(q.reason ?? 'missing-resonance'), observed: emptyBand(q.reason ?? 'missing-resonance') };
  if (!finite(vswr) || vswr <= 1) return { vswr, predicted: emptyBand('invalid-vswr'), observed: emptyBand('invalid-vswr') };
  if (!q.available || !positive(q.qz) || !positive(q.f0Hz) || !positive(q.r0Ohm)) return result;
  const f0 = q.f0Hz, r0 = q.r0Ohm, fraction = (vswr - 1) / (Math.sqrt(vswr) * q.qz), hz = f0 * fraction;
  if (!positive(fraction) || !positive(hz)) return { vswr, predicted: emptyBand('bandwidth-unstable'), observed: emptyBand('bandwidth-unstable') };
  result.predicted = { ...available(), fraction, hz, lowerHz: f0 - hz / 2, upperHz: f0 + hz / 2 };
  result.observed = emptyBand('bandwidth-edges');
  const refuse = (reason: SmallAntennaReason) => { result.predicted = emptyBand(reason); return result; };
  if (fraction > .1) return refuse('broad-response');
  const threshold = ((vswr - 1) / (vswr + 1)) ** 2;
  const samples = s.f.map((f, i) => {
    const r = s.zRe[i], x = s.zIm[i], den = Math.hypot(r + r0, x);
    return { f, value: validSample(s, i) && positive(den) ? (Math.hypot(r - r0, x) / den) ** 2 : NaN };
  });
  // Insert the interpolated natural resonance; do not bridge missing recorded samples.
  const at = samples.findIndex(p => p.f >= f0);
  if (at < 0) return refuse('bandwidth-edges');
  if (closeFrequency(samples[at].f, f0)) samples[at] = { f: f0, value: 0 };
  else samples.splice(at, 0, { f: f0, value: 0 });
  const edge = (direction: -1 | 1) => {
    let prev = samples[at], count = 0;
    for (let i = at + direction; i >= 0 && i < samples.length; i += direction) {
      const next = samples[i]; count++;
      if (!finite(next.value)) return null;
      if (next.value >= threshold) {
        if (count < 2 || next.value === prev.value) return null;
        return prev.f + (next.f - prev.f) * (threshold - prev.value) / (next.value - prev.value);
      }
      prev = next;
    }
    return null;
  };
  const lower = edge(-1), upper = edge(1);
  if (lower === null || upper === null || !(lower < f0 && upper > f0)) return refuse('bandwidth-edges');
  const observedHz = upper - lower;
  result.observed = { ...available(), lowerHz: lower, upperHz: upper, hz: observedHz, fraction: observedHz / f0 };
  const lo = Math.min(lower, result.predicted.lowerHz!), hi = Math.max(upper, result.predicted.upperHz!);
  if (all.some(c => c !== selected && c.f0 >= lo && c.f0 <= hi)) {
    result.observed = emptyBand('multiple-resonances');
    return refuse('multiple-resonances');
  }
  if (lo < s.f[0] || hi > s.f.at(-1)!) return refuse('bandwidth-edges');
  for (let i = 0; i < s.f.length; i++) if (s.f[i] >= lo && s.f[i] <= hi) {
    const center = Math.max(2, Math.min(s.f.length - 3, i)), indices = [-2, -1, 0, 1, 2].map(j => center + j);
    if (!indices.every(j => validSample(s, j))) return refuse('bandwidth-unstable');
    const fs = indices.map(j => s.f[j]), r = polynomial(fs, indices.map(j => s.zRe[j]), s.f[i]), x = polynomial(fs, indices.map(j => s.zIm[j]), s.f[i]);
    if (!r || !x) return refuse('bandwidth-unstable');
    const rr = r(s.f[i]), xx = x(s.f[i]), localQ = s.f[i] * Math.hypot(rr.derivative, xx.derivative) / (2 * rr.value);
    if (!positive(localQ) || Math.abs(localQ - q.qz) / q.qz > .1) return refuse('bandwidth-unstable');
  }
  if (Math.abs(observedHz - hz) / hz > .1) return refuse('bandwidth-unstable');
  return result;
}

export function analyzeSmallAntennaGeometry(b: Bundle, options: SmallAntennaOptions, f0Hz: number | null): SmallAntennaGeometry {
  const parts = b.parts ?? [], indices = Array.isArray(options.selectedPartIndices) ? [...options.selectedPartIndices] : [];
  const result: SmallAntennaGeometry = { ...unavailable('empty-geometry'), parts: parts.map((p, index) => ({ index, name: p.label ?? p.name, selected: indices.includes(index), void: !!p.void })),
    selectedPartIndices: indices, excludedPartIndices: parts.flatMap((p, i) => !p.void && !indices.includes(i) ? [i] : []),
    centerM: null, radiusM: null, ka: null, enclosure: options.enclosure, planeM: null };
  const fail = (reason: SmallAntennaReason) => ({ ...result, ...unavailable(reason) });
  if (!Array.isArray(options.selectedPartIndices) || new Set(indices).size !== indices.length || indices.some(i => !Number.isInteger(i) || i < 0 || i >= parts.length || parts[i].void)) return fail('invalid-parts');
  if (!indices.length) return result;
  if (!positive(b.units?.length_m)) return fail('invalid-units');
  if (!indices.every(i => bounds(parts[i].bbox))) return fail('invalid-bounds');
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const index of indices) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], parts[index].bbox[0][a]); hi[a] = Math.max(hi[a], parts[index].bbox[1][a]); }
  if (options.enclosure === 'pec-image') {
    if (!recognizedImage(b)) return fail('invalid-image-plane');
    const z = b.half_space!.position, oldLo = lo[2], oldHi = hi[2];
    if (oldLo < z) return fail('invalid-image-plane');
    lo[2] = Math.min(oldLo, 2 * z - oldHi); hi[2] = Math.max(oldHi, 2 * z - oldLo);
    result.planeM = z * b.units.length_m;
  } else if (options.enclosure !== 'finite') return fail('invalid-enclosure');
  const unit = b.units.length_m, radius = Math.hypot(...hi.map((v, a) => (v - lo[a]) * unit / 2)), center = lo.map((v, a) => (v / 2 + hi[a] / 2) * unit) as Vec3;
  if (!positive(radius) || !center.every(finite) || (result.planeM !== null && !finite(result.planeM))) return fail('invalid-bounds');
  const ka = positive(f0Hz) ? 2 * Math.PI * f0Hz * radius / 299792458 : null;
  return { ...result, ...available(), centerM: center, radiusM: radius, ka: ka !== null && positive(ka) ? ka : null };
}

/** All model parts and finite feed/element bounds must fit the selected enclosure.
 * This only admits a qualified diagnostic; it does not identify a spherical mode. */
function ratioEligibility(b: Bundle, g: SmallAntennaGeometry): SmallAntennaReason | null {
  if (!g.available) return g.reason;
  if (g.enclosure === 'pec-image') return 'image-reference';
  if (g.excludedPartIndices.length) return 'incomplete-geometry';
  if (b.half_space) return 'non-free-space';
  const walls = b.solver?.boundaries;
  if (!walls || !(['x-', 'x+', 'y-', 'y+', 'z-', 'z+'] as const).every(face => /^(MUR|PML(?:_\d+)?)$/i.test(walls[face] ?? ''))) return 'non-free-space';
  // Fairbeam's project exporter uses vacuum outside the finite listed components.
  if (b.generator?.name?.toLowerCase() !== 'fairbeam' || b.schema !== 'fairbeam.project/1') return 'uncertain-geometry';
  if (g.selectedPartIndices.some(i => !b.parts[i].primitives?.length || b.parts[i].primitives.some(p => p.exact !== true || !bounds(p.bbox)))) return 'uncertain-geometry';
  const lo = g.selectedPartIndices.map(i => b.parts[i].bbox[0]).reduce((a, p) => a.map((x, j) => Math.min(x, p[j])) as Vec3);
  const hi = g.selectedPartIndices.map(i => b.parts[i].bbox[1]).reduce((a, p) => a.map((x, j) => Math.max(x, p[j])) as Vec3);
  const contained = (p: unknown) => vec(p) && p.every((x, j) => x >= lo[j] && x <= hi[j]);
  if (b.ports.some(p => !contained(p.start) || !contained(p.stop) || p.group?.members.some(m => !contained(m.start) || !contained(m.stop)))
    || b.lumped_elements?.some(e => !contained(e.start) || !contained(e.stop))) return 'incomplete-geometry';
  // A finite selected box must also actually contain its exported primitive boxes.
  if (g.selectedPartIndices.some(i => b.parts[i].primitives.some(p => !contained(p.bbox[0]) || !contained(p.bbox[1])))) return 'invalid-bounds';
  return null;
}

function efficiency(b: Bundle, f0: number | null): SmallAntennaAnalysis['efficiency'] {
  const port = b.ports?.length === 1 ? b.ports[0].number : null;
  const result: SmallAntennaAnalysis['efficiency'] = { ...unavailable('unavailable-efficiency'), value: null, raw: null, kind: 'unavailable', frequencyHz: null, port,
    pradW: null, paccW: null, qa: [], energyDb: null, endCriterionDb: finite(b.solver?.end_criteria_db) ? b.solver.end_criteria_db : null };
  const fail = (reason: SmallAntennaReason) => ({ ...result, ...unavailable(reason) });
  if (portProcessingInfo(b)) return fail('projected-plane');
  if (port === null) return fail('efficiency-port');
  if (!positive(f0)) return fail('missing-resonance');
  type Power = { f: number; prad: number; pacc: number | null; value: number | null; raw?: number | null; quality: boolean; qa: string[] };
  const powers: Power[] = [];
  let any = false, samePort = false;
  for (const e of b.results?.efficiency ?? []) {
    any = true;
    if ((e.port ?? port) !== port) continue;
    samePort = true;
    const n = e.f?.length;
    if (!Array.isArray(e.f) || !e.f.every((f, i) => positive(f) && (!i || f > e.f[i - 1]))
      || ![e.prad_w, e.pacc_w, e.rad_efficiency].every(v => Array.isArray(v) && v.length === n)
      || [e.rad_efficiency_raw, e.reliable, e.pacc_error].some(v => v !== undefined && (!Array.isArray(v) || v.length !== n))) return fail('efficiency-quality');
    for (let i = 0; i < n; i++) if (closeFrequency(e.f[i], f0)) powers.push({ f: e.f[i], prad: e.prad_w[i], pacc: e.pacc_w[i], value: e.rad_efficiency[i], raw: e.rad_efficiency_raw?.[i],
      qa: e.qa_warnings ?? [], quality: !e.qa_warnings?.length && (e.reliable === undefined || e.reliable[i] === true)
        && (e.pacc_error === undefined || finite(e.pacc_error[i]) && e.pacc_error[i]! >= 0 && e.pacc_error[i]! <= .1) });
  }
  for (const ff of b.results?.farfield ?? []) {
    any = true;
    if ((ff.port ?? port) !== port) continue;
    samePort = true;
    if (positive(ff.f) && closeFrequency(ff.f, f0)) powers.push({ f: ff.f, prad: ff.prad_w, pacc: ff.pacc_w, value: ff.rad_efficiency, raw: ff.rad_efficiency_raw, qa: ff.qa_warnings ?? [], quality: !ff.qa_warnings?.length });
  }
  if (!powers.length) return fail(any ? samePort ? 'efficiency-frequency' : 'efficiency-port' : 'unavailable-efficiency');
  const first = powers[0];
  result.frequencyHz = first.f;
  result.pradW = finite(first.prad) ? first.prad : null; result.paccW = finite(first.pacc) ? first.pacc : null;
  result.qa = [...new Set(powers.flatMap(p => p.qa))];
  if (positive(first.pacc) && finite(first.prad)) {
    const raw = first.prad / first.pacc;
    result.raw = finite(raw) ? raw : null;
  }
  const normalized = powers.some(p => p.raw !== undefined && p.raw !== null && p.value === 1);
  if (normalized) { result.kind = 'model-normalized'; result.value = 1; }
  const ratioClose = (a: number, c: number) => Math.abs(a - c) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(c));
  for (const p of powers) {
    if (!positive(p.pacc) || !finite(p.prad) || p.prad <= 0 || !positive(p.value) || p.value > 1) return fail('efficiency-power');
    const raw = p.prad / p.pacc;
    if (!positive(raw) || raw > 1 || (p.raw !== undefined && (!finite(p.raw) || !ratioClose(p.raw, raw)))
      || (!normalized && !ratioClose(p.value, raw)) || !ratioClose(raw, result.raw!)) return fail('efficiency-power');
  }
  if (normalized) return fail('model-normalized');
  if (powers.some(p => !p.quality)) return fail('efficiency-quality');
  const run = b.run;
  if (!run || run.converged !== true || run.hit_timestep_limit !== false || !finite(b.solver?.end_criteria_db) || b.solver.end_criteria_db >= 0
    || !Array.isArray(run.energy_trace) || !Number.isInteger(run.timesteps) || run.timesteps! <= 0
    || (run.excitation_timesteps !== undefined && (!Number.isInteger(run.excitation_timesteps) || run.excitation_timesteps <= 0 || run.excitation_timesteps >= run.timesteps!))
    || [run.final_energy_db, run.final_energy_bound_db].some(v => v !== undefined && !finite(v))) return fail('efficiency-convergence');
  const energy = finalEnergy(run, b.solver.end_criteria_db);
  result.energyDb = finite(energy.db) ? energy.db : null;
  if (!finite(energy.db) || energy.db > b.solver.end_criteria_db) return fail('efficiency-convergence');
  if (run.final_energy_bound_db !== undefined && run.final_energy_bound_db > b.solver.end_criteria_db) return fail('efficiency-convergence');
  if (run.port_runs !== undefined && (run.port_runs.length !== 1 || run.port_runs[0].port !== port || run.port_runs[0].converged !== true
    || [run.port_runs[0].final_energy_db, run.port_runs[0].final_energy_bound_db].some(v => v !== undefined && (!finite(v) || v > b.solver.end_criteria_db)))) return fail('efficiency-convergence');
  return { ...result, ...available(), value: result.raw, kind: 'power-ratio' };
}

export function smallAntennaAnalysis(b: Bundle, options: SmallAntennaOptions = defaultSmallAntennaOptions(b)): SmallAntennaAnalysis {
  const admitted = admittedSweep(b), s = admitted.s, all = s ? crossings(s) : [];
  const qs = s ? all.map(c => qAtCrossing(s, c, all)) : [];
  const candidates = all.map((c, i) => ({ id: c.id, f0Hz: qs[i].f0Hz ?? c.f0, available: qs[i].available, reason: qs[i].reason }));
  const eligible = candidates.flatMap((c, i) => c.available ? [i] : []);
  const mustChoose = options.resonanceId === null && eligible.length > 1;
  const chosen = options.resonanceId === null ? mustChoose ? -1 : eligible[0] ?? (candidates.length ? 0 : -1)
    : candidates.findIndex(c => c.id === options.resonanceId);
  const selected = all[chosen] ?? null;
  const q = qs[chosen] ?? emptyQ(admitted.reason ?? (mustChoose ? 'choose-resonance' : options.resonanceId === null ? 'no-resonance' : 'invalid-selection'));
  const geometry = analyzeSmallAntennaGeometry(b, options, q.available ? q.f0Hz : null);
  const reference: SmallAntennaAnalysis['reference'] = { ...unavailable(geometry.reason ?? 'missing-resonance'), qChuMcLean: null, ratio: null, ratioReason: geometry.reason ?? 'missing-resonance' };
  if (positive(geometry.ka)) {
    if (geometry.ka >= 1) Object.assign(reference, unavailable('not-small'), { ratioReason: 'not-small' });
    else {
      const formula = 1 / geometry.ka ** 3 + 1 / geometry.ka;
      if (positive(formula)) {
        Object.assign(reference, available(), { qChuMcLean: formula });
        reference.ratioReason = ratioEligibility(b, geometry) ?? (q.available ? null : q.reason);
        const ratio = q.available && q.qz !== null ? q.qz / formula : null;
        if (!reference.ratioReason) {
          if (positive(ratio)) reference.ratio = ratio;
          else reference.ratioReason = 'unresolved-derivative';
        }
      }
    }
  }
  const port = b.ports?.length === 1 ? b.ports[0] : null;
  const projection = portProcessingInfo(b);
  return { available: q.available, reason: q.reason, candidates, selectedCandidateId: selected?.id ?? null, q,
    bandwidth: s ? bandwidth(s, q, options.vswr, all, selected) : { vswr: options.vswr, predicted: emptyBand(q.reason!), observed: emptyBand(q.reason!) },
    geometry, reference, efficiency: efficiency(b, q.available ? q.f0Hz : null),
    provenance: { port: port?.number ?? null, portType: port?.type ?? null, plane: projection ? 'projected' : port ? 'original-stored' : 'unknown',
      source: JSON.stringify({ name: b.name ?? null, created: b.created ?? null, model: b.model?.id ?? null, generator: b.generator ?? null,
        units: b.units ?? null, boundaries: b.solver?.boundaries ?? null, halfSpace: b.half_space ?? null }),
      feedMetadata: JSON.stringify(port ? { start: port.start ?? null, stop: port.stop ?? null, direction: port.direction ?? null, sourcePlane: port.actual_source_plane ?? null,
        referencePlane: port.reference_plane ?? null, measurementShift: port.actual_measurement_shift ?? port.measurement_shift ?? null, group: port.group ?? null } : null) },
    assumptions: ['sampled-natural-resonance', 'original-single-port', 'three-five-point-screen-5pct', 'root-screen-quarter-interval',
      'ideal-real-match-at-resonance', 'bandwidth-screen-10pct', 'selected-box-circumsphere', 'vacuum-wavenumber',
      'single-mode-classical-reference-not-bound-verdict', 'no-efficiency-corrected-ratio', 'exact-frequency-efficiency-32eps', 'no-em-qualification'] };
}

/** Full precision, locale-independent scalar values shared by every export consumer. */
export function smallAntennaColumns(a: SmallAntennaAnalysis): { header: string[]; row: (string | number | null)[] } {
  const entries: [string, string | number | null][] = [];
  const add = (key: string, value: string | number | null) => entries.push([`small_antenna_${key}`, typeof value === 'number' && !finite(value) ? null : value]);
  add('status', a.reason ?? 'available'); add('source', a.provenance.source); add('port', a.provenance.port); add('port_type', a.provenance.portType);
  add('plane', a.provenance.plane); add('feed_metadata', a.provenance.feedMetadata); add('resonance_id', a.selectedCandidateId);
  add('f0_hz', a.q.f0Hz); add('r0_ohm', a.q.r0Ohm); add('dr_df_ohm_per_hz', a.q.dRdf); add('dx_df_ohm_per_hz', a.q.dXdf);
  add('qz', a.q.qz); add('q3', a.q.q3); add('q5', a.q.q5); add('stencil_hz', JSON.stringify(a.q.stencilHz)); add('vswr', a.bandwidth.vswr);
  for (const [name, band] of Object.entries({ predicted: a.bandwidth.predicted, observed: a.bandwidth.observed })) {
    add(`${name}_bandwidth_status`, band.reason ?? 'available'); add(`${name}_fractional_bw`, band.fraction); add(`${name}_bw_hz`, band.hz);
    add(`${name}_lower_hz`, band.lowerHz); add(`${name}_upper_hz`, band.upperHz);
  }
  add('geometry_status', a.geometry.reason ?? 'available'); add('selected_parts', JSON.stringify(a.geometry.selectedPartIndices));
  add('excluded_parts', JSON.stringify(a.geometry.excludedPartIndices)); add('part_names', JSON.stringify(a.geometry.parts.filter(p => p.selected).map(p => p.name)));
  add('enclosure', a.geometry.enclosure); add('image_plane_m', a.geometry.planeM); add('radius_m', a.geometry.radiusM);
  for (const [i, axis] of ['x', 'y', 'z'].entries()) add(`center_${axis}_m`, a.geometry.centerM?.[i] ?? null);
  add('ka', a.geometry.ka); add('reference_status', a.reference.reason ?? 'available'); add('q_chu_mclean_single_mode', a.reference.qChuMcLean);
  add('ratio_status', a.reference.ratioReason ?? 'available'); add('qz_reference_ratio', a.reference.ratio);
  add('efficiency_status', a.efficiency.reason ?? 'available'); add('efficiency_kind', a.efficiency.kind); add('radiation_efficiency', a.efficiency.value);
  add('efficiency_raw_power_ratio', a.efficiency.raw); add('efficiency_frequency_hz', a.efficiency.frequencyHz); add('efficiency_port', a.efficiency.port);
  add('efficiency_prad_w', a.efficiency.pradW); add('efficiency_pacc_w', a.efficiency.paccW); add('efficiency_qa', JSON.stringify(a.efficiency.qa));
  add('efficiency_final_energy_db', a.efficiency.energyDb); add('efficiency_end_criterion_db', a.efficiency.endCriterionDb);
  add('assumptions', a.assumptions.join(';'));
  return { header: entries.map(e => e[0]), row: entries.map(e => e[1]) };
}
