// Array pattern synthesis from embedded element patterns: weighted sum, directivity by numerical
// integration over the sphere (or the upper half space above an infinite ground), main beam,
// half-power beamwidths, steering phases and active reflection. Pure TS (Node + browser).

import type { Bundle, FarField, Vec3 } from "../types";
import type { ElementPatternSet, SMatrix } from "./sparams.ts";
import { sAt } from "./sparams.ts";

export const C0 = 299_792_458;

export interface Weight {
  /** amplitude in dB (0 dB = unit) */
  ampDb: number;
  /** phase in degrees */
  phaseDeg: number;
}

export const weightComplex = (w: Weight): [number, number] => {
  const a = Math.pow(10, w.ampDb / 20);
  const p = (w.phaseDeg * Math.PI) / 180;
  return [a * Math.cos(p), a * Math.sin(p)];
};

/** Radiation intensity |E_θ|² + |E_φ|² of the weighted sum Σ w_i E_i, as [theta][phi]. */
export function combine(set: ElementPatternSet, weights: Map<number, Weight> | Weight[]): number[][] {
  const w = set.elements.map((e, i) => {
    const x = Array.isArray(weights) ? weights[i] : weights.get(e.port);
    return x ? weightComplex(x) : ([0, 0] as [number, number]);
  });
  const nt = set.theta.length;
  const np = set.phi.length;
  const U: number[][] = [];
  for (let i = 0; i < nt; i++) {
    const row = new Array<number>(np);
    for (let j = 0; j < np; j++) {
      let tr = 0, ti = 0, pr = 0, pi = 0;
      set.elements.forEach((e, k) => {
        const [wr, wi] = w[k];
        const a = e.eThetaRe[i][j], b = e.eThetaIm[i][j];
        const c = e.ePhiRe[i][j], d = e.ePhiIm[i][j];
        tr += wr * a - wi * b;
        ti += wr * b + wi * a;
        pr += wr * c - wi * d;
        pi += wr * d + wi * c;
      });
      row[j] = tr * tr + ti * ti + pr * pr + pi * pi;
    }
    U.push(row);
  }
  return U;
}

/**
 * Solid-angle weight of each grid sample: ∫ sin θ dθ over the θ cell (clipped to [0, θmax]) times
 * the φ cell width. The φ grid is periodic (0 … 355° without 360°), the θ grid spans 0 … 180°.
 */
export function solidAngleWeights(theta: number[], phi: number[], thetaMaxDeg = 180): { wt: number[]; wp: number[] } {
  const rad = Math.PI / 180;
  const tmax = thetaMaxDeg * rad;
  const wt = theta.map((t, i) => {
    const lo = Math.max(0, i ? ((theta[i - 1] + t) / 2) * rad : 0);
    const hi = Math.min(tmax, i < theta.length - 1 ? ((t + theta[i + 1]) / 2) * rad : Math.PI);
    return hi > lo ? Math.cos(lo) - Math.cos(hi) : 0;
  });
  const np = phi.length;
  const wp = phi.map((_, j) => {
    const prev = j ? phi[j - 1] : phi[np - 1] - 360;
    const next = j < np - 1 ? phi[j + 1] : phi[0] + 360;
    return ((next - prev) / 2) * rad;
  });
  return { wt, wp };
}

export interface DirectivityResult {
  /** directivity in dBi, [theta][phi] */
  d: number[][];
  dmaxDbi: number;
  /** ∮ U dΩ in the pattern's units */
  prad: number;
}

/** Directivity D = 4π U / ∮ U dΩ, integrated over θ ≤ 90° when `half` (infinite ground). */
export function directivity(theta: number[], phi: number[], U: number[][], half: boolean, floorDb = 60): DirectivityResult {
  const { wt, wp } = solidAngleWeights(theta, phi, half ? 90 : 180);
  let prad = 0;
  for (let i = 0; i < theta.length; i++) for (let j = 0; j < phi.length; j++) prad += U[i][j] * wt[i] * wp[j];
  let dmax = -Infinity;
  const lin = U.map((row) => row.map((u) => (prad > 0 ? (4 * Math.PI * u) / prad : 0)));
  for (let i = 0; i < theta.length; i++) {
    if (half && theta[i] > 90.0001) continue;
    for (const v of lin[i]) dmax = Math.max(dmax, v);
  }
  const dmaxDb = 10 * Math.log10(Math.max(dmax, 1e-30));
  const d = lin.map((row) => row.map((v) => Math.max(dmaxDb - floorDb, 10 * Math.log10(Math.max(v, 1e-30)))));
  return { d, dmaxDbi: dmaxDb, prad };
}

