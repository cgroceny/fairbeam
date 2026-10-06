// S-parameter and element-pattern adapter: the one place that maps bundle fields to the viewer's
// multi-port model. Newer bundles carry `results.sparams` (N-port matrix) and
// `results.element_patterns` (embedded element patterns); older ones only
// `results.ports["1"].s11_*` and are presented as a 1-port matrix. Pure TS (Node + browser).
//
// Accepted shapes (schema fairbeam.project/1, additive fields; key names are matched loosely so a
// small renaming on the Python side only needs a change here):
//   results.sparams = { ports: [1, 2], z_ref: [50, 50] | 50, excited: [1],
//                       s: { "2,1": { re: [...], im: [...] }, ... }      (also "S21", "2-1", "s21")
//                       reciprocity_max?, passivity_max? (or qa: { reciprocity, passivity }) }
//   results.element_patterns = [ { f, theta: [...], phi: [...],
//                       elements: [ { port, e_theta: { re: [][], im: [][] }, e_phi: { re, im } } ] } ]
//                       (also { ports: { "1": { e_theta_re, e_theta_im, e_phi_re, e_phi_im } } })
//   or the compact form written by python/fairbeam/multiport.py (docs/BUNDLE.md):
//   results.element_patterns = { encoding, shape: [nθ, nφ], theta, phi, frequencies: [...],
//                       ports: [ { port, position, fields: [ { f, scale?, e_theta_re, e_theta_im, e_phi_re, e_phi_im } ] } ] }
//                       where every e_* is a base64 string of nθ·nφ values, row-major [θ][φ]:
//                       encoding "i16le-base64-scaled" (current writer): little-endian int16 q, value = q · scale / 32767
//                       encoding "f32le-base64" (older bundles): little-endian float32

import type { Bundle } from "../types";

export interface Complex {
  re: number[];
  im: number[];
}

