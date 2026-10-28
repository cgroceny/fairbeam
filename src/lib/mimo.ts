/** MIMO postprocessing of stored physical-port power waves and matched complex fields.
 * R = I - SᴴS is an accepted-power Gram matrix, not a measured radio channel.
 * Its radiation/receive interpretation assumes negligible dissipative loss, reciprocity,
 * isotropic unpolarized multipath and matched unexcited ports. See docs/RESULTS.md.
 * No interpolation, solver launch, efficiency correction or accuracy qualification. */
import type { Bundle } from "../types.ts";
import { hasSParameterPhase, physicalPortNumber, sMatrix, type ElementPatternSet, type SMatrix } from "./sparams.ts";
import { portProcessingInfo } from "./portProcessingMetadata.ts";
import { solidAngleWeights } from "./array.ts";
import { strictElementPatternsAt } from "./patternAdmission.ts";

export type MimoComplex = readonly [number, number];
export type MimoWeights = ReadonlyMap<number, MimoComplex>;
export interface MimoValue { value: number | null; reason: string | null }
export interface MimoPair {
  ports: [number, number]; eccS: MimoValue; eccField: MimoValue;
  dgS: MimoValue; dgField: MimoValue; warnings: string[];
}
export interface MimoRow {
  frequency: number; pairs: MimoPair[]; tarc: MimoValue; ccl: MimoValue;
  meg: { port: number; estimate: MimoValue }[]; warnings: string[];
}
export interface MimoAnalysis {
  ports: number[]; rows: MimoRow[]; reason: string | null;
  /** Complete finite supplied power-wave excitation, keyed by physical port.
   * Missing or malformed input has no exportable excitation snapshot. */
  weights: { port: number; re: number; im: number }[];
}
const unavailable = (reason: string): MimoValue => ({ value: null, reason });
const value = (v: number): MimoValue => Number.isFinite(v) ? { value: v, reason: null } : unavailable("mimo.reason.nonfinite");
const conjProduct = (a: MimoComplex, b: MimoComplex): [number, number] => [a[0] * b[0] + a[1] * b[1], a[0] * b[1] - a[1] * b[0]];
const abs2 = (a: MimoComplex) => a[0] * a[0] + a[1] * a[1];
/** Floating-point algebra allowance only, not a physical passivity/accuracy target. */
const ROUND_OFF = 1e-10;
export const ECC_DISAGREEMENT = 0.05;

function admittedMatrix(b: Bundle): { m: SMatrix; ports: number[]; reason: null } | { m: null; ports: number[]; reason: string } {
  const m = sMatrix(b), fail = (reason: string) => ({ m: null, ports: [] as number[], reason });
  if (!m || m.ports.length < 2 || m.ports.length > 64 || m.legacy) return fail("mimo.reason.matrix");
  if (!hasSParameterPhase(b)) return fail("mimo.reason.phase");
  // A projected S matrix must not be combined with the original field-wave basis.
  if (portProcessingInfo(b)) return fail("mimo.reason.processed");
  const raw = b.results?.sparams;
  // The display adapter may infer ports/excitations and default a missing reference
  // to 50 ohms. Quantitative power identities require explicitly stored metadata.
  if (!raw || !Array.isArray(raw.ports) || raw.ports.length !== m.ports.length ||
      !raw.ports.every((p, k) => p === m.ports[k])) return fail("mimo.reason.mapping");
  const ports = m.ports.map(p => physicalPortNumber(m, p));
  if (m.modalChannels || new Set(m.ports).size !== m.ports.length || !m.ports.every(p => Number.isInteger(p) && p > 0) ||
      !ports.every((p): p is number => p !== null && Number.isInteger(p) && p > 0) || new Set(ports).size !== ports.length ||
      !Array.isArray(b.ports) || b.ports.length !== ports.length || new Set(b.ports.map(p => p.number)).size !== ports.length ||
      !ports.every(p => b.ports.some(modelPort => modelPort.number === p)))
    return fail("mimo.reason.mapping");
  if (raw.complete !== true || !Array.isArray(raw.excited) || raw.excited.length !== m.ports.length || m.excited.length !== m.ports.length ||
      new Set(m.excited).size !== m.ports.length || !m.ports.every(p => m.excited.includes(p)) ||
      m.ports.some(i => m.ports.some(j => !m.get(i, j)))) return fail("mimo.reason.complete");
  if (!Array.isArray(raw.z_ref) || raw.z_ref.length !== m.ports.length || !raw.z_ref.every(z => Number.isFinite(z) && z > 0) ||
      m.zRef.length !== m.ports.length || !m.zRef.every(z => Number.isFinite(z) && z > 0) ||
      m.zRefImag && (m.zRefImag.length !== m.ports.length || m.zRefImag.some(z => !Number.isFinite(z) || z !== 0))) return fail("mimo.reason.references");
  if (!m.f.length || !m.f.every((f, k) => Number.isFinite(f) && f > 0 && (k === 0 || f > m.f[k - 1])))
    return fail("mimo.reason.frequency");
  return { m, ports, reason: null };
}