/** A FarField record (the viewer's pattern type) for a synthesized array pattern. */
export function arrayFarField(b: Bundle, set: ElementPatternSet, weights: Map<number, Weight>): FarField {
  const U = combine(set, weights);
  const r = directivity(set.theta, set.phi, U, !!b.half_space);
  return {
    f: set.f,
    theta: set.theta,
    phi: set.phi,
    directivity_dbi: r.d,
    dmax_dbi: r.dmaxDbi,
    rad_efficiency: null,
    prad_w: r.prad,
    pacc_w: 0,
    mirror_planes: 0,
  };
}

export interface Beam {
  theta: number;
  phi: number;
  dmaxDbi: number;
  /** half-power beamwidth in the elevation cut through the beam (φ = φ0 plane), degrees */
  hpbwTheta: number | null;
  /** half-power beamwidth across it (along φ at θ0, as a great-circle angle), degrees */
  hpbwPhi: number | null;
}

/** Linear interpolation of the −3 dB crossing between samples. */
function crossing(a0: number, v0: number, a1: number, v1: number, level: number) {
  return v0 === v1 ? a0 : a0 + ((level - v0) * (a1 - a0)) / (v1 - v0);
}

/** Index of the φ sample opposite phi0 (φ0 + 180°), or −1. */
const opposite = (phi: number[], phi0: number) => phi.findIndex((p) => Math.abs(((((p - phi0) % 360) + 360) % 360) - 180) < 1e-6);

/** Main-beam direction and half-power beamwidths of a directivity grid (dBi). */
export function mainBeam(theta: number[], phi: number[], d: number[][], half: boolean): Beam {
  let bi = 0, bj = 0;
  for (let i = 0; i < theta.length; i++) {
    if (half && theta[i] > 90.0001) continue;
    for (let j = 0; j < phi.length; j++) if (d[i][j] > d[bi][bj]) {
      bi = i;
      bj = j;
    }
  }
  const peak = d[bi][bj];
  // at a pole every φ sample is the same direction, so the argmax over φ is decided by numerical
  // noise (float32 or int16 quantisation). Take the cut plane from the neighbouring θ ring instead:
  // the φ where the beam falls off fastest, i.e. the narrowest cut (the array axis for a linear
  // array, the same plane the steered beams are measured in). φ0 and φ0 + 180° give the same cut.
  const nb = theta[bi] < 1e-6 ? bi + 1 : theta[bi] > 180 - 1e-6 ? bi - 1 : -1;
  if (nb >= 0 && nb < theta.length && !(half && theta[nb] > 90.0001)) {
    bj = 0;
    for (let j = 1; j < phi.length; j++) if (d[nb][j] < d[nb][bj] - 1e-9) bj = j;
    // a symmetric pattern ties φ0 and φ0 + 180° up to noise: report the plane as φ0 < 180°
    const opp = opposite(phi, phi[bj]);
    if (opp >= 0 && ((phi[bj] % 360) + 360) % 360 >= 180) bj = opp;
  }
  const level = peak - 3;
  // elevation cut through the beam: signed angle along the great circle φ0 / φ0 + 180
  const phi0 = phi[bj];
  const jOpp = opposite(phi, phi0);
  const cut: { a: number; v: number }[] = [];
  const tmax = half ? 90.0001 : 180.0001;
  if (jOpp >= 0) for (let i = theta.length - 1; i > 0; i--) if (theta[i] <= tmax) cut.push({ a: -theta[i], v: d[i][jOpp] });
  for (let i = 0; i < theta.length; i++) if (theta[i] <= tmax) cut.push({ a: theta[i], v: d[i][bj] });
  const k0 = cut.findIndex((c) => Math.abs(c.a - theta[bi]) < 1e-9);
  const width = (pts: { a: number; v: number }[], k: number): number | null => {
    let lo: number | null = null;
    let hi: number | null = null;
    for (let k1 = k; k1 > 0; k1--) if (pts[k1 - 1].v < level) {
      lo = crossing(pts[k1].a, pts[k1].v, pts[k1 - 1].a, pts[k1 - 1].v, level);
      break;
    }
    for (let k1 = k; k1 < pts.length - 1; k1++) if (pts[k1 + 1].v < level) {
      hi = crossing(pts[k1].a, pts[k1].v, pts[k1 + 1].a, pts[k1 + 1].v, level);
      break;
    }
    return lo === null || hi === null ? null : Math.abs(hi - lo);
  };
  const hpbwTheta = k0 >= 0 ? width(cut, k0) : null;
  // across: φ sweep at θ0 (periodic), converted to a great-circle angle
  let hpbwPhi: number | null = null;
  if (theta[bi] > 1e-6 && theta[bi] < 180 - 1e-6) {
    const np = phi.length;
    const ring = [...Array(3 * np).keys()].map((m) => ({ a: phi[m % np] + 360 * (Math.floor(m / np) - 1), v: d[bi][m % np] }));
    const w = width(ring, np + bj);
    hpbwPhi = w === null || w >= 360 ? null : 2 * Math.asin(Math.min(1, Math.sin((theta[bi] * Math.PI) / 180) * Math.sin((w * Math.PI) / 360))) * (180 / Math.PI);
  }
  return { theta: theta[bi], phi: phi[bj], dmaxDbi: peak, hpbwTheta, hpbwPhi };
}