export interface SMatrix {
  /** frequency grid in Hz (results.frequency) */
  f: number[];
  /** port numbers, in matrix order */
  ports: number[];
  zRef: number[];
  excited: number[];
  /** S_ij (receiving port i, driven port j); null when not stored */
  get(i: number, j: number): Complex | null;
  /** every stored pair [i, j] in row-major order */
  pairs: [number, number][];
  reciprocity: number | null;
  passivity: number | null;
  /** true when built from the legacy results.ports["1"] fields */
  legacy: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const nums = (v: unknown): number[] | null => (Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : null);

function complexOf(v: unknown): Complex | null {
  if (!isObj(v)) return null;
  const re = nums(v.re ?? v.real);
  const im = nums(v.im ?? v.imag);
  return re && im && re.length === im.length ? { re, im } : null;
}

/** "2,1" | "2-1" | "S21" | "s_2_1" -> [2, 1] */
export function parsePair(k: string, nPorts = 9): [number, number] | null {
  const m = /^[sS]?_?(\d+)\s*[,;\-_ ]\s*(\d+)$/.exec(k.trim());
  if (m) return [Number(m[1]), Number(m[2])];
  const c = /^[sS](\d)(\d)$/.exec(k.trim());
  if (c && nPorts < 10) return [Number(c[1]), Number(c[2])];
  return null;
}

export function sMatrix(b: Bundle | null | undefined): SMatrix | null {
  const r = b?.results;
  if (!b || !r) return null;
  const f = r.frequency;
  const raw = (r as unknown as Obj).sparams;
  if (isObj(raw)) {
    const table = (raw.s ?? raw.S ?? raw.matrix ?? raw.data) as unknown;
    const map = new Map<string, Complex>();
    let ports = nums(raw.ports) ?? [];
    if (isObj(table)) {
      const n = ports.length || 9;
      for (const [k, v] of Object.entries(table)) {
        const p = parsePair(k, n);
        const c = complexOf(v);
        if (p && c && c.re.length === f.length) map.set(`${p[0]},${p[1]}`, c);
      }
    }
    if (!ports.length) ports = [...new Set([...map.keys()].flatMap((k) => k.split(",").map(Number)))].sort((a, c) => a - c);
    if (map.size && ports.length) {
      const zr = raw.z_ref ?? raw.zref ?? raw.z0;
      const zRef = typeof zr === "number" ? ports.map(() => zr) : nums(zr) ?? ports.map((p) => r.ports[String(p)]?.z_ref ?? 50);
      const qa = isObj(raw.qa) ? raw.qa : raw;
      const num = (...ks: string[]) => {
        for (const k of ks) if (typeof qa[k] === "number") return qa[k] as number;
        return null;
      };
      const pairs: [number, number][] = [];
      for (const i of ports) for (const j of ports) if (map.has(`${i},${j}`)) pairs.push([i, j]);
      return {
        f, ports, zRef,
        excited: nums(raw.excited) ?? b.ports.filter((p) => p.excite).map((p) => p.number),
        get: (i, j) => map.get(`${i},${j}`) ?? null,
        pairs,
        reciprocity: num("reciprocity_max", "reciprocity", "reciprocity_err", "max_reciprocity_error"),
        passivity: num("passivity_max", "passivity", "max_column_power"),
        legacy: false,
      };
    }
  }
  // legacy: every port result with s11_* is that port's reflection S_ii
  const map = new Map<string, Complex>();
  const ports: number[] = [];
  const zRef: number[] = [];
  const keys = Object.keys(r.ports ?? {}).map(Number).filter(Number.isFinite).sort((a, c) => a - c);
  for (const p of keys) {
    const pr = r.ports[String(p)];
    if (!pr?.s11_re || pr.s11_re.length !== f.length) continue;
    map.set(`${p},${p}`, { re: pr.s11_re, im: pr.s11_im });
    ports.push(p);
    zRef.push(pr.z_ref);
  }
  if (!ports.length) return null;
  return {
    f, ports, zRef,
    excited: b.ports.filter((p) => p.excite).map((p) => p.number),
    get: (i, j) => map.get(`${i},${j}`) ?? null,
    pairs: ports.map((p) => [p, p] as [number, number]),
    reciprocity: null,
    passivity: null,
    legacy: true,
  };
}

export const pairLabel = ([i, j]: [number, number]) => (i < 10 && j < 10 ? `S${i}${j}` : `S${i},${j}`);

export const magDb = (c: Complex) => c.re.map((re, k) => 10 * Math.log10(Math.max(1e-30, re * re + c.im[k] * c.im[k])));
export const phaseDeg = (c: Complex) => c.re.map((re, k) => (Math.atan2(c.im[k], re) * 180) / Math.PI);

/** Input impedance seen at a port from its reflection coefficient. */
export function zFromGamma(c: Complex, z0: number): Complex {
  const re: number[] = [];
  const im: number[] = [];
  c.re.forEach((gr, k) => {
    const gi = c.im[k];
    // Z = z0 (1 + Γ) / (1 − Γ)
    const dr = 1 - gr;
    const den = dr * dr + gi * gi || 1e-30;
    re.push((z0 * ((1 + gr) * dr - gi * gi)) / den);
    im.push((z0 * (gi * dr + (1 + gr) * gi)) / den);
  });
  return { re, im };
}

/** S_ij interpolated linearly at frequency fHz. */
export function sAt(S: SMatrix, i: number, j: number, fHz: number): [number, number] | null {
  const c = S.get(i, j);
  if (!c) return null;
  const f = S.f;
  let k = 0;
  while (k < f.length - 2 && f[k + 1] < fHz) k++;
  const t = f.length > 1 ? Math.min(1, Math.max(0, (fHz - f[k]) / (f[k + 1] - f[k] || 1))) : 0;
  const k2 = Math.min(k + 1, f.length - 1);
  return [c.re[k] + t * (c.re[k2] - c.re[k]), c.im[k] + t * (c.im[k2] - c.im[k])];
}

// ------------------------------------------------------------------ element patterns

export interface ElementPattern {
  port: number;
  /** [theta][phi] */
  eThetaRe: number[][];
  eThetaIm: number[][];
  ePhiRe: number[][];
  ePhiIm: number[][];
}

export interface ElementPatternSet {
  f: number;
  theta: number[];
  phi: number[];
  elements: ElementPattern[];
}

const grid = (v: unknown): number[][] | null => (Array.isArray(v) && v.every((row) => nums(row)) ? (v as number[][]) : null);

function elementOf(port: number, v: unknown): ElementPattern | null {
  if (!isObj(v)) return null;
  const et = isObj(v.e_theta) ? v.e_theta : isObj(v.E_theta) ? v.E_theta : null;
  const ep = isObj(v.e_phi) ? v.e_phi : isObj(v.E_phi) ? v.E_phi : null;
  const tr = grid(et?.re ?? v.e_theta_re);
  const ti = grid(et?.im ?? v.e_theta_im);
  const pr = grid(ep?.re ?? v.e_phi_re);
  const pi = grid(ep?.im ?? v.e_phi_im);
  if (!tr || !ti || !pr || !pi) return null;
  return { port, eThetaRe: tr, eThetaIm: ti, ePhiRe: pr, ePhiIm: pi };
}

/** Element-pattern encodings (docs/BUNDLE.md#element_patterns); both are read. */
export const ENC_F32 = "f32le-base64";
export const ENC_I16 = "i16le-base64-scaled";
export const I16_FULL = 32767;

function base64Bytes(text: string, n: number): DataView | null {
  let bin: string;
  try {
    bin = atob(text);
  } catch {
    return null;
  }
  if (bin.length !== n) return null;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new DataView(bytes.buffer);
}

function toGrid(rows: number, cols: number, at: (i: number) => number): number[][] {
  const out: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = new Array(cols);
    for (let c = 0; c < cols; c++) row[c] = at(r * cols + c);
    out.push(row);
  }
  return out;
}

