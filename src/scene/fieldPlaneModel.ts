// What a field-plane map (bundle `field_planes`, python/fairbeam/field_planes.py) shows, as pure
// functions without three.js, Solid or the DOM, so the 2D tab (designer/FieldMapView.tsx), the 3D
// layer (scene/fieldPlanes.ts) and scripts/check-field-planes.mjs share one set of numbers:
//   - the colour values (dB below the maximum, linear, signed, phase) and their RGBA image,
//   - the optional phasor (complex components, int8) and the field over one period,
//   - the hover readout, the structure's outline projected onto the plane, and the raw-data columns.
import type { FieldPlaneMap, FieldPlanePhasor, Part } from "../types";
import { viewShapes } from "../drawing/geometry.ts";

export type FieldPlaneScale = "db" | "linear";
/** the dB scale spans this many dB below the map's maximum (lower values sit at the bottom of the ramp) */
export const FIELD_PLANE_DB_RANGE = 40;

/** magnitude: |F| as stored; phase: the phase of one component; animate: Re{F e^(j wt)} */
export type FieldPlaneMode = "magnitude" | "phase" | "animate";
/** "all": the whole map (|F| of the stored components); or one stored component */
export type FieldPlanePart = "all" | "x" | "y" | "z";
export type RGB = readonly [number, number, number];

export interface FieldPlaneView {
  mode: FieldPlaneMode;
  part: FieldPlanePart;
  scale: FieldPlaneScale;
  /** the instant of the animation, degrees of the period (animate mode) */
  phaseDeg: number;
}

// ------------------------------------------------------------------ colour positions (magnitude)

/** One sample on the colour ramp, 0 (bottom) to 1 (the map's maximum). */
export function rampPosition(value: number, max: number, scale: FieldPlaneScale, dbRange = FIELD_PLANE_DB_RANGE): number {
  if (!(max > 0) || !(value > 0)) return 0;
  const r = Math.min(1, value / max);
  if (scale === "linear") return r;
  return Math.max(0, 1 + (20 * Math.log10(r)) / dbRange);
}

/** Ramp positions of a map, row-major with v as the row (nv × nu). */
export function rampValues(m: FieldPlaneMap, scale: FieldPlaneScale, dbRange = FIELD_PLANE_DB_RANGE): Float32Array {
  const out = new Float32Array(m.nu * m.nv);
  for (let j = 0; j < m.nv; j++) {
    const row = m.magnitude[j];
    for (let i = 0; i < m.nu; i++) out[j * m.nu + i] = rampPosition(row[i], m.max, scale, dbRange);
  }
  return out;
}

/** The colour bar's tick labels, top (maximum) to bottom. */
export function scaleTicks(m: { max: number }, scale: FieldPlaneScale, dbRange = FIELD_PLANE_DB_RANGE): string[] {
  if (scale === "db") return [0, 0.25, 0.5, 0.75, 1].map((k) => `${k ? -Math.round(k * dbRange) : 0} dB`);
  return [1, 0.75, 0.5, 0.25, 0].map((k) => {
    const v = k * m.max;
    return v === 0 ? "0" : Number(v.toPrecision(3)).toString();
  });
}

// ------------------------------------------------------------------ the phasor

export interface DecodedPhasor {
  components: ("x" | "y" | "z")[];
  /** per component: nu · nv values, row-major with v as the row, in the map's unit */
  re: Float32Array[];
  im: Float32Array[];
  /** per component: the largest magnitude, and the sum of |F|² (which component dominates) */
  maxMag: number[];
  energy: number[];
}

const decoded = new WeakMap<FieldPlanePhasor, DecodedPhasor | null>();

/** The map's complex components in physical units, decoded once; null without a (usable) phasor. */
export function decodePhasor(m: Pick<FieldPlaneMap, "phasor" | "nu" | "nv">): DecodedPhasor | null {
  const p = m.phasor;
  if (!p) return null;
  if (decoded.has(p)) return decoded.get(p)!;
  let out: DecodedPhasor | null = null;
  try {
    const raw = atob(p.data);
    const n = m.nu * m.nv, k = p.components.length;
    if (k > 0 && raw.length === n * k * 2 && p.peak > 0) {
      const scale = p.peak / 127;
      const re = p.components.map(() => new Float32Array(n)), im = p.components.map(() => new Float32Array(n));
      for (let px = 0; px < n; px++) {
        for (let c = 0; c < k; c++) {
          const at = (px * k + c) * 2;
          // signed bytes: 128..255 are negative
          const a = raw.charCodeAt(at), b = raw.charCodeAt(at + 1);
          re[c][px] = (a > 127 ? a - 256 : a) * scale;
          im[c][px] = (b > 127 ? b - 256 : b) * scale;
        }
      }
      const maxMag = re.map((r, c) => { let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.hypot(r[i], im[c][i])); return mx; });
      const energy = re.map((r, c) => { let e = 0; for (let i = 0; i < n; i++) e += r[i] * r[i] + im[c][i] * im[c][i]; return e; });
      out = { components: [...p.components], re, im, maxMag, energy };
    }
  } catch { /* not base64: no phasor */ }
  decoded.set(p, out);
  return out;
}

