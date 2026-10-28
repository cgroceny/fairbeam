// Ludwig's third definition, fixed linear reference alpha measured +x toward +y:
// co = Etheta cos(phi-alpha) - Ephi sin(phi-alpha)
// cross = Etheta sin(phi-alpha) + Ephi cos(phi-alpha).
// A. C. Ludwig, IEEE TAP 21(1), 116-119 (1973), doi:10.1109/TAP.1973.1140406.
// Pure, no native/DOM/Solid dependencies. Rotate COMPLEX fields before taking power.
import type { FarField } from "../types";

export const COMPLEX_FIELD_CELLS_MAX = 65536;
export const COMPLEX_FIELD_FREQS_MAX = 16;
export const COMPLEX_FIELD_TOTAL_CELLS_MAX = 262144; // per driven port
export const XPD_MAX_DB = 60; // display saturation bound, not measurement precision
export const XPD_MASK_DB = 20;
export const LUDWIG_FLOOR_DB = 60;
/** Export the convention beside every derived value; the reference is never beam-fitted. */
export const LUDWIG_EXPORT_HEADERS = ["Ludwig reference (deg)", "Ludwig convention", "Ludwig normalization", "Ludwig masks and bounds"];
export function ludwigExportMetadata(referenceDeg = 0): (string | number)[] {
  return [normalizeLudwigReference(referenceDeg),
    "Ludwig-3; fixed global xy reference +x toward +y; complex rotation before power",
    "Stored physical-space Dmax and native power_peak; mirror correction applied once; int16 relative phase",
    "Co/cross floor Dmax-60 dB; XPD total-power mask peak-20 dB and saturation +/-60 dB; zero fields and theta=180 missing"];
}
export function ludwigExportNote(referenceDeg = 0): string {
  const [angle, convention, normalization, limits] = ludwigExportMetadata(referenceDeg);
  return `Reference alpha=${angle} deg. ${convention}. ${normalization}. ${limits}. Co/cross: dBi; XPD: dB. Floors and saturation are bounds, not measured finite null power.`;
}
const keys = ["e_theta_re", "e_theta_im", "e_phi_re", "e_phi_im"] as const;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const portId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const axis = (v: unknown, end: number, inclusive: boolean): v is number[] => Array.isArray(v) && v.length > 0
  && v.every((x, i) => finite(x) && x >= 0 && (inclusive ? x <= end : x < end) && (!i || x > v[i - 1]));

export interface ComplexFarField {
  /** Native E components divided by the common scale, flat row-major; avoids power overflow.
   * The physical components can be reconstructed by multiplying by scale. */
  eThetaRe: Float64Array; eThetaIm: Float64Array; ePhiRe: Float64Array; ePhiIm: Float64Array;
  scale: number; powerPeak: number; rows: number; cols: number;
}

/** Resolve a recorded field to an original physical driven port. Explicit malformed IDs never
 * become omitted IDs, and S-parameter matrix indices must be mapped through port_numbers. */
export function complexFieldPort(b: unknown, ff: unknown): number | null {
  if (!obj(b) || !obj(ff) || !Array.isArray(b.ports) || !b.ports.length || !obj(b.results) || !obj(b.results.ports)) return null;
  const ports = b.ports;
  if (!ports.every(p => obj(p) && portId(p.number))) return null;
  const ids = ports.map(p => p.number as number);
  if (new Set(ids).size !== ids.length) return null;
  const sp = b.results.sparams;
  let driven: number[];
  if (sp !== undefined) {
    if (!obj(sp) || !Array.isArray(sp.ports) || sp.ports.length !== ids.length
        || !sp.ports.every((v, i) => v === i + 1) || !Array.isArray(sp.excited) || !sp.excited.length
        || !sp.excited.every(v => portId(v) && v <= ids.length) || new Set(sp.excited).size !== sp.excited.length
        || typeof sp.complete !== "boolean" || sp.complete !== (sp.excited.length === ids.length)) return null;
    const order = sp.port_numbers === undefined ? sp.ports : sp.port_numbers;
    if (!Array.isArray(order) || order.length !== ids.length || !order.every(v => portId(v) && ids.includes(v))
        || new Set(order).size !== ids.length) return null;
    driven = sp.excited.map(v => order[v - 1]);
  } else {
    if (!ports.every(p => typeof p.excite === "boolean")) return null;
    driven = ports.filter(p => p.excite === true).map(p => p.number as number);
    if (driven.length !== 1) return null; // simultaneous excitation is not one identifiable driven-port field
  }
  const id = ff.port === undefined ? (driven.length === 1 ? driven[0] : null) : ff.port;
  return portId(id) && driven.includes(id) && obj(b.results.ports[String(id)]) ? id : null;
}

