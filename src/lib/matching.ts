/** Ideal, lossless one-port matching at the stored impedance reference plane.
 * No geometry, solver result or reference impedance is changed. Frequencies are Hz. */
import type { Bundle } from "../types.ts";
import { sweep } from "./rf.ts";
import { hasSParameterPhase, sMatrix } from "./sparams.ts";

/** Reject representations which do not define this single, real-reference circuit problem. */
export function matchingSweep(b: Bundle) {
  const s = sweep(b), matrix = sMatrix(b), complex = b.ports[0]?.reference_impedance;
  const rawReference = b.results?.ports[String(b.ports[0]?.number)]?.z_ref_f;
  return s && hasSParameterPhase(b) && b.ports.length === 1 && (!matrix || matrix.ports.length === 1)
    && Number.isFinite(s.zRef) && s.zRef > 0 && s.f.length > 0
    && s.f.every((f, i) => Number.isFinite(f) && f > 0 && (!i || f > s.f[i - 1]))
    && s.zRe.length === s.f.length && s.zIm.length === s.f.length
    && (rawReference === undefined || (Array.isArray(rawReference) && rawReference.length === s.f.length && rawReference.every(z => z === s.zRef)))
    && (!complex || (complex.imag === 0 && complex.real === s.zRef)) ? s : null;
}

export interface Impedance { re: number; im: number }
export interface MatchNetwork {
  id: string;
  topology: "series-input" | "shunt-input" | "quarter-wave";
  f0: number;
  /** Series reactance (ohm) and shunt susceptance (siemens) at f0. */
  x: number;
  b: number;
  lineZ?: number;
}
const finiteZ = (z: Impedance) => Number.isFinite(z.re) && Number.isFinite(z.im);
function div(a: Impedance, b: Impedance): Impedance | null {
  const d = b.re * b.re + b.im * b.im;
  if (!(d > 0 && Number.isFinite(d))) return null;
  const z = { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
  return finiteZ(z) ? z : null;
}
const inverse = (z: Impedance) => div({ re: 1, im: 0 }, z);

export function matchedImpedance(n: MatchNetwork, load: Impedance, f: number): Impedance | null {
  if (!finiteZ(load) || !(load.re > 0) || !(Number.isFinite(f) && f > 0)
    || !(Number.isFinite(n.f0) && n.f0 > 0)) return null;
  const ratio = f / n.f0;
  if (n.topology === "quarter-wave") {
    if (!(n.lineZ! > 0 && Number.isFinite(n.lineZ))) return null;
    const c = Math.cos(Math.PI / 2 * ratio), s = Math.sin(Math.PI / 2 * ratio), z = n.lineZ!;
    return div({ re: load.re * c, im: load.im * c + z * s },
      { re: c - load.im * s / z, im: load.re * s / z });
  }
  // Positive series X is L, negative X is C; positive shunt B is C, negative B is L.
  const x = n.x >= 0 ? n.x * ratio : n.x / ratio;
  const b = n.b >= 0 ? n.b * ratio : n.b / ratio;
  if (![x, b].every(Number.isFinite)) return null;
  if (n.topology === "shunt-input") {
    const y = inverse({ re: load.re, im: load.im + x });
    return y && inverse({ re: y.re, im: y.im + b });
  }
  const y = inverse(load), parallel = y && inverse({ re: y.re, im: y.im + b });
  return parallel ? { re: parallel.re, im: parallel.im + x } : null;
}

export function reflection(z: Impedance, reference: number): Impedance | null {
  if (!finiteZ(z) || !(Number.isFinite(reference) && reference > 0)) return null;
  return div({ re: z.re - reference, im: z.im }, { re: z.re + reference, im: z.im });
}

/** Both L-section orientations and both algebraic signs where physically admissible.
 * A reactive load can admit four solutions. Degenerate zero elements are bypasses. */
export function synthesizeMatches(load: Impedance, reference: number, f0: number): MatchNetwork[] {
  if (!finiteZ(load) || !(load.re > 0) || !(Number.isFinite(reference) && reference > 0)
    || !(Number.isFinite(f0) && f0 > 0)) return [];
  const result: MatchNetwork[] = [], r = load.re;
  if (r <= reference) for (const sign of [-1, 1]) {
    const totalX = sign * Math.sqrt(r * (reference - r));
    result.push({ id: `shunt-input:${sign}`, topology: "shunt-input", f0, x: totalX - load.im, b: totalX / (r * reference) });
  }
  const y = inverse(load);
  if (y && y.re > 0 && 1 / y.re >= reference) for (const sign of [-1, 1]) {
    const totalB = sign * Math.sqrt(Math.max(0, y.re / reference - y.re * y.re));
    result.push({ id: `series-input:${sign}`, topology: "series-input", f0, x: totalB * reference / y.re, b: totalB - y.im });
  }
  if (load.im === 0) result.push({ id: "quarter-wave", topology: "quarter-wave", f0, x: 0, b: 0, lineZ: Math.sqrt(r * reference) });
  return result.filter((n, i) => {
    if (result.slice(0, i).some(p => p.topology === n.topology && p.x === n.x && p.b === n.b && p.lineZ === n.lineZ)) return false;
    const z = matchedImpedance(n, load, f0), g = z && reflection(z, reference);
    return !!g && Math.hypot(g.re, g.im) < 1e-10;
  });
}

export function matchComponents(n: MatchNetwork): { location: "series" | "shunt"; kind: "L" | "C"; value: number }[] {
  const omega = 2 * Math.PI * n.f0;
  if (n.topology === "quarter-wave") return [];
  const series = n.x === 0 ? [] : [{ location: "series" as const, kind: n.x > 0 ? "L" as const : "C" as const,
    value: n.x > 0 ? n.x / omega : -1 / (omega * n.x) }];
  const shunt = n.b === 0 ? [] : [{ location: "shunt" as const, kind: n.b > 0 ? "C" as const : "L" as const,
    value: n.b > 0 ? n.b / omega : -1 / (omega * n.b) }];
  return n.topology === "series-input" ? [...series, ...shunt] : [...shunt, ...series];
}
