import type { Series } from "./LineChart";
import { isReflectionTrace } from "./markerMath.ts";
import { t } from "../i18n/index.ts";
import { analyzeSParameterPhase } from "../lib/sparamPhase.ts";

export type PlotFormat = "plot" | "db" | "db_phase" | "re_im" | "mag_phase" | "all" | "gd" | "phase_unwrapped";
export interface PhasePlotOptions { aperturePoints?: number }
export type PlotMode = "db" | "phase";
export interface ComplexPlotInput {
  id: string;
  /** the quantity's name, "S11"; drawn as |S11|, ∠S11, Re S11 */
  label: string;
  /** what tells compared traces apart (a run's label): after the quantity, "|S11| · E" */
  suffix?: string;
  color: string;
  dash?: string;
  x: number[];
  re: number[];
  im: number[];
  /** False for magnitude-only reference imports; omit quantities requiring a phase. */
  phaseKnown?: boolean;
  /** Preserve the original samples: unwrap their phase before comparison-grid interpolation. */
  phaseSource?: { x: number[]; re: number[]; im: number[] };
}
export interface PlotQuantity {
  key: string;
  title: string;
  yLabel: string;
  kind: "reflection" | "other";
  series: Series[];
  phaseWarnings?: ReturnType<typeof analyzeSParameterPhase>["warnings"];
}

export const complexDb = (re: number, im: number) => 10 * Math.log10(Math.max(1e-30, re * re + im * im));
export const complexPhase = (re: number, im: number) => Math.atan2(im, re) * 180 / Math.PI;
export const complexMagnitude = (re: number, im: number) => Math.hypot(re, im);


/** Build plotted values straight from complex samples. Every returned group owns one axis/unit. The
 * bars or the angle go around the quantity only ("|S11| · E", not "|S11 · E|"); when every trace is the
 * same quantity the y-axis title names it ("|S11| (dB)"), so a single plotted trace is named without a legend. */
export function plotQuantities(inputs: ComplexPlotInput[], format: PlotFormat, mode: PlotMode = "db", options: PhasePlotOptions = {}): PlotQuantity[] {
  const active = format === "plot" ? [mode] : format === "db" ? ["db"] : format === "db_phase" ? ["db", "phase"]
    : format === "gd" || format === "phase_unwrapped" ? [format]
    : format === "re_im" ? ["re_im"] : format === "mag_phase" ? ["mag", "phase"] : ["db", "phase", "re_im", "mag"];
  const names = [...new Set(inputs.map((s) => s.label))];
  const one = names.length === 1 ? names[0] : null;
  return active.map((q) => {
    const complex = q === "re_im";
    const derivedPhase = q === "gd" || q === "phase_unwrapped";
    const phaseWarnings: NonNullable<PlotQuantity["phaseWarnings"]> = [];
    const series = inputs.flatMap((s) => {
      if (s.phaseKnown === false && q !== "db" && q !== "mag") return [];
      const after = s.suffix ? ` · ${s.suffix}` : "";
      if (derivedPhase) {
        const source = s.phaseSource ?? s;
        const analysis = analyzeSParameterPhase(source.x, source.re, source.im, { ...options, gridGHz: s.x });
        phaseWarnings.push(...analysis.warnings);
        return [{ id: `${s.id}:${q}`, label: `${q === "gd" ? "τg " : "∠"}${s.label}${after}`, color: s.color, dash: s.dash,
          x: s.x, y: q === "gd" ? analysis.delayNs : analysis.phaseDeg }];
      }
      const make = (part: "db" | "phase" | "re" | "im" | "mag"): Series => ({
        id: `${s.id}:${part}`, label: `${complex ? `${part === "re" ? "Re" : "Im"} ${s.label}` : q === "phase" ? `∠${s.label}` : `|${s.label}|`}${after}`,
        color: s.color, dash: complex ? (part === "im" ? "6 4" : undefined) : s.dash,
        x: s.x, y: s.re.map((re, k) => {
          const im = s.im[k];
          if (!Number.isFinite(re) || !Number.isFinite(im)) return Number.NaN;
          if (part === "re") return re;
          if (part === "im") return im;
          if (part === "phase") return complexPhase(re, im);
          if (part === "mag") return complexMagnitude(re, im);
          return complexDb(re, im);
        }),
      });
      return complex ? [make("re"), make("im")] : [make(q as "db" | "phase" | "mag")];
    });
    const title = q === "gd" ? t("chart.q.groupDelay") : q === "phase_unwrapped" ? t("chart.q.unwrappedPhase") : q === "db" ? t("chart.q.magnitudeDb") : q === "phase" ? t("chart.q.phase") : q === "re_im" ? t("chart.q.reIm") : t("chart.q.linearMagnitude");
    const yLabel = q === "gd" ? (one ? `τg ${one} (ns)` : t("chart.q.groupDelayNs")) : q === "phase_unwrapped" ? (one ? `∠${one} (°)` : t("chart.q.phaseDeg")) : one && q === "db" ? `|${one}| (dB)` : one && q === "phase" ? `∠${one} (°)` : one && q === "mag" ? `|${one}|`
      : q === "db" ? t("chart.q.magnitudeDb") : q === "phase" ? t("chart.q.phaseDeg") : q === "mag" ? t("chart.q.magnitude") : t("chart.q.unitless");
    return { key: q, title, yLabel, kind: q === "db" && inputs.some((s) => isReflectionTrace(s.id)) ? "reflection" : "other", series,
      ...(derivedPhase ? { phaseWarnings: [...new Set(phaseWarnings)] } : {}) };
  });
}
