// Sampled array analysis. No solver, state, chart or display rounding in these calculations.
import type { Bundle, Vec3 } from '../types.ts';
import { activeReflection, C0, combine, directivity, gammaDb, portCentre, steeringPhases, weightComplex, type Weight } from './array.ts';
import { physicalPortNumber, sAt, sMatrix, type ElementPatternSet, type SMatrix } from './sparams.ts';
import { analyzeCut, patternMetrics } from './patternMetrics.ts';
import { strictElementPatternsAt } from './patternAdmission.ts';
import { originalPortResult } from './portProcessingMetadata.ts';
import { EFFICIENCY_TOLERANCE } from './runQuality.ts';

export type ArrayReason = 'layout' | 'weights' | 'fields' | 'basis' | 'halfSpace' | 'power' | 'matrix' | 'budget' | 'range';
export type Admission<T> = { ok: true; value: T } | { ok: false; reason: ArrayReason };
const no = (reason: ArrayReason): { ok: false; reason: ArrayReason } => ({ ok: false, reason });
const dot = (a: number[], b: number[]) => a.reduce((v, x, i) => v + x * b[i], 0);
const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]);
const norm = (a: number[]) => Math.hypot(...a);
const unit = (b: Bundle) => b.units?.length_m ?? 1e-3;
export const wrapScanPhi = (phi: number) => ((phi % 360) + 360) % 360;

export interface LinearLayout { ports: number[]; axis: Vec3; spacingM: number }
/** Reject non-collinear, coincident and nonuniform geometry; sorting is geometric, not by port ID. */
export function linearLayout(b: Bundle, ports: number[]): Admission<LinearLayout> {
  if (ports.length < 2 || ports.length > 64 || new Set(ports).size !== ports.length || !(unit(b) > 0) || !Number.isFinite(unit(b))) return no('layout');
  const points = ports.map(p => portCentre(b, p));
  if (points.some(p => !p || p.length !== 3 || !p.every(Number.isFinite)) || ports.some(p => b.ports.filter(q => q.number === p).length !== 1)) return no('layout');
  const pts = points as Vec3[];
  let a = 0, z = 1, length = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const d = norm(sub(pts[j], pts[i]));
    if (d > length) { a = i; z = j; length = d; }
  }
  if (!(length > 0)) return no('layout');
  let axis = sub(pts[z], pts[a]).map(x => x / length) as Vec3;
  const dominant = axis.findIndex(x => Math.abs(x) > 1e-8);
  if (axis[dominant] < 0) axis = axis.map(x => -x) as Vec3;
  const ordered = pts.map((p, i) => ({ port: ports[i], projection: dot(sub(p, pts[a]), axis), delta: sub(p, pts[a]) })).sort((p, q) => p.projection - q.projection);
  const spacing = length / (pts.length - 1), tolerance = spacing * 1e-5;
  if (ordered.some((p, i) => norm(p.delta.map((x, k) => x - p.projection * axis[k])) > tolerance
    || (i > 0 && Math.abs(p.projection - ordered[i - 1].projection - spacing) > tolerance))) return no('layout');
  return { ok: true, value: { ports: ordered.map(p => p.port), axis, spacingM: spacing * unit(b) } };
}

export type TaperKind = 'uniform' | 'chebyshev' | 'taylor' | 'binomial';
/** Symmetric windows, sampled maximum normalized to one. Taylor uses nbar=min(4,N).
 * Definitions: scipy.signal.windows.chebwin and taylor; binomial uses row N-1 of Pascal's triangle.
 * SLL is a design target for an ideal broadside ULA, not a measured embedded-pattern guarantee. */
