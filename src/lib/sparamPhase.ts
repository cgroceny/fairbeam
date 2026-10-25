/** Display-only S-parameter phase and group delay. Frequency is GHz, phase is degrees,
 * and -d(phase)/d(frequency)/360 is delay in ns. No bundle or optimizer state is changed. */
export type SParameterPhaseWarning = "phaseStep" | "invalidGrid" | "invalidSample";

export interface SParameterPhaseOptions {
  /** Optional comparison grid. Unwrap the source first, then interpolate phase before fitting. */
  gridGHz?: readonly number[];
  /** Odd local least-squares aperture; default 3, bounded to 3..101, even values round up. */
  aperturePoints?: number;
}

export interface SParameterPhaseAnalysis {
  phaseDeg: number[];
  delayNs: number[];
  warnings: SParameterPhaseWarning[];
}

type PhaseSamples = { phase: number[]; segment: number[] };
const missing = (length: number) => Array<number>(length).fill(Number.NaN);
const validGrid = (grid: readonly number[]) => {
  for (let i = 0; i < grid.length; i++) {
    if (!Number.isFinite(grid[i]) || grid[i] < 0 || (i > 0 && grid[i] <= grid[i - 1])) return false;
  }
  return true;
};
// Only floating-point noise around an exactly ambiguous half-turn, not a sampling threshold.
const HALF_TURN_EPS = 64 * Number.EPSILON * 180;

function unwrapSamples(wrapped: readonly number[], warn: (warning: SParameterPhaseWarning) => void): PhaseSamples {
  const phase = missing(wrapped.length), segment = Array<number>(wrapped.length).fill(-1);
  let previous = Number.NaN, continuous = Number.NaN, id = -1;
  for (let i = 0; i < wrapped.length; i++) {
    const value = wrapped[i];
    if (!Number.isFinite(value)) {
      warn("invalidSample");
      previous = Number.NaN;
      continue;
    }
    if (!Number.isFinite(previous)) {
      continuous = value;
      id++;
    } else {
      const delta = value - previous;
      // A principal-phase wrap is observable; it is NOT evidence of undersampling/aliasing.
      if (Math.abs(delta) >= 180 - HALF_TURN_EPS) warn("phaseStep");
      if (Math.abs(Math.abs(delta) - 180) <= HALF_TURN_EPS) {
        // Neither sign is justified. Leave a gap and start the next sample independently.
        previous = Number.NaN;
        continue;
      }
      continuous += delta - 360 * Math.round(delta / 360);
    }
    if (!Number.isFinite(continuous)) {
      warn("invalidSample");
      previous = Number.NaN;
      continue;
    }
    phase[i] = continuous;
    segment[i] = id;
    previous = value;
  }
  return { phase, segment };
}

/** Unwrap principal phase angles independently across NaN gaps. An ambiguous 180-degree
 * step leaves a gap. Correct recovery requires the true adjacent increment to be <180 degrees;
 * complex samples alone cannot establish that condition or detect an integer-turn alias. */
export function unwrapDeg(wrapped: readonly number[]): number[] {
  return unwrapSamples(wrapped, () => {}).phase;
}

function interpolateSegments(source: readonly number[], samples: PhaseSamples, grid: readonly number[]): PhaseSamples {
  const phase = missing(grid.length), segment = Array<number>(grid.length).fill(-1);
  let target = 0;
  for (let start = 0; start < source.length;) {
    const id = samples.segment[start];
    if (id < 0) { start++; continue; }
    let end = start;
    while (end + 1 < source.length && samples.segment[end + 1] === id) end++;
    while (target < grid.length && grid[target] < source[start]) target++;
    let left = start;
    while (target < grid.length && grid[target] <= source[end]) {
      const f = grid[target];
      while (left < end && source[left + 1] <= f) left++;
      if (f === source[left]) {
        phase[target] = samples.phase[left];
      } else if (left < end) {
        const fraction = (f - source[left]) / (source[left + 1] - source[left]);
        phase[target] = samples.phase[left] * (1 - fraction) + samples.phase[left + 1] * fraction;
      }
      if (Number.isFinite(phase[target])) segment[target] = id;
      target++;
    }
    start = end + 1;
  }
  return { phase, segment };
}

