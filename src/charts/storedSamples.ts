/** Choose the frequency before looking at the value. Missing samples cannot jump a gap;
 * traces with a shorter span do not extrapolate to the chart's crosshair. */
export function nearestStoredIndex(xs: readonly number[], x: number): number {
  if (!Number.isFinite(x) || !xs.length || x < xs[0] || x > xs[xs.length - 1]) return -1;
  let lo = 0, hi = xs.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid + 1; else hi = mid; }
  return lo > 0 && x - xs[lo - 1] <= xs[lo] - x ? lo - 1 : lo;
}