export function taperAmplitudes(count: number, kind: TaperKind, attenuationDb = 30): Admission<number[]> {
  if (!Number.isInteger(count) || count < 2 || count > 64 || !['uniform', 'chebyshev', 'taylor', 'binomial'].includes(kind)
    || !Number.isFinite(attenuationDb) || attenuationDb < 20 || attenuationDb > 60) return no('range');
  let w: number[];
  if (kind === 'uniform') w = Array(count).fill(1);
  else if (kind === 'binomial') {
    w = [1];
    for (let i = 1; i < count; i++) w.push(w[i - 1] * (count - i) / i);
  } else if (kind === 'taylor') {
    const nbar = Math.min(4, count), A = Math.acosh(10 ** (attenuationDb / 20)) / Math.PI;
    const sigma2 = nbar * nbar / (A * A + (nbar - .5) ** 2);
    const coefficients = Array.from({ length: nbar - 1 }, (_, index) => {
      const m = index + 1; let numerator = m % 2 ? 1 : -1, denominator = 2;
      for (let k = 1; k < nbar; k++) {
        numerator *= 1 - m * m / (sigma2 * (A * A + (k - .5) ** 2));
        if (k !== m) denominator *= 1 - m * m / (k * k);
      }
      return numerator / denominator;
    });
    w = Array.from({ length: count }, (_, i) => 1 + 2 * coefficients.reduce((sum, c, k) => sum + c * Math.cos(2 * Math.PI * (k + 1) * (i - (count - 1) / 2) / count), 0));
  } else {
    const order = count - 1, beta = Math.cosh(Math.acosh(10 ** (attenuationDb / 20)) / order);
    const spectrum = Array.from({ length: count }, (_, k) => {
      const x = beta * Math.cos(Math.PI * k / count);
      return Math.abs(x) <= 1 ? Math.cos(order * Math.acos(x))
        : Math.cosh(order * Math.acosh(Math.abs(x))) * (x < -1 && order % 2 ? -1 : 1);
    });
    const transformed = Array.from({ length: count }, (_, i) => spectrum.reduce((sum, p, k) => sum + p * Math.cos(2 * Math.PI * k * i / count - (count % 2 ? 0 : Math.PI * k / count)), 0));
    const n = Math.floor(count / 2) + 1;
    w = count % 2 ? [...transformed.slice(1, n).reverse(), ...transformed.slice(0, n)]
      : [...transformed.slice(1, n).reverse(), ...transformed.slice(1, n)];
  }
  const peak = Math.max(...w);
  if (!(peak > 0) || w.length !== count || w.some(x => !Number.isFinite(x) || x <= 0)) return no('range');
  return { ok: true, value: w.map(x => x / peak) };
}

export function taperWeights(b: Bundle, weights: Map<number, Weight>, kind: TaperKind, attenuationDb = 30): Admission<Map<number, Weight>> {
  const layout = linearLayout(b, [...weights.keys()]);
  if (!layout.ok) return layout;
  const amplitudes = taperAmplitudes(weights.size, kind, attenuationDb);
  if (!amplitudes.ok) return amplitudes;
  return { ok: true, value: new Map(layout.value.ports.map((p, i) => [p, { ampDb: 20 * Math.log10(amplitudes.value[i]), phaseDeg: weights.get(p)!.phaseDeg }])) };
}

export interface GratingCheck { spacingWavelengths: number; orders: number[]; directionCosines: number[] }
export function gratingLobes(b: Bundle, ports: number[], f: number, theta: number, phi: number): Admission<GratingCheck> {
  const layout = linearLayout(b, ports);
  if (!layout.ok) return layout;
  if (![f, theta, phi].every(Number.isFinite) || f <= 0 || Math.abs(theta) > 90) return no('range');
  const t = theta * Math.PI / 180, p = phi * Math.PI / 180;
  const c = dot(layout.value.axis, [Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), Math.cos(t)]);
  const d = layout.value.spacingM * f / C0;
  if (!Number.isFinite(d) || d > 1000) return no('range');
  const orders: number[] = [], directionCosines: number[] = [];
  for (let m = Math.ceil((-1 - c) * d - 1e-10); m <= Math.floor((1 - c) * d + 1e-10); m++) {
    if (!m) continue;
    orders.push(m); directionCosines.push(Math.max(-1, Math.min(1, c + m / d)));
  }
  return { ok: true, value: { spacingWavelengths: d, orders, directionCosines } };
}

