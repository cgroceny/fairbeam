import { patternCut, samplePhi } from './rf.ts';

export type PatternCutSpec = { kind: 'elevation' | 'conical'; angle: number };
export type PatternCutChoice = PatternCutSpec | { kind: 'principal' };
export interface PatternCutData {
  angle: number[]; value: number[]; theta: number[]; phi: number[];
  periodic: boolean; interpolated: boolean; spec: PatternCutSpec;
}
const EPS = 1e-9;
export const wrapPhi = (p: number) => ((p % 360) + 360) % 360;
const validTheta = (theta: number[]) => theta.length > 0 && theta.every((v, i) => Number.isFinite(v)
  && v >= 0 && v <= 180 && (i === 0 || v > theta[i - 1]));

/** Adjacent samples only, in the plotted quantity's units (dB); never extrapolate or bridge gaps. */
function sampleTheta(theta: number[], values: number[], target: number): number {
  if (!validTheta(theta) || !Number.isFinite(target) || target < theta[0] || target > theta.at(-1)!) return NaN;
  const exact = theta.findIndex(v => Math.abs(v - target) < EPS);
  if (exact >= 0) return Number.isFinite(values[exact]) ? values[exact] : NaN;
  const hi = theta.findIndex(v => v > target), lo = hi - 1;
  return Number.isFinite(values[lo]) && Number.isFinite(values[hi])
    ? values[lo] + (values[hi] - values[lo]) * (target - theta[lo]) / (theta[hi] - theta[lo]) : NaN;
}

export function samplePattern(theta: number[], phi: number[], grid: number[][], t: number, p: number): number {
  const column = samplePhi(phi, grid, p);
  return column ? sampleTheta(theta, column.values, t) : NaN;
}

/** A conical cut follows stored azimuths, with an explicit seam point at ±180°.
 * Theta and seam interpolation are estimates; no stored grid is changed. */
export function thetaCut(theta: number[], phi: number[], grid: number[][], thetaDeg: number, halfSpace = false): PatternCutData {
  const spec: PatternCutSpec = { kind: 'conical', angle: thetaDeg };
  const empty = { angle: [], value: [], theta: [], phi: [], periodic: false, interpolated: false, spec };
  if (!validTheta(theta) || !samplePhi(phi, grid, 0) || phi.length < 2 || !Number.isFinite(thetaDeg)
      || thetaDeg < theta[0] || thetaDeg > Math.min(theta.at(-1)!, halfSpace ? 90 : 180)) return empty;
  const angle = [...new Set([-180, ...phi.map(p => p >= 180 ? p - 360 : p), 180])].sort((a, b) => a - b);
  return { angle, value: angle.map(p => samplePattern(theta, phi, grid, thetaDeg, p)),
    theta: angle.map(() => thetaDeg), phi: angle.map(wrapPhi), periodic: true,
    interpolated: !theta.some(t => Math.abs(t - thetaDeg) < EPS) || !phi.some(p => Math.abs(p - 180) < EPS), spec };
}

export function analyzeCut(theta: number[], phi: number[], grid: number[][], spec: PatternCutSpec, halfSpace = false): PatternCutData {
  if (spec.kind === 'conical') return thetaCut(theta, phi, grid, spec.angle, halfSpace);
  if (!validTheta(theta) || !Number.isFinite(spec.angle)) return { angle: [], value: [], theta: [], phi: [], periodic: false, interpolated: false, spec };
  const cut = patternCut(theta, phi, grid, spec.angle, halfSpace);
  // A missing zenith must remain a gap between the two independent half-planes.
  if (theta[0] > 0 && cut.angle.some(a => a < 0) && cut.angle.some(a => a > 0)) {
    const k = cut.angle.findIndex(a => a > 0);
    cut.angle.splice(k, 0, 0);
    cut.value.splice(k, 0, NaN);
  }
  return { ...cut, theta: cut.angle.map(Math.abs), phi: cut.angle.map(a => wrapPhi(spec.angle + (a < 0 ? 180 : 0))),
    periodic: !halfSpace && theta[0] === 0 && theta.at(-1) === 180, spec };
}

export function cutSpecs(choice: PatternCutChoice, principalAvailable = true, fallbackPhi = 0): PatternCutSpec[] {
  return choice.kind === 'principal' ? (principalAvailable ? [0, 90] : [fallbackPhi]).map(angle => ({ kind: 'elevation', angle })) : [choice];
}
export function cutLabel(spec: PatternCutSpec): string {
  return `${spec.kind === 'elevation' ? 'φ' : 'θ'} = ${spec.kind === 'elevation' ? wrapPhi(spec.angle) : spec.angle}°`;
}
export type MetricReason = 'empty' | 'ambiguous' | 'gap' | 'coverage' | 'crossings' | 'sidelobe' | 'floor' | 'halfSpace' | 'antipode' | 'quantity';
/** Ratio/quality quantities (for example axial ratio) do not describe radiation maxima. */
export const supportsPatternMetrics = (quantity: string) => ['directivity', 'gain', 'realized', 'rhcp', 'lhcp'].includes(quantity);
export interface CutMetric { value: number | null; reason?: MetricReason }
export interface PatternMetrics {
  peak: { angle: number; theta: number; phi: number; dbi: number } | null;
  hpbw: CutMetric; sll: CutMetric; frontBack: CutMetric; spacing: [number, number] | null;
}
const unavailable = (reason: MetricReason): CutMetric => ({ value: null, reason });