/** Port centre in model units. */
export const portCentre = (b: Bundle, port: number): Vec3 | null => {
  const p = b.ports.find((q) => q.number === port);
  return p ? (p.start.map((x, i) => (x + p.stop[i]) / 2) as Vec3) : null;
};

/**
 * Progressive phases that steer the beam to (θ0, φ0): φ_i = −k (r_i − r_ref)·û(θ0, φ0), with the
 * port centres as element positions (bundle units, normally mm). Returned in degrees, wrapped to
 * (−180, 180].
 */
export function steeringPhases(b: Bundle, ports: number[], fHz: number, theta0Deg: number, phi0Deg: number): Map<number, number> {
  const unit = b.units?.length_m ?? 1e-3;
  const k = (2 * Math.PI * fHz) / C0;
  const t = (theta0Deg * Math.PI) / 180;
  const p = (phi0Deg * Math.PI) / 180;
  const u: Vec3 = [Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), Math.cos(t)];
  const ref = portCentre(b, ports[0]) ?? [0, 0, 0];
  const out = new Map<number, number>();
  for (const n of ports) {
    const r = portCentre(b, n) ?? ref;
    const dot = (r[0] - ref[0]) * u[0] + (r[1] - ref[1]) * u[1] + (r[2] - ref[2]) * u[2];
    let deg = (-k * dot * unit * 180) / Math.PI;
    deg = ((((deg + 180) % 360) + 360) % 360) - 180;
    out.set(n, Math.abs(deg + 180) < 1e-9 ? 180 : deg);
  }
  return out;
}

/** Active reflection Γ_i = Σ_j S_ij w_j / w_i at fHz; null for a port with zero weight. */
export function activeReflection(S: SMatrix, weights: Map<number, Weight>, fHz: number): Map<number, [number, number] | null> {
  const out = new Map<number, [number, number] | null>();
  for (const i of S.ports) {
    const wi = weights.get(i);
    if (!wi) {
      out.set(i, null);
      continue;
    }
    const [ar, ai] = weightComplex(wi);
    const den = ar * ar + ai * ai;
    if (den < 1e-24) {
      out.set(i, null);
      continue;
    }
    let sr = 0, si = 0;
    for (const j of S.ports) {
      const w = weights.get(j);
      const s = sAt(S, i, j, fHz);
      if (!w || !s) continue;
      const [wr, wim] = weightComplex(w);
      sr += s[0] * wr - s[1] * wim;
      si += s[0] * wim + s[1] * wr;
    }
    // (sr + j si) / (ar + j ai)
    out.set(i, [(sr * ar + si * ai) / den, (si * ar - sr * ai) / den]);
  }
  return out;
}

export const gammaDb = (g: [number, number]) => 10 * Math.log10(Math.max(1e-30, g[0] * g[0] + g[1] * g[1]));

export const uniformWeights = (ports: number[]) => new Map(ports.map((p) => [p, { ampDb: 0, phaseDeg: 0 }]));