/** Strictly admit this single field's own axes, exact frequency and declared convention.
 * Do not borrow an embedded field from the nearest frequency or a different driven port. */
export function readComplexFarField(ff: unknown): ComplexFarField | null {
  if (!obj(ff) || !axis(ff.theta, 180, true) || !axis(ff.phi, 360, false) || !finite(ff.f) || ff.f <= 0
      || !finite(ff.dmax_dbi) || !Number.isInteger(ff.mirror_planes) || (ff.mirror_planes as number) < 0
      || (ff.mirror_planes as number) > 3) return null;
  const e = ff.fields, rows = ff.theta.length, cols = ff.phi.length, count = rows * cols;
  if (count > COMPLEX_FIELD_CELLS_MAX || !obj(e) || e.schema !== "fairbeam.farfield-fields/1"
      || e.encoding !== "i16le-base64-scaled" || e.basis !== "theta-phi" || e.normalization !== "native-E-theta-phi"
      || e.f !== ff.f || e.mirror_planes !== ff.mirror_planes || !finite(e.radius_m) || e.radius_m <= 0
      || !finite(e.scale) || e.scale < 0 || !finite(e.power_peak)
      || (e.scale === 0 ? e.power_peak !== 0 : e.power_peak < 1 || e.power_peak > 4)
      || !Array.isArray(e.shape) || e.shape.length !== 2
      || e.shape[0] !== rows || e.shape[1] !== cols || !Array.isArray(e.phase_center_m)
      || e.phase_center_m.length !== 3 || !e.phase_center_m.every(finite)) return null;
  const arrays: Float64Array[] = [];
  let maxQ = 0;
  for (const key of keys) {
    const text = e[key];
    // Bound and validate before decoding: no whitespace, truncation, surplus bytes or noncanonical padding.
    if (typeof text !== "string" || text.length !== 4 * Math.ceil(count * 2 / 3)
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return null;
    let bytes: string;
    try { bytes = atob(text); if (btoa(bytes) !== text) return null; } catch { return null; }
    if (bytes.length !== count * 2) return null;
    const a = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      let q = bytes.charCodeAt(2 * k) | bytes.charCodeAt(2 * k + 1) << 8;
      if (q >= 32768) q -= 65536;
      if (q === -32768 || (e.scale === 0 && q !== 0)) return null;
      maxQ = Math.max(maxQ, Math.abs(q)); a[k] = q / 32767;
    }
    arrays.push(a);
  }
  if (e.scale > 0 && maxQ !== 32767) return null; // scale is the maximum of the four native arrays
  let decodedPeak = 0;
  for (let k = 0; k < count; k++) decodedPeak = Math.max(decodedPeak, arrays.reduce((sum, a) => sum + a[k] ** 2, 0));
  // Four real components, each rounded by at most 0.5/32767. Reject a lost peak,
  // rather than rescale a cropped subset using the containing whole-pattern Dmax.
  const powerError = 4 / 32767 + 1 / 32767 ** 2;
  if (Math.abs(decodedPeak - e.power_peak) > powerError + 1e-12) return null;
  return { eThetaRe: arrays[0], eThetaIm: arrays[1], ePhiRe: arrays[2], ePhiIm: arrays[3],
    scale: e.scale, powerPeak: e.power_peak, rows, cols };
}