/** Grid-limited estimates. A unique sampled maximum is required; equal competing maxima,
 * flat/isotropic patterns, unbounded main lobes and unresolved sidelobes have no invented number. */
export function patternMetrics(cut: PatternCutData, theta: number[], phi: number[], grid: number[][], halfSpace = false, quantity = 'directivity'): PatternMetrics {
  const n = cut.angle.length - (cut.periodic && cut.angle.length > 1 && Math.abs(cut.angle.at(-1)! - cut.angle[0] - 360) < EPS ? 1 : 0);
  const x = cut.angle.slice(0, n), y = cut.value.slice(0, n);
  const steps = x.slice(1).map((v, i) => v - x[i]).filter(v => v > 0);
  if (cut.periodic && n > 1) steps.push(x[0] + 360 - x.at(-1)!);
  const result: PatternMetrics = { peak: null, hpbw: unavailable('empty'), sll: unavailable('empty'), frontBack: unavailable('empty'),
    spacing: steps.length ? [Math.min(...steps), Math.max(...steps)] : null };
  if (!supportsPatternMetrics(quantity)) return { ...result, hpbw: unavailable('quantity'), sll: unavailable('quantity'), frontBack: unavailable('quantity') };
  const finite = y.filter(Number.isFinite);
  if (!finite.length) return result;
  const top = Math.max(...finite), peaks = y.map((v, i) => Math.abs(v - top) < EPS ? i : -1).filter(i => i >= 0);
  if (peaks.length !== 1 || n < 3 || Math.max(...finite) - Math.min(...finite) < EPS) {
    return { ...result, hpbw: unavailable('ambiguous'), sll: unavailable('ambiguous'), frontBack: unavailable('ambiguous') };
  }
  const peak = peaks[0];
  result.peak = { angle: x[peak], theta: cut.theta[peak], phi: cut.phi[peak], dbi: top };
  const index = (i: number) => (i + n) % n;
  const at = (offset: number) => {
    const i = peak + offset;
    if (!cut.periodic && (i < 0 || i >= n)) return null;
    const j = index(i);
    return { value: y[j], angle: x[j] + 360 * Math.floor(i / n), index: j };
  };
  const crossing = (dir: number): CutMetric => {
    let prev = at(0)!;
    for (let s = 1; s < n; s++) {
      const cur = at(s * dir);
      if (!cur) return unavailable('crossings');
      if (!Number.isFinite(cur.value)) return unavailable('gap');
      if (cur.value <= top - 3) return { value: prev.angle + (top - 3 - prev.value) * (cur.angle - prev.angle) / (cur.value - prev.value) };
      prev = cur;
    }
    return unavailable('crossings');
  };
  const left = crossing(-1), right = crossing(1);
  result.hpbw = left.value !== null && right.value !== null && right.value - left.value <= 360
    ? { value: right.value - left.value } : unavailable(left.reason ?? right.reason ?? 'crossings');
  // SLL is only defensible with complete coverage. Bound the main lobe by the first
  // sampled local minima in each direction, then seek finite local maxima outside it.
  if (!cut.periodic) result.sll = unavailable('coverage');
  else if (finite.length !== n) result.sll = unavailable('gap');
  else {
    const minimum = (dir: number) => {
      for (let s = 1; s < n; s++) {
        const before = at((s - 1) * dir)!, cur = at(s * dir)!, after = at((s + 1) * dir)!;
        if (cur.value <= before.value && cur.value < after.value) return s;
      }
      return null;
    };
    const l = minimum(-1), r = minimum(1);
    const lobes: number[] = [];
    if (l !== null && r !== null && l + r < n) {
      for (let s = r + 1; s < n - l; s++) {
        const prev = at(s - 1)!, cur = at(s)!, next = at(s + 1)!;
        if (cur.value >= prev.value && cur.value > next.value) lobes.push(cur.value);
      }
    }
    result.sll = lobes.length ? (Math.max(...lobes) >= top - 40 ? { value: Math.max(...lobes) - top } : unavailable('floor')) : unavailable('sidelobe');
  }
  if (halfSpace) result.frontBack = unavailable('halfSpace');
  else {
    const back = samplePattern(theta, phi, grid, 180 - result.peak.theta, result.peak.phi + 180);
    result.frontBack = Number.isFinite(back) ? { value: top - back } : unavailable('antipode');
  }
  return result;
}