export const hasPhasor = (m: Pick<FieldPlaneMap, "phasor" | "nu" | "nv">): boolean => decodePhasor(m) !== null;

/** The parts a viewer can pick: "all", and each stored component when there are several. */
export function partsOf(m: Pick<FieldPlaneMap, "phasor" | "nu" | "nv">): FieldPlanePart[] {
  const d = decodePhasor(m);
  return d && d.components.length > 1 ? ["all", ...d.components] : ["all"];
}

/** The component with the most energy: the one whose phase stands for a map of |F|. */
export function dominantComponent(d: DecodedPhasor): "x" | "y" | "z" {
  let best = 0;
  d.energy.forEach((e, i) => { if (e > d.energy[best]) best = i; });
  return d.components[best];
}

/** What a view really shows for this map: without a phasor only the magnitude; a part the map lacks
 * becomes "all"; the phase of a map of |F| is the phase of its dominant component. */
export function effectiveView(m: Pick<FieldPlaneMap, "phasor" | "nu" | "nv">, view: FieldPlaneView): FieldPlaneView {
  const d = decodePhasor(m);
  if (!d) return { ...view, mode: "magnitude", part: "all" };
  let part: FieldPlanePart = view.part !== "all" && d.components.includes(view.part) && d.components.length > 1 ? view.part : "all";
  if (view.mode === "phase" && part === "all") part = d.components.length > 1 ? dominantComponent(d) : "all";
  return { ...view, part };
}

// ------------------------------------------------------------------ the values of a view

/** magnitude: 0..ref; signed: -ref..ref (an instantaneous component); phase: degrees, -180..180 */
export type FieldKind = "magnitude" | "signed" | "phase";

export interface FieldValues {
  kind: FieldKind;
  /** nu · nv values, row-major with v as the row */
  values: Float32Array;
  /** full scale: the largest magnitude (magnitude, signed), the amplitude behind a phase */
  ref: number;
  /** phase: the magnitude of the same component, which says where the phase means anything */
  amplitude?: Float32Array;
  /** the component behind a component view or a phase ("all": the whole map) */
  component: FieldPlanePart;
  unit: string;
  /** a magnitude at one instant of the period, |F(t)|, rather than the phasor's */
  instant?: boolean;
}

const flat = new WeakMap<object, Float32Array>();
function magnitudeOf(m: FieldPlaneMap): Float32Array {
  let out = flat.get(m.magnitude);
  if (!out) {
    out = new Float32Array(m.nu * m.nv);
    for (let j = 0; j < m.nv; j++) for (let i = 0; i < m.nu; i++) out[j * m.nu + i] = m.magnitude[j][i];
    flat.set(m.magnitude, out);
  }
  return out;
}

/** Re{F e^(j·phase)} of one component, or |Re{F e^(j·phase)}| over the components: the field at one
 * instant of the period. */
export function instantaneous(d: DecodedPhasor, part: FieldPlanePart, phaseDeg: number, out?: Float32Array): Float32Array {
  const a = (phaseDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const n = d.re[0].length;
  const values = out?.length === n ? out : new Float32Array(n);
  if (part !== "all" || d.components.length === 1) {
    const k = part === "all" ? 0 : d.components.indexOf(part);
    const re = d.re[Math.max(0, k)], im = d.im[Math.max(0, k)];
    for (let i = 0; i < n; i++) values[i] = re[i] * c - im[i] * s;
    return values;
  }
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < d.components.length; k++) { const x = d.re[k][i] * c - d.im[k][i] * s; sum += x * x; }
    values[i] = Math.sqrt(sum);
  }
  return values;
}

