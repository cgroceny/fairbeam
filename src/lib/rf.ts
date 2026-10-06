import type { Bundle, PortResult } from "../types";

export interface Sweep {
  f: number[];
  s11Db: number[];
  s11Re: number[];
  s11Im: number[];
  zRe: number[];
  zIm: number[];
  vswr: number[];
  zRef: number;
}

export function sweep(b: Bundle): Sweep | null {
  const r = b.results;
  if (!r) return null;
  const excited = b.ports.find((p) => p.excite) ?? b.ports[0];
  const pr: PortResult | undefined = excited ? r.ports[String(excited.number)] : undefined;
  if (!pr) return null;
  // |S11| = 0 would give −∞: clamp at −300 dB like magDb; missing samples stay NaN (gaps)
  const s11Db = pr.s11_re.map((re, i) => 10 * Math.log10(Math.max(1e-30, re * re + pr.s11_im[i] * pr.s11_im[i])));
  const vswr = pr.s11_re.map((re, i) => {
    const g = Math.hypot(re, pr.s11_im[i]);
    return g >= 1 ? Infinity : (1 + g) / (1 - g);
  });
  return { f: r.frequency, s11Db, s11Re: pr.s11_re, s11Im: pr.s11_im, zRe: pr.zin_re, zIm: pr.zin_im, vswr, zRef: pr.z_ref };
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