/** Alpha and alpha+180 give the same component powers. Invalid input is never replaced by zero. */
export const normalizeLudwigReference = (alpha: number) => finite(alpha) ? ((alpha % 180) + 180) % 180 : NaN;
export const isLudwigQuantity = (q: string): q is "co" | "cross" | "xpd" => q === "co" || q === "cross" || q === "xpd";

export interface LudwigGrids { co: number[][]; cross: number[][]; xpd: number[][]; referenceDeg: number }
export function ludwigGrids(ff: FarField, referenceDeg = 0): LudwigGrids {
  const empty = () => ff.theta.map(() => ff.phi.map(() => NaN));
  const co = empty(), cross = empty(), xpd = empty();
  const alpha = normalizeLudwigReference(referenceDeg), fields = readComplexFarField(ff);
  if (!fields || !finite(alpha) || fields.scale === 0) return { co, cross, xpd, referenceDeg: alpha };
  const { eThetaRe: tr, eThetaIm: ti, ePhiRe: pr, ePhiIm: pi, rows, cols } = fields;
  const peak = fields.powerPeak;
  const floor = ff.dmax_dbi - LUDWIG_FLOOR_DB;
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    // Ludwig-3 is continuous around +z, but its fixed transverse reference is singular at -z.
    // Keep the exact south pole as a gap rather than a phi-dependent physical readout.
    if (Math.abs(ff.theta[i] - 180) < 1e-9) continue;
    const k = i * cols + j, angle = (ff.phi[j] - alpha) * Math.PI / 180;
    const c = Math.cos(angle), s = Math.sin(angle);
    const pc = (tr[k] * c - pr[k] * s) ** 2 + (ti[k] * c - pi[k] * s) ** 2;
    const px = (tr[k] * s + pr[k] * c) ** 2 + (ti[k] * s + pi[k] * c) ** 2;
    const total = pc + px;
    if (!(total > 0)) continue; // a zero field carries neither polarization nor XPD
    // Dmax already includes the physical-space mirror factor; never apply it to fields again.
    co[i][j] = pc > 0 ? Math.max(floor, ff.dmax_dbi + 10 * Math.log10(pc / peak)) : floor;
    cross[i][j] = px > 0 ? Math.max(floor, ff.dmax_dbi + 10 * Math.log10(px / peak)) : floor;
    if (10 * Math.log10(total / peak) >= -XPD_MASK_DB - 1e-10) {
      xpd[i][j] = pc === 0 ? -XPD_MAX_DB : px === 0 ? XPD_MAX_DB
        : Math.max(-XPD_MAX_DB, Math.min(XPD_MAX_DB, 10 * Math.log10(pc / px)));
    }
  }
  return { co, cross, xpd, referenceDeg: alpha };
}

export interface LudwigPoint { theta: number; phi: number; co: number; cross: number; xpd: number | null }
/** Samples at the stored total-directivity peak and +z; no automatic antenna-dependent reference rotation. */
export function ludwigReadouts(ff: FarField, referenceDeg = 0, halfSpace = false): { peak: LudwigPoint | null; boresight: LudwigPoint | null } {
  const g = ludwigGrids(ff, referenceDeg);
  let best = -Infinity, bi = -1, bj = -1;
  for (let i = 0; i < ff.theta.length; i++) for (let j = 0; j < ff.phi.length; j++) {
    if (halfSpace && ff.theta[i] > 90) continue;
    const d = ff.directivity_dbi[i]?.[j];
    if (finite(d) && d > best) { best = d; bi = i; bj = j; }
  }
  const point = (i: number, j: number): LudwigPoint | null => finite(g.co[i]?.[j]) && finite(g.cross[i]?.[j])
    ? { theta: ff.theta[i], phi: ff.phi[j], co: g.co[i][j], cross: g.cross[i][j], xpd: finite(g.xpd[i][j]) ? g.xpd[i][j] : null } : null;
  return { peak: point(bi, bj), boresight: point(ff.theta.findIndex(v => Math.abs(v) < 1e-9), 0) };
}