/** The numbers a view colours. `view` is taken through `effectiveView`. */
export function fieldPlaneValues(m: FieldPlaneMap, requested: FieldPlaneView, animateOut?: Float32Array): FieldValues {
  const view = effectiveView(m, requested);
  const d = decodePhasor(m);
  const unit = m.unit;
  const compOf = (part: FieldPlanePart) => (d ? (part === "all" ? (d.components.length === 1 ? 0 : -1) : d.components.indexOf(part)) : -1);
  const magOfComponent = (k: number) => {
    const out = new Float32Array(m.nu * m.nv);
    for (let i = 0; i < out.length; i++) out[i] = Math.hypot(d!.re[k][i], d!.im[k][i]);
    return out;
  };
  if (view.mode === "magnitude" || !d) {
    const k = compOf(view.part);
    // a map of one component, or of |F|: the stored magnitude; one component of |F|: from the phasor
    if (!d || view.part === "all" || k < 0) return { kind: "magnitude", values: magnitudeOf(m), ref: m.max, component: "all", unit };
    return { kind: "magnitude", values: magOfComponent(k), ref: d.maxMag[k], component: view.part, unit };
  }
  const k = compOf(view.part);
  if (view.mode === "phase") {
    const kk = k < 0 ? 0 : k;
    const values = new Float32Array(m.nu * m.nv);
    for (let i = 0; i < values.length; i++) values[i] = (Math.atan2(d.im[kk][i], d.re[kk][i]) * 180) / Math.PI;
    return { kind: "phase", values, ref: d.maxMag[kk], amplitude: magOfComponent(kk), component: d.components[kk], unit };
  }
  // animate: the instantaneous magnitude of the vector for the whole map, else a signed component
  const values = instantaneous(d, view.part, view.phaseDeg, animateOut);
  if (k < 0) return { kind: "magnitude", values, ref: m.max, component: "all", unit, instant: true };
  return { kind: "signed", values, ref: d.maxMag[k], component: d.components[k], unit };
}

// ------------------------------------------------------------------ colours

/** Position 0..1 on a list of RGB stops. */
export function sampleRamp(stops: readonly RGB[], t: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const x = (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i, a = stops[i], b = stops[i + 1];
  out[0] = a[0] + (b[0] - a[0]) * f;
  out[1] = a[1] + (b[1] - a[1]) * f;
  out[2] = a[2] + (b[2] - a[2]) * f;
  return out;
}

/** blue - light - red for signed values (an instantaneous component); 0 is the light middle */
export const DIVERGING_STOPS: readonly RGB[] = [[33, 82, 176], [104, 158, 224], [241, 239, 232], [232, 140, 104], [176, 40, 34]];

/** The colour of a signed value against its full scale. */
export const signedColor = (value: number, ref: number, out?: [number, number, number]): [number, number, number] => sampleRamp(DIVERGING_STOPS, ref > 0 ? 0.5 + 0.5 * Math.max(-1, Math.min(1, value / ref)) : 0.5, out);

const NEUTRAL: RGB = [128, 128, 128];
/** Phases are drawn where the field is at least this far below its maximum, fading to grey below:
 * the 8-bit phasor cannot tell a phase from noise there. */
export const PHASE_FADE_DB: readonly [number, number] = [-40, -28];

/** A cyclic hue for a phase in degrees (-180 and 180 are the same colour). */
export function phaseColor(deg: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const h = ((((deg + 180) % 360) + 360) % 360) / 60;
  const s = 0.62, v = 0.96;
  const f = h - Math.floor(h), p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  switch (Math.floor(h) % 6) {
    case 0: out[0] = v * 255; out[1] = t * 255; out[2] = p * 255; break;
    case 1: out[0] = q * 255; out[1] = v * 255; out[2] = p * 255; break;
    case 2: out[0] = p * 255; out[1] = v * 255; out[2] = t * 255; break;
    case 3: out[0] = p * 255; out[1] = q * 255; out[2] = v * 255; break;
    case 4: out[0] = t * 255; out[1] = p * 255; out[2] = v * 255; break;
    case 5: out[0] = v * 255; out[1] = p * 255; out[2] = q * 255; break;
    default: throw new RangeError("phase angle must be finite");
  }
  return out;
}

/** How much of a phase colour shows at an amplitude (0 grey, 1 full). */
export function phaseWeight(amplitude: number, ref: number): number {
  if (!(ref > 0) || !(amplitude > 0)) return 0;
  const db = 20 * Math.log10(Math.min(1, amplitude / ref));
  const [lo, hi] = PHASE_FADE_DB;
  const x = Math.max(0, Math.min(1, (db - lo) / (hi - lo)));
  return x * x * (3 - 2 * x);
}

/** The RGB of one sample of a view. */
export function fieldColor(fv: FieldValues, i: number, scale: FieldPlaneScale, ramp: readonly RGB[], out?: [number, number, number]): [number, number, number] {
  const v = fv.values[i];
  if (fv.kind === "magnitude") return sampleRamp(ramp, rampPosition(v, fv.ref, scale), out);
  if (fv.kind === "signed") return signedColor(v, fv.ref, out);
  const w = phaseWeight(fv.amplitude?.[i] ?? 0, fv.ref), c = phaseColor(v, out);
  c[0] = NEUTRAL[0] + (c[0] - NEUTRAL[0]) * w;
  c[1] = NEUTRAL[1] + (c[1] - NEUTRAL[1]) * w;
  c[2] = NEUTRAL[2] + (c[2] - NEUTRAL[2]) * w;
  return c;
}

/** nu × nv RGBA bytes of a view, row 0 at v_range[0] (the texture's order), or at the top with
 * `flipV` (an image on screen has v growing upwards). */
export function fieldPlaneRgba(m: Pick<FieldPlaneMap, "nu" | "nv">, fv: FieldValues, scale: FieldPlaneScale, ramp: readonly RGB[], flipV = false, out?: Uint8ClampedArray): Uint8ClampedArray {
  const data = out && out.length === m.nu * m.nv * 4 ? out : new Uint8ClampedArray(m.nu * m.nv * 4);
  const color: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < m.nv; j++) {
    const row = flipV ? m.nv - 1 - j : j;
    for (let i = 0; i < m.nu; i++) {
      const c = fieldColor(fv, j * m.nu + i, scale, ramp, color), at = (row * m.nu + i) * 4;
      data[at] = c[0]; data[at + 1] = c[1]; data[at + 2] = c[2]; data[at + 3] = 255;
    }
  }
  return data;
}

