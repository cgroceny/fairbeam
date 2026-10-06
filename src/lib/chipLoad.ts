/** Passive parallel R/L/C equivalent of a target Z at one frequency (Hz).
 * This circuit matches Z only at frequencyHz; it is not a constant complex load.
 * Values are physical ohms, henries and farads, not power-wave reference data.
 */
export function equivalentChipLoad(real: number, imag: number, frequencyHz: number) {
  if (![real, imag, frequencyHz].every(Number.isFinite) || real <= 0 || frequencyHz <= 0) return null;
  const square = real * real + imag * imag, omega = 2 * Math.PI * frequencyHz;
  const R = square / real;
  const C = imag < 0 ? -imag / (omega * square) : undefined;
  const L = imag > 0 ? square / (omega * imag) : undefined;
  if (![R, ...(C === undefined ? [] : [C]), ...(L === undefined ? [] : [L])].every((v) => Number.isFinite(v) && v > 0)) return null;
  return { R, ...(C === undefined ? {} : { C }), ...(L === undefined ? {} : { L }), topology: "parallel" as const };
}
