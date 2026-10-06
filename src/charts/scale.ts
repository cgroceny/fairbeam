export function ticks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const raw = (max - min) / Math.max(1, count);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const step = (m > 5 ? 10 : m > 2 ? 5 : m > 1 ? 2 : 1) * p;
  const out: number[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

export function niceDomain(min: number, max: number, count = 5): [number, number] {
  const t = ticks(min, max, count);
  if (t.length < 2) return [min - 1, max + 1];
  const step = t[1] - t[0];
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step];
}

export function extent(values: number[][]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const arr of values) for (const v of arr) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

export function tickLabel(v: number, step: number): string {
  const digits = Math.max(0, -Math.floor(Math.log10(Math.abs(step) || 1)));
  return v.toFixed(Math.min(4, digits));
}