/** The colour bar of a view: RGB from the top to the bottom, `n` steps, with the tick labels. */
export function legendOf(fv: FieldValues, scale: FieldPlaneScale, ramp: readonly RGB[], n = 64): { colors: [number, number, number][]; ticks: string[] } {
  const at = (k: number) => 1 - k / (n - 1);            // 1 at the top
  if (fv.kind === "phase") {
    return { colors: Array.from({ length: n }, (_, k) => phaseColor(-180 + 360 * at(k))), ticks: ["180°", "90°", "0°", "−90°", "−180°"] };
  }
  if (fv.kind === "signed") {
    const ticks = [1, 0.5, 0, -0.5, -1].map((k) => (k === 0 ? "0" : `${k < 0 ? "−" : ""}${Number(Math.abs(k * fv.ref).toPrecision(3))}`));
    return { colors: Array.from({ length: n }, (_, k) => signedColor((2 * at(k) - 1) * fv.ref, fv.ref)), ticks };
  }
  return { colors: Array.from({ length: n }, (_, k) => sampleRamp(ramp, at(k))), ticks: scaleTicks({ max: fv.ref }, scale) };
}

// ------------------------------------------------------------------ hover readout

/** The sample nearest to (u, v) in mm, or null outside the map. */
export function sampleIndex(m: Pick<FieldPlaneMap, "u_range" | "v_range" | "nu" | "nv">, u: number, v: number): { i: number; j: number } | null {
  const du = (m.u_range[1] - m.u_range[0]) / Math.max(1, m.nu - 1), dv = (m.v_range[1] - m.v_range[0]) / Math.max(1, m.nv - 1);
  const fi = du > 0 ? (u - m.u_range[0]) / du : 0, fj = dv > 0 ? (v - m.v_range[0]) / dv : 0;
  if (!(fi >= -0.5 && fi <= m.nu - 0.5 && fj >= -0.5 && fj <= m.nv - 0.5)) return null;
  return { i: Math.min(m.nu - 1, Math.max(0, Math.round(fi))), j: Math.min(m.nv - 1, Math.max(0, Math.round(fj))) };
}

/** The coordinates of a sample, mm. */
export function samplePosition(m: Pick<FieldPlaneMap, "u_range" | "v_range" | "nu" | "nv">, i: number, j: number): { u: number; v: number } {
  return {
    u: m.u_range[0] + (i * (m.u_range[1] - m.u_range[0])) / Math.max(1, m.nu - 1),
    v: m.v_range[0] + (j * (m.v_range[1] - m.v_range[0])) / Math.max(1, m.nv - 1),
  };
}

export interface Readout {
  u: number;
  v: number;
  /** the shown value: a magnitude, a signed component, or a phase in degrees */
  value: number;
  kind: FieldKind;
  /** a magnitude's level against the map's maximum, dB (−Infinity for zero); for a phase, the level of its amplitude */
  db: number | null;
}

