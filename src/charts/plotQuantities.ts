import type { Series } from "./LineChart";
import { isReflectionTrace } from "./markerMath.ts";
import { t } from "../i18n/index.ts";

export type PlotFormat = "plot" | "db" | "db_phase" | "re_im" | "mag_phase" | "all";
export type PlotMode = "db" | "phase";
export interface ComplexPlotInput {
  id: string;
  label: string;
  color: string;
  dash?: string;
  x: number[];
  re: number[];
  im: number[];
}
export interface PlotQuantity {
  key: string;
  title: string;
  yLabel: string;
  kind: "reflection" | "other";
  series: Series[];
}

export const complexDb = (re: number, im: number) => 10 * Math.log10(Math.max(1e-30, re * re + im * im));
export const complexPhase = (re: number, im: number) => Math.atan2(im, re) * 180 / Math.PI;
export const complexMagnitude = (re: number, im: number) => Math.hypot(re, im);


/** Build plotted values straight from complex samples. Every returned group owns one axis/unit. */
export function plotQuantities(inputs: ComplexPlotInput[], format: PlotFormat, mode: PlotMode = "db"): PlotQuantity[] {
  const active = format === "plot" ? [mode] : format === "db" ? ["db"] : format === "db_phase" ? ["db", "phase"]
    : format === "re_im" ? ["re_im"] : format === "mag_phase" ? ["mag", "phase"] : ["db", "phase", "re_im", "mag"];
  return active.map((q) => {
    const complex = q === "re_im";
    const series = inputs.flatMap((s) => {
      const make = (part: "db" | "phase" | "re" | "im" | "mag"): Series => ({
        id: `${s.id}:${part}`, label: complex ? `${part === "re" ? "Re" : "Im"} ${s.label}` : q === "phase" ? `∠${s.label}` : q === "mag" ? `|${s.label}|` : `|${s.label}|`,
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
    const title = q === "db" ? t("chart.q.magnitudeDb") : q === "phase" ? t("chart.q.phase") : q === "re_im" ? t("chart.q.reIm") : t("chart.q.linearMagnitude");
    return { key: q, title, yLabel: q === "db" ? t("chart.q.magnitudeDb") : q === "phase" ? t("chart.q.phaseDeg") : q === "mag" ? t("chart.q.magnitude") : t("chart.q.unitless"), kind: q === "db" && inputs.some((s) => isReflectionTrace(s.id)) ? "reflection" : "other", series };
  });
}
