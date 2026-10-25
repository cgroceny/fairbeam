// Datasheet validation and band-centre appearance only. Solver poles are fitted by
// fairbeam.Simulation.dispersive, never by the instant browser preview.
import type { DesignMaterial, Expr } from "./types.ts";
export const DS_MODEL = "djordjevic-sarkar";
export interface DatasheetDispersion { model: "djordjevic-sarkar"; m1?: Expr; m2?: Expr; n_poles?: number }

export function descriptorProblem(material: Pick<DesignMaterial, "kind" | "dispersion">): string | null {
  if (!("dispersion" in material)) return null;
  const d = material.dispersion;
  if (material.kind !== "dielectric") return "dispersion requires a dielectric";
  if (!d || typeof d !== "object" || Array.isArray(d) || d.model !== DS_MODEL) return "dispersion model must be djordjevic-sarkar";
  if (Object.keys(d).some((k) => !["model", "m1", "m2", "n_poles"].includes(k))) return "unknown dispersion input";
  for (const k of ["m1", "m2"] as const) if (k in d && !["number", "string"].includes(typeof d[k])) return `${k} must be a number or expression`;
  if ("n_poles" in d && (!Number.isInteger(d.n_poles) || d.n_poles! < 1 || d.n_poles! > 32)) return "n_poles must be an integer from 1 to 32";
  return null;
}

const dsLog = (f: number, m1: number, m2: number) => {
  const w = 2 * Math.PI * f * 1e9, w1 = 10 ** m1, w2 = 10 ** m2, scale = Math.LN10 * (m2 - m1);
  return [(Math.log(Math.hypot(w2, w)) - Math.log(Math.hypot(w1, w))) / scale,
    (Math.atan2(w, w2) - Math.atan2(w, w1)) / scale];
};

export function resolvedDatasheet(material: DesignMaterial, evaluate: (v: Expr) => number = (v) => typeof v === "number" ? v : NaN) {
  const problem = descriptorProblem(material);
  if (problem || !material.dispersion) throw new Error(problem ?? "missing dispersion input");
  const number = (v: Expr | undefined) => {
    if (v === undefined || v === null || typeof v === "boolean") throw new Error("dispersion inputs must resolve to finite numbers");
    let n: number;
    try { n = evaluate(v); } catch { throw new Error("could not resolve the datasheet expressions"); }
    if (typeof n !== "number" || !Number.isFinite(n)) throw new Error("dispersion inputs must resolve to finite numbers");
    return n;
  };
  const eps = number(material.eps_r === undefined ? 1 : material.eps_r), tan = number(material.tan_d === undefined ? 0 : material.tan_d), f = number(material.tan_d_freq);
  const mu = number(material.mu_r === undefined ? 1 : material.mu_r), m1 = number(material.dispersion.m1 ?? 4), m2 = number(material.dispersion.m2 ?? 12);
  if (eps < 1 || tan < 0 || f <= 0) throw new Error("a datasheet point needs eps_r >= 1, tan_d >= 0 and a positive reference frequency");
  if (mu !== 1) throw new Error("Djordjevic-Sarkar requires nonmagnetic mu_r = 1");
  const [real, imag] = dsLog(f, m1, m2), delta = tan ? -eps * tan / imag : 0, eps_inf = eps - delta * real;
  if (m2 <= m1 || [10 ** m1, 10 ** m2].some((v) => !Number.isFinite(v) || v <= 0) || !Number.isFinite(delta) || delta < 0 || !Number.isFinite(eps_inf) || eps_inf <= 0)
    throw new Error("corners must satisfy m2 > m1 with finite positive frequencies and a passive positive eps_inf calibration");
  return { eps_r: eps, tan_d: tan, tan_d_freq: f, eps_inf, delta, m1, m2 };
}

export function datasheetAppearance(material: DesignMaterial, evaluate: (v: Expr) => number, fGHz: number) {
  const input = resolvedDatasheet(material, evaluate);
  if (!Number.isFinite(fGHz) || fGHz <= 0) throw new Error("appearance frequency must be positive");
  const [real, imag] = dsLog(fGHz, input.m1, input.m2);
  const eps = input.eps_inf + input.delta * real, loss = -input.delta * imag;
  return { eps_r: eps, mu_r: 1, tan_d: loss / eps, tan_d_freq: fGHz * 1e9,
    kappa: loss * 2 * Math.PI * fGHz * 1e9 * 8.8541878128e-12,
    dispersion: { model: DS_MODEL, eps_inf: input.eps_inf, delta: input.delta, m1: input.m1, m2: input.m2,
      source: { appearance_only: true, frequency_hz: fGHz * 1e9, datasheet: input } } };
}
