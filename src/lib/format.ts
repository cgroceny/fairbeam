// Numbers shown as text in the UI, in the UI language's decimal separator (2,450 GHz in Turkish).
// Not for inputs or exported files: `numPlain` is the locale-independent formatter for text that
// goes into files (lib/run.ts writes the report's convergence and efficiency sentences with it).
import { fmt, t, decimalComma } from "../i18n/index.ts";

export const GHz = (hz: number, digits = 3) => `${fmt.fixed(hz / 1e9, digits)} GHz`;

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

