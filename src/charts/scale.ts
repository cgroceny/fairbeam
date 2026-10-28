export function ticks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return [];
  if (min === max) return [min];
  // A chart needs a bounded number of ticks, even for malformed dimensions/counts.
  const target = Number.isFinite(count) ? Math.min(1000, Math.max(1, Math.floor(count))) : 5;
  const span = max - min;
  const raw = Number.isFinite(span) ? span / target : max / target - min / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const step = (m > 5 ? 10 : m > 2 ? 5 : m > 1 ? 2 : 1) * p;
  // An underflowed step, or one smaller than the spacing of representable values,
  // cannot advance an additive loop. Finite endpoints are the only honest ticks.
  if (!(step > 0) || !Number.isFinite(step) || min + step === min || max - step === max) return [min, max];
  const first = Math.ceil(min / step - 1e-9), last = Math.floor(max / step + 1e-9);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return [min, max];
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  const out: number[] = [];
  // Index a bounded range instead of accumulating v += step, which can stop
  // changing v for adjacent doubles while the loop condition stays true forever.
  for (let i = 0, length = Math.min(1001, Math.max(0, last - first + 1)); i < length; i++) {
    const rawValue = (first + i) * step;
    const value = digits <= 100 ? Number(rawValue.toFixed(digits)) : rawValue;
    if (Number.isFinite(value) && (!out.length || value > out[out.length - 1])) out.push(value === 0 ? 0 : value);
  }
  return out;
}

function paddedDomain(min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return [-1, 1];
  // A fixed +/-1 is itself unrepresentable at large magnitudes. Keep finite bounds
  // and all input samples, including at the largest representable finite values.
  const pad = Math.max(1, Math.max(Math.abs(min), Math.abs(max)) * Number.EPSILON * 4);
  const lo = min - pad, hi = max + pad;
  return [Number.isFinite(lo) ? lo : min, Number.isFinite(hi) ? hi : max];
}

export function niceDomain(min: number, max: number, count = 5): [number, number] {
  const t = ticks(min, max, count);
  if (t.length < 2) return paddedDomain(min, max);
  const step = t[1] - t[0];
  if (!(step > 0) || !Number.isFinite(step)) return paddedDomain(min, max);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  return Number.isFinite(lo) && Number.isFinite(hi) && lo <= min && hi >= max && hi > lo
    ? [lo, hi] : paddedDomain(min, max);
}

export function extent(values: number[][]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const arr of values) for (const v of arr) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

export function tickLabel(v: number, step: number): string {
  const spacing = Number.isFinite(step) && step !== 0 ? Math.abs(step) : 1;
  const exponent = Math.floor(Math.log10(spacing));
  const digits = Math.max(0, -exponent);
  if (digits <= 8) return v.toFixed(digits);
  // Preserve the selected tick spacing without hundreds of leading zeroes or
  // toFixed's 100-digit limit. Adjacent doubles can need 17 significant digits.
  const precision = Math.max(0, Math.min(16, Math.floor(Math.log10(Math.abs(v) || spacing)) - exponent));
  return v.toExponential(precision);
}