/** A complete network is usable only in its original wave reference, with all entries present.
 * The generic display sampler clamps endpoints; this quantitative caller first proves coverage. */
function completeNetwork(b: Bundle, weights: Map<number, Weight>, f: number): Admission<SMatrix | null> {
  const raw = b.results?.sparams;
  if (!raw || raw.complete !== true) return { ok: true, value: null };
  const S = sMatrix(b);
  if (!S || S.legacy || raw.method !== 'B A^-1' || S.ports.length !== weights.size || S.ports.some(p => !weights.has(physicalPortNumber(S, p)!))
    || S.zRef.length !== S.ports.length || S.zRef.some(z => !Number.isFinite(z) || z <= 0) || S.zRefImag?.some(z => z !== 0)
    || !S.f.length || S.f.some((x, i) => !Number.isFinite(x) || (i > 0 && x <= S.f[i - 1])) || f < S.f[0] || f > S.f.at(-1)!) return no('matrix');
  for (const i of S.ports) for (const j of S.ports) {
    const c = S.get(i, j);
    if (!c || c.re.length !== S.f.length || c.im.length !== S.f.length || c.re.some(x => !Number.isFinite(x)) || c.im.some(x => !Number.isFinite(x))) return no('matrix');
  }
  return { ok: true, value: S };
}

export interface ArrayPower { gainDbi: number; totalEfficiency: number; incidentW: number; radiatedW: number; acceptedW: number | null; directivityDbi: number }
/** Peak phasors give P_inc=1/2 Σ|a|², U=r²|E|²/(2η0). No second mismatch factor. */
export function arrayPower(b: Bundle, weights: Map<number, Weight>, f: number): Admission<ArrayPower> {
  b = originalPortResult(b); // Network view transformations do not re-reference the stored fields.
  const admitted = strictElementPatternsAt(b, f);
  if (!admitted.ok) return no(admitted.reason === 'basis' ? 'basis' : 'fields');
  if (b.half_space || admitted.mirrorPlanes !== 0) return no('halfSpace');
  const set = admitted.set, ports = set.elements.map(e => e.port);
  if (weights.size !== ports.length || [...weights].some(([p, w]) => !ports.includes(p) || !Number.isFinite(w.phaseDeg) || (!Number.isFinite(w.ampDb) && w.ampDb !== -Infinity))) return no('weights');
  const incidentW = .5 * [...weights.values()].reduce((sum, w) => sum + 10 ** (w.ampDb / 10), 0);
  if (!(incidentW > 0) || !Number.isFinite(incidentW)) return no('weights');
  const network = completeNetwork(b, weights, f);
  if (!network.ok) return network;
  let acceptedW: number | null = null;
  if (network.value) {
    const S = network.value; let reflectedW = 0;
    for (const i of S.ports) {
      let re = 0, im = 0;
      for (const j of S.ports) {
        const [wr, wi] = weightComplex(weights.get(physicalPortNumber(S, j)!)!), z = sAt(S, i, j, f)!;
        re += z[0] * wr - z[1] * wi; im += z[0] * wi + z[1] * wr;
      }
      reflectedW += .5 * (re * re + im * im);
    }
    acceptedW = incidentW - reflectedW;
    if (!Number.isFinite(acceptedW) || acceptedW <= 0) return no('power');
  }
  const u = combine(set, weights);
  if (u.some(r => r.some(v => !Number.isFinite(v)))) return no('power');
  const r = directivity(set.theta, set.phi, u, false), radius = admitted.radiusM;
  const factor = radius * radius / (2 * 376.730313668);
  const radiatedW = r.prad * factor, totalEfficiency = radiatedW / incidentW;
  // Same 5% numerical power-balance warning tolerance as runQuality and Python LOSSLESS_TOLERANCE.
  // Do not clamp the returned power/efficiency to 1 or call this a mesh-convergence result.
  if (!(radiatedW > 0) || !Number.isFinite(totalEfficiency) || totalEfficiency > 1 + EFFICIENCY_TOLERANCE
    || (acceptedW !== null && radiatedW > acceptedW * (1 + EFFICIENCY_TOLERANCE))) return no('power');
  let peak = 0; for (const row of u) for (const value of row) peak = Math.max(peak, value);
  const gainDbi = 10 * Math.log10(4 * Math.PI * peak * factor / incidentW);
  return Number.isFinite(gainDbi) ? { ok: true, value: { gainDbi, totalEfficiency, incidentW, radiatedW, acceptedW, directivityDbi: r.dmaxDbi } } : no('power');
}

