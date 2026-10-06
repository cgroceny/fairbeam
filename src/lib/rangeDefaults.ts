// Default ranges for a new sweep axis and for the optimizer's bounds: a small window
// around the parameter's current value, clipped to its limits; never the parameter's whole min..max
// (f0 = 0.1..30 GHz), and never the design frequency or the band as the parameter to vary.
// Pure (no Solid, no DOM), so scripts/check-range-defaults.mjs tests it.

export interface RangeParam {
  key: string;
  unit?: string | null;
  min?: number | null;
  max?: number | null;
  /** whole numbers only (a Python model's int parameter) */
  int?: boolean;
}

const FREQUENCY_UNITS = new Set(["hz", "khz", "mhz", "ghz", "thz"]);

/** The design frequency, the band edges and the like: parameters that define what is simulated
 * rather than the geometry, so a sweep or an optimizer must not pick them by default. */
export function isFrequencyParam(p: Pick<RangeParam, "key" | "unit">): boolean {
  if (p.unit && FREQUENCY_UNITS.has(p.unit.trim().toLowerCase())) return true;
  return /^(f|fc|f_?c|f_?0|f\d+|freq\w*|f_?(min|max|low|high|start|stop|centre|center|res)|bw|bandwidth)$/i.test(p.key);
}

/** Mesh settings ride along as numeric parameters in some models; they are not design variables. */
export const isMeshParam = (key: string) => /mesh|div|cells/i.test(key);

/** The first parameter to vary by default: an unused geometric one, else any unused one. */
export function pickVaryParam<T extends RangeParam>(params: readonly T[], used: ReadonlySet<string> = new Set()): T | undefined {
  const free = params.filter((p) => !used.has(p.key));
  return free.find((p) => !isFrequencyParam(p) && !isMeshParam(p.key)) ?? free.find((p) => !isFrequencyParam(p)) ?? free[0];
}

const nice = (v: number) => Number(v.toPrecision(6));

/**
 * `current` ± `fraction` (a share of its size), clipped to the limits. A current value of zero has
 * no size to scale: a tenth of the limits' span when both are known, else ±1 for whole numbers and
 * ±0.1 otherwise. Whole-number parameters get whole bounds, at least one apart.
 */
export function rangeAround(current: number, p: Pick<RangeParam, "min" | "max" | "int">, fraction: number): [number, number] {
  const min = p.min ?? -Infinity, max = p.max ?? Infinity;
  let d = Math.abs(current) * fraction;
  if (!(d > 0)) d = Number.isFinite(min) && Number.isFinite(max) && max > min ? (max - min) / 10 : p.int ? 1 : 0.1;
  let lo = Math.max(min, current - d), hi = Math.min(max, current + d);
  if (p.int) {
    lo = Math.ceil(lo); hi = Math.floor(hi);
    if (!(lo < hi)) { lo = Math.max(min, Math.round(current) - 1); hi = Math.min(max, Math.round(current) + 1); }
    return [lo, hi];
  }
  return [nice(Math.max(min, lo)), nice(Math.min(max, hi))];
}

/** A new sweep axis: the current value ±10 % in 5 steps. */
export const SWEEP_SPAN = 0.1;
export const SWEEP_STEPS = 5;
/** The optimizer's bounds: the current value ±20 %. */
export const OPTIMIZE_SPAN = 0.2;

export function sweepRange(current: number, p: Pick<RangeParam, "min" | "max" | "int">): { start: string; stop: string; steps: string } {
  const [lo, hi] = rangeAround(current, p, SWEEP_SPAN);
  return { start: String(lo), stop: String(hi), steps: String(SWEEP_STEPS) };
}
