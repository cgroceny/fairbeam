import { createSignal } from "solid-js";

/** The Summary tab's comparison view: "values" (each run's numbers with the difference from the first
 * run under them, the default) or "delta" (the differences first; Copy data and CSV then add Δ columns).
 * Remembered per viewer in localStorage. */
export const SUMMARY_MODES = ["values", "delta"] as const;
export type SummaryMode = typeof SUMMARY_MODES[number];
export const SUMMARY_MODE_KEY = "fairbeam:summary-mode";

export function readSummaryMode(): SummaryMode {
  try {
    const value = localStorage.getItem(SUMMARY_MODE_KEY);
    if (SUMMARY_MODES.includes(value as SummaryMode)) return value as SummaryMode;
  } catch { /* the default when storage is unavailable */ }
  return "values";
}

const [mode, setMode] = createSignal<SummaryMode>(readSummaryMode());
export const summaryMode = mode;

/** The run the comparison's differences are taken from, by its file; null: the default (the oldest
 * selected run, which is run A when A is selected). Not remembered: it names a run of this session's
 * selection, and a run that is no longer compared falls back to the default. */
const [reference, setReference] = createSignal<string | null>(null);
export const summaryReference = reference;
export const chooseSummaryReference = (file: string | null) => setReference(file);

export function writeSummaryMode(value: SummaryMode): void {
  if (!SUMMARY_MODES.includes(value)) return;
  setMode(value);
  try { localStorage.setItem(SUMMARY_MODE_KEY, value); } catch { /* the choice still holds for this session */ }
}