/** Phase-only steering preserves the current amplitudes; no display quantization of phase. */
export function steeredWeights(b: Bundle, weights: Map<number, Weight>, f: number, theta: number, phi: number): Map<number, Weight> {
  const phases = steeringPhases(b, [...weights.keys()], f, Math.abs(theta), theta < 0 ? phi + 180 : phi);
  return new Map([...weights].map(([p, w]) => [p, { ampDb: w.ampDb, phaseDeg: phases.get(p)! }]));
}

export interface ScanRow { theta: number; phi: number; gainDbi: number | null; scanLossDb: number | null; totalEfficiency: number | null; powerReason: ArrayReason | null; activeDb: [number, number | null][] }
export interface ScanTable { frequencyHz: number; phi: number; weights: [number, Weight][]; baseline: 'same-amplitudes-zero-phase'; rows: ScanRow[] }
/** Bounded explicit sweep. Read and export one immutable feed/source-frequency snapshot. */
export function scanTable(b: Bundle, weights: Map<number, Weight>, f: number, phi: number, start: number, stop: number, step: number): Admission<ScanTable> {
  b = originalPortResult(b);
  if (![f, phi, start, stop, step].every(Number.isFinite) || start < -90 || stop > 90 || stop <= start || step <= 0 || f <= 0) return no('range');
  const count = Math.floor((stop - start) / step + 1e-9) + 1;
  const admitted = strictElementPatternsAt(b, f);
  if (!admitted.ok) return no(admitted.reason === 'basis' ? 'basis' : 'fields');
  const set = admitted.set;
  if (count > 37 || count < 2 || count * set.theta.length * set.phi.length * set.elements.length > 25_000_000) return no('budget');
  if (weights.size !== set.elements.length || [...weights].some(([p, w]) => !set.elements.some(e => e.port === p) || !Number.isFinite(w.phaseDeg) || !Number.isFinite(w.ampDb))) return no('weights');
  const saved = new Map([...weights].map(([p, w]) => [p, { ...w }]));
  const base = arrayPower(b, steeredWeights(b, saved, f, 0, phi), f), network = completeNetwork(b, weights, f);
  const S = network.ok ? network.value : null;
  const rows = Array.from({ length: count }, (_, i): ScanRow => {
    const theta = start + i * step, w = steeredWeights(b, saved, f, theta, phi), power = arrayPower(b, w, f);
    const gamma = S ? activeReflection(S, w, f) : new Map<number, [number, number] | null>();
    return { theta, phi: wrapScanPhi(phi), gainDbi: power.ok ? power.value.gainDbi : null,
      scanLossDb: power.ok && base.ok ? base.value.gainDbi - power.value.gainDbi : null,
      totalEfficiency: power.ok ? power.value.totalEfficiency : null, powerReason: power.ok ? null : power.reason,
      activeDb: [...saved.keys()].map(p => { const g = gamma.get(p); return [p, g ? gammaDb(g) : null]; }) };
  });
  return { ok: true, value: { frequencyHz: f, phi: wrapScanPhi(phi), weights: [...saved], baseline: 'same-amplitudes-zero-phase', rows } };
}

/** SLL is an estimate in the selected elevation plane, with existing cut analyzer ambiguity/floor rules. */
export function arraySidelobe(set: ElementPatternSet, weights: Map<number, Weight>, phi: number, half = false) {
  const grid = directivity(set.theta, set.phi, combine(set, weights), half).d;
  const cut = analyzeCut(set.theta, set.phi, grid, { kind: 'elevation', angle: phi }, half);
  return patternMetrics(cut, set.theta, set.phi, grid, half);
}
