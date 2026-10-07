// Decimals of a frequency in GHz that give four significant digits: 2.404, 11.16, 0.8670. One rule for
// every place a frequency is read off a chart (the readouts, the marker table, the hover tips, the
// Smith chart's labels), so the same frequency never shows as 2.36 in one and 2.4036 in another.
// Locale-free (no i18n), so modules that write exported data can use it.

export function ghzDigits(ghz: number): number {
  const a = Math.abs(ghz);
  return a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
}