/** Cholesky of a Hermitian PSD Gram matrix. Singular PSD is allowed for reflection,
 * but its log determinant is unavailable. Zero pivots require a zero remaining column. */
function gramFactor(r: MimoComplex[][]): { passive: boolean; logDet: number | null } {
  const n = r.length, l: [number, number][][] = Array.from({ length: n }, () => Array.from({ length: n }, () => [0, 0]));
  let logDet = 0, singular = false;
  for (let j = 0; j < n; j++) {
    let d = r[j][j][0];
    for (let k = 0; k < j; k++) d -= abs2(l[j][k]);
    if (!Number.isFinite(d) || d < -ROUND_OFF) return { passive: false, logDet: null };
    if (d <= ROUND_OFF) singular = true;
    else { l[j][j] = [Math.sqrt(d), 0]; logDet += Math.log2(d); }
    for (let i = j + 1; i < n; i++) {
      let re = r[i][j][0], im = r[i][j][1];
      for (let k = 0; k < j; k++) {
        const p = conjProduct(l[j][k], l[i][k]); re -= p[0]; im -= p[1];
      }
      if (d <= ROUND_OFF) {
        if (Math.hypot(re, im) > ROUND_OFF) return { passive: false, logDet: null };
      } else l[i][j] = [re / l[j][j][0], im / l[j][j][0]];
    }
  }
  return { passive: true, logDet: singular ? null : logDet };
}

export function networkDiversity(s: MimoComplex[][], weights: MimoComplex[] | null) {
  const n = s.length;
  const fail = (reason: string) => ({ reason, gram: null, tarc: unavailable(reason), ccl: unavailable(reason), meg: [] as MimoValue[] });
  if (n < 2 || n > 64 || s.some(row => row.length !== n || row.some(z => z.length !== 2 || !z.every(Number.isFinite))))
    return fail("mimo.reason.nonfinite");
  if (s.some(row => row.some(z => abs2(z) > 1 + ROUND_OFF))) return fail("mimo.reason.passivity");
  const gram: [number, number][][] = s.map((_, i) => s.map((__, j) => {
    let re = Number(i === j), im = 0;
    for (let k = 0; k < n; k++) { const p = conjProduct(s[k][i], s[k][j]); re -= p[0]; im -= p[1]; }
    return [re, im];
  }));
  const factor = gramFactor(gram);
  if (!factor.passive) return fail("mimo.reason.passivity");
  let tarc = unavailable("mimo.reason.weights");
  if (weights?.length === n && weights.every(w => w.length === 2 && w.every(Number.isFinite))) {
    const scale = Math.max(...weights.flatMap(w => [Math.abs(w[0]), Math.abs(w[1])]));
    if (scale > 0 && Number.isFinite(scale)) {
      const a = weights.map(w => [w[0] / scale, w[1] / scale] as const), pin = a.reduce((sum, w) => sum + abs2(w), 0);
      const pout = s.reduce((sum, row) => {
        let re = 0, im = 0;
        row.forEach((z, j) => { re += z[0] * a[j][0] - z[1] * a[j][1]; im += z[0] * a[j][1] + z[1] * a[j][0]; });
        return sum + re * re + im * im;
      }, 0);
      tarc = value(Math.sqrt(Math.min(1, Math.max(0, pout / pin))));
    }
  }
  return { reason: null, gram, tarc, ccl: factor.logDet === null ? unavailable("mimo.reason.singular") : value(Math.max(0, -factor.logDet)),
    meg: gram.map((row, i) => value(Math.max(0, row[i][0]) / 2)) };
}

