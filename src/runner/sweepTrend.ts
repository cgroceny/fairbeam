import type { Job } from './api';

export const TREND_METRICS = ['frequency', 's11', 'bandwidth', 'directivity', 'efficiency'] as const;
export type TrendMetric = typeof TREND_METRICS[number];
export const trendUnit = (metric: TrendMetric) => ({ frequency: 'GHz', s11: 'dB', bandwidth: 'MHz', directivity: 'dBi', efficiency: '%' })[metric];
export type TrendReason = 'ok' | 'missing' | 'unfinished' | 'duplicate' | 'band' | 'field' | 'metric';
export interface TrendPoint {
  x: number; jobIds: string[]; status: string; value: number | null; slope: number | null;
  bandGHz: number | null; fieldGHz: number | null; reason: TrendReason;
  converged: boolean | null; nonphysical: boolean;
}
export interface TrendSeries { id: string; second: number | null; points: TrendPoint[] }
export interface TrendData { first: string; second: string | null; series: TrendSeries[]; error: 'axes' | 'settings' | null }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Same coordinate precision as the sweep planner; never use display rounding as identity. */
export const trendCoordinate = (v: number) => Number(v.toPrecision(10));
const unique = (values: number[]) => [...new Set(values.filter(finite).map(trendCoordinate))].sort((a, b) => a - b);
export function trendSequences(jobs: Job[]) {
  return [...new Map(jobs.filter(j => j.sweep).map(j => [j.sweep!.sequence_index ?? 0, j.sweep!.sequence_name ?? ''])).entries()]
    .sort((a, b) => a[0] - b[0]);
}
export function defaultTrendFrequency(jobs: Job[]) {
  return jobs.filter(j => j.status === 'done').sort((a, b) => (a.sweep?.index ?? 0) - (b.sweep?.index ?? 0))
    .flatMap(j => (j.stats.bands ?? []).map(b => b.f_center_ghz).filter(f => finite(f) && f > 0).sort((a, b) => a - b))[0] ?? 1;
}
/** Equal-distance candidates are ambiguous. A fixed window stops cumulative band drift.
 * Nearest-frequency association is a heuristic, not a physical mode-identity guarantee. */
function nearest<T>(items: T[], frequency: (v: T) => number, target: number, reference: number, radius: number): T | undefined {
  const candidates = items.filter(v => finite(frequency(v)) && frequency(v) > 0 && Math.abs(frequency(v) - reference) <= radius)
    .sort((a, b) => Math.abs(frequency(a) - target) - Math.abs(frequency(b) - target));
  if (candidates.length > 1 && Math.abs(Math.abs(frequency(candidates[0]) - target) - Math.abs(frequency(candidates[1]) - target)) < 1e-12) return;
  return candidates[0];
}
export function sweepTrend(jobs: Job[], sequence: number, metric: TrendMetric, referenceGHz: number, windowMHz: number): TrendData {
  const members = jobs.filter(j => j.sweep && (j.sweep.sequence_index ?? 0) === sequence);
  const axes = members[0]?.sweep?.axes ?? [];
  const result: TrendData = { first: axes[0]?.key ?? '', second: axes[1]?.key ?? null, series: [], error: null };
  if (!finite(referenceGHz) || referenceGHz <= 0 || !finite(windowMHz) || windowMHz <= 0) return { ...result, error: 'settings' };
  // Conflicting schemas or coordinates cannot safely be plotted as one experiment.
  if (!axes.length || axes.length > 2 || new Set(axes.map(a => a.key)).size !== axes.length ||
    members.some(j => j.sweep!.axes.length !== axes.length || j.sweep!.axes.some((a, i) => a.key !== axes[i].key ||
      a.values.some(v => !finite(v))) || axes.some(a => !finite(j.sweep!.values[a.key])))) return { ...result, error: 'axes' };
  const xs = unique(members.flatMap(j => [...j.sweep!.axes[0].values, j.sweep!.values[result.first]]));
  const seconds = result.second ? unique(members.flatMap(j => [...j.sweep!.axes[1].values, j.sweep!.values[result.second!]])) : [null];
  result.series = seconds.map(second => {
    let previousFrequency = referenceGHz;
    const points: TrendPoint[] = xs.map(x => {
      const matches = members.filter(j => trendCoordinate(j.sweep!.values[result.first]) === x &&
        (second === null || trendCoordinate(j.sweep!.values[result.second!]) === second));
      const point: TrendPoint = { x, jobIds: matches.map(j => j.id), status: matches.map(j => j.status).join('|'), value: null, slope: null,
        bandGHz: null, fieldGHz: null, reason: 'missing', converged: null, nonphysical: false };
      if (matches.length !== 1) { point.reason = matches.length ? 'duplicate' : 'missing'; return point; }
      const job = matches[0];
      point.converged = job.stats.converged ?? null;
      if (job.status !== 'done') { point.reason = 'unfinished'; return point; }
      const band = nearest(job.stats.bands ?? [], b => b.f_center_ghz, previousFrequency, referenceGHz, windowMHz / 1000);
      if (!band) { point.reason = 'band'; return point; }
      point.bandGHz = previousFrequency = band.f_center_ghz;
      let value: number | null | undefined;
      if (metric === 'frequency') value = band.f_center_ghz;
      else if (metric === 's11') value = band.s11_min_db;
      else if (metric === 'bandwidth') value = finite(band.f_lo_ghz) && finite(band.f_hi_ghz) && band.f_lo_ghz >= 0 &&
        band.f_lo_ghz <= band.f_center_ghz && band.f_hi_ghz >= band.f_center_ghz ? (band.f_hi_ghz - band.f_lo_ghz) * 1000 : null;
      else {
        const field = nearest(job.stats.farfield ?? [], f => f.f_ghz, band.f_center_ghz, band.f_center_ghz, windowMHz / 1000);
        if (!field) { point.reason = 'field'; return point; }
        point.fieldGHz = field.f_ghz;
        value = metric === 'directivity' ? field.dmax_dbi : finite(field.rad_efficiency) ? field.rad_efficiency * 100 : null;
        point.nonphysical = metric === 'efficiency' && finite(value) && (value < 0 || value > 100);
      }
      point.value = finite(value) ? value : null;
      point.reason = point.value === null ? 'metric' : 'ok';
      return point;
    });
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (a.value !== null && b.value !== null) {
        const slope = (b.value - a.value) / (b.x - a.x);
        if (finite(slope)) b.slope = slope;
      }
    }
    return { id: `${sequence}:${second ?? ''}`, second, points };
  });
  return result;
}
export function sweepTrendCsv(data: TrendData, metric: TrendMetric, sequence: number, referenceGHz: number, windowMHz: number) {
  const header = ['sequence_index', 'first_parameter', 'first_value', 'second_parameter', 'second_value', 'job_ids', 'status', 'metric', 'unit',
    'value', 'adjacent_slope_per_parameter_unit', 'band_best_ghz', 'farfield_sample_ghz', 'reason', 'converged', 'nonphysical', 'reference_ghz', 'half_window_mhz'];
  const rows = data.series.flatMap(s => s.points.map(p => [sequence, data.first, p.x, data.second, s.second, p.jobIds.join('|'), p.status, metric, trendUnit(metric),
    p.value, p.slope, p.bandGHz, p.fieldGHz, p.reason, p.converged, p.nonphysical, referenceGHz, windowMHz]));
  const cell = (v: unknown) => {
    // Text identifiers are spreadsheet-safe; numeric negative values remain numeric.
    let text = v == null ? '' : String(v);
    if (typeof v === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
