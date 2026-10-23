// Scalar counterpart of fairbeam/patch_seed.py. mm, GHz, ohms; estimates only.
// Balanis sec. 14.2 / Hammerstad, same model as fairbeam/analytic.py.
const C0_MM_GHZ = 299.792458;
const positive = (...v: number[]) => {
  if (v.some((x) => !Number.isFinite(x) || x <= 0)) throw new Error("synthesis inputs must be finite and positive");
};
function cached(fn: (...v: number[]) => number): (...v: number[]) => number {
  const cache = new Map<string, number>();
  return (...v) => {
    const key = v.join(",");
    if (cache.has(key)) return cache.get(key)!;
    const result = fn(...v);
    positive(result);
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    return result;
  };
}
function z0(epsR: number, u: number): number {
  let ee = (epsR + 1) / 2 + (epsR - 1) / 2 / Math.sqrt(1 + 12 / u);
  if (u < 1) ee += (epsR - 1) / 2 * 0.04 * (1 - u) ** 2;
  return u <= 1 ? 60 / Math.sqrt(ee) * Math.log(8 / u + u / 4)
    : 120 * Math.PI / (Math.sqrt(ee) * (u + 1.393 + 0.667 * Math.log(u + 1.444)));
}
export const microstripWidth = cached((target, epsR, h) => {
  positive(target, epsR, h);
  if (epsR < 1 || epsR > 20) throw new Error("microstrip_width needs 1 <= eps_r <= 20");
  let lo = 1e-4, hi = 50;
  if (target < z0(epsR, hi) || target > z0(epsR, lo)) throw new Error("requested impedance is outside the width synthesis range");
  for (let i = 0; i < 64; i++) {
    const mid = Math.sqrt(lo * hi);
    if (z0(epsR, mid) > target) lo = mid;
    else hi = mid;
  }
  const result = h * Math.sqrt(lo * hi);
  if (Math.abs(z0(epsR, result / h) - target) > 1e-9 * target) throw new Error("target impedance falls in the piecewise line model discontinuity");
  return result;
});
function j0(x: number): number {
  let term = 1, total = 1;
  for (let k = 1; k < 32; k++) {
    term *= -(x * x / 4) / (k * k);
    total += term;
  }
  return total;
}
export const patchInset = cached((target, length, width, fGHz) => {
  positive(target, length, width, fGHz);
  const lam = C0_MM_GHZ / fGHz;
  if (length > lam / 2 || width > lam / 2) throw new Error("patch_inset needs patch length and width <= wavelength/2");
  const k0 = 2 * Math.PI / lam, step = (Math.PI - 2e-6) / 4000;
  let g1 = 0, g12 = 0;
  for (let i = 0; i <= 4000; i++) {
    const theta = 1e-6 + i * step, ct = Math.cos(theta), st = Math.sin(theta);
    const a = k0 * width / 2, slot = Math.abs(ct) < 1e-12 ? a : Math.sin(a * ct) / ct;
    const base = slot * slot * st ** 3, weight = i === 0 || i === 4000 ? 0.5 : 1;
    g1 += weight * base;
    if (i % 8 === 0) g12 += weight * base * j0(k0 * length * st);
  }
  const conductance = (g1 + 8 * g12) * step / (120 * Math.PI ** 2);
  if (!Number.isFinite(conductance) || conductance <= 0) throw new Error("patch slot conductance is outside the synthesis range");
  const edge = 1 / (2 * conductance);
  if (target >= edge) throw new Error("target resistance must be below the estimated patch edge resistance");
  const result = length / Math.PI * Math.acos(Math.sqrt(target / edge));
  if (!(result > 0 && result < length / 2)) throw new Error("inset must be strictly inside the half patch");
  return result;
});
