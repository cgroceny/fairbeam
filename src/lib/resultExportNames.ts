import type { Bundle } from "../types.ts";
import { designStem } from "./exportNames.ts";

/** Locale-free frequency tag; sweeps use their full range, single-frequency views their selection. */
export function resultFrequencyTag(bundle: Bundle, frequency?: number): string {
  const values = frequency != null && Number.isFinite(frequency) && frequency > 0
    ? [frequency] : (bundle.results?.frequency ?? []).filter(f => Number.isFinite(f) && f > 0);
  if (!values.length) return "";
  const low = values.reduce((a, b) => Math.min(a, b)), high = values.reduce((a, b) => Math.max(a, b));
  const ghz = (f: number) => Number((f / 1e9).toPrecision(9)).toString();
  return `${ghz(low)}${low === high ? "" : `-${ghz(high)}`}GHz`;
}

/** Files of a shown result share a design, view and frequency stem. Run times disambiguate runs. */
export function resultExportStem(bundle: Bundle, view: string, frequency?: number): string {
  const stamp = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(bundle.created)
    ? bundle.created.replace(" ", "T").replace(/:/g, "-") : "";
  return [designStem(bundle.name || bundle.model.id), designStem(view), resultFrequencyTag(bundle, frequency), stamp].filter(Boolean).join("_");
}