function gramCorrelation(gram: MimoComplex[][], i: number, j: number): MimoValue {
  const den = gram[i][i][0] * gram[j][j][0];
  if (!(den > ROUND_OFF * ROUND_OFF)) return unavailable("mimo.reason.denominator");
  const ecc = abs2(gram[i][j]) / den;
  return ecc > 1 + ROUND_OFF || !Number.isFinite(ecc) ? unavailable("mimo.reason.denominator") : value(Math.max(0, Math.min(1, ecc)));
}

/** Full-sphere complex-vector inner product using angular cell solid angles. Values
 * are scaled per element before accumulation, preserving ECC under phase/amplitude. */
export function fieldCorrelation(set: ElementPatternSet, a: number, b: number): MimoValue {
  const x = set.elements.find(e => e.port === a), y = set.elements.find(e => e.port === b);
  if (a === b || !x || !y || new Set(set.elements.map(e => e.port)).size !== set.elements.length) return unavailable("mimo.reason.pair");
  const { theta, phi } = set, ordered = (v: number[]) => v.every((q, i) => Number.isFinite(q) && (i === 0 || q > v[i - 1]));
  if (theta.length < 2 || phi.length < 2 || !ordered(theta) || !ordered(phi) || theta[0] !== 0 || theta.at(-1) !== 180 || phi[0] < 0 || phi.at(-1)! >= 360)
    return unavailable("mimo.reason.fieldGrid");
  const fields = [x, y].map(e => [e.eThetaRe, e.eThetaIm, e.ePhiRe, e.ePhiIm]);
  if (fields.some(grids => grids.some(g => g.length !== theta.length || g.some(row => row.length !== phi.length || !row.every(Number.isFinite)))))
    return unavailable("mimo.reason.nonfinite");
  const scales = fields.map(grids => grids.reduce((m, g) => g.reduce((v, row) => row.reduce((p, z) => Math.max(p, Math.abs(z)), v), m), 0));
  if (scales.some(s => !(s > 0))) return unavailable("mimo.reason.zeroField");
  const { wt, wp } = solidAngleWeights(theta, phi);
  let re = 0, im = 0, xx = 0, yy = 0;
  for (let i = 0; i < theta.length; i++) for (let j = 0; j < phi.length; j++) {
    const w = wt[i] * wp[j];
    for (const offset of [0, 2]) {
      const u: MimoComplex = [fields[0][offset][i][j] / scales[0], fields[0][offset + 1][i][j] / scales[0]];
      const v: MimoComplex = [fields[1][offset][i][j] / scales[1], fields[1][offset + 1][i][j] / scales[1]];
      const p = conjProduct(u, v); re += w * p[0]; im += w * p[1]; xx += w * abs2(u); yy += w * abs2(v);
    }
  }
  const ecc = (re * re + im * im) / (xx * yy);
  return !Number.isFinite(ecc) || ecc > 1 + ROUND_OFF ? unavailable("mimo.reason.zeroField") : value(Math.max(0, Math.min(1, ecc)));
}

/** Conventional 10 sqrt(1-ECC²) proxy in dB; not measured outage diversity gain. */
export function diversityGain(ecc: MimoValue): MimoValue {
  if (ecc.value === null) return { ...ecc };
  return Number.isFinite(ecc.value) && ecc.value >= 0 && ecc.value <= 1
    ? value(10 * Math.sqrt(1 - ecc.value ** 2)) : unavailable("mimo.reason.denominator");
}