/** What the pointer is over: the value of the view at sample (i, j). */
export function readoutAt(m: FieldPlaneMap, fv: FieldValues, i: number, j: number): Readout {
  const at = j * m.nu + i, { u, v } = samplePosition(m, i, j);
  const level = (x: number) => (fv.ref > 0 ? 20 * Math.log10(Math.abs(x) / fv.ref) : null);
  const value = fv.values[at];
  return { u, v, value, kind: fv.kind, db: fv.kind === "phase" ? level(fv.amplitude?.[at] ?? 0) : fv.kind === "signed" ? null : level(value) };
}

// ------------------------------------------------------------------ the structure's outline

export interface OutlineShape {
  /** a metal part (drawn solid), else a dielectric (dashed) */
  metal: boolean;
  /** a closed polygon in (u, v), mm */
  points: [number, number][];
}

const isMetal = (p: Part) => p.type === "Metal" || p.type === "ConductingSheet" || !!p.conductor;

/** The model's parts projected onto the plane (along its normal), as outlines in (u, v): boxes and
 * polygons drawn on the plane's axis as they are, cylinders along it as circles, the rest by their
 * bounding boxes. At most `limit` shapes, identical ones once. */
export function planeOutline(parts: readonly Part[] | undefined, m: Pick<FieldPlaneMap, "axis" | "u_axis" | "v_axis">, limit = 1500): OutlineShape[] {
  const out: OutlineShape[] = [];
  const seen = new Set<string>();
  const rect = (lo: number[], hi: number[]): [number, number][] => [[lo[m.u_axis], lo[m.v_axis]], [hi[m.u_axis], lo[m.v_axis]], [hi[m.u_axis], hi[m.v_axis]], [lo[m.u_axis], hi[m.v_axis]]];
  const add = (metal: boolean, points: [number, number][]) => {
    if (out.length >= limit || points.length < 3 || points.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b))) return;
    const key = `${metal ? 1 : 0}|${points.map(([a, b]) => `${+a.toFixed(4)},${+b.toFixed(4)}`).join(";")}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ metal, points });
  };
  for (const part of parts ?? []) {
    const metal = isMetal(part);
    for (const p of part.primitives ?? []) {
      if (p.kind === "transformed") {
        const shapes = viewShapes({ parts: [{ ...part, primitives: [p] }] }, {
          id: "top", title: "", u: { axis: m.u_axis, sign: 1 }, v: { axis: m.v_axis, sign: 1 }, d: { axis: m.axis, sign: 1 },
        });
        for (const s of shapes) {
          if (s.kind === "circle" && s.c && s.r != null) {
            add(metal, Array.from({ length: 32 }, (_, k) => [s.c![0] + s.r! * Math.cos(2 * Math.PI * k / 32), s.c![1] + s.r! * Math.sin(2 * Math.PI * k / 32)]));
          } else if (s.kind === "poly") add(metal, s.pts);
        }
      } else if (p.kind === "box") add(metal, rect([0, 1, 2].map((a) => Math.min(p.start[a], p.stop[a])), [0, 1, 2].map((a) => Math.max(p.start[a], p.stop[a]))));
      else if ((p.kind === "polygon" || p.kind === "linpoly") && p.normal === m.axis) add(metal, p.points.map(([a, b]) => [a, b] as [number, number]));
      else if (p.kind === "cylinder" && [0, 1, 2].every((a) => a === m.axis || Math.abs(p.start[a] - p.stop[a]) < 1e-9)) {
        const cu = p.start[m.u_axis], cv = p.start[m.v_axis];
        add(metal, Array.from({ length: 32 }, (_, k) => [cu + p.radius * Math.cos((2 * Math.PI * k) / 32), cv + p.radius * Math.sin((2 * Math.PI * k) / 32)] as [number, number]));
      } else if (p.bbox) add(metal, rect(p.bbox[0], p.bbox[1]));
    }
  }
  return out;
}

// ------------------------------------------------------------------ raw data

/** Copy data / CSV columns of a map's phasor: per component the real and imaginary part and the
 * phase in degrees, beside `Magnitude`. English headers, plain numbers. */
export function phasorColumns(m: FieldPlaneMap): { header: string[]; at: (sample: number) => (number | null)[] } {
  const d = decodePhasor(m);
  if (!d) return { header: [], at: () => [] };
  const q = m.quantity;
  const cell = (x: number) => (Number.isFinite(x) ? +x.toPrecision(4) : null);
  return {
    header: d.components.flatMap((c) => [`Re ${q}${c}`, `Im ${q}${c}`, `Phase ${q}${c} (deg)`]),
    at: (s) => d.components.flatMap((_, k) => [cell(d.re[k][s]), cell(d.im[k][s]), cell((Math.atan2(d.im[k][s], d.re[k][s]) * 180) / Math.PI)]),
  };
}
