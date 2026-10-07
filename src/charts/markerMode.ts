// The marker inspector of a chart (LineChart.tsx): whether marker mode is on, the user's markers, the
// automatic markers and the table. Kept per chart, not per plotted quantity: a chart's key names the
// result view ("designer:run.json:reflection"), so switching it between dB and phase, or drawing the
// same picks as a stack of panes (dB + phase, All), keeps the markers, the mode and the table. A user
// marker is a frequency on a trace; it stands on the same trace in every quantity (S11 in dB and in
// phase).
import { createSignal } from "solid-js";

export interface MarkerModeState {
  active: boolean;
  everOpened: boolean;
}

export const initialMarkerMode: MarkerModeState = { active: false, everOpened: false };

/** Closing the inspector preserves automatic annotations already placed on the plot. */
export function toggleMarkerMode(state: MarkerModeState): MarkerModeState {
  return { active: !state.active, everOpened: true };
}

/** A user marker: an x value (a frequency) on a trace. */
export interface UserMark { id: number; seriesId: string; x: number }

export interface ChartMarkers {
  mode: MarkerModeState;
  marks: UserMark[];
  tableOpen: boolean;
  /** the automatic markers (resonances, or the minimum and maximum) are shown */
  auto: boolean;
  /** dB: the level the resonance markers and their bandwidth refer to */
  threshold: number;
}

export const emptyChartMarkers: ChartMarkers = { mode: initialMarkerMode, marks: [], tableOpen: true, auto: true, threshold: -10 };

/** A trace without its plotted quantity: "1,1:db" and "1,1:phase" are the same trace. */
export const baseSeriesId = (id: string) => id.replace(/:(db|phase|re|im|mag)$/, "");

/** The series a marker stands on: its own, else the same trace drawn as another quantity. */
export function markSeries<T extends { id: string }>(series: readonly T[], seriesId: string): T | undefined {
  return series.find((s) => s.id === seriesId) ?? series.find((s) => baseSeriesId(s.id) === baseSeriesId(seriesId));
}

/** The next free marker number (M1, M2, …) of a chart. */
export const nextMarkId = (marks: readonly UserMark[]) => Math.max(0, ...marks.map((m) => m.id)) + 1;

/** The marker state of every chart, by its key; reactive. */
export function createChartMarkerStore() {
  const [all, setAll] = createSignal<ReadonlyMap<string, ChartMarkers>>(new Map());
  const get = (key: string | undefined): ChartMarkers => (key ? all().get(key) : undefined) ?? emptyChartMarkers;
  const update = (key: string | undefined, change: (s: ChartMarkers) => ChartMarkers) => {
    if (key) setAll((m) => new Map(m).set(key, change(m.get(key) ?? emptyChartMarkers)));
  };
  return { get, update };
}

/** The store LineChart uses: one per app. */
export const chartMarkers = createChartMarkerStore();