function efficiencyAt(b: Bundle, port: number, f: number): number | null {
  const ff = (b.results?.farfield ?? []).filter(p => p.port === port && p.f === f);
  if (ff.length === 1) {
    const p = ff[0], eta = p.rad_efficiency_raw ?? p.rad_efficiency;
    return typeof eta === "number" && Number.isFinite(eta) && eta >= 0 ? eta : null;
  }
  const sweeps = (b.results?.efficiency ?? []).filter(p => p.port === port && p.f.filter(v => v === f).length === 1);
  if (sweeps.length !== 1) return null;
  const e = sweeps[0], k = e.f.indexOf(f), eta = e.rad_efficiency_raw?.[k] ?? e.rad_efficiency[k];
  return e.reliable?.[k] !== false && typeof eta === "number" && Number.isFinite(eta) && eta >= 0 ? eta : null;
}

export function mimoAnalysis(b: Bundle, weights?: MimoWeights): MimoAnalysis {
  const admission = admittedMatrix(b), { ports } = admission;
  const completeWeights = weights && weights.size === ports.length && ports.every(port => {
    const w = weights.get(port);
    return w?.length === 2 && w.every(Number.isFinite);
  });
  const savedWeights = completeWeights ? ports.map(port => ({ port, re: weights!.get(port)![0], im: weights!.get(port)![1] })) : [];
  if (!admission.m) return { ports, rows: [], reason: admission.reason, weights: savedWeights };
  const m = admission.m, ep = b.results?.element_patterns;
  const patternFrequencies = ep && !Array.isArray(ep) ? ep.frequencies : [];
  const frequencies = [...new Set([...m.f, ...(Array.isArray(patternFrequencies) ? patternFrequencies.filter(f => Number.isFinite(f) && f > 0) : [])])].sort((a, b) => a - b);
  const w = completeWeights ? ports.map(p => weights!.get(p)!) : null;
  const rows = frequencies.map(frequency => {
    const k = m.f.indexOf(frequency), s = k < 0 ? null : m.ports.map(i => m.ports.map(j => { const c = m.get(i, j)!; return [c.re[k], c.im[k]] as const; }));
    const network = s ? networkDiversity(s, w) : null;
    const field = strictElementPatternsAt(b, frequency);
    const eta = ports.map(port => efficiencyAt(b, port, frequency));
    const warnings: string[] = [];
    if (eta.some(e => e === null)) warnings.push("mimo.warning.efficiencyUnknown");
    if (eta.some(e => e !== null && e < .9)) warnings.push("mimo.warning.lossy");
    if (eta.some(e => e !== null && e > 1 + ROUND_OFF)) warnings.push("mimo.warning.efficiencyInvalid");
    const pairs: MimoPair[] = [];
    for (let i = 0; i < ports.length; i++) for (let j = i + 1; j < ports.length; j++) {
      const eccS = network?.gram ? gramCorrelation(network.gram, i, j) : unavailable(network?.reason ?? "mimo.reason.exactS");
      const eccField = field.ok && field.mirrorPlanes === 0 && !b.half_space && field.set.elements.length === ports.length && ports.every(p => field.set.elements.some(e => e.port === p))
        ? fieldCorrelation(field.set, ports[i], ports[j]) : unavailable("mimo.reason.pattern");
      const pairWarnings = [...warnings];
      if (eccS.value !== null && eccField.value !== null && Math.abs(eccS.value - eccField.value) > ECC_DISAGREEMENT)
        pairWarnings.push("mimo.warning.disagreement");
      pairs.push({ ports: [ports[i], ports[j]], eccS, eccField, dgS: diversityGain(eccS), dgField: diversityGain(eccField), warnings: pairWarnings });
    }
    return { frequency, pairs, warnings, tarc: network?.tarc ?? unavailable("mimo.reason.exactS"), ccl: network?.ccl ?? unavailable("mimo.reason.exactS"),
      meg: ports.map((port, i) => ({ port, estimate: network?.meg[i] ?? unavailable(network?.reason ?? "mimo.reason.exactS") })) };
  });
  return { ports, rows, reason: null, weights: savedWeights };
}
