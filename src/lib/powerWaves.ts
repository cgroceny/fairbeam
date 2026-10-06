/** Kurokawa power-wave reflection at an optional complex source reference. */
export function powerWaveReflection(zRe: number, zIm: number, refRe: number, refIm: number) {
  if (![zRe, zIm, refRe, refIm].every(Number.isFinite) || refRe <= 0) return null;
  const nr = zRe - refRe, ni = zIm + refIm, dr = zRe + refRe, di = zIm + refIm;
  const denominator = dr * dr + di * di;
  if (denominator === 0) return null;
  const re = (nr * dr + ni * di) / denominator, im = (ni * dr - nr * di) / denominator;
  const magnitude = Math.hypot(re, im);
  return { re, im, magnitude, transfer: 1 - magnitude * magnitude };
}