/** base64 little-endian float32 -> [rows][cols] */
export function decodeF32Grid(text: string, rows: number, cols: number): number[][] | null {
  const dv = base64Bytes(text, rows * cols * 4);
  return dv && toGrid(rows, cols, (i) => dv.getFloat32(i * 4, true));
}

/** base64 little-endian int16 q -> [rows][cols] of q · scale / 32767 */
export function decodeI16Grid(text: string, rows: number, cols: number, scale: number): number[][] | null {
  if (!Number.isFinite(scale)) return null;
  const dv = base64Bytes(text, rows * cols * 2);
  const k = scale / I16_FULL;
  return dv && toGrid(rows, cols, (i) => dv.getInt16(i * 2, true) * k);
}

/** Inverse of decodeI16Grid for flat arrays (tests and tools): { scale, texts } with one shared scale. */
export function encodeI16Grids(arrays: ArrayLike<number>[]): { scale: number; texts: string[] } {
  let scale = 0;
  for (const a of arrays) for (let i = 0; i < a.length; i++) scale = Math.max(scale, Math.abs(a[i]));
  const div = scale > 0 ? scale : 1;
  const texts = arrays.map((a) => {
    const dv = new DataView(new ArrayBuffer(a.length * 2));
    for (let i = 0; i < a.length; i++) dv.setInt16(i * 2, Math.round((a[i] / div) * I16_FULL), true);
    let bin = "";
    const u = new Uint8Array(dv.buffer);
    for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
    return btoa(bin);
  });
  return { scale, texts };
}

/** The compact multiport.py form: one set per stored frequency. */
function compactSets(raw: Obj): ElementPatternSet[] {
  const theta = nums(raw.theta);
  const phi = nums(raw.phi);
  const freqs = nums(raw.frequencies);
  const shape = nums(raw.shape);
  if (!theta || !phi || !freqs || !shape || !Array.isArray(raw.ports)) return [];
  const [nt, np] = shape;
  if (nt !== theta.length || np !== phi.length) return [];
  const i16 = raw.encoding === ENC_I16;
  return freqs.map((f, k) => {
    const elements: ElementPattern[] = [];
    for (const p of raw.ports as unknown[]) {
      if (!isObj(p) || typeof p.port !== "number" || !Array.isArray(p.fields)) continue;
      const e = p.fields[k];
      if (!isObj(e) || (i16 && typeof e.scale !== "number")) continue;
      const g = (key: string) => (typeof e[key] !== "string" ? null
        : i16 ? decodeI16Grid(e[key] as string, nt, np, e.scale as number) : decodeF32Grid(e[key] as string, nt, np));
      const tr = g("e_theta_re"), ti = g("e_theta_im"), pr = g("e_phi_re"), pi = g("e_phi_im");
      if (tr && ti && pr && pi) elements.push({ port: p.port, eThetaRe: tr, eThetaIm: ti, ePhiRe: pr, ePhiIm: pi });
    }
    return { f, theta, phi, elements: elements.sort((a, c) => a.port - c.port) };
  }).filter((s) => s.elements.length);
}

export function elementPatterns(b: Bundle | null | undefined): ElementPatternSet[] {
  const raw = (b?.results as unknown as Obj | undefined)?.element_patterns;
  if (isObj(raw) && (raw.encoding === ENC_F32 || raw.encoding === ENC_I16)) return compactSets(raw);
  const list = Array.isArray(raw) ? raw : isObj(raw) ? Object.values(raw) : [];
  const out: ElementPatternSet[] = [];
  for (const e of list) {
    if (!isObj(e)) continue;
    const theta = nums(e.theta);
    const phi = nums(e.phi);
    const f = typeof e.f === "number" ? e.f : typeof e.frequency === "number" ? e.frequency : null;
    if (!theta || !phi || f === null) continue;
    const els: ElementPattern[] = [];
    if (Array.isArray(e.elements)) {
      for (const el of e.elements) if (isObj(el) && typeof el.port === "number") {
        const x = elementOf(el.port, el);
        if (x) els.push(x);
      }
    } else if (isObj(e.ports)) {
      for (const [k, v] of Object.entries(e.ports)) {
        const x = elementOf(Number(k), v);
        if (x) els.push(x);
      }
    }
    const ok = els.filter((x) => x.eThetaRe.length === theta.length && x.eThetaRe.every((row) => row.length === phi.length));
    if (ok.length) out.push({ f, theta, phi, elements: ok.sort((a, c) => a.port - c.port) });
  }
  return out.sort((a, c) => a.f - c.f);
}

/** Element patterns at (or within 1 MHz of) fHz. */
export function elementPatternsAt(b: Bundle | null | undefined, fHz: number): ElementPatternSet | null {
  const list = elementPatterns(b);
  let best: ElementPatternSet | null = null;
  for (const e of list) if (Math.abs(e.f - fHz) <= 1e6 && (!best || Math.abs(e.f - fHz) < Math.abs(best.f - fHz))) best = e;
  return best;
}
