/** Choose the nearest angular sample before looking at its value. A masked bearing
 * remains unavailable in hover readouts instead of borrowing a distant valid AR. */
export function nearestPolarSample(series: { angle: number[]; value: number[] } | undefined, angle: number, half: boolean) {
  let k = -1;
  for (let i = 0; i < (series?.angle.length ?? 0); i++) {
    const a = series!.angle[i];
    if (!Number.isFinite(a) || (half && Math.abs(a) > 90.0001)) continue;
    if (k < 0 || Math.abs(a - angle) < Math.abs(series!.angle[k] - angle)) k = i;
  }
  return k < 0 ? { angle, value: NaN } : { angle: series!.angle[k], value: series!.value[k] ?? NaN };
}

/** A missing trace has no peak label. */
export function peakPolarSample(series: { angle: number[]; value: number[] }, half: boolean): number {
  let k = -1;
  for (let i = 0; i < series.angle.length; i++) {
    if (!Number.isFinite(series.angle[i]) || !Number.isFinite(series.value[i]) || (half && Math.abs(series.angle[i]) > 90.0001)) continue;
    if (k < 0 || series.value[i] > series.value[k]) k = i;
  }
  return k;
}
