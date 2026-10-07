// Numbers shown as text in the UI, in the UI language's decimal separator (2,450 GHz in Turkish).
// Not for inputs or exported files: `numPlain` is the locale-independent formatter for text that
// goes into files (lib/run.ts writes the report's convergence and efficiency sentences with it).
import { fmt, t, decimalComma } from "../i18n/index.ts";
import { ghzDigits } from "./ghzDigits.ts";

export const GHz = (hz: number, digits = 3) => `${fmt.fixed(hz / 1e9, digits)} GHz`;

/** Four significant digits of a frequency in GHz (lib/ghzDigits.ts, locale-free). */
export { ghzDigits };
/** A frequency given in GHz, four significant digits, with the decimal point (copied data). */
export const ghzPlain = (ghz: number) => (Number.isFinite(ghz) ? ghz.toFixed(ghzDigits(ghz)) : "—");
/** A frequency given in GHz, four significant digits, in the UI language's decimal separator. */
export const ghzText = (ghz: number) => (Number.isFinite(ghz) ? fmt.fixed(ghz, ghzDigits(ghz)) : "—");
/** A frequency given in Hz as display text with its unit: "2.404 GHz". */
export const freqText = (hz: number) => `${ghzText(hz / 1e9)} GHz`;

/** A value with its unit that never breaks between the two ("−1.22 dB", "75.5 %"): a no-break space. */
export const withUnit = (value: string, unit: string) => `${value} ${unit}`;

/** The decimals of a table column of numbers (a parameter across runs): as many as its most precise
 * value needs, at most `max`, so every value is shown as it was set and the column reads alike
 * (0.4660 / 0.4194 / 0.5126, not 0.466 / 0.4194 / 0.5126). Non-numbers are ignored. */
export function columnDecimals(values: readonly unknown[], max = 4): number {
  let digits = 0;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const s = v.toFixed(max).replace(/0+$/, "");
    digits = Math.max(digits, s.length - s.indexOf(".") - 1);
  }
  return Math.min(max, digits);
}

export function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return fmt.fixed(v, digits);
}

/** `num` with the decimal point whatever the UI language: for exported text (PDF / Markdown report). */
export function numPlain(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

/** Compact engineering formatting: 1.9 M, 97 k */
export function compact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${fmt.fixed(v / 1e9, 2)} G`;
  if (a >= 1e6) return `${fmt.fixed(v / 1e6, 2)} M`;
  if (a >= 1e4) return `${fmt.fixed(v / 1e3, 1)} k`;
  return `${Math.round(v)}`;
}

export function mm(v: number, digits = 2): string {
  return `${fmt.num(v, digits)} mm`;
}

export function seconds(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "—";
  if (s < 60) return `${fmt.fixed(s, 1)} s`;
  const m = Math.floor(s / 60);
  return t("format.minutesSeconds", { m, s: Math.round(s - m * 60) });
}

export function timeUnit(s: number | null | undefined): string {
  if (!s) return "—";
  if (s < 1e-9) return `${fmt.fixed(s * 1e12, 3)} ps`;
  if (s < 1e-6) return `${fmt.fixed(s * 1e9, 3)} ns`;
  const e = s.toExponential(3);
  return `${decimalComma() ? e.replace(".", ",") : e} s`;
}

export function dims(bbox: [number[], number[]]): string {
  const d = bbox[1].map((v, i) => fmt.num(v - bbox[0][i], 3));
  return d.join(" × ") + " mm";
}

