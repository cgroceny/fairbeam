export type SamplePoint = { index: number; x: number; y: number };
export type Resonance = SamplePoint & {
  low: number;
  high: number;
  percent: number;
  edgeLow: boolean;
  edgeHigh: boolean;
};

/** Only diagonal S-parameters are reflection traces; S21 and other transmission traces are not. */
export function isReflectionTrace(id: string): boolean {
  if (/^cmp-\d+$/.test(id)) return true; // single-port S11 comparisons
  const pair = /(?:^|[-])(\d+),(\d+)$/.exec(id);
  if (pair) return pair[1] === pair[2];
  return /^s(\d)\1$/i.test(id);
}

type Segment = SamplePoint[];

function finiteSegments(x: number[], y: number[]): Segment[] {
  const segments: Segment[] = [];
  let segment: Segment = [];
  for (let index = 0; index < Math.min(x.length, y.length); index += 1) {
    if (Number.isFinite(x[index]) && Number.isFinite(y[index])) {
      segment.push({ index, x: x[index], y: y[index] });
    } else if (segment.length) {
      segments.push(segment);
      segment = [];
    }
  }
  if (segment.length) segments.push(segment);
  return segments;
}

function minimaIn(segment: Segment): SamplePoint[] {
  const minima: SamplePoint[] = [];
  let start = 0;
  while (start < segment.length) {
    let end = start;
    while (end + 1 < segment.length && segment[end + 1].y === segment[start].y) end += 1;
    const leftLower = start > 0 && segment[start - 1].y <= segment[start].y;
    const rightLower = end + 1 < segment.length && segment[end + 1].y <= segment[end].y;
    const leftBoundary = start === 0 || segment[start - 1].y > segment[start].y;
    const rightBoundary = end + 1 === segment.length || segment[end + 1].y > segment[end].y;
    if (!leftLower && !rightLower && leftBoundary && rightBoundary && (start > 0 || end + 1 < segment.length)) {
      const middle = Math.floor((start + end) / 2);
      minima.push(segment[middle]);
    }
    start = end + 1;
  }
  return minima;
}

export function nearestFiniteSample(x: number[], y: number[], target: number): SamplePoint | null {
  // runs on every pointer move for every trace: a plain scan, no per-sample allocation
  let best = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < Math.min(x.length, y.length); index += 1) {
    if (!Number.isFinite(x[index]) || !Number.isFinite(y[index])) continue;
    const distance = Math.abs(x[index] - target);
    if (distance < bestDistance) { best = index; bestDistance = distance; }
  }
  return best < 0 ? null : { index: best, x: x[best], y: y[best] };
}

/** Pick the visible trace closest to the pointer at each trace's nearest finite frequency sample. */
export function pickTraceSample<T extends { id: string; x: number[]; y: number[] }>(
  traces: T[], targetX: number, targetYPixel: number, yPixel: (value: number) => number,
): { trace: T; point: SamplePoint } | null {
  let best: { trace: T; point: SamplePoint; distance: number } | null = null;
  for (const trace of traces) {
    const point = nearestFiniteSample(trace.x, trace.y, targetX);
    if (!point) continue;
    const distance = Math.abs(yPixel(point.y) - targetYPixel);
    if (!best || distance < best.distance) best = { trace, point, distance };
  }
  return best && { trace: best.trace, point: best.point };
}

function crossing(a: SamplePoint, b: SamplePoint, threshold: number): number {
  return a.x + ((threshold - a.y) / (b.y - a.y)) * (b.x - a.x);
}

/**
 * One resonance per contiguous run of samples below the threshold, placed at the deepest local
 * minimum of that run: ripple minima inside one band (filters, merged dual resonances, noise) do
 * not repeat the same bandwidth. Edges are interpolated linearly between the samples that
 * straddle the threshold; a run that reaches the end of the data (or a gap) is open-ended there
 * (edgeLow/edgeHigh), so its low/high is only the last sample and its percentage a lower bound.
 */
export function findResonances(x: number[], y: number[], threshold: number): Resonance[] {
  const result: Resonance[] = [];
  for (const segment of finiteSegments(x, y)) {
    const minima = minimaIn(segment);
    let position = 0;
    while (position < segment.length) {
      if (!(segment[position].y < threshold)) { position += 1; continue; }
      const left = position;
      let right = position;
      while (right + 1 < segment.length && segment[right + 1].y < threshold) right += 1;
      position = right + 1;
      const first = segment[left].index;
      const last = segment[right].index;
      let marker: SamplePoint | null = null;
      for (const m of minima) if (m.index >= first && m.index <= last && (marker === null || m.y < marker.y)) marker = m;
      if (!marker) continue;
      const edgeLow = left === 0;
      const edgeHigh = right === segment.length - 1;
      const low = edgeLow ? segment[left].x : crossing(segment[left - 1], segment[left], threshold);
      const high = edgeHigh ? segment[right].x : crossing(segment[right], segment[right + 1], threshold);
      const centre = (low + high) / 2;
      result.push({ ...marker, low, high, percent: centre === 0 ? Number.NaN : (100 * (high - low)) / centre, edgeLow, edgeHigh });
    }
  }
  return result;
}

export function globalExtrema(x: number[], y: number[]): { min: SamplePoint | null; max: SamplePoint | null } {
  let min: SamplePoint | null = null;
  let max: SamplePoint | null = null;
  for (const segment of finiteSegments(x, y)) {
    for (const point of segment) {
      if (min === null || point.y < min.y) min = point;
      if (max === null || point.y > max.y) max = point;
    }
  }
  return { min, max };
}

export function nextMinimum(x: number[], y: number[], fromIndex: number, direction: -1 | 1): SamplePoint | null {
  const minima = finiteSegments(x, y).flatMap(minimaIn).sort((a, b) => a.index - b.index);
  if (!minima.length) return null;
  const count = Math.min(x.length, y.length);
  for (let offset = 1; offset < count; offset += 1) {
    const index = (fromIndex + direction * offset % count + count) % count;
    const match = minima.find(point => point.index === index);
    if (match) return match;
  }
  return null;
}