function aperture(value: number | undefined): number {
  const size = Number.isFinite(value) ? Math.max(3, Math.min(101, Math.round(value!))) : 3;
  return size % 2 === 0 ? size + 1 : size;
}

function delayFromPhase(grid: readonly number[], samples: PhaseSamples, points: number): number[] {
  const delay = missing(grid.length);
  for (let start = 0; start < grid.length;) {
    const id = samples.segment[start];
    if (id < 0) { start++; continue; }
    let end = start;
    while (end + 1 < grid.length && samples.segment[end + 1] === id) end++;
    const width = Math.min(points, end - start + 1);
    if (width >= 2) for (let i = start; i <= end; i++) {
      // Keep the full available aperture near the ends by using a one-sided window.
      const first = Math.max(start, Math.min(i - Math.floor(width / 2), end - width + 1));
      const last = first + width - 1, span = grid[last] - grid[first];
      // Normalize x and subtract a local phase origin to avoid large offsets in the fit.
      let meanX = 0, meanY = 0;
      for (let k = first; k <= last; k++) {
        meanX += (grid[k] - grid[first]) / span / width;
        meanY += (samples.phase[k] - samples.phase[first]) / width;
      }
      let xx = 0, xy = 0;
      for (let k = first; k <= last; k++) {
        const x = (grid[k] - grid[first]) / span - meanX;
        const y = samples.phase[k] - samples.phase[first] - meanY;
        xx += x * x;
        xy += x * y;
      }
      const value = -(xy / xx / span) / 360;
      if (Number.isFinite(value)) delay[i] = value;
    }
    start = end + 1;
  }
  return delay;
}

/** Analyze complex samples without sorting, extrapolating or connecting invalid segments.
 * Invalid/non-increasing grids or mismatched array lengths return unavailable output. Zero
 * complex amplitude has no phase. With a comparison grid, local slopes are fitted AFTER phase
 * interpolation, never by interpolating already-computed delay. Short segments use all available
 * points (at least two); longer ones use the requested local aperture.
 *
 * phaseStep reports an observed principal-phase discontinuity, including an ambiguous half-turn.
 * It does not prove aliasing: true phase changes by extra whole turns are indistinguishable from
 * the same complex samples. Acquisition must resolve true adjacent phase increments below 180°.
 */
export function analyzeSParameterPhase(
  frequencyGHz: readonly number[], re: readonly number[], im: readonly number[],
  options: SParameterPhaseOptions = {},
): SParameterPhaseAnalysis {
  const grid = options.gridGHz ?? frequencyGHz;
  const warnings = new Set<SParameterPhaseWarning>();
  const unavailable = (): SParameterPhaseAnalysis => ({
    phaseDeg: missing(grid.length), delayNs: missing(grid.length), warnings: [...warnings],
  });
  if (!validGrid(frequencyGHz) || !validGrid(grid)) {
    warnings.add("invalidGrid");
    return unavailable();
  }
  if (re.length !== frequencyGHz.length || im.length !== frequencyGHz.length) {
    warnings.add("invalidSample");
    return unavailable();
  }
  const wrapped = Array.from(frequencyGHz, (_, i) =>
    Number.isFinite(re[i]) && Number.isFinite(im[i]) && (re[i] !== 0 || im[i] !== 0)
      ? Math.atan2(im[i], re[i]) * 180 / Math.PI : Number.NaN);
  const source = unwrapSamples(wrapped, (warning) => warnings.add(warning));
  const samples = options.gridGHz ? interpolateSegments(frequencyGHz, source, grid) : source;
  return { phaseDeg: samples.phase, delayNs: delayFromPhase(grid, samples, aperture(options.aperturePoints)), warnings: [...warnings] };
}
