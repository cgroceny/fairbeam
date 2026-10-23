import type { Bundle, PortResult } from "../types";
import { isFalseOpenImpedance, physicalPortNumber, reflectionAtPort, sMatrix, zFromGamma } from "./sparams.ts";
import { hasComplexPortReference, portProcessingInfo } from "./portProcessingMetadata.ts";

export interface Sweep {
  f: number[];
  s11Db: number[];
  s11Re: number[];
  s11Im: number[];
  zRe: number[];
  zIm: number[];
  vswr: number[];
  zRef: number;
  zRefF?: number[];
}

export function sweep(b: Bundle): Sweep | null {
  const r = b.results;
  if (!r) return null;
  const excited = b.ports.find((p) => p.excite) ?? b.ports[0];
  const pr: PortResult | undefined = excited ? r.ports[String(excited.number)] : undefined;
  if (!pr) return null;
  const matrix = sMatrix(b);
  const processing = portProcessingInfo(b);
  const index = processing?.primaryIndex ?? matrix?.ports.find(p => physicalPortNumber(matrix, p) === excited.number);
  const canonical = matrix && !matrix.legacy && index !== undefined ? matrix.get(index, index) : null;
  // A matrix-backed bundle must not silently fall back to a different run reflection.
  if (matrix && !matrix.legacy && !canonical) return null;
  const reflection = canonical ?? { re: pr.s11_re, im: pr.s11_im };
  const zRef = canonical ? matrix!.zRef[matrix!.ports.indexOf(index!)] : pr.z_ref;
  const zRefF = pr.z_ref_f?.length === r.frequency.length ? pr.z_ref_f : undefined;
  const projected = processing && index !== undefined ? reflectionAtPort(b, index) : null;
  const impedance = projected ? { re: projected.zRe, im: projected.zIm } : canonical && matrix!.ports.length > 1
    ? zFromGamma(reflection, zRefF ?? zRef) : { re: pr.zin_re, im: pr.zin_im };
  // |S11| = 0 would give −∞: clamp at −300 dB like magDb; missing samples stay NaN (gaps)
  const s11Db = reflection.re.map((re, i) => 10 * Math.log10(Math.max(1e-30, re * re + reflection.im[i] * reflection.im[i])));
  const vswr = reflection.re.map((re, i) => {
    if (hasComplexPortReference(b)) return NaN; // Kurokawa power waves are not traveling-wave standing waves.
    const g = Math.hypot(re, reflection.im[i]);
    return g >= 1 ? Infinity : (1 + g) / (1 - g);
  });
  const oldOpen = reflection.re.map((re, i) => isFalseOpenImpedance(re, reflection.im[i], impedance.re?.[i], impedance.im?.[i]));
  const repairOpen = oldOpen.some(Boolean);
  return { f: r.frequency, s11Db, s11Re: reflection.re, s11Im: reflection.im,
    zRe: repairOpen ? impedance.re.map((z, i) => oldOpen[i] ? NaN : z) : impedance.re,
    zIm: repairOpen ? impedance.im.map((z, i) => oldOpen[i] ? NaN : z) : impedance.im, vswr, zRef,
    ...(zRefF ? { zRefF } : {}) };
}

export function nearestIndex(xs: number[], x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
}

/** A φ-cut through the 3D pattern as a signed angle series (-180..180, or -90..90 in half space). */
export function patternCut(theta: number[], phi: number[], d: number[][], phiDeg: number, halfSpace: boolean) {
  const jp = phi.findIndex((p) => Math.abs(p - phiDeg) < 1e-6);
  const jm = phi.findIndex((p) => Math.abs(p - ((phiDeg + 180) % 360)) < 1e-6);
  const angle: number[] = [];
  const value: number[] = [];
  const maxTheta = halfSpace ? 90 : 180;
  // negative side: phi + 180, theta descending
  for (let i = theta.length - 1; i > 0; i--) {
    if (theta[i] > maxTheta || jm < 0) continue;
    angle.push(-theta[i]);
    value.push(d[i][jm]);
  }
  for (let i = 0; i < theta.length; i++) {
    if (theta[i] > maxTheta || jp < 0) continue;
    angle.push(theta[i]);
    value.push(d[i][jp]);
  }
  return { angle, value };
}
